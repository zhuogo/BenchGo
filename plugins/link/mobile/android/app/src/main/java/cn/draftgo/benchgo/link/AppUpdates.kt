package cn.draftgo.benchgo.link

import android.content.Context
import android.content.Intent
import android.net.Uri
import okhttp3.OkHttpClient
import okhttp3.Request
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.bouncycastle.crypto.util.PublicKeyFactory
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.URI
import java.util.Base64
import java.util.concurrent.TimeUnit

internal const val APP_UPDATE_REPOSITORY = "https://github.com/zhuogo/BenchGo/releases/"
internal const val APP_UPDATE_MIRROR = "https://ghfast.top/"
private const val APP_UPDATE_MANIFEST = APP_UPDATE_REPOSITORY + "download/plugin-updates/benchgo-update.json"
private val appVersionPattern = Regex("^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$")

internal fun appUpdateChannelUnpublished(canonical: String, status: Int): Boolean =
    status == 404 && canonical == APP_UPDATE_MANIFEST

internal fun validAppUpdateVersion(value: String): Boolean {
    if (value.length > 128) return false
    val match = appVersionPattern.matchEntire(value) ?: return false
    return match.groupValues[4].split('.').none { it.length > 1 && it.all(Char::isDigit) && it.startsWith('0') }
}

internal fun normalizeAppUpdateMirror(value: String): String {
    val uri = runCatching { URI(value) }.getOrNull()
    require(uri != null && uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null) { "更新镜像须为不含凭据、查询参数和片段的 HTTPS 地址" }
    return value.trimEnd('/') + "/"
}

internal fun trustedAppUpdateUrl(version: String, value: String): Boolean {
    if (!validAppUpdateVersion(version) || !value.startsWith(APP_UPDATE_REPOSITORY)) return false
    val parts = value.removePrefix(APP_UPDATE_REPOSITORY).split('/')
    return parts.size == 3 && parts[0] == "download" && parts[1].startsWith('v') &&
        validAppUpdateVersion(parts[1].drop(1)) && parts[2] == "benchgo-$version-android.apk"
}

internal fun verifyAppUpdateSignature(payload: ByteArray, signature: String, pem: String) {
    require(Regex("^[A-Za-z0-9+/]{86}==$").matches(signature)) { "更新清单签名格式无效" }
    val encoded = pem.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "").replace(Regex("\\s"), "")
    val key = runCatching { PublicKeyFactory.createKey(Base64.getDecoder().decode(encoded)) as Ed25519PublicKeyParameters }.getOrElse { error("更新信任公钥无效") }
    val verifier = Ed25519Signer().apply { init(false, key); update(payload, 0, payload.size) }
    require(verifier.verifySignature(Base64.getDecoder().decode(signature))) { "更新清单签名校验失败" }
}

/** Local APK updates have their own state and never mutate a connected Host. */
internal class AppUpdates(private val context: Context) {
    private val preferences = context.getSharedPreferences("benchgo_app_updates", Context.MODE_PRIVATE)
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(8, TimeUnit.SECONDS).readTimeout(8, TimeUnit.SECONDS).callTimeout(10, TimeUnit.SECONDS).build()
    private var phase = "idle"
    private var notice = "尚未检查本机应用更新"
    private var checkedAt: Long? = null
    private var releaseVersion: String? = null
    private var candidate: JSONObject? = null
    private var available = false
    private fun config() = JSONObject().put("source", preferences.getString("source", "mirror"))
        .put("mirrorUrl", preferences.getString("mirrorUrl", APP_UPDATE_MIRROR))

    @Synchronized fun status(): JSONObject = JSONObject().put("phase", phase).put("notice", notice).put("config", config())
        .put("current", JSONObject().put("version", BuildConfig.VERSION_NAME).put("versionCode", BuildConfig.VERSION_CODE))
        .put("available", available).put("checkedAt", checkedAt).put("releaseVersion", releaseVersion).put("android", candidate)

    @Synchronized fun configure(input: JSONObject): JSONObject {
        val source = input.optString("source", "mirror")
        require(source in listOf("mirror", "github", "custom")) { "未知更新源" }
        val mirror = if (source == "custom") normalizeAppUpdateMirror(input.optString("mirrorUrl").trim()) else APP_UPDATE_MIRROR
        require(preferences.edit().putString("source", source).putString("mirrorUrl", mirror).commit()) { "更新来源保存失败，请重试" }
        candidate = null; available = false; releaseVersion = null; phase = "idle"; notice = "更新来源已保存，请检查更新"; checkedAt = null
        return status()
    }

    private fun selectedUrl(canonical: String): String = if (preferences.getString("source", "mirror") == "github") canonical
        else normalizeAppUpdateMirror(preferences.getString("mirrorUrl", APP_UPDATE_MIRROR) ?: APP_UPDATE_MIRROR) + canonical

    private class Unpublished : Exception()
    private fun fetchBytes(canonical: String, maxBytes: Int, deadline: Long): ByteArray {
        val initial = selectedUrl(canonical)
        val allowed = setOf(URI(initial).host, "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com")
        var target = initial
        for (redirects in 0..4) {
            val remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
            require(remaining > 0) { "更新源响应超时，请重试或切换来源" }
            val bounded = client.newBuilder().callTimeout(minOf(10_000L, remaining), TimeUnit.MILLISECONDS).build()
            bounded.newCall(Request.Builder().url(target).header("Accept", "application/octet-stream").get().build()).execute().use { response ->
                if (response.code in listOf(301, 302, 303, 307, 308)) {
                    val location = response.header("Location") ?: error("更新源跳转地址缺失")
                    require(redirects < 4) { "更新源跳转次数过多" }
                    val next = URI(target).resolve(location)
                    require(next.scheme == "https" && next.host in allowed && next.rawUserInfo == null && next.rawFragment == null && next.port in listOf(-1, 443)) { "更新源返回了不受信任的跳转地址" }
                    target = next.toString()
                } else {
                    if (appUpdateChannelUnpublished(canonical, response.code)) throw Unpublished()
                    require(response.isSuccessful) { "更新源请求失败（HTTP ${response.code}）" }
                    val body = response.body ?: error("更新源返回空响应")
                    require(body.contentLength() <= maxBytes) { "更新清单超过允许大小" }
                    return body.byteStream().use { stream ->
                        val out = ByteArrayOutputStream(); val buffer = ByteArray(8192)
                        while (true) { val count = stream.read(buffer); if (count < 0) break; require(out.size() + count <= maxBytes) { "更新清单超过允许大小" }; out.write(buffer, 0, count) }
                        out.toByteArray()
                    }
                }
            }
        }
        error("更新源跳转次数过多")
    }

    private fun positiveInteger(value: JSONObject, key: String, maximum: Long): Long {
        val number = value.opt(key)
        require(number is Int || number is Long) { "手机更新字段 $key 无效" }
        val result = (number as Number).toLong()
        require(result in 1..maximum) { "手机更新字段 $key 无效" }
        return result
    }

    @Synchronized fun check(): JSONObject {
        checkedAt = null; phase = "checking"; available = false; candidate = null; releaseVersion = null; notice = "正在检查并验证签名…"
        try {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
            val bytes = fetchBytes(APP_UPDATE_MANIFEST, 256 * 1024, deadline)
            val signature = fetchBytes(APP_UPDATE_MANIFEST + ".sig", 4096, deadline).toString(Charsets.UTF_8).trim()
            val pem = context.assets.open("updates/update-public-key.pem").bufferedReader().use { it.readText() }
            verifyAppUpdateSignature(bytes, signature, pem)
            val manifest = JSONObject(bytes.toString(Charsets.UTF_8))
            require(manifest.opt("schemaVersion") == 1) { "不支持的更新清单格式" }
            if (manifest.has("releaseVersion")) {
                val version = manifest.opt("releaseVersion")
                require(version is String && validAppUpdateVersion(version)) { "统一发布版本无效" }
                releaseVersion = version
            }
            checkedAt = System.currentTimeMillis()
            if (!manifest.has("android")) {
                phase = "missing"; notice = "已验证发布签名，尚无手机更新信息"
            } else {
                val android = manifest.getJSONObject("android")
                val version = android.opt("version")
                require(version is String && validAppUpdateVersion(version)) { "手机应用版本无效" }
                val code = positiveInteger(android, "versionCode", Int.MAX_VALUE.toLong())
                val size = positiveInteger(android, "size", 1024L * 1024 * 1024)
                val url = android.opt("url"); val hash = android.opt("sha256")
                require(url is String && trustedAppUpdateUrl(version, url)) { "手机更新地址须为本仓库对应版本的 APK" }
                require(hash is String && Regex("^[a-f0-9]{64}$").matches(hash)) { "手机更新校验值无效" }
                candidate = JSONObject().put("version", version).put("versionCode", code).put("url", url).put("sha256", hash).put("size", size)
                available = code > BuildConfig.VERSION_CODE
                phase = if (available) "available" else "current"
                notice = if (available) "发现已验证签名的手机新版本" else "本机应用已是最新版本"
            }
        } catch (_: Unpublished) {
            phase = "unpublished"; notice = "更新通道尚未就绪"
        } catch (failure: Exception) {
            phase = "error"; notice = if (failure is java.io.IOException) "无法连接更新源，请重试或切换来源" else failure.message ?: "无法检查手机更新"
            candidate = null; available = false; releaseVersion = null
        }
        return status()
    }

    @Synchronized fun open(): JSONObject {
        val android = candidate
        require(phase == "available" && available && android != null) { "请先检查并验证手机新版本" }
        require(trustedAppUpdateUrl(android.getString("version"), android.getString("url"))) { "手机更新地址无效" }
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(selectedUrl(android.getString("url")))))
        return status().put("opened", true)
    }

    fun close() { client.dispatcher.cancelAll(); client.connectionPool.evictAll() }
}

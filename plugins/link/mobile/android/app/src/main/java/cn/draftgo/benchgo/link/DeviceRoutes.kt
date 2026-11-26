package cn.draftgo.benchgo.link

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.URI
import java.security.cert.CertificateException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response

internal data class DeviceRoute(
    val url: String,
    val pin: String,
    val kind: String,
    val relayId: String = "",
    val priority: Int = 0,
    val relayTarget: String = "",
)

internal class RouteHttpFailure(val status: Int, message: String) : IOException(message)
internal class RelayRoutesCooling : IOException("中继正在恢复，请稍后重试")
internal class HostIdentityFailure : IllegalStateException("主机身份已变更，请重新配对")

internal fun hostPin(hostId: String): String {
    if (hostId.isEmpty()) return ""
    val pin = hostId.removePrefix("sha256:")
    require(pin != hostId && runCatching { java.util.Base64.getDecoder().decode(pin).size == 32 }.getOrDefault(false)) { "主机身份无效" }
    return pin
}

internal fun trustedRoutes(raw: JSONArray?, hostId: String = ""): JSONArray? {
    if (raw == null) return null
    require(raw.length() <= 16) { "连接路由过多" }
    val expectedPin = hostPin(hostId)
    return JSONArray().apply {
        for (index in 0 until raw.length()) {
            val route = raw.getJSONObject(index)
            val kind = route.getString("kind")
            val target = Identity.parse(JSONObject().put("url", route.getString("url")).put("pin", route.optString("pin")).put("token", "validation"))
            require(kind == "direct" && target.pin.isNotEmpty() && (expectedPin.isEmpty() || expectedPin == target.pin) ||
                kind == "relay" && target.pin.isEmpty()) { "连接路由信任配置无效" }
            put(JSONObject().put("url", target.url).put("pin", target.pin).put("kind", kind).apply {
                if (kind == "relay") {
                    val relayTarget = validateRelayTarget(route.optString("relayTarget"), target.pin)
                    require(relayTarget.isEmpty() || hostId.isEmpty() || relayTarget == hostId) { "中继目标与主机身份不一致" }
                    if (relayTarget.isNotEmpty()) put("relayTarget", relayTarget)
                    val relayId = route.optString("relayId").ifBlank { route.optString("id") }.take(128)
                    if (relayId.isNotEmpty()) put("relayId", relayId)
                    put("priority", route.optInt("priority", index))
                }
            })
        }
    }
}

private fun localRouteHost(url: String): Boolean {
    val host = URI(url).host.trim('[', ']').lowercase()
    return host == "localhost" || host.endsWith(".localhost") || host == "::1" ||
        host == "0:0:0:0:0:0:0:1" || host.startsWith("127.")
}

internal fun orderedDeviceRoutes(identity: Identity): List<DeviceRoute> {
    val expectedHostId = identity.hostId.ifBlank { if (identity.pin.isEmpty()) "" else "sha256:${identity.pin}" }
    val routes = trustedRoutes(identity.routes, expectedHostId)
    if (routes == null || routes.length() == 0) return listOf(DeviceRoute(identity.url, identity.pin, if (identity.pin.isEmpty()) "relay" else "direct", relayTarget = identity.relayTarget))
    val candidates = (0 until routes.length()).map { index ->
        val route = routes.getJSONObject(index)
        val url = route.getString("url")
        val kind = route.getString("kind")
        val relayTarget = route.optString("relayTarget").ifBlank { if (kind == "relay" && url == identity.url) identity.relayTarget else "" }
        DeviceRoute(url, route.getString("pin"), kind, route.optString("relayId"), route.optInt("priority", index), relayTarget)
    }
    val ordered = orderDeviceRouteCandidates(candidates, identity.url)
    if (identity.groupId.isEmpty() || ordered.any { it.url == identity.url && it.pin == identity.pin && it.relayTarget == identity.relayTarget }) return ordered
    val admitted = DeviceRoute(identity.url, identity.pin, if (identity.pin.isEmpty()) "public" else "direct", relayTarget = identity.relayTarget)
    return if (admitted.kind == "direct") listOf(admitted) + ordered else ordered + admitted
}

internal fun orderDeviceRouteCandidates(candidates: List<DeviceRoute>, admittedUrl: String): List<DeviceRoute> =
    candidates.filterNot { it.kind == "direct" && it.url != admittedUrl && localRouteHost(it.url) }
        .distinctBy { Triple(it.kind, it.url, it.pin) }
        .sortedWith(compareBy<DeviceRoute> { if (it.kind == "direct") 0 else 1 }.thenBy { if (it.kind == "relay") it.priority else 0 })

internal fun <T> connectOnDeviceRoute(
    routes: List<DeviceRoute>,
    cooling: (DeviceRoute) -> Boolean,
    onFailure: (DeviceRoute) -> Unit,
    scheduler: ScheduledExecutorService? = null,
    probe: ((DeviceRoute) -> Call)? = null,
    connect: (DeviceRoute) -> T,
): T {
    var lastFailure: IOException? = null
    val available = routes.filterNot { it.kind == "relay" && cooling(it) }
    val pending = mutableMapOf<Int, CompletableFuture<IOException?>>()
    val cancel = mutableListOf<() -> Unit>()
    try {
        for ((index, route) in available.withIndex()) {
            if (scheduler != null && probe != null) for (offset in 1..2) {
                val next = available.getOrNull(index + offset) ?: break
                pending.getOrPut(index + offset) {
                    val call = probe(next)
                    val result = CompletableFuture<IOException?>()
                    val timer = scheduler.schedule({
                        call.enqueue(object : Callback {
                            override fun onFailure(call: Call, e: IOException) { result.complete(e) }
                            override fun onResponse(call: Call, response: Response) {
                                response.use {
                                    result.complete(if (it.code in 502..504) RouteHttpFailure(it.code, "连接暂不可用") else null)
                                }
                            }
                        })
                    }, 100L * offset, TimeUnit.MILLISECONDS)
                    cancel.add { timer.cancel(false); call.cancel() }
                    result
                }
            }
            try {
                pending[index]?.get()?.let { throw it }
                return connect(route)
            } catch (error: IOException) {
                if (generateSequence<Throwable>(error) { it.cause }.take(12).any { it is SSLException || it is CertificateException } ||
                    error is RouteHttpFailure && error.status !in 502..504) throw error
                lastFailure = error
                if (route.kind == "relay") onFailure(route)
            }
        }
    } finally {
        cancel.forEach { it() }
    }
    throw lastFailure ?: if (available.size < routes.size) RelayRoutesCooling() else IOException("无可用连接路由")
}

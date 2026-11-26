package cn.draftgo.benchgo.link

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.WebViewAssetLoader
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.URI
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.TimeUnit
import java.util.concurrent.Executors
import java.util.concurrent.ConcurrentHashMap

private const val APP_ORIGIN = "https://appassets.androidplatform.net"
private const val START_URL = "$APP_ORIGIN/assets/index.html"

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var localView: WebView
    private lateinit var layout: android.widget.LinearLayout
    private lateinit var content: android.widget.FrameLayout
    private lateinit var loadingView: NativeLoadingView
    private val workbenches = ConcurrentHashMap<String, WebView>()
    private lateinit var bridge: LinkBridge
    private var pendingBootstrap: String? = null
    private lateinit var devicesButton: android.widget.TextView
    private lateinit var appearance: NativeAppearance
    private lateinit var deviceNavigation: NativeDeviceNavigation
    private var workbenchIdentity: Identity? = null
    private val leaseRefresh = object : Runnable {
        override fun run() {
            workbenchIdentity?.takeIf { it.assetOwner.isNotEmpty() }?.let { bridge.renewWorkbench(it, webView, reload = false) }
            devicesButton.postDelayed(this, 45_000)
        }
    }
    private var microphoneRequest: android.webkit.PermissionRequest? = null
    private var uploadCallback: android.webkit.ValueCallback<Array<android.net.Uri>>? = null
    private val microphonePermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        microphoneRequest?.let { request -> if (granted && request.origin.toString().trimEnd('/') == workbenchIdentity?.url) request.grant(arrayOf(android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else request.deny() }
        microphoneRequest = null
    }
    private val uploadPicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        uploadCallback?.onReceiveValue(android.webkit.WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        uploadCallback = null
    }

    private val scanner = registerForActivityResult(ScanContract()) { result ->
        if (result.contents != null) handlePairUri(result.contents)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
        bridge = LinkBridge(this) { json ->
            pendingBootstrap = json
            dispatchBootstrap(json)
        }
        webView = WebView(this).apply { setBackgroundColor(getColor(R.color.benchgo_brand_background)) }
        localView = webView
        layout = android.widget.LinearLayout(this).apply { orientation = android.widget.LinearLayout.VERTICAL; setBackgroundColor(getColor(R.color.benchgo_brand_background)) }
        val density = resources.displayMetrics.density
        devicesButton = android.widget.TextView(this).apply {
            text = "‹  设备"; textSize = 14f; setTextColor(android.graphics.Color.rgb(67, 91, 117))
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding((16 * density).toInt(), 0, (16 * density).toInt(), 0)
            contentDescription = "返回本机设备列表"; visibility = android.view.View.GONE
            setOnClickListener { returnToDevices() }
        }
        layout.addView(devicesButton, android.widget.LinearLayout.LayoutParams(-1, (44 * density).toInt()))
        content = android.widget.FrameLayout(this)
        content.addView(webView, android.widget.FrameLayout.LayoutParams(-1, -1))
        loadingView = NativeLoadingView(this)
        content.addView(loadingView, android.widget.FrameLayout.LayoutParams(-1, -1))
        layout.addView(content, android.widget.LinearLayout.LayoutParams(-1, 0, 1f))
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(layout) { view, insets ->
            val bars = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars() or androidx.core.view.WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime())
            val padding = ContentInsets(bars.left, bars.top, bars.right, bars.bottom).merge(ContentInsets(ime.left, ime.top, ime.right, ime.bottom))
            view.setPadding(padding.left, padding.top, padding.right, padding.bottom)
            // WebViews are already inside the native safe area. Do not send it twice.
            androidx.core.view.WindowInsetsCompat.CONSUMED
        }
        setContentView(layout)
        androidx.core.view.ViewCompat.requestApplyInsets(layout)
        appearance = NativeAppearance(this, layout, devicesButton, loadingView) { webView }
        deviceNavigation = NativeDeviceNavigation(devicesButton, { webView }, ::returnToDevices)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false
        webView.settings.setSupportMultipleWindows(false)
        webView.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        android.webkit.CookieManager.getInstance().setAcceptCookie(true)
        android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)
        webView.webViewClient = localClient()
        webView.addJavascriptInterface(bridge, "LinkNative")
        appearance.attach(webView, APP_ORIGIN)
        webView.loadUrl(START_URL)
        intent?.data?.let { handlePairUri(it.toString()) }
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (workbenchIdentity != null) returnToDevices()
                else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.data?.let { handlePairUri(it.toString()) }
    }

    override fun onResume() {
        super.onResume()
        if (::appearance.isInitialized) appearance.resume()
        if (::loadingView.isInitialized) loadingView.setResumed(true)
        if (::devicesButton.isInitialized) devicesButton.post(leaseRefresh)
    }

    override fun onPause() {
        if (::devicesButton.isInitialized) devicesButton.removeCallbacks(leaseRefresh)
        if (::loadingView.isInitialized) loadingView.setResumed(false)
        if (::appearance.isInitialized) appearance.pause()
        super.onPause()
    }

    override fun onDestroy() {
        microphoneRequest?.deny(); uploadCallback?.onReceiveValue(null)
        bridge.close()
        loadingView.close()
        appearance.close()
        deviceNavigation.close()
        localView.removeJavascriptInterface("LinkNative")
        workbenches.values.forEach { it.destroy() }; workbenches.clear()
        localView.destroy()
        super.onDestroy()
    }

    private fun localClient() = object : WebViewClient() {
        private val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this@MainActivity))
            .build()

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            return loader.shouldInterceptRequest(request.url)
                ?: WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), java.io.ByteArrayInputStream(ByteArray(0)))
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            if (uri.scheme == "https" && uri.host == "appassets.androidplatform.net") return false
            if (uri.scheme in listOf("benchgo", "dshlink")) { handlePairUri(uri.toString()); return true }
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
            return true
        }

        override fun onPageFinished(view: WebView, url: String) {
            appearance.pageReady(view)
            pendingBootstrap?.let { dispatchBootstrap(it) }
        }
    }

    private fun handlePairUri(raw: String) {
        val parsed = runCatching { parsePairingLink(raw) }.getOrElse {
            android.widget.Toast.makeText(this, it.message ?: "配对信息无效", android.widget.Toast.LENGTH_LONG).show()
            return
        }
        val value = JSONObject().apply {
            put("url", parsed.url); put("pin", parsed.pin); put("code", parsed.code)
            if (parsed.name.isNotEmpty()) put("name", parsed.name)
            if (parsed.relayTarget.isNotEmpty()) put("relayTarget", parsed.relayTarget)
        }.toString()
        val saved = bridge.saveIdentity(value)
        val outcome = JSONObject(saved)
        if (!outcome.optBoolean("ok")) {
            android.widget.Toast.makeText(this, outcome.optString("error", "配对信息无效"), android.widget.Toast.LENGTH_LONG).show()
        }
    }

    private fun dispatchBootstrap(json: String) {
        if (!::webView.isInitialized) return
        webView.post {
            if (!webView.url.orEmpty().startsWith(START_URL)) return@post
            val encoded = JSONObject.quote(json)
            webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('link:bootstrap',{detail:$encoded}));", null)
        }
    }

    fun launchScanner() {
        runOnUiThread { scanner.launch(ScanOptions().apply {
            setCaptureActivity(LinkScannerActivity::class.java)
            setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            setPrompt("")
            setBeepEnabled(false)
            setOrientationLocked(true)
        }) }
    }

    fun deliverResult(script: String) { if (localView.url.orEmpty().startsWith(START_URL)) localView.evaluateJavascript(script, null) }
    private fun showView(view: WebView, deviceName: String? = null) {
        if (webView === view) { deviceNavigation.show(view, deviceName); return }
        content.removeView(webView); webView = view
        content.addView(view, 0, android.widget.FrameLayout.LayoutParams(-1, -1))
        appearance.show(view)
        deviceNavigation.show(view, deviceName)
    }
    fun canOpenDevice(id: String): Boolean = workbenches.containsKey(id) || workbenches.size < 4
    fun workbenchLoading(loading: Boolean) { runOnUiThread { loadingView.setLoading(loading) } }
    internal fun setWorkbenchCookies(identity: Identity, cookie: String, isCurrent: () -> Boolean, ready: (Boolean) -> Unit) {
        if (!isCurrent()) return
        val manager = android.webkit.CookieManager.getInstance()
        val url = identity.url + "/link/workbench/"
        if (identity.relayTarget.isEmpty()) {
            manager.setCookie(url, cookie) { if (isCurrent()) ready(it) }
            return
        }
        val route = "dsh_link_relay_target=" + identity.relayTarget + "; Path=/link; Secure; HttpOnly; SameSite=Lax"
        manager.setCookie(url, route) { accepted ->
            if (!isCurrent()) return@setCookie
            if (accepted) manager.setCookie(url, cookie) { if (isCurrent()) ready(it) }
            else ready(false)
        }
    }
    fun forgetDevice(id: String) {
        runOnUiThread { workbenches.remove(id)?.let { view -> if (view === webView) returnToDevices(); appearance.detach(view); deviceNavigation.detach(view); view.destroy() } }
    }

    fun openWorkbench(identity: Identity, cookie: String, isCurrent: () -> Boolean) {
        runOnUiThread {
            if (!isCurrent()) return@runOnUiThread
            val cached = workbenches[identity.id]
            if (cached != null && cached.tag == identity.url) {
                setWorkbenchCookies(identity, cookie, isCurrent) { accepted ->
                    if (accepted) {
                        workbenchLoading(false)
                        showView(cached, identity.publicJson().optString("name")); workbenchIdentity = identity; pendingBootstrap = null
                        devicesButton.text = "‹  设备 · " + identity.publicJson().optString("name")
                    } else workbenchFailed("无法保存工作台连接，请重试")
                }
                return@runOnUiThread
            }
            cached?.let { workbenches.remove(identity.id); appearance.detach(it); deviceNavigation.detach(it); it.destroy() }
            val remote = WebView(this).apply {
                settings.javaScriptEnabled = true; settings.domStorageEnabled = true
                settings.allowFileAccess = false; settings.allowContentAccess = false
                settings.setSupportMultipleWindows(false)
                settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
                tag = identity.url
            }
            android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(remote, false)
            workbenches[identity.id] = remote
            appearance.attach(remote, identity.url)
            deviceNavigation.attach(remote, identity.url, identity.publicJson().optString("name"))
            showView(remote)
            workbenchIdentity = identity
            devicesButton.text = "‹  设备 · " + identity.publicJson().optString("name")
            pendingBootstrap = null
            webView.removeJavascriptInterface("LinkNative")
            webView.webViewClient = workbenchClient(identity)
            webView.webChromeClient = object : android.webkit.WebChromeClient() {
                override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                    runOnUiThread {
                        if (request.origin.toString().trimEnd('/') != identity.url || !request.resources.contains(android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE)) { request.deny(); return@runOnUiThread }
                        microphoneRequest?.deny(); microphoneRequest = request
                        microphonePermission.launch(android.Manifest.permission.RECORD_AUDIO)
                    }
                }
                override fun onPermissionRequestCanceled(request: android.webkit.PermissionRequest) { if (microphoneRequest === request) microphoneRequest = null }
                override fun onShowFileChooser(view: WebView, callback: android.webkit.ValueCallback<Array<android.net.Uri>>, params: FileChooserParams): Boolean {
                    uploadCallback?.onReceiveValue(null); uploadCallback = callback
                    return runCatching { uploadPicker.launch(params.createIntent()); true }.getOrElse { uploadCallback?.onReceiveValue(null); uploadCallback = null; false }
                }
            }
            setWorkbenchCookies(identity, cookie, isCurrent) { accepted ->
                if (accepted) {
                    val path = getSharedPreferences("link_locations", Context.MODE_PRIVATE).getString(identity.id, "/link/workbench/") ?: "/link/workbench/"
                    val restored = runCatching { URI(identity.url + path) }.getOrNull()
                    remote.loadUrl(if (restored != null && restored.host == URI(identity.url).host && restored.path.startsWith("/link/workbench/") && !path.startsWith("//")) identity.url + path else identity.url + "/link/workbench/")
                }
                else workbenchFailed("无法保存工作台连接，请重试")
            }
        }
    }

    private fun workbenchClient(identity: Identity) = object : WebViewClient() {
        private var renewedAt = 0L
        private fun allowed(uri: android.net.Uri): Boolean = runCatching {
            val target = URI(uri.toString()); val host = URI(identity.url)
            target.scheme == "https" && target.host.equals(host.host, true) && target.port == host.port && target.rawUserInfo == null && target.path.startsWith("/link/workbench/")
        }.getOrDefault(false)
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (allowed(request.url)) return false
            if (request.url.toString() == identity.url + "/link/") {
                if (request.isForMainFrame && view === webView) {
                    if (System.currentTimeMillis() - renewedAt > 30_000) { renewedAt = System.currentTimeMillis(); bridge.renewWorkbench(identity, view) }
                    else workbenchFailed("设备会话无法恢复，请重新打开设备")
                }
                return true
            }
            if (request.url.scheme in listOf("https", "http", "mailto")) runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
            return true
        }
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            if (allowed(request.url) || request.url.scheme in listOf("blob", "data")) return null
            return WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), java.io.ByteArrayInputStream(ByteArray(0)))
        }
        override fun onReceivedSslError(view: WebView, handler: android.webkit.SslErrorHandler, error: android.net.http.SslError) {
            // LAN self-signed certificates are trusted only by the QR's exact SPKI anchor.
            val trusted = identity.pin.isNotEmpty() && allowed(android.net.Uri.parse(error.url)) && runCatching {
                val bytes = android.net.http.SslCertificate.saveState(error.certificate).getByteArray("x509-certificate") ?: return@runCatching false
                val cert = java.security.cert.CertificateFactory.getInstance("X.509").generateCertificate(java.io.ByteArrayInputStream(bytes)) as java.security.cert.X509Certificate
                cert.checkValidity()
                MessageDigest.isEqual(MessageDigest.getInstance("SHA-256").digest(cert.publicKey.encoded), Base64.getDecoder().decode(identity.pin))
            }.getOrDefault(false)
            if (trusted) handler.proceed() else { workbenchLoading(false); deviceNavigation.pageFailed(view); handler.cancel() }
        }
        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
            if (view === webView) workbenchLoading(true)
            deviceNavigation.pageStarted(view)
        }
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
            if (request.isForMainFrame) { workbenchLoading(false); deviceNavigation.pageFailed(view) }
        }
        override fun onPageFinished(view: WebView, url: String) {
            if (allowed(android.net.Uri.parse(url))) {
                appearance.pageReady(view)
                deviceNavigation.pageReady(view)
                if (view === webView) workbenchLoading(false)
                val target = URI(url)
                val path = target.rawPath + (target.rawQuery?.let { "?" + it } ?: "") + (target.rawFragment?.let { "#" + it } ?: "")
                getSharedPreferences("link_locations", Context.MODE_PRIVATE).edit().putString(identity.id, path).apply()
            }
        }
        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (response.statusCode == 401 && System.currentTimeMillis() - renewedAt > 30_000) {
                renewedAt = System.currentTimeMillis()
                bridge.renewWorkbench(identity, view)
            } else if (response.statusCode == 401 && request.isForMainFrame) {
                workbenchFailed("设备授权无法恢复，请重新打开设备")
            } else if (request.isForMainFrame) {
                workbenchLoading(false); deviceNavigation.pageFailed(view)
            }
        }
    }

    private fun returnToDevices() {
        bridge.showDevices()
        workbenchLoading(false)
        pendingBootstrap = null
        showView(localView)
        devicesButton.visibility = android.view.View.GONE
        microphoneRequest?.deny(); microphoneRequest = null
        uploadCallback?.onReceiveValue(null); uploadCallback = null
        workbenchIdentity = null; webView.stopLoading()
        webView.webViewClient = localClient(); webView.webChromeClient = android.webkit.WebChromeClient()
        webView.addJavascriptInterface(bridge, "LinkNative"); webView.loadUrl(START_URL)
    }
    fun workbenchFailed(message: String) {
        runOnUiThread {
            workbenchLoading(false)
            if (workbenchIdentity != null) { returnToDevices(); android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_LONG).show() }
            else webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('link:workbench-error',{detail:${JSONObject.quote(message)}}));", null)
        }
    }
}

class LinkBridge(private val context: MainActivity, private val onIdentity: (String) -> Unit) {
    private val store = IdentityStore(context)
    private val groupClient by lazy { DeviceGroupClient() }
    private val directoryRefresh = java.util.concurrent.atomic.AtomicBoolean()
    @Volatile private var nextDirectoryRefresh = 0L
    private val executor = Executors.newFixedThreadPool(3)
    private val routeScheduler = Executors.newSingleThreadScheduledExecutor()
    private val clients = ConcurrentHashMap<String, OkHttpClient>()
    private val pairs = ConcurrentHashMap<String, NativePair>()
    private val routeCooldowns = ConcurrentHashMap<String, ConcurrentHashMap<DeviceRoute, Long>>()
    private val activeRoutes = ConcurrentHashMap<String, DeviceRoute>()
    private val pendingIdentity = java.util.concurrent.atomic.AtomicReference<Identity?>()
    @Volatile private var devicesVisible = true
    private val connectionGeneration = java.util.concurrent.atomic.AtomicLong()
    private val servers = SshServerManager(context) { identity -> store.write(identity, false) }
    private val appUpdates = AppUpdates(context)
    private data class NativePair(val identity: Identity, val pollToken: String, val expiresAt: Long, val deviceGroup: Boolean)
    private fun existingDevice(identity: Identity) = store.all().firstOrNull {
        it.hostKey == identity.hostKey ||
            identity.relayTarget.isNotEmpty() && it.url == identity.url && it.pin.isEmpty() && it.hostId == identity.relayTarget
    }
    private fun capabilities() = JSONObject().put("devices", true).put("ssh", true).put("appUpdates", true)
    fun showDevices() { connectionGeneration.incrementAndGet(); pendingIdentity.set(null); devicesVisible = true }
    private fun currentIdentity() = pendingIdentity.get() ?: store.read()
    private fun canOpenAnother(id: String) = context.canOpenDevice(id)

    @JavascriptInterface
    fun bootstrap(): String = (currentIdentity()?.toJson() ?: JSONObject()).put("showDevices", devicesVisible)
        .put("localName", store.localName()).put("capabilities", capabilities()).toString()

    @JavascriptInterface
    fun saveIdentity(raw: String): String {
        return try {
            val value = JSONObject(raw)
            var incoming = Identity.parse(value)
            if (value.optString("localName").isNotBlank()) store.renameLocal(value.getString("localName"))
            val existing = existingDevice(incoming)
            if (existing != null && existing.token.isNotEmpty() && incoming.token.isNotEmpty() && existing.token != incoming.token && incoming.code.isEmpty()) {
                return errorJson("缺少一次性配对码")
            }
            if (existing != null && incoming.token.isEmpty() && incoming.code.isEmpty()) incoming = incoming.copy(token = existing.token)
            if (existing != null) incoming = incoming.copy(id = existing.id, kind = existing.kind, ssh = existing.ssh, alias = existing.alias,
                routes = incoming.routes ?: existing.routes, hostId = incoming.hostId.ifBlank { existing.hostId })
            if (incoming.token.isNotEmpty()) { store.write(incoming); pendingIdentity.set(null) } else pendingIdentity.set(incoming)
            connectionGeneration.incrementAndGet(); devicesVisible = false
            onIdentity(bootstrap())
            JSONObject().put("ok", true).toString()
        } catch (e: Exception) { errorJson(e.message ?: "无效的配对信息") }
    }

    @JavascriptInterface
    fun clearIdentity(): String { showDevices(); return JSONObject().put("ok", true).toString() }

    @JavascriptInterface
    fun scan(): String { context.launchScanner(); return JSONObject().put("ok", true).toString() }

    @JavascriptInterface
    fun openWorkbench(): String {
        val identity = store.read() ?: return errorJson("请先配对工作台")
        if (identity.token.isEmpty() && identity.groupId.isEmpty()) return errorJson("请先在电脑上允许连接")
        if (!canOpenAnother(identity.id)) return errorJson("已保留 4 个工作台，请先关闭暂不用的设备页面")
        val generation = connectionGeneration.get()
        context.workbenchLoading(true)
        executor.execute {
            runCatching {
                val isCurrent = { generation == connectionGeneration.get() && store.selectedId() == identity.id }
                val (chosen, cookie) = connectWorkbench(identity, isCurrent)
                if (isCurrent()) context.openWorkbench(chosen, cookie, isCurrent)
            }.onFailure { if (generation == connectionGeneration.get()) context.workbenchFailed(connectionFailureMessage(it, identity.url, identity.pin.isNotEmpty())) }
        }
        return JSONObject().put("ok", true).toString()
    }

    private fun authorization(identity: Identity): String {
        if (identity.groupId.isEmpty()) return identity.token
        val group = store.group()?.takeIf { it.optString("groupId") == identity.groupId } ?: error("设备组授权已失效")
        return groupClient.token(group, identity.hostId)
    }

    private fun workbenchCookie(identity: Identity, client: OkHttpClient = clientFor(identity)): String {
        if (identity.assetOwner.isNotEmpty()) {
            val (target, cookie) = assetWorkspace(identity)
            require(target.hostId == identity.hostId && orderedDeviceRoutes(target).any {
                it.url == identity.url && it.pin == identity.pin && it.relayTarget == identity.relayTarget
            }) { "工作台路线已更新，请重新打开设备" }
            return cookie
        }
        return workbenchSession(identity, client).second
    }

    private fun workbenchSession(identity: Identity, client: OkHttpClient): Pair<JSONObject, String> {
        val expectedHost = identity.hostId.ifBlank { identity.relayTarget.ifBlank { if (identity.pin.isEmpty()) "" else "sha256:${identity.pin}" } }
        val input = JSONObject()
        if (expectedHost.isNotEmpty()) input.put("expectedHostId", expectedHost)
        val request = Request.Builder().url(identity.url + "/link/api/workbench")
            .header("Authorization", "Bearer ${authorization(identity)}")
            .post(input.toString().toRequestBody("application/json".toMediaType())).build()
        return client.newCall(request).execute().use { result ->
            if (!result.isSuccessful) {
                val message = runCatching { JSONObject(result.body?.string() ?: "{}").optString("error") }.getOrDefault("")
                throw RouteHttpFailure(result.code, message.ifBlank { "工作台连接失败（HTTP ${result.code}）" })
            }
            val body = JSONObject(result.body?.string() ?: "{}")
            val hostId = body.optString("hostId")
            if (hostId.isEmpty() || body.optString("authorizationId").isEmpty() || body.optString("url") != "/link/workbench/")
                throw RouteHttpFailure(409, "请更新目标主机上的 BenchGo 以打开工作台")
            val pin = hostPin(hostId)
            if (expectedHost.isNotEmpty() && expectedHost != hostId || identity.pin.isNotEmpty() && pin != identity.pin)
                throw HostIdentityFailure()
            val cookie = result.headers.values("Set-Cookie").singleOrNull { it.contains("Path=/link/workbench/", true) && it.contains("HttpOnly", true) }
                ?: throw IllegalStateException("工作台未返回设备会话")
            body to cookie
        }
    }

    private fun probeRoute(identity: Identity, route: DeviceRoute): Call {
        val candidate = identity.copy(url = route.url, pin = route.pin, relayTarget = route.relayTarget)
        val client = clientFor(candidate).newBuilder().connectTimeout(2, TimeUnit.SECONDS)
            .callTimeout(2_500, TimeUnit.MILLISECONDS).retryOnConnectionFailure(false).build()
        return client.newCall(Request.Builder().url(candidate.url + "/link/api/info").build())
    }

    private fun connectWorkbench(identity: Identity, isCurrent: () -> Boolean): Pair<Identity, String> {
        if (identity.assetOwner.isNotEmpty()) {
            val (target, cookie) = assetWorkspace(identity)
            return connectOnDeviceRoute(orderedDeviceRoutes(target), { false }, {}, routeScheduler, { probeRoute(target, it) }) { route ->
                check(isCurrent()) { "连接已取消" }
                val candidate = target.copy(url = route.url, pin = route.pin, relayTarget = route.relayTarget)
                val client = clientFor(candidate).newBuilder().connectTimeout(2, TimeUnit.SECONDS)
                    .callTimeout(5, TimeUnit.SECONDS).retryOnConnectionFailure(false).build()
                val entry = Request.Builder().url(candidate.url + "/link/workbench/").head()
                    .header("Cookie", cookie.substringBefore(';')).build()
                client.newCall(entry).execute().use { response ->
                    if (!response.isSuccessful) throw RouteHttpFailure(response.code, "工作台暂不可用（HTTP ${response.code}）")
                }
                candidate to cookie
            }
        }
        if (identity.kind != "computer") return identity to workbenchCookie(identity)
        val candidates = orderedDeviceRoutes(identity)
        val cooldowns = routeCooldowns.getOrPut(identity.id) { ConcurrentHashMap() }
        cooldowns.entries.removeIf { it.value <= System.currentTimeMillis() }
        return connectOnDeviceRoute(candidates, { route -> (cooldowns[route] ?: 0) > System.currentTimeMillis() },
            { route -> cooldowns[route] = System.currentTimeMillis() + 10_000 }, routeScheduler, { probeRoute(identity, it) }) { route ->
            check(isCurrent()) { "连接已取消" }
            val candidate = identity.copy(url = route.url, pin = route.pin, relayTarget = route.relayTarget)
            val client = clientFor(candidate).newBuilder().connectTimeout(2, TimeUnit.SECONDS)
                .readTimeout(5, TimeUnit.SECONDS).callTimeout(6, TimeUnit.SECONDS).retryOnConnectionFailure(false).build()
            val (info, cookie) = workbenchSession(candidate, client)
            val hostId = info.getString("hostId")
            val discovered = trustedRoutes(info.optJSONArray("routes"), hostId)
            val name = info.optString("hostName").trim().take(100)
            check(isCurrent()) { "连接已取消" }
            store.refreshConnection(identity, name, discovered, hostId)
            activeRoutes[identity.id] = route
            cooldowns.remove(route)
            candidate.copy(name = name.ifBlank { identity.name }, hostId = hostId) to cookie
        }
    }

    private fun groupRpc(host: Identity, input: JSONObject, directory: JSONObject = store.group() ?: error("设备组授权已失效")): JSONObject {
        val sync = input.optString("operation") == "clientDirectory"
        val token = groupClient.token(directory, host.hostId, sync)
        input.put("action", "deviceGroup")
        val select = { route: DeviceRoute ->
            val target = host.copy(url = route.url, pin = route.pin, relayTarget = route.relayTarget)
            val client = clientFor(target).newBuilder().connectTimeout(1, TimeUnit.SECONDS)
                .callTimeout(if (sync) 2 else 20, TimeUnit.SECONDS)
                .retryOnConnectionFailure(false).build()
            target to client
        }
        val routes = orderedDeviceRoutes(host)
        if (sync) return connectOnDeviceRoute(routes, { false }, {}, routeScheduler, { probeRoute(host, it) }) { route ->
            val (target, client) = select(route)
            post(target, "/link/api/rpc", input, token, client)
        }
        val (target, client) = connectOnDeviceRoute(routes, { false }, {}, routeScheduler, { probeRoute(host, it) }) { route ->
            val (candidate, transport) = select(route)
            val request = Request.Builder().url(candidate.url + "/link/api/info")
                .header("Authorization", "Bearer $token").get().build()
            transport.newBuilder().callTimeout(2, TimeUnit.SECONDS).build().newCall(request).execute().use { response ->
                if (!response.isSuccessful) throw RouteHttpFailure(response.code, "登记主机连接失败（HTTP ${response.code}）")
                if (JSONObject(response.body?.string() ?: "{}").optString("hostId") != host.hostId) throw HostIdentityFailure()
            }
            candidate to transport
        }
        return post(target, "/link/api/rpc", input, token, client)
    }

    private fun refreshGroup() {
        val previous = store.group() ?: return
        if (System.currentTimeMillis() < nextDirectoryRefresh) return
        if (!directoryRefresh.compareAndSet(false, true)) return
        nextDirectoryRefresh = System.currentTimeMillis() + 4_000
        executor.execute {
            try {
                for (host in groupHosts(previous)) {
                    val current = runCatching { groupRpc(host, JSONObject().put("operation", "clientDirectory"), previous) }.getOrNull() ?: continue
                    if (current.optString("groupId") != previous.optString("groupId")) continue
                    val next = current.takeUnless { it.optBoolean("revoked") }
                    if (next != null) {
                        if (next.optJSONObject("self")?.optString("generation") != previous.optJSONObject("self")?.optString("generation")) continue
                        if (runCatching { groupClient.verifyDirectory(next) }.isFailure) continue
                        previous.optJSONObject("entry")?.let { next.put("entry", it) }
                    }
                    val removed = runCatching { store.saveGroup(next, previous) }.getOrNull() ?: break
                    removed.forEach(context::forgetDevice)
                    if (store.group() === next) context.runOnUiThread {
                        context.deliverResult("window.dispatchEvent(new Event('link:device-directory'));")
                    }
                    break
                }
            } finally {
                directoryRefresh.set(false)
            }
        }
    }

    private fun assetWorkspace(identity: Identity): Pair<Identity, String> {
        val owner = store.get(identity.assetOwner) ?: error("登记主机已退出设备组")
        val value = groupRpc(owner, JSONObject().put("operation", "asset").put("command", "workspace").put("assetId", identity.id))
        val hostId = value.getString("hostId")
        if (identity.hostId.isNotEmpty() && hostId != identity.hostId) throw HostIdentityFailure()
        val target = Identity.parse(value.put("groupId", identity.groupId).put("id", identity.id).put("name", identity.name))
            .copy(assetOwner = owner.id)
        if (target.pin.isNotEmpty() && target.pin != hostPin(hostId) || target.relayTarget.isNotEmpty() && target.relayTarget != hostId) throw HostIdentityFailure()
        val cookie = value.getString("cookie")
        require(cookie.startsWith("dsh_link_workbench=") && cookie.contains("Path=/link/workbench/", true) && cookie.contains("HttpOnly", true))
        return target to cookie
    }

    fun renewWorkbench(identity: Identity, view: WebView, reload: Boolean = true) {
        val generation = connectionGeneration.get()
        executor.execute {
            runCatching {
                val saved = store.get(identity.id) ?: error("设备已移除")
                require(saved.token == identity.token && saved.groupId == identity.groupId) { "设备授权已更改" }
                val cookie = workbenchCookie(identity)
                context.runOnUiThread {
                    if (generation != connectionGeneration.get() || store.selectedId() != identity.id) return@runOnUiThread
                    context.setWorkbenchCookies(identity, cookie, { generation == connectionGeneration.get() && store.selectedId() == identity.id }) { accepted ->
                        if (accepted && reload) view.reload()
                        else if (!accepted) context.workbenchFailed("无法恢复设备会话，请重试")
                    }
                }
            }.onFailure { if (generation == connectionGeneration.get()) context.workbenchFailed(connectionFailureMessage(it, identity.url, identity.pin.isNotEmpty())) }
        }
    }

    @JavascriptInterface
    fun deviceCall(raw: String): String {
        val input = runCatching { JSONObject(raw) }.getOrNull() ?: return errorJson("无效的设备请求")
        val requestId = input.optString("id")
        executor.execute {
            val result = try { JSONObject().put("ok", true).put("body", deviceAction(input)).toString() }
                catch (error: Exception) { errorJson(error.message ?: "设备操作失败") }
            context.runOnUiThread { context.deliverResult("window.__linkNativeResult && window.__linkNativeResult(" + JSONObject.quote(requestId) + "," + JSONObject.quote(result) + ");") }
        }
        return ""
    }

    private fun deviceAction(input: JSONObject): JSONObject {
        val targetId = input.optString("deviceId").ifBlank { input.optString("targetId") }
        return when (input.optString("action")) {
            "appUpdateStatus" -> appUpdates.status()
            "appUpdateConfigure" -> appUpdates.configure(input)
            "appUpdateCheck" -> appUpdates.check()
            "appUpdateOpen" -> appUpdates.open()
            "list" -> {
                refreshGroup()
                val group = store.group()
                val hosts = store.all()
                val assets = group?.optJSONArray("assets")
                val shared = (0 until (assets?.length() ?: 0)).map { assets!!.getJSONObject(it) }
                val hostIds = hosts.map { it.hostId }.filter { it.isNotEmpty() }.toSet()
                val members = group?.optJSONArray("members")
                val self = group?.optJSONObject("self")?.optString("id")
                val additional = (0 until (members?.length() ?: 0)).map { members!!.getJSONObject(it) }.mapNotNull { member ->
                    val id = member.getString("id")
                    if (id == self || id in hostIds) return@mapNotNull null
                    JSONObject().put("id", id).put("name", member.getString("name")).put("hostId", id)
                        .put("deviceType", member.optString("deviceType")).put("kind", "paired")
                        .put("groupMember", true).put("status", "unknown")
                }
                val devices = listOf(localDevice()) + hosts.map { host ->
                    host.publicJson(if (host.kind == "ssh") servers.status(host.id) else "unknown").apply {
                        activeRoutes[host.id]?.let { route ->
                            put("currentPath", route.kind)
                            if (route.kind == "relay") put("currentRelayUrl", route.url)
                            if (route.relayId.isNotEmpty()) put("currentRelayId", route.relayId)
                        }
                        shared.firstOrNull { host.hostId.isNotEmpty() && it.optString("hostId") == host.hostId && it.optBoolean("sharedTerminal") }?.let {
                            put("sharedTerminal", true).put("terminalAssetId", it.getString("id"))
                        }
                    }
                } + additional + shared.filter { it.optString("hostId") !in hostIds }
                JSONObject().put("devices", org.json.JSONArray(devices)).put("activeId", store.selectedId()).put("capabilities", capabilities())
                    .apply { if (group != null) put("group", JSONObject().put("enabled", true).put("members", org.json.JSONArray())) }
            }
            "select" -> {
                val identity = store.get(targetId) ?: error("设备不存在")
                require(identity.kind != "ssh" || servers.status(identity.id) == "connected") { "SSH 隧道已断开，请重新连接" }
                require(canOpenAnother(identity.id)) { "已保留 4 个工作台，请先关闭暂不用的设备页面" }
                connectionGeneration.incrementAndGet(); store.select(identity.id); pendingIdentity.set(null); devicesVisible = false
                val launched = JSONObject(openWorkbench()); require(launched.optBoolean("ok")) { launched.optString("error") }
                JSONObject().put("device", identity.publicJson())
            }
            "closeWorkbench" -> { activeRoutes.remove(targetId); context.forgetDevice(targetId); JSONObject().put("ok", true) }
            "rename" -> {
                val name = input.optString("name").trim(); require(name.isNotBlank() && name.length <= 128) { "设备名称须为 1–128 字" }
                if (targetId == "local") {
                    store.renameLocal(name)
                    JSONObject().put("device", localDevice())
                } else {
                    val identity = store.get(targetId) ?: error("设备不存在")
                    val renamed = identity.copy(alias = name); store.write(renamed, false)
                    JSONObject().put("device", renamed.publicJson())
                }
            }
            "remove" -> {
                if (store.selectedId() == targetId) showDevices()
                store.remove(targetId); routeCooldowns.remove(targetId); activeRoutes.remove(targetId); servers.remove(targetId); context.forgetDevice(targetId)
                context.getSharedPreferences("link_locations", Context.MODE_PRIVATE).edit().remove(targetId).apply()
                JSONObject().put("ok", true)
            }
            "pair" -> synchronized(pairs) {
                pairs.entries.removeIf { it.value.expiresAt <= System.currentTimeMillis() }
                val parsed = parsePairingLink(input.optString("uri"))
                val identity = Identity(parsed.url, parsed.pin, parsed.code, parsed.name, "",
                    id = stableId(parsed.url, parsed.pin, parsed.relayTarget), relayTarget = parsed.relayTarget)
                val existing = pairs.entries.firstOrNull { samePairing(it.value.identity, identity) }
                if (existing != null) return@synchronized pairingRequest(existing.key, existing.value)
                require(pairs.size < 16) { "待批准连接过多" }
                val pair = post(identity, "/link/api/pair", JSONObject().put("code", identity.code).put("name", store.localName())
                    .put("deviceType", "mobile").put("groupClientKey", groupClient.publicKey())
                    .put("groupId", store.group()?.optString("groupId")))
                val id = pair.getString("requestId")
                val pending = NativePair(identity, pair.getString("pollToken"), pair.optLong("expiresAt", System.currentTimeMillis() + 300000), pair.optBoolean("deviceGroup"))
                pairs[id] = pending
                pairingRequest(id, pending)
            }
            "pairStatus" -> {
                val id = input.optString("requestId"); val pair = pairs[id] ?: error("配对请求已过期")
                val result = post(pair.identity, "/link/api/pair/status", JSONObject().put("requestId", id).put("pollToken", pair.pollToken))
                if (result.optString("status") == "approved") {
                    val hostId = result.optString("hostId")
                    val pin = hostPin(hostId)
                    if (pin.isNotEmpty() && pair.identity.pin.isNotEmpty() && pin != pair.identity.pin) throw HostIdentityFailure()
                    if (pair.identity.relayTarget.isNotEmpty() && pair.identity.relayTarget != hostId) throw HostIdentityFailure()
                    if (pair.deviceGroup) {
                        require(hostId.isNotEmpty()) { "设备组邀请缺少主机身份" }
                        val directory = post(pair.identity, "/link/api/rpc", JSONObject()
                            .put("action", "deviceGroup").put("operation", "admitClient")
                            .put("groupId", store.group()?.optString("groupId"))
                            .put("proof", groupClient.invitationProof(hostId, result.getString("deviceId"))), result.getString("token"))
                        groupClient.verifyDirectory(directory)
                        directory.put("entry", JSONObject().put("hostId", hostId).put("url", pair.identity.url)
                            .put("pin", pair.identity.pin).put("relayTarget", pair.identity.relayTarget))
                        store.saveGroup(directory).forEach(context::forgetDevice)
                        val device = store.get(hostId) ?: error("已加入设备组，登记主机没有可用路线")
                        forgetPair(id, pair)
                        return JSONObject().put("status", "approved").put("device", device.publicJson()).put("direction", "group")
                    }
                    val previous = existingDevice(pair.identity)
                    val device = pair.identity.copy(name = result.optString("hostName").ifBlank { result.optString("name").ifBlank { pair.identity.name.ifBlank { "设备-" + pair.identity.id.take(5).uppercase() } } }, token = result.getString("token"), code = "", id = previous?.id ?: pair.identity.id, routes = trustedRoutes(result.optJSONArray("routes"), hostId), alias = previous?.alias.orEmpty(), hostId = hostId)
                    routeCooldowns.remove(device.id); activeRoutes.remove(device.id)
                    store.write(device, false); forgetPair(id, pair)
                    JSONObject().put("status", "approved").put("device", device.publicJson())
                } else { if (result.optString("status") in listOf("rejected", "expired")) forgetPair(id, pair); JSONObject().put("status", result.optString("status")) }
            }
            "sshProbe" -> servers.probe(input)
            "sshConnect" -> servers.connect(input)
            "job" -> servers.job(input.optString("jobId").ifBlank { input.optString("targetId") })
            "reconnect" -> {
                val identity = store.get(targetId) ?: error("设备不存在")
                require(identity.kind == "ssh") { "该设备不是 SSH 服务器" }
                servers.connect(input, identity)
            }
            "serverAction" -> servers.manage(input, store.get(targetId) ?: error("设备不存在"))
            "serverTerminal", "serverTerminalRead", "serverTerminalWrite", "serverTerminalResize", "serverTerminalClose" -> {
                val group = store.group() ?: error("设备组授权已失效")
                val assets = group.getJSONArray("assets")
                val asset = (0 until assets.length()).map { assets.getJSONObject(it) }
                    .firstOrNull { it.optString("id") == targetId && it.optBoolean("sharedTerminal") } ?: error("共享 SSH 资产不存在")
                val owner = store.get(asset.getString("ownerId")) ?: error("登记主机暂时没有可用路线")
                val payload = JSONObject().put("operation", "asset").put("command", input.getString("action")).put("assetId", targetId)
                if (input.has("operationId")) payload.put("id", input.get("operationId"))
                for (field in listOf("offset", "data", "cols", "rows")) if (input.has(field)) payload.put(field, input.get(field))
                groupRpc(owner, payload, group)
            }
            else -> error("不支持的设备操作")
        }
    }

    private fun localDevice() = JSONObject().put("id", "local").put("name", store.localName()).put("kind", "local").put("deviceType", "mobile").put("status", "online")
        .put("appVersion", BuildConfig.VERSION_NAME).put("appVersionCode", BuildConfig.VERSION_CODE)

    private fun samePairing(left: Identity, right: Identity) = left.hostKey == right.hostKey && left.code == right.code

    private fun pairingRequest(id: String, pair: NativePair) = JSONObject().put("requestId", id).put("expiresAt", pair.expiresAt)

    private fun forgetPair(id: String, pair: NativePair) {
        pairs.remove(id, pair)
        pendingIdentity.get()?.let { if (samePairing(it, pair.identity)) pendingIdentity.compareAndSet(it, null) }
    }

    private fun post(identity: Identity, path: String, body: JSONObject, token: String = "", client: OkHttpClient = clientFor(identity)): JSONObject {
        val request = Request.Builder().url(identity.url + path).post(body.toString().toRequestBody("application/json".toMediaType()))
        if (token.isNotEmpty()) request.header("Authorization", "Bearer $token")
        return client.newCall(request.build()).execute().use { response ->
            val value = JSONObject(response.body?.string() ?: "{}")
            if (!response.isSuccessful) throw RouteHttpFailure(response.code, value.optString("error", "连接失败（HTTP " + response.code + "）"))
            value
        }
    }

    @JavascriptInterface
    fun request(raw: String): String {
        val id = runCatching { JSONObject(raw).optString("id") }.getOrDefault("")
        executor.execute {
            val result = executeRequest(raw)
            context.runOnUiThread {
                val script = "window.__linkNativeResult && window.__linkNativeResult(${JSONObject.quote(id)},${JSONObject.quote(result)});"
                context.deliverResult(script)
            }
        }
        return ""
    }

    internal fun clientFor(identity: Identity): OkHttpClient = clients.getOrPut(identity.hostKey) {
            val uri = URI(identity.url)
            val builder = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
                .connectTimeout(12, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS)
            if (identity.relayTarget.isNotEmpty()) {
                builder.addInterceptor { chain ->
                    chain.proceed(chain.request().newBuilder().header("x-benchgo-relay-target", identity.relayTarget).build())
                }
            }
            if (identity.pin.isNotEmpty()) {
                // The QR pin is the trust anchor for local self-signed certificates.
                val trust = object : javax.net.ssl.X509TrustManager {
                    override fun getAcceptedIssuers() = emptyArray<java.security.cert.X509Certificate>()
                    override fun checkClientTrusted(chain: Array<java.security.cert.X509Certificate>, authType: String) { throw java.security.cert.CertificateException("Client certificates unsupported") }
                    override fun checkServerTrusted(chain: Array<java.security.cert.X509Certificate>, authType: String) {
                        val leaf = chain.firstOrNull() ?: throw java.security.cert.CertificateException("Empty certificate")
                        leaf.checkValidity()
                        val actual = MessageDigest.getInstance("SHA-256").digest(leaf.publicKey.encoded)
                        val expected = Base64.getDecoder().decode(identity.pin)
                        if (!MessageDigest.isEqual(actual, expected)) throw java.security.cert.CertificateException("主机公钥与配对身份不匹配")
                    }
                }
                val tls = javax.net.ssl.SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
                builder.sslSocketFactory(tls.socketFactory, trust)
                builder.hostnameVerifier { hostname, session ->
                    hostname.equals(uri.host, ignoreCase = true) && runCatching {
                        val leaf = session.peerCertificates.firstOrNull() as? java.security.cert.X509Certificate
                            ?: return@runCatching false
                        leaf.checkValidity()
                        MessageDigest.isEqual(
                            MessageDigest.getInstance("SHA-256").digest(leaf.publicKey.encoded),
                            Base64.getDecoder().decode(identity.pin)
                        )
                    }.getOrDefault(false)
                }
            }
            builder.build()
            }

    private fun executeRequest(raw: String): String {
        var requestId = ""
        var hostUrl = ""
        var pinned = false
        return try {
            val input = JSONObject(raw)
            val id = input.optString("id")
            requestId = id
            val identity = currentIdentity() ?: return response(id, 0, "未配对")
            hostUrl = identity.url
            pinned = identity.pin.isNotEmpty()
            val method = input.optString("method").uppercase()
            if (method != "GET" && method != "POST") return response(id, 0, "仅支持 GET/POST")
            val path = input.optString("path")
            if (!Regex("^/link/api/[A-Za-z0-9/_-]+$").matches(path)) return response(id, 0, "路径未授权")
            val uri = URI(identity.url + path)
            if (uri.scheme != "https" || uri.host.isNullOrBlank() || uri.userInfo != null) return response(id, 0, "仅支持 HTTPS 主机")
            val client = clientFor(identity)
            val requestBuilder = Request.Builder().url(uri.toURL()).header("Accept", "application/json")
            if (identity.token.isNotEmpty()) requestBuilder.header("Authorization", "Bearer ${identity.token}")
            val body = input.optJSONObject("body")?.toString()?.toRequestBody("application/json".toMediaType())
            if (method == "POST") requestBuilder.post(body ?: "{}".toRequestBody("application/json".toMediaType()))
            val headers = input.optJSONObject("headers")
            if (headers != null) headers.keys().forEach { key -> if (key.equals("content-type", true)) requestBuilder.header(key, headers.optString(key)) }
            client.newCall(requestBuilder.build()).execute().use { result ->
                response(id, result.code, result.body?.string() ?: "")
            }
        } catch (e: Exception) { response(requestId, 0, connectionFailureMessage(e, hostUrl, pinned)) }
    }

    private fun response(id: String, status: Int, body: String): String = JSONObject().apply {
        put("id", id); put("ok", status in 200..299); put("status", status)
        if (status == 0) put("error", body) else put("body", runCatching { org.json.JSONTokener(body).nextValue() }.getOrDefault(body))
    }.toString()
    private fun errorJson(message: String) = JSONObject().put("ok", false).put("status", 0).put("error", message).toString()
    fun close() {
        connectionGeneration.incrementAndGet()
        servers.close()
        appUpdates.close()
        executor.shutdownNow()
        routeScheduler.shutdownNow()
        clients.values.forEach { it.dispatcher.executorService.shutdownNow(); it.connectionPool.evictAll() }
        clients.clear()
    }
}

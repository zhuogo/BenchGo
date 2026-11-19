package cn.draftgo.benchgo.link

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.URI
import java.security.cert.CertificateException
import javax.net.ssl.SSLException

internal data class DeviceRoute(
    val url: String,
    val pin: String,
    val kind: String,
    val relayId: String = "",
    val priority: Int = 0,
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
    if (routes == null || routes.length() == 0) return listOf(DeviceRoute(identity.url, identity.pin, if (identity.pin.isEmpty()) "relay" else "direct"))
    val candidates = (0 until routes.length()).map { index ->
        val route = routes.getJSONObject(index)
        DeviceRoute(route.getString("url"), route.getString("pin"), route.getString("kind"), route.optString("relayId"), route.optInt("priority", index))
    }
    return orderDeviceRouteCandidates(candidates, identity.url)
}

internal fun orderDeviceRouteCandidates(candidates: List<DeviceRoute>, admittedUrl: String): List<DeviceRoute> =
    candidates.filterNot { it.kind == "direct" && it.url != admittedUrl && localRouteHost(it.url) }
        .distinctBy { Triple(it.kind, it.url, it.pin) }
        .sortedWith(compareBy<DeviceRoute> { if (it.kind == "direct") 0 else 1 }.thenBy { if (it.kind == "relay") it.priority else 0 })

internal fun <T> connectOnDeviceRoute(
    routes: List<DeviceRoute>,
    cooling: (DeviceRoute) -> Boolean,
    onFailure: (DeviceRoute) -> Unit,
    connect: (DeviceRoute) -> T,
): T {
    var lastFailure: IOException? = null
    var skippedCooling = false
    for (route in routes) {
        if (route.kind == "relay" && cooling(route)) {
            skippedCooling = true
            continue
        }
        try {
            return connect(route)
        } catch (error: IOException) {
            if (generateSequence<Throwable>(error) { it.cause }.take(12).any { it is SSLException || it is CertificateException } ||
                error is RouteHttpFailure && error.status !in 502..504) throw error
            lastFailure = error
            if (route.kind == "relay") onFailure(route)
        }
    }
    throw lastFailure ?: if (skippedCooling) RelayRoutesCooling() else IOException("无可用连接路由")
}

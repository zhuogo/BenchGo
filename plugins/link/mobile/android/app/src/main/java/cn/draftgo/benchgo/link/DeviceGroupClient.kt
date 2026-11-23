package cn.draftgo.benchgo.link

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.util.Base64

internal class DeviceGroupClient {
    private val alias = "benchgo-link-group-client"
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    @Synchronized
    fun publicKey(): String {
        if (!keyStore.containsAlias(alias)) {
            KeyPairGenerator.getInstance("RSA", "AndroidKeyStore").apply {
                initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                    .setKeySize(2048)
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
                    .build())
            }.generateKeyPair()
        }
        return Base64.getEncoder().encodeToString(keyStore.getCertificate(alias).publicKey.encoded)
    }

    fun invitationProof(hostId: String, invitationId: String): String =
        sign(claim("benchgo-group-client-v1", hostId, invitationId))

    fun token(directory: JSONObject, hostId: String, sync: Boolean = false): String {
        val self = directory.getJSONObject("self")
        val payload = claim("benchgo-group-auth-v1", directory.getString("groupId"), self.getString("id"), hostId,
            System.currentTimeMillis() + 90_000, sync, self.opt("generation"))
        return "group." + Base64.getUrlEncoder().withoutPadding().encodeToString(payload) + "." + sign(payload)
    }

    fun verifyDirectory(directory: JSONObject) {
        val key = Base64.getDecoder().decode(publicKey())
        val expected = "sha256:" + Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(key))
        require(directory.getJSONObject("self").getString("id") == expected) { "设备组成员身份不一致" }
    }

    private fun claim(vararg fields: Any?): ByteArray =
        JSONArray(fields.toList()).toString().replace("\\/", "/").toByteArray(Charsets.UTF_8)

    @Synchronized
    private fun sign(payload: ByteArray): String {
        val key = keyStore.getKey(alias, null) as? PrivateKey ?: error("设备组密钥不可用")
        return Base64.getEncoder().encodeToString(Signature.getInstance("SHA256withRSA").run {
            initSign(key)
            update(payload)
            sign()
        })
    }
}

internal fun groupHosts(directory: JSONObject): List<Identity> {
    val rows = directory.getJSONArray("members")
    val fallback = directory.optJSONObject("entry")
    return (0 until rows.length()).mapNotNull { index ->
        val member = rows.getJSONObject(index)
        if (member.optString("deviceType") == "mobile") return@mapNotNull null
        val id = member.getString("id")
        val routes = trustedRoutes(member.optJSONArray("routes"), id) ?: JSONArray()
        val joined = fallback?.takeIf { it.optString("hostId") == id }
        val first = routes.optJSONObject(0)
        val url = joined?.getString("url") ?: member.optString("publicUrl").ifBlank { first?.getString("url").orEmpty() }
        if (url.isEmpty()) return@mapNotNull null
        Identity.parse(JSONObject().put("id", id).put("name", member.getString("name"))
            .put("url", url).put("pin", joined?.optString("pin") ?: first?.takeIf { it.optString("url") == url }?.optString("pin").orEmpty())
            .put("relayTarget", joined?.optString("relayTarget") ?: first?.takeIf { it.optString("url") == url }?.optString("relayTarget").orEmpty())
            .put("hostId", id).put("routes", routes).put("groupId", directory.getString("groupId")))
    }
}

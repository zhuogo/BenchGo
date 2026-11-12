package cn.draftgo.benchgo.link

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.bouncycastle.crypto.util.SubjectPublicKeyInfoFactory
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64

class AppUpdatesTest {
    @Test fun missingSignatureRemainsAnErrorInsteadOfAnUnpublishedChannel() {
        val manifest = APP_UPDATE_REPOSITORY + "download/plugin-updates/benchgo-update.json"
        assertTrue(appUpdateChannelUnpublished(manifest, 404))
        assertFalse(appUpdateChannelUnpublished(manifest + ".sig", 404))
        assertFalse(appUpdateChannelUnpublished(manifest, 403))
        assertFalse(appUpdateChannelUnpublished(manifest, 200))
    }

    @Test fun apkTargetsAreBoundToTheExactSignedRepositoryVersion() {
        val url = APP_UPDATE_REPOSITORY + "download/v0.1.1/benchgo-0.1.1-android.apk"
        assertTrue(trustedAppUpdateUrl("0.1.1", url))
        assertTrue(trustedAppUpdateUrl("0.1.1", url.replace("download/v0.1.1/", "download/v0.2.0/")))
        for (bad in listOf(url.replace("github.com", "evil.example"), url + "?redirect=elsewhere", url.replace("v0.1.1", "latest"), url.replace("android.apk", "android-debug.apk"), url.replace("https:", "http:"))) {
            assertFalse(bad, trustedAppUpdateUrl("0.1.1", bad))
        }
        assertFalse(trustedAppUpdateUrl("0.1.2", url))
    }

    @Test fun versionsAndMirrorSettingsKeepHostValidationBoundaries() {
        for (version in listOf("0.1.0", "1.2.3-rc.1", "1.0.0+build.17")) assertTrue(version, validAppUpdateVersion(version))
        for (version in listOf("v0.1.0", "01.1.0", "1.2", "1.0.0-01", "../../evil", "")) assertFalse(version, validAppUpdateVersion(version))
        assertEquals("https://mirror.example/base/", normalizeAppUpdateMirror("https://mirror.example/base///"))
        for (value in listOf("http://mirror.example", "https://user:secret@mirror.example", "https://mirror.example/?q=1", "https://mirror.example/#fragment", "https://")) {
            assertThrows(IllegalArgumentException::class.java) { normalizeAppUpdateMirror(value) }
        }
    }

    @Test fun ed25519VerificationRejectsTamperedMetadataAndOtherKeys() {
        val privateKey = Ed25519PrivateKeyParameters(ByteArray(32) { it.toByte() }, 0)
        val payload = "{\"schemaVersion\":1,\"releaseVersion\":\"0.1.1\"}".toByteArray()
        val signer = Ed25519Signer().apply { init(true, privateKey); update(payload, 0, payload.size) }
        val signature = Base64.getEncoder().encodeToString(signer.generateSignature())
        val pem = "-----BEGIN PUBLIC KEY-----\n" + Base64.getEncoder().encodeToString(SubjectPublicKeyInfoFactory.createSubjectPublicKeyInfo(privateKey.generatePublicKey()).encoded) + "\n-----END PUBLIC KEY-----"
        verifyAppUpdateSignature(payload, signature, pem)
        assertThrows(IllegalArgumentException::class.java) { verifyAppUpdateSignature(payload + byteArrayOf(32), signature, pem) }
        assertThrows(IllegalArgumentException::class.java) { verifyAppUpdateSignature(payload, "invalid-signature", pem) }
        val other = Ed25519PrivateKeyParameters(ByteArray(32) { (it + 1).toByte() }, 0)
        val otherPem = "-----BEGIN PUBLIC KEY-----\n" + Base64.getEncoder().encodeToString(SubjectPublicKeyInfoFactory.createSubjectPublicKeyInfo(other.generatePublicKey()).encoded) + "\n-----END PUBLIC KEY-----"
        assertThrows(IllegalArgumentException::class.java) { verifyAppUpdateSignature(payload, signature, otherPem) }
    }
}

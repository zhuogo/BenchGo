package cn.draftgo.benchgo.link

import java.io.IOException
import java.net.SocketTimeoutException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLHandshakeException
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceRoutesTest {
    private val direct = DeviceRoute("https://192.168.1.5", "pin", "direct")
    private val primary = DeviceRoute("https://primary.example.com", "", "relay", "primary", 10)
    private val spare = DeviceRoute("https://spare.example.com", "", "relay", "spare", 30)

    @Test fun ordersDirectBeforePreferredRelayAndSkipsUnrelatedLoopback() {
        val loopback = DeviceRoute("https://127.0.0.1", "pin", "direct")
        val candidates = listOf(spare, loopback, primary, direct, primary)
        assertEquals(listOf(direct, primary, spare), orderDeviceRouteCandidates(candidates, direct.url))
        assertEquals(listOf(loopback, direct, primary, spare), orderDeviceRouteCandidates(candidates, loopback.url))
    }

    @Test fun fallsBackForUnavailableWorkspaceAndCoolsOnlyFailedRelay() {
        val tried = mutableListOf<DeviceRoute>()
        val failures = mutableListOf<DeviceRoute>()
        val chosen = connectOnDeviceRoute(listOf(direct, primary, spare), { false }, { failures.add(it) }) { route ->
            tried.add(route)
            when (route) {
                direct -> throw SocketTimeoutException("direct timeout")
                primary -> throw RouteHttpFailure(503, "relay unavailable")
                else -> route
            }
        }
        assertSame(spare, chosen)
        assertEquals(listOf(direct, primary, spare), tried)
        assertEquals(listOf(primary), failures)
        assertSame(spare, connectOnDeviceRoute(listOf(primary, spare), { it == primary }, { error("unexpected failure") }) { it })
        assertThrows(RelayRoutesCooling::class.java) { connectOnDeviceRoute(listOf(primary), { true }, {}) { it } }
    }

    @Test fun refusesFallbackForIdentityTlsOrAuthorizationFailure() {
        val failures = listOf(RouteHttpFailure(401, "unauthorized"), RouteHttpFailure(403, "forbidden"),
            SSLHandshakeException("invalid certificate"), IOException("wrapped TLS", SSLHandshakeException("invalid certificate")),
            HostIdentityFailure())
        for (failure in failures) {
            val result = assertThrows(failure.javaClass) {
                connectOnDeviceRoute(listOf(primary, spare), { false }, { error("must not cool") }) { route ->
                    assertSame(primary, route)
                    throw failure
                }
            }
            assertSame(failure, result)
        }
    }

    @Test fun startsBackupProbesBeforeThePreferredRouteFinishes() {
        val started = CountDownLatch(2)
        val scheduler = Executors.newSingleThreadScheduledExecutor()
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            assertNull(chain.request().header("Authorization"))
            started.countDown()
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                .code(200).message("OK").body("{}".toResponseBody()).build()
        }.build()
        try {
            val chosen = connectOnDeviceRoute(listOf(direct, primary, spare), { false }, {}, scheduler,
                { client.newCall(Request.Builder().url(it.url + "/link/api/info").build()) }) { route ->
                assertSame(direct, route)
                assertTrue(started.await(3, TimeUnit.SECONDS))
                route
            }
            assertSame(direct, chosen)
        } finally {
            scheduler.shutdownNow()
            client.dispatcher.executorService.shutdownNow()
        }
    }
}

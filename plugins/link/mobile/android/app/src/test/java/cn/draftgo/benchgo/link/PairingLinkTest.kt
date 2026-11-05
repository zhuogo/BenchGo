package cn.draftgo.benchgo.link

import org.junit.Assert.*
import org.junit.Test

class PairingLinkTest {
    @Test fun brandedAndLegacySchemesResolveTheSamePairingInformation() {
        val pin = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
        val parameters = "url=https%3A%2F%2Fdesk.example%3A48721&pin=$pin&code=one-time-code&name=BenchGo"
        val expected = PairingLink("https://desk.example:48721", pin, "one-time-code", "BenchGo")
        for (scheme in listOf("benchgo", "dshlink")) {
            assertEquals(expected, parsePairingLink("$scheme://pair?$parameters"))
            assertEquals(expected, parsePairingLink("$scheme://pair/?$parameters"))
        }
    }

    @Test fun httpsQrCodesRemainSupported() {
        for (path in listOf("/link", "/link/", "/link/index.html")) {
            val expected = PairingLink("https://relay.example", "", "one-time-code", "BenchGo")
            assertEquals(expected, parsePairingLink("https://relay.example$path#code=one-time-code&name=BenchGo"))
            assertEquals(expected, parsePairingLink("https://relay.example$path?code=one-time-code&name=BenchGo"))
        }
    }

    @Test fun customSchemesStillRequireThePairHostAndValidParameters() {
        for (scheme in listOf("benchgo", "dshlink")) {
            for (address in listOf(
                "$scheme://other?url=https%3A%2F%2Fdesk.example&pin=&code=valid",
                "$scheme://pair/other?url=https%3A%2F%2Fdesk.example&pin=&code=valid",
                "$scheme://pair?url=https%3A%2F%2Fdesk.example&pin=&code=",
                "$scheme://pair?url=http%3A%2F%2Fdesk.example&pin=&code=valid"
            )) {
                assertTrue(address, runCatching { parsePairingLink(address) }.isFailure)
            }
        }
    }
}

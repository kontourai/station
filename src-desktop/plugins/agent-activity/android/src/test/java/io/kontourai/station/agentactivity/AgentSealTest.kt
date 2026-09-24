package io.kontourai.station.agentactivity

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The vector was produced by Node's crypto (AES-256-GCM, 12-byte nonce, AAD
 * "station-agent-activity:v1:<registrationId>"), independently of this code,
 * following the Station contract in docs/design/notification-delivery.md.
 */
class AgentSealTest {
  private val payloadKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
  private val registrationId = "reg_0123456789abcdef"
  private val sealed =
    "AAECAwQFBgcICQoLPCCjaKCXnXLpY62pwp0ZGeq56RnBWXNeTReB5GkMZO1gZIzGjfAqqESUT924txgI3mlCoXi3wK5W4U87" +
      "IsGBnIVZ5FbxsEUVdSLDGpbQfoBZ-axATEEhHZOT96If0pWvqpstj9IovGPBcFfcLSoRXYBFNcSRrkz0KqMjnuqPHi7SJlyyx6O" +
      "qJ2GOJoNAH2V9xSFXopWU1dmAy7jvoQ"
  private val registration = Registration(registrationId, "station-1", "K".repeat(43), payloadKey)

  @Test
  fun opensTheReferenceVector() {
    assertEquals(
      mapOf(
        "user_id" to "station-1",
        "updated_at" to "1800000000000",
        "active" to "true",
        "activity_phase" to "running",
        "activity_line_0" to "Working\tShip it\tstation",
      ),
      unseal(payloadKey, registrationId, sealed)
    )
  }

  @Test
  fun refusesAnythingThatDoesNotAuthenticate() {
    val flipped = sealed.substring(0, 20) + (if (sealed[20] == 'A') 'B' else 'A') + sealed.substring(21)
    assertNull("tampered ciphertext", unseal(payloadKey, registrationId, flipped))
    assertNull("sealed for another registration", unseal(payloadKey, "reg_ffffffffffffffff", sealed))
    assertNull("another key", unseal("B" + payloadKey.substring(1), registrationId, sealed))
    assertNull("too short", unseal(payloadKey, registrationId, "AAECAwQFBgcICQoL"))
    assertNull("not base64url", unseal(payloadKey, registrationId, "not base64!"))
  }

  @Test
  fun routingFieldsComeFromOutsideTheSeal() {
    val push = mapOf(
      "station_kind" to "agent_activity",
      "device_id" to registrationId,
      "station_key" to "K".repeat(43),
      "sealed" to sealed,
    )
    val card = openPush(registration, push)
    assertEquals(registrationId, card?.get("device_id"))
    assertEquals("K".repeat(43), card?.get("station_key"))
    assertEquals("station-1", card?.get("user_id"))
    assertNull("an unsealed push is refused", openPush(registration, push - "sealed"))
  }

  @Test
  fun decodesUnpaddedBase64Url() {
    assertArrayEquals(ByteArray(32) { it.toByte() }, decodeBase64Url(payloadKey))
    assertArrayEquals(byteArrayOf(-5, -1), decodeBase64Url("-_8"))
    assertNull(decodeBase64Url("A"))
    assertNull(decodeBase64Url("A+/="))
  }
}

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

  /**
   * NATIVE_PUSH_SEALED_TEST_VECTOR from @kontourai/station-contracts/native-push: the Station's own sealer output.
   * A copy, pinned to the contract by agent-activity-seal.test.ts on the server side: update both together.
   */
  @Test
  fun opensTheStationsKnownAnswerVector() {
    val stationSealed =
      "AAECAwQFBgcICQoLPCCjaKCXnXLpY62pgNhJXLLntgXdSm5NCUrRtCxYLYowIZ_RnvAjqUWVTty5thkJzHVC-Cqywq" +
      "5a83V4bMHPzMEE9krj4RZRLGSaXt-tIspZ6b0LAAZxUt-J7Lkd0pWvqpstj9IovGPBbFbTOxADRZgQA8KXrEv9Epk4" +
      "v92HHn7JPXan2PXncWmCPMhLszi7aZiKW1BOo2i2fakHiqCGmPL7wmGvlrRe0wu42rns59Dk7qZN7MIdnBG6s7Mtsf" +
      "ucdCXk2kytpusbdLKFziiv7ZUHpxdedNOHFM75qDQm-9h5AeWNygJiRiYuzmHBaCMw3OfcG-lZ5stICAgG5ehguzbg" +
      "0Ly_uytKHqkbc85yX3Kq3bio89Tg21MVT2AyxIp7MTTseIr1_iewEBg7ZvDSp8ejP3xztv8nqAEtJqcNddn5pU8au1" +
      "BI2ZPQSxBt4y1SoyrntKwktTh5k0hWvYF4z2kfyem1ZEL7EJ-UE6eFUhi0zS9J3sEi7b2EWLmuIwZGzPesvKU98Z3R" +
      "AIwQSCF-p4xuCd_6RHD4H3GyIz-S5DR2Hi5J-fMXG9iYqDqa2NbJPAA9MnDsR4yJmZeI9d8_us1a4rLJPtFdqmqQdY" +
      "yGxMFWrOh4YsInKEEUM74P"
    val card = unseal(payloadKey, "AAECAwQFBgcICQoLDA0ODw", stationSealed)
    assertEquals("waiting_for_approval", card?.get("activity_phase"))
    assertEquals("Approval\tFix the flaky login test\tLogin App", card?.get("activity_line_0"))
    assertEquals("Approval needed", card?.get("alert_title"))
    assertEquals("11111111-1111-4111-8111-111111111111", card?.get("user_id"))
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
  fun aSealedCardCannotOverrideRoutingFields() {
    // Same key and registration, but the sealed card itself claims another
    // registration, another Station key and another kind (also from Node).
    val hostile = "Dw4NDAsKCQgHBgUE3xLELz6l8MeP_Yt9S-7odQAJcU3-e91GIznKnkZv1HVl_uF6CXhDvhCFHN2jPBg1JzDXfUrZO52dPyOpGhNnsJBFIm4-P8zRM31e0zZOEte1VCvi83Br2z_pfPVgIecRfd6joYExxMuIiOG6fMHyji9AqH9CMjur3VMvkqiM0aLb78pHYIjKK6O6ldFWCf29d0FlDe0OGPloXq5Cy8dJbKd5A0cNRsQUR3uq5Jiy6FHMfoZyPP0lHlIK"
    val card = openPush(
      registration,
      mapOf(
        "station_kind" to "agent_activity",
        "device_id" to registrationId,
        "station_key" to "K".repeat(43),
        "sealed" to hostile,
      )
    )
    assertEquals(registrationId, card?.get("device_id"))
    assertEquals("K".repeat(43), card?.get("station_key"))
    assertEquals("agent_activity", card?.get("station_kind"))
  }

  @Test
  fun decodesUnpaddedBase64Url() {
    assertArrayEquals(ByteArray(32) { it.toByte() }, decodeBase64Url(payloadKey))
    assertArrayEquals(byteArrayOf(-5, -1), decodeBase64Url("-_8"))
    assertNull(decodeBase64Url("A"))
    assertNull(decodeBase64Url("A+/="))
  }
}

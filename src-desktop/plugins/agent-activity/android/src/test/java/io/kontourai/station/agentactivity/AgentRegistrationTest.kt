package io.kontourai.station.agentactivity

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentRegistrationTest {
  private val key = "A".repeat(43)
  private val registration = Registration("reg_0123456789abcdef", "station-1", key, key)
  private val push = mapOf(
    "device_id" to "reg_0123456789abcdef",
    "user_id" to "station-1",
    "station_key" to key,
  )

  @Test
  fun acceptsOnlyAPushSpeakingForItsOwnRegistrationAndStationKey() {
    assertTrue(acceptsPush(registration, push))
    assertFalse("no registration", acceptsPush(null, push))
    assertFalse("other registration", acceptsPush(registration, push + ("device_id" to "reg_ffffffffffffffff")))
    assertFalse("other Station", acceptsPush(registration, push + ("user_id" to "station-2")))
    assertFalse("another Station's key", acceptsPush(registration, push + ("station_key" to "B".repeat(43))))
    assertFalse("no key stamped", acceptsPush(registration, push - "station_key"))
  }

  @Test
  fun freshnessWindowIsTenMinutesEitherSide() {
    val now = 1_800_000_000_000L
    assertTrue(isFresh(now - MAX_MESSAGE_AGE_MS, now))
    assertTrue(isFresh(now + MAX_MESSAGE_AGE_MS, now))
    assertFalse(isFresh(now - MAX_MESSAGE_AGE_MS - 1, now))
    assertFalse(isFresh(now + MAX_MESSAGE_AGE_MS + 1, now))
  }

  @Test
  fun registrationRequiresWhatTheStationReturned() {
    assertNotNull(Registration.validOrNull("reg_0123456789abcdef", "station-1", key, key))
    assertNull("short id", Registration.validOrNull("short", "station-1", key, key))
    assertNull("path characters in id", Registration.validOrNull("../../0123456789abc", "station-1", key, key))
    assertNull("blank station", Registration.validOrNull("reg_0123456789abcdef", " ", key, key))
    assertNull("not a thumbprint", Registration.validOrNull("reg_0123456789abcdef", "station-1", "abc", key))
    assertNull("not a payload key", Registration.validOrNull("reg_0123456789abcdef", "station-1", key, "short"))
    assertEquals("station-1", Registration.validOrNull("reg_0123456789abcdef", "station-1", key, key)?.stationId)
  }
}

package io.kontourai.station.agentactivity

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** #2515: the session a card or alert tap opens, validated before it is recorded against a tap nonce. */
class SessionRouteTest {
  private val registration = Registration(
    id = "AAECAwQFBgcICQoLDA0ODw",
    stationId = "11111111-1111-4111-8111-111111111111",
    stationKey = "k".repeat(43),
    payloadKey = "p".repeat(43)
  )

  @Test
  fun cardAndAlertRoutesCarryTheRegistrationsStationNotTheCards() {
    val card = mapOf(
      "user_id" to "some-other-station",
      "activity_session_id" to "thread-1",
      "activity_project_slug" to "login-app",
      "alert_session_id" to "0b0e7c2e-5d1f-4c55-9b0a-2f1f5b0c9d10",
    )
    assertEquals(
      SessionRoute(registration.stationId, "thread-1", "login-app"),
      sessionRoute(registration, card, RouteSource.ACTIVITY)
    )
    assertEquals(
      SessionRoute(registration.stationId, "0b0e7c2e-5d1f-4c55-9b0a-2f1f5b0c9d10", null),
      sessionRoute(registration, card, RouteSource.ALERT)
    )
  }

  @Test
  fun aCardWithoutAReferenceOpensTheAppWhereItWas() {
    assertNull(sessionRoute(registration, mapOf("activity_project_slug" to "login-app"), RouteSource.ACTIVITY))
    assertNull(sessionRoute(registration, emptyMap(), RouteSource.ALERT))
  }

  @Test
  fun acceptsTheWholeContractGrammar() {
    val longest = "a" + "Z9._:-".repeat(21) + "b"
    assertEquals(128, longest.length)
    for (id in listOf("a", "0", "review-1", "station-smoke-claude-1", "ns:thread.1_2", longest)) {
      assertEquals(id, SessionRoute.validOrNull("station", id, id)?.sessionId)
    }
  }

  @Test
  fun refusesAnythingOutsideTheGrammarWhole() {
    val bad = listOf(
      "",
      "a".repeat(129),
      "-leading",
      ".leading",
      "../etc",
      "a/b",
      "a?b",
      "a#b",
      "a b",
      "a%2Fb",
      "a\nb",
      "tail\n",
      "https://evil.example",
      "é",
      "١٢٣", // Arabic-Indic digits: not ASCII
    )
    for (value in bad) {
      assertNull("session $value", SessionRoute.validOrNull("station", value, null))
      // A malformed slug drops the whole route, not just the slug.
      assertNull("slug $value", SessionRoute.validOrNull("station", "thread-1", value))
    }
    val card = mapOf("alert_session_id" to "thread-1", "alert_project_slug" to "a/b")
    assertNull(sessionRoute(registration, card, RouteSource.ALERT))
  }

  @Test
  fun refusesAMissingOrOversizedStation() {
    assertNull(SessionRoute.validOrNull(null, "thread-1", null))
    assertNull(SessionRoute.validOrNull(" ", "thread-1", null))
    assertNull(SessionRoute.validOrNull("s".repeat(129), "thread-1", null))
    assertNull(SessionRoute.validOrNull("station", null, null))
  }
}

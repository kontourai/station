package io.kontourai.station.agentactivity

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentCardPlanTest {
  private fun line(status: String, title: String, project: String) = "$status\t$title\t$project"

  private val now = 1_800_000_000_000L
  private val live = CardMemory(lastUpdate = 0, lastActive = true, dismissed = false, ongoingEnabled = true)

  @Test
  fun aSingleThreadCardIsTitledByTheThreadAndItsLineCarriesTheProject() {
    val text = ActivityModel(mapOf("activity_line_0" to line("Working", "Fix login", "station")), active = true).cardText()
    assertEquals("Fix login", text.title)
    assertNull(text.subText)
    assertFalse(text.accentTitle)
    assertEquals(listOf(CardLine("Working", "station", "")), text.lines)
  }

  @Test
  fun aOneProjectCardNamesTheProjectOnceInTheSubText() {
    val data = mapOf(
      "activity_phase" to "waiting_for_approval",
      "activity_line_0" to line("Approval", "Deploy", "station"),
      "activity_line_1" to line("Working", "Refactor", "station"),
    )
    val text = ActivityModel(data, active = true).cardText()
    assertEquals("station · 2 active", text.subText)
    assertTrue("an approval is an outcome worth the accent", text.accentTitle)
    assertEquals(
      listOf(CardLine("Approval", "Deploy", ""), CardLine("Working", "Refactor", "")),
      text.lines
    )
  }

  @Test
  fun aMixedProjectCardSuffixesEachLineWithItsProject() {
    val data = mapOf(
      "activity_phase" to "running",
      "activity_line_0" to line("Done", "Deploy", "station"),
      "activity_line_1" to line("Done", "Refactor", "flow"),
      "activity_active_count" to "0",
    )
    val text = ActivityModel(data, active = true).cardText()
    assertEquals("2 threads", text.subText)
    assertFalse("a plain running card stays neutral", text.accentTitle)
    assertEquals(listOf("station", "flow"), text.lines.map { it.suffix })
  }

  @Test
  fun anEmptyCardHasNoLines() {
    val text = ActivityModel(emptyMap(), active = true).cardText()
    assertEquals("Agent activity", text.title)
    assertEquals(emptyList<CardLine>(), text.lines)
  }

  @Test
  fun alertHistoryRecognisesARetryAndKeepsOnlyTheMostRecentIds() {
    assertEquals("a", rememberAlert(null, "a"))
    assertEquals("a\nb", rememberAlert("a", "b"))
    assertNull("a retry of an older alert is still recognised", rememberAlert("a\nb", "a"))
    val full = (1..SEEN_ALERT_HISTORY).joinToString("\n") { "id$it" }
    val next = rememberAlert(full, "new")!!.split('\n')
    assertEquals(SEEN_ALERT_HISTORY, next.size)
    assertEquals("id2", next.first())
    assertEquals("new", next.last())
  }

  @Test
  fun anOlderUpdateThanTheLastAppliedIsStale() {
    assertEquals(CardStep.Stale, planCard(live.copy(lastUpdate = now), now - 1, active = true, expiresAtField = null, now = now))
  }

  @Test
  fun anActiveCardWithoutExpiryLivesTwoHoursFromItsUpdate() {
    assertEquals(
      CardStep.Post(RUNNING_LIFETIME_MS - 1000),
      planCard(live, now - 1000, active = true, expiresAtField = null, now = now)
    )
  }

  @Test
  fun expiryIsCappedAtADayAndAPastExpiryRemovesTheCard() {
    val farFuture = (now + 10 * MAX_LIFETIME_MS).toString()
    assertEquals(CardStep.Post(MAX_LIFETIME_MS), planCard(live, now, active = true, expiresAtField = farFuture, now = now))
    assertEquals(CardStep.Remove, planCard(live, now, active = true, expiresAtField = now.toString(), now = now))
    assertEquals("a finished card with no expiry is removed", CardStep.Remove, planCard(live, now, active = false, expiresAtField = null, now = now))
  }

  @Test
  fun ongoingCardsTurnedOffRemoveTheCard() {
    assertEquals(CardStep.Remove, planCard(live.copy(ongoingEnabled = false), now, active = true, expiresAtField = null, now = now))
  }

  @Test
  fun aDismissedRunStaysDownUntilANewRunStarts() {
    val dismissed = live.copy(dismissed = true)
    assertEquals(CardStep.KeepDismissed, planCard(dismissed, now, active = true, expiresAtField = null, now = now))
    val finishedExpiry = (now + 60_000).toString()
    assertEquals(CardStep.KeepDismissed, planCard(dismissed, now, active = false, expiresAtField = finishedExpiry, now = now))
    assertEquals(
      "inactive to active is a new run",
      CardStep.Post(RUNNING_LIFETIME_MS),
      planCard(dismissed.copy(lastActive = false), now, active = true, expiresAtField = null, now = now)
    )
  }
}

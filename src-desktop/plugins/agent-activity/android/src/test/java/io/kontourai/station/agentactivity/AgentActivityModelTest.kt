package io.kontourai.station.agentactivity

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AgentActivityModelTest {
  private fun line(status: String, title: String, project: String) = "$status\t$title\t$project"

  @Test
  fun rowsKeepSenderOrderAndDropMalformedLines() {
    val rows = activityRows(
      mapOf(
        "activity_line_0" to line("Approval", "Deploy", "station"),
        "activity_line_1" to "no tabs here",
        "activity_line_2" to line("Working", " ", "station"),
        "activity_line_3" to line("Working", "Refactor", "flow"),
        "activity_line_5" to line("Working", "Beyond the row limit", "flow"),
      )
    )
    assertEquals(listOf("Deploy", "Refactor"), rows.map { it.title })
  }

  @Test
  fun explicitPhaseWinsOverTheHeroRowStatus() {
    val data = mapOf(
      "activity_phase" to "waiting_for_input",
      "activity_line_0" to line("Working", "Refactor", "station"),
    )
    assertEquals(ActivityPhase.INPUT, activityPhase(data, activityRows(data)))
  }

  @Test
  fun unknownPhaseFallsBackToTheHeroRowStatus() {
    val data = mapOf(
      "activity_phase" to "not-a-phase",
      "activity_line_0" to line("Approval", "Deploy", "station"),
    )
    assertEquals(ActivityPhase.APPROVAL, activityPhase(data, activityRows(data)))
  }

  @Test
  fun chipCountsLiveAgentsAndCapsAtNinePlus() {
    val many = mapOf("activity_phase" to "running", "activity_active_count" to "12")
    assertEquals("9+ live", ActivityModel(many, active = true).chip)
    val three = mapOf("activity_phase" to "running", "activity_active_count" to "3")
    assertEquals("3 live", ActivityModel(three, active = true).chip)
    val one = mapOf("activity_phase" to "running", "activity_active_count" to "1")
    assertEquals("Working", ActivityModel(one, active = true).chip)
  }

  @Test
  fun attentionPhaseChipAsksForTheUser() {
    val data = mapOf("activity_phase" to "waiting_for_approval")
    assertEquals("Approve", ActivityModel(data, active = true).chip)
    assertEquals("Approve", ActivityModel(data, active = true).action)
  }

  @Test
  fun finishedCardHasNoChipAndNoAction() {
    val data = mapOf("activity_phase" to "completed", "activity_line_0" to line("Done", "Deploy", "station"))
    val model = ActivityModel(data, active = false)
    assertNull(model.chip)
    assertNull(model.action)
  }

  @Test
  fun summaryNamesTheSingleThreadOrCountsWhatNeedsTheUser() {
    val single = mapOf("activity_line_0" to line("Working", "Fix login", "station"))
    assertEquals("Fix login", ActivityModel(single, active = true).summary)

    val mixed = mapOf(
      "activity_line_0" to line("Approval", "Deploy", "station"),
      "activity_line_1" to line("Input", "Rename", "station"),
      "activity_line_2" to line("Working", "Refactor", "station"),
    )
    assertEquals("2 need you", ActivityModel(mixed, active = true).summary)

    val finished = mapOf(
      "activity_line_0" to line("Done", "Deploy", "station"),
      "activity_line_1" to line("Failed", "Rename", "station"),
    )
    assertEquals("Finished, 1 failed", ActivityModel(finished, active = false).summary)
  }

  @Test
  fun explicitCountsOverrideRowDerivedCounts() {
    // Only five rows travel, so the sender's totals are the truth for more.
    val data = mapOf(
      "activity_line_0" to line("Working", "A", "station"),
      "activity_line_1" to line("Working", "B", "station"),
      "activity_active_count" to "7",
    )
    assertEquals("7 working", ActivityModel(data, active = true).summary)
  }
}

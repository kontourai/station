// Adapted from T3 Code (https://github.com/pingdotgg/t3code,
// apps/mobile/modules/t3-agent-notifications), MIT License,
// Copyright (c) 2026 T3 Tools Inc.

package io.kontourai.station.agentactivity

/**
 * The Android-free half of an agent-activity card: what the payload says and
 * what the card should read. Kept free of android.* so it runs in plain JVM
 * unit tests; AgentActivityPresentation turns it into a notification.
 *
 * Payload wire format (FCM data message, all values strings):
 * - `station_kind` = `agent_activity`
 * - `device_id`, `user_id`: the registration id and Station id from `configure`
 * - `station_key`: stamped by the push gateway; must equal the Station key
 *   thumbprint from `configure` (see [acceptsPush])
 * - `updated_at`: epoch millis; stale or reordered messages are dropped
 * - `active`: `true` while any agent is working or waiting on the user
 * - `activity_phase`: one of [ActivityPhase.wire]
 * - `activity_line_0`..`activity_line_4`: `status\ttitle\tproject`, ordered by the sender.
 *   Required: unlike T3's format there is no title/body fallback, so a payload
 *   without a valid row renders as a bare "Agent activity" card.
 * - `activity_active_count`, `activity_attention_count`: optional totals
 * - `activity_expires_at`: optional absolute expiry, epoch millis
 * - `alert_id`, `alert_title`, `alert_body`: optional one-shot attention alert.
 *   While the app is in the foreground the alert is recorded as seen and not
 *   posted, on the premise that the web layer shows its own notice. The
 *   sender cannot know the app is in the foreground, so the web layer must
 *   surface the same attention events from its own server stream.
 */
internal data class ActivityRow(val status: String, val title: String, val project: String)

/**
 * What a Station returned when this phone registered: `id` is the random
 * per-registration value carried as `device_id`, `stationId` travels as
 * `user_id`, and `stationKey` is the thumbprint of the Station's push key,
 * which the gateway stamps as `station_key` after verifying the signature.
 */
data class Registration(val id: String, val stationId: String, val stationKey: String) {
  companion object {
    private val ID = Regex("^[A-Za-z0-9_-]{16,128}$")
    private val THUMBPRINT = Regex("^[A-Za-z0-9_-]{43}$")

    fun validOrNull(id: String, stationId: String, stationKey: String): Registration? =
      if (ID.matches(id) && stationId.isNotBlank() && stationId.length <= 128 && THUMBPRINT.matches(stationKey)) {
        Registration(id, stationId, stationKey)
      } else {
        null
      }
  }
}

internal const val MAX_MESSAGE_AGE_MS = 10 * 60 * 1000L

/**
 * Whether a push speaks for the Station this phone registered with. The key
 * pin is what stops someone else's Station, which can also get a signature
 * past the gateway, from writing on this phone's cards.
 */
internal fun acceptsPush(registration: Registration?, data: Map<String, String>): Boolean =
  registration != null &&
    data["device_id"] == registration.id &&
    data["user_id"] == registration.stationId &&
    data["station_key"] == registration.stationKey

internal fun isFresh(updatedAt: Long, now: Long): Boolean =
  now - updatedAt in -MAX_MESSAGE_AGE_MS..MAX_MESSAGE_AGE_MS

internal enum class ActivityPhase(
  val wire: String,
  /** Row status label, as the sender writes it in `activity_line_N`. */
  val status: String,
  /** The status-bar chip text. Android truncates short critical text aggressively. */
  val chip: String,
  val action: String
) {
  STARTING("starting", "Connecting", "Working", "Open"),
  RUNNING("running", "Working", "Working", "Open"),
  APPROVAL("waiting_for_approval", "Approval", "Approve", "Approve"),
  INPUT("waiting_for_input", "Input", "Answer", "Answer"),
  STALE("stale", "Waiting", "Waiting", "Open"),
  COMPLETED("completed", "Done", "Done", "Open"),
  FAILED("failed", "Failed", "Failed", "Open");

  val needsUser get() = this == APPROVAL || this == INPUT
  val finished get() = this == COMPLETED || this == FAILED

  companion object {
    fun forStatus(status: String) = entries.firstOrNull { it.status == status }
    fun forWire(wire: String) = entries.firstOrNull { it.wire == wire }
  }
}

internal const val MAX_ROWS = 5

/** The sender orders rows; the card never reorders them. Malformed rows are dropped. */
internal fun activityRows(data: Map<String, String>): List<ActivityRow> =
  (0 until MAX_ROWS).mapNotNull {
    val parts = data["activity_line_$it"]?.split('\t', limit = 3) ?: return@mapNotNull null
    if (parts.size != 3 || parts[1].isBlank()) {
      null
    } else {
      ActivityRow(parts[0].take(40), parts[1].take(120), parts[2].take(120))
    }
  }

internal fun activityPhase(data: Map<String, String>, rows: List<ActivityRow>): ActivityPhase? =
  data["activity_phase"]?.takeIf { it.isNotBlank() }?.let { ActivityPhase.forWire(it) }
    ?: rows.firstOrNull()?.let { ActivityPhase.forStatus(it.status) }

/** What the card says, derived only from the payload. */
internal class ActivityModel(data: Map<String, String>, val active: Boolean) {
  val rows = activityRows(data)
  val hero = rows.firstOrNull()
  val phase = activityPhase(data, rows)
  val activeCount = data["activity_active_count"]?.toIntOrNull()?.coerceAtLeast(0)
    ?: rows.count { ActivityPhase.forStatus(it.status)?.finished != true }
  val attentionCount = data["activity_attention_count"]?.toIntOrNull()?.coerceAtLeast(0)
    ?: rows.count { ActivityPhase.forStatus(it.status)?.needsUser == true }
  val failedCount = rows.count { it.status == ActivityPhase.FAILED.status }
  val threadCount = activeCount + rows.count { ActivityPhase.forStatus(it.status)?.finished == true }
  val singleProject = rows.map { it.project }.distinct().size == 1

  val summary: String = when {
    hero == null -> "Agent activity"
    rows.size == 1 -> hero.title
    attentionCount == 1 -> "1 needs you"
    attentionCount > 1 -> "$attentionCount need you"
    activeCount > 0 && failedCount > 0 -> "$failedCount failed"
    activeCount > 0 -> "$activeCount working"
    failedCount > 0 -> "Finished, $failedCount failed"
    else -> "All finished"
  }

  /** Null when finished: a finished card is not promoted, so it has no chip. */
  val chip: String? = when {
    !active -> null
    phase == null -> "Active"
    phase == ActivityPhase.RUNNING && activeCount > 1 ->
      "${if (activeCount > 9) "9+" else activeCount} live"
    else -> phase.chip
  }

  /** Null when finished: the card swipes away and a tap opens the app. */
  val action: String? = if (active) phase?.action ?: "Open" else null
}

package io.kontourai.station.agentactivity

import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.json.JSONException
import org.json.JSONObject

/*
 * The plain-JVM half of an agent-activity card: reading a push and deciding
 * what its card says. Nothing here touches android.*, so all of it runs in
 * the JVM unit tests; AgentActivityPresentation and AgentNotifications turn
 * these decisions into notifications.
 *
 * A push is an FCM data message whose values are all strings. Routing fields
 * travel in the clear; everything else is inside `sealed` (see [openPush]).
 *
 * | Field | Meaning |
 * | --- | --- |
 * | `station_kind` | always `agent_activity` |
 * | `device_id` | the registration id `configure` stored |
 * | `user_id` | the Station id `configure` stored |
 * | `station_key` | stamped by the push gateway; must equal the stored Station key thumbprint ([acceptsPush]) |
 * | `updated_at` | epoch millis; a push too far from the phone's clock is dropped whole; one older than the last applied update has its card update ignored (its alert is still handled) |
 * | `active` | `true` while an agent is working or waiting on the user |
 * | `activity_phase` | an [ActivityPhase.wire] value |
 * | `activity_line_0` .. `activity_line_4` | `status<TAB>title<TAB>project`, in the sender's order |
 * | `activity_active_count`, `activity_attention_count` | optional totals, since only five rows travel |
 * | `activity_expires_at` | optional absolute expiry, epoch millis |
 * | `activity_session_id`, `activity_project_slug` | optional; the session a tap on the card opens ([sessionRoute]) |
 * | `alert_id`, `alert_title`, `alert_body` | optional one-shot attention alert |
 * | `alert_session_id`, `alert_project_slug` | optional; the session a single-session alert opens |
 *
 * Rows are the only source of card text: a payload with no usable row reads
 * as a bare "Agent activity" card rather than borrowing text from elsewhere.
 *
 * An alert that arrives while the app is in the foreground is recorded as
 * seen and not posted, because the web layer shows its own notice. The
 * sender cannot tell the app is open, so the web layer must raise the same
 * attention events from its own server stream.
 */

/** One agent thread as the card lists it. */
internal data class ActivityRow(val status: String, val title: String, val project: String)

/**
 * What a Station returned when this phone registered: `id` is the random
 * per-registration value carried as `device_id`, `stationId` travels as
 * `user_id`, and `stationKey` is the thumbprint of the Station's push key,
 * which the gateway stamps as `station_key` after verifying the signature.
 */
data class Registration(
  val id: String,
  val stationId: String,
  val stationKey: String,
  /** AES-256 key (base64url) the Station seals this registration's cards with. */
  val payloadKey: String
) {
  companion object {
    private val ID = Regex("^[A-Za-z0-9_-]{16,128}$")
    private val KEY_43 = Regex("^[A-Za-z0-9_-]{43}$")

    fun validOrNull(id: String, stationId: String, stationKey: String, payloadKey: String): Registration? =
      if (ID.matches(id) && stationId.isNotBlank() && stationId.length <= 128 &&
        KEY_43.matches(stationKey) && KEY_43.matches(payloadKey)
      ) {
        Registration(id, stationId, stationKey, payloadKey)
      } else {
        null
      }
  }
}

private const val SEAL_NONCE_BYTES = 12
private const val SEAL_TAG_BITS = 128
internal fun sealAad(registrationId: String) = "station-agent-activity:v1:$registrationId"

/**
 * Opens a card the Station sealed for this registration (AES-256-GCM, a
 * 12-byte nonce prefixed, the registration bound in as associated data).
 * Only the Station and this phone hold the key, so the gateway, Cloudflare
 * and Google carry the card without being able to read or forge it. Returns
 * null for anything that does not authenticate or is not a flat string map.
 */
fun unseal(payloadKey: String, registrationId: String, sealed: String): Map<String, String>? {
  val key = decodeBase64Url(payloadKey)?.takeIf { it.size == 32 } ?: return null
  val bytes = decodeBase64Url(sealed)?.takeIf { it.size > SEAL_NONCE_BYTES + SEAL_TAG_BITS / 8 } ?: return null
  val plaintext = try {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(
      Cipher.DECRYPT_MODE,
      SecretKeySpec(key, "AES"),
      GCMParameterSpec(SEAL_TAG_BITS, bytes, 0, SEAL_NONCE_BYTES)
    )
    cipher.updateAAD(sealAad(registrationId).toByteArray(Charsets.UTF_8))
    cipher.doFinal(bytes, SEAL_NONCE_BYTES, bytes.size - SEAL_NONCE_BYTES)
  } catch (_: AEADBadTagException) {
    return null
  } catch (_: java.security.GeneralSecurityException) {
    return null
  }
  return try {
    val json = JSONObject(String(plaintext, Charsets.UTF_8))
    buildMap {
      for (name in json.keys()) {
        val value = json.get(name)
        if (value !is String) return null
        put(name, value)
      }
    }
  } catch (_: JSONException) {
    null
  }
}

private const val BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/**
 * Unpadded base64url. java.util.Base64 needs API 26 (minSdk is 24) and
 * android.util.Base64 is a stub in JVM unit tests, so decode by hand.
 */
internal fun decodeBase64Url(value: String): ByteArray? {
  if (value.length % 4 == 1) return null
  val out = java.io.ByteArrayOutputStream(value.length * 3 / 4)
  var buffer = 0
  var bits = 0
  for (char in value) {
    val index = BASE64URL.indexOf(char)
    if (index < 0) return null
    buffer = (buffer shl 6) or index
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.write((buffer shr bits) and 0xFF)
    }
  }
  return out.toByteArray()
}

/**
 * Combines a push's routing fields with its sealed card. Routing values come
 * only from outside the seal (the gateway stamps station_key there), and the
 * card cannot override them.
 */
internal fun openPush(registration: Registration, data: Map<String, String>): Map<String, String>? {
  val sealed = data["sealed"] ?: return null
  val card = unseal(registration.payloadKey, registration.id, sealed) ?: return null
  val routing = listOf("station_kind", "device_id", "station_key")
  return card - routing.toSet() + routing.mapNotNull { key -> data[key]?.let { key to it } }
}


/** How far `updated_at` may sit from the phone's clock, either way. */
internal const val MAX_MESSAGE_AGE_MS = 10 * 60 * 1000L

/**
 * True when a push names this phone's registration, its Station, and the
 * Station key the gateway verified. Pinning the key is what keeps another
 * Station — which can also get a signature past the gateway — off this
 * phone's cards.
 */
internal fun acceptsPush(registration: Registration?, data: Map<String, String>): Boolean {
  if (registration == null) return false
  return data["device_id"] == registration.id &&
    data["user_id"] == registration.stationId &&
    data["station_key"] == registration.stationKey
}

internal fun isFresh(updatedAt: Long, now: Long): Boolean {
  val skew = now - updatedAt
  return skew >= -MAX_MESSAGE_AGE_MS && skew <= MAX_MESSAGE_AGE_MS
}

/**
 * Where an agent thread is. [wire] is the `activity_phase` value; [status]
 * is the label the sender writes at the front of an `activity_line_N` row.
 */
internal enum class ActivityPhase(val wire: String, val status: String) {
  STARTING("starting", "Connecting"),
  RUNNING("running", "Working"),
  APPROVAL("waiting_for_approval", "Approval"),
  INPUT("waiting_for_input", "Input"),
  STALE("stale", "Waiting"),
  COMPLETED("completed", "Done"),
  FAILED("failed", "Failed");

  /**
   * Status-bar chip text. Kept to one short word because Android cuts the
   * promoted chip off after a few characters.
   */
  val chip: String
    get() = when (this) {
      STARTING, RUNNING -> "Working"
      APPROVAL -> "Approve"
      INPUT -> "Answer"
      else -> status
    }

  /** The card's primary button: the verb the user is being asked for, else Open. */
  val action: String
    get() = when (this) {
      APPROVAL -> "Approve"
      INPUT -> "Answer"
      else -> "Open"
    }

  val needsUser: Boolean get() = this == APPROVAL || this == INPUT
  val finished: Boolean get() = this == COMPLETED || this == FAILED

  companion object {
    private val byWire = entries.associateBy { it.wire }
    private val byStatus = entries.associateBy { it.status }

    fun forWire(wire: String): ActivityPhase? = byWire[wire]
    fun forStatus(status: String): ActivityPhase? = byStatus[status]
  }
}

/** Rows the sender may include; slots past this are ignored. */
internal const val MAX_ROWS = 5
private const val STATUS_CHARS = 40
private const val TEXT_CHARS = 120

/**
 * The card's rows, in the order the sender wrote them (the card never
 * re-sorts). A slot that is missing, lacks three tab-separated fields, or
 * has a blank title is skipped; overlong fields are cut.
 */
internal fun activityRows(data: Map<String, String>): List<ActivityRow> {
  val rows = ArrayList<ActivityRow>(MAX_ROWS)
  for (slot in 0 until MAX_ROWS) {
    val line = data["activity_line_$slot"] ?: continue
    val fields = line.split('\t', limit = 3)
    if (fields.size < 3) continue
    val (status, title, project) = fields
    if (title.isBlank()) continue
    rows.add(ActivityRow(status.take(STATUS_CHARS), title.take(TEXT_CHARS), project.take(TEXT_CHARS)))
  }
  return rows
}

/**
 * The card's overall phase: `activity_phase` when it names a known phase,
 * otherwise whatever the first row's status label maps to.
 */
internal fun activityPhase(data: Map<String, String>, rows: List<ActivityRow>): ActivityPhase? {
  val declared = data["activity_phase"].orEmpty()
  if (declared.isNotBlank()) {
    ActivityPhase.forWire(declared)?.let { return it }
  }
  val lead = rows.firstOrNull() ?: return null
  return ActivityPhase.forStatus(lead.status)
}

private fun Map<String, String>.total(key: String): Int? = this[key]?.toIntOrNull()?.coerceAtLeast(0)

/** Everything the card shows, worked out from the payload alone. */
internal class ActivityModel(data: Map<String, String>, val active: Boolean) {
  val rows: List<ActivityRow> = activityRows(data)
  val hero: ActivityRow? = rows.firstOrNull()
  val phase: ActivityPhase? = activityPhase(data, rows)

  private val rowPhases = rows.map { ActivityPhase.forStatus(it.status) }
  private val finishedRows = rowPhases.count { it?.finished == true }

  /** The sender's totals win: they cover threads beyond the five rows. */
  val activeCount: Int = data.total("activity_active_count") ?: (rows.size - finishedRows)
  val attentionCount: Int = data.total("activity_attention_count") ?: rowPhases.count { it?.needsUser == true }
  val failedCount: Int = rows.count { it.status == ActivityPhase.FAILED.status }
  val threadCount: Int = activeCount + finishedRows
  val singleProject: Boolean = rows.map { it.project }.toSet().size == 1

  /** The card title: the thread itself when there is one, else a count of what matters most. */
  val summary: String = describe()

  /** Chip text while the card is live; a finished card is not promoted and has none. */
  val chip: String? = if (active) chipText() else null

  /** The primary button while the card is live; a finished card only needs its tap. */
  val action: String? = if (active) phase?.action ?: "Open" else null

  private fun describe(): String {
    val only = hero ?: return "Agent activity"
    if (rows.size == 1) return only.title
    if (attentionCount > 0) return if (attentionCount == 1) "1 needs you" else "$attentionCount need you"
    if (failedCount > 0) return if (activeCount > 0) "$failedCount failed" else "Finished, $failedCount failed"
    return if (activeCount > 0) "$activeCount working" else "All finished"
  }

  private fun chipText(): String {
    val current = phase ?: return "Active"
    if (current == ActivityPhase.RUNNING && activeCount > 1) {
      val shown = if (activeCount > 9) "9+" else activeCount.toString()
      return "$shown live"
    }
    return current.chip
  }
}

/** One line of the card body: a status label, the thread, and an optional dimmed suffix. */
internal data class CardLine(val status: String, val text: String, val suffix: String)

/** The card's text, before Android styling is applied. */
internal data class CardText(
  val title: String,
  /** Colour the title with the phase only when it reports an outcome or a request. */
  val accentTitle: Boolean,
  /** Below the title on a multi-thread card: the shared project, then a count. */
  val subText: String?,
  val lines: List<CardLine>
)

internal fun ActivityModel.cardText(): CardText {
  val multi = rows.size > 1
  // A plain "3 working" stays neutral so the accent keeps meaning something.
  val accent = multi && phase != null && phase != ActivityPhase.RUNNING && phase != ActivityPhase.STARTING
  val subText = if (!multi) {
    null
  } else {
    val parts = mutableListOf<String>()
    val project = rows[0].project
    if (singleProject && project.isNotBlank()) parts.add(project)
    parts.add(if (activeCount > 0) "$activeCount active" else "$threadCount threads")
    parts.joinToString(" · ")
  }
  val lines = when {
    rows.isEmpty() -> emptyList()
    // The title already names a lone thread, so its line carries the project instead.
    !multi -> listOf(CardLine(rows[0].status, rows[0].project, ""))
    else -> rows.map { CardLine(it.status, it.title, if (singleProject) "" else it.project) }
  }
  return CardText(summary, accent, subText, lines)
}

/** How many alert ids a registration remembers, so delivery retries are recognised. */
internal const val SEEN_ALERT_HISTORY = 64

/**
 * The alert history after seeing [alertId], or null when the id is already
 * in [history] (a delivery retry). History is newline-joined, oldest first,
 * and keeps the most recent [SEEN_ALERT_HISTORY] ids.
 */
internal fun rememberAlert(history: String?, alertId: String): String? {
  val seen = history?.split('\n') ?: emptyList()
  if (seen.contains(alertId)) return null
  return (seen.takeLast(SEEN_ALERT_HISTORY - 1) + alertId).joinToString("\n")
}

/** A card with no explicit expiry lives this long after its update while active. */
internal const val RUNNING_LIFETIME_MS = 2 * 60 * 60 * 1000L
/** No card outlives this, whatever expiry it asks for. */
internal const val MAX_LIFETIME_MS = 24 * 60 * 60 * 1000L

/** What a registration remembers about its ongoing card between pushes. */
internal data class CardMemory(
  val lastUpdate: Long,
  val lastActive: Boolean,
  val dismissed: Boolean,
  /** Whether the user turned ongoing cards on for this registration. */
  val ongoingEnabled: Boolean
)

/** What one accepted status update does to the ongoing card. */
internal sealed class CardStep {
  /** Older than an update already applied: change nothing. */
  object Stale : CardStep()

  /** Expired, or ongoing cards are off: take the card down and forget any dismissal. */
  object Remove : CardStep()

  /** The user dismissed this run; keep it down. */
  object KeepDismissed : CardStep()

  /** Post (or refresh) the card, to time out after [remainingMs]. */
  data class Post(val remainingMs: Long) : CardStep()
}

/**
 * Decides [CardStep] for an update. Expiry is absolute — `activity_expires_at`
 * when the sender gives one, else [RUNNING_LIFETIME_MS] after an active
 * update — so a replayed push cannot keep a finished card or an abandoned
 * host alive. Dismissing a run also dismisses its finished card; only a new
 * run (inactive to active) brings the card back.
 */
internal fun planCard(
  memory: CardMemory,
  updatedAt: Long,
  active: Boolean,
  expiresAtField: String?,
  now: Long
): CardStep {
  if (updatedAt < memory.lastUpdate) return CardStep.Stale
  val expiresAt = expiresAtField?.toLongOrNull() ?: if (active) updatedAt + RUNNING_LIFETIME_MS else 0L
  val remainingMs = minOf(expiresAt - now, MAX_LIFETIME_MS)
  if (remainingMs <= 0 || !memory.ongoingEnabled) return CardStep.Remove
  val newRun = active && !memory.lastActive
  if (memory.dismissed && !newRun) return CardStep.KeepDismissed
  return CardStep.Post(remainingMs)
}


/**
 * The contract grammar for a session id or project slug
 * (packages/contracts/src/native-push.ts
 * `NATIVE_PUSH_SESSION_REFERENCE_PATTERN`; a server test pins the two equal).
 * ASCII only: `[A-Za-z0-9]` is not Unicode-aware in java.util.regex.
 */
internal val SESSION_REFERENCE = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")

/**
 * A session a tap opens, and which Station it belongs to. `stationId` is the
 * registration's verified Station id, never a value from the card, so the
 * web layer can refuse a route for a Station it is not connected to.
 */
data class SessionRoute(val stationId: String, val sessionId: String, val projectSlug: String?) {
  companion object {
    /**
     * Null unless every part is well formed: a session id and (optional)
     * project slug in the contract grammar, and a Station id that is a
     * registration's. Anything else opens the app where it was.
     */
    fun validOrNull(stationId: String?, sessionId: String?, projectSlug: String?): SessionRoute? {
      if (stationId.isNullOrBlank() || stationId.length > 128) return null
      if (sessionId == null || !SESSION_REFERENCE.matches(sessionId)) return null
      if (projectSlug != null && !SESSION_REFERENCE.matches(projectSlug)) return null
      return SessionRoute(stationId, sessionId, projectSlug)
    }
  }
}

internal enum class RouteSource(val prefix: String) { ACTIVITY("activity"), ALERT("alert") }

/**
 * The route a card (or its alert) names, from an opened, accepted card.
 * A malformed reference is dropped whole — never half a route.
 */
internal fun sessionRoute(registration: Registration, data: Map<String, String>, source: RouteSource): SessionRoute? =
  SessionRoute.validOrNull(
    registration.stationId,
    data["${source.prefix}_session_id"],
    data["${source.prefix}_project_slug"]
  )

/**
 * A tap nonce: 128 random bits, lowercase hex. The only thing a card's or
 * alert's launch intent carries; the route it opens stays in app-private
 * storage (see [TapLedger]).
 */
internal val TAP_NONCE = Regex("^[0-9a-f]{32}$")

/** Card taps are valid at most as long as a card can live. */
internal const val TAP_LIFETIME_MS = 24 * 60 * 60 * 1000L

/** One live nonce per card/alert identity, so this bounds cards plus recent alerts. */
internal const val MAX_TAPS = 20

/** A nonce a posted card or alert carries, and what a tap on it opens. */
internal data class IssuedTap(
  val nonce: String,
  /** The notification's intent identity (`activity:<registration>`, `alert:<registration>:<alert>`). */
  val identity: String,
  /** The PendingIntent request code, so a redeemed tap can re-arm the same intent. */
  val requestCode: Int,
  val route: SessionRoute,
  val issuedAt: Long
)

/** A redeemed tap: the route to open, and the fresh nonce that re-arms the same notification. */
internal data class RedeemedTap(val ledger: TapLedger, val route: SessionRoute, val reissued: IssuedTap)

/**
 * Which tap nonces are live (#2515). The launcher activity is exported and
 * Android restores a recreated activity with its ORIGINAL launch intent after
 * process death, so neither the intent's extras nor "we removed them" can be
 * trusted: a route is opened only by redeeming a nonce this phone issued, and
 * redeeming consumes it.
 *
 * Repeat taps of the same ongoing card must keep working, but its posted
 * PendingIntent still carries the consumed nonce. So redeeming re-issues: a
 * fresh nonce for the same identity and route, which the caller writes into
 * the SAME PendingIntent with FLAG_UPDATE_CURRENT (the posted notification
 * holds that PendingIntent, so its next tap delivers the fresh nonce). The
 * consumed nonce — the one a restored launch intent replays — is gone.
 *
 * Issuing for an identity drops that identity's previous nonce: its
 * PendingIntent's extras were just replaced, so nothing can legitimately
 * deliver the old one.
 */
internal class TapLedger(val taps: List<IssuedTap>) {
  private fun live(now: Long) = taps.filter { now - it.issuedAt in 0..TAP_LIFETIME_MS }

  fun issue(identity: String, requestCode: Int, route: SessionRoute, nonce: String, now: Long): TapLedger =
    TapLedger(
      (live(now).filter { it.identity != identity } + IssuedTap(nonce, identity, requestCode, route, now))
        .takeLast(MAX_TAPS)
    )

  /** Drops an identity's nonce: its notification no longer names a session. */
  fun forget(identity: String, now: Long): TapLedger = TapLedger(live(now).filter { it.identity != identity })

  /**
   * Consumes [nonce] and re-issues its identity under [freshNonce]; null
   * when the nonce is malformed, unknown, expired or already redeemed.
   */
  fun redeem(nonce: String?, now: Long, freshNonce: String): RedeemedTap? {
    if (nonce == null || !TAP_NONCE.matches(nonce)) return null
    val tap = live(now).firstOrNull { it.nonce == nonce } ?: return null
    val reissued = IssuedTap(freshNonce, tap.identity, tap.requestCode, tap.route, now)
    return RedeemedTap(TapLedger(live(now).filter { it.nonce != nonce } + reissued), tap.route, reissued)
  }

  fun serialize(): String =
    org.json.JSONArray(
      taps.map { tap ->
        JSONObject()
          .put("nonce", tap.nonce)
          .put("identity", tap.identity)
          .put("requestCode", tap.requestCode)
          .put("stationId", tap.route.stationId)
          .put("sessionId", tap.route.sessionId)
          .put("projectSlug", tap.route.projectSlug ?: JSONObject.NULL)
          .put("issuedAt", tap.issuedAt)
      }
    ).toString()

  companion object {
    /** Anything unreadable, or any entry that no longer validates, is dropped. */
    fun parse(serialized: String?): TapLedger {
      if (serialized.isNullOrEmpty()) return TapLedger(emptyList())
      return try {
        val array = org.json.JSONArray(serialized)
        TapLedger(
          (0 until array.length()).mapNotNull { index ->
            val entry = array.optJSONObject(index) ?: return@mapNotNull null
            val nonce = entry.optString("nonce").takeIf { TAP_NONCE.matches(it) } ?: return@mapNotNull null
            val route = SessionRoute.validOrNull(
              entry.optString("stationId", null),
              entry.optString("sessionId", null),
              if (entry.isNull("projectSlug")) null else entry.optString("projectSlug", null)
            ) ?: return@mapNotNull null
            IssuedTap(nonce, entry.optString("identity"), entry.optInt("requestCode"), route, entry.optLong("issuedAt"))
          }
        )
      } catch (_: JSONException) {
        TapLedger(emptyList())
      }
    }
  }
}

/**
 * Whether an intent is shaped like the launch intents this plugin posts
 * (`getLaunchIntentForPackage`: ACTION_MAIN, no data) and was not relaunched
 * from Recents, which replays the original intent. Anything else is not a
 * card tap, whatever extras it carries.
 */
internal fun isCardTapIntent(action: String?, hasData: Boolean, launchedFromHistory: Boolean): Boolean =
  action == "android.intent.action.MAIN" && !hasData && !launchedFromHistory

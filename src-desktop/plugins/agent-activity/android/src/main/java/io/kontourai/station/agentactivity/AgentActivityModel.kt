// Adapted from T3 Code (https://github.com/pingdotgg/t3code,
// apps/mobile/modules/t3-agent-notifications), MIT License,
// Copyright (c) 2026 T3 Tools Inc.

package io.kontourai.station.agentactivity

import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.json.JSONException
import org.json.JSONObject

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
 * - `activity_session_id`, `activity_project_slug`: optional; the session row 0
 *   names, which a tap on the card opens (see [sessionRoute])
 * - `alert_id`, `alert_title`, `alert_body`: optional one-shot attention alert.
 * - `alert_session_id`, `alert_project_slug`: optional; the session a
 *   single-session alert names
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
 * [aad] defaults to the card's; a Station notification is sealed under its
 * own (see StationNotifications.kt), so neither opens as the other.
 */
fun unseal(
  payloadKey: String,
  registrationId: String,
  sealed: String,
  aad: String = sealAad(registrationId)
): Map<String, String>? {
  val key = decodeBase64Url(payloadKey)?.takeIf { it.size == 32 } ?: return null
  val bytes = decodeBase64Url(sealed)?.takeIf { it.size > SEAL_NONCE_BYTES + SEAL_TAG_BITS / 8 } ?: return null
  val plaintext = try {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(
      Cipher.DECRYPT_MODE,
      SecretKeySpec(key, "AES"),
      GCMParameterSpec(SEAL_TAG_BITS, bytes, 0, SEAL_NONCE_BYTES)
    )
    cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
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
internal fun openPush(
  registration: Registration,
  data: Map<String, String>,
  aad: String = sealAad(registration.id)
): Map<String, String>? {
  val sealed = data["sealed"] ?: return null
  val card = unseal(registration.payloadKey, registration.id, sealed, aad) ?: return null
  val routing = listOf("station_kind", "device_id", "station_key")
  return card - routing.toSet() + routing.mapNotNull { key -> data[key]?.let { key to it } }
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

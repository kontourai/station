package io.kontourai.station.agentactivity

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner

internal const val STATION_NOTIFICATION_KIND = "station_notification"

/**
 * Additional authenticated data prefix for a sealed Station notification
 * (`NATIVE_PUSH_NOTIFICATION_AAD_PREFIX` in
 * @kontourai/station-contracts/native-push; a server test pins the two equal).
 */
internal const val NOTIFICATION_AAD_PREFIX = "station-notification:v1:"

/** Ids the Station mints are UUIDs; anything outside this grammar is refused. */
private val NOTIFICATION_ID_PATTERN = Regex("^[A-Za-z0-9._:-]{1,128}$")

/** Deliveries of one id remembered per registration, newest last. */
internal const val NOTIFICATION_HISTORY = 64

/** How far a notification's `created_at` may be ahead of this phone's clock. */
private const val MAX_CLOCK_AHEAD_MS = 10 * 60 * 1000L

internal enum class NotificationUrgency(val wire: String) {
  ATTENTION("attention"),
  FAILED("failed"),
  DONE("done"),
  INFO("info");

  companion object {
    fun forWire(wire: String?) = entries.firstOrNull { it.wire == wire }
  }
}

/**
 * An opened, accepted Station notification (#2588). Plaintext format:
 * `NativePushNotificationPlaintext` in @kontourai/station-contracts/native-push.
 */
internal data class StationNotification(
  val id: String,
  val retract: Boolean,
  val title: String,
  val body: String,
  val urgency: NotificationUrgency,
  val createdAt: Long,
  val expiresAt: Long,
  val route: SessionRoute?
)

/**
 * Opens a `station_notification` push for [registration]: it must
 * authenticate under the notification AAD, name this registration, Station
 * and pinned Station key (the routing fields come from outside the seal, as
 * for the card), and be a well-formed version 1 alert or retract. Null for
 * anything else.
 */
internal fun openStationNotification(registration: Registration, data: Map<String, String>): StationNotification? {
  val fields = openPush(registration, data, NOTIFICATION_AAD_PREFIX + registration.id) ?: return null
  if (!acceptsPush(registration, fields)) return null
  if (fields["v"] != "1") return null
  val id = fields["id"]?.takeIf { NOTIFICATION_ID_PATTERN.matches(it) } ?: return null
  val createdAt = fields["created_at"]?.toLongOrNull() ?: return null
  val expiresAt = fields["expires_at"]?.toLongOrNull() ?: return null
  return when (fields["kind"]) {
    "retract" -> StationNotification(id, true, "", "", NotificationUrgency.INFO, createdAt, expiresAt, null)
    "alert" -> StationNotification(
      id = id,
      retract = false,
      title = fields["title"]?.takeIf { it.isNotBlank() }?.take(120) ?: return null,
      body = fields["body"].orEmpty().take(600),
      urgency = NotificationUrgency.forWire(fields["urgency"]) ?: NotificationUrgency.INFO,
      createdAt = createdAt,
      expiresAt = expiresAt,
      route = SessionRoute.validOrNull(registration.stationId, fields["session_id"], fields["project_slug"])
    )
    else -> null
  }
}

internal enum class NotificationAction { POST, CANCEL, DROP }

/**
 * What this phone has seen of each notification id: the newest `created_at`
 * of any delivery of it, alert or retract. Pure, so it runs in JVM tests.
 *
 * - An alert no newer than what was seen is dropped: an FCM redelivery or a
 *   retry of the same delivery, or an alert arriving after its own
 *   retraction (FCM does not order messages). A newer alert for the same id
 *   (the Station re-delivered it, or its content changed) replaces it.
 * - An expired alert, or one dated implausibly far ahead, is dropped.
 * - A retract cancels unless it is older than the newest delivery seen for
 *   the id (a newer re-show of the notification must not be taken back by a
 *   retract of an earlier one that FCM delivered late). Cancelling nothing
 *   is harmless, and the retract is remembered, so the alert it retracted
 *   cannot come back.
 */
internal class NotificationHistory(val seen: List<Pair<String, Long>>) {
  fun decide(notification: StationNotification, now: Long): Pair<NotificationAction, NotificationHistory> {
    val previous = seen.lastOrNull { it.first == notification.id }?.second
    if (notification.retract) {
      if (previous != null && notification.createdAt < previous) return NotificationAction.DROP to this
      return NotificationAction.CANCEL to remember(notification, previous)
    }
    if (previous != null && notification.createdAt <= previous) return NotificationAction.DROP to this
    if (now >= notification.expiresAt || notification.createdAt - now > MAX_CLOCK_AHEAD_MS) {
      return NotificationAction.DROP to this
    }
    return NotificationAction.POST to remember(notification, previous)
  }

  private fun remember(notification: StationNotification, previous: Long?): NotificationHistory {
    val createdAt = maxOf(notification.createdAt, previous ?: Long.MIN_VALUE)
    return NotificationHistory(
      (seen.filter { it.first != notification.id } + (notification.id to createdAt)).takeLast(NOTIFICATION_HISTORY)
    )
  }

  fun serialize(): String = seen.joinToString("\n") { "${it.first}\t${it.second}" }

  companion object {
    fun parse(serialized: String?): NotificationHistory =
      NotificationHistory(
        serialized.orEmpty().split('\n').mapNotNull { line ->
          val parts = line.split('\t')
          val createdAt = parts.getOrNull(1)?.toLongOrNull()
          if (parts.size == 2 && NOTIFICATION_ID_PATTERN.matches(parts[0]) && createdAt != null) parts[0] to createdAt else null
        }.takeLast(NOTIFICATION_HISTORY)
      )
  }
}

/**
 * Renders Station notifications natively, in a process FCM may just have
 * started (no MainActivity, WebView or Rust runtime). One Android
 * notification per Station notification id, per registration, on one
 * channel per urgency so each can be tuned in system settings. A tap opens
 * the app, and the session the notification names through the same
 * one-time tap nonce as a card ([TapLedger]); the route never rides on the
 * intent.
 */
object StationNotifications {
  private const val TAG = "station-notification"
  private const val NOTIFICATION_ID = 73002
  private const val HISTORY_KEY = "notificationHistory"

  private val CHANNELS = mapOf(
    NotificationUrgency.ATTENTION to Triple("station-attention", "Needs you", NotificationManager.IMPORTANCE_HIGH),
    NotificationUrgency.FAILED to Triple("station-failed", "Failures", NotificationManager.IMPORTANCE_HIGH),
    NotificationUrgency.DONE to Triple("station-done", "Finished work", NotificationManager.IMPORTANCE_DEFAULT),
    NotificationUrgency.INFO to Triple("station-info", "Updates", NotificationManager.IMPORTANCE_LOW),
  )

  internal fun tagPrefix(registrationId: String) = "$TAG:$registrationId:"
  internal fun isStationNotificationTag(tag: String?) = tag?.startsWith("$TAG:") == true
  private fun tag(registrationId: String, id: String) = tagPrefix(registrationId) + id

  fun receive(context: Context, data: Map<String, String>) {
    synchronized(AgentNotifications) { receiveLocked(context, data) }
  }

  private fun receiveLocked(context: Context, data: Map<String, String>) {
    val registration = data["device_id"]?.let { AgentNotifications.registration(context, it) } ?: return
    val notification = openStationNotification(registration, data) ?: return
    val prefs = AgentNotifications.state(context, registration.id)
    val (action, history) = NotificationHistory.parse(prefs.getString(HISTORY_KEY, null))
      .decide(notification, System.currentTimeMillis())
    if (action == NotificationAction.DROP) return
    // commit: a redelivery right after a process death must still be recognised.
    prefs.edit().putString(HISTORY_KEY, history.serialize()).commit()
    val manager = context.getSystemService(NotificationManager::class.java)
    if (action == NotificationAction.CANCEL) {
      manager.cancel(tag(registration.id, notification.id), NOTIFICATION_ID)
      return
    }
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
    // The open app shows its own in-app notice, as for card alerts. Recorded
    // either way, so a retry cannot surface it after the app is backgrounded.
    if (ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return
    channels(context)
    val identity = "notification:${registration.id}:${notification.id}"
    val (channel, _, importance) = CHANNELS.getValue(notification.urgency)
    val high = importance >= NotificationManager.IMPORTANCE_HIGH
    val built = NotificationCompat.Builder(context, channel)
      .setSmallIcon(R.drawable.agent_activity_mark)
      .setContentTitle(notification.title)
      .setContentText(notification.body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(notification.body))
      .setPriority(if (high) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
      .setDefaults(if (high) Notification.DEFAULT_ALL else 0)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setAutoCancel(true)
      .setTimeoutAfter((notification.expiresAt - System.currentTimeMillis()).coerceAtLeast(1))
      .setContentIntent(AgentNotifications.openApp(context, identity.hashCode(), identity, notification.route))
      .build()
    manager.notify(tag(registration.id, notification.id), NOTIFICATION_ID, built)
  }

  private fun channels(context: Context) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      context.getSystemService(NotificationManager::class.java).createNotificationChannels(
        CHANNELS.values.map { (id, name, importance) -> NotificationChannel(id, name, importance) }
      )
    }
  }
}

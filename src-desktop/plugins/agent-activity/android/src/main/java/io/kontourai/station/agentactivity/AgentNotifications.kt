package io.kontourai.station.agentactivity

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

internal const val AGENT_ACTIVITY_KIND = "agent_activity"
private const val EXTRA_REGISTRATION = "io.kontourai.station.agentactivity.REGISTRATION"
/** The tap nonce a card's or alert's launch intent carries; see [TapLedger]. */
internal const val EXTRA_TAP = "io.kontourai.station.agentactivity.TAP"

/**
 * FCM entry point. FCM may start the process just for this, so there is no
 * MainActivity, WebView or Rust runtime: [AgentNotifications] works from a
 * bare Context.
 */
class AgentMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    val data = remoteMessage.data
    if (data["station_kind"] != AGENT_ACTIVITY_KIND) return
    AgentNotifications.receive(this, data)
  }
}

/** A broadcast that names one registration, sent by a card's delete intent or expiry alarm. */
abstract class RegistrationBroadcastReceiver : BroadcastReceiver() {
  protected abstract fun handle(context: Context, registrationId: String)

  override fun onReceive(context: Context, intent: Intent) {
    val registrationId = intent.getStringExtra(EXTRA_REGISTRATION) ?: return
    handle(context, registrationId)
  }
}

class AgentActivityDismissReceiver : RegistrationBroadcastReceiver() {
  override fun handle(context: Context, registrationId: String) = AgentNotifications.dismiss(context, registrationId)
}

class AgentActivityExpiryReceiver : RegistrationBroadcastReceiver() {
  override fun handle(context: Context, registrationId: String) = AgentNotifications.expire(context, registrationId)
}

/**
 * The two notification channels. Ids and names are persisted by Android
 * once created, so they must not change.
 */
private enum class Channel(
  val id: String,
  val title: String,
  val importance: Int,
  val priority: Int,
  val defaults: Int
) {
  ALERTS(
    "agent-alerts",
    "Agent alerts",
    NotificationManager.IMPORTANCE_HIGH,
    NotificationCompat.PRIORITY_HIGH,
    Notification.DEFAULT_ALL
  ),
  ACTIVITY(
    "agent-activity",
    "Ongoing agent activity",
    NotificationManager.IMPORTANCE_LOW,
    NotificationCompat.PRIORITY_LOW,
    0
  ),
}

/**
 * Posts agent-activity pushes as native notifications, so nothing waits on
 * the WebView. A phone may be paired with several Stations; every
 * registration keeps its own card, alert tag and replay state, so one
 * Station can never overwrite or clear another's.
 *
 * Storage (file and key names are on-disk state and must stay stable): the
 * `station-agent-activity` preferences file holds the set of registration
 * ids and the tap ledger; `station-agent-activity.<registrationId>` holds one
 * registration's keys and card memory.
 */
object AgentNotifications {
  private const val STORE = "station-agent-activity"
  private const val KEY_REGISTRATIONS = "registrations"
  private const val KEY_TAPS = "taps"
  private const val KEY_STATION_ID = "stationId"
  private const val KEY_STATION_KEY = "stationKey"
  private const val KEY_PAYLOAD_KEY = "payloadKey"
  private const val KEY_ONGOING = "ongoing"
  private const val KEY_DISMISSED = "dismissed"
  private const val KEY_LAST_UPDATE = "lastUpdate"
  private const val KEY_LAST_ACTIVE = "lastActive"
  private const val KEY_SEEN_ALERTS = "seenAlerts"
  private const val KEY_EXPIRES_AT = "expiresAt"

  private const val CARD_TAG = "station-agent-activity"
  private const val ALERT_TAG = "station-agent-alert"
  private const val CARD_NOTIFICATION_ID = 73001
  private const val ALERT_TITLE_CHARS = 120
  /** Room for a grouped alert: five thread titles of up to 120 characters, plus separators. */
  private const val ALERT_BODY_CHARS = 608
  /** The pseudo-registration `preview` renders under. */
  private const val PREVIEW = "preview"

  // ---- storage ----

  private fun indexStore(context: Context): SharedPreferences =
    context.getSharedPreferences(STORE, Context.MODE_PRIVATE)

  /** Registration ids are validated base64url, so they are safe in a file name. */
  private fun registrationStore(context: Context, registrationId: String): SharedPreferences =
    context.getSharedPreferences("$STORE.$registrationId", Context.MODE_PRIVATE)

  private fun knownIds(context: Context): Set<String> =
    indexStore(context).getStringSet(KEY_REGISTRATIONS, emptySet()).orEmpty()

  private fun writeIds(context: Context, ids: Set<String>) {
    indexStore(context).edit().putStringSet(KEY_REGISTRATIONS, ids).apply()
  }

  private fun storedStationId(context: Context, registrationId: String): String? =
    registrationStore(context, registrationId).getString(KEY_STATION_ID, null)

  private fun loadRegistration(context: Context, registrationId: String): Registration? {
    if (registrationId !in knownIds(context)) return null
    val store = registrationStore(context, registrationId)
    return Registration(
      registrationId,
      store.getString(KEY_STATION_ID, null) ?: return null,
      store.getString(KEY_STATION_KEY, null) ?: return null,
      store.getString(KEY_PAYLOAD_KEY, null) ?: return null
    )
  }

  private fun loadTaps(context: Context): TapLedger = TapLedger.parse(indexStore(context).getString(KEY_TAPS, null))

  /**
   * Written with commit(), not apply(): a redeemed nonce has to be off disk
   * before the process can die, or a restored launch intent could spend it
   * a second time.
   */
  private fun storeTaps(context: Context, ledger: TapLedger) {
    indexStore(context).edit().putString(KEY_TAPS, ledger.serialize()).commit()
  }

  // ---- registrations ----

  @Synchronized
  fun configure(context: Context, registration: Registration, ongoingEnabled: Boolean) {
    // A Station that registers again (reinstall, rotated registration)
    // replaces its old registration instead of gaining a second card. It
    // takes both the Station id and its key to match: an id on its own is
    // just a claim, and a different Station quoting it must not evict this one.
    val superseded = knownIds(context).filter { otherId ->
      otherId != registration.id &&
        registrationStore(context, otherId).let { other ->
          other.getString(KEY_STATION_ID, null) == registration.stationId &&
            other.getString(KEY_STATION_KEY, null) == registration.stationKey
        }
    }
    superseded.forEach { forget(context, it) }

    val store = registrationStore(context, registration.id)
    // A new key means a new replay history: start this registration over.
    val rekeyed = store.getString(KEY_STATION_KEY, null) != registration.stationKey
    if (rekeyed) cancelCard(context, registration.id)
    val wasOngoing = !rekeyed && store.getBoolean(KEY_ONGOING, false)
    store.edit().apply {
      if (rekeyed) clear()
      putString(KEY_STATION_ID, registration.stationId)
      putString(KEY_STATION_KEY, registration.stationKey)
      putString(KEY_PAYLOAD_KEY, registration.payloadKey)
      putBoolean(KEY_ONGOING, ongoingEnabled)
      // Turning ongoing cards back on shows the current run again.
      if (ongoingEnabled && !wasOngoing) putBoolean(KEY_DISMISSED, false)
    }.apply()
    if (!ongoingEnabled) cancelCard(context, registration.id)
    writeIds(context, knownIds(context) + registration.id)
    ensureChannels(context)
  }

  /**
   * Forgets [registrationId], or every registration when it is null, and
   * returns whether any registration is left. An id this phone does not know
   * is ignored, so it never creates a preferences file.
   */
  @Synchronized
  fun clear(context: Context, registrationId: String? = null): Boolean {
    when {
      registrationId == null -> {
        knownIds(context).forEach { forget(context, it) }
        // Also takes down the preview card and cards an older build posted
        // under a tag without the registration suffix.
        val manager = notificationManager(context)
        for (posted in manager.activeNotifications) {
          val tag = posted.tag ?: continue
          if (tag.startsWith(CARD_TAG) || tag.startsWith(ALERT_TAG)) manager.cancel(tag, posted.id)
        }
      }
      registrationId in knownIds(context) -> forget(context, registrationId)
    }
    return knownIds(context).isNotEmpty()
  }

  private fun forget(context: Context, registrationId: String) {
    // Drop the index entry first. Dying after that leaves at worst an
    // orphaned file, never an index entry with no data behind it (which
    // would keep the push token registered).
    writeIds(context, knownIds(context) - registrationId)
    cancelCard(context, registrationId)
    val manager = notificationManager(context)
    val alerts = alertTag(registrationId)
    for (posted in manager.activeNotifications) {
      if (posted.tag == alerts) manager.cancel(posted.tag, posted.id)
    }
    registrationStore(context, registrationId).edit().clear().commit()
    context.deleteSharedPreferences("$STORE.$registrationId")
  }

  /** True once `configure` stored a registration; says nothing about the Station's side. */
  fun isConfigured(context: Context): Boolean = knownIds(context).isNotEmpty()

  // ---- taps ----

  /**
   * Redeems a card or alert tap and returns the session it opens. Null when
   * the nonce was not issued here, was already spent (Android restoring a
   * launch intent after process death, or Recents replaying it), has
   * expired, or belongs to a Station this phone no longer knows. Redeeming
   * re-arms the same notification with a new nonce, so the card keeps
   * working on the next tap.
   */
  @Synchronized
  fun redeemTap(context: Context, nonce: String?): SessionRoute? {
    val redeemed = loadTaps(context).redeem(nonce, System.currentTimeMillis(), randomNonce()) ?: return null
    storeTaps(context, redeemed.ledger)
    rearm(context, redeemed.reissued)
    val route = redeemed.route
    val stationKnown = knownIds(context).any { storedStationId(context, it) == route.stationId }
    return if (stationKnown) route else null
  }

  /**
   * Puts [tap]'s fresh nonce into the PendingIntent its notification holds.
   * Only an intent that still exists is touched (FLAG_NO_CREATE probe);
   * FLAG_UPDATE_CURRENT then swaps the extras in place.
   */
  private fun rearm(context: Context, tap: IssuedTap) {
    val intent = launchIntent(context, tap.identity) ?: return
    PendingIntent.getActivity(
      context,
      tap.requestCode,
      intent,
      PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
    ) ?: return
    PendingIntent.getActivity(
      context,
      tap.requestCode,
      intent.putExtra(EXTRA_TAP, tap.nonce),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun randomNonce(): String {
    val bytes = ByteArray(16).also { java.security.SecureRandom().nextBytes(it) }
    val hex = StringBuilder(32)
    for (byte in bytes) hex.append(String.format("%02x", byte))
    return hex.toString()
  }

  // ---- card lifecycle ----

  @Synchronized
  fun dismiss(context: Context, registrationId: String) {
    if (registrationId == PREVIEW) {
      cancelCard(context, PREVIEW)
      return
    }
    if (registrationId !in knownIds(context)) return
    registrationStore(context, registrationId).edit().putBoolean(KEY_DISMISSED, true).apply()
    cancelCard(context, registrationId)
  }

  @Synchronized
  fun expire(context: Context, registrationId: String, now: Long = System.currentTimeMillis()) {
    val expiresAt = registrationStore(context, registrationId).getLong(KEY_EXPIRES_AT, 0)
    // An alarm set for an earlier run must not take down a later run's card.
    if (expiresAt > 0 && expiresAt <= now) cancelCard(context, registrationId)
  }

  @Synchronized
  fun receive(context: Context, data: Map<String, String>) {
    val registration = data["device_id"]?.let { loadRegistration(context, it) } ?: return
    // Cards travel sealed. One that does not open with this registration's
    // key was not written by its Station.
    val card = openPush(registration, data) ?: return
    val updatedAt = card["updated_at"]?.toLongOrNull() ?: return
    if (!acceptsPush(registration, card)) return
    if (!isFresh(updatedAt, System.currentTimeMillis())) return
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
    val store = registrationStore(context, registration.id)
    ensureChannels(context)
    handleAlert(context, registration.id, store, card, sessionRoute(registration, card, RouteSource.ALERT))
    handleCard(context, registration.id, store, card, updatedAt, sessionRoute(registration, card, RouteSource.ACTIVITY))
  }

  /**
   * Posts a payload as-is, skipping registration, freshness and foreground
   * checks. For verifying rendering on a device; not in the default
   * permission set. With no registration there is no verified Station, so
   * nothing it posts opens a session.
   */
  @Synchronized
  fun preview(context: Context, data: Map<String, String>) {
    ensureChannels(context)
    val alertId = data["alert_id"]
    if (alertId != null) postAlert(context, PREVIEW, data, alertId, null)
    postCard(context, PREVIEW, data, data["active"] == "true", RUNNING_LIFETIME_MS, null)
  }

  private fun cardTag(registrationId: String) = "$CARD_TAG:$registrationId"
  private fun alertTag(registrationId: String) = "$ALERT_TAG:$registrationId"

  private fun appInForeground(): Boolean =
    ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)

  private fun handleAlert(
    context: Context,
    registrationId: String,
    store: SharedPreferences,
    card: Map<String, String>,
    route: SessionRoute?
  ) {
    val alertId = card["alert_id"] ?: return
    // A retry repeats the alert id; the bounded history catches it even
    // after other alerts arrived in between.
    val history = rememberAlert(store.getString(KEY_SEEN_ALERTS, null), alertId) ?: return
    // With the app open its own in-app notice covers this. The id is still
    // recorded, so a retry cannot surface it once the app is backgrounded.
    if (!appInForeground()) postAlert(context, registrationId, card, alertId, route)
    store.edit().putString(KEY_SEEN_ALERTS, history).apply()
  }

  private fun postAlert(
    context: Context,
    registrationId: String,
    data: Map<String, String>,
    alertId: String,
    route: SessionRoute?
  ) {
    val title = (data["alert_title"] ?: "").take(ALERT_TITLE_CHARS)
    val body = (data["alert_body"] ?: "").take(ALERT_BODY_CHARS)
    val notificationId = alertId.hashCode()
    val opens = tapIntent(context, notificationId, "alert:$registrationId:$alertId", route)
    val builder = newBuilder(context, Channel.ALERTS)
    builder.setSmallIcon(R.drawable.agent_activity_mark)
    builder.setContentTitle(title)
    builder.setContentText(body)
    builder.setStyle(NotificationCompat.BigTextStyle().bigText(body))
    builder.setAutoCancel(true)
    builder.setContentIntent(opens)
    notificationManager(context).notify(alertTag(registrationId), notificationId, builder.build())
  }

  private fun handleCard(
    context: Context,
    registrationId: String,
    store: SharedPreferences,
    card: Map<String, String>,
    updatedAt: Long,
    route: SessionRoute?
  ) {
    val active = card["active"] == "true"
    val memory = CardMemory(
      lastUpdate = store.getLong(KEY_LAST_UPDATE, 0),
      lastActive = store.getBoolean(KEY_LAST_ACTIVE, false),
      dismissed = store.getBoolean(KEY_DISMISSED, false),
      ongoingEnabled = store.getBoolean(KEY_ONGOING, false)
    )
    val step = planCard(memory, updatedAt, active, card["activity_expires_at"], System.currentTimeMillis())
    // A reordered status update is dropped here; its alert was already handled.
    if (step is CardStep.Stale) return
    store.edit().putLong(KEY_LAST_UPDATE, updatedAt).putBoolean(KEY_LAST_ACTIVE, active).apply()
    when (step) {
      is CardStep.Post -> {
        store.edit().putBoolean(KEY_DISMISSED, false).apply()
        postCard(context, registrationId, card, active, step.remainingMs, route)
      }
      CardStep.Remove -> {
        cancelCard(context, registrationId)
        store.edit().putBoolean(KEY_DISMISSED, false).apply()
      }
      CardStep.KeepDismissed, CardStep.Stale -> Unit
    }
  }

  /**
   * A broadcast PendingIntent addressed to one registration. The request
   * code differs per registration so one card's dismiss intent cannot
   * overwrite another's; because hash codes can collide and PendingIntent
   * identity ignores extras, the data URI is what really keeps them apart.
   */
  private fun registrationBroadcast(context: Context, receiver: Class<*>, registrationId: String): PendingIntent {
    val intent = Intent(context, receiver)
      .setData(Uri.fromParts("station-registration", registrationId, null))
      .putExtra(EXTRA_REGISTRATION, registrationId)
    return PendingIntent.getBroadcast(
      context,
      registrationId.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun postCard(
    context: Context,
    registrationId: String,
    data: Map<String, String>,
    active: Boolean,
    remainingMs: Long,
    route: SessionRoute?
  ) {
    val model = ActivityModel(data, active)
    val onDismiss = registrationBroadcast(context, AgentActivityDismissReceiver::class.java, registrationId)
    // One PendingIntent per registration's card, updated in place, so a tap
    // (or the primary button) opens whatever session row 0 names right now.
    val opens = tapIntent(context, registrationId.hashCode(), "activity:$registrationId", route)
    val builder = newBuilder(context, Channel.ACTIVITY)
    builder.setOngoing(active)
    builder.setOnlyAlertOnce(true)
    builder.setSilent(true)
    builder.setTimeoutAfter(remainingMs)
    // A colorized notification does not qualify for Live Update promotion.
    builder.setColorized(false)
    builder.setRequestPromotedOngoing(active)
    builder.setShortCriticalText(model.chip)
    builder.setContentIntent(opens)
    builder.setDeleteIntent(onDismiss)
    model.applyTo(builder, context)
    // Buttons only on a live card: a finished card swipes away and its tap
    // already opens the app.
    model.action?.let { primary ->
      if (opens != null) builder.addAction(0, primary, opens)
      builder.addAction(0, "Dismiss", onDismiss)
    }
    notificationManager(context).notify(cardTag(registrationId), CARD_NOTIFICATION_ID, builder.build())

    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O && registrationId != PREVIEW) {
      // setTimeoutAfter needs API 26. On Android 7 a single inexact alarm
      // takes the card down, even after the process is gone, without an
      // exact-alarm permission, a foreground service or periodic work.
      val expiresAt = System.currentTimeMillis() + remainingMs
      registrationStore(context, registrationId).edit().putLong(KEY_EXPIRES_AT, expiresAt).apply()
      val alarms = context.getSystemService(AlarmManager::class.java)
      alarms.setAndAllowWhileIdle(
        AlarmManager.RTC_WAKEUP,
        expiresAt,
        registrationBroadcast(context, AgentActivityExpiryReceiver::class.java, registrationId)
      )
    }
  }

  private fun cancelCard(context: Context, registrationId: String) {
    notificationManager(context).cancel(cardTag(registrationId), CARD_NOTIFICATION_ID)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) return
    val alarms = context.getSystemService(AlarmManager::class.java)
    alarms.cancel(registrationBroadcast(context, AgentActivityExpiryReceiver::class.java, registrationId))
    registrationStore(context, registrationId).edit().remove(KEY_EXPIRES_AT).apply()
  }

  private fun notificationManager(context: Context): NotificationManager =
    context.getSystemService(NotificationManager::class.java)

  private fun ensureChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channels = Channel.entries.map { NotificationChannel(it.id, it.title, it.importance) }
    notificationManager(context).createNotificationChannels(channels)
  }

  private fun newBuilder(context: Context, channel: Channel): NotificationCompat.Builder =
    NotificationCompat.Builder(context, channel.id)
      .setPriority(channel.priority)
      .setDefaults(channel.defaults)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setShowWhen(false)

  /**
   * The PendingIntent a card or alert tap fires. It opens the app, at the
   * session [route] names when there is one: AgentActivityPlugin redeems
   * the tap and passes the route to the web layer, which checks it again
   * before navigating. Without a route the app opens where it was.
   *
   * Only a tap nonce rides on the intent. The route itself stays in
   * app-private storage ([TapLedger]), so extras another app puts on the
   * exported launcher activity open nothing, and a spent nonce cannot be
   * replayed. No data URI or action is set, because the deep-link plugin
   * would take either for a pairing link.
   *
   * PendingIntent identity ignores extras: [requestCode] and, from API 29,
   * the intent identifier built from [identity] keep one notification's
   * intent separate from another's. FLAG_UPDATE_CURRENT then replaces the
   * extras of the same notification's intent, so an updated card carries
   * only its latest nonce, and a card that stops naming a session stops
   * carrying one.
   */
  private fun tapIntent(context: Context, requestCode: Int, identity: String, route: SessionRoute?): PendingIntent? {
    val intent = launchIntent(context, identity) ?: return null
    val now = System.currentTimeMillis()
    val ledger = loadTaps(context)
    if (route == null) {
      storeTaps(context, ledger.forget(identity, now))
    } else {
      val nonce = randomNonce()
      storeTaps(context, ledger.issue(identity, requestCode, route, nonce, now))
      intent.putExtra(EXTRA_TAP, nonce)
    }
    return PendingIntent.getActivity(
      context,
      requestCode,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  /** The app's launch intent for a tap on [identity], before any nonce is added. */
  private fun launchIntent(context: Context, identity: String): Intent? {
    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) intent.identifier = "station-agent-activity:$identity"
    return intent
  }
}

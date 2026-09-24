// Adapted from T3 Code (https://github.com/pingdotgg/t3code,
// apps/mobile/modules/t3-agent-notifications), MIT License,
// Copyright (c) 2026 T3 Tools Inc.

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

/**
 * Runs in a process FCM may have just started: no MainActivity, no WebView,
 * no Rust runtime. Everything below must work from a bare Context.
 */
class AgentMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    if (remoteMessage.data["station_kind"] == AGENT_ACTIVITY_KIND) {
      AgentNotifications.receive(this, remoteMessage.data)
    }
  }
}

class AgentActivityDismissReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    intent.getStringExtra(EXTRA_REGISTRATION)?.let { AgentNotifications.dismiss(context, it) }
  }
}

class AgentActivityExpiryReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    intent.getStringExtra(EXTRA_REGISTRATION)?.let { AgentNotifications.expire(context, it) }
  }
}

/**
 * Renders agent-activity pushes natively, so delivery never waits on the
 * WebView. A phone can be paired with several Stations; each registration
 * has its own card and its own replay state, so one Station can never
 * overwrite or dismiss another's.
 */
object AgentNotifications {
  private const val INDEX_STORE = "station-agent-activity"
  private const val ACTIVITY_CHANNEL = "agent-activity"
  private const val ALERT_CHANNEL = "agent-alerts"
  private const val ACTIVITY_TAG = "station-agent-activity"
  private const val ALERT_TAG = "station-agent-alert"
  private const val ACTIVITY_ID = 73001
  private const val RUNNING_LIFETIME_MS = 2 * 60 * 60 * 1000L
  private const val MAX_LIFETIME_MS = 24 * 60 * 60 * 1000L
  private const val SEEN_ALERT_HISTORY = 64
  private const val PREVIEW = "preview"

  private fun index(context: Context): SharedPreferences =
    context.getSharedPreferences(INDEX_STORE, Context.MODE_PRIVATE)

  private fun registrationIds(context: Context): Set<String> =
    index(context).getStringSet("registrations", emptySet()).orEmpty()

  // registrationId is validated as base64url, so it is safe in a file name.
  private fun state(context: Context, registrationId: String): SharedPreferences =
    context.getSharedPreferences("$INDEX_STORE.$registrationId", Context.MODE_PRIVATE)

  private fun registration(context: Context, registrationId: String): Registration? {
    if (registrationId !in registrationIds(context)) return null
    val prefs = state(context, registrationId)
    val stationId = prefs.getString("stationId", null) ?: return null
    val stationKey = prefs.getString("stationKey", null) ?: return null
    return Registration(registrationId, stationId, stationKey)
  }

  @Synchronized
  fun configure(
    context: Context,
    registration: Registration,
    ongoingEnabled: Boolean
  ) {
    // The same Station re-registering (new install, registration rotated)
    // replaces its previous registration rather than leaving a second card.
    // Both id and key must match: a Station id alone is only a claim, and
    // another Station reporting it must not be able to evict this one.
    registrationIds(context)
      .filter {
        it != registration.id &&
          state(context, it).getString("stationId", null) == registration.stationId &&
          state(context, it).getString("stationKey", null) == registration.stationKey
      }
      .forEach { remove(context, it) }

    val prefs = state(context, registration.id)
    if (prefs.getString("stationKey", null) != registration.stationKey) {
      // A different key means different replay history; start clean.
      cancelActivity(context, registration.id)
      prefs.edit().clear().apply()
    }
    val wasEnabled = prefs.getBoolean("ongoing", false)
    prefs.edit()
      .putString("stationId", registration.stationId)
      .putString("stationKey", registration.stationKey)
      .putBoolean("ongoing", ongoingEnabled)
      .apply()
    if (ongoingEnabled && !wasEnabled) prefs.edit().putBoolean("dismissed", false).apply()
    if (!ongoingEnabled) cancelActivity(context, registration.id)
    index(context).edit().putStringSet("registrations", registrationIds(context) + registration.id).apply()
    channels(context)
  }

  /**
   * Removes one registration, or every registration when [registrationId] is
   * null, and reports whether any registration remains. Only known ids are
   * touched: an unknown id must not create a preferences file.
   */
  @Synchronized
  fun clear(context: Context, registrationId: String? = null): Boolean {
    if (registrationId == null) {
      registrationIds(context).forEach { remove(context, it) }
      // Also sweeps the preview card and any card an earlier version posted
      // under an unsuffixed tag.
      val manager = manager(context)
      manager.activeNotifications
        .filter { it.tag?.startsWith(ACTIVITY_TAG) == true || it.tag?.startsWith(ALERT_TAG) == true }
        .forEach { manager.cancel(it.tag, it.id) }
    } else if (registrationId in registrationIds(context)) {
      remove(context, registrationId)
    }
    return registrationIds(context).isNotEmpty()
  }

  private fun remove(context: Context, registrationId: String) {
    // Index first: a crash after this leaves an orphan file, never an index
    // entry without data that would keep the push token alive.
    index(context).edit().putStringSet("registrations", registrationIds(context) - registrationId).apply()
    cancelActivity(context, registrationId)
    val manager = manager(context)
    manager.activeNotifications.filter { it.tag == alertTag(registrationId) }
      .forEach { manager.cancel(it.tag, it.id) }
    state(context, registrationId).edit().clear().commit()
    context.deleteSharedPreferences("$INDEX_STORE.$registrationId")
  }

  /** True once `configure` stored a registration here; says nothing about the Station's side. */
  fun isConfigured(context: Context): Boolean = registrationIds(context).isNotEmpty()

  @Synchronized
  fun dismiss(context: Context, registrationId: String) {
    if (registrationId == PREVIEW) {
      cancelActivity(context, PREVIEW)
      return
    }
    if (registrationId !in registrationIds(context)) return
    state(context, registrationId).edit().putBoolean("dismissed", true).apply()
    cancelActivity(context, registrationId)
  }

  @Synchronized
  fun expire(context: Context, registrationId: String, now: Long = System.currentTimeMillis()) {
    val expiresAt = state(context, registrationId).getLong("expiresAt", 0)
    // An alarm dispatched for an earlier run must not remove a newer run's card.
    if (expiresAt in 1..now) cancelActivity(context, registrationId)
  }

  @Synchronized
  fun receive(context: Context, data: Map<String, String>) {
    val registration = data["device_id"]?.let { registration(context, it) }
    val updatedAt = data["updated_at"]?.toLongOrNull() ?: return
    if (!acceptsPush(registration, data) || !isFresh(updatedAt, System.currentTimeMillis())) return
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
    val prefs = state(context, registration!!.id)
    channels(context)
    showAlert(context, registration.id, prefs, data)
    updateActivity(context, registration.id, prefs, data, updatedAt)
  }

  /**
   * Renders a payload without the registration, freshness and foreground
   * checks. Device verification only: it is not in the default permission set.
   */
  @Synchronized
  fun preview(context: Context, data: Map<String, String>) {
    channels(context)
    data["alert_id"]?.let { postAlert(context, PREVIEW, data, it) }
    showActivity(context, PREVIEW, data, data["active"] == "true", RUNNING_LIFETIME_MS)
  }

  private fun activityTag(registrationId: String) = "$ACTIVITY_TAG:$registrationId"
  private fun alertTag(registrationId: String) = "$ALERT_TAG:$registrationId"

  private fun showAlert(
    context: Context,
    registrationId: String,
    prefs: SharedPreferences,
    data: Map<String, String>
  ) {
    // Delivery retries carry the same alert id. Keep a bounded, ordered
    // history so a retry of alert A after alert B is still recognised.
    val alertId = data["alert_id"] ?: return
    val seen = prefs.getString("seenAlerts", null)?.split('\n').orEmpty()
    if (alertId in seen) return
    // The open app shows its own in-app notice. Record the alert either way,
    // so a retry cannot surface it after the app is backgrounded.
    if (!ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
      postAlert(context, registrationId, data, alertId)
    }
    prefs.edit().putString(
      "seenAlerts",
      (seen.takeLast(SEEN_ALERT_HISTORY - 1) + alertId).joinToString("\n")
    ).apply()
  }

  private fun postAlert(
    context: Context,
    registrationId: String,
    data: Map<String, String>,
    alertId: String
  ) {
    val title = data["alert_title"].orEmpty().take(120)
    // Grouped alerts list up to five 120-character thread titles.
    val body = data["alert_body"].orEmpty().take(608)
    val id = alertId.hashCode()
    val notification = base(context, ALERT_CHANNEL)
      .setSmallIcon(R.drawable.agent_activity_mark)
      .setContentTitle(title).setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setAutoCancel(true)
      .setContentIntent(openApp(context, id))
      .build()
    manager(context).notify(alertTag(registrationId), id, notification)
  }

  private fun updateActivity(
    context: Context,
    registrationId: String,
    prefs: SharedPreferences,
    data: Map<String, String>,
    updatedAt: Long
  ) {
    // Drop reordered status updates without dropping an unrelated alert.
    if (updatedAt < prefs.getLong("lastUpdate", 0)) return
    prefs.edit().putLong("lastUpdate", updatedAt).apply()
    val active = data["active"] == "true"
    // Absolute expiry: a replay must not extend a finished card, or make an
    // abandoned host look active indefinitely.
    val expiresAt = data["activity_expires_at"]?.toLongOrNull()
      ?: if (active) updatedAt + RUNNING_LIFETIME_MS else 0L
    val remainingMs = (expiresAt - System.currentTimeMillis()).coerceAtMost(MAX_LIFETIME_MS)
    val wasActive = prefs.getBoolean("lastActive", false)
    prefs.edit().putBoolean("lastActive", active).apply()
    if (remainingMs <= 0 || !prefs.getBoolean("ongoing", false)) {
      cancelActivity(context, registrationId)
      prefs.edit().putBoolean("dismissed", false).apply()
      return
    }
    // Dismissing a run includes its finished card. A new run arms it again;
    // replays of the finished state stay dismissed.
    if (active && !wasActive) prefs.edit().putBoolean("dismissed", false).apply()
    if (!prefs.getBoolean("dismissed", false)) {
      showActivity(context, registrationId, data, active, remainingMs)
    }
  }

  private fun registrationIntent(context: Context, receiver: Class<*>, registrationId: String): PendingIntent =
    PendingIntent.getBroadcast(
      context,
      // Request codes must differ per registration, or one card's dismiss
      // action would be overwritten by another's.
      registrationId.hashCode(),
      // PendingIntent identity ignores extras, and hashCode values collide:
      // the data URI keeps each registration's intent distinct.
      Intent(context, receiver)
        .setData(Uri.fromParts("station-registration", registrationId, null))
        .putExtra(EXTRA_REGISTRATION, registrationId),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

  private fun showActivity(
    context: Context,
    registrationId: String,
    data: Map<String, String>,
    active: Boolean,
    remainingMs: Long
  ) {
    val dismissIntent = registrationIntent(context, AgentActivityDismissReceiver::class.java, registrationId)
    val model = ActivityModel(data, active)
    val open = openApp(context, registrationId.hashCode())
    val builder = base(context, ACTIVITY_CHANNEL)
      .setOngoing(active).setOnlyAlertOnce(true).setSilent(true)
      .setTimeoutAfter(remainingMs)
      // Live Updates must stay uncolorized to qualify for promotion.
      .setColorized(false)
      .setRequestPromotedOngoing(active)
      .setShortCriticalText(model.chip)
      .setContentIntent(open)
      .setDeleteIntent(dismissIntent)
    model.applyTo(builder, context)
    // A finished card is not ongoing: it swipes away and a tap opens the app,
    // so buttons would only repeat that.
    val action = model.action
    if (action != null) {
      if (open != null) builder.addAction(0, action, open)
      builder.addAction(0, "Dismiss", dismissIntent)
    }
    manager(context).notify(activityTag(registrationId), ACTIVITY_ID, builder.build())
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O && registrationId != PREVIEW) {
      // Notification timeouts arrived in API 26. One inexact alarm expires
      // the card on Android 7 even after the process exits, with no
      // exact-alarm permission, foreground service or periodic work.
      val expiresAt = System.currentTimeMillis() + remainingMs
      state(context, registrationId).edit().putLong("expiresAt", expiresAt).apply()
      context.getSystemService(AlarmManager::class.java).setAndAllowWhileIdle(
        AlarmManager.RTC_WAKEUP,
        expiresAt,
        registrationIntent(context, AgentActivityExpiryReceiver::class.java, registrationId)
      )
    }
  }

  private fun cancelActivity(context: Context, registrationId: String) {
    manager(context).cancel(activityTag(registrationId), ACTIVITY_ID)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      context.getSystemService(AlarmManager::class.java)
        .cancel(registrationIntent(context, AgentActivityExpiryReceiver::class.java, registrationId))
      state(context, registrationId).edit().remove("expiresAt").apply()
    }
  }

  private fun manager(context: Context) = context.getSystemService(NotificationManager::class.java)

  private fun channels(context: Context) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager(context).createNotificationChannels(
        listOf(
          NotificationChannel(ALERT_CHANNEL, "Agent alerts", NotificationManager.IMPORTANCE_HIGH),
          NotificationChannel(ACTIVITY_CHANNEL, "Ongoing agent activity", NotificationManager.IMPORTANCE_LOW),
        )
      )
    }
  }

  private fun base(context: Context, channel: String): NotificationCompat.Builder {
    val alert = channel == ALERT_CHANNEL
    return NotificationCompat.Builder(context, channel)
      .setPriority(if (alert) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_LOW)
      .setDefaults(if (alert) Notification.DEFAULT_ALL else 0)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setShowWhen(false)
  }

  /**
   * Opens the app where it was. Routing to a specific session needs a route
   * contract with the web layer and is deliberately not guessed here.
   */
  private fun openApp(context: Context, id: Int): PendingIntent? {
    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      context,
      id,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }
}

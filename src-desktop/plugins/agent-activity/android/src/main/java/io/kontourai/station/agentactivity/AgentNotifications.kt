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
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

internal const val AGENT_ACTIVITY_KIND = "agent_activity"

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
    AgentNotifications.dismiss(context)
  }
}

class AgentActivityExpiryReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    AgentNotifications.expire(context)
  }
}

/** Renders agent-activity pushes natively, so delivery never waits on the WebView. */
object AgentNotifications {
  private const val STORE = "station-agent-activity"
  private const val ACTIVITY_CHANNEL = "agent-activity"
  private const val ALERT_CHANNEL = "agent-alerts"
  private const val ACTIVITY_TAG = "station-agent-activity"
  private const val ALERT_TAG = "station-agent-alert"
  private const val ACTIVITY_ID = 73001
  private const val MAX_MESSAGE_AGE_MS = 10 * 60 * 1000L
  private const val RUNNING_LIFETIME_MS = 2 * 60 * 60 * 1000L
  private const val MAX_LIFETIME_MS = 24 * 60 * 60 * 1000L
  private const val SEEN_ALERT_HISTORY = 64

  private fun prefs(context: Context): SharedPreferences =
    context.getSharedPreferences(STORE, Context.MODE_PRIVATE)

  @Synchronized
  fun configure(context: Context, deviceId: String, userId: String, ongoingEnabled: Boolean) {
    val prefs = prefs(context)
    // The WebView has no identity on a cold start, so the durable identity
    // lives here. Only a different identity clears cards and replay history.
    if (prefs.getString("userId", null) != userId || prefs.getString("deviceId", null) != deviceId) {
      clear(context)
    }
    val wasEnabled = prefs.getBoolean("ongoing", false)
    prefs.edit()
      .putString("deviceId", deviceId)
      .putString("userId", userId)
      .putBoolean("enabled", true)
      .putBoolean("ongoing", ongoingEnabled)
      .apply()
    if (ongoingEnabled && !wasEnabled) prefs.edit().putBoolean("dismissed", false).apply()
    if (!ongoingEnabled) cancelActivity(context)
    channels(context)
  }

  @Synchronized
  fun clear(context: Context) {
    cancelActivity(context)
    prefs(context).edit().clear().apply()
    val manager = manager(context)
    manager.activeNotifications.filter { it.tag == ACTIVITY_TAG || it.tag == ALERT_TAG }
      .forEach { manager.cancel(it.tag, it.id) }
  }

  /** True once `configure` stored an identity here; says nothing about any relay registration. */
  fun isConfigured(context: Context): Boolean = prefs(context).getBoolean("enabled", false)

  @Synchronized
  fun dismiss(context: Context) {
    prefs(context).edit().putBoolean("dismissed", true).apply()
    cancelActivity(context)
  }

  @Synchronized
  fun expire(context: Context, now: Long = System.currentTimeMillis()) {
    val expiresAt = prefs(context).getLong("expiresAt", 0)
    // An alarm dispatched for an earlier run must not remove a newer run's card.
    if (expiresAt in 1..now) cancelActivity(context)
  }

  @Synchronized
  fun receive(context: Context, data: Map<String, String>) {
    val prefs = prefs(context)
    val updatedAt = data["updated_at"]?.toLongOrNull() ?: return
    val registered = prefs.getBoolean("enabled", false) &&
      data["device_id"] == prefs.getString("deviceId", null) &&
      data["user_id"] == prefs.getString("userId", null)
    val fresh = System.currentTimeMillis() - updatedAt in -MAX_MESSAGE_AGE_MS..MAX_MESSAGE_AGE_MS
    if (registered && fresh && NotificationManagerCompat.from(context).areNotificationsEnabled()) {
      channels(context)
      showAlert(context, prefs, data)
      updateActivity(context, prefs, data, updatedAt)
    }
  }

  /**
   * Renders a payload without the registration, freshness and foreground
   * checks. Device verification only: it is not in the default permission set.
   */
  @Synchronized
  fun preview(context: Context, data: Map<String, String>) {
    channels(context)
    data["alert_id"]?.let { postAlert(context, data, it) }
    showActivity(context, data, data["active"] == "true", RUNNING_LIFETIME_MS)
  }

  private fun showAlert(context: Context, prefs: SharedPreferences, data: Map<String, String>) {
    // Delivery retries carry the same alert id. Keep a bounded, ordered
    // history so a retry of alert A after alert B is still recognised.
    val alertId = data["alert_id"] ?: return
    val seen = prefs.getString("seenAlerts", null)?.split('\n').orEmpty()
    if (alertId in seen) return
    // The open app shows its own in-app notice. Record the alert either way,
    // so a retry cannot surface it after the app is backgrounded.
    if (!ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
      postAlert(context, data, alertId)
    }
    prefs.edit().putString(
      "seenAlerts",
      (seen.takeLast(SEEN_ALERT_HISTORY - 1) + alertId).joinToString("\n")
    ).apply()
  }

  private fun postAlert(context: Context, data: Map<String, String>, alertId: String) {
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
    manager(context).notify(ALERT_TAG, id, notification)
  }

  private fun updateActivity(
    context: Context,
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
      cancelActivity(context)
      prefs.edit().putBoolean("dismissed", false).apply()
      return
    }
    // Dismissing a run includes its finished card. A new run arms it again;
    // replays of the finished state stay dismissed.
    if (active && !wasActive) prefs.edit().putBoolean("dismissed", false).apply()
    if (!prefs.getBoolean("dismissed", false)) {
      showActivity(context, data, active, remainingMs)
    }
  }

  private fun showActivity(
    context: Context,
    data: Map<String, String>,
    active: Boolean,
    remainingMs: Long
  ) {
    val dismissIntent = PendingIntent.getBroadcast(
      context,
      ACTIVITY_ID,
      Intent(context, AgentActivityDismissReceiver::class.java),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val model = ActivityModel(data, active)
    val open = openApp(context, ACTIVITY_ID)
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
    manager(context).notify(ACTIVITY_TAG, ACTIVITY_ID, builder.build())
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      // Notification timeouts arrived in API 26. One inexact alarm expires
      // the card on Android 7 even after the process exits, with no
      // exact-alarm permission, foreground service or periodic work.
      val expiresAt = System.currentTimeMillis() + remainingMs
      prefs(context).edit().putLong("expiresAt", expiresAt).apply()
      context.getSystemService(AlarmManager::class.java)
        .setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, expiresAt, expiryIntent(context))
    }
  }

  private fun expiryIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
    context,
    ACTIVITY_ID,
    Intent(context, AgentActivityExpiryReceiver::class.java),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
  )

  private fun cancelActivity(context: Context) {
    manager(context).cancel(ACTIVITY_TAG, ACTIVITY_ID)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      context.getSystemService(AlarmManager::class.java).cancel(expiryIntent(context))
      prefs(context).edit().remove("expiresAt").apply()
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

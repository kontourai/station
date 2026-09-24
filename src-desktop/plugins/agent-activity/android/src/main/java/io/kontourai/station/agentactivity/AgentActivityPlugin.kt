package io.kontourai.station.agentactivity

import android.app.Activity
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

@InvokeArg
class ConfigureArgs {
  lateinit var deviceId: String
  lateinit var userId: String
  var ongoingEnabled: Boolean = true
}

/**
 * The WebView's handle on native agent activity. Receipt and rendering do
 * not go through here — AgentMessagingService handles pushes with no
 * WebView — so this only registers identity and reports capability.
 */
@TauriPlugin
class AgentActivityPlugin(private val activity: Activity) : Plugin(activity) {
  private val context get() = activity.applicationContext

  private fun firebaseConfigured() = FirebaseApp.getApps(context).isNotEmpty()

  @Command
  fun status(invoke: Invoke) {
    val manager = context.getSystemService(NotificationManager::class.java)
    val result = JSObject()
    result.put("sdkInt", Build.VERSION.SDK_INT)
    result.put("notificationsEnabled", NotificationManagerCompat.from(context).areNotificationsEnabled())
    // Live Updates are Android 16 (API 36). The user can revoke promotion
    // per app, in which case cards still post but never become chips.
    result.put("liveUpdatesSupported", Build.VERSION.SDK_INT >= 36)
    result.put(
      "promotionAllowed",
      Build.VERSION.SDK_INT >= 36 && manager.canPostPromotedNotifications()
    )
    result.put("pushConfigured", firebaseConfigured())
    // Local identity only: whether any relay knows this device is not known here.
    result.put("configured", AgentNotifications.isConfigured(context))
    invoke.resolve(result)
  }

  @Command
  fun configure(invoke: Invoke) {
    val args = invoke.parseArgs(ConfigureArgs::class.java)
    if (args.deviceId.isBlank() || args.userId.isBlank()) {
      invoke.reject("deviceId and userId are required")
      return
    }
    AgentNotifications.configure(context, args.deviceId, args.userId, args.ongoingEnabled)
    invoke.resolve()
  }

  /**
   * The user's opt-out. Besides local state, undoes what pushToken enabled:
   * Firebase persists the auto-init flag over the manifest default, so
   * without this every later launch would still refresh a live token.
   */
  @Command
  fun clear(invoke: Invoke) {
    AgentNotifications.clear(context)
    if (!firebaseConfigured()) {
      invoke.resolve()
      return
    }
    try {
      val messaging = FirebaseMessaging.getInstance()
      messaging.isAutoInitEnabled = false
      messaging.deleteToken().addOnCompleteListener { task ->
        if (task.isSuccessful) invoke.resolve() else invoke.reject("push token not deleted", task.exception)
      }
    } catch (e: Exception) {
      invoke.reject("push token not deleted", e)
    }
  }

  @Command
  fun preview(invoke: Invoke) {
    val payload = invoke.getArgs().getJSObject("data")
    if (payload == null) {
      invoke.reject("data is required")
      return
    }
    val data = payload.keys().asSequence().associateWith { payload.getString(it) }
    AgentNotifications.preview(context, data)
    invoke.resolve()
  }

  @Command
  fun pushToken(invoke: Invoke) {
    if (!firebaseConfigured()) {
      // Not an error: this build carries no Firebase project, so there is
      // nothing to register. The caller must not report push as available.
      val result = JSObject()
      result.put("state", "unconfigured")
      invoke.resolve(result)
      return
    }
    val messaging = try {
      FirebaseMessaging.getInstance().also {
        // Auto-init is off in the manifest so an install does not contact
        // Google before the user asks for push. getToken works without it;
        // enabling it keeps the token refreshed at startup from now on,
        // until the `clear` command turns it off again.
        it.isAutoInitEnabled = true
      }
    } catch (e: Exception) {
      invoke.reject("push unavailable", e)
      return
    }
    // The listener runs on the main thread outside the plugin manager's
    // error handling: read `result` only after checking success, because
    // Task.getResult() throws on a failed task and would crash the app.
    messaging.token.addOnCompleteListener { task ->
      val token = if (task.isSuccessful) task.result else null
      if (token.isNullOrBlank()) {
        invoke.reject("push token unavailable", task.exception)
      } else {
        val result = JSObject()
        result.put("state", "available")
        result.put("token", token)
        invoke.resolve(result)
      }
    }
  }

  @Command
  fun openLiveUpdateSettings(invoke: Invoke) {
    val result = JSObject()
    if (Build.VERSION.SDK_INT < 36) {
      result.put("opened", false)
      invoke.resolve(result)
      return
    }
    val opened = try {
      activity.startActivity(
        Intent(Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS)
          .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
      )
      true
    } catch (_: ActivityNotFoundException) {
      false
    }
    result.put("opened", opened)
    invoke.resolve(result)
  }
}

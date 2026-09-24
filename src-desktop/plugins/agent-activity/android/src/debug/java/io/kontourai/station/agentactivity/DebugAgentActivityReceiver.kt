package io.kontourai.station.agentactivity

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Debug builds only (src/debug). Stands in for FCM so the push path can be
 * exercised on a device before a Firebase project exists, including against
 * a process that is not running:
 *
 *   adb shell am broadcast -n <package>/io.kontourai.station.agentactivity.DebugAgentActivityReceiver \
 *     -a io.kontourai.station.agentactivity.DEBUG_DELIVER --es mode preview \
 *     --es active true --es activity_phase running \
 *     --es activity_line_0 "$(printf 'Working\tFix the login bug\tstation')"
 *
 * Every string extra except `mode` becomes a payload field. `mode=preview`
 * renders unconditionally; `mode=receive` (the default) runs the same
 * registration and freshness checks as a real push, filling in
 * `updated_at` when it is absent.
 */
class DebugAgentActivityReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val extras = intent.extras ?: return
    val data = extras.keySet()
      .filter { it != "mode" }
      .mapNotNull { key -> extras.getString(key)?.let { key to it } }
      .toMap()
    if (intent.getStringExtra("mode") == "preview") {
      AgentNotifications.preview(context, data)
    } else {
      val stamped = if ("updated_at" in data) data else data + ("updated_at" to System.currentTimeMillis().toString())
      AgentNotifications.receive(context, stamped + ("station_kind" to AGENT_ACTIVITY_KIND))
    }
  }
}

package io.kontourai.station.agentactivity

import android.app.Activity
import android.os.SystemClock
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/** The process, rather than the replaceable WebViewClient, owns this window. */
internal class RendererRecoveryWindow {
  private val attempts = java.util.ArrayDeque<Long>()

  @Synchronized fun recover(now: Long, restart: () -> Unit, exhausted: () -> Unit) {
    while (attempts.isNotEmpty() && now - attempts.peekFirst() >= 60_000) attempts.removeFirst()
    if (attempts.size >= 3) exhausted() else {
      attempts.addLast(now)
      restart()
    }
  }

  @Synchronized fun reset() = attempts.clear()
}

object StationRendererRecovery {
  private val window = RendererRecoveryWindow()

  @JvmStatic fun recover(activity: Activity, view: WebView) {
    (view.parent as? ViewGroup)?.removeView(view)
    view.destroy()
    window.recover(SystemClock.elapsedRealtime(), {
      // Post after Wry has returned from the renderer-death callback.
      android.os.Handler(android.os.Looper.getMainLooper()).post {
        if (!activity.isFinishing && !activity.isDestroyed) activity.recreate()
      }
    }, {
      // Native widgets remain usable even when the renderer crashes on every load.
      val layout = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(32, 64, 32, 32)
        addView(TextView(activity).apply { text = "Station could not restore this screen." })
        addView(Button(activity).apply {
          text = "Reload"
          setOnClickListener {
            window.reset()
            activity.recreate()
          }
        })
      }
      activity.setContentView(layout)
    })
  }
}

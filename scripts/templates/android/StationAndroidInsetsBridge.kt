package __STATION_NAMESPACE__

import android.app.Activity
import android.os.Build
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

/** Native geometry only. Never exposes application data or input authority. */
class StationAndroidInsetsBridge(private val webView: WebView, private val activity: Activity) {
  @Volatile private var snapshot = "{}"

  @JavascriptInterface
  fun safeArea(): String = snapshot

  private fun publish(insets: WindowInsetsCompat) {
    val density = webView.resources.displayMetrics.density
    val bars = insets.getInsets(
      WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
    )
    val location = IntArray(2)
    webView.getLocationOnScreen(location)
    val bottom = location[1] + webView.height
    // Window bounds include insets even if the WebView already resized.
    // Subtracting IME height from the resized view would count it twice.
    val windowBottom = if (Build.VERSION.SDK_INT >= 30) activity.windowManager.currentWindowMetrics.bounds.bottom else null
    val visibleBottom = if (windowBottom != null && insets.isVisible(WindowInsetsCompat.Type.ime())) {
      minOf(bottom, windowBottom - insets.getInsets(WindowInsetsCompat.Type.ime()).bottom)
    } else bottom
    val next = JSONObject()
      .put("top", bars.top / density)
      .put("right", bars.right / density)
      .put("bottom", bars.bottom / density)
      .put("left", bars.left / density)
      .put("viewportWidth", webView.width / density)
      .put("viewportHeight", webView.height / density)
      .put("visibleHeight", (visibleBottom - location[1]).coerceIn(0, webView.height) / density)
      .toString()
    if (next == snapshot) return
    snapshot = next
    webView.post {
      webView.evaluateJavascript("window.dispatchEvent(new Event('station-android-insets'))", null)
    }
  }

  companion object {
    fun install(webView: WebView, activity: Activity) {
      val bridge = StationAndroidInsetsBridge(webView, activity)
      webView.addJavascriptInterface(bridge, "StationAndroidInsets")
      ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
        bridge.publish(insets)
        ViewCompat.onApplyWindowInsets(view, insets)
      }
      ViewCompat.setWindowInsetsAnimationCallback(webView,
        object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
          override fun onProgress(insets: WindowInsetsCompat, runningAnimations: MutableList<WindowInsetsAnimationCompat>): WindowInsetsCompat {
            bridge.publish(insets)
            return insets
          }
        }
      )
      webView.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
        ViewCompat.getRootWindowInsets(webView)?.let { bridge.publish(it) }
      }
      webView.post { ViewCompat.requestApplyInsets(webView) }
    }
  }
}

package __STATION_NAMESPACE__

import android.app.Activity
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.view.View
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
  @Volatile private var networkCostSnapshot = "unknown"
  private var dispatchPending = false

  @JavascriptInterface
  fun safeArea(): String = snapshot

  @JavascriptInterface
  fun networkCost(): String = networkCostSnapshot

  private fun observeNetwork() {
    val manager = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    fun refreshCost() {
      networkCostSnapshot = try {
        if (manager.isActiveNetworkMetered) "metered" else "unmetered"
      } catch (_: SecurityException) { "unknown" }
    }
    val callback = object : ConnectivityManager.NetworkCallback() {
      private fun changed() {
        io.kontourai.station.agentactivity.NativeHttpNetwork.changed()
        refreshCost()
        webView.post {
          webView.evaluateJavascript("window.dispatchEvent(new Event('station-network-cost-change'))", null)
        }
      }
      override fun onAvailable(network: Network) = changed()
      override fun onLost(network: Network) = changed()
      override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = changed()
    }
    var registered = false
    fun register() {
      if (registered) return
      try {
        manager.registerDefaultNetworkCallback(callback)
        registered = true
        refreshCost()
      } catch (_: SecurityException) { /* Older generated manifests may lack the permission. */ }
    }
    webView.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
      override fun onViewAttachedToWindow(view: View) = register()
      override fun onViewDetachedFromWindow(view: View) {
        if (registered) {
          manager.unregisterNetworkCallback(callback)
          registered = false
        }
      }
    })
    if (webView.isAttachedToWindow) register()
  }

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
    if (dispatchPending) return
    dispatchPending = true
    webView.postOnAnimation {
      dispatchPending = false
      webView.evaluateJavascript("window.dispatchEvent(new Event('station-android-insets'))", null)
    }
  }

  companion object {
    fun install(webView: WebView, activity: Activity) {
      val bridge = StationAndroidInsetsBridge(webView, activity)
      webView.addJavascriptInterface(bridge, "StationAndroidInsets")
      bridge.observeNetwork()
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

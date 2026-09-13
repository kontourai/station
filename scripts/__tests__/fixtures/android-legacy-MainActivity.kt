package io.kontourai.station

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import io.crates.keyring.Keyring

class MainActivity : TauriActivity() {
  // Android's WebView reports env(safe-area-inset-*) as 0 for system bars, so
  // an edge-to-edge activity must hand the WindowInsets to CSS itself
  // (station#2617). The web side reads this through the StationAndroidInsets
  // JavascriptInterface below; @JavascriptInterface methods run off the main
  // thread, hence the @Volatile snapshot instead of reading the view live.
  @Volatile
  private var safeAreaJson = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}"

  override fun onCreate(savedInstanceState: Bundle?) {
    Keyring.initializeNdkContext(applicationContext)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    webView.addJavascriptInterface(SafeAreaBridge(), "StationAndroidInsets")
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val density = view.resources.displayMetrics.density
      fun toDp(px: Int): Float = px / density
      safeAreaJson =
        "{\"top\":${toDp(bars.top)},\"right\":${toDp(bars.right)}," +
        "\"bottom\":${toDp(bars.bottom)},\"left\":${toDp(bars.left)}}"
      view.post {
        (view as? WebView)?.evaluateJavascript(
          "window.dispatchEvent(new Event('station-android-insets'))",
          null
        )
      }
      // Delegate to the view's own handling so keyboard/adjustResize
      // behavior is unchanged — this listener only observes.
      ViewCompat.onApplyWindowInsets(view, insets)
    }
    ViewCompat.requestApplyInsets(webView)
  }

  private inner class SafeAreaBridge {
    @JavascriptInterface
    fun safeArea(): String = safeAreaJson
  }
}

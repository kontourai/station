package io.kontourai.station

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onWebViewCreate(webView: WebView) {
    webView.setBackgroundColor(android.graphics.Color.TRANSPARENT)
    StationAndroidInsetsBridge.install(webView, this)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    window.setBackgroundDrawableResource(R.drawable.station_startup_background)
    super.onCreate(savedInstanceState)
  }


}

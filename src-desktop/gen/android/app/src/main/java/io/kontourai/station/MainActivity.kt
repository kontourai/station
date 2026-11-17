package io.kontourai.station

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import android.content.Intent
import io.kontourai.station.mediaintake.ShareIntentBuffer

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

  // STATION IMAGE SHARE BUFFER. AUTO-GENERATED. DO NOT REMOVE.
  // Tauri forwards a new intent only to plugins already loaded and never
  // updates the activity's intent. After process death a share can arrive
  // before the media-intake plugin loads, so keep it for that plugin.
  override fun onNewIntent(intent: Intent) {
    setIntent(intent)
    ShareIntentBuffer.offer(intent)
    super.onNewIntent(intent)
  }
  // STATION IMAGE SHARE BUFFER. AUTO-GENERATED. DO NOT REMOVE.
}

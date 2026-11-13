package io.kontourai.station.mediaintake

import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputContentInfo
import android.webkit.WebView
import java.util.WeakHashMap
import java.util.concurrent.atomic.AtomicBoolean

/** Wry's generated overrides call this; implementation stays in the maintained plugin. */
internal class ImageReadGrant(private val relinquish: () -> Unit = {}) {
  private val released = AtomicBoolean(false)
  private val handler = android.os.Handler(android.os.Looper.getMainLooper())
  private val timeout = Runnable { release() }
  fun begin() { handler.postDelayed(timeout, 30_000) }
  fun release() {
    handler.removeCallbacks(timeout)
    if (released.compareAndSet(false, true)) relinquish()
  }
}

object KeyboardImageIntake {
  internal var bind: ((WebView) -> Unit)? = null
  @JvmStatic fun attached(view: WebView) { bind?.invoke(view) }
  @JvmStatic fun detached(view: WebView) { uninstall(view) }

  internal fun appOrigin(url: String?): Boolean {
    val uri = url?.let(Uri::parse) ?: return false
    return uri.scheme == "http" && uri.host == "tauri.localhost" && uri.port == -1
  }

  private val receivers = WeakHashMap<WebView, (List<Uri>, ImageReadGrant) -> Unit>()

  internal fun install(view: WebView, receive: (List<Uri>, ImageReadGrant) -> Unit) {
    synchronized(receivers) { receivers[view] = receive }
  }

  internal fun uninstall(view: WebView) {
    synchronized(receivers) { receivers.remove(view) }
  }

  private fun receive(view: WebView, uris: List<Uri>, release: ImageReadGrant): Boolean {
    if (!appOrigin(view.url)) return false
    val receiver = synchronized(receivers) { receivers[view] } ?: return false
    // Chromium calls InputConnection on its IME thread. Only the handoff runs here.
    if (!view.post { receiver(uris, release) }) return false
    return true
  }

  @JvmStatic
  fun connection(view: WebView, original: InputConnection, info: EditorInfo): InputConnection {
    if (Build.VERSION.SDK_INT < 25 ||
        info.inputType and android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE == 0) return original
    val mimeTypes = arrayOf("image/png", "image/jpeg", "image/gif", "image/webp")
    info.contentMimeTypes = mimeTypes
    return object : InputConnectionWrapper(original, false) {
      override fun commitContent(content: InputContentInfo, flags: Int, opts: Bundle?): Boolean {
        if (!mimeTypes.any { content.description.hasMimeType(it) })
          return super.commitContent(content, flags, opts)
        val grant = flags and InputConnection.INPUT_CONTENT_GRANT_READ_URI_PERMISSION != 0
        try {
          if (grant) content.requestPermission()
        } catch (_: Exception) {
          return false
        }
        val release = ImageReadGrant { if (grant) content.releasePermission() }
        if (receive(view, listOf(content.contentUri), release)) return true
        release.release()
        return false
      }
    }
  }

  /** Chromium's selection-menu paste does not necessarily call the IME connection. */
  @JvmStatic
  fun actionMode(view: WebView, original: ActionMode.Callback): ActionMode.Callback =
    object : ActionMode.Callback2() {
      private var eligible = false
      private var alive = true
      private fun isPaste(item: MenuItem) = item.itemId == android.R.id.paste ||
        item.title?.toString() == view.context.getString(android.R.string.paste)
      private fun offerImagePaste(mode: ActionMode, menu: Menu): Boolean {
        if (!appOrigin(view.url)) return false
        val bridge = view.context.assets.open("station-image-paste.js").bufferedReader().use { it.readText() }
        view.evaluateJavascript("$bridge;window.__stationImagePaste?.eligible() === true") { result ->
          if (alive && eligible != (result == "true")) {
            eligible = result == "true"
            if (!eligible) menu.removeItem(android.R.id.paste)
            mode.invalidate()
          }
        }
        val clipboard = view.context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        if (!eligible || clipboard?.primaryClipDescription?.hasMimeType("image/*") != true) return false
        if ((0 until menu.size()).any { isPaste(menu.getItem(it)) }) return false
        menu.add(Menu.NONE, android.R.id.paste, Menu.NONE, android.R.string.paste)
        return true
      }
      override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
        val created = original.onCreateActionMode(mode, menu)
        if (created) offerImagePaste(mode, menu)
        return created
      }
      override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
        val prepared = original.onPrepareActionMode(mode, menu)
        val added = offerImagePaste(mode, menu)
        return prepared || added
      }
      override fun onDestroyActionMode(mode: ActionMode) { alive = false; original.onDestroyActionMode(mode) }
      override fun onGetContentRect(mode: ActionMode, target: android.view.View, rect: android.graphics.Rect) {
        if (original is ActionMode.Callback2) original.onGetContentRect(mode, target, rect)
        else super.onGetContentRect(mode, target, rect)
      }
      override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
        if (eligible && isPaste(item)) {
          val clipboard = view.context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
          val clip = clipboard?.primaryClip
          if (clip != null && clip.description.hasMimeType("image/*")) {
            val uris = try { clipboardImageUris(view.context, clip) } catch (_: Exception) { emptyList() }
            if (uris.isNotEmpty() && receive(view, uris, ImageReadGrant())) {
              mode.finish()
              return true
            }
          }
        }
        return original.onActionItemClicked(mode, item)
      }
    }
}

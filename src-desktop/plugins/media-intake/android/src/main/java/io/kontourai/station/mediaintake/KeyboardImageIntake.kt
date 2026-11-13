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
object KeyboardImageIntake {
  private val receivers = WeakHashMap<WebView, (List<Uri>, () -> Unit) -> Unit>()

  internal fun install(view: WebView, receive: (List<Uri>, () -> Unit) -> Unit) {
    synchronized(receivers) { receivers[view] = receive }
  }

  internal fun uninstall(view: WebView) {
    synchronized(receivers) { receivers.remove(view) }
  }

  private fun receive(view: WebView, uris: List<Uri>, release: () -> Unit): Boolean {
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
        val released = AtomicBoolean(false)
        val timeout = Runnable { if (grant && released.compareAndSet(false, true)) content.releasePermission() }
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        handler.postDelayed(timeout, 30_000)
        val release = {
          handler.removeCallbacks(timeout)
          timeout.run()
        }
        if (receive(view, listOf(content.contentUri), release)) return true
        release()
        return false
      }
    }
  }

  /** Chromium's selection-menu paste does not necessarily call the IME connection. */
  @JvmStatic
  fun actionMode(view: WebView, original: ActionMode.Callback): ActionMode.Callback =
    object : ActionMode.Callback2() {
      private fun offerImagePaste(menu: Menu) {
        val clipboard = view.context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        if (clipboard?.primaryClipDescription?.hasMimeType("image/*") == true && menu.findItem(android.R.id.paste) == null)
          menu.add(Menu.NONE, android.R.id.paste, Menu.NONE, android.R.string.paste)
      }
      override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
        val created = original.onCreateActionMode(mode, menu)
        if (created) offerImagePaste(menu)
        return created
      }
      override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
        val prepared = original.onPrepareActionMode(mode, menu)
        offerImagePaste(menu)
        return prepared
      }
      override fun onDestroyActionMode(mode: ActionMode) = original.onDestroyActionMode(mode)
      override fun onGetContentRect(mode: ActionMode, target: android.view.View, rect: android.graphics.Rect) {
        if (original is ActionMode.Callback2) original.onGetContentRect(mode, target, rect)
        else super.onGetContentRect(mode, target, rect)
      }
      override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
        if (item.itemId == android.R.id.paste) {
          val clipboard = view.context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
          val clip = clipboard?.primaryClip
          if (clip != null && clip.description.hasMimeType("image/*")) {
            val uris = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
            if (uris.isNotEmpty() && receive(view, uris) {}) {
              mode.finish()
              return true
            }
          }
        }
        return original.onActionItemClicked(mode, item)
      }
    }
}

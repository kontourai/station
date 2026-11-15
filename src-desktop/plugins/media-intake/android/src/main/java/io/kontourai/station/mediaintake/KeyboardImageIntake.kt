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

/** Recheck inside the JS world too: navigation can race native WebView.url. */
internal fun appScript(script: String): String =
  "if (location.origin === 'http://tauri.localhost') { $script }"

internal class ImageReadGrant(private val relinquish: () -> Unit = {}) {
  private val released = AtomicBoolean(false)
  private val handler = android.os.Handler(android.os.Looper.getMainLooper())
  private val timeout = Runnable { release() }
  init { handler.postDelayed(timeout, 30_000) }
  internal val isReleased get() = released.get()
  fun release() {
    handler.removeCallbacks(timeout)
    if (released.compareAndSet(false, true)) relinquish()
  }
}

/** Wry's generated overrides call this; implementation stays in the maintained plugin. */
object KeyboardImageIntake {
  internal var bind: ((WebView) -> Unit)? = null
  @JvmStatic fun attached(view: WebView) { bind?.invoke(view) }
  @JvmStatic fun detached(view: WebView) { uninstall(view) }

  internal fun appOrigin(url: String?): Boolean {
    val uri = url?.let(Uri::parse) ?: return false
    return uri.scheme == "http" && uri.host == "tauri.localhost" && uri.port == -1
  }

  private val pending = WeakHashMap<WebView, MutableSet<ImageReadGrant>>()
  private val receivers = WeakHashMap<WebView, (List<Uri>, ImageReadGrant) -> Unit>()

  internal fun install(view: WebView, receive: (List<Uri>, ImageReadGrant) -> Unit) {
    synchronized(receivers) { receivers[view] = receive }
  }

  internal fun uninstall(view: WebView) {
    val grants = synchronized(receivers) {
      receivers.remove(view)
      pending.remove(view)?.toList().orEmpty()
    }
    grants.forEach { it.release() }
  }

  private fun receive(view: WebView, uris: List<Uri>, release: ImageReadGrant): Boolean {
    val receiver = synchronized(receivers) {
      val receiver = receivers[view] ?: return false
      pending.getOrPut(view) { mutableSetOf() }.apply {
        removeAll { it.isReleased }
        add(release)
      }
      receiver
    }
    // Chromium calls InputConnection on its IME thread. Only the handoff runs here.
    if (!view.post {
      val current = synchronized(receivers) { receivers[view] === receiver }
      if (!current || release.isReleased || !appOrigin(view.url)) release.release()
      else receiver(uris, release)
    }) return false
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
      private var imagePasteItem: MenuItem? = null
      private val imagePasteId = android.view.View.generateViewId()
      private fun removeImagePaste(menu: Menu): Boolean {
        val removed = imagePasteItem != null
        imagePasteItem?.let { if (menu.findItem(it.itemId) === it) menu.removeItem(it.itemId) }
        imagePasteItem = null
        return removed
      }
      // Chromium now uses the framework id. Older providers expose this resource name.
      // Never identify an action by translated display text.
      private fun isPaste(item: MenuItem): Boolean {
        if (item === imagePasteItem) return false
        if (item.itemId == android.R.id.paste) return true
        return try {
          view.context.resources.getResourceEntryName(item.itemId) == "select_action_menu_paste"
        } catch (_: android.content.res.Resources.NotFoundException) { false }
      }
      private fun offerImagePaste(mode: ActionMode, menu: Menu): Boolean {
        if (!appOrigin(view.url)) return removeImagePaste(menu)
        val bridge = view.context.assets.open("station-image-paste.js").bufferedReader().use { it.readText() }
        view.evaluateJavascript(appScript("$bridge;window.__stationImagePaste?.eligible() === true")) { result ->
          if (alive && eligible != (result == "true")) {
            eligible = result == "true"
            if (!eligible) removeImagePaste(menu)
            mode.invalidate()
          }
        }
        val clipboard = view.context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        if (!eligible || clipboard?.primaryClipDescription?.hasMimeType("image/*") != true ||
            (0 until menu.size()).any { isPaste(menu.getItem(it)) }) return removeImagePaste(menu)
        // Trust the saved item only while it is still in this menu; a provider may rebuild it.
        if (imagePasteItem != null && menu.findItem(imagePasteId) === imagePasteItem) return false
        imagePasteItem = menu.add(Menu.NONE, imagePasteId, Menu.NONE, android.R.string.paste)
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
        val ownItem = item.itemId == imagePasteId
        if (eligible && (ownItem || isPaste(item))) {
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
        if (ownItem) { mode.invalidate(); return true }
        return original.onActionItemClicked(mode, item)
      }
    }
}

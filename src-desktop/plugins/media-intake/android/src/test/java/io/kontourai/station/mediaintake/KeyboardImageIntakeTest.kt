package io.kontourai.station.mediaintake

import android.content.ClipDescription
import android.net.Uri
import android.os.Looper
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputContentInfo
import android.webkit.WebView
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class KeyboardImageIntakeTest {
  @Test fun keyboardCommitReachesTheInstalledReceiver() {
    val activity = org.robolectric.Robolectric.buildActivity(android.app.Activity::class.java).setup().get()
    val view = WebView(activity)
    activity.setContentView(view)
    view.loadUrl("http://tauri.localhost/")
    val info = EditorInfo().apply { inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE }
    var received = emptyList<Uri>()
    KeyboardImageIntake.install(view) { uris, release -> received = uris; release.release() }
    val connection = KeyboardImageIntake.connection(view, BaseInputConnection(view, false), info)
    assertTrue(info.contentMimeTypes?.contains("image/png") == true)
    val uri = Uri.parse("content://keyboard.example/image/1")
    val content = InputContentInfo(uri, ClipDescription("image", arrayOf("image/png")), null)
    assertTrue(connection.commitContent(content, 0, null))
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(listOf(uri), received)
    KeyboardImageIntake.uninstall(view)
    assertFalse(connection.commitContent(content, 0, null))
  }

  @Test fun unrelatedContentFallsBackToOriginalConnection() {
    val activity = org.robolectric.Robolectric.buildActivity(android.app.Activity::class.java).setup().get()
    val view = WebView(activity)
    activity.setContentView(view)
    view.loadUrl("http://tauri.localhost/")
    var delegated = false
    val original = object : BaseInputConnection(view, false) {
      override fun commitContent(content: InputContentInfo, flags: Int, opts: android.os.Bundle?): Boolean {
        delegated = true
        return true
      }
    }
    val connection = KeyboardImageIntake.connection(view, original, EditorInfo().apply { inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE })
    val content = InputContentInfo(Uri.parse("content://keyboard.example/text"), ClipDescription("text", arrayOf("text/plain")), null)
    assertTrue(connection.commitContent(content, 0, null))
    assertTrue(delegated)
  }
  @Test fun systemPasteMenuRoutesImagesAndKeepsTextPaste() {
    val activity = org.robolectric.Robolectric.buildActivity(android.app.Activity::class.java).setup().get()
    val view = object : WebView(activity) {
      var eligible = false
      override fun evaluateJavascript(script: String, callback: android.webkit.ValueCallback<String>?) { callback?.onReceiveValue(eligible.toString()) }
    }
    activity.setContentView(view)
    view.loadUrl("http://tauri.localhost/")
    val menu = android.widget.PopupMenu(view.context, view).menu
    val clipboard = view.context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
    val uri = Uri.parse("content://keyboard.example/image/2")
    org.robolectric.shadows.ShadowContentResolver.registerProviderInternal("keyboard.example", object : android.content.ContentProvider() {
      override fun onCreate() = true
      override fun getType(uri: Uri) = if (uri.path?.endsWith(".pdf") == true) "application/pdf" else "image/png"
      override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, order: String?) : android.database.Cursor? = null
      override fun insert(uri: Uri, values: android.content.ContentValues?): Uri? = null
      override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
      override fun update(uri: Uri, values: android.content.ContentValues?, selection: String?, args: Array<out String>?) = 0
    })
    val mixed = android.content.ClipData(ClipDescription("image and PDF", arrayOf("image/png", "application/pdf")), android.content.ClipData.Item(uri))
    mixed.addItem(android.content.ClipData.Item(Uri.parse("content://keyboard.example/document.pdf")))
    clipboard.setPrimaryClip(mixed)
    var delegated = false
    var received = emptyList<Uri>()
    KeyboardImageIntake.install(view) { uris, release -> received = uris; release.release() }
    val callback = KeyboardImageIntake.actionMode(view, object : android.view.ActionMode.Callback {
      override fun onCreateActionMode(mode: android.view.ActionMode, menu: android.view.Menu) = true
      override fun onPrepareActionMode(mode: android.view.ActionMode, menu: android.view.Menu) = false
      override fun onDestroyActionMode(mode: android.view.ActionMode) {}
      override fun onActionItemClicked(mode: android.view.ActionMode, item: android.view.MenuItem): Boolean { delegated = true; return true }
    })
    val mode = object : android.view.ActionMode() {
      override fun setTitle(title: CharSequence?) {}
      override fun setTitle(resId: Int) {}
      override fun setSubtitle(title: CharSequence?) {}
      override fun setSubtitle(resId: Int) {}
      override fun setCustomView(view: android.view.View?) {}
      override fun invalidate() {}
      override fun finish() {}
      override fun getMenu() = menu
      override fun getTitle(): CharSequence = ""
      override fun getSubtitle(): CharSequence = ""
      override fun getCustomView(): android.view.View? = null
      override fun getMenuInflater() = android.view.MenuInflater(view.context)
    }
    assertTrue(callback.onCreateActionMode(mode, menu))
    assertEquals(0, menu.size())
    view.eligible = true
    assertTrue(callback.onPrepareActionMode(mode, menu))
    assertFalse(callback.onPrepareActionMode(mode, menu))
    menu.clear() // a provider that rebuilds its menu must not lose our item for good
    assertTrue(callback.onPrepareActionMode(mode, menu))
    assertEquals(1, menu.size())
    val paste = menu.getItem(0)
    assertNotNull(paste)
    assertTrue(callback.onActionItemClicked(mode, paste))
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(listOf(uri), received)
    assertFalse(delegated)
    clipboard.setPrimaryClip(android.content.ClipData.newPlainText("text", "hello"))
    menu.add(0, android.R.id.paste, 0, "Coller") // framework id, arbitrary locale
    assertTrue(callback.onPrepareActionMode(mode, menu))
    assertEquals(1, menu.size())
    clipboard.setPrimaryClip(android.content.ClipData.newPlainText("text", "hello"))
    assertTrue(callback.onActionItemClicked(mode, paste))
    assertFalse(delegated) // even a stale click on our item never goes to Chromium
    assertTrue(callback.onActionItemClicked(mode, menu.findItem(android.R.id.paste)))
    assertTrue(delegated)
    KeyboardImageIntake.uninstall(view)
  }

  @Test fun foreignOriginsCannotReceiveImages() {
    val activity = org.robolectric.Robolectric.buildActivity(android.app.Activity::class.java).setup().get()
    val view = WebView(activity)
    activity.setContentView(view)
    view.loadUrl("https://example.com/")
    KeyboardImageIntake.install(view) { _, _ -> fail("foreign origin received content") }
    val connection = KeyboardImageIntake.connection(view, BaseInputConnection(view, false), EditorInfo().apply { inputType = android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE })
    assertTrue(connection.commitContent(InputContentInfo(Uri.parse("content://keyboard/image"), ClipDescription("image", arrayOf("image/png")), null), 0, null))
    shadowOf(Looper.getMainLooper()).idle()
    assertFalse(KeyboardImageIntake.appOrigin("http://tauri.localhost.attacker/"))
    assertFalse(KeyboardImageIntake.appOrigin("https://tauri.localhost/"))
    KeyboardImageIntake.uninstall(view)
  }

  @Test fun grantTimeoutBoundsCaptureAndQueuedRead() {
    var releases = 0
    val grant = ImageReadGrant { releases++ }
    shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(31))

    assertEquals(1, releases)
    grant.release()
    assertEquals(1, releases)
  }

  @Test fun destroyRecreateKeepsCommandsAndKeyboardReadsAlive() {
    val old = org.robolectric.Robolectric.buildActivity(androidx.appcompat.app.AppCompatActivity::class.java).get()
    val plugin = MediaIntakePlugin(old)
    val first = WebView(old)
    plugin.load(first)
    plugin.onDestroy(old)
    val next = org.robolectric.Robolectric.buildActivity(android.app.Activity::class.java).setup().get()
    val scripts = mutableListOf<String>()
    val view = object : WebView(next) {
      override fun evaluateJavascript(script: String, callback: android.webkit.ValueCallback<String>?) {
        scripts.add(script)
        callback?.onReceiveValue("true")
      }
    }
    next.setContentView(view)
    view.loadUrl("http://tauri.localhost/")
    KeyboardImageIntake.attached(view) // the generated override's lifecycle seam
    val responses = mutableListOf<String>()
    val invoke = app.tauri.plugin.Invoke(1L, "readClipboardImages", 2L, 3L, { _, data -> responses.add(data) }, "{}", com.fasterxml.jackson.databind.ObjectMapper())
    plugin.readClipboardImages(invoke)
    val executor = MediaIntakePlugin::class.java.getDeclaredField("reads").apply { isAccessible = true }.get(plugin) as java.util.concurrent.ExecutorService
    executor.submit {}.get(5, java.util.concurrent.TimeUnit.SECONDS)
    assertEquals(1, responses.size)
    assertTrue(responses[0].contains("files"))
    var releases = 0
    // Invalid source reaches the actual capture -> queued read -> cancel/finally path.
    val receive = KeyboardImageIntake::class.java.getDeclaredField("receivers").apply { isAccessible = true }.get(KeyboardImageIntake) as Map<WebView, (List<Uri>, ImageReadGrant) -> Unit>
    receive[view]!!(listOf(Uri.parse("file:///refused")), ImageReadGrant { releases++ })
    executor.submit {}.get(5, java.util.concurrent.TimeUnit.SECONDS)
    shadowOf(Looper.getMainLooper()).idle()
    assertTrue(scripts.any { it.contains(".capture(") })
    assertTrue(scripts.any { it.contains(".cancel(") })
    assertEquals(1, releases)
    org.robolectric.shadows.ShadowContentResolver.registerProviderInternal("keyboard.example", object : android.content.ContentProvider() {
      override fun onCreate() = true
      override fun getType(uri: Uri) = if (uri.path?.endsWith(".pdf") == true) "application/pdf" else "image/png"
      override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, order: String?) : android.database.Cursor? = null
      override fun insert(uri: Uri, values: android.content.ContentValues?): Uri? = null
      override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
      override fun update(uri: Uri, values: android.content.ContentValues?, selection: String?, args: Array<out String>?) = 0
    })
    val uri = Uri.parse("content://keyboard.example/image/success")
    shadowOf(next.contentResolver).registerInputStream(uri, java.io.ByteArrayInputStream(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d)))
    receive[view]!!(listOf(uri), ImageReadGrant { releases++ })
    executor.submit {}.get(5, java.util.concurrent.TimeUnit.SECONDS)
    shadowOf(Looper.getMainLooper()).idle()
    assertTrue(scripts.last() + " toast=" + org.robolectric.shadows.ShadowToast.getTextOfLatestToast(), scripts.any { it.contains(".deliver(") && it.contains("pasted-image-1.png") })
    assertEquals(2, releases)
    assertTrue(scripts.all { it.startsWith("if (location.origin === 'http://tauri.localhost') {") })
    shadowOf(next.contentResolver).registerInputStream(uri, java.io.ByteArrayInputStream(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)))
    @Suppress("UNCHECKED_CAST")
    val session = MediaIntakePlugin::class.java.getDeclaredField("session").apply { isAccessible = true }.get(plugin) as ShareIntakeSession<Uri>
    session.onNewIntent(IntentFacts(android.content.Intent.ACTION_SEND, "image/png", false) { uri to null })
    plugin.takeSharedImages(invoke)
    executor.submit {}.get(5, java.util.concurrent.TimeUnit.SECONDS)
    assertEquals(2, responses.size)
    assertEquals("image/png", org.json.JSONObject(responses[1]).getJSONArray("files").getJSONObject(0).getString("mimeType"))
    KeyboardImageIntake.detached(view)
    KeyboardImageIntake.bind = null
  }

  @Test fun generatedWryViewRebindsOnAttachAndDetaches() {
    val activity = org.robolectric.Robolectric.buildActivity(android.app.Activity::class.java).setup().get()
    var bound: WebView? = null
    KeyboardImageIntake.bind = { view ->
      bound = view
      KeyboardImageIntake.install(view) { _, grant -> grant.release() }
    }
    val view = station.hookcheck.RustWebView(activity, emptyArray(), "hook-check")
    activity.setContentView(view)
    assertSame(view, bound)
    view.loadUrl("http://tauri.localhost/")
    val info = EditorInfo()
    val connection = view.onCreateInputConnection(info)
    assertNotSame(view.originalConnection, connection)
    assertTrue(info.contentMimeTypes?.contains("image/png") == true)
    val original = object : android.view.ActionMode.Callback {
      override fun onCreateActionMode(mode: android.view.ActionMode, menu: android.view.Menu) = true
      override fun onPrepareActionMode(mode: android.view.ActionMode, menu: android.view.Menu) = false
      override fun onDestroyActionMode(mode: android.view.ActionMode) {}
      override fun onActionItemClicked(mode: android.view.ActionMode, item: android.view.MenuItem) = false
    }
    view.startActionMode(original, android.view.ActionMode.TYPE_FLOATING)
    assertNotNull(view.actionCallback)
    assertNotSame(original, view.actionCallback)
    KeyboardImageIntake.detached(view)
    KeyboardImageIntake.bind = null
  }

  @Test fun keyboardCommitFromImeThreadNeverReadsWebViewState() {
    val activity = org.robolectric.Robolectric.buildActivity(android.app.Activity::class.java).setup().get()
    val view = object : WebView(activity) {
      override fun getUrl(): String? {
        check(Looper.myLooper() === Looper.getMainLooper()) { "WebView accessed from IME thread" }
        return super.getUrl()
      }
    }
    activity.setContentView(view)
    view.loadUrl("http://tauri.localhost/")
    var received = false
    KeyboardImageIntake.install(view) { _, grant -> received = true; grant.release() }
    val connection = KeyboardImageIntake.connection(view, BaseInputConnection(view, false), EditorInfo().apply {
      inputType = android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
    })
    val thread = android.os.HandlerThread("test-ime").apply { start() }
    val result = java.util.concurrent.FutureTask<Boolean> {
      check(Looper.myLooper() !== Looper.getMainLooper())
      connection.commitContent(InputContentInfo(Uri.parse("content://keyboard/image"), ClipDescription("image", arrayOf("image/png")), null), 0, null)
    }
    try {
      android.os.Handler(thread.looper).post(result)
      assertTrue(result.get(5, java.util.concurrent.TimeUnit.SECONDS))
      shadowOf(Looper.getMainLooper()).idle()
      assertTrue(received)
    } finally { thread.quitSafely(); thread.join(5000); KeyboardImageIntake.uninstall(view) }
  }

  @Test fun detachReleasesPendingGrantBeforeCapture() {
    val activity = org.robolectric.Robolectric.buildActivity(android.app.Activity::class.java).setup().get()
    val view = WebView(activity)
    activity.setContentView(view)
    view.loadUrl("http://tauri.localhost/")
    KeyboardImageIntake.install(view) { _, _ -> fail("detached receiver ran") }
    // Hold the posted callback, as happens when a view is detached before dispatch.
    val grant = ImageReadGrant()
    val method = KeyboardImageIntake::class.java.getDeclaredMethod("receive", WebView::class.java, List::class.java, ImageReadGrant::class.java).apply { isAccessible = true }
    assertEquals(true, method.invoke(KeyboardImageIntake, view, listOf(Uri.parse("content://keyboard/image")), grant))
    KeyboardImageIntake.detached(view)
    assertTrue(grant.isReleased)
    shadowOf(Looper.getMainLooper()).idle()
  }

  @Test fun activityContextCanBeWrapped() {
    val activity = org.robolectric.Robolectric.buildActivity(android.app.Activity::class.java).setup().get()
    assertSame(activity, owningActivity(android.content.ContextWrapper(android.content.ContextWrapper(activity))))
    assertNull(owningActivity(activity.applicationContext))
  }

}

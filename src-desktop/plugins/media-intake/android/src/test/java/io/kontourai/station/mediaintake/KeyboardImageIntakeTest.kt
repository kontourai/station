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
    val info = EditorInfo().apply { inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE }
    var received = emptyList<Uri>()
    KeyboardImageIntake.install(view) { uris, release -> received = uris; release() }
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
    val view = WebView(activity)
    activity.setContentView(view)
    val menu = android.widget.PopupMenu(view.context, view).menu
    val clipboard = view.context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
    val uri = Uri.parse("content://keyboard.example/image/2")
    clipboard.setPrimaryClip(android.content.ClipData(ClipDescription("image", arrayOf("image/png")), android.content.ClipData.Item(uri)))
    var delegated = false
    var received = emptyList<Uri>()
    KeyboardImageIntake.install(view) { uris, release -> received = uris; release() }
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
    val paste = menu.findItem(android.R.id.paste)
    assertNotNull(paste)
    assertTrue(callback.onActionItemClicked(mode, paste))
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(listOf(uri), received)
    assertFalse(delegated)
    clipboard.setPrimaryClip(android.content.ClipData.newPlainText("text", "hello"))
    assertTrue(callback.onActionItemClicked(mode, paste))
    assertTrue(delegated)
    KeyboardImageIntake.uninstall(view)
  }

}

package io.kontourai.station.mediaintake

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.concurrent.Executors

internal const val SHARED_IMAGES_EVENT = "sharedImages"

/**
 * Clipboard image reads and the image share target. Both commands resolve
 * `{ files: [{ name, mimeType, dataUrl }] }` through [readIntakeImages], or
 * reject with a message the web layer shows.
 *
 * The share follows the agent-activity launch-route pattern: `load` adopts
 * the intent that started the app, `onNewIntent` adopts one that arrives
 * while it runs and triggers [SHARED_IMAGES_EVENT], and
 * [takeSharedImages] returns the pending share once. Only the URIs are kept
 * until then; reading waits for the take so a cold start never blocks on a
 * content provider.
 */
@TauriPlugin
class MediaIntakePlugin(private val activity: Activity) : Plugin(activity) {
  private val reads = Executors.newSingleThreadExecutor()
  private val lock = Any()

  /** The latest share's URIs, or why it was refused, until taken. */
  private var pendingUris: List<Uri>? = null
  private var pendingRefusal: String? = null

  override fun load(webView: WebView) {
    adoptShare(activity.intent)
  }

  override fun onNewIntent(intent: Intent) {
    if (adoptShare(intent)) trigger(SHARED_IMAGES_EVENT, JSObject())
  }

  /**
   * Keeps an image share's streams. A share relaunched from Recents (which
   * Android restores with the original intent) is ignored, and the stream
   * extra is removed so a later `load` in this process does not adopt it
   * again. A newer share replaces an untaken one.
   */
  private fun adoptShare(intent: Intent?): Boolean {
    if (intent == null) return false
    if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return false
    val uris = sharedImageStreams(intent.action, intent.type, streamExtra(intent), streamListExtra(intent))
    if (uris.isEmpty()) return false
    intent.removeExtra(Intent.EXTRA_STREAM)
    synchronized(lock) {
      if (uris.size > MAX_IMAGE_COUNT) {
        pendingUris = null
        pendingRefusal = "Station can take at most $MAX_IMAGE_COUNT images at once."
      } else {
        pendingUris = uris
        pendingRefusal = null
      }
    }
    return true
  }

  @Suppress("DEPRECATION")
  private fun streamExtra(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri

  @Suppress("DEPRECATION")
  private fun streamListExtra(intent: Intent): List<Uri?>? =
    if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)

  /** Returns and clears the pending share: `{ files: [] }` when there is none. */
  @Command
  fun takeSharedImages(invoke: Invoke) {
    val (uris, refusal) = synchronized(lock) {
      val taken = pendingUris to pendingRefusal
      pendingUris = null
      pendingRefusal = null
      taken
    }
    when {
      refusal != null -> invoke.reject(refusal)
      uris == null -> invoke.resolve(filesResult(emptyList()))
      else -> readOffMainThread(invoke, "shared-image") { uris }
    }
  }

  /** The clipboard's image items; `{ files: [] }` when it holds none. */
  @Command
  fun readClipboardImages(invoke: Invoke) {
    readOffMainThread(invoke, "pasted-image") {
      val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
      val clip = clipboard?.primaryClip
      if (clip == null) {
        emptyList()
      } else {
        val clipIsImage = (0 until clip.description.mimeTypeCount)
          .any { clip.description.getMimeType(it).lowercase().startsWith("image/") }
        (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }.filter { uri ->
          clipIsImage || activity.contentResolver.getType(uri)?.lowercase()?.startsWith("image/") == true
        }
      }
    }
  }

  private fun readOffMainThread(invoke: Invoke, prefix: String, sources: () -> List<Uri>) {
    reads.execute {
      try {
        val resolver = activity.contentResolver
        val images = readIntakeImages(
          sources(),
          prefix,
          open = { resolver.openInputStream(it) },
          displayName = { uri ->
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
              if (cursor.moveToFirst()) cursor.getString(0) else null
            }
          },
          encodeBase64 = { Base64.encodeToString(it, Base64.NO_WRAP) },
        )
        invoke.resolve(filesResult(images))
      } catch (refused: IntakeRefused) {
        invoke.reject(refused.message)
      } catch (error: Exception) {
        invoke.reject("Station could not read the images.")
      }
    }
  }

  private fun filesResult(images: List<IntakeImage>): JSObject {
    val files = JSArray()
    for (image in images) {
      val file = JSObject()
      file.put("name", image.name)
      file.put("mimeType", image.mimeType)
      file.put("dataUrl", image.dataUrl)
      files.put(file)
    }
    val result = JSObject()
    result.put("files", files)
    return result
  }
}

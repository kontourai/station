package io.kontourai.station.mediaintake

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.provider.Settings
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
private const val TAKEN_PREFERENCES = "station_media_intake"
private const val TAKEN_KEYS = "taken_shares"

/**
 * Clipboard image reads and the image share target. Both commands resolve
 * `{ files: [{ name, mimeType, dataUrl }] }` through [IntakeSources], or
 * reject with a message the web layer shows.
 *
 * The share follows the agent-activity launch-route pattern: `load` adopts
 * the intent that started the app (or a share MainActivity buffered before
 * this plugin loaded), `onNewIntent` adopts one that arrives while it runs and
 * triggers [SHARED_IMAGES_EVENT], and [takeSharedImages] returns the pending
 * share once. Every decision lives in [ShareIntakeSession] and
 * [IntakeSources]; this class only turns Android types into their inputs.
 */
@TauriPlugin
class MediaIntakePlugin(private val activity: Activity) : Plugin(activity) {
  private val reads = Executors.newSingleThreadExecutor()

  private val session = ShareIntakeSession<Uri>(
    taken = object : TakenShares {
      private val store get() = activity.getSharedPreferences(TAKEN_PREFERENCES, Context.MODE_PRIVATE)
      override fun keys() = store.getString(TAKEN_KEYS, null)?.split('\n')?.filter { it.isNotEmpty() } ?: emptyList()
      override fun save(keys: List<String>) {
        store.edit().putString(TAKEN_KEYS, keys.joinToString("\n")).apply()
      }
    },
    bootCount = ::bootCount,
    taskId = { activity.taskId },
    describe = { it.toString() },
  )

  private val sources = IntakeSources<Uri>(
    ownAuthorities = {
      @Suppress("DEPRECATION")
      val info = activity.packageManager.getPackageInfo(activity.packageName, PackageManager.GET_PROVIDERS)
      info.providers.orEmpty().flatMap { it.authority.orEmpty().split(';') }.filter { it.isNotBlank() }.toSet()
    },
    scheme = { it.scheme },
    authority = { it.authority },
  )

  /** -1 when the platform will not say; a share then keys on its task alone. */
  private fun bootCount(): Int =
    try {
      Settings.Global.getInt(activity.contentResolver, Settings.Global.BOOT_COUNT, -1)
    } catch (_: Exception) {
      -1
    }

  override fun load(webView: WebView) {
    session.onLoad(activity.intent?.let(::facts), ShareIntentBuffer.intents.take()?.let(::facts))
  }

  override fun onNewIntent(intent: Intent) {
    // MainActivity buffered this same intent before Tauri forwarded it here;
    // one `load` already drained is not adopted twice.
    if (deliverNewIntent(ShareIntentBuffer.intents, intent) { session.onNewIntent(facts(it)) }) {
      trigger(SHARED_IMAGES_EVENT, JSObject())
    }
  }

  private fun facts(intent: Intent) = IntentFacts(
    intent.action,
    intent.type,
    (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0,
  ) { streamExtra(intent) to streamListExtra(intent) }

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
    when (val share = session.take()) {
      is PendingShare.None -> invoke.resolve(filesResult(emptyList()))
      is PendingShare.Refused -> invoke.reject(share.message)
      is PendingShare.Streams -> readOffMainThread(invoke, "shared-image") { share.streams }
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
        sources.clipboardItems(
          (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri },
          { activity.contentResolver.getType(it) },
          (0 until clip.description.mimeTypeCount).map { clip.description.getMimeType(it) },
        )
      }
    }
  }

  private fun readOffMainThread(invoke: Invoke, prefix: String, uris: () -> List<Uri>) {
    reads.execute {
      try {
        val resolver = activity.contentResolver
        val images = sources.read(
          uris(),
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

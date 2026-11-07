package io.kontourai.station.mediaintake

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
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
private const val TAKEN_PREFERENCES = "station_media_intake"
private const val TAKEN_KEYS = "taken_shares"

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
 * content provider. Every decision is [shareDecision]; a taken share's key is
 * remembered across processes so a restored launch intent is not replayed.
 */
@TauriPlugin
class MediaIntakePlugin(private val activity: Activity) : Plugin(activity) {
  private val reads = Executors.newSingleThreadExecutor()
  private val lock = Any()

  /** The latest share's URIs, or why it was refused, until taken. */
  private var pendingUris: List<Uri>? = null
  private var pendingRefusal: String? = null
  private var pendingKey: String? = null

  private val takenStore get() = activity.getSharedPreferences(TAKEN_PREFERENCES, Context.MODE_PRIVATE)

  private fun takenKeys(): List<String> =
    takenStore.getString(TAKEN_KEYS, null)?.split('\n')?.filter { it.isNotEmpty() } ?: emptyList()

  /** Station's own provider authorities, which a sender must not name. */
  private val ownAuthorities: Set<String> by lazy {
    @Suppress("DEPRECATION")
    val providers = try {
      activity.packageManager.getPackageInfo(activity.packageName, PackageManager.GET_PROVIDERS).providers
    } catch (_: Exception) {
      null
    }
    providers.orEmpty().flatMap { it.authority.orEmpty().split(';') }.filter { it.isNotBlank() }.toSet()
  }

  override fun load(webView: WebView) {
    adoptShare(activity.intent, launchIntent = true)
  }

  override fun onNewIntent(intent: Intent) {
    if (adoptShare(intent, launchIntent = false)) trigger(SHARED_IMAGES_EVENT, JSObject())
  }

  /** Applies [shareDecision]; a newer share replaces an untaken one. */
  private fun adoptShare(intent: Intent?, launchIntent: Boolean): Boolean {
    if (intent == null) return false
    val decision = shareDecision(
      intent.action,
      intent.type,
      launchedFromHistory = (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0,
      launchIntent = launchIntent,
      readExtras = { streamExtra(intent) to streamListExtra(intent) },
      key = { streams -> shareKey(activity.taskId, streams.map { it.toString() }) },
      taken = takenKeys(),
    )
    synchronized(lock) {
      when (decision) {
        is ShareDecision.Ignore -> return false
        is ShareDecision.Refuse -> {
          pendingUris = null
          pendingRefusal = decision.message
          pendingKey = decision.key
        }
        is ShareDecision.Adopt -> {
          pendingUris = decision.streams
          pendingRefusal = null
          pendingKey = decision.key
        }
      }
    }
    return true
  }

  private fun markTaken(key: String) {
    takenStore.edit().putString(TAKEN_KEYS, rememberTaken(takenKeys(), key).joinToString("\n")).apply()
  }

  @Suppress("DEPRECATION")
  private fun streamExtra(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri

  @Suppress("DEPRECATION")
  private fun streamListExtra(intent: Intent): List<Uri?>? =
    if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
    else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)

  /**
   * Returns and clears the pending share: `{ files: [] }` when there is none.
   * Taking marks the share taken, whatever the read then finds, so a
   * restored launch intent carrying it is ignored.
   */
  @Command
  fun takeSharedImages(invoke: Invoke) {
    val (uris, refusal, key) = synchronized(lock) {
      val taken = Triple(pendingUris, pendingRefusal, pendingKey)
      pendingUris = null
      pendingRefusal = null
      pendingKey = null
      taken
    }
    key?.let { markTaken(it) }
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
        val resolver = activity.contentResolver
        clipboardImageItems(
          (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }.map { uri ->
            uri to (if (admitted(uri)) try { resolver.getType(uri) } catch (_: Exception) { null } else null)
          },
          (0 until clip.description.mimeTypeCount).map { clip.description.getMimeType(it) },
        )
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
          admit = ::admitted,
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

  private fun admitted(uri: Uri): Boolean = admitIntakeUri(uri.scheme, uri.authority, ownAuthorities)

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

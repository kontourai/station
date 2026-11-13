package io.kontourai.station.mediaintake

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.ContextWrapper
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
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import java.util.UUID
import java.util.concurrent.Executors
import org.json.JSONObject

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
class MediaIntakePlugin(private var activity: Activity) : Plugin(activity) {
  private var intakeView: WebView? = null
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
    KeyboardImageIntake.bind = ::bindView
    bindView(webView)
  }

  private fun bindView(webView: WebView) {
    activity = owningActivity(webView.context) ?: return
    intakeView = webView
    val bridge = activity.assets.open("station-image-paste.js").bufferedReader().use { it.readText() }
    KeyboardImageIntake.install(webView) { uris, release ->
      if (!KeyboardImageIntake.appOrigin(webView.url)) { release.release(); return@install }
      val id = JSONObject.quote(UUID.randomUUID().toString())
      webView.evaluateJavascript(appScript("$bridge;window.__stationImagePaste.capture($id)")) { captured ->
        if (captured != "true") {
          release.release()
          Toast.makeText(activity, if (captured == "\"busy\"") "Wait for the pending images to finish." else "Focus a chat composer to insert an image.", Toast.LENGTH_SHORT).show()
        } else {
          try {
            reads.execute {
              if (release.isReleased) {
                // The grant expired while queued; free the composer's pending slot too.
                webView.post { if (KeyboardImageIntake.appOrigin(webView.url)) webView.evaluateJavascript(appScript("window.__stationImagePaste?.cancel($id)"), null) }
                return@execute
              }
              try {
                val images = readImages(uris, "pasted-image")
                val payload = filesResult(images).toString()
                webView.post { if (KeyboardImageIntake.appOrigin(webView.url)) webView.evaluateJavascript(appScript("window.__stationImagePaste?.deliver($id,$payload)"), null) }
              } catch (error: Exception) {
                webView.post {
                  if (KeyboardImageIntake.appOrigin(webView.url)) webView.evaluateJavascript(appScript("window.__stationImagePaste?.cancel($id)"), null)
                  Toast.makeText(activity, (error as? IntakeRefused)?.message ?: "Station could not read the images.", Toast.LENGTH_SHORT).show()
                }
              } finally {
                release.release()
              }
            }
          } catch (_: java.util.concurrent.RejectedExecutionException) {
            release.release()
            if (KeyboardImageIntake.appOrigin(webView.url)) webView.evaluateJavascript(appScript("window.__stationImagePaste?.cancel($id)"), null)
          }
        }
      }
    }
  }

  override fun onDestroy(activity: AppCompatActivity) {
    if (intakeView?.context?.let(::owningActivity) === activity) {
      intakeView?.let(KeyboardImageIntake::uninstall)
      intakeView = null
    }
    // Tauri retains this plugin across activity recreation; the next view rebinds it.
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
        clipboardImageUris(activity, clip)
      }
    }
  }

  private fun readOffMainThread(invoke: Invoke, prefix: String, uris: () -> List<Uri>) {
    reads.execute {
      try {
        val images = readImages(uris(), prefix)
        invoke.resolve(filesResult(images))
      } catch (refused: IntakeRefused) {
        invoke.reject(refused.message)
      } catch (error: Exception) {
        invoke.reject("Station could not read the images.")
      }
    }
  }

  private fun readImages(uris: List<Uri>, prefix: String): List<IntakeImage> {
    val resolver = activity.contentResolver
    return sources.read(
      uris, prefix,
      open = { resolver.openInputStream(it) },
      displayName = { uri ->
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
          if (cursor.moveToFirst()) cursor.getString(0) else null
        }
      },
      encodeBase64 = { Base64.encodeToString(it, Base64.NO_WRAP) },
    )
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

/** Shared by the explicit clipboard command and Chromium's selection menu. */
internal fun clipboardImageUris(context: Context, clip: android.content.ClipData): List<Uri> =
  IntakeSources<Uri>(
    ownAuthorities = {
      @Suppress("DEPRECATION")
      val info = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PROVIDERS)
      info.providers.orEmpty().flatMap { it.authority.orEmpty().split(';') }.filter { it.isNotBlank() }.toSet()
    },
    scheme = { it.scheme }, authority = { it.authority },
  ).clipboardItems(
    (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri },
    { context.contentResolver.getType(it) },
    (0 until clip.description.mimeTypeCount).map { clip.description.getMimeType(it) },
  )


/** Tauri or a themed WebView may wrap its Activity context. */
internal fun owningActivity(context: Context): Activity? {
  var current = context
  val seen = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<Context, Boolean>())
  while (seen.add(current)) {
    if (current is Activity) return current
    current = (current as? ContextWrapper)?.baseContext ?: return null
  }
  return null
}

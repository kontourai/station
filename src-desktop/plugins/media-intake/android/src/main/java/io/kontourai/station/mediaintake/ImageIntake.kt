package io.kontourai.station.mediaintake

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.security.MessageDigest

/**
 * The chat-attachment contract's bounds
 * (`packages/contracts/src/chat-attachment.ts`), pinned there by
 * `src-ui/src/platform/native/__tests__/media-intake-native-limits.test.ts`.
 * Native code refuses past them; the web layer validates the payload again.
 */
internal const val MAX_IMAGE_COUNT = 5
internal const val MAX_IMAGE_BYTES = 5 * 1024 * 1024
internal const val MAX_TOTAL_IMAGE_BYTES = 15 * 1024 * 1024
internal const val MAX_IMAGE_NAME_LENGTH = 160

/** One image as the web layer receives it: `{ name, mimeType, dataUrl }`. */
internal data class IntakeImage(val name: String, val mimeType: String, val dataUrl: String)

/** A read that must not deliver a partial set; the message is shown to the person. */
internal class IntakeRefused(message: String) : Exception(message)

private val EXTENSIONS = mapOf(
  "image/png" to "png",
  "image/jpeg" to "jpg",
  "image/gif" to "gif",
  "image/webp" to "webp",
)

/**
 * The chat image type the bytes declare, mirroring the contract's
 * `sniffChatImageMimeType`: the payload's type comes from the bytes, never
 * from a sender's claim.
 */
internal fun sniffImageMimeType(head: ByteArray): String? {
  fun at(index: Int) = if (index < head.size) head[index].toInt() and 0xff else -1
  fun starts(vararg bytes: Int) = bytes.withIndex().all { (index, byte) -> at(index) == byte }
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png"
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg"
  if (starts(0x47, 0x49, 0x46, 0x38) && (at(4) == 0x37 || at(4) == 0x39) && at(5) == 0x61) return "image/gif"
  if (starts(0x52, 0x49, 0x46, 0x46) && at(8) == 0x57 && at(9) == 0x45 && at(10) == 0x42 && at(11) == 0x50) {
    return "image/webp"
  }
  return null
}

internal const val ACTION_SEND = "android.intent.action.SEND"
internal const val ACTION_SEND_MULTIPLE = "android.intent.action.SEND_MULTIPLE"
internal const val TOO_MANY_IMAGES = "Station can take at most $MAX_IMAGE_COUNT images at once."

/** Whether an intent is shaped like an image share, before any extra is read. */
internal fun isImageShare(action: String?, type: String?): Boolean =
  (action == ACTION_SEND || action == ACTION_SEND_MULTIPLE) &&
    type != null && type.lowercase().startsWith("image/")

/**
 * The streams an inbound intent shares, or empty when it is not an image
 * share. Generic over the URI type so the shape rules are unit-testable
 * without Android's stubbed `Uri`.
 */
internal fun <T> sharedImageStreams(action: String?, type: String?, single: T?, multiple: List<T?>?): List<T> {
  if (!isImageShare(action, type)) return emptyList()
  return when (action) {
    ACTION_SEND -> listOfNotNull(single)
    else -> multiple.orEmpty().filterNotNull()
  }
}

/** What the plugin does with an inbound intent. */
internal sealed class ShareDecision<out T> {
  object Ignore : ShareDecision<Nothing>()
  /** Kept so `take_shared_images` can say why, then forgotten. */
  data class Refuse(val message: String, val key: String) : ShareDecision<Nothing>()
  data class Adopt<T>(val streams: List<T>, val key: String) : ShareDecision<T>()
}

/**
 * The adopt/ignore/refuse decision for an inbound intent, in this order:
 * shape (action and type) before any extra is unpacked; a relaunch from
 * Recents is ignored; extras that fail to unpack mean "not a share"; a
 * launch intent whose key was already taken is ignored (Android restores the
 * original share intent when it recreates the activity after process death,
 * and removing the extra only changes this process's copy); past the
 * contract's count the share is refused rather than truncated.
 *
 * [launchIntent] is true for the intent the activity was created with
 * (`load`), false for one delivered while running (`onNewIntent`, always a
 * fresh share). [key] identifies a share within its task, so a later share
 * of the same images in a new task is not mistaken for a replay.
 */
internal fun <T> shareDecision(
  action: String?,
  type: String?,
  launchedFromHistory: Boolean,
  launchIntent: Boolean,
  readExtras: () -> Pair<T?, List<T?>?>,
  key: (List<T>) -> String,
  taken: Collection<String>,
): ShareDecision<T> {
  if (!isImageShare(action, type)) return ShareDecision.Ignore
  if (launchedFromHistory) return ShareDecision.Ignore
  val streams = try {
    val (single, multiple) = readExtras()
    sharedImageStreams(action, type, single, multiple)
  } catch (_: Exception) {
    return ShareDecision.Ignore
  }
  if (streams.isEmpty()) return ShareDecision.Ignore
  val shareKey = key(streams)
  if (launchIntent && shareKey in taken) return ShareDecision.Ignore
  if (streams.size > MAX_IMAGE_COUNT) return ShareDecision.Refuse(TOO_MANY_IMAGES, shareKey)
  return ShareDecision.Adopt(streams, shareKey)
}

/**
 * A share's identity: the boot, its task and its streams, hashed so no URI is
 * stored. The boot count keeps a task id reused after a reboot from matching
 * an earlier boot's taken share.
 */
internal fun shareKey(bootCount: Int, taskId: Int, streams: List<String>): String {
  val digest = MessageDigest.getInstance("SHA-256")
    .digest((listOf(bootCount.toString(), taskId.toString()) + streams).joinToString("\n").toByteArray(Charsets.UTF_8))
  return digest.joinToString("") { "%02x".format(it.toInt() and 0xff) }
}

internal const val MAX_TAKEN_SHARES = 16

/** The taken-share keys to keep: newest last, bounded, no duplicates. */
internal fun rememberTaken(taken: List<String>, key: String): List<String> =
  (taken.filter { it != key } + key).takeLast(MAX_TAKEN_SHARES)

/**
 * Whether Station may open a shared or pasted URI with its own identity. Only
 * `content://` from another app's provider: a `file://` URI, or one served
 * by a provider Station itself declares (its FileProvider exposes the cache
 * directory), would read Station's private files on a sender's behalf.
 */
internal fun admitIntakeUri(scheme: String?, authority: String?, ownAuthorities: Set<String>): Boolean {
  if (scheme == null || !scheme.equals("content", ignoreCase = true)) return false
  if (authority.isNullOrBlank()) return false
  val host = authority.substringAfterLast('@').lowercase()
  return ownAuthorities.none { it.equals(host, ignoreCase = true) }
}

/**
 * The clipboard items to paste: each judged by its own type, so a clip that
 * mixes an image and a PDF pastes the image and skips the PDF. An item whose
 * provider reports no type counts only when the clip declares images alone.
 */
internal fun <T> clipboardImageItems(items: List<Pair<T, String?>>, clipMimeTypes: List<String>): List<T> {
  val clipIsOnlyImages = clipMimeTypes.isNotEmpty() && clipMimeTypes.all { it.lowercase().startsWith("image/") }
  return items.filter { (_, type) ->
    if (type == null) clipIsOnlyImages else type.lowercase().startsWith("image/")
  }.map { it.first }
}

/** Reads at most [limit] bytes; null when the stream holds more. */
internal fun readBounded(stream: InputStream, limit: Int): ByteArray? {
  val out = ByteArrayOutputStream()
  val buffer = ByteArray(64 * 1024)
  var total = 0
  while (true) {
    val read = stream.read(buffer)
    if (read < 0) break
    total += read
    if (total > limit) return null
    out.write(buffer, 0, read)
  }
  return out.toByteArray()
}

/**
 * Control (Cc), format (Cf: bidi overrides, zero-width characters) and
 * line/paragraph separators (Zl, Zp) can disguise or split a name.
 */
private fun isUnsafeNameCodePoint(codePoint: Int): Boolean =
  when (Character.getType(codePoint).toByte()) {
    Character.CONTROL, Character.FORMAT, Character.LINE_SEPARATOR, Character.PARAGRAPH_SEPARATOR -> true
    else -> false
  }

/**
 * A sender's display name when it is safe to show and send: non-blank,
 * within the contract's length, no path separator, control, format or
 * line/paragraph separator character.
 * Otherwise a generated `<prefix>-<n>.<ext>`. Only the label is replaced;
 * the bytes are never altered.
 */
internal fun intakeImageName(candidate: String?, prefix: String, index: Int, mimeType: String): String {
  val trimmed = candidate?.trim()
  val usable = !trimmed.isNullOrEmpty() &&
    trimmed.length <= MAX_IMAGE_NAME_LENGTH &&
    trimmed.none { it == '/' || it == '\\' } &&
    trimmed.codePoints().noneMatch { isUnsafeNameCodePoint(it) }
  return if (usable) trimmed!! else "$prefix-${index + 1}.${EXTENSIONS.getValue(mimeType)}"
}

/**
 * The one URI-to-payload path the clipboard read and the share receiver
 * share. Refuses the whole set (never truncates) past the contract's count,
 * per-image or total byte bounds, when any source fails [admit] (see
 * [admitIntakeUri]), or when any source is unreadable or not an admitted
 * image type.
 */
internal fun <T> readIntakeImages(
  sources: List<T>,
  prefix: String,
  admit: (T) -> Boolean,
  open: (T) -> InputStream?,
  displayName: (T) -> String?,
  encodeBase64: (ByteArray) -> String,
): List<IntakeImage> {
  if (sources.size > MAX_IMAGE_COUNT) throw IntakeRefused(TOO_MANY_IMAGES)
  // Checked for every source before any is opened.
  if (!sources.all(admit)) throw IntakeRefused("Station only reads images another app shares with it.")
  var total = 0
  return sources.mapIndexed { index, source ->
    val bytes = try {
      open(source)?.use { readBounded(it, MAX_IMAGE_BYTES) ?: throw IntakeRefused("An image is larger than 5 MB.") }
    } catch (refused: IntakeRefused) {
      throw refused
    } catch (_: Exception) {
      null
    } ?: throw IntakeRefused("An image could not be read.")
    if (bytes.isEmpty()) throw IntakeRefused("An image could not be read.")
    total += bytes.size
    if (total > MAX_TOTAL_IMAGE_BYTES) throw IntakeRefused("The images are larger than 15 MB together.")
    val mimeType = sniffImageMimeType(bytes)
      ?: throw IntakeRefused("Only PNG, JPEG, GIF and WebP images can be attached.")
    val name = intakeImageName(
      try { displayName(source) } catch (_: Exception) { null },
      prefix,
      index,
      mimeType,
    )
    IntakeImage(name, mimeType, "data:$mimeType;base64,${encodeBase64(bytes)}")
  }
}

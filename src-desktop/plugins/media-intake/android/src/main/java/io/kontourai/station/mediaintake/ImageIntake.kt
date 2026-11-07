package io.kontourai.station.mediaintake

import java.io.ByteArrayOutputStream
import java.io.InputStream

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

/**
 * The streams an inbound intent shares, or empty when it is not an image
 * share. Generic over the URI type so the shape rules are unit-testable
 * without Android's stubbed `Uri`.
 */
internal fun <T> sharedImageStreams(action: String?, type: String?, single: T?, multiple: List<T?>?): List<T> {
  if (type == null || !type.lowercase().startsWith("image/")) return emptyList()
  return when (action) {
    ACTION_SEND -> listOfNotNull(single)
    ACTION_SEND_MULTIPLE -> multiple.orEmpty().filterNotNull()
    else -> emptyList()
  }
}

internal const val ACTION_SEND = "android.intent.action.SEND"
internal const val ACTION_SEND_MULTIPLE = "android.intent.action.SEND_MULTIPLE"

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
 * A sender's display name when it is safe to show and send: non-blank,
 * within the contract's length, no path separator or control character.
 * Otherwise a generated `<prefix>-<n>.<ext>`. Only the label is replaced;
 * the bytes are never altered.
 */
internal fun intakeImageName(candidate: String?, prefix: String, index: Int, mimeType: String): String {
  val trimmed = candidate?.trim()
  val usable = !trimmed.isNullOrEmpty() &&
    trimmed.length <= MAX_IMAGE_NAME_LENGTH &&
    trimmed.none { it == '/' || it == '\\' || it.code <= 0x1f || it.code == 0x7f }
  return if (usable) trimmed!! else "$prefix-${index + 1}.${EXTENSIONS.getValue(mimeType)}"
}

/**
 * The one URI-to-payload path the clipboard read and the share receiver
 * share. Refuses the whole set (never truncates) past the contract's count,
 * per-image or total byte bounds, or when any source is unreadable or not an
 * admitted image type.
 */
internal fun <T> readIntakeImages(
  sources: List<T>,
  prefix: String,
  open: (T) -> InputStream?,
  displayName: (T) -> String?,
  encodeBase64: (ByteArray) -> String,
): List<IntakeImage> {
  if (sources.size > MAX_IMAGE_COUNT) {
    throw IntakeRefused("Station can take at most $MAX_IMAGE_COUNT images at once.")
  }
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

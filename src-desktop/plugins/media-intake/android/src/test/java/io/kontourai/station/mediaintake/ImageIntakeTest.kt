package io.kontourai.station.mediaintake

import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ImageIntakeTest {
  private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d)
  private val jpeg = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xe0.toByte(), 1)
  private val gif = "GIF89a....".toByteArray()
  private val webp = "RIFF\u0000\u0000\u0000\u0000WEBPVP8 ".toByteArray()
  private val heic = byteArrayOf(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63)

  private fun read(
    sources: Map<String, ByteArray?>,
    names: Map<String, String?> = emptyMap(),
  ): List<IntakeImage> = readIntakeImages(
    sources.keys.toList(),
    "pasted-image",
    open = { key -> sources.getValue(key)?.let { ByteArrayInputStream(it) } },
    displayName = { names[it] },
    encodeBase64 = { Base64.getEncoder().encodeToString(it) },
  )

  private fun refusal(block: () -> Unit): String {
    try {
      block()
    } catch (refused: IntakeRefused) {
      return refused.message ?: ""
    }
    fail("expected the read to be refused")
    return ""
  }

  @Test
  fun sniffsOnlyTheContractsImageTypes() {
    assertEquals("image/png", sniffImageMimeType(png))
    assertEquals("image/jpeg", sniffImageMimeType(jpeg))
    assertEquals("image/gif", sniffImageMimeType(gif))
    assertEquals("image/webp", sniffImageMimeType(webp))
    assertEquals("image/gif", sniffImageMimeType("GIF87a".toByteArray()))
    assertNull(sniffImageMimeType("GIF87Z".toByteArray()))
    assertNull(sniffImageMimeType(heic))
    assertNull(sniffImageMimeType("RIFF".toByteArray()))
    assertNull(sniffImageMimeType(ByteArray(0)))
  }

  @Test
  fun aSingleImageShareYieldsItsStream() {
    assertEquals(listOf("a"), sharedImageStreams(ACTION_SEND, "image/png", "a", null))
    assertEquals(listOf("a"), sharedImageStreams(ACTION_SEND, "image/*", "a", listOf("ignored")))
  }

  @Test
  fun aMultipleImageShareYieldsEveryNonNullStream() {
    assertEquals(listOf("a", "b"), sharedImageStreams(ACTION_SEND_MULTIPLE, "image/*", null, listOf("a", null, "b")))
  }

  @Test
  fun nonImageOrNonShareIntentsYieldNothing() {
    assertEquals(emptyList<String>(), sharedImageStreams(ACTION_SEND, "text/plain", "a", null))
    assertEquals(emptyList<String>(), sharedImageStreams(ACTION_SEND, null, "a", null))
    assertEquals(emptyList<String>(), sharedImageStreams("android.intent.action.MAIN", "image/png", "a", null))
    assertEquals(emptyList<String>(), sharedImageStreams("android.intent.action.VIEW", "image/png", "a", null))
    assertEquals(emptyList<String>(), sharedImageStreams<String>(ACTION_SEND, "image/png", null, null))
    assertEquals(emptyList<String>(), sharedImageStreams<String>(ACTION_SEND_MULTIPLE, "image/png", null, null))
  }

  @Test
  fun anEmptySourceListIsAnEmptyPayload() {
    assertEquals(emptyList<IntakeImage>(), read(emptyMap()))
  }

  @Test
  fun encodesEachImageAsASniffedDataUrl() {
    val images = read(linkedMapOf("a" to png, "b" to jpeg), mapOf("a" to "Screenshot.png"))
    assertEquals(2, images.size)
    assertEquals(IntakeImage("Screenshot.png", "image/png", "data:image/png;base64," + Base64.getEncoder().encodeToString(png)), images[0])
    // The type comes from the bytes; the generated name follows it.
    assertEquals("image/jpeg", images[1].mimeType)
    assertEquals("pasted-image-2.jpg", images[1].name)
  }

  @Test
  fun refusesMoreThanTheContractCountRatherThanTruncating() {
    assertEquals(5, MAX_IMAGE_COUNT)
    val five = (1..5).associate { "s$it" to png }
    assertEquals(5, read(five).size)
    val six = (1..6).associate { "s$it" to png }
    assertTrue(refusal { read(six) }.contains("at most 5"))
  }

  @Test
  fun refusesAnImageOverTheByteLimit() {
    assertEquals(5 * 1024 * 1024, MAX_IMAGE_BYTES)
    val atLimit = png + ByteArray(MAX_IMAGE_BYTES - png.size)
    assertEquals(1, read(mapOf("a" to atLimit)).size)
    val over = png + ByteArray(MAX_IMAGE_BYTES - png.size + 1)
    assertTrue(refusal { read(mapOf("a" to over)) }.contains("5 MB"))
  }

  @Test
  fun refusesASetOverTheTotalByteLimit() {
    assertEquals(15 * 1024 * 1024, MAX_TOTAL_IMAGE_BYTES)
    val big = png + ByteArray(MAX_IMAGE_BYTES - png.size)
    assertEquals(3, read(linkedMapOf("a" to big, "b" to big, "c" to big)).size)
    val sources = linkedMapOf("a" to big, "b" to big, "c" to big, "d" to png)
    assertTrue(refusal { read(sources) }.contains("15 MB"))
  }

  @Test
  fun refusesTheWholeSetWhenOneImageIsNotAnAdmittedType() {
    assertTrue(refusal { read(linkedMapOf("a" to png, "b" to heic)) }.contains("PNG, JPEG, GIF and WebP"))
  }

  @Test
  fun refusesUnreadableOrEmptySources() {
    assertTrue(refusal { read(mapOf("a" to null)) }.contains("could not be read"))
    assertTrue(refusal { read(mapOf("a" to ByteArray(0))) }.contains("could not be read"))
    val throwing = readIntakeImagesOrMessage(open = { object : InputStream() {
      override fun read(): Int = throw IOException("revoked")
    } })
    assertTrue(throwing.contains("could not be read"))
  }

  @Test
  fun replacesUnsafeNamesButKeepsSafeOnes() {
    assertEquals("photo.png", intakeImageName(" photo.png ", "shared-image", 0, "image/png"))
    assertEquals("shared-image-1.png", intakeImageName("../etc/passwd", "shared-image", 0, "image/png"))
    assertEquals("shared-image-2.webp", intakeImageName("a\\b", "shared-image", 1, "image/webp"))
    assertEquals("shared-image-1.gif", intakeImageName("bell\u0007", "shared-image", 0, "image/gif"))
    assertEquals("shared-image-1.jpg", intakeImageName("   ", "shared-image", 0, "image/jpeg"))
    assertEquals("shared-image-1.jpg", intakeImageName(null, "shared-image", 0, "image/jpeg"))
    val limit = "x".repeat(MAX_IMAGE_NAME_LENGTH)
    assertEquals(limit, intakeImageName(limit, "shared-image", 0, "image/png"))
    assertEquals("shared-image-1.png", intakeImageName(limit + "x", "shared-image", 0, "image/png"))
  }

  @Test
  fun readBoundedStopsPastTheLimit() {
    assertEquals(3, readBounded(ByteArrayInputStream(ByteArray(3)), 3)!!.size)
    assertNull(readBounded(ByteArrayInputStream(ByteArray(4)), 3))
  }

  private fun readIntakeImagesOrMessage(open: (String) -> InputStream?): String =
    refusal {
      readIntakeImages(listOf("a"), "pasted-image", open, { null }, { Base64.getEncoder().encodeToString(it) })
    }
}

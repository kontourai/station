package io.kontourai.station.mediaintake

import java.io.ByteArrayInputStream
import java.net.URI
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ShareIntakeSessionTest {
  private class MemoryTaken : TakenShares {
    var saved = emptyList<String>()
    override fun keys() = saved
    override fun save(keys: List<String>) {
      saved = keys
    }
  }

  private fun share(vararg uris: String, action: String = if (uris.size > 1) ACTION_SEND_MULTIPLE else ACTION_SEND) =
    IntentFacts<String>(action, "image/*", false) {
      if (action == ACTION_SEND) uris.firstOrNull() to null else null to uris.toList()
    }

  private val notAShare = IntentFacts<String>("android.intent.action.MAIN", null, false) { null to null }

  private fun session(taken: MemoryTaken = MemoryTaken(), boot: Int = 1) =
    ShareIntakeSession<String>(taken, bootCount = { boot }, taskId = { 9 }, describe = { it })

  @Test
  fun loadAdoptsTheLaunchIntentAsALaunch() {
    val taken = MemoryTaken()
    val first = session(taken)
    assertTrue(first.onLoad(share("content://media/1"), null))
    assertEquals(PendingShare.Streams(listOf("content://media/1")), first.take())
    // Process death: a new session is loaded with the same launch intent.
    val restored = session(taken)
    assertFalse(restored.onLoad(share("content://media/1"), null))
    assertEquals(PendingShare.None, restored.take())
  }

  @Test
  fun loadTreatsABufferedShareAsFresh() {
    val taken = MemoryTaken()
    val first = session(taken)
    assertTrue(first.onLoad(share("content://media/1"), null))
    first.take()
    // The same images shared again while the process was dead, buffered by
    // MainActivity before the plugin loaded: a new share, not a replay.
    val restored = session(taken)
    assertTrue(restored.onLoad(share("content://media/1"), share("content://media/1")))
    assertEquals(PendingShare.Streams(listOf("content://media/1")), restored.take())
  }

  @Test
  fun aBufferedIntentThatIsNotAShareFallsBackToTheLaunchIntent() {
    val loaded = session()
    assertTrue(loaded.onLoad(share("content://media/1"), notAShare))
    assertEquals(PendingShare.Streams(listOf("content://media/1")), loaded.take())
    assertFalse(session().onLoad(null, null))
  }

  @Test
  fun takingAShareRecordsItAsTakenOnce() {
    val taken = MemoryTaken()
    val running = session(taken)
    assertTrue(running.onNewIntent(share("content://media/1")))
    assertEquals(emptyList<String>(), taken.saved)
    running.take()
    assertEquals(listOf(shareKey(1, 9, listOf("content://media/1"))), taken.saved)
    // Nothing pending: nothing more is recorded.
    assertEquals(PendingShare.None, running.take())
    assertEquals(1, taken.saved.size)
  }

  @Test
  fun aRefusedShareIsHandedOverAndRecorded() {
    val taken = MemoryTaken()
    val running = session(taken)
    val six = (1..6).map { "content://media/$it" }.toTypedArray()
    assertTrue(running.onNewIntent(share(*six)))
    assertEquals(PendingShare.Refused(TOO_MANY_IMAGES), running.take())
    assertEquals(1, taken.saved.size)
  }

  @Test
  fun aNewerShareReplacesAnUntakenOne() {
    val running = session()
    assertTrue(running.onNewIntent(share("content://media/1")))
    assertTrue(running.onNewIntent(share("content://media/2")))
    assertFalse(running.onNewIntent(notAShare))
    assertEquals(PendingShare.Streams(listOf("content://media/2")), running.take())
  }

  @Test
  fun aTakenShareDoesNotSuppressTheSameTaskAfterAReboot() {
    val taken = MemoryTaken()
    val first = session(taken, boot = 1)
    assertTrue(first.onLoad(share("content://media/1"), null))
    first.take()
    // Same boot: a restored launch intent is a replay.
    assertFalse(session(taken, boot = 1).onLoad(share("content://media/1"), null))
    // After a reboot the task id may be reused; the share is new.
    assertTrue(session(taken, boot = 2).onLoad(share("content://media/1"), null))
  }

  @Test
  fun shareKeysDependOnTheBoot() {
    assertTrue(shareKey(1, 9, listOf("a")) != shareKey(2, 9, listOf("a")))
    assertEquals(shareKey(1, 9, listOf("a")), shareKey(1, 9, listOf("a")))
  }

  // --- Sources ---------------------------------------------------------

  private fun sources(own: () -> Set<String>) =
    IntakeSources<String>(own, { URI(it).scheme }, { URI(it).rawAuthority })

  private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

  @Test
  fun everyReadIsHeldToTheUriGuard() {
    val opened = mutableListOf<String>()
    val reader = sources { setOf("io.kontourai.station.fileprovider") }
    for (refused in listOf("file:///data/data/io.kontourai.station/cache/a.png", "content://io.kontourai.station.fileprovider/my_cache_images/a.png")) {
      try {
        reader.read(listOf(refused), "shared-image", { opened.add(it); ByteArrayInputStream(png) }, { null }, { Base64.getEncoder().encodeToString(it) })
        fail("expected $refused to be refused")
      } catch (_: IntakeRefused) {
      }
    }
    assertEquals(emptyList<String>(), opened)
    val images = reader.read(listOf("content://media/external/images/1"), "shared-image", { opened.add(it); ByteArrayInputStream(png) }, { null }, { Base64.getEncoder().encodeToString(it) })
    assertEquals(1, images.size)
  }

  @Test
  fun aFailedOwnProviderLookupRefusesEverySource() {
    val reader = sources { throw RuntimeException("NameNotFoundException") }
    assertFalse(reader.admitted("content://media/external/images/1"))
    try {
      reader.read(listOf("content://media/external/images/1"), "shared-image", { fail("opened"); null }, { null }, { "" })
      fail("expected a refusal")
    } catch (_: IntakeRefused) {
    }
  }

  @Test
  fun theClipboardNeverAsksTypesOfSourcesItWouldRefuse() {
    val asked = mutableListOf<String>()
    val reader = sources { setOf("io.kontourai.station.fileprovider") }
    val items = reader.clipboardItems(
      listOf("content://media/1", "content://io.kontourai.station.fileprovider/a", "content://docs/2"),
      { asked.add(it); if (it.endsWith("2")) "application/pdf" else "image/png" },
      listOf("image/png", "application/pdf"),
    )
    assertEquals(listOf("content://media/1"), items)
    assertEquals(listOf("content://media/1", "content://docs/2"), asked)
  }

  // --- Buffer ----------------------------------------------------------

  private class Delivery(val share: Boolean)

  @Test
  fun theBufferKeepsTheLatestShareUntilTakenAndDropsOnlyWhatWasDelivered() {
    val buffer = LatestBuffer<Delivery> { it.share }
    val first = Delivery(true)
    val second = Delivery(true)
    buffer.offer(first)
    buffer.offer(second)
    assertTrue(buffer.claimDelivered(first))
    assertSame(second, buffer.take())
    assertNull(buffer.take())
    val third = Delivery(true)
    buffer.offer(third)
    assertTrue(buffer.claimDelivered(third))
    assertNull(buffer.take())
  }

  @Test
  fun onlyAShareReplacesABufferedShare() {
    val buffer = LatestBuffer<Delivery> { it.share }
    val share = Delivery(true)
    buffer.offer(share)
    buffer.offer(Delivery(false))
    assertSame(share, buffer.take())
  }

  @Test
  fun anIntentLoadDrainedIsNotAdoptedAgainWhenDelivered() {
    val buffer = LatestBuffer<Delivery> { it.share }
    val share = Delivery(true)
    buffer.offer(share)
    // load (off the main thread) drains it before Tauri forwards it.
    assertSame(share, buffer.take())
    val adopted = mutableListOf<Delivery>()
    assertFalse(deliverNewIntent(buffer, share) { adopted.add(it) })
    assertEquals(emptyList<Delivery>(), adopted)
    // A different intent still reaches the plugin.
    val next = Delivery(true)
    buffer.offer(next)
    assertTrue(deliverNewIntent(buffer, next) { adopted.add(it) })
    assertEquals(listOf(next), adopted)
    assertNull(buffer.take())
  }
}

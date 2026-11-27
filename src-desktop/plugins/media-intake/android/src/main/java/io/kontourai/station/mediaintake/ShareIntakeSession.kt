package io.kontourai.station.mediaintake

import android.content.Intent
import java.io.InputStream

/** The parts of an inbound intent [shareDecision] reads; extras are read lazily. */
internal class IntentFacts<T>(
  val action: String?,
  val type: String?,
  val launchedFromHistory: Boolean,
  val readExtras: () -> Pair<T?, List<T?>?>,
)

/** Where taken-share keys survive process death (app preferences on Android). */
internal interface TakenShares {
  fun keys(): List<String>
  fun save(keys: List<String>)
}

/** What `take_shared_images` hands back. */
internal sealed class PendingShare<out T> {
  object None : PendingShare<Nothing>()
  data class Refused(val message: String) : PendingShare<Nothing>()
  data class Streams<T>(val streams: List<T>) : PendingShare<T>()
}

/**
 * The share receiver's state, apart from Android types so its wiring is
 * unit-tested: which intent `load` adopts and as what, the pending share, and
 * marking a share taken when it is handed over.
 */
internal class ShareIntakeSession<T>(
  private val taken: TakenShares,
  /** Settings.Global.BOOT_COUNT on Android; -1 when the platform will not say. */
  private val bootCount: () -> Int,
  private val taskId: () -> Int,
  private val describe: (T) -> String,
) {
  private val key: (List<T>) -> String = { streams -> shareKey(bootCount(), taskId(), streams.map(describe)) }

  private val lock = Any()
  private var pending: PendingShare<T> = PendingShare.None
  private var pendingKey: String? = null

  /**
   * At plugin load. A share MainActivity buffered from `onNewIntent` before
   * this plugin was registered is a fresh share; otherwise the activity's
   * launch intent is adopted unless its share was already taken (a restore
   * after process death redelivers it).
   */
  fun onLoad(launch: IntentFacts<T>?, buffered: IntentFacts<T>?): Boolean {
    if (buffered != null && adopt(buffered, launchIntent = false)) return true
    return launch != null && adopt(launch, launchIntent = true)
  }

  /** A share delivered while running; true when it should be announced. */
  fun onNewIntent(facts: IntentFacts<T>): Boolean = adopt(facts, launchIntent = false)

  /** Returns and clears the pending share, recording it as taken. */
  fun take(): PendingShare<T> {
    val (share, shareKey) = synchronized(lock) {
      val current = pending to pendingKey
      pending = PendingShare.None
      pendingKey = null
      current
    }
    shareKey?.let { taken.save(rememberTaken(taken.keys(), it)) }
    return share
  }

  /** A newer share replaces an untaken one. */
  private fun adopt(facts: IntentFacts<T>, launchIntent: Boolean): Boolean {
    val decision = shareDecision(
      facts.action,
      facts.type,
      facts.launchedFromHistory,
      launchIntent,
      facts.readExtras,
      key,
      taken.keys(),
    )
    synchronized(lock) {
      when (decision) {
        is ShareDecision.Ignore -> return false
        is ShareDecision.Refuse -> {
          pending = PendingShare.Refused(decision.message)
          pendingKey = decision.key
        }
        is ShareDecision.Adopt -> {
          pending = PendingShare.Streams(decision.streams)
          pendingKey = decision.key
        }
      }
    }
    return true
  }
}

/**
 * Which sources the plugin may open, and the reads that apply that rule.
 * [ownAuthorities] lists Station's own provider authorities; when it cannot
 * be read every source is refused, since an unknown own provider could be
 * one of them.
 */
internal class IntakeSources<T>(
  ownAuthorities: () -> Set<String>,
  private val scheme: (T) -> String?,
  private val authority: (T) -> String?,
) {
  private val own: Set<String>? by lazy {
    try {
      ownAuthorities()
    } catch (_: Exception) {
      null
    }
  }

  fun admitted(source: T): Boolean {
    val ownSet = own ?: return false
    return admitIntakeUri(scheme(source), authority(source), ownSet)
  }

  fun read(
    sources: List<T>,
    prefix: String,
    open: (T) -> InputStream?,
    displayName: (T) -> String?,
    encodeBase64: (ByteArray) -> String,
  ): List<IntakeImage> = readIntakeImages(sources, prefix, ::admitted, open, displayName, encodeBase64)

  /** The clipboard items to paste; a source that is not admitted is never asked its type. */
  fun clipboardItems(items: List<T>, typeOf: (T) -> String?, clipMimeTypes: List<String>): List<T> =
    clipboardImageItems(
      items.map { item ->
        item to (if (admitted(item)) try { typeOf(item) } catch (_: Exception) { null } else null)
      },
      clipMimeTypes,
    )
}

/**
 * Holds the latest accepted value until taken. Only a value [accepts] admits
 * replaces a held one, so an unrelated value cannot push out a held share.
 * It remembers what [take] drained, so the same value delivered afterwards
 * is not handled twice.
 */
internal class LatestBuffer<T : Any>(private val accepts: (T) -> Boolean) {
  private var value: T? = null
  private var drained: T? = null

  fun offer(next: T) {
    if (!accepts(next)) return
    synchronized(this) { value = next }
  }

  fun take(): T? = synchronized(this) {
    val taken = value
    value = null
    if (taken != null) drained = taken
    taken
  }

  /**
   * A value delivered to a loaded receiver: false when [take] already drained
   * this very value (by identity); otherwise drops it if held and returns true.
   */
  fun claimDelivered(delivered: T): Boolean = synchronized(this) {
    if (drained === delivered) return@synchronized false
    if (value === delivered) value = null
    true
  }
}

/** A new intent for a loaded plugin: adopted unless `load` already drained it. */
internal fun <I : Any> deliverNewIntent(buffer: LatestBuffer<I>, intent: I, adopt: (I) -> Boolean): Boolean =
  buffer.claimDelivered(intent) && adopt(intent)

/**
 * Intents MainActivity receives in `onNewIntent`. Tauri forwards a new intent
 * only to plugins already registered, and after process death a share can
 * arrive before this plugin loads; MainActivity offers every new intent here
 * (scripts/apply-android-native-bootstrap.mjs adds that override); only an
 * image share is kept, a loaded plugin claims the one it was handed (skipping
 * one `load` already drained), and `load` takes any left.
 */
object ShareIntentBuffer {
  internal val intents = LatestBuffer<Intent> { isImageShare(it.action, it.type) }

  @JvmStatic
  fun offer(intent: Intent) = intents.offer(intent)
}

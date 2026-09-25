import Foundation
import UserNotifications

// See SealedAlert.swift: SwiftPM builds define SWIFT_PACKAGE; the
// extension target compiles the shared sources into this module instead.
#if SWIFT_PACKAGE
  import StationAgentActivityShared
#endif

/// One alert push through the Notification Service Extension: hands iOS
/// either the opened notification or the push exactly as it arrived, and
/// hands it over exactly once.
///
/// The keychain read and the decryption run off the calling thread, so
/// `expire()` (the extension's `serviceExtensionTimeWillExpire`) can answer
/// while they are still running; whichever of the two answers first wins,
/// and the later one is dropped.
public final class SealedAlertDelivery: @unchecked Sendable {
  private let lookup: (String) -> AgentActivityRegistration?
  private let queue: DispatchQueue
  private let clock: () -> Date
  // `original` and `handler` are read and written under `lock`, hence the
  // unchecked Sendable.
  private let lock = NSLock()
  private var original: UNNotificationContent?
  private var handler: ((UNNotificationContent) -> Void)?

  public init(
    registration lookup: @escaping (String) -> AgentActivityRegistration?,
    queue: DispatchQueue = DispatchQueue.global(qos: .userInitiated),
    clock: @escaping () -> Date = Date.init
  ) {
    self.lookup = lookup
    self.queue = queue
    self.clock = clock
  }

  public func receive(
    _ content: UNNotificationContent,
    contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    lock.lock()
    original = content
    handler = contentHandler
    lock.unlock()
    queue.async { [self] in
      deliver(Self.rewritten(content, now: clock(), registration: lookup))
    }
  }

  /// Time is up: the push as it arrived, unless an answer already went.
  public func expire() {
    lock.lock()
    let content = original
    lock.unlock()
    if let content { deliver(content) }
  }

  private func deliver(_ content: UNNotificationContent) {
    lock.lock()
    let handler = self.handler
    self.handler = nil
    lock.unlock()
    handler?(content)
  }

  /// `content` with its title and body replaced by the sealed notification's,
  /// or `content` itself, untouched, when that does not open and verify.
  public static func rewritten(
    _ content: UNNotificationContent,
    now: Date,
    registration lookup: (String) -> AgentActivityRegistration?
  ) -> UNNotificationContent {
    guard
      let text = SealedAlertResolver.resolve(
        userInfo: content.userInfo, fixedTitle: content.title, fixedBody: content.body, now: now,
        registration: lookup),
      let mutable = content.mutableCopy() as? UNMutableNotificationContent
    else { return content }
    mutable.title = text.title
    mutable.body = text.body
    return mutable
  }
}

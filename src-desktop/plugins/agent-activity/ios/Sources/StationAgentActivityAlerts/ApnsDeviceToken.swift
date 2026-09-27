import Foundation

/// What `registerForRemoteNotifications` answered: the app's regular APNs
/// device token as lowercase hex, or why registration failed. This token is
/// for alert pushes (#2589); it is not the Live Activity push-to-start token.
public enum ApnsDeviceTokenOutcome: Sendable, Equatable {
  case token(String)
  case failed(String)
}

/// The token as the Station stores it: lowercase hex of whole bytes, within
/// the gateway's bound (32 to 100 bytes). Nil for anything else, so a value
/// the Station would refuse is never offered to it.
public func apnsDeviceTokenHex(_ token: Data) -> String? {
  guard (32...100).contains(token.count) else { return nil }
  return token.map { String(format: "%02x", $0) }.joined()
}

/// Carries the app delegate's answer to whoever asked for the token.
///
/// UIKit reports the token only to the app delegate, which Tauri's runtime
/// owns, so `RemoteNotificationDelegateHook` forwards both callbacks here.
/// The latest outcome is kept and replayed to each new waiter, so an answer
/// that lands before the waiter subscribes is not lost; `reset()` clears it
/// before a new registration, so a stale answer is never taken for a new one.
public final class ApnsDeviceTokenBroker: @unchecked Sendable {
  public static let shared = ApnsDeviceTokenBroker()

  private let lock = NSLock()
  private var latest: ApnsDeviceTokenOutcome?
  private var waiters: [UUID: AsyncStream<ApnsDeviceTokenOutcome>.Continuation] = [:]

  public init() {}

  public func record(deviceToken: Data) {
    guard let hex = apnsDeviceTokenHex(deviceToken) else {
      publish(.failed("APNs returned a device token of \(deviceToken.count) bytes"))
      return
    }
    publish(.token(hex))
  }

  public func record(failure: Error) {
    publish(.failed(failure.localizedDescription))
  }

  /// Forgets the last answer; call before asking UIKit again.
  public func reset() {
    lock.lock()
    latest = nil
    lock.unlock()
  }

  /// Every answer from now on, starting with the latest one if there is one.
  public func updates() -> AsyncStream<ApnsDeviceTokenOutcome> {
    AsyncStream { continuation in
      let id = UUID()
      lock.lock()
      let current = latest
      waiters[id] = continuation
      lock.unlock()
      if let current { continuation.yield(current) }
      continuation.onTermination = { [weak self] _ in
        guard let self else { return }
        self.lock.lock()
        self.waiters[id] = nil
        self.lock.unlock()
      }
    }
  }

  private func publish(_ outcome: ApnsDeviceTokenOutcome) {
    lock.lock()
    latest = outcome
    let current = Array(waiters.values)
    lock.unlock()
    for waiter in current { waiter.yield(outcome) }
  }
}

import Foundation
import ObjectiveC
import StationAgentActivityShared

/// The session a tapped alert opens, on the Station that registered it.
public struct AlertTapRoute: Equatable {
  /// The registration's verified Station id, never a field of the seal.
  public let stationId: String
  public let sessionId: String
  public let projectSlug: String?
  /// The record the alert was for, so opening it reads it (the web layer's
  /// `openedNotification`). Nil when the seal's id is outside its grammar.
  public let notificationId: String?

  public init(stationId: String, sessionId: String, projectSlug: String?, notificationId: String? = nil) {
    self.stationId = stationId
    self.sessionId = sessionId
    self.projectSlug = projectSlug
    self.notificationId = notificationId
  }

  /// The shape `take_launch_route` answers, the same as Android's.
  public var json: [String: Any] {
    var value: [String: Any] = ["stationId": stationId, "sessionId": sessionId]
    if let projectSlug { value["projectSlug"] = projectSlug }
    if let notificationId { value["notificationId"] = notificationId }
    return value
  }
}

/// Reads the route a tapped alert push names (#2515 on iOS).
///
/// The push is the one the Notification Service Extension opened to show
/// its text (`SealedAlertResolver`): `station` holds `v`, `rid`, `sk` and
/// `sealed`. The app opens the seal again with the same registration and
/// the same checks — a payload of this version, a registration this phone
/// holds for `rid`, `sk` equal to the key it pinned, a seal that opens in the
/// alert domain, and `user_id` naming the registered Station — and takes
/// `session_id` / `project_slug` from it only when both match the contract
/// grammar (`NATIVE_PUSH_SESSION_REFERENCE_PATTERN`), and `notification_id`
/// (the record, so the tap reads it) when it matches the record-id grammar;
/// an unreadable id only drops the read, not the route. Any failure is nil: the
/// tap just opens the app. No URL is ever read. Unlike the text, a route has
/// no freshness bound: a tap may come hours after delivery, and it only
/// navigates; the session stays behind the Station's own read checks.
public enum AlertTapRouteResolver {
  /// `SealedAlertResolver.payloadKey` / `payloadVersion` (the extension's
  /// module, which the app does not compile).
  static let payloadKey = "station"
  static let payloadVersion = 1

  public static func resolve(
    userInfo: [AnyHashable: Any],
    registration lookup: (String) -> AgentActivityRegistration?
  ) -> AlertTapRoute? {
    guard let station = userInfo[payloadKey] as? [String: Any],
      let version = station["v"] as? NSNumber,
      CFGetTypeID(version) != CFBooleanGetTypeID(),
      version.intValue == payloadVersion,
      let rid = station["rid"] as? String,
      let stationKey = station["sk"] as? String,
      let sealed = station["sealed"] as? String
    else { return nil }
    guard let registration = lookup(rid), registration.id == rid,
      stationKey == registration.stationKey
    else { return nil }
    guard
      let fields = CardOpener.open(
        payloadKey: registration.payloadKey,
        registrationId: registration.id,
        sealed: sealed,
        domain: CardOpener.alertDomain),
      fields["user_id"] == registration.stationId,
      let sessionId = fields["session_id"], isSessionReference(sessionId)
    else { return nil }
    let projectSlug = fields["project_slug"]
    if let projectSlug, !isSessionReference(projectSlug) { return nil }
    let notificationId = fields["notification_id"].flatMap { isNotificationId($0) ? $0 : nil }
    return AlertTapRoute(
      stationId: registration.stationId, sessionId: sessionId, projectSlug: projectSlug,
      notificationId: notificationId)
  }

  /// `^[A-Za-z0-9._:-]{1,128}$`, ASCII only: a record id as the Android
  /// opener accepts it (`NOTIFICATION_ID_PATTERN`).
  static func isNotificationId(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard (1...128).contains(bytes.count), bytes.count == value.count else { return false }
    return bytes.allSatisfy { byte in
      (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A)
        || byte == UInt8(ascii: ".") || byte == UInt8(ascii: "_")
        || byte == UInt8(ascii: ":") || byte == UInt8(ascii: "-")
    }
  }

  /// `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, ASCII only.
  static func isSessionReference(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard (1...128).contains(bytes.count), bytes.count == value.count else { return false }
    func alphanumeric(_ byte: UInt8) -> Bool {
      (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A)
    }
    guard alphanumeric(bytes[0]) else { return false }
    return bytes.dropFirst().allSatisfy { byte in
      alphanumeric(byte) || byte == UInt8(ascii: ".") || byte == UInt8(ascii: "_")
        || byte == UInt8(ascii: ":") || byte == UInt8(ascii: "-")
    }
  }
}

/// Gives the notification-center delegate's tap callback a second listener.
///
/// The Tauri notification plugin owns `UNUserNotificationCenter.delegate`
/// and ignores taps on push notifications, so a tapped alert reached no one.
/// Like `RemoteNotificationDelegateHook`, this wraps the delegate class's
/// `userNotificationCenter(_:didReceive:withCompletionHandler:)` with the
/// Objective-C runtime: the listener sees the response first, then the
/// original runs (and calls the completion handler); a class without the
/// method gets one that only calls the completion handler. The response is
/// passed as `AnyObject` so the hook is tested on macOS with a stand-in.
public enum NotificationResponseHook {
  static let responseSelector = NSSelectorFromString(
    "userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:")

  private typealias Completion = @convention(block) () -> Void
  private typealias ResponseIMP =
    @convention(c) (AnyObject, Selector, AnyObject, AnyObject, Completion) -> Void

  private static let hooked = HookedResponseClasses()

  /// Installs the listener on `delegateClass` once; a second call for the
  /// same class does nothing. Returns whether this call installed it.
  @discardableResult
  public static func install(on delegateClass: AnyClass, listener: @escaping (AnyObject) -> Void) -> Bool {
    guard hooked.claim(delegateClass) else { return false }
    let original = class_getInstanceMethod(delegateClass, responseSelector).map(method_getImplementation)
    let block: @convention(block) (AnyObject, AnyObject, AnyObject, @escaping Completion) -> Void = {
      this, center, response, completion in
      listener(response)
      if let original {
        unsafeBitCast(original, to: ResponseIMP.self)(this, responseSelector, center, response, completion)
      } else {
        completion()
      }
    }
    let imp = imp_implementationWithBlock(block)
    // v@:@@@? : void, self, _cmd, center, response, completion block.
    if !class_addMethod(delegateClass, responseSelector, imp, "v@:@@@?"),
      let method = class_getInstanceMethod(delegateClass, responseSelector)
    {
      method_setImplementation(method, imp)
    }
    return true
  }
}

private final class HookedResponseClasses: @unchecked Sendable {
  private let lock = NSLock()
  private var classes = Set<ObjectIdentifier>()

  func claim(_ cls: AnyClass) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return classes.insert(ObjectIdentifier(cls)).inserted
  }
}

import UserNotifications

// The shared sources (plugins/agent-activity/ios/Sources/
// StationAgentActivityShared: Base64URL, CardOpener, RegistrationKeychain)
// and StationNotificationServiceCore are compiled into this target
// directly, so their types are in this module.

/// Replaces an alert push's fixed text with the notification the Station
/// sealed for this phone (#2590). Anything that does not open and verify,
/// and running out of time, leaves the fixed text exactly as it arrived.
final class NotificationService: UNNotificationServiceExtension {
  // Nil reads across every group this extension holds; its entitlements
  // list only the group the app shares registrations through.
  private let delivery = SealedAlertDelivery(registration: RegistrationKeychain(accessGroup: nil).load)

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    delivery.receive(request.content, contentHandler: contentHandler)
  }

  override func serviceExtensionTimeWillExpire() {
    delivery.expire()
  }
}

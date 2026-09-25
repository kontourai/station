import Foundation

// The Notification Service Extension compiles the shared sources it needs
// (Base64URL, CardOpener, RegistrationKeychain) into its own module, as the
// widget does; the host `swift test` build reaches them as a package module.
#if canImport(StationAgentActivityShared)
  import StationAgentActivityShared
#endif

/// The text a sealed alert push shows once the extension has opened it.
public struct SealedAlertText: Equatable {
  public let title: String
  public let body: String

  public init(title: String, body: String) {
    self.title = title
    self.body = body
  }
}

/// Opens the notification an alert push carries sealed (#2590).
///
/// The push gateway builds the push (`buildAlertPayload` in
/// deploy/push-gateway/src/apns-request.ts): fixed `aps.alert` text chosen
/// by kind, and under `station` the routing data `v`, `rid`, the verified
/// signing key's thumbprint `sk`, and `sealed`, which the Station sealed
/// under the registration's payload key with AAD `station-alert:v1:<rid>`
/// (`composeApnsAlertPlaintext` in src-server's apns-alert-channel.ts writes
/// the plaintext).
public enum SealedAlertResolver {
  /// The custom key the gateway puts the sealed notification under.
  public static let payloadKey = "station"
  public static let payloadVersion = 1

  /// The notification's own text, or nil when anything does not check out,
  /// in which case the push's fixed text must show unchanged. Every check
  /// must pass: a payload of this version; a registration this phone holds
  /// for `rid`; `sk` equal to the Station key that registration pinned; a
  /// seal that opens under that registration's key in the alert domain; and
  /// `user_id` inside it naming the Station that registered.
  ///
  /// A seal without a title or body (the Station hides content for that
  /// surface) is nil too, so the fixed neutral text stays. An empty title
  /// with a body keeps the fixed title.
  public static func resolve(
    userInfo: [AnyHashable: Any],
    fixedTitle: String,
    registration lookup: (String) -> AgentActivityRegistration?
  ) -> SealedAlertText? {
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
      fields["user_id"] == registration.stationId
    else { return nil }
    let title = fields["title"] ?? ""
    let body = fields["body"] ?? ""
    guard !title.isEmpty || !body.isEmpty else { return nil }
    return SealedAlertText(title: title.isEmpty ? fixedTitle : title, body: body)
  }
}

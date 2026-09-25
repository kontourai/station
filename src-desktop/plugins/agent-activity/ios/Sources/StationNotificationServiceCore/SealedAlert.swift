import Foundation

// The Notification Service Extension compiles the shared sources it needs
// (Base64URL, CardOpener, RegistrationKeychain) into its own module, as the
// widget does; the host `swift test` build reaches them as a package module.
// SwiftPM defines SWIFT_PACKAGE for every package build and the XcodeGen
// extension target does not, so the import follows how the file is built
// rather than whichever modules happen to be importable.
#if SWIFT_PACKAGE
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
  /// How old, by this phone's clock, a sealed alert may be and still open.
  /// Bounds replay: whoever holds a genuine sealed push (the gateway, or
  /// anyone with its APNs credentials and the device token) can send it
  /// again, and an old one must not bring text back to the lock screen
  /// after the user has turned on hidden content.
  public static let maxAgeMilliseconds: Int64 = 24 * 60 * 60 * 1000
  /// How far ahead of this phone's clock `issued_at` may be (clock skew).
  public static let maxFutureSkewMilliseconds: Int64 = 10 * 60 * 1000

  /// The notification's own text, or nil when anything does not check out,
  /// in which case the push's fixed text must show unchanged. Every check
  /// must pass: a payload of this version; a registration this phone holds
  /// for `rid`; `sk` equal to the Station key that registration pinned; a
  /// seal that opens under that registration's key in the alert domain; and
  /// `user_id` inside it naming the Station that registered; and
  /// `issued_at` (decimal milliseconds since the epoch, as the Station
  /// writes `Date.now()`) no more than `maxAgeMilliseconds` before `now`
  /// and no more than `maxFutureSkewMilliseconds` after it.
  ///
  /// A seal without a title or body (the Station hides content for that
  /// surface) is nil too, so the fixed neutral text stays. An empty title
  /// keeps the fixed title, and an empty body the fixed body.
  public static func resolve(
    userInfo: [AnyHashable: Any],
    fixedTitle: String,
    fixedBody: String,
    now: Date,
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
      fields["user_id"] == registration.stationId,
      let issuedAt = fields["issued_at"].flatMap(epochMilliseconds),
      isFresh(issuedAt: issuedAt, now: now)
    else { return nil }
    let title = fields["title"] ?? ""
    let body = fields["body"] ?? ""
    guard !title.isEmpty || !body.isEmpty else { return nil }
    return SealedAlertText(
      title: title.isEmpty ? fixedTitle : title, body: body.isEmpty ? fixedBody : body)
  }

  /// `issued_at` as the Station writes it (`String(Date.now())`): ASCII
  /// digits only, no sign, no leading zero, at most 15 digits. Anything
  /// else is nil.
  static func epochMilliseconds(_ text: String) -> Int64? {
    let digits = text.utf8
    guard (1...15).contains(digits.count), digits.first != UInt8(ascii: "0"),
      digits.allSatisfy({ $0 >= UInt8(ascii: "0") && $0 <= UInt8(ascii: "9") })
    else { return nil }
    return Int64(text)
  }

  static func isFresh(issuedAt: Int64, now: Date) -> Bool {
    let nowMilliseconds = Int64((now.timeIntervalSince1970 * 1000).rounded(.down))
    let age = nowMilliseconds - issuedAt
    return age <= maxAgeMilliseconds && age >= -maxFutureSkewMilliseconds
  }
}

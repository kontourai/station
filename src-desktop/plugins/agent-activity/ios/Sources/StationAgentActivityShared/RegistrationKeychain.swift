import Foundation
import Security

/// What a Station returned when this phone registered: `id` is the random
/// per-registration value (`rid`), `stationId` must equal the card's
/// `user_id`, `stationKey` is the thumbprint the gateway stamps as `sk`, and
/// `payloadKey` is the AES-256 key (base64url) the Station seals cards with.
public struct AgentActivityRegistration: Equatable {
  public let id: String
  public let stationId: String
  public let stationKey: String
  public let payloadKey: String

  /// Same shape rules as the Android plugin's `Registration.validOrNull`.
  public static func valid(id: String, stationId: String, stationKey: String, payloadKey: String)
    -> AgentActivityRegistration?
  {
    guard matches(id, pattern: "^[A-Za-z0-9_-]{16,128}$"),
      !stationId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      stationId.utf16.count <= 128,
      matches(stationKey, pattern: "^[A-Za-z0-9_-]{43}$"),
      matches(payloadKey, pattern: "^[A-Za-z0-9_-]{43}$")
    else { return nil }
    return AgentActivityRegistration(
      id: id, stationId: stationId, stationKey: stationKey, payloadKey: payloadKey)
  }

  private static func matches(_ value: String, pattern: String) -> Bool {
    value.range(of: pattern, options: .regularExpression) != nil
  }
}

/// Registrations live in the keychain, one generic-password item per
/// registration (account = rid), in an access group shared with the widget
/// extension, which opens cards without the app running. Items never sync
/// and are readable once the phone has been unlocked after boot, so a Live
/// Activity updated while locked still renders.
public struct RegistrationKeychain {
  public static let service = "io.kontourai.station.agent-activity"
  /// Appended to the app's default access group
  /// (`$(AppIdentifierPrefix)<app bundle>`) to name the shared group.
  public static let sharedGroupSuffix = ".agentactivity"

  /// Where writes go. Nil reads across every group the process holds, which
  /// is what the widget does: its entitlements list only the shared group.
  public let accessGroup: String?

  public init(accessGroup: String?) {
    self.accessGroup = accessGroup
  }

  private struct Stored: Codable {
    let stationId: String
    let stationKey: String
    let payloadKey: String
  }

  /// The attributes of a new item. Exposed so tests pin the protection class.
  public func addQuery(for registration: AgentActivityRegistration) throws -> [String: Any] {
    let value = try JSONEncoder().encode(
      Stored(
        stationId: registration.stationId,
        stationKey: registration.stationKey,
        payloadKey: registration.payloadKey))
    var query = baseQuery(account: registration.id)
    query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    query[kSecAttrSynchronizable as String] = kCFBooleanFalse
    query[kSecValueData as String] = value
    return query
  }

  public func save(_ registration: AgentActivityRegistration) throws {
    SecItemDelete(baseQuery(account: registration.id) as CFDictionary)
    let status = SecItemAdd(try addQuery(for: registration) as CFDictionary, nil)
    guard status == errSecSuccess else { throw KeychainError(status: status) }
  }

  public func load(_ registrationId: String) -> AgentActivityRegistration? {
    var query = baseQuery(account: registrationId)
    query[kSecReturnData as String] = kCFBooleanTrue
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data,
      let stored = try? JSONDecoder().decode(Stored.self, from: data)
    else { return nil }
    return AgentActivityRegistration.valid(
      id: registrationId,
      stationId: stored.stationId,
      stationKey: stored.stationKey,
      payloadKey: stored.payloadKey)
  }

  public func registrationIds() -> [String] {
    var query = baseQuery(account: nil)
    query[kSecReturnAttributes as String] = kCFBooleanTrue
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let items = result as? [[String: Any]]
    else { return [] }
    return items.compactMap { $0[kSecAttrAccount as String] as? String }
  }

  /// Deletes one registration, or every registration when `registrationId`
  /// is nil.
  public func delete(_ registrationId: String?) {
    SecItemDelete(baseQuery(account: registrationId) as CFDictionary)
  }

  private func baseQuery(account: String?) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.service,
    ]
    if let account { query[kSecAttrAccount as String] = account }
    if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
    return query
  }

  /// The shared group, derived from the group the keychain assigns items by
  /// default: the first `keychain-access-groups` entitlement, which the app
  /// target lists as `$(AppIdentifierPrefix)<bundle>` before the shared one.
  /// Nil when the keychain cannot be reached.
  public static func appSharedAccessGroup() -> String? {
    let probe: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service + ".group-probe",
      kSecAttrAccount as String: "default-access-group",
    ]
    var lookup = probe
    lookup[kSecReturnAttributes as String] = kCFBooleanTrue
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    var status = SecItemCopyMatching(lookup as CFDictionary, &result)
    if status == errSecItemNotFound {
      var add = probe
      add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      add[kSecReturnAttributes as String] = kCFBooleanTrue
      status = SecItemAdd(add as CFDictionary, &result)
    }
    guard status == errSecSuccess,
      let attributes = result as? [String: Any],
      let group = attributes[kSecAttrAccessGroup as String] as? String,
      !group.isEmpty
    else { return nil }
    return group + sharedGroupSuffix
  }
}

public struct KeychainError: Error, CustomStringConvertible {
  public let status: OSStatus
  public var description: String {
    // The build has the plugin half (STATION_IOS_LIVE_ACTIVITY=1) without
    // the project half that grants the app the shared keychain group.
    if status == errSecMissingEntitlement {
      return
        "keychain status \(status): this build lacks the keychain group it shares with the Live Activity widget; run scripts/ensure-ios-agent-activity-extension.mjs on the rendered gen/apple/project.yml, then xcodegen generate"
    }
    return "keychain status \(status)"
  }
}

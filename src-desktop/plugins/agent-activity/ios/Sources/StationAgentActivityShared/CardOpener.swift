import CryptoKit
import Foundation

/// Opens a card the Station sealed for one registration: AES-256-GCM with a
/// 12-byte nonce prefixed and the 16-byte tag appended (CryptoKit's
/// "combined" representation), the registration bound in as associated data.
/// Only the Station and this phone hold the key, so the gateway, Cloudflare
/// and Apple carry the card without being able to read or forge it.
public enum CardOpener {
  static let nonceBytes = 12
  static let tagBytes = 16

  public static func associatedData(registrationId: String) -> Data {
    Data("station-agent-activity:v1:\(registrationId)".utf8)
  }

  /// The plaintext card, or nil for anything that does not authenticate or
  /// is not a flat JSON object of strings.
  public static func open(payloadKey: String, registrationId: String, sealed: String) -> [String: String]? {
    guard let key = Base64URL.decode(payloadKey), key.count == 32,
      let bytes = Base64URL.decode(sealed), bytes.count > nonceBytes + tagBytes,
      let box = try? AES.GCM.SealedBox(combined: bytes),
      let plaintext = try? AES.GCM.open(
        box,
        using: SymmetricKey(data: key),
        authenticating: associatedData(registrationId: registrationId))
    else { return nil }
    guard let object = try? JSONSerialization.jsonObject(with: plaintext),
      let fields = object as? [String: Any]
    else { return nil }
    var card: [String: String] = [:]
    for (name, value) in fields {
      // JSON numbers and booleans bridge to NSNumber, never to String.
      guard let text = value as? String else { return nil }
      card[name] = text
    }
    return card
  }
}

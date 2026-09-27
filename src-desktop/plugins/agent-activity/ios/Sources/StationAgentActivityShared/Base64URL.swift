import Foundation

/// Unpadded base64url, strict: any character outside the URL-safe alphabet
/// (including `=` padding) is refused, matching the Android decoder.
public enum Base64URL {
  private static let alphabet = Set(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)

  public static func decode(_ value: String) -> Data? {
    let bytes = Array(value.utf8)
    guard bytes.count % 4 != 1, bytes.allSatisfy({ alphabet.contains($0) }) else { return nil }
    var standard = String(decoding: bytes, as: UTF8.self)
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    while standard.utf8.count % 4 != 0 { standard += "=" }
    return Data(base64Encoded: standard)
  }

  public static func encode(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}

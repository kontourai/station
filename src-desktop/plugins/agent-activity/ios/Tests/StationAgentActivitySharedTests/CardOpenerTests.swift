import CryptoKit
import Foundation
import XCTest

@testable import StationAgentActivityShared

/// NATIVE_PUSH_SEALED_TEST_VECTOR, copied verbatim from
/// packages/contracts/src/native-push.ts: the Station sealer's own output,
/// which the Android opener (AgentSealTest.kt) also pins. If the contract's
/// vector changes, this copy must change with it.
enum SealedTestVector {
  static let payloadKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
  static let registrationId = "AAECAwQFBgcICQoLDA0ODw"
  static let nonce = "AAECAwQFBgcICQoL"
  static let plaintext =
    #"{"user_id":"11111111-1111-4111-8111-111111111111","updated_at":"1800000000000","active":"true","activity_phase":"waiting_for_approval","activity_line_0":"Approval\tFix the flaky login test\tLogin App","activity_active_count":"1","activity_attention_count":"1","activity_expires_at":"1800007200000","alert_id":"0000000000000000000000000000000000000000000000000000000000000000","alert_title":"Approval needed","alert_body":"Fix the flaky login test · Login App"}"#
  static let sealed =
    "AAECAwQFBgcICQoLPCCjaKCXnXLpY62pgNhJXLLntgXdSm5NCUrRtCxYLYowIZ_RnvAjqUWVTty5thkJzHVC-Cqywq5a83V4bMHPzMEE9krj4RZRLGSaXt-tIspZ6b0LAAZxUt-J7Lkd0pWvqpstj9IovGPBbFbTOxADRZgQA8KXrEv9Epk4v92HHn7JPXan2PXncWmCPMhLszi7aZiKW1BOo2i2fakHiqCGmPL7wmGvlrRe0wu42rns59Dk7qZN7MIdnBG6s7MtsfucdCXk2kytpusbdLKFziiv7ZUHpxdedNOHFM75qDQm-9h5AeWNygJiRiYuzmHBaCMw3OfcG-lZ5stICAgG5ehguzbg0Ly_uytKHqkbc85yX3Kq3bio89Tg21MVT2AyxIp7MTTseIr1_iewEBg7ZvDSp8ejP3xztv8nqAEtJqcNddn5pU8au1BI2ZPQSxBt4y1SoyrntKwktTh5k0hWvYF4z2kfyem1ZEL7EJ-UE6eFUhi0zS9J3sEi7b2EWLmuIwZGzPesvKU98Z3RAIwQSCF-p4xuCd_6RHD4H3GyIz-S5DR2Hi5J-fMXG9iYqDqa2NbJPAA9MnDsR4yJmZeI9d8_us1a4rLJPtFdqmqQdYyGxMFWrOh4YsInKEEUM74P"
  static let stationId = "11111111-1111-4111-8111-111111111111"
  /// The vector's `updated_at` and `activity_expires_at`, epoch millis.
  static let updatedAtMillis: Int64 = 1_800_000_000_000
  static let expiresAtMillis: Int64 = 1_800_007_200_000
  static let updatedAt = Date(timeIntervalSince1970: Double(updatedAtMillis) / 1000)

  /// `plaintext` sealed the way the Station seals it, under this vector's
  /// key and registration, for cards the vector itself does not cover.
  static func seal(_ plaintext: String) throws -> String {
    let box = try AES.GCM.seal(
      Data(plaintext.utf8),
      using: SymmetricKey(data: Base64URL.decode(payloadKey)!),
      authenticating: CardOpener.associatedData(registrationId: registrationId))
    return Base64URL.encode(box.combined!)
  }
}

final class CardOpenerTests: XCTestCase {
  func testOpensTheStationsKnownAnswerVector() throws {
    let expected = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(SealedTestVector.plaintext.utf8)) as? [String: String])
    let card = CardOpener.open(
      payloadKey: SealedTestVector.payloadKey,
      registrationId: SealedTestVector.registrationId,
      sealed: SealedTestVector.sealed)
    XCTAssertEqual(card, expected)
    XCTAssertEqual(card?["activity_line_0"], "Approval\tFix the flaky login test\tLogin App")
  }

  func testTheVectorsNonceIsTheSealsPrefix() throws {
    let sealed = try XCTUnwrap(Base64URL.decode(SealedTestVector.sealed))
    let nonce = try XCTUnwrap(Base64URL.decode(SealedTestVector.nonce))
    XCTAssertEqual(sealed.prefix(12), nonce)
  }

  func testTheAssociatedDataNamesTheRegistration() {
    XCTAssertEqual(
      CardOpener.associatedData(registrationId: "rid_0123456789abcdef"),
      Data("station-agent-activity:v1:rid_0123456789abcdef".utf8))
  }

  func testRefusesAnythingThatDoesNotAuthenticate() {
    let sealed = SealedTestVector.sealed
    let index = sealed.index(sealed.startIndex, offsetBy: 20)
    let flipped =
      sealed[..<index] + (sealed[index] == "A" ? "B" : "A") + sealed[sealed.index(after: index)...]
    let key = SealedTestVector.payloadKey
    let rid = SealedTestVector.registrationId
    XCTAssertNil(CardOpener.open(payloadKey: key, registrationId: rid, sealed: String(flipped)), "tampered")
    XCTAssertNil(
      CardOpener.open(payloadKey: key, registrationId: "AAECAwQFBgcICQoLDA0OEA", sealed: sealed),
      "sealed for another registration")
    XCTAssertNil(
      CardOpener.open(payloadKey: "B" + key.dropFirst(), registrationId: rid, sealed: sealed),
      "another key")
    XCTAssertNil(CardOpener.open(payloadKey: key, registrationId: rid, sealed: "AAECAwQFBgcICQoL"), "too short")
    XCTAssertNil(CardOpener.open(payloadKey: key, registrationId: rid, sealed: "not base64!"), "not base64url")
    XCTAssertNil(CardOpener.open(payloadKey: "AAEC", registrationId: rid, sealed: sealed), "short key")
  }

  func testRefusesACardThatIsNotAFlatObjectOfStrings() throws {
    let open = { (plaintext: String) throws -> [String: String]? in
      CardOpener.open(
        payloadKey: SealedTestVector.payloadKey,
        registrationId: SealedTestVector.registrationId,
        sealed: try SealedTestVector.seal(plaintext))
    }
    // The seal helper itself round-trips a well-formed card.
    XCTAssertEqual(try open(#"{"user_id":"u","active":"true"}"#), ["user_id": "u", "active": "true"])
    XCTAssertNil(try open(#"{"user_id":"u","activity_active_count":1}"#), "a number")
    XCTAssertNil(try open(#"{"user_id":"u","active":true}"#), "a boolean")
    XCTAssertNil(try open(#"{"user_id":"u","active":null}"#), "a null")
    XCTAssertNil(try open(#"{"user_id":"u","rows":["a"]}"#), "a nested array")
    XCTAssertNil(try open(#"[{"user_id":"u"}]"#), "a top-level array")
    XCTAssertNil(try open(#""user_id""#), "a bare string")
  }

  func testDecodesUnpaddedBase64UrlStrictly() {
    XCTAssertEqual(Base64URL.decode(SealedTestVector.payloadKey), Data((0..<32).map { UInt8($0) }))
    XCTAssertEqual(Base64URL.decode("-_8"), Data([0xFB, 0xFF]))
    XCTAssertNil(Base64URL.decode("A"))
    XCTAssertNil(Base64URL.decode("A+/="))
    XCTAssertEqual(Base64URL.encode(Data([0xFB, 0xFF])), "-_8")
  }
}

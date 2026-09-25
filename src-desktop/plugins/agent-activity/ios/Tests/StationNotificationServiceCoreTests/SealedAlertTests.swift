import CryptoKit
import Foundation
import UserNotifications
import XCTest

@testable import StationAgentActivityShared
@testable import StationNotificationServiceCore

/// NATIVE_PUSH_ALERT_SEALED_TEST_VECTOR, copied verbatim from
/// packages/contracts/src/native-push.ts: the Station sealer's own output
/// for an alert. src-server's agent-activity-seal.test.ts pins this copy to
/// the contract's, so changing either without the other fails there.
enum AlertTestVector {
  static let payloadKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
  static let registrationId = "AAECAwQFBgcICQoLDA0ODw"
  static let nonce = "AQIDBAUGBwgJCgsM"
  static let plaintext =
    #"{"user_id":"11111111-1111-4111-8111-111111111111","notification_id":"notif-0001","urgency":"attention","issued_at":"1800000000000","title":"Approval needed","body":"Fix the flaky login test · Login App"}"#
  static let sealed =
    "AQIDBAUGBwgJCgsMfsgvponmr-8ogFllISLbGXNy0M-6XGH0kHLNFa-HW_211aryX4TdroGdi9T06slsvNptjrvtXxdfHm25Bm5aUx4ZKRmdnzKUInSdSssIMoXxEkVahUyQowO0rClBilRG-bIFEtFmIkecpeJQzpJHreymHfrgQaFeQx3B9oyhHQQwRS6HnrAAXI-KeN60rsAzq41d_f6obgf3VAm_Qlo4eJYTF7Mxc0w6tLzn_58A00ZJqz7T67c-sPl6qVy7cHotQU-0-etVBpvrCQG0DjUQtxApwbPd_tZwAPO_Uw"
  static let stationId = "11111111-1111-4111-8111-111111111111"
  /// The vector's `issued_at`, 1800000000000 ms, as a date.
  static let issuedAt = Date(timeIntervalSince1970: 1_800_000_000)

  /// `plaintext` sealed the way the Station seals an alert, under this
  /// vector's key and registration.
  static func seal(_ plaintext: String, domain: String = CardOpener.alertDomain) throws -> String {
    let box = try AES.GCM.seal(
      Data(plaintext.utf8),
      using: SymmetricKey(data: Base64URL.decode(payloadKey)!),
      authenticating: CardOpener.associatedData(registrationId: registrationId, domain: domain))
    return Base64URL.encode(box.combined!)
  }
}

/// The fixed text the gateway sent (APNS_ALERT_TEXT.attention).
private let fixedTitle = "Station"
private let fixedBody = "Something needs your attention"
private let stationKey = String(repeating: "K", count: 43)
/// A phone clock one minute after the vector was issued.
private let fresh = AlertTestVector.issuedAt.addingTimeInterval(60)

private let registration = AgentActivityRegistration.valid(
  id: AlertTestVector.registrationId,
  stationId: AlertTestVector.stationId,
  stationKey: stationKey,
  payloadKey: AlertTestVector.payloadKey)!

/// A keychain holding exactly `registration`, as `RegistrationKeychain.load`
/// answers: the registration for its own id, nothing for any other.
private func holding(_ stored: AgentActivityRegistration?) -> (String) -> AgentActivityRegistration? {
  { rid in rid == stored?.id ? stored : nil }
}

/// The `userInfo` of the push the gateway builds (`buildAlertPayload`).
private func userInfo(
  v: Any = 1, rid: String = AlertTestVector.registrationId, sk: String? = stationKey,
  sealed: String = AlertTestVector.sealed
) -> [AnyHashable: Any] {
  var station: [String: Any] = ["v": v, "rid": rid, "sealed": sealed]
  if let sk { station["sk"] = sk }
  return [
    "aps": ["alert": ["title": fixedTitle, "body": fixedBody], "mutable-content": 1],
    "station": station,
  ]
}

private func content(_ userInfo: [AnyHashable: Any]) -> UNNotificationContent {
  let content = UNMutableNotificationContent()
  content.title = fixedTitle
  content.body = fixedBody
  content.userInfo = userInfo
  return content.copy() as! UNNotificationContent
}

/// Flips one base64url character inside the ciphertext.
private func tampered(_ sealed: String, at offset: Int = 30) -> String {
  let index = sealed.index(sealed.startIndex, offsetBy: offset)
  return String(sealed[..<index]) + (sealed[index] == "A" ? "B" : "A")
    + String(sealed[sealed.index(after: index)...])
}

final class SealedAlertTests: XCTestCase {
  private func resolve(
    _ info: [AnyHashable: Any], _ lookup: (String) -> AgentActivityRegistration? = holding(registration),
    now: Date = fresh
  ) -> SealedAlertText? {
    SealedAlertResolver.resolve(
      userInfo: info, fixedTitle: fixedTitle, fixedBody: fixedBody, now: now, registration: lookup)
  }

  /// `fields` plus this Station's `user_id`, sealed as an alert.
  private func sealed(_ fields: [String: String]) throws -> String {
    var all = fields
    all["user_id"] = AlertTestVector.stationId
    let json = try JSONSerialization.data(withJSONObject: all, options: [.sortedKeys])
    return try AlertTestVector.seal(String(decoding: json, as: UTF8.self))
  }

  func testOpensTheStationsKnownAnswerVector() throws {
    let expected = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(AlertTestVector.plaintext.utf8)) as? [String: String])
    XCTAssertEqual(
      CardOpener.open(
        payloadKey: AlertTestVector.payloadKey,
        registrationId: AlertTestVector.registrationId,
        sealed: AlertTestVector.sealed,
        domain: CardOpener.alertDomain),
      expected)
    let sealed = try XCTUnwrap(Base64URL.decode(AlertTestVector.sealed))
    XCTAssertEqual(sealed.prefix(12), Base64URL.decode(AlertTestVector.nonce))
    XCTAssertEqual(
      resolve(userInfo()),
      SealedAlertText(title: "Approval needed", body: "Fix the flaky login test · Login App"))
  }

  func testTheDomainsKeepAlertsAndCardsApart() throws {
    XCTAssertEqual(
      CardOpener.associatedData(registrationId: "rid", domain: CardOpener.alertDomain),
      Data("station-alert:v1:rid".utf8))
    // The alert vector does not open as a card, and a card (sealed under
    // the same key for the same registration) does not open as an alert.
    XCTAssertNil(
      CardOpener.open(
        payloadKey: AlertTestVector.payloadKey,
        registrationId: AlertTestVector.registrationId,
        sealed: AlertTestVector.sealed))
    let card = try AlertTestVector.seal(AlertTestVector.plaintext, domain: CardOpener.cardDomain)
    XCTAssertNil(resolve(userInfo(sealed: card)))
  }

  func testATamperedSealKeepsTheFixedText() {
    XCTAssertNil(resolve(userInfo(sealed: tampered(AlertTestVector.sealed))), "ciphertext")
    XCTAssertNil(resolve(userInfo(sealed: tampered(AlertTestVector.sealed, at: 3))), "nonce")
    XCTAssertNil(resolve(userInfo(sealed: String(AlertTestVector.sealed.dropLast()))), "truncated tag")
    XCTAssertNil(resolve(userInfo(sealed: "not base64!")), "not base64url")
  }

  func testAnotherStationKeyKeepsTheFixedText() {
    XCTAssertNil(resolve(userInfo(sk: String(repeating: "J", count: 43))), "another key")
    XCTAssertNil(resolve(userInfo(sk: nil)), "no key stamped")
  }

  func testAnotherStationsUserIdKeepsTheFixedText() throws {
    let other = AlertTestVector.plaintext.replacingOccurrences(
      of: AlertTestVector.stationId, with: "22222222-2222-4222-8222-222222222222")
    XCTAssertNotEqual(other, AlertTestVector.plaintext)
    XCTAssertNil(resolve(userInfo(sealed: try AlertTestVector.seal(other))))
    let none = #"{"notification_id":"n","issued_at":"1800000000000","title":"Approval needed","body":"b"}"#
    XCTAssertNil(resolve(userInfo(sealed: try AlertTestVector.seal(none))), "no user_id")
  }

  func testNoKeychainItemKeepsTheFixedText() {
    XCTAssertNil(resolve(userInfo(), holding(nil)), "nothing registered")
    XCTAssertNil(
      resolve(userInfo(rid: "AAECAwQFBgcICQoLDA0OEA")), "a registration this phone does not hold")
  }

  func testOnlyThisPayloadVersionOpens() {
    XCTAssertNil(resolve(userInfo(v: 2)))
    XCTAssertNil(resolve(userInfo(v: "1")), "a string")
    XCTAssertNil(resolve(userInfo(v: true)), "a boolean")
    XCTAssertNil(resolve(["aps": ["alert": ["title": fixedTitle]]]), "no station payload")
  }

  func testHiddenContentKeepsTheFixedText() throws {
    // What the Station seals for a surface that hides content: no title,
    // no body. Nothing may replace the neutral text.
    // These are fresh, so only the missing text keeps the fixed text.
    let issued = "1800000000000"
    let hidden = ["notification_id": "n", "urgency": "attention", "issued_at": issued]
    XCTAssertNil(resolve(userInfo(sealed: try sealed(hidden))))
    XCTAssertNil(resolve(userInfo(sealed: try sealed(["issued_at": issued, "title": "", "body": ""]))))
    // A body without a title keeps the fixed title.
    XCTAssertEqual(
      resolve(userInfo(sealed: try sealed(["issued_at": issued, "title": "", "body": "b"]))),
      SealedAlertText(title: fixedTitle, body: "b"))
  }

  func testATitleWithoutABodyKeepsTheFixedBody() throws {
    let issued = "1800000000000"
    // The Station leaves `body` out when it is empty.
    XCTAssertEqual(
      resolve(userInfo(sealed: try sealed(["issued_at": issued, "title": "t"]))),
      SealedAlertText(title: "t", body: fixedBody))
    XCTAssertEqual(
      resolve(userInfo(sealed: try sealed(["issued_at": issued, "title": "t", "body": ""]))),
      SealedAlertText(title: "t", body: fixedBody))
  }

  func testOnlyAFreshAlertOpens() {
    let hour: TimeInterval = 60 * 60
    let opened = SealedAlertText(title: "Approval needed", body: "Fix the flaky login test · Login App")
    // 86_400_000 ms and 600_000 ms, written out rather than derived.
    XCTAssertEqual(SealedAlertResolver.maxAgeMilliseconds, 86_400_000)
    XCTAssertEqual(SealedAlertResolver.maxFutureSkewMilliseconds, 600_000)
    let issued = AlertTestVector.issuedAt
    XCTAssertEqual(resolve(userInfo(), now: issued), opened, "at issue")
    XCTAssertEqual(resolve(userInfo(), now: issued.addingTimeInterval(24 * hour)), opened, "24 h old")
    XCTAssertNil(resolve(userInfo(), now: issued.addingTimeInterval(24 * hour + 0.001)), "just past 24 h")
    XCTAssertNil(resolve(userInfo(), now: issued.addingTimeInterval(30 * 24 * hour)), "a month old")
    XCTAssertEqual(resolve(userInfo(), now: issued.addingTimeInterval(-600)), opened, "10 min ahead")
    XCTAssertNil(resolve(userInfo(), now: issued.addingTimeInterval(-601)), "past the skew allowance")
    XCTAssertNil(resolve(userInfo(), now: issued.addingTimeInterval(-24 * hour)), "a day ahead")
  }

  func testAMissingOrMalformedIssuedAtKeepsTheFixedText() throws {
    let text = ["title": "t", "body": "b"]
    XCTAssertNotNil(
      resolve(userInfo(sealed: try sealed(text.merging(["issued_at": "1800000000000"]) { $1 }))),
      "the control opens")
    XCTAssertNil(resolve(userInfo(sealed: try sealed(text))), "missing")
    for bad in [
      "", "+1800000000000", "-1800000000000", " 1800000000000", "1800000000000 ", "01800000000000",
      "1800000000000.0", "1.8e12", "0x1A3185C5000", "１800000000000", "1800000000000000000",
    ] {
      XCTAssertNil(resolve(userInfo(sealed: try sealed(text.merging(["issued_at": bad]) { $1 }))), bad)
    }
    // A number rather than a string is not the Station's shape either.
    let numeric =
      #"{"user_id":"11111111-1111-4111-8111-111111111111","issued_at":1800000000000,"title":"t","body":"b"}"#
    XCTAssertNil(resolve(userInfo(sealed: try AlertTestVector.seal(numeric))), "a JSON number")
  }
}

final class SealedAlertDeliveryTests: XCTestCase {
  func testReplacesOnlyTheTitleAndBody() {
    let original = content(userInfo())
    let rewritten = SealedAlertDelivery.rewritten(
      original, now: fresh, registration: holding(registration))
    XCTAssertEqual(rewritten.title, "Approval needed")
    XCTAssertEqual(rewritten.body, "Fix the flaky login test · Login App")
    XCTAssertEqual(
      rewritten.userInfo["station"] as? [String: AnyHashable],
      original.userInfo["station"] as? [String: AnyHashable])
    // The arrived content itself is not modified.
    XCTAssertEqual(original.title, fixedTitle)
    XCTAssertEqual(original.body, fixedBody)
  }

  func testAnyFailureHandsBackThePushAsItArrived() {
    let stale = SealedAlertDelivery.rewritten(
      content(userInfo()), now: fresh.addingTimeInterval(2 * 24 * 60 * 60),
      registration: holding(registration))
    XCTAssertEqual(stale.body, fixedBody, "a stale seal")
    for (label, info, lookup) in [
      ("tampered seal", userInfo(sealed: tampered(AlertTestVector.sealed)), holding(registration)),
      ("tampered sk", userInfo(sk: String(repeating: "J", count: 43)), holding(registration)),
      ("no keychain item", userInfo(), holding(nil)),
    ] {
      let original = content(info)
      let delivered = SealedAlertDelivery.rewritten(original, now: fresh, registration: lookup)
      XCTAssertTrue(delivered === original, label)
      XCTAssertEqual(delivered.title, fixedTitle, label)
      XCTAssertEqual(delivered.body, fixedBody, label)
    }
  }

  func testDeliversTheOpenedNotificationOnce() {
    let delivered = expectation(description: "delivered")
    var answers: [UNNotificationContent] = []
    let delivery = SealedAlertDelivery(registration: holding(registration), clock: { fresh })
    delivery.receive(content(userInfo())) { content in
      answers.append(content)
      delivered.fulfill()
    }
    wait(for: [delivered], timeout: 5)
    delivery.expire()
    XCTAssertEqual(answers.map(\.body), ["Fix the flaky login test · Login App"])
  }

  func testRunningOutOfTimeDeliversTheFixedTextAndDropsTheLateAnswer() {
    // A keychain read that has not returned when time runs out.
    let release = DispatchSemaphore(value: 0)
    let lookedUp = expectation(description: "looked up")
    let finished = expectation(description: "the late answer ran")
    let lock = NSLock()
    var answers: [UNNotificationContent] = []
    let delivery = SealedAlertDelivery(
      registration: { rid in
        lookedUp.fulfill()
        release.wait()
        return holding(registration)(rid)
      }, clock: { fresh })
    delivery.receive(content(userInfo())) { content in
      lock.lock()
      answers.append(content)
      lock.unlock()
    }
    wait(for: [lookedUp], timeout: 5)
    delivery.expire()
    lock.lock()
    XCTAssertEqual(answers.map(\.title), [fixedTitle])
    XCTAssertEqual(answers.map(\.body), [fixedBody])
    lock.unlock()
    release.signal()
    // Let the background work finish; its answer must not be delivered.
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { finished.fulfill() }
    wait(for: [finished], timeout: 5)
    lock.lock()
    XCTAssertEqual(answers.count, 1)
    lock.unlock()
  }
}

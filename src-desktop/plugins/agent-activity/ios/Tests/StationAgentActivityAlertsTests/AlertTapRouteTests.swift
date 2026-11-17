import CryptoKit
import Foundation
import XCTest

@testable import StationAgentActivityAlerts
@testable import StationAgentActivityShared

/// The alert test vector's key and ids (NATIVE_PUSH_ALERT_SEALED_TEST_VECTOR
/// in packages/contracts/src/native-push.ts); the plaintexts here add the
/// session reference `composeApnsAlertPlaintext` seals.
private let payloadKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
private let registrationId = "AAECAwQFBgcICQoLDA0ODw"
private let stationId = "11111111-1111-4111-8111-111111111111"
private let stationKey = String(repeating: "K", count: 43)

private let registration = AgentActivityRegistration.valid(
  id: registrationId, stationId: stationId, stationKey: stationKey, payloadKey: payloadKey)!

private func holding(_ stored: AgentActivityRegistration?) -> (String) -> AgentActivityRegistration? {
  { rid in rid == stored?.id ? stored : nil }
}

private func seal(_ fields: [String: String], domain: String = CardOpener.alertDomain) throws -> String {
  let plaintext = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
  let box = try AES.GCM.seal(
    plaintext,
    using: SymmetricKey(data: Base64URL.decode(payloadKey)!),
    authenticating: CardOpener.associatedData(registrationId: registrationId, domain: domain))
  return Base64URL.encode(box.combined!)
}

private func alert(_ fields: [String: String], sk: String = stationKey, domain: String = CardOpener.alertDomain)
  throws -> [AnyHashable: Any]
{
  ["station": ["v": 1, "rid": registrationId, "sk": sk, "sealed": try seal(fields, domain: domain)]]
}

private let base: [String: String] = [
  "user_id": stationId, "notification_id": "notif-0001", "urgency": "attention",
  "issued_at": "1800000000000", "title": "Approval needed",
]

final class AlertTapRouteTests: XCTestCase {
  func testATappedAlertOpensItsSessionOnTheRegisteredStation() throws {
    var fields = base
    fields["session_id"] = "thread-1"
    fields["project_slug"] = "login-app"
    XCTAssertEqual(
      AlertTapRouteResolver.resolve(userInfo: try alert(fields), registration: holding(registration)),
      AlertTapRoute(
        stationId: stationId, sessionId: "thread-1", projectSlug: "login-app", notificationId: "notif-0001"))
    fields.removeValue(forKey: "project_slug")
    let route = AlertTapRouteResolver.resolve(userInfo: try alert(fields), registration: holding(registration))
    XCTAssertEqual(
      route?.json as? [String: String],
      ["stationId": stationId, "sessionId": "thread-1", "notificationId": "notif-0001"])
  }

  /// The tap reads its record: the seal's `notification_id` rides the route
  /// to the web opener (`openedNotification`). An id outside the record
  /// grammar drops only the read, never the session.
  func testTheRouteCarriesTheAlertsRecordForItsRead() throws {
    var fields = base
    fields["session_id"] = "thread-1"
    XCTAssertEqual(
      AlertTapRouteResolver.resolve(userInfo: try alert(fields), registration: holding(registration))?.json[
        "notificationId"] as? String,
      "notif-0001")
    for bad in ["", "a/b", "a b", "é", String(repeating: "x", count: 129)] {
      fields["notification_id"] = bad
      let route = AlertTapRouteResolver.resolve(userInfo: try alert(fields), registration: holding(registration))
      XCTAssertEqual(route?.sessionId, "thread-1", bad)
      XCTAssertNil(route?.notificationId, bad)
    }
  }

  func testAnAlertWithoutASessionOpensNothing() throws {
    XCTAssertNil(AlertTapRouteResolver.resolve(userInfo: try alert(base), registration: holding(registration)))
  }

  func testAReferenceOutsideTheGrammarDropsTheWholeRoute() throws {
    for bad in ["", "../x", "a/b", "a b", "-lead", "é", String(repeating: "x", count: 129)] {
      var fields = base
      fields["session_id"] = bad
      XCTAssertNil(
        AlertTapRouteResolver.resolve(userInfo: try alert(fields), registration: holding(registration)), bad)
      fields["session_id"] = "thread-1"
      fields["project_slug"] = bad
      XCTAssertNil(
        AlertTapRouteResolver.resolve(userInfo: try alert(fields), registration: holding(registration)), bad)
    }
  }

  func testEveryCheckTheExtensionMakesStillHolds() throws {
    var fields = base
    fields["session_id"] = "thread-1"
    // Another Station's key, an unknown registration, a card seal, and a
    // seal naming a different Station: nothing opens.
    XCTAssertNil(
      AlertTapRouteResolver.resolve(
        userInfo: try alert(fields, sk: String(repeating: "Z", count: 43)), registration: holding(registration)))
    XCTAssertNil(AlertTapRouteResolver.resolve(userInfo: try alert(fields), registration: holding(nil)))
    XCTAssertNil(
      AlertTapRouteResolver.resolve(
        userInfo: try alert(fields, domain: CardOpener.cardDomain), registration: holding(registration)))
    fields["user_id"] = "22222222-2222-4222-8222-222222222222"
    XCTAssertNil(AlertTapRouteResolver.resolve(userInfo: try alert(fields), registration: holding(registration)))
    XCTAssertNil(AlertTapRouteResolver.resolve(userInfo: [:], registration: holding(registration)))
  }
}

/// A notification-center delegate stand-in that answers taps itself.
private final class AnsweringDelegate: NSObject {
  static var answered: [String] = []
  @objc(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:)
  func didReceive(_ center: AnyObject, response: AnyObject, completion: @escaping () -> Void) {
    Self.answered.append("original")
    completion()
  }
}

/// One that does not implement the callback at all.
private final class SilentDelegate: NSObject {}

final class NotificationResponseHookTests: XCTestCase {
  private typealias Completion = @convention(block) () -> Void
  private typealias ResponseIMP =
    @convention(c) (AnyObject, Selector, AnyObject, AnyObject, Completion) -> Void

  private func tap(_ delegate: NSObject, completion: @escaping () -> Void) {
    let imp = class_getMethodImplementation(
      object_getClass(delegate), NotificationResponseHook.responseSelector)!
    unsafeBitCast(imp, to: ResponseIMP.self)(
      delegate, NotificationResponseHook.responseSelector, NSObject(), NSString(string: "response"),
      completion)
  }

  func testTheListenerSeesTheTapAndTheOriginalStillAnswersIt() {
    AnsweringDelegate.answered = []
    var heard: [String] = []
    XCTAssertTrue(
      NotificationResponseHook.install(on: AnsweringDelegate.self) { response in
        heard.append(response as? String ?? "?")
        AnsweringDelegate.answered.append("listener")
      })
    var completed = 0
    tap(AnsweringDelegate()) { completed += 1 }
    XCTAssertEqual(heard, ["response"])
    XCTAssertEqual(AnsweringDelegate.answered, ["listener", "original"])
    XCTAssertEqual(completed, 1)
    // A second install would report every tap twice.
    XCTAssertFalse(NotificationResponseHook.install(on: AnsweringDelegate.self) { _ in heard.append("twice") })
    tap(AnsweringDelegate()) {}
    XCTAssertEqual(heard, ["response", "response"])
  }

  func testADelegateWithoutTheCallbackStillCompletes() {
    var heard = 0
    XCTAssertTrue(NotificationResponseHook.install(on: SilentDelegate.self) { _ in heard += 1 })
    var completed = 0
    tap(SilentDelegate()) { completed += 1 }
    XCTAssertEqual(heard, 1)
    XCTAssertEqual(completed, 1)
  }
}

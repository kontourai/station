import Foundation
import XCTest

@testable import StationAgentActivityShared

final class CardResolverTests: XCTestCase {
  private let stationKey = String(repeating: "K", count: 43)
  private var registration: AgentActivityRegistration {
    AgentActivityRegistration.valid(
      id: SealedTestVector.registrationId,
      stationId: SealedTestVector.stationId,
      stationKey: stationKey,
      payloadKey: SealedTestVector.payloadKey)!
  }

  private func state(
    v: Int = 1, rid: String = SealedTestVector.registrationId, sk: String?? = .none,
    sealed: String = SealedTestVector.sealed
  ) -> StationAgentActivityAttributes.ContentState {
    StationAgentActivityAttributes.ContentState(
      v: v, rid: rid, sk: sk ?? stationKey, sealed: sealed)
  }

  private func resolve(
    _ state: StationAgentActivityAttributes.ContentState,
    attributesRid: String = SealedTestVector.registrationId,
    now: Date = SealedTestVector.updatedAt,
    contextIsStale: Bool = false,
    registration: AgentActivityRegistration?? = .none
  ) -> AgentActivityCard {
    let stored = registration ?? self.registration
    return AgentActivityCardResolver.resolve(
      state: state, attributesRid: attributesRid, now: now, contextIsStale: contextIsStale
    ) { rid in
      rid == stored?.id ? stored : nil
    }
  }

  private func millis(_ value: Int64) -> Date {
    Date(timeIntervalSince1970: Double(value) / 1000)
  }

  func testRendersTheOpenedCardWhenEveryCheckPasses() {
    guard case .card(let model) = resolve(state()) else {
      return XCTFail("expected the decrypted card")
    }
    XCTAssertEqual(model.phase, .approval)
    XCTAssertEqual(model.summary, "Fix the flaky login test")
    XCTAssertEqual(model.chip, "Approve")
    XCTAssertEqual(model.action, "Approve")
    XCTAssertTrue(model.active)
    XCTAssertEqual(model.hero?.project, "Login App")
  }

  func testAnExpiredCardIsStaleWithNoContent() {
    let expiry = SealedTestVector.expiresAtMillis
    guard case .card = resolve(state(), now: millis(expiry - 1)) else {
      return XCTFail("a card is current until its expiry")
    }
    // `.stale` carries no model: nothing from an expired card can render.
    XCTAssertEqual(resolve(state(), now: millis(expiry)), .stale, "at its expiry")
    XCTAssertEqual(resolve(state(), now: millis(expiry + 60_000)), .stale, "after it")
  }

  func testActivityKitsStaleFlagIsStaleWithNoContent() {
    // The Station's stale date is the expiry rounded down to whole seconds,
    // so ActivityKit can say stale while the card is a moment from expiring.
    let justBefore = millis(SealedTestVector.expiresAtMillis - 500)
    guard case .card = resolve(state(), now: justBefore) else {
      return XCTFail("current without the flag")
    }
    XCTAssertEqual(resolve(state(), now: justBefore, contextIsStale: true), .stale)
  }

  func testACardThatDoesNotVerifyIsThePlaceholderEvenWhenStale() {
    let sealed = SealedTestVector.sealed
    let tampered = String(sealed.dropLast()) + (sealed.last == "P" ? "Q" : "P")
    let late = millis(SealedTestVector.expiresAtMillis + 60_000)
    XCTAssertEqual(resolve(state(sealed: tampered), now: late), .placeholder)
    XCTAssertEqual(resolve(state(sealed: tampered), contextIsStale: true), .placeholder)
    XCTAssertEqual(resolve(state(sk: .some(nil)), now: late), .placeholder, "an unstamped state")
  }

  func testACardWithoutAReadableExpiryIsNotRendered() throws {
    let base =
      #""user_id":"11111111-1111-4111-8111-111111111111","active":"true","activity_line_0":"Working\tA\tB""#
    guard case .card = resolve(
      state(sealed: try SealedTestVector.seal("{\(base),\"activity_expires_at\":\"1800007200000\"}")))
    else { return XCTFail("the same card with an expiry renders") }
    XCTAssertEqual(resolve(state(sealed: try SealedTestVector.seal("{\(base)}"))), .placeholder)
    XCTAssertEqual(
      resolve(state(sealed: try SealedTestVector.seal("{\(base),\"activity_expires_at\":\"soon\"}"))),
      .placeholder)
  }

  func testAnUnknownContentVersionIsNotRendered() {
    XCTAssertEqual(resolve(state(v: 2)), .placeholder)
  }

  func testTheStateMustNameTheActivitysRegistration() {
    XCTAssertEqual(resolve(state(), attributesRid: "AAECAwQFBgcICQoLDA0OEA"), .placeholder)
  }

  func testAnUnregisteredActivityIsNotRendered() {
    XCTAssertEqual(resolve(state(), registration: .some(nil)), .placeholder)
  }

  func testTheGatewayStampedStationKeyMustMatchTheRegistration() {
    XCTAssertEqual(resolve(state(sk: .some(String(repeating: "J", count: 43)))), .placeholder)
    XCTAssertEqual(resolve(state(sk: .some(nil))), .placeholder, "an unstamped state")
  }

  func testABadSealIsNotRendered() {
    let sealed = SealedTestVector.sealed
    let tampered = String(sealed.dropLast()) + (sealed.last == "P" ? "Q" : "P")
    XCTAssertEqual(resolve(state(sealed: tampered)), .placeholder)
  }

  func testTheSealedCardMustComeFromTheRegisteredStation() {
    let other = AgentActivityRegistration.valid(
      id: SealedTestVector.registrationId,
      stationId: "22222222-2222-4222-8222-222222222222",
      stationKey: stationKey,
      payloadKey: SealedTestVector.payloadKey)
    XCTAssertEqual(resolve(state(), registration: .some(other)), .placeholder)
  }
}

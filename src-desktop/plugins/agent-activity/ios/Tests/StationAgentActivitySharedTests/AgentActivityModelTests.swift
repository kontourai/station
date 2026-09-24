import Foundation
import XCTest

@testable import StationAgentActivityShared

/// Mirrors the Android AgentActivityModelTest so both platforms read one card
/// the same way. Deliberate difference: a finished card keeps a chip ("Done"
/// or "Failed") because the Dynamic Island still shows it until dismissal.
final class AgentActivityModelTests: XCTestCase {
  private func line(_ status: String, _ title: String, _ project: String) -> String {
    "\(status)\t\(title)\t\(project)"
  }

  func testRowsKeepSenderOrderAndDropMalformedLines() {
    let rows = activityRows([
      "activity_line_0": line("Approval", "Deploy", "station"),
      "activity_line_1": "no tabs here",
      "activity_line_2": line("Working", " ", "station"),
      "activity_line_3": line("Working", "Refactor", "flow"),
      "activity_line_5": line("Working", "Beyond the row limit", "flow"),
    ])
    XCTAssertEqual(rows.map(\.title), ["Deploy", "Refactor"])
  }

  func testATabInsideTheProjectStaysInTheProject() {
    XCTAssertEqual(
      activityRows(["activity_line_0": "Working\tA\tone\ttwo"]).first?.project, "one\ttwo")
  }

  func testExplicitPhaseWinsOverTheHeroRowStatus() {
    let data = [
      "activity_phase": "waiting_for_input",
      "activity_line_0": line("Working", "Refactor", "station"),
    ]
    XCTAssertEqual(activityPhase(data, rows: activityRows(data)), .input)
  }

  func testUnknownPhaseFallsBackToTheHeroRowStatus() {
    let data = [
      "activity_phase": "not-a-phase",
      "activity_line_0": line("Approval", "Deploy", "station"),
    ]
    XCTAssertEqual(activityPhase(data, rows: activityRows(data)), .approval)
  }

  func testChipCountsLiveAgentsAndCapsAtNinePlus() {
    XCTAssertEqual(
      ActivityModel(data: ["activity_phase": "running", "activity_active_count": "12"], active: true).chip,
      "9+ live")
    XCTAssertEqual(
      ActivityModel(data: ["activity_phase": "running", "activity_active_count": "3"], active: true).chip,
      "3 live")
    XCTAssertEqual(
      ActivityModel(data: ["activity_phase": "running", "activity_active_count": "1"], active: true).chip,
      "Working")
  }

  func testFinishedCardHasNoActionAndReadsDone() {
    let model = ActivityModel(
      data: ["activity_phase": "completed", "activity_line_0": line("Done", "Deploy", "station")],
      active: false)
    XCTAssertNil(model.action)
    XCTAssertEqual(model.chip, "Done")
  }

  func testSummaryNamesTheSingleThreadOrCountsWhatNeedsTheUser() {
    XCTAssertEqual(
      ActivityModel(data: ["activity_line_0": line("Working", "Fix login", "station")], active: true).summary,
      "Fix login")
    XCTAssertEqual(
      ActivityModel(
        data: [
          "activity_line_0": line("Approval", "Deploy", "station"),
          "activity_line_1": line("Input", "Rename", "station"),
          "activity_line_2": line("Working", "Refactor", "station"),
        ], active: true
      ).summary, "2 need you")
    XCTAssertEqual(
      ActivityModel(
        data: [
          "activity_line_0": line("Done", "Deploy", "station"),
          "activity_line_1": line("Failed", "Rename", "station"),
        ], active: false
      ).summary, "Finished, 1 failed")
  }

  func testExplicitCountsOverrideRowDerivedCounts() {
    let data = [
      "activity_line_0": line("Working", "A", "station"),
      "activity_line_1": line("Working", "B", "station"),
      "activity_active_count": "7",
    ]
    XCTAssertEqual(ActivityModel(data: data, active: true).summary, "7 working")
  }
}

final class RegistrationTests: XCTestCase {
  func testRegistrationShapeMatchesAndroid() {
    let key = String(repeating: "K", count: 43)
    XCTAssertNotNil(
      AgentActivityRegistration.valid(id: "reg_0123456789abcdef", stationId: "s", stationKey: key, payloadKey: key))
    XCTAssertNil(
      AgentActivityRegistration.valid(id: "short", stationId: "s", stationKey: key, payloadKey: key))
    XCTAssertNil(
      AgentActivityRegistration.valid(id: "reg_0123456789abcdef", stationId: " ", stationKey: key, payloadKey: key))
    XCTAssertNil(
      AgentActivityRegistration.valid(
        id: "reg_0123456789abcdef", stationId: "s", stationKey: key + "K", payloadKey: key))
    XCTAssertNil(
      AgentActivityRegistration.valid(
        id: "reg_0123456789abcdef", stationId: "s", stationKey: key, payloadKey: "+" + key.dropFirst()))
  }

  /// The widget reads while the phone is locked, and a registration must
  /// never leave the device, so both properties are pinned on the write.
  func testKeychainItemsAreDeviceOnlyAndReadableAfterFirstUnlock() throws {
    let key = String(repeating: "K", count: 43)
    let registration = try XCTUnwrap(
      AgentActivityRegistration.valid(
        id: "reg_0123456789abcdef", stationId: "s", stationKey: key, payloadKey: key))
    let query = try RegistrationKeychain(accessGroup: "TEAM.io.kontourai.station.agentactivity")
      .addQuery(for: registration)
    XCTAssertEqual(
      query[kSecAttrAccessible as String] as? String,
      kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    XCTAssertEqual(query[kSecAttrSynchronizable as String] as? Bool, false)
    XCTAssertEqual(
      query[kSecAttrAccessGroup as String] as? String, "TEAM.io.kontourai.station.agentactivity")
    XCTAssertEqual(query[kSecAttrAccount as String] as? String, "reg_0123456789abcdef")
    XCTAssertEqual(query[kSecAttrService as String] as? String, RegistrationKeychain.service)
    let stored = try XCTUnwrap(query[kSecValueData as String] as? Data)
    let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: stored) as? [String: String])
    XCTAssertEqual(Set(fields.keys), ["stationId", "stationKey", "payloadKey"])
  }
}

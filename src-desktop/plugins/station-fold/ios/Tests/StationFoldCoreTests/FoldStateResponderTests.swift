import Foundation
import XCTest

@testable import StationFoldCore

/// Readings as the plugin saw them on a cold launch into Book (2026-11-05,
/// iPhone Duo simulator, iOS 27.1): nothing at install, then the hinge and the
/// division region about half a second later, with no posture change.
private let viewport = FoldViewport(width: 951, height: 669)
private let launchReading = FoldReading(supported: true, hinge: nil, regions: [], viewport: viewport)
private let bookReading = FoldReading(
  supported: true,
  hinge: FoldHinge(status: "partially-open", angle: 90),
  regions: [FoldRegion(x: 455.5, y: 0, width: 40, height: 669)],
  viewport: viewport)

/// The display, as a test sets it, and every `change` the responder emitted.
private final class Harness {
  var display = launchReading
  var emitted: [FoldSnapshot] = []
  var scheduled: [(delay: Double, work: () -> Void)] = []
  lazy var responder = FoldStateResponder(
    read: { [unowned self] in self.display },
    emit: { [unowned self] in self.emitted.append($0) })

  func start() { responder.start { delay, work in self.scheduled.append((delay, work)) } }
  func runFollowUps() { for entry in scheduled { entry.work() } }
}

final class FoldStateResponderTests: XCTestCase {
  func testStateAnswersAFreshReadingNotTheCachedOne() {
    let harness = Harness()
    harness.start()
    XCTAssertEqual(harness.responder.state().regions, [])
    // The region appears with no UIKit callback at all.
    harness.display = bookReading
    let reply = harness.responder.state()
    XCTAssertEqual(reply.regions, bookReading.regions)
    XCTAssertEqual(reply.hinge, bookReading.hinge)
    XCTAssertEqual(reply.revision, 2)
    // A moved reading is pushed too, for a page that is listening.
    XCTAssertEqual(harness.emitted.last, reply)
  }

  func testFollowUpReadsFindARegionNoCallbackAnnounced() {
    let harness = Harness()
    harness.start()
    XCTAssertEqual(harness.emitted.map(\.revision), [1])
    XCTAssertEqual(harness.scheduled.map(\.delay), FoldStateResponder.followUpReadsSeconds)
    harness.display = bookReading
    harness.runFollowUps()
    // One emit for the reading that moved; the later follow-ups saw no change.
    XCTAssertEqual(harness.emitted.map(\.revision), [1, 2])
    XCTAssertEqual(harness.emitted.last?.regions, bookReading.regions)
  }

  func testAnUnchangedReadingKeepsItsRevisionAndEmitsNothing() {
    let harness = Harness()
    harness.display = bookReading
    harness.start()
    let first = harness.responder.state()
    let again = harness.responder.state()
    harness.responder.observe()
    XCTAssertEqual(first, again)
    XCTAssertEqual(harness.emitted.count, 1)
  }

  /// The page's parser (`foldGeometry.ts`) relies on this shape: camel-case
  /// keys, and an absent `hinge` key rather than null before the first update.
  func testSnapshotEncodesTheShapeThePageParses() throws {
    let harness = Harness()
    harness.start()
    let launch = try JSONSerialization.jsonObject(
      with: JSONEncoder().encode(harness.responder.state())) as? [String: Any]
    XCTAssertEqual(Set(launch?.keys.map { $0 } ?? []), ["revision", "supported", "regions", "viewport"])
    harness.display = bookReading
    let book = try JSONSerialization.jsonObject(
      with: JSONEncoder().encode(harness.responder.state())) as? [String: Any]
    XCTAssertEqual(
      Set(book?.keys.map { $0 } ?? []), ["revision", "supported", "hinge", "regions", "viewport"])
    let region = (book?["regions"] as? [[String: Any]])?.first
    XCTAssertEqual(region?["x"] as? Double, 455.5)
    XCTAssertEqual((book?["hinge"] as? [String: Any])?["status"] as? String, "partially-open")
  }
}

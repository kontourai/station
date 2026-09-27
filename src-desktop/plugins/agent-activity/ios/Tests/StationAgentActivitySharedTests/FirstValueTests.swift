import Foundation
import XCTest

@testable import StationAgentActivityShared

/// A sequence that never yields and ignores cancellation, the worst case for
/// ActivityKit's `pushToStartTokenUpdates` when no token ever arrives.
private struct NeverYields: AsyncSequence {
  typealias Element = Int
  struct AsyncIterator: AsyncIteratorProtocol {
    mutating func next() async -> Int? {
      await withCheckedContinuation { (_: CheckedContinuation<Void, Never>) in }
      return nil
    }
  }
  func makeAsyncIterator() -> AsyncIterator { AsyncIterator() }
}

private final class Deliveries: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [Int?] = []
  func append(_ value: Int?) {
    lock.lock()
    values.append(value)
    lock.unlock()
  }
  var all: [Int?] {
    lock.lock()
    defer { lock.unlock() }
    return values
  }
}

final class FirstValueTests: XCTestCase {
  func testTimeoutsThatWouldOverflowAreClampedNotTrapped() async {
    XCTAssertEqual(deadlineNanoseconds(2), 2_000_000_000)
    XCTAssertEqual(deadlineNanoseconds(-1), 0)
    XCTAssertEqual(deadlineNanoseconds(.nan), 0)
    let year: UInt64 = 365 * 24 * 60 * 60 * 1_000_000_000
    XCTAssertEqual(deadlineNanoseconds(.infinity), year)
    XCTAssertEqual(deadlineNanoseconds(1e300), year)
    // End to end: an unbounded wait still answers with the first value.
    let first = await firstValue(timeout: .infinity) {
      AsyncStream<Int> { continuation in continuation.yield(3) }
    }
    XCTAssertEqual(first, 3)
  }

  func testReturnsTheFirstValue() async {
    let first = await firstValue(timeout: 5) {
      AsyncStream<Int> { continuation in
        continuation.yield(7)
        continuation.yield(8)
      }
    }
    XCTAssertEqual(first, 7)
  }

  func testAnEndedSequenceGivesNil() async {
    let first = await firstValue(timeout: 5) { AsyncStream<Int> { $0.finish() } }
    XCTAssertNil(first)
  }

  /// The deadline must answer even when the reader never returns. Run on an
  /// unstructured task so a hang fails this test instead of stalling the run.
  func testTheDeadlineAnswersEvenIfTheSequenceIgnoresCancellation() {
    let answered = expectation(description: "answered at the deadline")
    Task {
      let first = await firstValue(timeout: 0.2) { NeverYields() }
      XCTAssertNil(first)
      answered.fulfill()
    }
    wait(for: [answered], timeout: 5)
  }

  /// A value, then the deadline passing later, is still one answer: the
  /// caller gets the value and nothing resumes it a second time (which would
  /// trap on the checked continuation).
  func testAValueBeforeTheDeadlineIsTheOnlyAnswer() async throws {
    let first = await firstValue(timeout: 0.1) { AsyncStream<Int> { $0.yield(3) } }
    XCTAssertEqual(first, 3)
    try await Task.sleep(nanoseconds: 300_000_000)
  }

  func testTheCallersCancellationAnswersNil() {
    let answered = expectation(description: "answered on cancellation")
    let caller = Task {
      let first = await firstValue(timeout: 60) { NeverYields() }
      XCTAssertNil(first)
      answered.fulfill()
    }
    Task {
      try? await Task.sleep(nanoseconds: 100_000_000)
      caller.cancel()
    }
    wait(for: [answered], timeout: 5)
  }

  func testResumeOnceDeliversOnlyTheFirstAnswer() {
    let deliveries = Deliveries()
    let once = ResumeOnce<Int>()
    once.install { deliveries.append($0) }
    once.resume(5)
    once.resume(nil)
    once.resume(9)
    XCTAssertEqual(deliveries.all, [5])
  }

  func testAnAnswerBeforeInstallIsDeliveredOnInstall() {
    let deliveries = Deliveries()
    let once = ResumeOnce<Int>()
    once.resume(nil)
    once.install { deliveries.append($0) }
    XCTAssertEqual(deliveries.all, [nil])
  }
}

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

final class FirstValueTests: XCTestCase {
  func testReturnsTheFirstValue() async {
    let values = AsyncStream<Int> { continuation in
      continuation.yield(7)
      continuation.yield(8)
    }
    let first = await firstValue(of: values, timeout: 5)
    XCTAssertEqual(first, 7)
  }

  func testAnEndedSequenceGivesNil() async {
    let first = await firstValue(of: AsyncStream<Int> { $0.finish() }, timeout: 5)
    XCTAssertNil(first)
  }

  /// The deadline must answer even when the reader never returns. Run on an
  /// unstructured task so a hang fails this test instead of stalling the run.
  func testTheDeadlineAnswersEvenIfTheSequenceIgnoresCancellation() {
    let answered = expectation(description: "answered at the deadline")
    Task {
      let first = await firstValue(of: NeverYields(), timeout: 0.2)
      XCTAssertNil(first)
      answered.fulfill()
    }
    wait(for: [answered], timeout: 5)
  }
}

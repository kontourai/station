import Foundation

/// The first element `sequence` produces, or nil once `seconds` pass.
///
/// A task group cannot express this: it returns only after every child
/// finishes, and a sequence that ignores cancellation (ActivityKit's
/// `pushToStartTokenUpdates` is not documented to honour it) would keep the
/// caller waiting forever. Here the reader runs in its own task, whichever
/// of value, end or deadline comes first resumes the caller exactly once,
/// and the reader is cancelled and left behind if it never returns.
public func firstValue<S: AsyncSequence>(of sequence: S, timeout seconds: Double) async -> S.Element? {
  await withCheckedContinuation { (continuation: CheckedContinuation<S.Element?, Never>) in
    let resume = ResumeOnce(continuation)
    let reader = Task {
      do {
        for try await value in sequence {
          resume(value)
          return
        }
      } catch {}
      resume(nil)
    }
    Task {
      try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
      resume(nil)
      reader.cancel()
    }
  }
}

private final class ResumeOnce<Value> {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Value?, Never>?

  init(_ continuation: CheckedContinuation<Value?, Never>) {
    self.continuation = continuation
  }

  func callAsFunction(_ value: Value?) {
    lock.lock()
    let pending = continuation
    continuation = nil
    lock.unlock()
    pending?.resume(returning: value)
  }
}

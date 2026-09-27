import Foundation

/// The first element of the sequence `makeSequence` builds, or nil once
/// `seconds` pass, the sequence ends, or the calling task is cancelled.
///
/// A task group cannot express this: it returns only after every child
/// finishes, and a sequence that ignores cancellation (ActivityKit's
/// `pushToStartTokenUpdates` is not documented to honour it) would keep the
/// caller waiting forever. Here the reader and the deadline run as their own
/// tasks, whichever outcome comes first answers the caller exactly once, and
/// both tasks are then cancelled; a reader that never returns is left behind.
///
/// The sequence is built inside the reader task, so it need not be Sendable
/// (ActivityKit's `PushTokenUpdates` is not); only its elements cross tasks.
public func firstValue<S: AsyncSequence>(
  timeout seconds: Double,
  of makeSequence: @escaping @Sendable () -> S
) async -> S.Element?
where S: SendableMetatype, S.AsyncIterator: SendableMetatype, S.Element: Sendable {
  let once = ResumeOnce<S.Element>()
  return await withTaskCancellationHandler {
    await withCheckedContinuation { (continuation: CheckedContinuation<S.Element?, Never>) in
      once.install { continuation.resume(returning: $0) }
      once.track(
        Task {
          do {
            for try await value in makeSequence() {
              once.resume(value)
              return
            }
          } catch {}
          once.resume(nil)
        })
      once.track(
        Task {
          do {
            try await Task.sleep(nanoseconds: deadlineNanoseconds(seconds))
          } catch {
            return  // Cancelled because another outcome already answered.
          }
          once.resume(nil)
        })
    }
  } onCancel: {
    once.resume(nil)
  }
}

/// `seconds` as a sleep length: negative and NaN mean now, and anything past
/// a year (including infinity) is a year, where `UInt64(seconds * 1e9)`
/// would trap.
func deadlineNanoseconds(_ seconds: Double) -> UInt64 {
  let year = 365.0 * 24 * 60 * 60
  guard seconds > 0 else { return 0 }  // Also NaN.
  return UInt64(min(seconds, year) * 1_000_000_000)
}

/// Delivers one answer and cancels the tasks racing to give it. Every member
/// is read and written under `lock`, hence the unchecked Sendable.
final class ResumeOnce<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var answered = false
  private var answer: Value?
  private var deliver: (@Sendable (Value?) -> Void)?
  private var tasks: [Task<Void, Never>] = []

  /// Where the answer goes. An answer given before this (the caller was
  /// cancelled first) is delivered at once.
  func install(_ deliver: @escaping @Sendable (Value?) -> Void) {
    lock.lock()
    if answered {
      let answer = self.answer
      lock.unlock()
      deliver(answer)
      return
    }
    self.deliver = deliver
    lock.unlock()
  }

  func track(_ task: Task<Void, Never>) {
    lock.lock()
    if answered {
      lock.unlock()
      task.cancel()
      return
    }
    tasks.append(task)
    lock.unlock()
  }

  func resume(_ value: Value?) {
    lock.lock()
    guard !answered else {
      lock.unlock()
      return
    }
    // `answered` is the only thing that makes this exactly-once: every
    // later call returns at the guard above.
    answered = true
    answer = value
    let deliver = self.deliver
    let tasks = self.tasks
    self.tasks = []
    lock.unlock()
    for task in tasks { task.cancel() }
    deliver?(value)
  }
}

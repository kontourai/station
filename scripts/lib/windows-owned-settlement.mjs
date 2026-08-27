/**
 * Coordinates the receiver-visible completion barrier for the Windows owned
 * command launcher. A successful completion must wait for the guard to exit,
 * both raw output sources to reach EOF, and every destination write callback.
 */
export function createWindowsOwnedSettlement({ onComplete, onAbortSettled }) {
  let complete;
  let guardClosed = false;
  let aborted = false;
  let ready = false;
  const rawEnded = [false, false];
  const rawPendingWrites = [0, 0];

  const settle = () => {
    if (ready || !guardClosed || !rawEnded.every(Boolean)) return false;
    if (!rawPendingWrites.every((count) => count === 0)) return false;
    if (!aborted && complete === undefined) return false;
    ready = true;
    if (aborted) onAbortSettled?.();
    else onComplete(complete);
    return true;
  };

  return {
    abort() {
      aborted = true;
      return settle();
    },
    complete(status) {
      complete = status;
      return settle();
    },
    guardClose(ok) {
      if (!ok) {
        aborted = true;
      }
      guardClosed = true;
      return settle();
    },
    rawEnd(index) {
      rawEnded[index] = true;
      return settle();
    },
    writeStart(index) {
      rawPendingWrites[index] += 1;
    },
    writeFinish(index) {
      if (rawPendingWrites[index] === 0)
        throw new Error('Windows owned raw write completed without a start');
      rawPendingWrites[index] -= 1;
      return settle();
    },
  };
}

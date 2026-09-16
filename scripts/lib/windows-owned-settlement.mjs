/**
 * Coordinates the receiver-visible completion barrier for the Windows owned
 * command launcher. A successful completion must wait for the guard to exit,
 * both raw output sources to reach EOF, and every destination write callback.
 */
export function createWindowsOwnedSettlement({
  onComplete,
  onAbortSettled,
  onState,
}) {
  let complete;
  let guardClosed = false;
  let guardCloseOk = null;
  let aborted = false;
  let ready = false;
  const rawEnded = [false, false];
  const rawPendingWrites = [0, 0];

  const state = () => ({
    complete: complete !== undefined,
    completeStatus: complete ?? null,
    guardClosed,
    guardCloseOk,
    stdoutEof: rawEnded[0],
    stderrEof: rawEnded[1],
    stdoutDrained: rawPendingWrites[0] === 0,
    stderrDrained: rawPendingWrites[1] === 0,
    acknowledged: ready,
    aborted,
  });

  const publishState = () => {
    try {
      onState?.(state());
    } catch {
      // Diagnostics cannot change settlement or command terminal behavior.
    }
  };

  const settle = () => {
    if (ready || !guardClosed || !rawEnded.every(Boolean)) return false;
    if (!rawPendingWrites.every((count) => count === 0)) return false;
    if (!aborted && complete === undefined) return false;
    ready = true;
    publishState();
    if (aborted) onAbortSettled?.();
    else onComplete(complete);
    return true;
  };

  return {
    abort() {
      aborted = true;
      publishState();
      return settle();
    },
    complete(status) {
      complete = status;
      publishState();
      return settle();
    },
    guardClose(ok) {
      guardCloseOk = ok;
      if (!ok) {
        aborted = true;
      }
      guardClosed = true;
      publishState();
      return settle();
    },
    rawEnd(index) {
      rawEnded[index] = true;
      publishState();
      return settle();
    },
    writeStart(index) {
      rawPendingWrites[index] += 1;
    },
    writeFinish(index) {
      if (rawPendingWrites[index] === 0)
        throw new Error('Windows owned raw write completed without a start');
      rawPendingWrites[index] -= 1;
      if (rawEnded[index] && rawPendingWrites[index] === 0) publishState();
      return settle();
    },
    state,
  };
}

/** Best-effort diagnostic IPC; it never owns command settlement. */
export function publishWindowsOwnedSettlementState(channel, state) {
  if (channel?.connected !== true || typeof channel.send !== 'function')
    return false;
  try {
    channel.send({ type: 'owned-command-settlement-state', state }, () => {});
    return true;
  } catch {
    return false;
  }
}

import { describe, expect, it } from 'vitest';
import {
  createWindowsOwnedSettlement,
  publishWindowsOwnedSettlementState,
} from '../lib/windows-owned-settlement.mjs';

function recorder() {
  const published: number[] = [];
  const states: Record<string, unknown>[] = [];
  let aborts = 0;
  return {
    aborts: () => aborts,
    published,
    states,
    settlement: createWindowsOwnedSettlement({
      onComplete: (status) => published.push(status),
      onAbortSettled: () => {
        aborts += 1;
      },
      onState: (state) => states.push(state),
    }),
  };
}

describe('Windows owned launcher settlement', () => {
  it('holds completion when raw callbacks and EOF arrive before COMPLETE', () => {
    const { published, settlement } = recorder();

    settlement.writeStart(0);
    settlement.rawEnd(0);
    settlement.rawEnd(1);
    settlement.guardClose(true);
    settlement.writeFinish(0);
    expect(published).toEqual([]);

    settlement.complete(0);
    expect(published).toEqual([0]);
  });

  it('holds completion when COMPLETE arrives before raw EOF', () => {
    const { published, settlement, states } = recorder();

    settlement.complete(0);
    settlement.guardClose(true);
    expect(published).toEqual([]);

    settlement.rawEnd(0);
    expect(published).toEqual([]);
    expect(states.at(-1)).toMatchObject({
      complete: true,
      guardClosed: true,
      stdoutEof: true,
      stderrEof: false,
      stdoutDrained: true,
      stderrDrained: true,
      acknowledged: false,
    });
    settlement.rawEnd(1);
    expect(published).toEqual([0]);
    expect(states.at(-1)).toMatchObject({
      stdoutEof: true,
      stderrEof: true,
      acknowledged: true,
    });
  });

  it('waits for all pending raw destination writes', () => {
    const { published, settlement } = recorder();

    settlement.writeStart(0);
    settlement.writeStart(1);
    settlement.complete(0);
    settlement.guardClose(true);
    settlement.rawEnd(0);
    settlement.rawEnd(1);
    settlement.writeFinish(0);
    expect(published).toEqual([]);

    settlement.writeFinish(1);
    expect(published).toEqual([0]);
  });

  it('gives guard failure and abort precedence over later success signals', () => {
    const { aborts, published, settlement } = recorder();

    settlement.complete(0);
    settlement.guardClose(false);
    settlement.rawEnd(0);
    settlement.rawEnd(1);
    expect(published).toEqual([]);
    expect(aborts()).toBe(1);

    settlement.abort();
    expect(published).toEqual([]);
  });

  it('acknowledges post-resume abort only after guard close and raw output settlement', () => {
    const { aborts, settlement } = recorder();

    settlement.abort();
    settlement.writeStart(0);
    settlement.rawEnd(0);
    settlement.rawEnd(1);
    expect(aborts()).toBe(0);

    settlement.guardClose(false);
    expect(aborts()).toBe(0);
    settlement.writeFinish(0);
    expect(aborts()).toBe(1);
  });

  it('publishes a successful COMPLETE 0 once all barriers are met', () => {
    const { aborts, published, settlement } = recorder();

    settlement.complete(0);
    settlement.guardClose(true);
    settlement.rawEnd(0);
    settlement.rawEnd(1);
    expect(published).toEqual([0]);

    // Success has established terminal Job/raw-output proof. A later abort
    // request cannot require a second acknowledgement from the launcher.
    settlement.abort();
    expect(aborts()).toBe(0);
    expect(published).toEqual([0]);
  });

  it('preserves settlement when the diagnostic observer throws', () => {
    const published: number[] = [];
    const settlement = createWindowsOwnedSettlement({
      onComplete: (status) => published.push(status),
      onState: () => {
        throw new Error('diagnostic observer failed');
      },
    });

    settlement.complete(0);
    settlement.guardClose(true);
    settlement.rawEnd(0);
    settlement.rawEnd(1);
    expect(published).toEqual([0]);
  });

  it('ignores disconnected and throwing diagnostic IPC channels', () => {
    expect(
      publishWindowsOwnedSettlementState(
        { connected: false, send: () => true },
        { complete: true },
      ),
    ).toBe(false);
    expect(
      publishWindowsOwnedSettlementState(
        {
          connected: true,
          send: () => {
            throw new Error('IPC closed');
          },
        },
        { complete: true },
      ),
    ).toBe(false);
  });
});

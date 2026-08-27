import { describe, expect, it } from 'vitest';
import { createWindowsOwnedSettlement } from '../lib/windows-owned-settlement.mjs';

function recorder() {
  const published: number[] = [];
  let aborts = 0;
  return {
    aborts: () => aborts,
    published,
    settlement: createWindowsOwnedSettlement({
      onComplete: (status) => published.push(status),
      onAbortSettled: () => {
        aborts += 1;
      },
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
    const { published, settlement } = recorder();

    settlement.complete(0);
    settlement.guardClose(true);
    expect(published).toEqual([]);

    settlement.rawEnd(0);
    expect(published).toEqual([]);
    settlement.rawEnd(1);
    expect(published).toEqual([0]);
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
});

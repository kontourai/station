/**
 * station#1778 delta review, finding 2 — `observedBy` IS the argument.
 *
 * The whole reason `answerability: false` carries an observer and a timestamp
 * is that "no adapter for this provider" is a fact about ONE process at ONE
 * moment, not about the session. Strip the observer and the claim degrades to
 * the label-vs-derivation defect the decoration exists to prevent.
 *
 * The verifier proved this was unpinned: collapsing `servingInstanceIdentity()`
 * to the constant `'station'` — destroying exactly the two-instances-on-one-
 * host distinction the module's own doc says the pid provides — left 125 tests
 * green, and this module had no test file at all. That is the repo's master
 * defect class landing on the field introduced to prevent it, so the property
 * is pinned here directly rather than via `expect.any(String)` somewhere else.
 *
 * The module memoises at import, which is correct for production (the identity
 * cannot change within a process) and means every case here re-imports under
 * `vi.resetModules()`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

async function freshIdentity(instanceId?: string): Promise<string> {
  vi.resetModules();
  if (instanceId === undefined) delete process.env.STATION_INSTANCE_ID;
  else process.env.STATION_INSTANCE_ID = instanceId;
  const { servingInstanceIdentity } = await import('../serving-instance.js');
  return servingInstanceIdentity();
}

describe('servingInstanceIdentity', () => {
  const original = process.env.STATION_INSTANCE_ID;

  beforeEach(() => {
    delete process.env.STATION_INSTANCE_ID;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.STATION_INSTANCE_ID;
    else process.env.STATION_INSTANCE_ID = original;
    vi.resetModules();
  });

  test('carries the operator-facing instance name when one is configured', async () => {
    expect(await freshIdentity('phone')).toContain('phone');
  });

  test('always carries THIS process id, named or not', async () => {
    // The part that actually distinguishes. Asserted for both the named and
    // the unnamed case, because the unnamed case is the one where the label
    // alone identifies nothing.
    expect(await freshIdentity('phone')).toBe(`phone#${process.pid}`);
    expect(await freshIdentity()).toBe(`default#${process.pid}`);
  });

  test('two unnamed instances on one host are still distinguishable', async () => {
    // The exact scenario the doc claims the pid buys, stated as the
    // difference it must produce. `STATION_INSTANCE_ID` is unset for both, so
    // the LABEL is identical ('default') — if the identity were the label
    // alone, these would collide and one Station's observation would be
    // indistinguishable from the other's.
    const mine = await freshIdentity();
    const asIfOtherProcess = `default#${process.pid + 1}`;
    expect(mine).not.toBe(asIfOtherProcess);
    expect(mine.split('#')[0]).toBe(asIfOtherProcess.split('#')[0]);
  });

  test('the identity is not a bare constant', async () => {
    // Directly the shape the verifier injected: a fixed string would satisfy
    // every `expect.any(String)` assertion in the suite while destroying the
    // distinction the wire field exists to carry.
    const identity = await freshIdentity('alpha');
    expect(identity).not.toBe('station');
    expect(identity).not.toBe('default');
    expect(identity).toMatch(/^alpha#\d+$/);
  });

  test('an empty STATION_INSTANCE_ID falls back rather than yielding a bare pid', async () => {
    // `STATION_INSTANCE_ID=` is a realistic shell value (an unset variable
    // expanded in a wrapper script). `||` treats it as absent, which is the
    // intent; `??` would not, and would silently produce `#<pid>` — an
    // identity whose readable half is missing (delta review, finding 2
    // residual). No test covered the difference.
    expect(await freshIdentity('')).toBe(`default#${process.pid}`);
  });

  test('is stable within a process', async () => {
    vi.resetModules();
    const { servingInstanceIdentity } = await import('../serving-instance.js');
    expect(servingInstanceIdentity()).toBe(servingInstanceIdentity());
  });
});

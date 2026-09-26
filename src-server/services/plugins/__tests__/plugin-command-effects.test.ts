import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OperationalEventEnvelope } from '@kontourai/station-contracts/operational-event';
import { PLUGIN_COMMAND_EFFECT_REQUEST_WINDOW_MS } from '@kontourai/station-contracts/plugin-command-effect';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  createPluginCommandEffectService,
  FilePluginCommandEffectStore,
  PLUGIN_COMMAND_EFFECT_BOUNDS,
  type PluginCommandEffectAdmissionRecord,
  PluginCommandEffectsUnavailableError,
  settlePluginCommandEffectsForResponse,
  withdrawPluginCommandEffects,
} from '../plugin-command-effects.js';

// Removed in an after-hook even when an assertion fails (#2421).
const makeTempDir = trackTempDirs();

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const DOCUMENT = 'document-0001';
const KEY = 'k'.repeat(43);
const START = Date.parse('2026-09-16T12:00:00.000Z');
const WAIT = 60_000;

function home() {
  const dir = makeTempDir('station-command-effects-');
  return dir;
}

function harness(
  dir = home(),
  options: {
    beforeCommit?: () => void | Promise<void>;
    publishAudit?: (event: OperationalEventEnvelope) => boolean;
    clock?: { now: number };
  } = {},
) {
  const clock = options.clock ?? { now: START };
  const conflicts = vi.fn();
  const events: OperationalEventEnvelope[] = [];
  const service = createPluginCommandEffectService({
    store: new FilePluginCommandEffectStore(dir, {
      beforeCommit: options.beforeCommit,
    }),
    now: () => new Date(clock.now),
    indeterminateAfterMs: WAIT,
    publishAudit:
      options.publishAudit ??
      ((event) => {
        events.push(event);
        return true;
      }),
    onSettlementConflict: conflicts,
  });
  return {
    dir,
    clock,
    service,
    conflicts,
    events,
    advance(ms: number) {
      clock.now += ms;
    },
    ledger: () =>
      JSON.parse(
        readFileSync(join(dir, 'plugin-command-effects.json'), 'utf8'),
      ) as {
        effects: Array<{
          effectId: string;
          state: string;
          pluginId: string;
          settledBy?: string;
          lateOutcome?: string;
          conflicts: number;
        }>;
        withdrawals: Array<{ withdrawalId: string }>;
        tombstones: unknown[];
      },
  };
}
type Harness = ReturnType<typeof harness>;

let requestCounter = 0;
function admission(
  h: Pick<Harness, 'clock'>,
  overrides: Partial<PluginCommandEffectAdmissionRecord> = {},
): PluginCommandEffectAdmissionRecord {
  requestCounter += 1;
  return {
    principalId: 'local-operator',
    pluginId: 'demo',
    installationGeneration: '["incarnation-1","digest-1"]',
    requiresPluginServer: false,
    commandId: 'demo.open',
    target: { kind: 'destination', destinationId: 'plugins' },
    content: { kind: 'navigate', destinationId: 'plugins' },
    documentId: DOCUMENT,
    documentKey: KEY,
    requestId: `request-${String(requestCounter).padStart(4, '0')}`,
    issuedAt: h.clock.now,
    ...overrides,
  };
}

async function admit(h: Harness, input = admission(h)) {
  const outcome = await h.service.recordAdmission(input);
  if (outcome.kind !== 'admitted')
    throw new Error(`expected admission, got ${outcome.reason}`);
  return { input, receipt: outcome.receipt };
}

const settleOne = (
  h: Harness,
  input: PluginCommandEffectAdmissionRecord,
  outcome: 'applied' | 'aborted' | 'cancelled' | 'abandoned',
  extra: { effectId?: string; principalId?: string; documentKey?: string } = {},
) =>
  h.service.settle({
    principalId: extra.principalId ?? input.principalId,
    documentId: input.documentId,
    documentKey: extra.documentKey ?? input.documentKey,
    items: [
      {
        requestId: input.requestId,
        ...(extra.effectId ? { effectId: extra.effectId } : {}),
        outcome,
      },
    ],
  });

const withdrawAll = (
  h: Harness,
  cause: 'removal' | 'update' | 'grant-withdrawal' = 'removal',
  pluginId = 'demo',
) => h.service.beginWithdrawal({ pluginId, cause, captures: () => true });

async function captured(h: Harness, cause?: 'removal' | 'update') {
  const summary = await withdrawAll(h, cause);
  if (!summary) throw new Error('expected a withdrawal that captured effects');
  return summary;
}

describe('plugin command effect admission (LP-A)', () => {
  test('is idempotent on (documentId, requestId) and refuses a conflicting retry', async () => {
    const h = harness();
    const input = admission(h);
    const first = await admit(h, input);
    await expect(h.service.recordAdmission(input)).resolves.toEqual({
      kind: 'admitted',
      receipt: first.receipt,
    });
    await expect(
      h.service.recordAdmission({ ...input, commandId: 'demo.other' }),
    ).resolves.toEqual({ kind: 'refused', reason: 'request-conflict' });
    expect(h.ledger().effects).toHaveLength(1);
  });

  test('L6: request identity is scoped to principal and document key, so nobody else gets a conflict oracle', async () => {
    const h = harness();
    const input = admission(h);
    await admit(h, input);
    const otherPrincipal = await h.service.recordAdmission({
      ...input,
      principalId: 'device:someone',
      commandId: 'demo.other',
    });
    const otherKey = await h.service.recordAdmission({
      ...input,
      documentKey: 'x'.repeat(43),
      commandId: 'demo.other',
    });
    expect(otherPrincipal).toMatchObject({ kind: 'admitted' });
    expect(otherKey).toMatchObject({ kind: 'admitted' });
    expect(h.ledger().effects).toHaveLength(3);
  });

  test('refuses a request issued outside the window in either direction', async () => {
    const h = harness();
    const window = PLUGIN_COMMAND_EFFECT_REQUEST_WINDOW_MS;
    await expect(
      h.service.recordAdmission(admission(h, { issuedAt: START - window - 1 })),
    ).resolves.toEqual({ kind: 'refused', reason: 'request-expired' });
    await expect(
      h.service.recordAdmission(admission(h, { issuedAt: START + window + 1 })),
    ).resolves.toEqual({ kind: 'refused', reason: 'request-expired' });
    await expect(
      h.service.recordAdmission(admission(h, { issuedAt: START - window })),
    ).resolves.toMatchObject({ kind: 'admitted' });
  });

  test('the receipt carries exactly the server-read effect content', async () => {
    const h = harness();
    const { receipt } = await admit(
      h,
      admission(h, {
        target: { kind: 'composer', sessionId: 'session-1' },
        content: {
          kind: 'seed-composer',
          sessionId: 'session-1',
          text: 'Summarize',
        },
      }),
    );
    expect(receipt.effect).toEqual({
      kind: 'seed-composer',
      sessionId: 'session-1',
      text: 'Summarize',
    });
  });

  test('I4: capacity refuses per plugin and in total, and never evicts an outstanding effect', async () => {
    const h = harness();
    const bounds = PLUGIN_COMMAND_EFFECT_BOUNDS;
    const held: string[] = [];
    for (let index = 0; index < bounds.outstandingPerPlugin; index += 1)
      held.push((await admit(h)).receipt.effectId);
    await expect(h.service.recordAdmission(admission(h))).resolves.toEqual({
      kind: 'refused',
      reason: 'capacity',
    });
    for (
      let index = 0;
      index < bounds.retainedTerminalEffects + 8;
      index += 1
    ) {
      const { input } = await admit(
        h,
        admission(h, { pluginId: 'other', commandId: 'other.open' }),
      );
      await settleOne(h, input, 'applied');
    }
    const effects = h.ledger().effects;
    for (const effectId of held)
      expect(effects).toContainEqual(
        expect.objectContaining({ effectId, state: 'admitted' }),
      );

    const g = harness();
    for (let plugin = 0; plugin < 8; plugin += 1)
      for (let index = 0; index < bounds.outstandingPerPlugin; index += 1)
        await admit(
          g,
          admission(g, { pluginId: `p${plugin}`, principalId: `pr-${plugin}` }),
        );
    await expect(
      g.service.recordAdmission(
        admission(g, { pluginId: 'fresh', principalId: 'pr-fresh' }),
      ),
    ).resolves.toEqual({ kind: 'refused', reason: 'capacity' });
  });

  test('M2: one principal reaches its own bound before the global one, and others still admit', async () => {
    const h = harness();
    const bounds = PLUGIN_COMMAND_EFFECT_BOUNDS;
    for (let index = 0; index < bounds.outstandingPerPrincipal; index += 1)
      await admit(h, admission(h, { pluginId: `p${index % 4}` }));
    await expect(
      h.service.recordAdmission(admission(h, { pluginId: 'p9' })),
    ).resolves.toEqual({ kind: 'refused', reason: 'capacity' });
    await expect(
      h.service.recordAdmission(
        admission(h, { pluginId: 'p9', principalId: 'device:other' }),
      ),
    ).resolves.toMatchObject({ kind: 'admitted' });
  });

  test('an audit that is not persisted cancels the admission with station proof and refuses', async () => {
    const h = harness(home(), { publishAudit: () => false });
    const input = admission(h);
    await expect(h.service.recordAdmission(input)).resolves.toEqual({
      kind: 'refused',
      reason: 'unavailable',
    });
    expect(h.ledger().effects).toEqual([
      expect.objectContaining({ state: 'cancelled', settledBy: 'station' }),
    ]);
    await expect(settleOne(h, input, 'cancelled')).resolves.toEqual([
      { requestId: input.requestId, status: 'already-settled' },
    ]);
  });

  test('a beforeCommit fault leaves no half-committed admission', async () => {
    let fail = true;
    const h = harness(home(), {
      beforeCommit: () => {
        if (fail) throw new Error('injected commit fault');
      },
    });
    const input = admission(h);
    await expect(h.service.recordAdmission(input)).resolves.toEqual({
      kind: 'refused',
      reason: 'unavailable',
    });
    expect(() => h.ledger()).toThrow();
    fail = false;
    const { receipt } = await admit(h, input);
    expect(h.ledger().effects).toEqual([
      expect.objectContaining({ effectId: receipt.effectId }),
    ]);
  });

  test('L2: the admission event names the principal and carries no effect content', async () => {
    const h = harness();
    const { receipt } = await admit(
      h,
      admission(h, {
        target: { kind: 'composer', sessionId: 'session-1' },
        content: {
          kind: 'seed-composer',
          sessionId: 'session-1',
          text: 'Never in an event',
        },
      }),
    );
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.payload).toEqual({
      schema: 'station.plugin-command.execution/v1',
      data: {
        effectId: receipt.effectId,
        principalId: 'local-operator',
        pluginId: 'demo',
        installationGeneration: '["incarnation-1","digest-1"]',
        commandId: 'demo.open',
        target: { kind: 'composer', sessionId: 'session-1' },
        outcome: 'admitted',
      },
    });
  });
});

describe('plugin command effect settlement (LP-K)', () => {
  test('first terminal wins; the same outcome is idempotent; a different one is a counted conflict with its own event', async () => {
    const h = harness();
    const { input, receipt } = await admit(h);
    const effectId = receipt.effectId;
    await expect(
      settleOne(h, input, 'applied', { documentKey: 'y'.repeat(43) }),
    ).resolves.toEqual([{ requestId: input.requestId, status: 'not-found' }]);
    await expect(settleOne(h, input, 'applied', { effectId })).resolves.toEqual(
      [{ requestId: input.requestId, status: 'settled' }],
    );
    await expect(settleOne(h, input, 'applied', { effectId })).resolves.toEqual(
      [{ requestId: input.requestId, status: 'already-settled' }],
    );
    await expect(settleOne(h, input, 'aborted', { effectId })).resolves.toEqual(
      [{ requestId: input.requestId, status: 'conflict' }],
    );
    expect(h.conflicts).toHaveBeenCalledTimes(1);
    expect(h.ledger().effects).toEqual([
      expect.objectContaining({ state: 'applied', conflicts: 1 }),
    ]);
    expect(h.events.map((event) => event.payload.data)).toEqual([
      expect.objectContaining({ outcome: 'admitted' }),
      expect.objectContaining({ outcome: 'applied', settledBy: 'document' }),
      expect.objectContaining({ outcome: 'aborted', disposition: 'conflict' }),
    ]);
  });

  test('a mismatched effectId never settles the request', async () => {
    const h = harness();
    const { input } = await admit(h);
    await expect(
      settleOne(h, input, 'applied', { effectId: 'pce-not-this-one' }),
    ).resolves.toEqual([{ requestId: input.requestId, status: 'not-found' }]);
    expect(h.ledger().effects[0]?.state).toBe('admitted');
  });

  test('another principal cannot settle an effect even with the document key', async () => {
    const h = harness();
    const { input } = await admit(h);
    await expect(
      settleOne(h, input, 'cancelled', { principalId: 'someone-else' }),
    ).resolves.toEqual([
      { requestId: input.requestId, status: 'cancel-recorded' },
    ]);
    expect(h.ledger().effects[0]?.state).toBe('admitted');
  });

  test('a cancel recorded before the admission commits makes that admission refuse', async () => {
    const h = harness();
    const input = admission(h);
    await expect(settleOne(h, input, 'cancelled')).resolves.toEqual([
      { requestId: input.requestId, status: 'cancel-recorded' },
    ]);
    await expect(h.service.recordAdmission(input)).resolves.toEqual({
      kind: 'refused',
      reason: 'cancelled',
    });
    const other = admission(h);
    await settleOne(h, other, 'cancelled', { documentKey: 'z'.repeat(43) });
    await expect(h.service.recordAdmission(other)).resolves.toMatchObject({
      kind: 'admitted',
    });
  });

  test('M4: cancels at capacity are refused, never evicted, and nobody else can push one out', async () => {
    const h = harness();
    const bounds = PLUGIN_COMMAND_EFFECT_BOUNDS;
    const first = admission(h);
    await settleOne(h, first, 'cancelled');
    for (let index = 1; index < bounds.tombstonesPerDocument; index += 1)
      await settleOne(h, admission(h), 'cancelled');
    const overflow = admission(h);
    await expect(settleOne(h, overflow, 'cancelled')).resolves.toEqual([
      { requestId: overflow.requestId, status: 'cancel-refused' },
    ]);
    // Another principal filling its own quota evicts nothing of ours.
    for (let index = 0; index < bounds.tombstonesPerPrincipal; index += 1)
      await settleOne(
        h,
        admission(h, {
          documentKey: `${String(index).padStart(3, '0')}${'q'.repeat(40)}`,
        }),
        'cancelled',
        { principalId: 'device:noisy' },
      );
    await expect(h.service.recordAdmission(first)).resolves.toEqual({
      kind: 'refused',
      reason: 'cancelled',
    });
  });

  test('M4: a cancel is forgotten only after no admission it could match can still be accepted', async () => {
    const h = harness();
    const input = admission(h);
    await settleOne(h, input, 'cancelled');
    h.advance(2 * PLUGIN_COMMAND_EFFECT_REQUEST_WINDOW_MS - 1);
    // The original request is still inside the window only if it was issued
    // by a clock up to one window ahead; the cancel still guards it.
    await expect(
      h.service.recordAdmission({
        ...input,
        issuedAt: START + PLUGIN_COMMAND_EFFECT_REQUEST_WINDOW_MS,
      }),
    ).resolves.toEqual({ kind: 'refused', reason: 'cancelled' });
    h.advance(2);
    // Past the lifetime the request itself is expired, so forgetting is safe.
    await expect(h.service.recordAdmission(input)).resolves.toEqual({
      kind: 'refused',
      reason: 'request-expired',
    });
    await settleOne(h, admission(h), 'cancelled');
    expect(h.ledger().tombstones).toHaveLength(1);
  });

  test('a beforeCommit fault leaves no half-committed settlement', async () => {
    let fail = false;
    const dir = home();
    const h = harness(dir, {
      beforeCommit: () => {
        if (fail) throw new Error('injected commit fault');
      },
    });
    const { input } = await admit(h);
    const before = readFileSync(join(dir, 'plugin-command-effects.json'));
    fail = true;
    await expect(settleOne(h, input, 'applied')).rejects.toBeInstanceOf(
      PluginCommandEffectsUnavailableError,
    );
    expect(readFileSync(join(dir, 'plugin-command-effects.json'))).toEqual(
      before,
    );
  });
});

describe('plugin command withdrawals (LP-W, LP-C)', () => {
  test('I1: completed only once every captured effect is settled with document proof', async () => {
    const h = harness();
    const a = await admit(h);
    const b = await admit(h);
    const withdrawal = await captured(h);
    expect(withdrawal).toMatchObject({
      status: 'winding-down',
      outstanding: 2,
    });
    await settleOne(h, a.input, 'applied');
    await expect(
      h.service.withdrawal(withdrawal.withdrawalId),
    ).resolves.toMatchObject({
      status: 'winding-down',
      outstandingEffectIds: [b.receipt.effectId],
    });
    h.advance(WAIT);
    await expect(
      h.service.withdrawal(withdrawal.withdrawalId),
    ).resolves.toMatchObject({ status: 'indeterminate', outstanding: 1 });
    await settleOne(h, b.input, 'applied');
    await expect(
      h.service.withdrawal(withdrawal.withdrawalId),
    ).resolves.toMatchObject({ status: 'completed', outstanding: 0 });
  });

  test('a withdrawal that captures nothing records nothing', async () => {
    const h = harness();
    await admit(h, admission(h, { pluginId: 'other' }));
    await expect(withdrawAll(h, 'update')).resolves.toBeNull();
    expect(h.ledger().withdrawals).toEqual([]);
  });

  test('the capture predicate selects by generation and by plugin-server requirement', async () => {
    const h = harness();
    const old = await admit(h);
    await admit(
      h,
      admission(h, { installationGeneration: '["incarnation-2","digest-2"]' }),
    );
    const server = await admit(h, admission(h, { requiresPluginServer: true }));
    const grant = await h.service.beginWithdrawal({
      pluginId: 'demo',
      cause: 'grant-withdrawal',
      captures: (effect) => effect.requiresPluginServer,
    });
    await expect(
      h.service.withdrawal(grant!.withdrawalId),
    ).resolves.toMatchObject({
      outstandingEffectIds: [server.receipt.effectId],
    });
    const update = await h.service.beginWithdrawal({
      pluginId: 'demo',
      cause: 'update',
      captures: (effect) =>
        effect.installationGeneration !== '["incarnation-2","digest-2"]',
    });
    expect(update?.withdrawalId).toBe(grant!.withdrawalId);
    await expect(
      h.service.withdrawal(grant!.withdrawalId),
    ).resolves.toMatchObject({
      causes: ['grant-withdrawal', 'update'],
      outstandingEffectIds: [server.receipt.effectId, old.receipt.effectId],
    });
  });

  test('coalescing: every change on a plugin with an open withdrawal joins it, so capacity can never refuse one', async () => {
    const h = harness();
    await admit(h);
    const first = await captured(h, 'update');
    for (let index = 0; index < 200; index += 1) {
      const again = await withdrawAll(
        h,
        index % 2 ? 'removal' : 'grant-withdrawal',
      );
      expect(again?.withdrawalId).toBe(first.withdrawalId);
    }
    expect(h.ledger().withdrawals).toHaveLength(1);
    await expect(
      h.service.withdrawal(first.withdrawalId),
    ).resolves.toMatchObject({
      causes: ['update', 'grant-withdrawal', 'removal'],
      outstanding: 1,
    });
  });

  test('a completed withdrawal is never reopened: a later capture starts a new one', async () => {
    const h = harness();
    const a = await admit(h);
    const first = await captured(h);
    await settleOne(h, a.input, 'applied');
    await admit(h);
    const second = await captured(h, 'update');
    expect(second.withdrawalId).not.toBe(first.withdrawalId);
    await expect(
      h.service.withdrawal(first.withdrawalId),
    ).resolves.toMatchObject({ status: 'completed', outstanding: 0 });
  });

  test("H2: closed-indeterminate comes only from the withdrawal's own resolution, and a later withdrawal stays resolvable", async () => {
    const h = harness();
    await admit(h);
    const first = await captured(h);
    h.advance(WAIT);
    await expect(
      h.service.resolveWithdrawal(first.withdrawalId),
    ).resolves.toMatchObject({
      kind: 'resolved',
      withdrawal: { status: 'closed-indeterminate' },
    });
    await admit(h);
    const second = await captured(h, 'update');
    expect(second.withdrawalId).not.toBe(first.withdrawalId);
    h.advance(WAIT);
    await expect(
      h.service.withdrawal(second.withdrawalId),
    ).resolves.toMatchObject({ status: 'indeterminate', outstanding: 1 });
    await expect(
      h.service.resolveWithdrawal(second.withdrawalId),
    ).resolves.toMatchObject({ kind: 'resolved' });
  });

  test('resolving a merged withdrawal abandons exactly its outstanding captured effects; late settlements are counted with an event', async () => {
    const h = harness();
    const a = await admit(h);
    const b = await admit(h);
    await captured(h, 'update');
    await settleOne(h, a.input, 'applied');
    const c = await admit(h, admission(h, { requiresPluginServer: true }));
    const merged = await h.service.beginWithdrawal({
      pluginId: 'demo',
      cause: 'grant-withdrawal',
      captures: (effect) => effect.requiresPluginServer,
    });
    const uncaptured = await admit(h);
    await expect(
      h.service.resolveWithdrawal(merged!.withdrawalId),
    ).resolves.toMatchObject({ kind: 'not-indeterminate' });
    h.advance(WAIT);
    await expect(
      h.service.resolveWithdrawal(merged!.withdrawalId),
    ).resolves.toMatchObject({
      kind: 'resolved',
      withdrawal: { status: 'closed-indeterminate', outstanding: 0 },
    });
    const states = Object.fromEntries(
      h.ledger().effects.map((effect) => [effect.effectId, effect]),
    );
    expect(states[a.receipt.effectId]).toMatchObject({ state: 'applied' });
    expect(states[b.receipt.effectId]).toMatchObject({
      state: 'abandoned',
      settledBy: 'operator',
    });
    expect(states[c.receipt.effectId]).toMatchObject({
      state: 'abandoned',
      settledBy: 'operator',
    });
    expect(states[uncaptured.receipt.effectId]).toMatchObject({
      state: 'admitted',
    });
    await expect(settleOne(h, b.input, 'applied')).resolves.toEqual([
      { requestId: b.input.requestId, status: 'recorded-late' },
    ]);
    expect(h.events.at(-1)?.payload.data).toMatchObject({
      outcome: 'applied',
      disposition: 'late',
    });
    await expect(
      h.service.withdrawal(merged!.withdrawalId),
    ).resolves.toMatchObject({ status: 'closed-indeterminate' });
  });

  test('awaitWithdrawal wakes on a settlement and stops at its deadline', async () => {
    const h = harness();
    const { input } = await admit(h);
    const withdrawal = await captured(h);
    await expect(
      h.service.awaitWithdrawal(withdrawal.withdrawalId, 20),
    ).resolves.toMatchObject({ status: 'winding-down', outstanding: 1 });
    const waiting = h.service.awaitWithdrawal(withdrawal.withdrawalId, 10_000);
    await settleOne(h, input, 'aborted');
    const started = Date.now();
    await expect(waiting).resolves.toMatchObject({ status: 'completed' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('a beforeCommit fault leaves no half-committed withdrawal', async () => {
    let fail = false;
    const dir = home();
    const h = harness(dir, {
      beforeCommit: () => {
        if (fail) throw new Error('injected commit fault');
      },
    });
    await admit(h);
    fail = true;
    await expect(withdrawAll(h)).rejects.toBeInstanceOf(
      PluginCommandEffectsUnavailableError,
    );
    expect(h.ledger().withdrawals).toEqual([]);
  });

  test('lists every open withdrawal before recent closed ones', async () => {
    const h = harness();
    const a = await admit(h, admission(h, { pluginId: 'alpha' }));
    const closed = await withdrawAll(h, 'removal', 'alpha');
    await settleOne(h, a.input, 'applied');
    await admit(h, admission(h, { pluginId: 'beta' }));
    const open = await withdrawAll(h, 'update', 'beta');
    await expect(h.service.listWithdrawals()).resolves.toEqual([
      expect.objectContaining({
        withdrawalId: open!.withdrawalId,
        status: 'winding-down',
      }),
      expect.objectContaining({
        withdrawalId: closed!.withdrawalId,
        status: 'completed',
      }),
    ]);
  });
});

describe('uncaptured outstanding effects (M2)', () => {
  test('the operator may abandon an aged effect no withdrawal captured, and nothing younger or captured', async () => {
    const h = harness();
    const loose = await admit(h, admission(h, { pluginId: 'alpha' }));
    const held = await admit(h, admission(h, { pluginId: 'beta' }));
    const withdrawal = await withdrawAll(h, 'removal', 'beta');
    await expect(h.service.listUncapturedEffects()).resolves.toEqual([
      expect.objectContaining({
        effectId: loose.receipt.effectId,
        abandonable: false,
      }),
    ]);
    await expect(
      h.service.abandonEffect(loose.receipt.effectId),
    ).resolves.toEqual({ kind: 'too-recent' });
    h.advance(WAIT);
    await expect(
      h.service.abandonEffect(held.receipt.effectId),
    ).resolves.toEqual({
      kind: 'captured',
      withdrawalId: withdrawal!.withdrawalId,
    });
    await expect(
      h.service.abandonEffect(loose.receipt.effectId),
    ).resolves.toEqual({ kind: 'abandoned' });
    await expect(
      h.service.abandonEffect(loose.receipt.effectId),
    ).resolves.toEqual({ kind: 'not-found' });
    expect(
      h
        .ledger()
        .effects.find((effect) => effect.effectId === loose.receipt.effectId),
    ).toMatchObject({ state: 'abandoned', settledBy: 'operator' });
    // A freed principal slot admits again.
    await expect(h.service.listUncapturedEffects()).resolves.toEqual([]);
  });
});

describe('plugin command effect ledger durability and bounds', () => {
  test('a restarted service on the same file keeps outstanding effects and completes their withdrawal', async () => {
    const dir = home();
    const clock = { now: START };
    const before = harness(dir, { clock });
    const { input } = await admit(before);
    const withdrawal = await captured(before);
    const after = harness(dir, { clock });
    await expect(
      after.service.withdrawal(withdrawal.withdrawalId),
    ).resolves.toMatchObject({ status: 'winding-down', outstanding: 1 });
    await settleOne(after, input, 'applied');
    await expect(
      after.service.withdrawal(withdrawal.withdrawalId),
    ).resolves.toMatchObject({ status: 'completed' });
  });

  test('a ledger with two open withdrawals for one plugin is refused whole', async () => {
    const dir = home();
    const h = harness(dir);
    await admit(h);
    await admit(h);
    await captured(h);
    const file = join(dir, 'plugin-command-effects.json');
    const ledger = JSON.parse(readFileSync(file, 'utf8'));
    const [withdrawal] = ledger.withdrawals;
    const second = withdrawal.outstanding.pop();
    ledger.withdrawals.push({
      ...withdrawal,
      withdrawalId: 'pcw-duplicate',
      sequence: ledger.sequence + 1,
      outstanding: [second],
    });
    ledger.sequence += 1;
    writeFileSync(file, JSON.stringify(ledger));
    await expect(h.service.listWithdrawals()).rejects.toBeInstanceOf(
      PluginCommandEffectsUnavailableError,
    );
  });

  test('L3: a ledger at every bound with maximum-length fields fits under the growth limit', async () => {
    const dir = home();
    const bounds = PLUGIN_COMMAND_EFFECT_BOUNDS;
    const long = (prefix: string, length: number) =>
      `${prefix}${'x'.repeat(length - prefix.length)}`;
    const at = '2026-09-16T12:00:00.000Z';
    let sequence = 0;
    const effect = (index: number, state: string, pluginId: string) => ({
      effectId: long(`pce-${index}-`, 64),
      sequence: ++sequence,
      documentId: long(`d${index}-`, 128),
      documentKeyDigest: 'a'.repeat(64),
      requestId: long(`r${index}-`, 128),
      principalId: long(`p${Math.floor(index / 16)}-`, 256),
      pluginId,
      installationGeneration: long('g', 256),
      requiresPluginServer: true,
      commandId: long('c', 127),
      target: { kind: 'composer', sessionId: long('s', 128) },
      effectDigest: 'b'.repeat(64),
      state,
      admittedAt: at,
      ...(state === 'admitted'
        ? {}
        : { settledBy: 'operator', settledAt: at, lateOutcome: 'applied' }),
      conflicts: 999_999,
    });
    const outstanding = Array.from(
      { length: bounds.outstandingTotal },
      (_, i) => effect(i, 'admitted', long(`plugin${Math.floor(i / 8)}-`, 64)),
    );
    const terminal = Array.from(
      { length: bounds.retainedTerminalEffects },
      (_, i) => effect(1000 + i, 'abandoned', long('plugin-t', 64)),
    );
    const withdrawal = (index: number, open: boolean) => ({
      withdrawalId: long(`pcw-${index}-`, 64),
      sequence: ++sequence,
      pluginId: long(`plugin${index}-`, 64),
      causes: ['removal', 'update', 'grant-withdrawal'],
      createdAt: at,
      outstanding: open
        ? outstanding.slice(index * 8, index * 8 + 8).map((entry) => ({
            effectId: entry.effectId,
            capturedAt: at,
          }))
        : [],
      settled: 999_999,
      ...(open
        ? {}
        : {
            resolution: {
              disposition: 'accept-indeterminate',
              resolvedAt: at,
              abandoned: 999_999,
            },
          }),
    });
    const tombstones = Array.from(
      { length: bounds.tombstonesTotal },
      (_, i) => ({
        sequence: ++sequence,
        documentId: long(`t${i}-`, 128),
        documentKeyDigest: 'c'.repeat(64),
        requestId: long(`tr${i}-`, 128),
        principalId: long(`tp${Math.floor(i / 16)}-`, 256),
        createdAt: at,
      }),
    );
    const ledger = {
      version: 1,
      sequence: 0,
      effects: [...outstanding, ...terminal],
      withdrawals: [
        ...Array.from({ length: 8 }, (_, i) => withdrawal(i, true)),
        ...Array.from({ length: bounds.retainedResolvedWithdrawals }, (_, i) =>
          withdrawal(100 + i, false),
        ),
      ],
      tombstones,
    };
    ledger.sequence = sequence;
    const serialized = JSON.stringify(ledger, null, 2);
    writeFileSync(join(dir, 'plugin-command-effects.json'), serialized);
    const store = new FilePluginCommandEffectStore(dir);
    await expect(store.read()).resolves.toMatchObject({ version: 1 });
    expect(Buffer.byteLength(serialized)).toBeLessThan(bounds.growthBytes);
  });
});

describe('lifecycle helpers', () => {
  test('an unreadable ledger never throws into a lifecycle change and never reads as completion', async () => {
    const dir = home();
    writeFileSync(join(dir, 'plugin-command-effects.json'), 'not json');
    const capture = await withdrawPluginCommandEffects(dir, {
      pluginId: 'demo',
      cause: 'removal',
      captures: () => true,
    });
    expect(capture).toEqual({ kind: 'unavailable' });
    await expect(
      settlePluginCommandEffectsForResponse(
        dir,
        { commandEffectsUnavailable: true },
        200,
      ),
    ).resolves.toEqual({
      fields: { commandEffectsUnavailable: true },
      status: 202,
    });
  });
});

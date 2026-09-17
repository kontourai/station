import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationalEventEnvelope } from '@kontourai/station-contracts/operational-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createPluginCommandEffectService,
  FilePluginCommandEffectStore,
  PLUGIN_COMMAND_EFFECT_BOUNDS,
  type PluginCommandEffectAdmissionRecord,
  PluginCommandEffectsUnavailableError,
  PluginCommandWithdrawalCapacityError,
} from '../plugin-command-effects.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const DOCUMENT = 'document-0001';
const KEY = 'k'.repeat(43);

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'station-command-effects-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function harness(
  dir = home(),
  options: {
    beforeCommit?: () => void | Promise<void>;
    publishAudit?: (event: OperationalEventEnvelope) => boolean;
  } = {},
) {
  let clock = Date.parse('2026-09-16T12:00:00.000Z');
  const conflicts = vi.fn();
  const service = createPluginCommandEffectService({
    store: new FilePluginCommandEffectStore(dir, {
      beforeCommit: options.beforeCommit,
    }),
    now: () => new Date(clock),
    indeterminateAfterMs: 60_000,
    publishAudit: options.publishAudit,
    onSettlementConflict: conflicts,
  });
  return {
    dir,
    service,
    conflicts,
    advance(ms: number) {
      clock += ms;
    },
    ledger: () =>
      JSON.parse(
        readFileSync(join(dir, 'plugin-command-effects.json'), 'utf8'),
      ) as {
        effects: Array<{ effectId: string; state: string; pluginId: string }>;
        withdrawals: unknown[];
        tombstones: unknown[];
      },
  };
}

let requestCounter = 0;
function admission(
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
    ...overrides,
  };
}

function captured<T>(value: T | null): T {
  if (value === null)
    throw new Error('expected a withdrawal that captured effects');
  return value;
}

async function admit(
  service: ReturnType<typeof harness>['service'],
  input = admission(),
) {
  const outcome = await service.recordAdmission(input);
  if (outcome.kind !== 'admitted')
    throw new Error(`expected admission, got ${outcome.reason}`);
  return { input, receipt: outcome.receipt };
}

describe('plugin command effect admission (LP-A)', () => {
  test('is idempotent on (documentId, requestId) and refuses a conflicting retry', async () => {
    const h = harness();
    const input = admission();
    const first = await admit(h.service, input);
    const again = await h.service.recordAdmission(input);
    expect(again).toEqual({ kind: 'admitted', receipt: first.receipt });
    expect(h.ledger().effects).toHaveLength(1);
    await expect(
      h.service.recordAdmission({ ...input, commandId: 'demo.other' }),
    ).resolves.toEqual({ kind: 'refused', reason: 'request-conflict' });
    await expect(
      h.service.recordAdmission({ ...input, documentKey: 'x'.repeat(43) }),
    ).resolves.toEqual({ kind: 'refused', reason: 'request-conflict' });
    expect(h.ledger().effects).toHaveLength(1);
  });

  test('the receipt carries exactly the server-read effect content', async () => {
    const h = harness();
    const { receipt } = await admit(
      h.service,
      admission({
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

  test('I4: capacity refuses new admissions and never evicts an outstanding effect', async () => {
    const h = harness();
    const bounds = PLUGIN_COMMAND_EFFECT_BOUNDS;
    const held: string[] = [];
    for (let index = 0; index < bounds.outstandingPerPlugin; index += 1)
      held.push((await admit(h.service)).receipt.effectId);
    await expect(h.service.recordAdmission(admission())).resolves.toEqual({
      kind: 'refused',
      reason: 'capacity',
    });
    // Churn far past terminal retention on other plugins.
    for (
      let index = 0;
      index < bounds.retainedTerminalEffects + 8;
      index += 1
    ) {
      const { input } = await admit(
        h.service,
        admission({ pluginId: 'other', commandId: 'other.open' }),
      );
      await h.service.settle({
        principalId: input.principalId,
        documentId: input.documentId,
        documentKey: input.documentKey,
        items: [{ requestId: input.requestId, outcome: 'applied' }],
      });
    }
    const effects = h.ledger().effects;
    for (const effectId of held)
      expect(effects).toContainEqual(
        expect.objectContaining({ effectId, state: 'admitted' }),
      );
    expect(
      effects.filter((effect) => effect.state !== 'admitted').length,
    ).toBeLessThanOrEqual(bounds.retainedTerminalEffects);

    // Total capacity across plugins.
    const g = harness();
    for (let plugin = 0; plugin < 8; plugin += 1)
      for (let index = 0; index < bounds.outstandingPerPlugin; index += 1)
        await admit(g.service, admission({ pluginId: `p${plugin}` }));
    await expect(
      g.service.recordAdmission(admission({ pluginId: 'fresh' })),
    ).resolves.toEqual({ kind: 'refused', reason: 'capacity' });
  });

  test('an audit that is not persisted cancels the admission with station proof and refuses', async () => {
    const events: OperationalEventEnvelope[] = [];
    const h = harness(home(), {
      publishAudit: (event) => {
        events.push(event);
        return false;
      },
    });
    const input = admission();
    await expect(h.service.recordAdmission(input)).resolves.toEqual({
      kind: 'refused',
      reason: 'unavailable',
    });
    expect(h.ledger().effects).toEqual([
      expect.objectContaining({ state: 'cancelled', settledBy: 'station' }),
    ]);
    expect(events[0]?.payload).toMatchObject({
      schema: 'station.plugin-command.execution/v1',
      data: { outcome: 'admitted', pluginId: 'demo' },
    });
    // The document's own cancel for that request is idempotent, not a conflict.
    await expect(
      h.service.settle({
        principalId: input.principalId,
        documentId: input.documentId,
        documentKey: input.documentKey,
        items: [{ requestId: input.requestId, outcome: 'cancelled' }],
      }),
    ).resolves.toEqual([
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
    const input = admission();
    await expect(h.service.recordAdmission(input)).resolves.toEqual({
      kind: 'refused',
      reason: 'unavailable',
    });
    await expect(h.service.withdrawal('pcw-missing')).resolves.toBeNull();
    expect(() => h.ledger()).toThrow();
    fail = false;
    const { receipt } = await admit(h.service, input);
    expect(h.ledger().effects).toEqual([
      expect.objectContaining({ effectId: receipt.effectId }),
    ]);
  });
});

describe('plugin command effect settlement (LP-K)', () => {
  test('first terminal wins; the same outcome is idempotent; a different one is a counted conflict', async () => {
    const h = harness();
    const { input, receipt } = await admit(h.service);
    const settle = (outcome: 'applied' | 'aborted', key = KEY) =>
      h.service.settle({
        principalId: input.principalId,
        documentId: input.documentId,
        documentKey: key,
        items: [
          {
            requestId: input.requestId,
            effectId: receipt.effectId,
            outcome,
          },
        ],
      });
    await expect(settle('applied', 'y'.repeat(43))).resolves.toEqual([
      { requestId: input.requestId, status: 'not-found' },
    ]);
    await expect(settle('applied')).resolves.toEqual([
      { requestId: input.requestId, status: 'settled' },
    ]);
    await expect(settle('applied')).resolves.toEqual([
      { requestId: input.requestId, status: 'already-settled' },
    ]);
    await expect(settle('aborted')).resolves.toEqual([
      { requestId: input.requestId, status: 'conflict' },
    ]);
    expect(h.conflicts).toHaveBeenCalledTimes(1);
    expect(h.ledger().effects).toEqual([
      expect.objectContaining({ state: 'applied', conflicts: 1 }),
    ]);
  });

  test('another principal cannot settle an effect even with the document key', async () => {
    const h = harness();
    const { input } = await admit(h.service);
    await expect(
      h.service.settle({
        principalId: 'someone-else',
        documentId: input.documentId,
        documentKey: input.documentKey,
        items: [{ requestId: input.requestId, outcome: 'cancelled' }],
      }),
    ).resolves.toEqual([{ requestId: input.requestId, status: 'not-found' }]);
    expect(h.ledger().effects[0]?.state).toBe('admitted');
  });

  test('a cancel recorded before the admission commits makes that admission refuse', async () => {
    const h = harness();
    const input = admission();
    await expect(
      h.service.settle({
        principalId: input.principalId,
        documentId: input.documentId,
        documentKey: input.documentKey,
        items: [{ requestId: input.requestId, outcome: 'cancelled' }],
      }),
    ).resolves.toEqual([
      { requestId: input.requestId, status: 'cancel-recorded' },
    ]);
    await expect(h.service.recordAdmission(input)).resolves.toEqual({
      kind: 'refused',
      reason: 'cancelled',
    });
    expect(h.ledger().effects).toEqual([]);
    // A forged cancel under a different key does not block the real document.
    const other = admission();
    await h.service.settle({
      principalId: other.principalId,
      documentId: other.documentId,
      documentKey: 'z'.repeat(43),
      items: [{ requestId: other.requestId, outcome: 'cancelled' }],
    });
    await expect(h.service.recordAdmission(other)).resolves.toMatchObject({
      kind: 'admitted',
    });
  });

  test('a cancel after the admission commits settles it, and a retry then refuses', async () => {
    const h = harness();
    const { input } = await admit(h.service);
    await expect(
      h.service.settle({
        principalId: input.principalId,
        documentId: input.documentId,
        documentKey: input.documentKey,
        items: [{ requestId: input.requestId, outcome: 'cancelled' }],
      }),
    ).resolves.toEqual([{ requestId: input.requestId, status: 'settled' }]);
    await expect(h.service.recordAdmission(input)).resolves.toEqual({
      kind: 'refused',
      reason: 'cancelled',
    });
  });

  test('a beforeCommit fault leaves no half-committed settlement', async () => {
    let fail = false;
    const dir = home();
    const h = harness(dir, {
      beforeCommit: () => {
        if (fail) throw new Error('injected commit fault');
      },
    });
    const { input } = await admit(h.service);
    const before = readFileSync(join(dir, 'plugin-command-effects.json'));
    fail = true;
    await expect(
      h.service.settle({
        principalId: input.principalId,
        documentId: input.documentId,
        documentKey: input.documentKey,
        items: [{ requestId: input.requestId, outcome: 'applied' }],
      }),
    ).rejects.toBeInstanceOf(PluginCommandEffectsUnavailableError);
    expect(readFileSync(join(dir, 'plugin-command-effects.json'))).toEqual(
      before,
    );
  });
});

describe('plugin command withdrawals (LP-W, LP-C)', () => {
  test('I1: status is completed only once every captured effect is settled with document proof', async () => {
    const h = harness();
    const a = await admit(h.service);
    const b = await admit(h.service);
    const withdrawal = captured(
      await h.service.beginWithdrawal({
        pluginId: 'demo',
        cause: 'removal',
        captures: () => true,
      }),
    );
    expect(withdrawal).toMatchObject({
      status: 'winding-down',
      outstanding: 2,
    });
    const settle = (entry: typeof a) =>
      h.service.settle({
        principalId: entry.input.principalId,
        documentId: entry.input.documentId,
        documentKey: entry.input.documentKey,
        items: [{ requestId: entry.input.requestId, outcome: 'applied' }],
      });
    await settle(a);
    await expect(
      h.service.withdrawal(withdrawal.withdrawalId),
    ).resolves.toMatchObject({
      status: 'winding-down',
      outstanding: 1,
      outstandingEffectIds: [b.receipt.effectId],
    });
    h.advance(60_000);
    await expect(
      h.service.withdrawal(withdrawal.withdrawalId),
    ).resolves.toMatchObject({ status: 'indeterminate', outstanding: 1 });
    await settle(b);
    await expect(
      h.service.withdrawal(withdrawal.withdrawalId),
    ).resolves.toMatchObject({ status: 'completed', outstanding: 0 });
  });

  test('a withdrawal that captures nothing records nothing', async () => {
    const h = harness();
    await admit(h.service, admission({ pluginId: 'other' }));
    await expect(
      h.service.beginWithdrawal({
        pluginId: 'demo',
        cause: 'update',
        captures: () => true,
      }),
    ).resolves.toBeNull();
    expect(h.ledger().withdrawals).toEqual([]);
  });

  test('the capture predicate selects by generation and by plugin-server requirement', async () => {
    const h = harness();
    const old = await admit(h.service);
    const current = await admit(
      h.service,
      admission({ installationGeneration: '["incarnation-2","digest-2"]' }),
    );
    const server = await admit(
      h.service,
      admission({ requiresPluginServer: true }),
    );
    const update = captured(
      await h.service.beginWithdrawal({
        pluginId: 'demo',
        cause: 'update',
        captures: (effect) =>
          effect.installationGeneration !== '["incarnation-2","digest-2"]',
      }),
    );
    await expect(
      h.service.withdrawal(update.withdrawalId),
    ).resolves.toMatchObject({
      outstanding: 2,
      outstandingEffectIds: [old.receipt.effectId, server.receipt.effectId],
    });
    const grant = captured(
      await h.service.beginWithdrawal({
        pluginId: 'demo',
        cause: 'grant-withdrawal',
        captures: (effect) => effect.requiresPluginServer,
      }),
    );
    await expect(
      h.service.withdrawal(grant.withdrawalId),
    ).resolves.toMatchObject({
      outstandingEffectIds: [server.receipt.effectId],
    });
    expect(current.receipt.effectId).not.toBe(old.receipt.effectId);
  });

  test('effects admitted after the capture do not join the withdrawal', async () => {
    const h = harness();
    const before = await admit(h.service);
    const withdrawal = captured(
      await h.service.beginWithdrawal({
        pluginId: 'demo',
        cause: 'removal',
        captures: () => true,
      }),
    );
    if (!withdrawal) throw new Error('expected a withdrawal');
    await admit(h.service);
    await h.service.settle({
      principalId: before.input.principalId,
      documentId: before.input.documentId,
      documentKey: before.input.documentKey,
      items: [{ requestId: before.input.requestId, outcome: 'applied' }],
    });
    await expect(
      h.service.withdrawal(withdrawal.withdrawalId),
    ).resolves.toMatchObject({ status: 'completed', outstanding: 0 });
  });

  test('only an indeterminate withdrawal can be resolved; late settlements are counted, never shown as completed', async () => {
    const h = harness();
    const { input, receipt } = await admit(h.service);
    const withdrawal = captured(
      await h.service.beginWithdrawal({
        pluginId: 'demo',
        cause: 'removal',
        captures: () => true,
      }),
    );
    await expect(
      h.service.resolveWithdrawal(withdrawal.withdrawalId),
    ).resolves.toMatchObject({
      kind: 'not-indeterminate',
      withdrawal: { status: 'winding-down' },
    });
    h.advance(60_000);
    await expect(
      h.service.resolveWithdrawal(withdrawal.withdrawalId),
    ).resolves.toMatchObject({
      kind: 'resolved',
      withdrawal: { status: 'closed-indeterminate', outstanding: 0 },
    });
    expect(h.ledger().effects).toEqual([
      expect.objectContaining({
        effectId: receipt.effectId,
        state: 'abandoned',
        settledBy: 'operator',
      }),
    ]);
    await expect(
      h.service.settle({
        principalId: input.principalId,
        documentId: input.documentId,
        documentKey: input.documentKey,
        items: [{ requestId: input.requestId, outcome: 'applied' }],
      }),
    ).resolves.toEqual([
      { requestId: input.requestId, status: 'recorded-late' },
    ]);
    expect(h.ledger().effects[0]).toMatchObject({ lateOutcome: 'applied' });
    await expect(
      h.service.withdrawal(withdrawal.withdrawalId),
    ).resolves.toMatchObject({ status: 'closed-indeterminate' });
    // A freed slot admits again.
    await expect(h.service.recordAdmission(admission())).resolves.toMatchObject(
      { kind: 'admitted' },
    );
  });

  test('awaitWithdrawal wakes on a settlement and stops at its deadline', async () => {
    const h = harness();
    const { input } = await admit(h.service);
    const withdrawal = captured(
      await h.service.beginWithdrawal({
        pluginId: 'demo',
        cause: 'removal',
        captures: () => true,
      }),
    );
    await expect(
      h.service.awaitWithdrawal(withdrawal.withdrawalId, 20),
    ).resolves.toMatchObject({ status: 'winding-down', outstanding: 1 });
    const waiting = h.service.awaitWithdrawal(withdrawal.withdrawalId, 10_000);
    await h.service.settle({
      principalId: input.principalId,
      documentId: input.documentId,
      documentKey: input.documentKey,
      items: [{ requestId: input.requestId, outcome: 'aborted' }],
    });
    const started = Date.now();
    await expect(waiting).resolves.toMatchObject({ status: 'completed' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('open withdrawals at capacity refuse a new capture instead of evicting one', async () => {
    const h = harness();
    await admit(h.service);
    for (
      let index = 0;
      index < PLUGIN_COMMAND_EFFECT_BOUNDS.openWithdrawals;
      index += 1
    )
      await h.service.beginWithdrawal({
        pluginId: 'demo',
        cause: 'update',
        captures: () => true,
      });
    await expect(
      h.service.beginWithdrawal({
        pluginId: 'demo',
        cause: 'removal',
        captures: () => true,
      }),
    ).rejects.toBeInstanceOf(PluginCommandWithdrawalCapacityError);
    expect(h.ledger().withdrawals).toHaveLength(
      PLUGIN_COMMAND_EFFECT_BOUNDS.openWithdrawals,
    );
  });

  test('a beforeCommit fault leaves no half-committed withdrawal', async () => {
    let fail = false;
    const dir = home();
    const h = harness(dir, {
      beforeCommit: () => {
        if (fail) throw new Error('injected commit fault');
      },
    });
    await admit(h.service);
    fail = true;
    await expect(
      h.service.beginWithdrawal({
        pluginId: 'demo',
        cause: 'removal',
        captures: () => true,
      }),
    ).rejects.toBeInstanceOf(PluginCommandEffectsUnavailableError);
    expect(h.ledger().withdrawals).toEqual([]);
  });
});

describe('plugin command effect ledger durability', () => {
  test('a restarted service on the same file keeps outstanding effects and completes their withdrawal', async () => {
    const dir = home();
    const before = harness(dir);
    const { input } = await admit(before.service);
    const withdrawal = captured(
      await before.service.beginWithdrawal({
        pluginId: 'demo',
        cause: 'removal',
        captures: () => true,
      }),
    );
    const after = harness(dir);
    await expect(
      after.service.withdrawal(withdrawal.withdrawalId),
    ).resolves.toMatchObject({ status: 'winding-down', outstanding: 1 });
    await expect(after.service.recordAdmission(input)).resolves.toMatchObject({
      kind: 'admitted',
    });
    await after.service.settle({
      principalId: input.principalId,
      documentId: input.documentId,
      documentKey: input.documentKey,
      items: [{ requestId: input.requestId, outcome: 'applied' }],
    });
    await expect(
      after.service.withdrawal(withdrawal.withdrawalId),
    ).resolves.toMatchObject({ status: 'completed' });
  });

  test('a ledger violating its cross-record invariants is refused whole', async () => {
    const dir = home();
    const h = harness(dir);
    await admit(h.service);
    const withdrawal = captured(
      await h.service.beginWithdrawal({
        pluginId: 'demo',
        cause: 'removal',
        captures: () => true,
      }),
    );
    const file = join(dir, 'plugin-command-effects.json');
    const ledger = JSON.parse(readFileSync(file, 'utf8'));
    // An unsettled capture whose effect is no longer outstanding.
    ledger.effects[0].state = 'applied';
    ledger.effects[0].settledBy = 'document';
    ledger.effects[0].settledAt = '2026-09-16T12:00:01.000Z';
    writeFileSync(file, JSON.stringify(ledger));
    await expect(
      h.service.withdrawal(withdrawal.withdrawalId),
    ).rejects.toBeInstanceOf(PluginCommandEffectsUnavailableError);
    await expect(h.service.recordAdmission(admission())).resolves.toEqual({
      kind: 'refused',
      reason: 'unavailable',
    });
  });
});

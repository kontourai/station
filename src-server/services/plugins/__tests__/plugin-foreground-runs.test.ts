import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN_FOREGROUND_WORK_SCHEMA_VERSION } from '@kontourai/station-contracts/plugin-foreground-work';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import {
  ActionOperationService,
  FileActionOperationStore,
} from '../../operations/action-operation-service.js';
import {
  createPluginForegroundActionOperationObserver,
  createPluginForegroundRuns,
  type PluginForegroundRunCoordinator,
  type PluginForegroundRunRecord,
} from '../plugin-foreground-runs.js';

class MemoryCoordinator implements PluginForegroundRunCoordinator {
  readonly records = new Map<string, PluginForegroundRunRecord>();

  admit(record: PluginForegroundRunRecord) {
    const existing = this.records.get(record.runId);
    if (existing) {
      return {
        kind: 'existing' as const,
        record: structuredClone(existing),
      };
    }
    this.records.set(record.runId, structuredClone(record));
    return { kind: 'admitted' as const };
  }

  transition(
    input: Parameters<PluginForegroundRunCoordinator['transition']>[0],
  ) {
    const current = this.records.get(input.runId);
    if (!current || current.executionOwnerId !== input.executionOwnerId) {
      return { kind: 'stale' as const };
    }
    if (
      current.state === input.to &&
      current.effectDepth === input.effectDepth &&
      current.failureSummary === input.failureSummary
    ) {
      return { kind: 'applied' as const, record: structuredClone(current) };
    }
    if (!input.from.includes(current.state)) {
      return { kind: 'stale' as const, record: structuredClone(current) };
    }
    const terminal = [
      'completed',
      'failed',
      'cancelled',
      'indeterminate',
    ].includes(input.to);
    const next: PluginForegroundRunRecord = {
      ...current,
      state: input.to,
      effectDepth: input.effectDepth,
      updatedAt: input.now,
      ...(terminal ? { completedAt: input.now } : {}),
      ...(input.failureSummary ? { failureSummary: input.failureSummary } : {}),
    };
    this.records.set(input.runId, next);
    return { kind: 'applied' as const, record: structuredClone(next) };
  }

  settleCancellation(
    input: Parameters<PluginForegroundRunCoordinator['settleCancellation']>[0],
  ) {
    const current = this.records.get(input.runId);
    if (!current || current.executionOwnerId !== input.executionOwnerId) {
      return { kind: 'stale' as const };
    }
    if (
      current.state === input.to &&
      current.failureSummary === input.failureSummary
    ) {
      return { kind: 'applied' as const, record: structuredClone(current) };
    }
    if (current.state !== 'admitted' && current.state !== 'running') {
      return { kind: 'stale' as const, record: structuredClone(current) };
    }
    const next: PluginForegroundRunRecord = {
      ...current,
      state: input.to,
      effectDepth:
        current.state === 'admitted' ? 'uninvoked' : 'possible-effect',
      updatedAt: input.now,
      completedAt: input.now,
      ...(input.failureSummary ? { failureSummary: input.failureSummary } : {}),
    };
    this.records.set(input.runId, next);
    return { kind: 'applied' as const, record: structuredClone(next) };
  }

  read(runId: string) {
    const record = this.records.get(runId);
    return record ? structuredClone(record) : null;
  }

  list() {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  active() {
    return this.list().filter(
      (record) => record.state === 'admitted' || record.state === 'running',
    );
  }
}

const authority = sessionReadAuthorityFromRequest(
  'account-a',
  undefined,
  undefined,
);
const owner = {
  pluginId: 'build-tools',
  installationKey: 'install-a',
  installationGeneration: 3,
  accountId: 'account-a',
};
const declaration = {
  kind: 'index-project',
  title: 'Index project',
  requiredCapabilities: ['workspace.read'],
  cancellation: 'supported' as const,
};
const request = {
  schemaVersion: PLUGIN_FOREGROUND_WORK_SCHEMA_VERSION,
  kind: declaration.kind,
  idempotencyKey: 'request-a',
  input: { paths: ['src', 'tests'], options: { symbols: true } },
  taskId: 'task-a',
  sessionId: 'session-a',
};

function createHarness(
  options: {
    coordinator?: MemoryCoordinator;
    ownerId?: string;
    authorization?: () => 'granted' | 'denied' | 'unavailable';
    cancellation?: () => Promise<'confirmed' | 'refused' | 'unknown'>;
    probe?: () =>
      | { state: 'dead' }
      | { state: 'unavailable' }
      | { state: 'exact'; identity: { pid: number; start: string } };
    observer?: Parameters<typeof createPluginForegroundRuns>[0]['observer'];
    observerTimeoutMs?: number;
  } = {},
) {
  const coordinator = options.coordinator ?? new MemoryCoordinator();
  const runs = createPluginForegroundRuns({
    declarations: [declaration],
    coordinator,
    authorizer: {
      authorize: () => ({
        kind: options.authorization?.() ?? 'granted',
      }),
    },
    executionOwner: {
      id: options.ownerId ?? 'worker-a',
      pid: process.pid,
      birth: 'birth-a',
      identityKind: 'exact',
    },
    processIdentity: {
      probe:
        options.probe ??
        (() => ({
          state: 'exact' as const,
          identity: { pid: process.pid, start: 'birth-a' },
        })),
    },
    canRead: (record, candidate) =>
      record.accountId === candidate.userId &&
      (record.sessionId === undefined || record.sessionId === 'session-a'),
    ...(options.cancellation
      ? { cancellationAdapter: { cancel: options.cancellation } }
      : {}),
    ...(options.observer ? { observer: options.observer } : {}),
    ...(options.observerTimeoutMs
      ? { observerTimeoutMs: options.observerTimeoutMs }
      : {}),
  });
  return { coordinator, runs };
}

describe('plugin foreground run authority', () => {
  test('refuses non-JSON input without invoking accessors', async () => {
    const getter = vi.fn(() => 'secret');
    const input = {};
    Object.defineProperty(input, 'value', { enumerable: true, get: getter });
    const { runs } = createHarness();

    await expect(runs.start(owner, { ...request, input })).resolves.toEqual({
      kind: 'refused',
      reason: 'invalid',
    });
    expect(getter).not.toHaveBeenCalled();
  });

  test('deduplicates one semantic request and refuses same-key equivocation', async () => {
    const { runs } = createHarness();
    const first = await runs.start(owner, request);
    expect(first.kind).toBe('admitted');
    const duplicate = await runs.start(owner, {
      ...request,
      input: { options: { symbols: true }, paths: ['src', 'tests'] },
    });
    expect(duplicate).toEqual({
      kind: 'existing',
      run: expect.objectContaining({
        runId: first.kind === 'admitted' ? first.run.runId : '',
        state: 'admitted',
        effectDepth: 'uninvoked',
      }),
    });
    await expect(
      runs.start(owner, { ...request, input: { paths: ['private'] } }),
    ).resolves.toEqual({
      kind: 'refused',
      reason: 'idempotency-equivocation',
    });
    expect(JSON.stringify(duplicate)).not.toContain('request-a');
    expect(JSON.stringify(duplicate)).not.toContain('install-a');
    expect(JSON.stringify(duplicate)).not.toContain('inputDigest');
  });

  test('qualifies run identity by account and machine', async () => {
    const { runs } = createHarness();
    const accountRun = await runs.start(owner, request);
    const otherAccountRun = await runs.start(
      { ...owner, accountId: 'account-b' },
      request,
    );
    const otherMachineRun = await runs.start(
      { ...owner, machineId: 'machine-b' },
      request,
    );

    expect(accountRun.kind).toBe('admitted');
    expect(otherAccountRun.kind).toBe('admitted');
    expect(otherMachineRun.kind).toBe('admitted');
    if (
      accountRun.kind !== 'admitted' ||
      otherAccountRun.kind !== 'admitted' ||
      otherMachineRun.kind !== 'admitted'
    ) {
      throw new Error('expected independent admissions');
    }
    expect(
      new Set([
        accountRun.run.runId,
        otherAccountRun.run.runId,
        otherMachineRun.run.runId,
      ]).size,
    ).toBe(3);
  });

  test('revalidates authorization at the effect boundary and persists a pre-effect refusal', async () => {
    let authorization: 'granted' | 'denied' = 'granted';
    const { runs } = createHarness({ authorization: () => authorization });
    const started = await runs.start(owner, request);
    expect(started.kind).toBe('admitted');
    if (started.kind !== 'admitted') throw new Error('expected admission');

    authorization = 'denied';
    await expect(
      started.claim.beginEffect('2026-09-03T00:00:01.000Z'),
    ).resolves.toMatchObject({
      kind: 'applied',
      record: {
        state: 'failed',
        effectDepth: 'uninvoked',
        completedAt: '2026-09-03T00:00:01.000Z',
      },
    });
    await expect(
      runs.read(started.run.runId, authority),
    ).resolves.toMatchObject({
      kind: 'available',
      run: { state: 'failed', effectDepth: 'uninvoked' },
    });
  });

  test('records admitted, running, and terminal truth with explicit effect depth', async () => {
    const { runs } = createHarness();
    const started = await runs.start(owner, request);
    if (started.kind !== 'admitted') throw new Error('expected admission');
    await expect(
      started.claim.beginEffect('2026-09-03T00:00:01.000Z'),
    ).resolves.toMatchObject({
      kind: 'applied',
      record: { state: 'running', effectDepth: 'possible-effect' },
    });
    await expect(
      started.claim.completed('2026-09-03T00:00:02.000Z'),
    ).resolves.toMatchObject({
      kind: 'applied',
      record: { state: 'completed', effectDepth: 'confirmed-effect' },
    });
    await expect(
      started.claim.completed('2026-09-03T00:00:02.000Z'),
    ).resolves.toMatchObject({
      kind: 'applied',
      record: { state: 'completed' },
    });
  });

  test('reconciles a dead pre-effect owner as failed and a dead active owner as indeterminate', async () => {
    const coordinator = new MemoryCoordinator();
    const first = createHarness({ coordinator, ownerId: 'worker-pre' });
    const admitted = await first.runs.start(owner, request);
    if (admitted.kind !== 'admitted') throw new Error('expected admission');
    first.runs.releaseOwner();

    const second = createHarness({
      coordinator,
      ownerId: 'worker-recovery-a',
      probe: () => ({ state: 'dead' }),
    });
    expect(second.runs.reconcile('2026-09-03T00:01:00.000Z')).toEqual({
      kind: 'available',
    });
    expect(coordinator.read(admitted.run.runId)).toMatchObject({
      state: 'failed',
      effectDepth: 'uninvoked',
    });

    const active = await second.runs.start(owner, {
      ...request,
      idempotencyKey: 'request-b',
    });
    if (active.kind !== 'admitted') throw new Error('expected admission');
    await active.claim.beginEffect('2026-09-03T00:02:00.000Z');
    second.runs.releaseOwner();
    const third = createHarness({
      coordinator,
      ownerId: 'worker-recovery-b',
      probe: () => ({ state: 'dead' }),
    });
    expect(third.runs.reconcile('2026-09-03T00:03:00.000Z')).toEqual({
      kind: 'available',
    });
    expect(coordinator.read(active.run.runId)).toMatchObject({
      state: 'indeterminate',
      effectDepth: 'possible-effect',
    });
  });

  test('keeps execution-owner leases scoped to their composed run authority', async () => {
    const first = createHarness({ ownerId: 'shared-worker' });
    const second = createHarness({ ownerId: 'shared-worker' });
    const started = await second.runs.start(owner, request);
    if (started.kind !== 'admitted') throw new Error('expected admission');

    first.runs.releaseOwner();
    expect(second.runs.reconcile('2026-09-03T00:01:00.000Z')).toEqual({
      kind: 'available',
    });
    expect(second.coordinator.read(started.run.runId)).toMatchObject({
      state: 'admitted',
      effectDepth: 'uninvoked',
    });
    await expect(first.runs.start(owner, request)).resolves.toEqual({
      kind: 'refused',
      reason: 'run-authority-unavailable',
    });
  });

  test('a released owner cannot cross the effect boundary', async () => {
    const { runs } = createHarness({ ownerId: 'released-worker' });
    const started = await runs.start(owner, request);
    if (started.kind !== 'admitted') throw new Error('expected admission');
    runs.releaseOwner();

    await expect(
      started.claim.beginEffect('2026-09-03T00:00:01.000Z'),
    ).resolves.toEqual({ kind: 'stale' });
  });

  test('targets cancellation at the recorded exact owner and makes an unknown outcome indeterminate', async () => {
    const cancel = vi.fn(async () => 'unknown' as const);
    const { runs } = createHarness({ cancellation: cancel });
    const started = await runs.start(owner, request);
    if (started.kind !== 'admitted') throw new Error('expected admission');
    await started.claim.beginEffect('2026-09-03T00:00:01.000Z');

    await expect(runs.cancel(owner, started.run.runId)).resolves.toMatchObject({
      kind: 'unknown',
      run: { state: 'indeterminate', effectDepth: 'possible-effect' },
    });
    expect(cancel).toHaveBeenCalledWith({
      runId: started.run.runId,
      executionOwner: {
        id: 'worker-a',
        pid: process.pid,
        birth: 'birth-a',
        identityKind: 'exact',
      },
    });
    await expect(
      runs.cancel(
        { ...owner, installationKey: 'install-b' },
        started.run.runId,
      ),
    ).resolves.toEqual({ kind: 'unauthorized' });
  });

  test('terminalizes a confirmed cancellation across an admitted-to-running race', async () => {
    let confirmCancellation: ((value: 'confirmed') => void) | undefined;
    const cancellation = vi.fn(
      () =>
        new Promise<'confirmed'>((resolve) => {
          confirmCancellation = resolve;
        }),
    );
    const { runs } = createHarness({ cancellation });
    const started = await runs.start(owner, request);
    if (started.kind !== 'admitted') throw new Error('expected admission');

    const cancelling = runs.cancel(owner, started.run.runId);
    expect(cancellation).toHaveBeenCalledOnce();
    await started.claim.beginEffect('2026-09-03T00:00:01.000Z');
    confirmCancellation?.('confirmed');

    await expect(cancelling).resolves.toMatchObject({
      kind: 'confirmed',
      run: { state: 'cancelled', effectDepth: 'possible-effect' },
    });
  });

  test('does not let a stale terminal method poison the applicable settlement', async () => {
    const { runs } = createHarness();
    const started = await runs.start(owner, request);
    if (started.kind !== 'admitted') throw new Error('expected admission');
    await started.claim.beginEffect('2026-09-03T00:00:01.000Z');

    await expect(
      started.claim.failedBeforeEffect(
        '2026-09-03T00:00:02.000Z',
        'Worker failed before invocation.',
      ),
    ).resolves.toMatchObject({ kind: 'stale' });
    await expect(
      started.claim.failedAfterEffect(
        '2026-09-03T00:00:03.000Z',
        'Worker failed after invocation.',
      ),
    ).resolves.toMatchObject({
      kind: 'applied',
      record: { state: 'failed', effectDepth: 'possible-effect' },
    });
  });

  test('bounds hanging observer begin and update work away from run control', async () => {
    const warn = vi.fn();
    const beginNeverSettles = createHarness({
      observer: { begin: () => new Promise(() => {}) },
      observerTimeoutMs: 5,
    });
    await expect(
      beginNeverSettles.runs.start(owner, request),
    ).resolves.toMatchObject({ kind: 'admitted' });

    const updateNeverSettles = createPluginForegroundRuns({
      declarations: [declaration],
      coordinator: new MemoryCoordinator(),
      authorizer: { authorize: () => ({ kind: 'granted' }) },
      executionOwner: {
        id: 'worker-hanging-observer',
        pid: process.pid,
        birth: 'birth-hanging-observer',
        identityKind: 'exact',
      },
      processIdentity: { probe: () => ({ state: 'dead' }) },
      canRead: () => true,
      observerTimeoutMs: 5,
      observer: {
        begin: async () => ({ update: () => new Promise(() => {}) }),
      },
      logger: { warn },
    });
    const started = await updateNeverSettles.start(owner, request);
    if (started.kind !== 'admitted') throw new Error('expected admission');
    await expect(
      started.claim.beginEffect('2026-09-03T00:00:01.000Z'),
    ).resolves.toMatchObject({
      kind: 'applied',
      record: { state: 'running' },
    });
    expect(warn).toHaveBeenCalledWith(
      'Plugin foreground run observation unavailable',
      expect.objectContaining({ error: 'observer timed out' }),
    );
  });

  test('mirrors lifecycle into Action Operations without giving the observer run authority', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'plugin-runs-actions-'));
    const operations = new ActionOperationService(
      new FileActionOperationStore(directory),
    );
    const coordinator = new MemoryCoordinator();
    const runs = createPluginForegroundRuns({
      declarations: [declaration],
      coordinator,
      authorizer: { authorize: () => ({ kind: 'granted' }) },
      executionOwner: {
        id: 'worker-actions',
        pid: process.pid,
        birth: 'birth-actions',
        identityKind: 'exact',
      },
      processIdentity: { probe: () => ({ state: 'dead' }) },
      canRead: () => true,
      observer: createPluginForegroundActionOperationObserver({
        service: operations,
        actorFor: (candidate) => ({
          accountId: candidate.accountId,
          canReadSession: () => true,
        }),
      }),
    });
    const started = await runs.start(owner, request);
    if (started.kind !== 'admitted') throw new Error('expected admission');
    await started.claim.beginEffect('2026-09-03T00:00:01.000Z');
    await started.claim.completed('2026-09-03T00:00:02.000Z');

    await expect(
      operations.get(
        { accountId: owner.accountId, canReadSession: () => true },
        started.run.runId,
      ),
    ).resolves.toMatchObject({
      id: started.run.runId,
      status: 'succeeded',
      domain: { kind: 'platform-action', actionId: started.run.runId },
    });
    expect(coordinator.read(started.run.runId)).toMatchObject({
      state: 'completed',
      effectDepth: 'confirmed-effect',
    });
  });

  test('does not let an observer failure overturn canonical run truth', async () => {
    const coordinator = new MemoryCoordinator();
    const warn = vi.fn();
    const runs = createPluginForegroundRuns({
      declarations: [declaration],
      coordinator,
      authorizer: { authorize: () => ({ kind: 'granted' }) },
      executionOwner: {
        id: 'worker-observer-fault',
        pid: process.pid,
        identityKind: 'unverified',
      },
      processIdentity: { probe: () => ({ state: 'dead' }) },
      canRead: () => true,
      observer: {
        begin: async () => {
          throw new Error('injected observer fault');
        },
      },
      logger: { warn },
    });

    const started = await runs.start(owner, request);
    expect(started.kind).toBe('admitted');
    expect(warn).toHaveBeenCalledOnce();
    if (started.kind !== 'admitted') throw new Error('expected admission');
    await expect(
      started.claim.beginEffect('2026-09-03T00:00:01.000Z'),
    ).resolves.toMatchObject({ kind: 'applied', record: { state: 'running' } });
    expect(coordinator.read(started.run.runId)).toMatchObject({
      state: 'running',
      effectDepth: 'possible-effect',
    });
  });
});

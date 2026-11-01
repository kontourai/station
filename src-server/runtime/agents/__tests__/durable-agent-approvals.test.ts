import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createAgentRuntime,
  openSqliteAgentJournal,
  readSqliteAgentApproval,
} from '@kontourai/agent-runtime';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { afterEach, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ApprovalRegistry } from '../../../services/approvals/approval-registry.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';

const temp = trackTempDirs();
afterEach(() => vi.useRealTimers());
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
it('identical native tool IDs in different turns cannot share or overwrite a registry approval', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const db = new DatabaseSync(
    join(temp('durable-approval-scope-'), 'journal.sqlite'),
  );
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;',
  );
  const journal = openSqliteAgentJournal({ database: db });
  const bus = new EventBus();
  const registry = new ApprovalRegistry(
    { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    { eventBus: bus },
  );
  const publicationStates: string[] = [];
  const registryStates: string[] = [];
  const runtime = createAgentRuntime({
    journal,
    owner: { id: 'owner', pid: 123, identityKind: 'exact', birth: 'epoch' },
    liveness: () => 'live',
    implementation: 'approval-scope/1',
    now: () => 1_000,
    approvalSettled: (spec, approval) => {
      publicationStates.push(
        readSqliteAgentApproval({
          database: db,
          key: spec.key,
          id: approval.id,
        })!.state,
      );
    },
  });
  const key = {
    scopeId: 'station',
    conversationId: 'A',
    invocationId: 'turn-1',
  };
  const a = await runtime.start({
    key,
    input: 'A',
    implementation: 'approval-scope/1',
  });
  const b = await runtime.start({
    key: { ...key, conversationId: 'B' },
    input: 'B',
    implementation: 'approval-scope/1',
  });
  const tool = {
    id: 'tool:shared-native-id',
    input: { path: 'same.txt' },
    replay: 'unsafe' as const,
  };
  const requested: Array<{ id: string; key: typeof key }> = [];
  bus.subscribe((event) => {
    if (event.event !== SERVER_EVENTS.APPROVAL_RESOLVED) return;
    const request = requested.find(
      (value) => value.id === event.data?.approvalId,
    );
    if (request)
      registryStates.push(
        readSqliteAgentApproval({
          database: db,
          key: request.key,
          id: request.id,
        })!.state,
      );
  });
  const firstAsked = gate();
  const secondAsked = gate();
  const first = a.approval(tool, 60_000, async (pending) => {
    requested.push({ id: pending.id, key: a.key });
    firstAsked.resolve();
    return registry.register(pending.id, {
      timeoutMs: pending.remainingMs,
      metadata: { conversationId: 'A', source: 'runtime', title: 'probe' },
    });
  });
  const second = b.approval(tool, 60_000, async (pending) => {
    requested.push({ id: pending.id, key: b.key });
    secondAsked.resolve();
    return registry.register(pending.id, {
      timeoutMs: pending.remainingMs,
      metadata: { conversationId: 'B', source: 'runtime', title: 'probe' },
    });
  });
  void first.catch(() => {});
  void second.catch(() => {});
  try {
    await Promise.all([firstAsked.promise, secondAsked.promise]);
    expect(requested[0]!.id).not.toBe(requested[1]!.id);
    expect(registry.isPendingForSession(requested[0]!.id, 'A')).toBe(true);
    expect(registry.isPendingForSession(requested[0]!.id, 'B')).toBe(false);
    expect(registry.resolve(requested[0]!.id, true)).toBe(true);
    expect(await first).toBe(true);
    expect(
      readSqliteAgentApproval({
        database: db,
        key: b.key,
        id: requested[1]!.id,
      })?.state,
    ).toBe('pending');
    expect(registry.resolve(requested[1]!.id, false)).toBe(true);
    expect(await second).toBe(false);
    await a.run(async () => {});
    const next = await runtime.start({
      key: { ...key, invocationId: 'turn-2' },
      input: 'next',
      implementation: 'approval-scope/1',
    });
    const thirdAsked = gate();
    const third = next.approval(tool, 60_000, async (pending) => {
      requested.push({ id: pending.id, key: next.key });
      thirdAsked.resolve();
      return registry.register(pending.id, {
        timeoutMs: pending.remainingMs,
        metadata: { conversationId: 'A', source: 'runtime', title: 'probe' },
      });
    });
    await thirdAsked.promise;
    expect(new Set(requested.map((request) => request.id)).size).toBe(3);
    expect(registry.resolve(requested[2]!.id, false)).toBe(true);
    expect(await third).toBe(false);
    expect(registryStates).toEqual(['pending', 'pending', 'pending']);
    expect(publicationStates).toEqual(['approved', 'denied', 'denied']);
  } finally {
    registry.cancelAll();
    await vi.runAllTimersAsync();
    vi.clearAllTimers();
    await journal.close();
    db.close();
  }
});

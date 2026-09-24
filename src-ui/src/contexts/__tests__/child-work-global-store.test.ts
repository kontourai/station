/**
 * @vitest-environment jsdom
 */

/**
 * #2459: the window-wide engine-subagent registry behind the Agents pane's
 * "All" scope. It is fed from the dispatcher BEFORE the chat guard, so the
 * cases that matter are the ones a chat-gated registry cannot see, and the
 * ones where an absence of outcome must not be read as success.
 */

import type { ChildWorkItem } from '@kontourai/station-contracts/child-work';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-sdk', () => ({
  telemetry: { track: vi.fn() },
}));

import { handleOrchestrationEvent } from '../../hooks/orchestration/eventHandlers';
import { activeChatsStore } from '../active-chats-store';
import {
  childWorkGlobalStore,
  GLOBAL_CHILD_WORK_FINISHED_LIMIT,
  GLOBAL_CHILD_WORK_OBSERVABILITY_LIMIT,
  GLOBAL_CHILD_WORK_PARTITION_LIMIT,
} from '../child-work-global-store';

/** The Station these events arrive from (the store is partitioned by it). */
const API = 'http://localhost';

const CHATLESS = 'thread-no-chat-open';
let seq = 0;

function at() {
  seq += 1;
  return `2026-09-24T00:00:${String(seq % 60).padStart(2, '0')}.000Z`;
}

function registryTuple(threadId: string, active: unknown[]) {
  handleOrchestrationEvent('http://localhost', {
    eventId: `evt-${++seq}`,
    provider: 'claude',
    threadId,
    createdAt: at(),
    method: 'extension.notification',
    namespace: 'claude-code',
    type: 'task/registry',
    payload: { active },
  });
}

function running(threadId: string, childId: string): ChildWorkItem {
  return {
    producer: 'engine-subagent',
    reporterThreadId: threadId,
    childId,
    status: 'running',
  };
}

const items = () =>
  Object.values(childWorkGlobalStore.getPartition(API).registry.items);

describe('child-work global store', () => {
  beforeEach(() => {
    childWorkGlobalStore.reset();
    activeChatsStore.removeChat(CHATLESS);
    seq = 0;
  });

  test('a reporter with no chat open is folded through the dispatcher', () => {
    expect(activeChatsStore.getChatKeyForExecutionSession(CHATLESS)).toBe(
      undefined,
    );
    registryTuple(CHATLESS, [{ taskId: 't-1', description: 'Survey' }]);
    handleOrchestrationEvent('http://localhost', {
      eventId: `evt-${++seq}`,
      provider: 'codex',
      threadId: CHATLESS,
      createdAt: at(),
      method: 'child-work.updated',
      delta: { kind: 'upsert', item: running(CHATLESS, 'c-2') },
    });
    expect(items().map((item) => [item.childId, item.status])).toEqual([
      ['t-1', 'running'],
      ['c-2', 'running'],
    ]);
  });

  test('each Station has its own partition: events from A never reach B', () => {
    handleOrchestrationEvent('http://station-a.test', {
      eventId: 'evt-a',
      provider: 'codex',
      threadId: 'exec-a',
      createdAt: at(),
      method: 'child-work.updated',
      delta: { kind: 'upsert', item: running('exec-a', 'c-a') },
    });
    childWorkGlobalStore.reconcileSnapshot('http://station-a.test', [
      {
        threadId: 'exec-a2',
        childWork: { children: { observability: 'not-reported', reason: 'x' } },
      },
    ]);
    const b = childWorkGlobalStore.getPartition('http://station-b.test');
    expect(Object.keys(b.registry.items)).toEqual([]);
    expect(b.observability).toEqual({});
    const a = childWorkGlobalStore.getPartition('http://station-a.test');
    expect(Object.values(a.registry.items).map((item) => item.childId)).toEqual(
      ['c-a'],
    );
    // A full snapshot from B does not end A's children.
    childWorkGlobalStore.reconcileSnapshot('http://station-b.test', []);
    expect(
      childWorkGlobalStore.getPartition('http://station-a.test').registry.items,
    ).toEqual(a.registry.items);
  });

  test('partitions are bounded: the least recently written Station is released', () => {
    const write = (apiBase: string) =>
      childWorkGlobalStore.ingest(apiBase, {
        provider: 'codex',
        threadId: 'exec',
        createdAt: at(),
        method: 'child-work.updated',
        // A new child each time: an identical upsert changes nothing.
        delta: { kind: 'upsert', item: running('exec', `c-${++seq}`) },
      });
    const held = (apiBase: string) =>
      Object.keys(childWorkGlobalStore.getPartition(apiBase).registry.items)
        .length > 0;
    const bases = Array.from(
      { length: GLOBAL_CHILD_WORK_PARTITION_LIMIT + 1 },
      (_, index) => `http://station-${index}.test`,
    );
    for (const base of bases.slice(0, -1)) write(base);
    // Writing to the oldest again makes it the most recent.
    write(bases[0]);
    write(bases[bases.length - 1]);
    expect(held(bases[0])).toBe(true);
    expect(held(bases[1])).toBe(false);
    for (const base of bases.slice(2)) expect(held(base)).toBe(true);
  });

  test('a delta naming another reporter is not recorded', () => {
    handleOrchestrationEvent('http://localhost', {
      eventId: 'evt-x',
      provider: 'codex',
      threadId: CHATLESS,
      createdAt: at(),
      method: 'child-work.updated',
      delta: { kind: 'upsert', item: running('someone-else', 'c-9') },
    });
    expect(items()).toEqual([]);
  });

  test('a session exit ends its running children as unresolved — kept, never completed', () => {
    registryTuple(CHATLESS, [{ taskId: 't-1' }, { taskId: 't-2' }]);
    handleOrchestrationEvent('http://localhost', {
      eventId: `evt-${++seq}`,
      provider: 'claude',
      threadId: CHATLESS,
      createdAt: at(),
      method: 'session.exited',
      sessionId: CHATLESS,
    });
    expect(items().map((item) => item.status)).toEqual([
      'unresolved',
      'unresolved',
    ]);
  });

  test('a terminal state change ends them the same way', () => {
    childWorkGlobalStore.ingest(API, {
      provider: 'claude',
      threadId: CHATLESS,
      createdAt: at(),
      method: 'child-work.updated',
      delta: { kind: 'upsert', item: running(CHATLESS, 'c-1') },
    });
    childWorkGlobalStore.ingest(API, {
      provider: 'claude',
      threadId: CHATLESS,
      createdAt: at(),
      method: 'session.state-changed',
      sessionId: CHATLESS,
      from: 'running',
      to: 'errored',
    });
    expect(items()[0]?.status).toBe('unresolved');
  });

  test('the snapshot seeds running children and records a not-reported engine', () => {
    childWorkGlobalStore.reconcileSnapshot(API, [
      {
        threadId: 'reporter-a',
        childWork: {
          children: {
            observability: 'reported',
            running: [running('reporter-a', 'c-1')],
            observedAt: '2026-09-24T00:00:00.000Z',
          },
        },
      },
      {
        threadId: 'reporter-b',
        childWork: {
          children: { observability: 'not-reported', reason: 'ACP' },
        },
      },
    ]);
    expect(items().map((item) => item.childId)).toEqual(['c-1']);
    expect(childWorkGlobalStore.getPartition(API).observability).toEqual({
      'reporter-a': { kind: 'reported' },
      'reporter-b': { kind: 'not-reported', reason: 'ACP' },
    });
    // Not the reducer's never-forgotten map (R4).
    expect(childWorkGlobalStore.getPartition(API).registry.notReported).toEqual(
      {},
    );
  });

  test('a later report retracts an earlier refusal', () => {
    childWorkGlobalStore.ingest(API, {
      provider: 'codex',
      threadId: 'r-1',
      createdAt: at(),
      method: 'child-work.updated',
      delta: { kind: 'not-reported', reporterThreadId: 'r-1', reason: 'no' },
    });
    childWorkGlobalStore.ingest(API, {
      provider: 'codex',
      threadId: 'r-1',
      createdAt: at(),
      method: 'child-work.updated',
      delta: { kind: 'upsert', item: running('r-1', 'c-1') },
    });
    expect(childWorkGlobalStore.getPartition(API).observability['r-1']).toEqual(
      {
        kind: 'reported',
      },
    );
  });

  test('what a reporter said is forgotten on its exit, and when a full snapshot no longer lists it', () => {
    childWorkGlobalStore.reconcileSnapshot(API, [
      {
        threadId: 'gone-by-exit',
        childWork: { children: { observability: 'not-reported', reason: 'x' } },
      },
      {
        threadId: 'gone-by-snapshot',
        childWork: { children: { observability: 'not-reported', reason: 'y' } },
      },
    ]);
    childWorkGlobalStore.ingest(API, {
      provider: 'acp',
      threadId: 'gone-by-exit',
      createdAt: at(),
      method: 'session.exited',
      sessionId: 'gone-by-exit',
    });
    expect(
      Object.keys(childWorkGlobalStore.getPartition(API).observability),
    ).toEqual(['gone-by-snapshot']);
    childWorkGlobalStore.reconcileSnapshot(API, []);
    expect(childWorkGlobalStore.getPartition(API).observability).toEqual({});
  });

  test('what reporters said is bounded, oldest dropped first', () => {
    const total = GLOBAL_CHILD_WORK_OBSERVABILITY_LIMIT + 4;
    for (let index = 0; index < total; index += 1)
      childWorkGlobalStore.ingest(API, {
        provider: 'acp',
        threadId: `r-${index}`,
        createdAt: at(),
        method: 'child-work.updated',
        delta: {
          kind: 'not-reported',
          reporterThreadId: `r-${index}`,
          reason: 'none',
        },
      });
    const kept = Object.keys(
      childWorkGlobalStore.getPartition(API).observability,
    );
    expect(kept).toHaveLength(GLOBAL_CHILD_WORK_OBSERVABILITY_LIMIT);
    expect(kept).not.toContain('r-3');
    expect(kept).toContain('r-4');
    expect(kept).toContain(`r-${total - 1}`);
  });

  test('a reporter the full snapshot no longer lists is gone: unresolved, not completed', () => {
    childWorkGlobalStore.reconcileSnapshot(API, [
      {
        threadId: 'reporter-a',
        childWork: {
          children: {
            observability: 'reported',
            running: [running('reporter-a', 'c-1')],
            observedAt: '2026-09-24T00:00:00.000Z',
          },
        },
      },
    ]);
    childWorkGlobalStore.reconcileSnapshot(API, []);
    expect(items().map((item) => item.status)).toEqual(['unresolved']);
  });

  test('settled children are bounded across reporters, oldest-settled first', () => {
    const total = GLOBAL_CHILD_WORK_FINISHED_LIMIT + 5;
    for (let index = 0; index < total; index += 1) {
      const reporter = `reporter-${index}`;
      childWorkGlobalStore.ingest(API, {
        provider: 'codex',
        threadId: reporter,
        createdAt: new Date(Date.UTC(2026, 8, 24, 0, 0, index)).toISOString(),
        method: 'child-work.updated',
        delta: {
          kind: 'settle',
          producer: 'engine-subagent',
          reporterThreadId: reporter,
          childId: `c-${index}`,
          status: 'completed',
        },
      });
    }
    const kept = items().map((item) => item.childId);
    expect(kept).toHaveLength(GLOBAL_CHILD_WORK_FINISHED_LIMIT);
    // The five settled first are the five evicted.
    expect(kept).not.toContain('c-0');
    expect(kept).not.toContain('c-4');
    expect(kept).toContain('c-5');
    expect(kept).toContain(`c-${total - 1}`);
  });

  test('running children never count against the finished bound', () => {
    for (let index = 0; index < GLOBAL_CHILD_WORK_FINISHED_LIMIT + 3; index++)
      childWorkGlobalStore.ingest(API, {
        provider: 'codex',
        threadId: `r-${index}`,
        createdAt: at(),
        method: 'child-work.updated',
        delta: { kind: 'upsert', item: running(`r-${index}`, 'c') },
      });
    expect(items()).toHaveLength(GLOBAL_CHILD_WORK_FINISHED_LIMIT + 3);
  });
});

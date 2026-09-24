/**
 * #2457: the Claude adapter's child work, replayed from REAL claude captures
 * (`claude-task-captures.ts`) through the adapter's own mapper and folded
 * with the contract reducer — the same fold every consumer runs.
 */
import {
  applyChildWorkDelta,
  type ChildWorkDelta,
  type ChildWorkItem,
  type ChildWorkRegistryState,
  createEmptyChildWorkRegistry,
} from '@kontourai/station-contracts/child-work';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test } from 'vitest';
import {
  CLAUDE_TASK_CAPTURES,
  type ClaudeTaskCaptureName,
  loadClaudeTaskCapture,
  replayClaudeTaskCapture,
} from './claude-task-captures.js';

function deltasOf(events: CanonicalRuntimeEvent[]): ChildWorkDelta[] {
  return events.flatMap((event) =>
    event.method === 'child-work.updated' ? [event.delta] : [],
  );
}

function foldAll(deltas: ChildWorkDelta[]): ChildWorkRegistryState {
  return deltas.reduce(applyChildWorkDelta, createEmptyChildWorkRegistry());
}

function itemsOf(events: CanonicalRuntimeEvent[]): ChildWorkItem[] {
  return Object.values(foldAll(deltasOf(events)).items);
}

/** The `local_agent` task ids the capture started, in order. */
function agentTaskIds(name: ClaudeTaskCaptureName): string[] {
  const ids: string[] = [];
  for (const line of loadClaudeTaskCapture(name)) {
    const message = line.message as
      | {
          type?: string;
          subtype?: string;
          task_id?: string;
          task_type?: string;
        }
      | undefined;
    if (
      message?.type === 'system' &&
      message.subtype === 'task_started' &&
      message.task_type === 'local_agent' &&
      message.task_id &&
      !ids.includes(message.task_id)
    ) {
      ids.push(message.task_id);
    }
  }
  return ids;
}

/** Each child's status after every delta, in order, collapsing repeats. */
function statusHistory(deltas: ChildWorkDelta[], childId: string): string[] {
  const history: string[] = [];
  let state = createEmptyChildWorkRegistry();
  for (const delta of deltas) {
    state = applyChildWorkDelta(state, delta);
    const item = Object.values(state.items).find(
      (candidate) => candidate.childId === childId,
    );
    if (item && history.at(-1) !== item.status) history.push(item.status);
  }
  return history;
}

describe('#2457 Claude child work, replayed from real captures', () => {
  for (const name of CLAUDE_TASK_CAPTURES) {
    describe(name, () => {
      const { events } = replayClaudeTaskCapture(name);
      const deltas = deltasOf(events);

      test('emits no pre-contract task tuple', () => {
        expect(
          events.filter(
            (event) =>
              event.method === 'extension.notification' &&
              (event.type === 'task/registry' || event.type === 'task/settled'),
          ),
        ).toEqual([]);
      });

      test('every emitted delta changes the fold (no emit on a no-op)', () => {
        let state = createEmptyChildWorkRegistry();
        for (const delta of deltas) {
          const next = applyChildWorkDelta(state, delta);
          expect(next).not.toBe(state);
          state = next;
        }
      });

      test('#1877: each agent is listed running before anything settles it', () => {
        const ids = agentTaskIds(name);
        expect(ids.length).toBeGreaterThan(0);
        for (const childId of ids) {
          expect(statusHistory(deltas, childId)[0]).toBe('running');
        }
      });

      test('owned_by_subagent shell calls are never child work', () => {
        const childIds = new Set(itemsOf(events).map((item) => item.childId));
        expect([...childIds].sort()).toEqual([...agentTaskIds(name)].sort());
      });

      test('#1878: nothing is left running once the session ends', () => {
        expect(
          itemsOf(events).filter((item) => item.status === 'running'),
        ).toEqual([]);
      });

      test('every running child offers the per-task stop', () => {
        for (const delta of deltas) {
          if (delta.kind !== 'snapshot') continue;
          for (const item of delta.running) {
            expect(item.controls).toEqual({ stop: 'provider-task-stop' });
          }
        }
      });
    });
  }

  test.each([
    'background-agent',
    'stop-task',
    'close-kills',
    'progress-summary',
    'subagent-permission',
  ] as const)('%s: backgrounded comes from task_started', (name) => {
    const { events } = replayClaudeTaskCapture(name);
    const [first] = deltasOf(events);
    expect(first).toMatchObject({
      kind: 'snapshot',
      running: [{ backgrounded: true, depth: 1 }],
    });
  });

  test('task-subagents: the foreground agent is not backgrounded', () => {
    const items = itemsOf(replayClaudeTaskCapture('task-subagents').events);
    expect(items.map((item) => item.backgrounded)).toEqual([false, true]);
  });

  test('progress-summary: the model summary and running usage arrive as upserts', () => {
    const deltas = deltasOf(replayClaudeTaskCapture('progress-summary').events);
    const upserts = deltas.filter((delta) => delta.kind === 'upsert');
    expect(upserts.length).toBeGreaterThan(2);
    expect(upserts).toContainEqual(
      expect.objectContaining({
        item: expect.objectContaining({
          progress: 'Executing second sleep interval.',
          usage: { totalTokens: 42345, toolUses: 4, durationMs: 68172 },
          // The title stays the child's name.
          title: 'Run four sleep commands sequentially',
        }),
      }),
    );
    // Without a summary, the line is the description plus the tool.
    expect(upserts[0]).toMatchObject({
      item: { progress: 'Running Sleep for 20 seconds (1 of 4) — Bash' },
    });
  });

  test.each([
    'task-subagents',
    'background-agent',
    'progress-summary',
    'subagent-permission',
  ] as const)(
    '#1892 %s: both terminals settle, the child settles once, and the result survives',
    (name) => {
      const { events } = replayClaudeTaskCapture(name);
      const deltas = deltasOf(events);
      for (const childId of agentTaskIds(name)) {
        const settles = deltas.filter(
          (delta) => delta.kind === 'settle' && delta.childId === childId,
        );
        // task_updated then task_notification: two settles on the wire…
        expect(settles.length).toBe(2);
        // …one terminal transition in the fold…
        expect(statusHistory(deltas, childId)).toEqual([
          'running',
          'completed',
        ]);
        // …and the notification's result and usage are on the final item.
        const item = itemsOf(events).find(
          (candidate) => candidate.childId === childId,
        );
        expect(item?.result?.summary).toBeTruthy();
        expect(item?.result?.handle).toMatchObject({ kind: 'transcript-file' });
        expect(item?.usage?.totalTokens).toBeGreaterThan(0);
      }
    },
  );

  test('#1878 stop-task: Query.stopTask settles the child cancelled, never completed', () => {
    const { events } = replayClaudeTaskCapture('stop-task');
    const [childId] = agentTaskIds('stop-task');
    expect(statusHistory(deltasOf(events), childId)).toEqual([
      'running',
      'cancelled',
    ]);
    expect(itemsOf(events)).toEqual([
      expect.objectContaining({
        childId,
        status: 'cancelled',
        result: expect.objectContaining({
          handle: expect.objectContaining({ kind: 'transcript-file' }),
        }),
      }),
    ]);
  });

  test('#1878 close-kills: the engine sends no terminal, so session end settles the child unresolved', () => {
    const lines = loadClaudeTaskCapture('close-kills');
    // Premise, from the capture itself: no terminal frame for the agent.
    const [childId] = agentTaskIds('close-kills');
    expect(
      lines.filter((line) => {
        const message = line.message as
          | { subtype?: string; task_id?: string }
          | undefined;
        return (
          message?.task_id === childId &&
          (message.subtype === 'task_notification' ||
            message.subtype === 'task_updated')
        );
      }),
    ).toEqual([]);
    const { events } = replayClaudeTaskCapture('close-kills');
    expect(statusHistory(deltasOf(events), childId)).toEqual([
      'running',
      'unresolved',
    ]);
  });

  test('#1878 close-kills after a stop request: the session end reports stopped-unconfirmed', () => {
    const lines = loadClaudeTaskCapture('close-kills');
    const [childId] = agentTaskIds('close-kills');
    const closeAt = lines.findIndex((line) => line.probe === 'CLOSE INPUT');
    expect(closeAt).toBeGreaterThan(0);
    const { events } = replayClaudeTaskCapture('close-kills', {
      extraProbes: { [closeAt]: `STOP_TASK ${childId}` },
    });
    expect(statusHistory(deltasOf(events), childId)).toEqual([
      'running',
      'stopped-unconfirmed',
    ]);
  });

  test('nested-agent: the inner agent carries depth 2; its resumed re-run under the same id is not re-listed', () => {
    const { events } = replayClaudeTaskCapture('nested-agent');
    const items = itemsOf(events);
    expect(
      items.map((item) => [item.depth, item.status, item.backgrounded]),
    ).toEqual([
      [1, 'completed', false],
      [2, 'completed', true],
    ]);
    // The capture starts the inner id twice (a resume, new tool_use_id); the
    // contract never revives a settled child, so it is listed once.
    const [, inner] = agentTaskIds('nested-agent');
    expect(statusHistory(deltasOf(events), inner)).toEqual([
      'running',
      'completed',
    ]);
  });
});

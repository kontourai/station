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
import { resolveClaudeChildStop } from '../adapters/claude-adapter-child-work.js';
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

/**
 * The child ids the capture's agents should be listed under: each
 * `local_agent` start, keyed by its `task_id` the first time and
 * `${task_id}:${tool_use_id}` when a settled id is started again (a resume).
 */
function expectedChildIds(name: ClaudeTaskCaptureName): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const line of loadClaudeTaskCapture(name)) {
    const message = line.message as
      | {
          type?: string;
          subtype?: string;
          task_id?: string;
          task_type?: string;
          tool_use_id?: string;
        }
      | undefined;
    if (
      message?.type !== 'system' ||
      message.subtype !== 'task_started' ||
      message.task_type !== 'local_agent' ||
      !message.task_id
    ) {
      continue;
    }
    ids.push(
      seen.has(message.task_id)
        ? `${message.task_id}:${message.tool_use_id}`
        : message.task_id,
    );
    seen.add(message.task_id);
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
        const ids = expectedChildIds(name);
        expect(ids.length).toBeGreaterThan(0);
        for (const childId of ids) {
          expect(statusHistory(deltas, childId)[0]).toBe('running');
        }
      });

      test('owned_by_subagent shell calls are never child work', () => {
        const childIds = new Set(itemsOf(events).map((item) => item.childId));
        expect([...childIds].sort()).toEqual(
          [...expectedChildIds(name)].sort(),
        );
      });

      test('#1878: nothing is left running once the session ends', () => {
        expect(
          itemsOf(events).filter((item) => item.status === 'running'),
        ).toEqual([]);
      });

      test('every expected run settles exactly once in the fold', () => {
        for (const childId of expectedChildIds(name)) {
          const history = statusHistory(deltas, childId);
          expect(history[0]).toBe('running');
          expect(history.length).toBeGreaterThanOrEqual(2);
        }
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
    // Without a summary, the line is the description plus the tool. (#3163:
    // the child's model arrives as an upsert of its own, without progress.)
    const progressed = upserts.filter(
      (delta) => delta.kind === 'upsert' && delta.item.progress !== undefined,
    );
    expect(progressed[0]).toMatchObject({
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

  test('#3308 task-subagents: a child whose task_updated carried no usage ends with the notification figure, not its running one', () => {
    const { events } = replayClaudeTaskCapture('task-subagents');
    const [, background] = agentTaskIds('task-subagents');
    const deltas = deltasOf(events);
    // Premise: the running figure arrived first, and the first settle had none.
    expect(deltas).toContainEqual(
      expect.objectContaining({
        kind: 'upsert',
        item: expect.objectContaining({
          childId: background,
          usage: { totalTokens: 40141, toolUses: 1, durationMs: 1854 },
        }),
      }),
    );
    const settles = deltas.filter(
      (delta) => delta.kind === 'settle' && delta.childId === background,
    );
    expect(settles.map((delta) => 'usage' in delta && delta.usage)).toEqual([
      false,
      { totalTokens: 41833, toolUses: 1, durationMs: 3677 },
    ]);
    const item = itemsOf(events).find(
      (candidate) => candidate.childId === background,
    );
    expect(item?.usage).toEqual({
      totalTokens: 41833,
      toolUses: 1,
      durationMs: 3677,
    });
    expect(item?.usageProvisional).toBeUndefined();
  });

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

  test('#2457 R4 nested-agent: a resumed re-run of a settled task_id is its own child — listed running, with Stop, then settled', () => {
    const { events } = replayClaudeTaskCapture('nested-agent');
    const [outer, inner, rerun] = expectedChildIds('nested-agent');
    // Premise, from the capture: the inner task_id is started twice.
    expect(rerun.startsWith(`${inner}:toolu_`)).toBe(true);
    const deltas = deltasOf(events);
    // The first run keeps the bare task_id — the legacy (replay) key.
    expect(statusHistory(deltas, inner)).toEqual(['running', 'completed']);
    expect(statusHistory(deltas, rerun)).toEqual(['running', 'completed']);
    expect(
      deltas.some(
        (delta) =>
          delta.kind === 'snapshot' &&
          delta.running.some(
            (item) =>
              item.childId === rerun &&
              item.depth === 2 &&
              item.controls?.stop === 'provider-task-stop',
          ),
      ),
    ).toBe(true);
    const items = itemsOf(events);
    expect(items.map((item) => [item.childId, item.depth])).toEqual([
      [outer, 1],
      [inner, 2],
      [rerun, 2],
    ]);
    // Each run keeps its own spawning call.
    expect(items[1].parent?.toolCallId).not.toBe(items[2].parent?.toolCallId);
  });

  test('#2457 R4: a stop addressed to a re-run reaches the engine as its SDK task_id', () => {
    const lines = loadClaudeTaskCapture('nested-agent');
    const [, inner, rerun] = expectedChildIds('nested-agent');
    const restartAt = lines.findIndex(
      (line) =>
        (line.message as { subtype?: string; task_id?: string } | undefined)
          ?.subtype === 'task_started' &&
        (line.message as { tool_use_id?: string }).tool_use_id ===
          rerun.slice(inner.length + 1),
    );
    expect(restartAt).toBeGreaterThan(0);
    const { record } = replayClaudeTaskCapture('nested-agent', {
      stopAfterLine: restartAt,
    });
    expect(resolveClaudeChildStop(record, rerun)).toEqual({
      taskId: inner,
      childId: rerun,
    });
    // A bare task_id addresses the id's CURRENT run.
    expect(resolveClaudeChildStop(record, inner)).toEqual({
      taskId: inner,
      childId: rerun,
    });
  });

  test('#2457 V2: the captured canUseTool agentID IS the subagent task_id (the #2348 premise)', () => {
    const lines = loadClaudeTaskCapture('subagent-permission');
    const probes = lines.flatMap((line) =>
      line.probe?.startsWith('CAN_USE_TOOL ')
        ? [
            JSON.parse(line.probe.slice('CAN_USE_TOOL '.length)) as {
              toolName: string;
              agentID: string | null;
            },
          ]
        : [],
    );
    const [taskId] = expectedChildIds('subagent-permission');
    expect(probes.length).toBeGreaterThan(0);
    expect(probes).toContainEqual(
      expect.objectContaining({ toolName: 'Bash', agentID: taskId }),
    );
    expect(taskId).toMatch(/^a[0-9a-f]+$/);
  });

  test('#2457 R1 stop-task: a real stopped notification drained after the session end corrects stopped-unconfirmed to cancelled', () => {
    const lines = loadClaudeTaskCapture('stop-task');
    const stopAt = lines.findIndex((line) =>
      line.probe?.startsWith('STOP_TASK '),
    );
    const [childId] = expectedChildIds('stop-task');
    // The session ends right after the stop request, before the engine's
    // answer is read (stopSession's grace elapsing); the answer drains after.
    const { events } = replayClaudeTaskCapture('stop-task', {
      extraProbes: { [stopAt + 1]: 'ITERATOR END' },
    });
    expect(statusHistory(deltasOf(events), childId)).toEqual([
      'running',
      'stopped-unconfirmed',
      'cancelled',
    ]);
  });
});

/**
 * #3163: each subagent's OWN model, from the replies it produces itself
 * (`parent_tool_use_id` = its spawning tool call). Every capture ran the
 * session and its agents on one model, so the different-model cases rewrite
 * only the `message.model` of the subagent frames; every other line, and the
 * frames' shape, is exactly as captured.
 */
describe('#3163 Claude subagent model and transcript identity', () => {
  const SESSION_MODEL = 'claude-haiku-4-5-20251001';
  const OUTER_MODEL = 'claude-sonnet-4-5-20250929';
  const INNER_MODEL = 'claude-opus-4-1-20250805';

  type FrameView = {
    type?: string;
    parent_tool_use_id?: string | null;
    message?: { model?: string };
    subtype?: string;
    task_id?: string;
    tool_use_id?: string;
    session_id?: string;
  };
  const view = (line: { message?: unknown }) =>
    (line.message ?? {}) as FrameView;

  /** The spawning tool call of each local_agent task_started, in order. */
  function spawnCalls(): string[] {
    return loadClaudeTaskCapture('nested-agent').flatMap((line) => {
      const message = view(line);
      return message.subtype === 'task_started' && message.tool_use_id
        ? [message.tool_use_id]
        : [];
    });
  }

  /** Rewrites the model of every frame a given spawn's subagent produced. */
  function withSubagentModels(models: Record<string, string>) {
    return (lines: ReturnType<typeof loadClaudeTaskCapture>) =>
      lines.map((line) => {
        const message = view(line);
        const parent = message.parent_tool_use_id;
        if (message.type !== 'assistant' || !parent || !models[parent])
          return line;
        const raw = line.message as unknown as {
          message: Record<string, unknown>;
        };
        return {
          message: {
            ...raw,
            message: { ...raw.message, model: models[parent] },
          } as unknown as typeof line.message,
        } as typeof line;
      });
  }

  test('premise: the capture runs the session on one model and nests a resumed agent', () => {
    const lines = loadClaudeTaskCapture('nested-agent');
    const models = new Set(
      lines.flatMap((line) => {
        const message = view(line);
        return message.type === 'assistant' && message.message?.model
          ? [message.message.model]
          : [];
      }),
    );
    expect([...models]).toEqual([SESSION_MODEL]);
    const [outerCall, innerCall, rerunCall] = spawnCalls();
    expect([outerCall, innerCall, rerunCall].every(Boolean)).toBe(true);
    // The resumed inner agent replies under its ORIGINAL spawn's call.
    const rerunAt = lines.findIndex(
      (line) => view(line).tool_use_id === rerunCall,
    );
    expect(
      lines
        .slice(rerunAt + 1)
        .some((line) => view(line).parent_tool_use_id === innerCall),
    ).toBe(true);
    expect(
      lines.some((line) => view(line).parent_tool_use_id === rerunCall),
    ).toBe(false);
  });

  test('a subagent on a different model than its parent shows its own; a nested one shows ITS own; the session keeps its model', () => {
    const [outerCall, innerCall] = spawnCalls();
    const { events } = replayClaudeTaskCapture('nested-agent', {
      rewrite: withSubagentModels({
        [outerCall]: OUTER_MODEL,
        [innerCall]: INNER_MODEL,
      }),
    });
    const [outer, inner, rerun] = expectedChildIds('nested-agent');
    const byId = new Map(itemsOf(events).map((item) => [item.childId, item]));
    expect(byId.get(outer)?.model).toEqual({
      id: OUTER_MODEL,
      source: 'subagent-reply',
    });
    expect(byId.get(inner)?.model).toEqual({
      id: INNER_MODEL,
      source: 'subagent-reply',
    });
    // The resume's replies name the original spawn; they still reach the
    // re-run, which is that agent's current run.
    expect(byId.get(rerun)?.model).toEqual({
      id: INNER_MODEL,
      source: 'subagent-reply',
    });
    // Nested replies never leak to the root session: no event but the
    // child-work deltas names a subagent's model, and every turn reports the
    // session's own.
    for (const event of events) {
      if (event.method === 'child-work.updated') continue;
      const text = JSON.stringify(event);
      expect(text).not.toContain(OUTER_MODEL);
      expect(text).not.toContain(INNER_MODEL);
    }
    const turnModels = events.flatMap((event) =>
      event.method === 'turn.completed' && event.metadata
        ? [JSON.stringify(event.metadata)]
        : [],
    );
    expect(turnModels.length).toBeGreaterThan(0);
    for (const metadata of turnModels)
      expect(metadata).toContain(SESSION_MODEL);
  });

  test('a model is never borrowed: before its first reply a child has no model, though the session model is on the wire', () => {
    const lines = loadClaudeTaskCapture('nested-agent');
    const [outerCall] = spawnCalls();
    const startedAt = lines.findIndex(
      (line) =>
        view(line).subtype === 'task_started' &&
        view(line).tool_use_id === outerCall,
    );
    const { events } = replayClaudeTaskCapture('nested-agent', {
      stopAfterLine: startedAt,
    });
    const [outer] = expectedChildIds('nested-agent');
    const item = itemsOf(events).find(
      (candidate) => candidate.childId === outer,
    );
    expect(item?.status).toBe('running');
    expect(item?.model).toBeUndefined();
    for (const delta of deltasOf(events)) {
      expect(JSON.stringify(delta)).not.toContain(SESSION_MODEL);
    }
  });

  test('the session replying while a background child runs gives that child no model', () => {
    // Captured order: the agent starts in the background, the SESSION then
    // replies (on its own model), and only later does the agent reply.
    const lines = loadClaudeTaskCapture('background-agent');
    const startedAt = lines.findIndex(
      (line) =>
        view(line).subtype === 'task_started' &&
        (line.message as { task_type?: string }).task_type === 'local_agent',
    );
    const ownReplyAt = lines.findIndex(
      (line, index) =>
        index > startedAt &&
        view(line).type === 'assistant' &&
        Boolean(view(line).parent_tool_use_id),
    );
    const sessionReplies = lines
      .slice(startedAt + 1, ownReplyAt)
      .filter(
        (line) =>
          view(line).type === 'assistant' &&
          view(line).parent_tool_use_id === null &&
          view(line).message?.model === SESSION_MODEL,
      );
    expect(sessionReplies.length).toBeGreaterThan(0);
    const { events } = replayClaudeTaskCapture('background-agent', {
      stopAfterLine: ownReplyAt - 1,
    });
    const [childId] = expectedChildIds('background-agent');
    const item = itemsOf(events).find(
      (candidate) => candidate.childId === childId,
    );
    expect(item?.status).toBe('running');
    expect(item?.model).toBeUndefined();
  });

  test('a reply that beats its task_started is held and applied when the task registers', () => {
    const [outerCall] = spawnCalls();
    const reorder = (lines: ReturnType<typeof loadClaudeTaskCapture>) => {
      const startedAt = lines.findIndex(
        (line) =>
          view(line).subtype === 'task_started' &&
          view(line).tool_use_id === outerCall,
      );
      const replyAt = lines.findIndex(
        (line) =>
          view(line).type === 'assistant' &&
          view(line).parent_tool_use_id === outerCall,
      );
      expect(replyAt).toBeGreaterThan(startedAt);
      const next = [...lines];
      const [reply] = next.splice(replyAt, 1);
      next.splice(startedAt, 0, reply);
      return withSubagentModels({ [outerCall]: OUTER_MODEL })(next);
    };
    const { events } = replayClaudeTaskCapture('nested-agent', {
      rewrite: reorder,
    });
    const [outer] = expectedChildIds('nested-agent');
    const firstListing = deltasOf(events)
      .flatMap((delta) => (delta.kind === 'snapshot' ? delta.running : []))
      .find((item) => item.childId === outer);
    expect(firstListing?.model).toEqual({
      id: OUTER_MODEL,
      source: 'subagent-reply',
    });
  });

  test('a later synthetic reply never erases the real model a subagent reported', () => {
    const [outerCall] = spawnCalls();
    // The outer agent replies on Sonnet, then a synthesized frame (an API
    // error, an interruption) arrives under the same spawn.
    const realThenSynthetic = (
      lines: ReturnType<typeof loadClaudeTaskCapture>,
    ) => {
      const rewritten = withSubagentModels({ [outerCall]: OUTER_MODEL })(lines);
      const ownReplies = rewritten.flatMap((line, index) =>
        view(line).type === 'assistant' &&
        view(line).parent_tool_use_id === outerCall
          ? [index]
          : [],
      );
      const lastOwnReply = ownReplies[ownReplies.length - 1];
      const own = rewritten[lastOwnReply].message as unknown as {
        message: Record<string, unknown>;
      };
      const synthetic = {
        message: {
          ...own,
          uuid: '00000000-0000-4000-8000-0000000000ff',
          message: { ...own.message, model: '<synthetic>' },
        },
      } as unknown as (typeof rewritten)[number];
      return [
        ...rewritten.slice(0, lastOwnReply + 1),
        synthetic,
        ...rewritten.slice(lastOwnReply + 1),
      ];
    };
    const { events } = replayClaudeTaskCapture('nested-agent', {
      rewrite: realThenSynthetic,
    });
    const [outer] = expectedChildIds('nested-agent');
    expect(
      itemsOf(events).find((item) => item.childId === outer)?.model,
    ).toEqual({ id: OUTER_MODEL, source: 'subagent-reply' });
    for (const delta of deltasOf(events))
      expect(JSON.stringify(delta)).not.toContain('<synthetic>');
  });

  test('a synthetic reply names no model', () => {
    const [outerCall] = spawnCalls();
    const { events } = replayClaudeTaskCapture('nested-agent', {
      rewrite: withSubagentModels({ [outerCall]: '<synthetic>' }),
    });
    const [outer] = expectedChildIds('nested-agent');
    expect(
      itemsOf(events).find((item) => item.childId === outer)?.model,
    ).toBeUndefined();
  });

  test('each agent names its transcript by Claude session and agent id, and the settle carries it with the model', () => {
    const lines = loadClaudeTaskCapture('nested-agent');
    const sessionId = lines
      .map((line) => view(line))
      .find((message) => message.subtype === 'task_started')?.session_id;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const [outerCall] = spawnCalls();
    const { events } = replayClaudeTaskCapture('nested-agent', {
      rewrite: withSubagentModels({ [outerCall]: OUTER_MODEL }),
    });
    const [outer, inner, rerun] = expectedChildIds('nested-agent');
    const byId = new Map(itemsOf(events).map((item) => [item.childId, item]));
    expect(byId.get(outer)?.transcript).toEqual({
      kind: 'claude-subagent',
      sessionId,
      agentId: outer,
    });
    // A re-run is the same agent: the same transcript.
    expect(byId.get(rerun)?.transcript).toEqual(byId.get(inner)?.transcript);
    const outerSettle = deltasOf(events).find(
      (delta) =>
        delta.kind === 'settle' &&
        delta.childId === outer &&
        delta.status === 'completed',
    );
    expect(outerSettle).toMatchObject({
      identity: {
        model: { id: OUTER_MODEL, source: 'subagent-reply' },
        transcript: { kind: 'claude-subagent', agentId: outer },
      },
    });
  });
});

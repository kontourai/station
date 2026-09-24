/**
 * #2456 conformance tripwire: every engine's `subagentObservability` cell in
 * the capability matrix is checked against what that engine's adapter
 * ACTUALLY emits as child work, by replaying captured engine output through
 * the adapter's own mapper and folding the resulting `child-work.updated`
 * events.
 *
 * - `declared` → the observed signals must be exactly the declared ones,
 *   less any registered gap; each gap is a `test.fails` linked to its issue.
 * - `none` → the adapter must emit no child work at all for the engine's
 *   real output.
 *
 * A signal is only counted when the delta carries it:
 *   lifecycle = a settle for a child a same-reporter snapshot listed running
 *   progress  = an upsert with a progress line
 *   usage     = child usage on a settle or upsert
 *   result    = a summary or a result handle on a settle
 *   nesting   = a depth on any child
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  type ChildWorkDelta,
  type ChildWorkItem,
  childWorkDeltaFromLegacyClaudeTaskNotification,
  childWorkKey,
} from '@kontourai/station-contracts/child-work';
import {
  ENGINE_CAPABILITY_MATRICES,
  type SubagentSignal,
} from '@kontourai/station-contracts/engine-capability-matrix';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test } from 'vitest';
import { STATION_UNMAPPED_SUBAGENT_ENGINES } from '../../services/orchestration/child-work-projection.js';
import { mapAcpExtensionNotification } from '../adapters/acp-adapter-events.js';
import {
  type ClaudeMessageState,
  mapClaudeSdkMessage,
} from '../adapters/claude-adapter-events.js';
import { recordClaudeTurnDispatched } from '../adapters/claude-sdk-turns.js';
import { handleCodexNotification } from '../adapters/codex-adapter-notifications.js';
import type { CodexSessionRecord } from '../adapters/codex-adapter-types.js';
import { MuseAdapter } from '../adapters/muse-adapter.js';
import type { MuseProcessLike } from '../adapters/muse-adapter-types.js';
import {
  MUSE_13_BACKGROUND_WORKFLOW_TURN_LINES,
  MUSE_13_BASH_TOOL_TURN_LINES,
} from './muse-adapter-fixtures.js';

type Driver = {
  /** The adapter module whose mapper this driver actually runs. */
  adapterModule?: string;
  /** Replays the engine's captured output; returns everything published. */
  run: () => Promise<CanonicalRuntimeEvent[]>;
};

const CLAUDE_TASK_SUBAGENTS_FIXTURE = readFileSync(
  new URL('./fixtures/claude-task-subagents.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((line) => line.length > 0);

/**
 * A REAL capture (`fixtures/claude-task-subagents.jsonl`, recorded by
 * `fixtures/capture-claude-task-fixtures.mjs` against
 * @anthropic-ai/claude-agent-sdk 0.3.261 / claude 2.1.261, haiku): one
 * foreground and one backgrounded Task subagent, every SDK message in order.
 */
async function replayClaudeCapture(): Promise<CanonicalRuntimeEvent[]> {
  const events: CanonicalRuntimeEvent[] = [];
  const record: ClaudeMessageState = {
    session: {
      provider: 'claude',
      threadId: 'thread-claude',
      status: 'running',
      createdAt: '2026-09-23T00:00:00.000Z',
      updatedAt: '2026-09-23T00:00:00.000Z',
    },
    lastSessionState: 'running',
  };
  // #2324: turn identity lives in the SDK turn ledger; dispatching turn-1
  // makes it the running turn, as the live adapter does.
  recordClaudeTurnDispatched(record, 'turn-1');
  for (const line of CLAUDE_TASK_SUBAGENTS_FIXTURE) {
    mapClaudeSdkMessage({
      provider: 'claude',
      record,
      message: JSON.parse(line) as SDKMessage,
      publish: (event) => events.push(event),
    });
  }
  return events;
}

class FakeMuseProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor() {
    super();
    this.stdout.setEncoding('utf8');
    this.stderr.setEncoding('utf8');
  }
  kill(): boolean {
    this.killed = true;
    this.exit(null);
    return true;
  }
  exit(code: number | null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 0;
    this.emit('exit', code);
  }
}

/**
 * The REAL muse 1.3 captures already committed for the muse adapter (a bash
 * tool turn and a background-workflow turn), fed through the actual adapter
 * with its process replaced by a stream double.
 */
async function replayMuseCaptures(): Promise<CanonicalRuntimeEvent[]> {
  const events: CanonicalRuntimeEvent[] = [];
  for (const [index, lines] of [
    MUSE_13_BASH_TOOL_TURN_LINES,
    MUSE_13_BACKGROUND_WORKFLOW_TURN_LINES,
  ].entries()) {
    const processes: FakeMuseProcess[] = [];
    const adapter = new MuseAdapter({
      newSessionId: () => `muse-session-${index}`,
      processFactory: () => {
        const processHandle = new FakeMuseProcess();
        processes.push(processHandle);
        return { process: processHandle, release: () => {} };
      },
      terminateProcess: async (processHandle: MuseProcessLike) => {
        processHandle.kill('SIGTERM');
      },
      logger: { warn: () => {}, info: () => {} },
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    const threadId = `thread-muse-${index}`;
    await adapter.startSession({ provider: 'muse', threadId });
    await adapter.sendTurn({ threadId, input: 'go' });
    for (const line of lines) processes[0].stdout.write(`${line}\n`);
    await new Promise((settle) => setTimeout(settle, 20));
    // Collect whatever the adapter published; stop once the queue is quiet.
    for (;;) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<'quiet'>((settle) => setTimeout(() => settle('quiet'), 30)),
      ]);
      if (next === 'quiet' || next.done) break;
      events.push(next.value as CanonicalRuntimeEvent);
    }
    await adapter.stopAll();
  }
  return events;
}

/**
 * ACP: `_kiro.dev/subagent/list_update` is the one subagent-shaped tuple a
 * Kiro ACP agent was observed sending (station#1935, bound as host chrome).
 * Only the TUPLE was observed; no payload was captured, so the params here
 * are an empty object and the claim under test is the routing: the mapper
 * forwards it as an opaque extension notification, never as child work.
 */
async function replayAcpKiroSubagentTuple(): Promise<CanonicalRuntimeEvent[]> {
  const events: CanonicalRuntimeEvent[] = [];
  mapAcpExtensionNotification('_kiro.dev/subagent/list_update', {}, {
    provider: 'acp',
    session: { threadId: 'thread-acp' },
    publish: (event: CanonicalRuntimeEvent) => events.push(event),
  } as unknown as Parameters<typeof mapAcpExtensionNotification>[2]);
  return events;
}

/**
 * Codex: NOT a live capture. A `collabAgentToolCall` thread item shaped from
 * the protocol schema codex-cli 0.155.1 itself generates
 * (`codex app-server generate-ts`, `v2/ThreadItem.ts`): a `spawnAgent` call
 * starting and then completing with its receiver `completed`. Station has no
 * collab handling (#2458), so this is the known-gap input, not evidence of
 * the wire.
 */
async function replayCodexCollabSchemaShape(): Promise<
  CanonicalRuntimeEvent[]
> {
  const events: CanonicalRuntimeEvent[] = [];
  const record = {
    externalThreadId: 'thread-codex',
    session: {
      provider: 'codex',
      threadId: 'thread-codex',
      status: 'running',
      createdAt: '2026-09-23T00:00:00.000Z',
      updatedAt: '2026-09-23T00:00:00.000Z',
    },
    lastSessionState: 'running',
    turnOutput: new Map(),
    toolNames: new Map(),
    openToolCalls: new Map(),
    pendingRpcRequests: new Map(),
    pendingApprovals: new Map(),
    approvedTools: new Set(),
    activeTurnId: 'turn-1',
    stopped: false,
  } as unknown as CodexSessionRecord;
  const item = (status: string, agentStatus: string) => ({
    type: 'collabAgentToolCall',
    id: 'collab-1',
    tool: 'spawnAgent',
    status,
    senderThreadId: 'thread-codex',
    receiverThreadIds: ['thread-codex-child'],
    prompt: 'Summarise the repo',
    model: null,
    reasoningEffort: null,
    agentsStates: {
      'thread-codex-child': { status: agentStatus, message: null },
    },
  });
  for (const [method, params] of [
    [
      'item/started',
      {
        threadId: 'thread-codex',
        turnId: 'turn-1',
        item: item('inProgress', 'running'),
      },
    ],
    [
      'item/completed',
      {
        threadId: 'thread-codex',
        turnId: 'turn-1',
        item: item('completed', 'completed'),
      },
    ],
  ] as const) {
    handleCodexNotification({
      notification: { method, params },
      nowIso: () => '2026-09-23T00:00:01.000Z',
      publish: (event) => events.push(event),
      record,
    });
  }
  return events;
}

/**
 * Station's own engine: its matrix cell is `none` (Station delegation is a
 * task, not an engine subagent). STRUCTURAL guard only: there is no captured
 * engine output to replay, so this asserts the adapter module never names the
 * child-work event at all.
 */
async function stationAdapterStructural(): Promise<CanonicalRuntimeEvent[]> {
  const source = readFileSync(
    new URL('../adapters/station-agent-adapter.ts', import.meta.url),
    'utf8',
  );
  expect(source).not.toContain('child-work.updated');
  return [];
}

const DRIVERS: Record<string, Driver> = {
  station: { run: stationAdapterStructural },
  // Via the legacy translator until #2457: the adapter's existing pure
  // mapper emits `claude-code` task tuples, which `childWorkDeltas` reads
  // exactly as the server projection does.
  claude: {
    adapterModule: 'claude-adapter-events.ts',
    run: replayClaudeCapture,
  },
  codex: {
    // Where Codex notifications are actually mapped; the matrix cell names
    // `codex-adapter-events.ts` (see the known-gap tests below).
    adapterModule: 'codex-adapter-notifications.ts',
    run: replayCodexCollabSchemaShape,
  },
  muse: { run: replayMuseCaptures },
  acp: { run: replayAcpKiroSubagentTuple },
};

/**
 * The child work a replay produced, read exactly as the server projection
 * reads it: `child-work.updated` deltas, plus — until #2457 moves the Claude
 * adapter onto the contract — its legacy `claude-code` task tuples through
 * the contract's one translator. For every other engine the translator
 * matches nothing, so it cannot manufacture a signal.
 */
function childWorkDeltas(events: CanonicalRuntimeEvent[]): ChildWorkDelta[] {
  return events.flatMap((event) => {
    if (event.method === 'child-work.updated') return [event.delta];
    if (event.method !== 'extension.notification') return [];
    const legacy = childWorkDeltaFromLegacyClaudeTaskNotification(
      event,
      event.threadId,
    );
    return legacy ? [legacy] : [];
  });
}

function itemsOf(delta: ChildWorkDelta): ChildWorkItem[] {
  if (delta.kind === 'snapshot') return delta.running;
  if (delta.kind === 'upsert') return [delta.item];
  return [];
}

function observedSignals(deltas: ChildWorkDelta[]): Set<SubagentSignal> {
  const signals = new Set<SubagentSignal>();
  // Lifecycle is ONE child's start and end: a settle for a key that a
  // snapshot from the same reporter listed as running. Any running snapshot
  // plus any unrelated settle proves nothing about either.
  const listedRunning = new Set(
    deltas.flatMap((delta) =>
      delta.kind === 'snapshot'
        ? delta.running
            .filter(
              (item) =>
                item.reporterThreadId === delta.reporterThreadId &&
                item.producer === delta.producer,
            )
            .map((item) => childWorkKey(item))
        : [],
    ),
  );
  if (
    deltas.some(
      (delta) =>
        delta.kind === 'settle' && listedRunning.has(childWorkKey(delta)),
    )
  ) {
    signals.add('lifecycle');
  }
  for (const delta of deltas) {
    if (delta.kind === 'upsert' && delta.item.progress) {
      signals.add('progress');
    }
    if (
      (delta.kind === 'settle' && delta.usage) ||
      (delta.kind === 'upsert' && delta.item.usage)
    ) {
      signals.add('usage');
    }
    if (
      delta.kind === 'settle' &&
      (delta.result?.summary || delta.result?.handle)
    ) {
      signals.add('result');
    }
    if (
      itemsOf(delta).some((item) => item.depth !== undefined) ||
      (delta.kind === 'settle' && delta.identity?.depth !== undefined)
    ) {
      signals.add('nesting');
    }
  }
  return signals;
}

/**
 * Declared signals the adapter does not yet deliver: registered, tracked gaps
 * rather than passes. Each one is a `test.fails`, so it turns red the moment
 * the signal IS delivered — the cue to delete the entry.
 */
const KNOWN_SIGNAL_GAPS: Record<
  string,
  Partial<Record<SubagentSignal, string>>
> = {
  // #2457: via the legacy translator, Claude's `task_progress` reaches
  // clients only as `tool.progress`; no child-work progress exists until the
  // adapter emits the contract's `upsert`.
  claude: { progress: '#2457' },
  // #2458: Codex declares `lifecycle`, but Station has no collabAgent
  // handling, so no child work is emitted at all.
  codex: { lifecycle: '#2458' },
};

/**
 * #2458: the Codex cell names `codex-adapter-events.ts`, but Codex
 * notifications are mapped in `codex-adapter-notifications.ts`. Registered
 * with the Codex gap; the cell should name wherever collab handling lands.
 */
const KNOWN_MODULE_GAPS: Record<string, string> = { codex: '#2458' };

describe('#2456 child-work conformance tripwire', () => {
  test("the projection's unmapped-engine set is exactly the engines whose declared lifecycle is a known gap", () => {
    const lifecycleGaps = Object.fromEntries(
      Object.entries(KNOWN_SIGNAL_GAPS).flatMap(([key, gaps]) =>
        gaps?.lifecycle ? [[key, gaps.lifecycle]] : [],
      ),
    );
    expect(STATION_UNMAPPED_SUBAGENT_ENGINES).toEqual(lifecycleGaps);
  });

  test('there is exactly one driver per matrix engine key', () => {
    expect(Object.keys(DRIVERS).sort()).toEqual(
      Object.keys(ENGINE_CAPABILITY_MATRICES).sort(),
    );
  });

  for (const [key, matrix] of Object.entries(ENGINE_CAPABILITY_MATRICES)) {
    const cell = matrix.subagentObservability;
    const driver = DRIVERS[key];
    if (cell.state === 'none') {
      test(`${key}: declared none — real output emits no child work`, async () => {
        const events = await driver.run();
        // The replay must actually have reached the mapper; an empty stream
        // would pass the assertion below vacuously. Station's driver is the
        // labelled structural exception (no engine output to replay).
        if (key !== 'station') expect(events.length).toBeGreaterThan(0);
        expect(childWorkDeltas(events)).toEqual([]);
      });
      continue;
    }
    const moduleTest = KNOWN_MODULE_GAPS[key] ? test.fails : test;
    moduleTest(
      `${key}: the driver runs the adapter module the cell names`,
      () => {
        expect(driver.adapterModule).toBe(cell.adapterModule);
      },
    );
    const gaps = KNOWN_SIGNAL_GAPS[key] ?? {};
    const expected = cell.signals.filter((signal) => !gaps[signal]);
    test(`${key}: observed signals are the declared ones, less registered gaps`, async () => {
      const observed = observedSignals(childWorkDeltas(await driver.run()));
      expect([...observed].sort()).toEqual([...expected].sort());
    });
    for (const [signal, issue] of Object.entries(gaps)) {
      test.fails(`${key}: delivers declared ${signal} (known gap ${issue})`, async () => {
        const observed = observedSignals(childWorkDeltas(await driver.run()));
        expect(observed.has(signal as SubagentSignal)).toBe(true);
      });
    }
  }

  test('the Claude capture, via the legacy translator until #2457, is the two-task shape the claims rest on', async () => {
    const deltas = childWorkDeltas(await replayClaudeCapture());
    const settled = deltas.filter((delta) => delta.kind === 'settle');
    // Each subagent settles twice (task_updated then task_notification).
    expect(new Set(settled.map((delta) => delta.childId)).size).toBe(2);
    expect(
      deltas.some(
        (delta) =>
          delta.kind === 'snapshot' &&
          delta.running.some((item) => item.depth === 1),
      ),
    ).toBe(true);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * #2324 review H1: the real Claude adapter's emission for a send racing (and
 * folded into) a turn the engine opened on its own, driven from live
 * captures THROUGH `OrchestrationService` — persisted events, the session
 * lifecycle, the conversation activity record, the Stop target and the
 * terminal-identity anchor every completion consumer (including the push
 * notification) folds. The adapter-level fixture test proves what the
 * adapter emits; this proves the server can follow it.
 */

const { mockQuery, mockFindCliBinaryAsync, mockRunCliCommand } = vi.hoisted(
  () => ({
    mockQuery: vi.fn(),
    mockFindCliBinaryAsync: vi.fn(),
    mockRunCliCommand: vi.fn(),
  }),
);

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  deleteSession: vi.fn(),
  forkSession: vi.fn(),
  listSessions: vi.fn(),
  query: mockQuery,
}));

vi.mock('../../../providers/auth/cli-auth.js', () => ({
  buildCliRuntimePrerequisites: vi.fn().mockResolvedValue([]),
  augmentedSpawnEnv: vi.fn(),
  findCliBinaryAsync: mockFindCliBinaryAsync,
  runCliCommand: mockRunCliCommand,
}));

import {
  type ClaudeProviderTurnFixtureLine,
  loadClaudeProviderTurnFixture,
} from '../../../providers/__tests__/claude-provider-turns-fixtures.js';
import { loadClaudeTaskCapture } from '../../../providers/__tests__/claude-task-captures.js';
import type { ProviderAdapterShape } from '../../../providers/adapter-shape.js';
import { ClaudeAdapter } from '../../../providers/adapters/claude-adapter.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { createOrchestrationRoutes } from '../../../routes/orchestration/orchestration.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import {
  acceptsTurnTerminalEvent,
  activeTurnIdForEvents,
  interruptibleTurnIdForEvents,
  turnIdentityAnchorForEvents,
} from '../session-lifecycle-service.js';

type FixtureLine = ClaudeProviderTurnFixtureLine;
const loadFixture = loadClaudeProviderTurnFixture;

/** The race: Station read the push before the engine's own turn's `init`. */
function pushBeforeRunningTurnInit(lines: FixtureLine[]): FixtureLine[] {
  const pushAt = lines.findIndex((line) => line.probe === 'PUSH U2');
  let initAt = -1;
  for (let index = pushAt - 1; index >= 0; index--) {
    if (lines[index].msg?.subtype === 'init') {
      initAt = index;
      break;
    }
  }
  const moved = [...lines];
  const [push] = moved.splice(pushAt, 1);
  moved.splice(initAt, 0, push);
  return moved;
}

function controlledQuery() {
  const pending: unknown[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  return {
    push(message: unknown) {
      pending.push(message);
      wake?.();
      wake = null;
    },
    /** The engine process ends: the SDK iterator finishes. */
    end() {
      ended = true;
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (pending.length === 0) {
          if (ended) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        yield pending.shift();
      }
    },
    interrupt: vi.fn().mockResolvedValue({ still_queued: [] }),
    supportedModels: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    applyFlagSettings: vi.fn().mockResolvedValue(undefined),
  };
}

function registry(adapter: ProviderAdapterShape): IProviderAdapterRegistry {
  return {
    register() {},
    get: (provider) => (provider === adapter.provider ? adapter : undefined),
    list: () => [adapter],
  };
}

const settle = async () => {
  for (let index = 0; index < 5; index++)
    await new Promise((resolve) => setTimeout(resolve, 0));
};

interface Midpoint {
  events: CanonicalRuntimeEvent[];
  lifecycleState?: string;
  openTurnId?: string;
  activeTurnId?: string;
  stopTarget?: string;
}

describe('#2324 review H1: provider-triggered turns through OrchestrationService', () => {
  let directory: string;
  let eventStore: EventStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'claude-provider-turns-service-'));
    eventStore = new EventStore(join(directory, 'orchestration.sqlite'));
    mockFindCliBinaryAsync.mockResolvedValue(null);
    mockRunCliCommand.mockResolvedValue(null);
  });

  afterEach(() => {
    eventStore.close();
    rmSync(directory, { recursive: true, force: true });
    mockQuery.mockReset();
  });

  async function run(
    lines: FixtureLine[],
    options: {
      /** End the engine right after the first message this matches. */
      endAfter?: (
        message: Record<string, unknown>,
        sends: ReadonlyMap<string, string>,
      ) => boolean;
    } = {},
  ) {
    const query = controlledQuery();
    mockQuery.mockReturnValue(query);
    const adapter = new ClaudeAdapter();
    const service = new OrchestrationService({
      adapterRegistry: registry(adapter),
      eventBus: new EventBus(),
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = `service-${crypto.randomUUID()}`;
    await service.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude' },
    });
    const prompts = mockQuery.mock.calls
      .at(-1)![0]
      .prompt[Symbol.asyncIterator]() as AsyncIterator<{ uuid: string }>;
    const rewrites = new Map<string, string>();
    const sends = new Map<string, string>();
    const persisted = () =>
      eventStore.listEvents(threadId).map((row) => row.payload);
    let midpoint: Midpoint | undefined;
    let stoppedFirstTurn = false;

    const capturedUuidAfter = (from: number) => {
      for (let index = from + 1; index < lines.length; index++) {
        const msg = lines[index].msg;
        if (msg?.type === 'command_lifecycle' && msg.state === 'queued')
          return String(msg.command_uuid);
      }
      return undefined;
    };

    for (const [index, line] of lines.entries()) {
      if (line.probe?.startsWith('PUSH ')) {
        const label = line.probe.slice('PUSH '.length);
        await service.dispatch({
          type: 'sendTurn',
          input: { threadId, input: label },
        });
        const pushed = (await prompts.next()).value;
        sends.set(label, pushed.uuid);
        const captured = capturedUuidAfter(index);
        if (captured) rewrites.set(captured, pushed.uuid);
        await settle();
        continue;
      }
      if (!line.msg) continue;
      // The user stops their first turn before its own result lands (it
      // has already launched the background work). A thread whose last
      // turn COMPLETED refuses further sends on that thread (the
      // conversation continues in a new session instead), so this is the
      // shape in which a send can reach the same live Claude query while
      // the engine is about to answer on its own.
      if (line.msg.type === 'result' && !stoppedFirstTurn) {
        stoppedFirstTurn = true;
        await service.dispatch({ type: 'interruptTurn', threadId });
        await settle();
      }
      let text = JSON.stringify(line.msg);
      for (const [from, to] of rewrites) text = text.split(from).join(to);
      const message = JSON.parse(text) as Record<string, unknown>;
      // The capture's working directory is a scrubbed placeholder; the
      // session's real one is this test's directory.
      if (message.subtype === 'init') message.cwd = directory;
      query.push(message);
      await settle();
      if (options.endAfter?.(message, sends)) {
        query.end();
        await settle();
        break;
      }
      // The first reply frame that names U2: U2 is replying now.
      const u2 = sends.get('U2');
      if (
        !midpoint &&
        u2 &&
        message.type === 'stream_event' &&
        message.user_message_uuid === u2
      ) {
        const events = persisted();
        const detail = await service.readSession(
          threadId,
          INTERNAL_SESSION_READ_SCOPE,
        );
        midpoint = {
          events,
          lifecycleState: detail?.session.lifecycleState,
          openTurnId: detail?.session.conversationActivity?.openTurn?.turnId,
          activeTurnId: activeTurnIdForEvents(events),
          stopTarget: interruptibleTurnIdForEvents(events),
        };
      }
    }
    await settle();
    const detail = await service.readSession(
      threadId,
      INTERNAL_SESSION_READ_SCOPE,
    );
    return {
      service,
      threadId,
      sends,
      midpoint,
      events: persisted(),
      detail,
      possibleEffect: eventStore
        .sessionTurnBoundaryAuthority()
        .hasPossibleEffect(threadId),
    };
  }

  const turnFacts = (events: CanonicalRuntimeEvent[]) =>
    events.flatMap((event) =>
      event.method === 'turn.started' ||
      event.method === 'turn.completed' ||
      event.method === 'turn.aborted'
        ? [
            `${event.method}:${event.turnId?.startsWith('provider:') ? 'P' : event.turnId}`,
          ]
        : [],
    );

  for (const [name, fixture] of [
    ['a send racing the engine’s own turn', 'send-races-provider-turn-start'],
    [
      'a send the engine folds into its own turn',
      'send-folded-into-provider-turn',
    ],
  ] as const) {
    test(`${name}: the server folds follow it — the send's reply has an open turn, a Stop target, and an accepted completion`, async () => {
      const { sends, midpoint, events, detail } = await run(
        pushBeforeRunningTurnInit(loadFixture(fixture)),
      );
      const u1 = sends.get('U1')!;
      const u2 = sends.get('U2')!;
      // Persisted in the engine's order.
      expect(turnFacts(events)).toEqual([
        `turn.started:${u1}`,
        `turn.aborted:${u1}`,
        'turn.started:P',
        'turn.completed:P',
        `turn.started:${u2}`,
        `turn.completed:${u2}`,
      ]);
      // While U2 replies, every fold sees U2 open.
      expect(midpoint).toMatchObject({
        activeTurnId: u2,
        stopTarget: u2,
        lifecycleState: 'running',
        openTurnId: u2,
      });
      // U2's completion is accepted by the identity anchor the lifecycle,
      // agent-run and notification folds share.
      const u2Completion = events.find(
        (
          event,
        ): event is Extract<
          CanonicalRuntimeEvent,
          { method: 'turn.completed' }
        > => event.method === 'turn.completed' && event.turnId === u2,
      )!;
      const before = events.slice(0, events.indexOf(u2Completion));
      expect(
        acceptsTurnTerminalEvent(
          u2Completion,
          turnIdentityAnchorForEvents(before),
        ),
      ).toBe(true);
      // And the session ends settled on U2's reply, not the engine's.
      expect(detail?.session).toMatchObject({
        lifecycleState: 'idle',
        transitionReason: 'turn_completed',
      });
      expect(activeTurnIdForEvents(events)).toBeUndefined();
      expect(detail?.session.conversationActivity?.openTurn).toBeUndefined();
    });
  }

  test('M-1: a send still queued when the engine ends reaches the transcript with its message, then ends, and its boundary retires', async () => {
    const { sends, events, possibleEffect } = await run(
      pushBeforeRunningTurnInit(loadFixture('send-races-provider-turn-start')),
      {
        // The engine's own reply has begun; U2 is still queued behind it.
        endAfter: (message, sent) =>
          sent.has('U2') &&
          message.type === 'stream_event' &&
          message.user_message_uuid === undefined,
      },
    );
    const u2 = sends.get('U2')!;
    const u2Events = events.filter((event) => event.turnId === u2);
    expect(u2Events.map((event) => event.method)).toEqual([
      'turn.started',
      'turn.aborted',
    ]);
    expect(u2Events[0]).toMatchObject({ prompt: 'U2' });
    expect(u2Events[1]).toMatchObject({ reason: 'engine-ended-before-start' });
    expect(possibleEffect).toEqual({ kind: 'available', active: false });
  });
});

/**
 * #2457: the Claude adapter's child work, from live captures, THROUGH
 * `OrchestrationService` (and, for the stop, its HTTP route): the session
 * summary carries the running child mid-stream and not after, the persisted
 * log holds `child-work.updated` and no pre-contract task tuple, and a stop
 * reaches `Query.stopTask` and settles the child from the engine's own
 * `stopped` notification.
 */
describe('#2457: Claude child work through OrchestrationService', () => {
  let directory: string;
  let eventStore: EventStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'claude-child-work-service-'));
    eventStore = new EventStore(join(directory, 'orchestration.sqlite'));
    mockFindCliBinaryAsync.mockResolvedValue(null);
    mockRunCliCommand.mockResolvedValue(null);
  });

  afterEach(() => {
    eventStore.close();
    rmSync(directory, { recursive: true, force: true });
    mockQuery.mockReset();
  });

  async function startService() {
    const query = Object.assign(controlledQuery(), {
      stopTask: vi.fn<(taskId: string) => Promise<void>>(),
    });
    mockQuery.mockReturnValue(query);
    const adapter = new ClaudeAdapter();
    const eventBus = new EventBus();
    const service = new OrchestrationService({
      adapterRegistry: registry(adapter),
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = `service-${crypto.randomUUID()}`;
    await service.dispatch({
      type: 'startSession',
      input: { threadId, provider: 'claude' },
    });
    const routes = createOrchestrationRoutes(service, {
      eventBus,
      logger: { debug: vi.fn() },
      getUserId: () => 'user-1',
    });
    const children = async () =>
      (await service.readSession(threadId, INTERNAL_SESSION_READ_SCOPE))
        ?.session.childWork?.children;
    const persisted = () =>
      eventStore.listEvents(threadId).map((row) => row.payload);
    const pushMessage = async (message: SDKMessage) => {
      const next = JSON.parse(JSON.stringify(message)) as Record<
        string,
        unknown
      >;
      if (next.subtype === 'init') next.cwd = directory;
      query.push(next);
      await settle();
    };
    return {
      query,
      service,
      threadId,
      routes,
      children,
      persisted,
      pushMessage,
    };
  }

  function legacyTuples(events: CanonicalRuntimeEvent[]) {
    return events.filter(
      (event) =>
        event.method === 'extension.notification' &&
        (event.type === 'task/registry' || event.type === 'task/settled'),
    );
  }

  test('background-agent: the summary lists the child while it runs and not after; no legacy tuple is persisted', async () => {
    const { service, threadId, children, persisted, pushMessage, query } =
      await startService();
    const lines = loadClaudeTaskCapture('background-agent');
    const [childId] = lines.flatMap((line) =>
      line.message?.type === 'system' &&
      line.message.subtype === 'task_started' &&
      (line.message as { task_type?: string }).task_type === 'local_agent'
        ? [line.message.task_id]
        : [],
    );
    let listedMidStream = false;
    for (const line of lines) {
      if (line.probe?.startsWith('PUSH ')) {
        await service.dispatch({
          type: 'sendTurn',
          input: { threadId, input: line.probe.slice('PUSH '.length) },
        });
        await settle();
        continue;
      }
      if (line.probe === 'CLOSE INPUT') {
        query.end();
        await settle();
        break;
      }
      if (!line.message) continue;
      await pushMessage(line.message);
      const view = await children();
      if (
        view?.observability === 'reported' &&
        view.running.some(
          (item) => item.childId === childId && item.status === 'running',
        )
      ) {
        listedMidStream = true;
      }
    }
    expect(listedMidStream).toBe(true);
    expect(await children()).toMatchObject({
      observability: 'reported',
      running: [],
    });
    const events = persisted();
    expect(legacyTuples(events)).toEqual([]);
    const settles = events.flatMap((event) =>
      event.method === 'child-work.updated' &&
      event.delta.kind === 'settle' &&
      event.delta.childId === childId
        ? [event.delta.status]
        : [],
    );
    expect(settles).toEqual(['completed', 'completed']);
  });

  test('stop-task: POST …/provider-tasks/:taskId/stop reaches Query.stopTask and the engine’s stopped settle cancels the child', async () => {
    const { query, threadId, routes, children, persisted, pushMessage } =
      await startService();
    const lines = loadClaudeTaskCapture('stop-task');
    const stopAt = lines.findIndex((line) =>
      line.probe?.startsWith('STOP_TASK '),
    );
    const childId = lines[stopAt].probe!.slice('STOP_TASK '.length);
    // The engine's answer to the stop, exactly as captured.
    query.stopTask.mockImplementation(async (taskId) => {
      for (const line of lines.slice(stopAt + 1)) {
        const message = line.message as { task_id?: string } | undefined;
        if (message?.task_id === taskId) query.push(line.message);
      }
    });
    for (const line of lines.slice(0, stopAt)) {
      if (line.message) await pushMessage(line.message);
    }
    expect(await children()).toMatchObject({
      running: [
        expect.objectContaining({
          childId,
          controls: { stop: 'provider-task-stop' },
        }),
      ],
    });

    const stop = () =>
      routes.request(`/sessions/${threadId}/provider-tasks/${childId}/stop`, {
        method: 'POST',
      });
    const response = await stop();
    expect(await response.json()).toEqual({
      success: true,
      data: { outcome: 'stopped', taskId: childId },
    });
    expect(query.stopTask).toHaveBeenCalledWith(childId);
    await settle();

    expect(await children()).toMatchObject({ running: [] });
    const settled = persisted().flatMap((event) =>
      event.method === 'child-work.updated' &&
      event.delta.kind === 'settle' &&
      event.delta.childId === childId
        ? [event.delta.status]
        : [],
    );
    expect(settled).toEqual(['cancelled', 'cancelled']);
    // Settled: a second stop is the documented race, not an error.
    expect(await (await stop()).json()).toEqual({
      success: true,
      data: { outcome: 'no-active-task', taskId: childId },
    });
    expect(query.stopTask).toHaveBeenCalledTimes(1);
  });
});

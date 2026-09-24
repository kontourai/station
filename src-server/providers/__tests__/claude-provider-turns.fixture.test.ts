import { PROVIDER_TURN_IN_PROGRESS_CODE } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * #2324: provider-triggered turns, replayed from REAL Claude streams.
 *
 * Each fixture is a scrubbed capture of `claude` 2.1.281 driven through the
 * Agent SDK with Station's option shape (streaming input,
 * `includePartialMessages`, default permission mode). Lines are
 * `{"t": ms, "msg": <SDK message>}` in emission order, plus the probe's own
 * actions `{"t": ms, "probe": "PUSH U2" | "INTERRUPT during P" | ...}` at the
 * moment it took them. Removed from the capture: hook, rate-limit and
 * thinking-token frames (nothing here reads them), signature deltas, and
 * `session_state_changed` — the capture set `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`,
 * which Station does not, so Station never receives those frames.
 *
 * The replay drives the real `ClaudeAdapter` against a controlled query: a
 * `PUSH` calls `sendTurn` (or `steerTurn`), and every uuid the capture used
 * for that message is rewritten to the one the adapter queued, so the
 * engine's `command_lifecycle` and `user_message_uuid(s)` name Station's turn
 * exactly as the live CLI would.
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

vi.mock('../auth/cli-auth.js', () => ({
  buildCliRuntimePrerequisites: vi.fn(),
  augmentedSpawnEnv: vi.fn(),
  findCliBinaryAsync: mockFindCliBinaryAsync,
  runCliCommand: mockRunCliCommand,
}));

import { ProviderTurnInProgressError } from '../adapter-shape.js';
import { ClaudeAdapter } from '../adapters/claude-adapter.js';
import {
  CLAUDE_PROVIDER_TURN_FIXTURES,
  type ClaudeProviderTurnFixtureLine,
  loadClaudeProviderTurnFixture,
  readClaudeProviderTurnFixture,
} from './claude-provider-turns-fixtures.js';

type FixtureLine = ClaudeProviderTurnFixtureLine;
const FIXTURES = CLAUDE_PROVIDER_TURN_FIXTURES;
const readFixture = readClaudeProviderTurnFixture;
const loadFixture = loadClaudeProviderTurnFixture;

/**
 * Moves the `PUSH <label>` action to just before the `init` of the SDK turn
 * that was already running when it was pushed: the race where the engine had
 * begun its own turn but Station had not yet read that `init`.
 */
function pushBeforeRunningTurnInit(
  lines: FixtureLine[],
  label: string,
): FixtureLine[] {
  const pushAt = lines.findIndex((line) => line.probe === `PUSH ${label}`);
  let initAt = -1;
  for (let index = pushAt - 1; index >= 0; index--) {
    if (lines[index].msg?.subtype === 'init') {
      initAt = index;
      break;
    }
  }
  expect(pushAt).toBeGreaterThan(0);
  expect(initAt).toBeGreaterThan(0);
  const moved = [...lines];
  const [push] = moved.splice(pushAt, 1);
  moved.splice(initAt, 0, push);
  return moved;
}

function createControlledMockQuery() {
  const pending: unknown[] = [];
  let wake: (() => void) | null = null;
  return {
    push(message: unknown) {
      pending.push(message);
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (pending.length === 0) {
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

type PushMode = 'send' | 'steer';

interface ReplayResult {
  events: CanonicalRuntimeEvent[];
  sends: Map<string, { turnId?: string; error?: unknown }>;
  adapter: ClaudeAdapter;
  threadId: string;
}

async function replay(
  lines: FixtureLine[],
  options: {
    pushMode?: Record<string, PushMode>;
    /** Stop replaying after the first message this returns true for. */
    stopAfter?: (msg: Record<string, unknown>) => boolean;
  } = {},
): Promise<ReplayResult> {
  const controlled = createControlledMockQuery();
  mockQuery.mockReturnValue(controlled);
  const adapter = new ClaudeAdapter();
  const events: CanonicalRuntimeEvent[] = [];
  void (async () => {
    for await (const event of adapter.streamEvents()) events.push(event);
  })();
  const threadId = `fixture-${crypto.randomUUID()}`;
  await adapter.startSession({ provider: 'claude', threadId });
  const queued = mockQuery.mock.calls
    .at(-1)![0]
    .prompt[Symbol.asyncIterator]() as AsyncIterator<{ uuid: string }>;
  const rewrites = new Map<string, string>();
  const sends = new Map<string, { turnId?: string; error?: unknown }>();

  const capturedUuidFor = (fromIndex: number): string | undefined => {
    for (let index = fromIndex + 1; index < lines.length; index++) {
      const msg = lines[index].msg;
      if (msg?.type === 'command_lifecycle' && msg.state === 'queued') {
        return String(msg.command_uuid);
      }
    }
    return undefined;
  };

  for (const [index, line] of lines.entries()) {
    if (line.probe?.startsWith('PUSH ')) {
      const label = line.probe.slice('PUSH '.length).split(' ')[0];
      const mode = options.pushMode?.[label] ?? 'send';
      try {
        if (mode === 'steer') {
          // Steer the turn the transcript shows running, as a client does.
          const turnId = [...events]
            .reverse()
            .find((event) => event.method === 'turn.started')?.turnId;
          await adapter.steerTurn(threadId, label, turnId!);
          sends.set(label, { turnId });
        } else {
          const started = await adapter.sendTurn({ threadId, input: label });
          sends.set(label, { turnId: started.turnId });
        }
        const pushed = (await queued.next()).value;
        const captured = capturedUuidFor(index);
        if (captured) rewrites.set(captured, pushed.uuid);
      } catch (error) {
        sends.set(label, { error });
      }
      await flush();
      continue;
    }
    if (line.probe?.startsWith('INTERRUPT')) {
      await adapter.interruptTurn(threadId);
      await flush();
      continue;
    }
    if (!line.msg) continue;
    let text = JSON.stringify(line.msg);
    for (const [from, to] of rewrites) text = text.split(from).join(to);
    const msg = JSON.parse(text) as Record<string, unknown>;
    controlled.push(msg);
    await flush();
    if (options.stopAfter?.(msg)) break;
  }
  await flush();
  return { events, sends, adapter, threadId };
}

interface TurnFact {
  method: string;
  turnId: string;
  trigger?: unknown;
  outputText?: string;
  finishReason?: string;
  prompt?: string;
}

const turnFacts = (events: CanonicalRuntimeEvent[]): TurnFact[] =>
  events.flatMap((event): TurnFact[] => {
    switch (event.method) {
      case 'turn.started':
        return [
          {
            method: event.method,
            turnId: event.turnId,
            ...(event.metadata?.trigger
              ? { trigger: event.metadata.trigger }
              : {}),
            ...(event.prompt !== undefined ? { prompt: event.prompt } : {}),
          },
        ];
      case 'turn.completed':
        return [
          {
            method: event.method,
            turnId: event.turnId,
            ...(event.metadata?.trigger
              ? { trigger: event.metadata.trigger }
              : {}),
            ...(event.outputText !== undefined
              ? { outputText: event.outputText }
              : {}),
            ...(event.finishReason ? { finishReason: event.finishReason } : {}),
          },
        ];
      case 'turn.aborted':
        return [
          {
            method: event.method,
            turnId: event.turnId,
            ...(event.metadata?.trigger
              ? { trigger: event.metadata.trigger }
              : {}),
          },
        ];
      case 'runtime.error':
        return [{ method: event.method, turnId: event.turnId ?? '' }];
      default:
        return [];
    }
  });

const textFor = (events: CanonicalRuntimeEvent[], turnId: string) =>
  events
    .flatMap((event) =>
      event.method === 'content.text-delta' && event.turnId === turnId
        ? [event.delta]
        : [],
    )
    .join('');

const isProviderId = (turnId: unknown) =>
  typeof turnId === 'string' && turnId.startsWith('provider:');

describe('#2324 provider-triggered turns, replayed from live Claude streams', () => {
  beforeEach(() => {
    mockFindCliBinaryAsync.mockReset();
    mockFindCliBinaryAsync.mockResolvedValue(null);
    mockRunCliCommand.mockReset();
    mockRunCliCommand.mockResolvedValue(null);
  });

  afterEach(() => {
    mockQuery.mockReset();
  });

  test('the fixtures are scrubbed of machine paths and personal names', () => {
    for (const name of FIXTURES) {
      const text = readFixture(name);
      for (const token of [
        '/Users/',
        '/private/',
        'brian',
        'claude-501',
        'kontour',
        '@kontourai',
      ]) {
        expect(text.toLowerCase(), `${name}: ${token}`).not.toContain(
          token.toLowerCase(),
        );
      }
    }
  });

  test('an unprompted reply after background work is its own provider turn, closed by its own result', async () => {
    const { events, sends, adapter, threadId } = await replay(
      loadFixture('background-bash'),
    );
    const u1 = sends.get('U1')!.turnId!;
    const facts = turnFacts(events);
    expect(facts).toEqual([
      { method: 'turn.started', turnId: u1, prompt: 'U1' },
      {
        method: 'turn.completed',
        turnId: u1,
        outputText: 'started',
        finishReason: 'stop',
      },
      {
        method: 'turn.started',
        turnId: expect.stringMatching(/^provider:/),
        trigger: 'provider',
      },
      {
        method: 'turn.completed',
        turnId: facts[2].turnId,
        trigger: 'provider',
        outputText: 'finished',
        finishReason: 'stop',
      },
    ]);
    // Its reply streams on its own turn, never turn-less or on U1.
    expect(textFor(events, facts[2].turnId)).toBe('finished');
    expect(textFor(events, u1)).toBe('started');
    // A provider turn has no prompt of its own.
    expect(facts[2]).not.toHaveProperty('prompt');
    // Once it closed, the next send is accepted.
    await expect(
      adapter.sendTurn({ threadId, input: 'next' }),
    ).resolves.toMatchObject({ turnId: expect.any(String) });
    await adapter.stopSession(threadId);
  });

  test('a background subagent’s own frames never open a provider turn; its completion does', async () => {
    const lines = loadFixture('background-agent');
    // The capture really carries subagent frames (parent_tool_use_id set).
    expect(
      lines.some(
        (line) => line.msg?.type === 'assistant' && line.msg.parent_tool_use_id,
      ),
    ).toBe(true);
    const { events, sends, adapter, threadId } = await replay(lines);
    const u1 = sends.get('U1')!.turnId!;
    const facts = turnFacts(events);
    expect(
      facts.map((fact) => [fact.method, isProviderId(fact.turnId)]),
    ).toEqual([
      ['turn.started', false],
      ['turn.completed', false],
      ['turn.started', true],
      ['turn.completed', true],
    ]);
    expect(facts[1]).toMatchObject({ turnId: u1, outputText: 'started' });
    expect(facts[3]).toMatchObject({
      trigger: 'provider',
      outputText: 'finished',
    });
    // The provider turn opened only after the agent's task settled.
    const settledAt = events.findIndex(
      (event) =>
        event.method === 'tool.completed' && event.toolName.startsWith('Task'),
    );
    const providerStartAt = events.findIndex(
      (event) => event.method === 'turn.started' && isProviderId(event.turnId),
    );
    expect(settledAt).toBeGreaterThan(-1);
    expect(providerStartAt).toBeGreaterThan(settledAt);
    await adapter.stopSession(threadId);
  });

  test('a send before the task notification runs first; the provider turn follows it', async () => {
    const { events, sends, adapter, threadId } = await replay(
      loadFixture('send-before-task-notification'),
    );
    const u1 = sends.get('U1')!.turnId!;
    const u2 = sends.get('U2')!.turnId!;
    const facts = turnFacts(events);
    expect(facts.map((fact) => [fact.method, fact.turnId])).toEqual([
      ['turn.started', u1],
      ['turn.completed', u1],
      ['turn.started', u2],
      ['turn.completed', u2],
      ['turn.started', expect.stringMatching(/^provider:/)],
      ['turn.completed', facts[4].turnId],
    ]);
    expect(facts[3]).toMatchObject({ outputText: 'second' });
    expect(facts[5]).toMatchObject({
      trigger: 'provider',
      outputText: 'finished',
    });
    await adapter.stopSession(threadId);
  });

  test('D4: a send while the engine runs its own turn is refused, retryably, before any effect', async () => {
    const lines = loadFixture('send-races-provider-turn-start');
    // Replay stops at the provider turn's result: everything after it in the
    // capture answers a push Station has just refused.
    const { events, sends, adapter, threadId } = await replay(lines, {
      stopAfter: (msg) =>
        msg.type === 'result' &&
        (msg.origin as { kind?: unknown } | undefined)?.kind ===
          'task-notification',
    });
    const refusal = sends.get('U2')!.error;
    expect(refusal).toBeInstanceOf(ProviderTurnInProgressError);
    expect((refusal as { code?: string }).code).toBe(
      PROVIDER_TURN_IN_PROGRESS_CODE,
    );
    const facts = turnFacts(events);
    expect(facts.slice(2)).toEqual([
      {
        method: 'turn.started',
        turnId: expect.stringMatching(/^provider:/),
        trigger: 'provider',
      },
      {
        method: 'turn.completed',
        turnId: facts[2].turnId,
        trigger: 'provider',
        outputText: 'finished',
        finishReason: 'stop',
      },
    ]);
    // The refused send never reached the engine or the transcript.
    expect(facts.filter((fact) => fact.method === 'turn.started')).toHaveLength(
      2,
    );
    // The same send is accepted once the provider turn closed.
    await expect(
      adapter.sendTurn({ threadId, input: 'U2 again' }),
    ).resolves.toMatchObject({ turnId: expect.any(String) });
    await adapter.stopSession(threadId);
  });

  test('a send racing the provider turn’s start is queued behind it: the reply stays on the provider turn, the send gets its own', async () => {
    // Station accepted U2 before reading the provider turn's `init`; the
    // engine had already started that turn, so U2 ran after it. The frames
    // before U2's `started` carry no user uuid and must not become U2's, and
    // U2's start is published when the engine starts it (#2324 review H1):
    // the published order is the engine's, which every server fold follows.
    const lines = pushBeforeRunningTurnInit(
      loadFixture('send-races-provider-turn-start'),
      'U2',
    );
    const { events, sends, adapter, threadId } = await replay(lines);
    const u2 = sends.get('U2')!.turnId!;
    expect(sends.get('U2')!.error).toBeUndefined();
    const facts = turnFacts(events);
    const provider = facts.find(
      (fact) => fact.method === 'turn.started' && isProviderId(fact.turnId),
    )!.turnId;
    expect(facts.slice(2)).toEqual([
      { method: 'turn.started', turnId: provider, trigger: 'provider' },
      {
        method: 'turn.completed',
        turnId: provider,
        trigger: 'provider',
        outputText: 'finished',
        finishReason: 'stop',
      },
      { method: 'turn.started', turnId: u2, prompt: 'U2' },
      {
        method: 'turn.completed',
        turnId: u2,
        outputText: 'second',
        finishReason: 'stop',
      },
    ]);
    expect(textFor(events, provider)).toBe('finished');
    expect(textFor(events, u2)).toBe('second');
    await adapter.stopSession(threadId);
  });

  test('a send the engine folds into its own turn ends that turn at the fold; the rest is the send’s', async () => {
    const lines = pushBeforeRunningTurnInit(
      loadFixture('send-folded-into-provider-turn'),
      'U2',
    );
    const { events, sends, adapter, threadId } = await replay(lines);
    const u2 = sends.get('U2')!.turnId!;
    const facts = turnFacts(events);
    const provider = facts.find(
      (fact) => fact.method === 'turn.started' && isProviderId(fact.turnId),
    )!.turnId;
    expect(facts.slice(2)).toEqual([
      { method: 'turn.started', turnId: provider, trigger: 'provider' },
      // Closed where the engine took U2: no result of its own will come.
      {
        method: 'turn.completed',
        turnId: provider,
        trigger: 'provider',
        finishReason: 'other',
      },
      // U2 starts where the engine took it, not where Station queued it.
      { method: 'turn.started', turnId: u2, prompt: 'U2' },
      // The one combined result (U2's uuid + task-notification origin).
      {
        method: 'turn.completed',
        turnId: u2,
        outputText: 'finished',
        finishReason: 'stop',
      },
    ]);
    // The provider turn's tool round stays on the provider turn.
    const verify = events.find(
      (event) =>
        event.method === 'tool.started' &&
        event.toolName === 'Bash' &&
        event.turnId === provider,
    );
    expect(verify).toBeDefined();
    expect(textFor(events, u2)).toBe('finished');
    await adapter.stopSession(threadId);
  });

  test('a steer on the provider turn continues it; its combined result closes the provider turn', async () => {
    const { events, sends, adapter, threadId } = await replay(
      loadFixture('send-folded-into-provider-turn'),
      { pushMode: { U2: 'steer' } },
    );
    const steer = sends.get('U2')!;
    expect(steer.error).toBeUndefined();
    expect(isProviderId(steer.turnId)).toBe(true);
    const facts = turnFacts(events);
    expect(facts.slice(2)).toEqual([
      { method: 'turn.started', turnId: steer.turnId, trigger: 'provider' },
      { method: 'turn.started', turnId: steer.turnId, prompt: 'U2' },
      {
        method: 'turn.completed',
        turnId: steer.turnId,
        trigger: 'provider',
        outputText: 'finished',
        finishReason: 'stop',
      },
    ]);
    await adapter.stopSession(threadId);
  });

  test('Stop during a provider turn aborts it cleanly; the next send runs normally', async () => {
    const { events, sends, adapter, threadId } = await replay(
      loadFixture('interrupt-provider-turn'),
    );
    const v = sends.get('V')!.turnId!;
    const facts = turnFacts(events);
    const provider = facts.find(
      (fact) => fact.method === 'turn.started' && isProviderId(fact.turnId),
    )!.turnId;
    expect(facts.slice(2)).toEqual([
      { method: 'turn.started', turnId: provider, trigger: 'provider' },
      { method: 'turn.aborted', turnId: provider, trigger: 'provider' },
      { method: 'turn.started', turnId: v, prompt: 'V' },
      {
        method: 'turn.completed',
        turnId: v,
        outputText: 'vee',
        finishReason: 'stop',
      },
    ]);
    // The interrupt receipt (an error result) is not a failure.
    expect(events.some((event) => event.method === 'runtime.error')).toBe(
      false,
    );
    await adapter.stopSession(threadId);
  });
});

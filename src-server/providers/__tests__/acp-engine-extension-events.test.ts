import { readFileSync } from 'node:fs';
import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable';
import { describe, expect, test, vi } from 'vitest';
import {
  ENGINE_EXTENSION_BINDINGS,
  ENGINE_EXTENSION_CONSUMERS,
  type EngineExtensionConsumerId,
  KIRO_V3_LIVE_CAPTURE,
} from '../../../src-shared/extension-notification-bindings.js';
import type {
  CanonicalRuntimeEvent,
  ProviderSession,
} from '../adapter-shape.js';
import {
  type AcpMapperContext,
  type AcpMapperState,
  mapAcpExtensionNotification,
  mapAcpSessionUpdate,
} from '../adapters/acp-adapter-events.js';
import {
  ENGINE_CONSUMERS_WITHOUT_SERVER_READER,
  ENGINE_EXTENSION_READERS,
} from '../adapters/acp-engine-extension-events.js';
import { AcpToolUpdateSupervisor } from '../adapters/acp-tool-update-supervisor.js';

const FIXTURES = '../../services/acp/__tests__/fixtures';

type Frame = { method?: string; id?: unknown; params?: any };

function liveFrames(capture: string): Frame[] {
  return readFileSync(
    new URL(`../../../${KIRO_V3_LIVE_CAPTURE}`, import.meta.url),
    'utf8',
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.capture === capture && entry.dir === 'E->C')
    .map((entry) => entry.msg);
}

function goldenFrames(): Array<{ source: string; msg: Frame }> {
  return readFileSync(
    new URL(`${FIXTURES}/kiro-extension-golden-frames.jsonl`, import.meta.url),
    'utf8',
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function harness(overrides: Partial<AcpMapperContext> = {}) {
  const events: CanonicalRuntimeEvent[] = [];
  const session: ProviderSession = {
    provider: 'acp',
    threadId: 'thread-1',
    status: 'running',
    model: 'claude-opus-4.6',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  // A Kiro session: its handshake names both subagent wires.
  const state: AcpMapperState = {
    acpSubagentWires: new Set(['roster', 'agent-subtask']),
  };
  const warn = vi.fn();
  const ctx: AcpMapperContext = {
    provider: 'acp',
    session,
    activeTurnId: 'turn-1',
    publish: (event) => events.push(event),
    state,
    logger: { warn },
    toolUpdateSupervisor: new AcpToolUpdateSupervisor(session, (event) =>
      events.push(event),
    ),
    ...overrides,
  };
  /** Feed one engine→client frame the way the adapter routes it. */
  const feed = (msg: Frame) => {
    if (msg.id !== undefined) return;
    if (msg.method === 'session/update')
      mapAcpSessionUpdate(msg.params.update as SessionUpdate, ctx);
    else if (msg.method)
      mapAcpExtensionNotification(msg.method, msg.params, ctx);
  };
  const of = <M extends CanonicalRuntimeEvent['method']>(method: M) =>
    events.filter(
      (event): event is Extract<CanonicalRuntimeEvent, { method: M }> =>
        event.method === method,
    );
  return { ctx, events, session, state, warn, feed, of };
}

describe('engine extension events: the kiro-cli 2.35.0 live capture', () => {
  test('a full v3 turn yields context readings and the turn and session credits', () => {
    const { feed, of } = harness();
    for (const msg of liveFrames('turn-autopilot-off')) feed(msg);

    const usage = of('token-usage.updated');
    expect(usage.filter((event) => event.contextPercent !== undefined)).toEqual(
      [expect.objectContaining({ contextPercent: 0.9, turnId: 'turn-1' })],
    );
    expect(
      usage.flatMap((event) =>
        event.reportedCost ? [event.reportedCost] : [],
      ),
    ).toEqual([
      { amount: 0.06769492504145938, unit: 'credit', scope: 'turn' },
      { amount: 0.06769492504145938, unit: 'credit', scope: 'session' },
    ]);
    // `_kiro/mcp/status` with no servers is a complete, empty list.
    expect(of('engine-mcp.status')).toEqual([
      expect.objectContaining({ servers: [], complete: true }),
    ]);
  });

  // The adapter's turn ledger owns the id (acp-kiro-parity.process.test.ts
  // proves rewind and fork read it); the mapper publishes nothing for it.
  test('the engine user message id frame publishes nothing', () => {
    const { feed, events } = harness();
    const assigned = liveFrames('turn-autopilot-off').filter(
      (msg) =>
        msg.params?.update?._meta?.kiro?.kind === 'user_message_id_assigned',
    );
    expect(assigned.length).toBeGreaterThan(0);
    for (const msg of assigned) feed(msg);
    expect(events).toEqual([]);
  });

  test('host-chrome kinds publish nothing and pending_interaction is never a second approval', () => {
    const { feed, events } = harness();
    const chrome = liveFrames('turn-autopilot-off').filter((msg) => {
      const kind = msg.params?.update?._meta?.kiro?.kind;
      return [
        'focus_update',
        'turn_start',
        'turn_end',
        'pending_interaction',
        'interaction_resolved',
      ].includes(kind);
    });
    expect(chrome.length).toBeGreaterThanOrEqual(5);
    for (const msg of chrome) feed(msg);
    expect(events).toEqual([]);
  });
});

describe('engine extension events: reported cost', () => {
  const completion = (usage: number) =>
    ({
      sessionUpdate: 'session_info_update',
      _meta: {
        kiro: {
          kind: 'turn_completion',
          turnId: 'engine-turn-1',
          promptTurnSummaries: [
            { unit: 'credit', unitPlural: 'credits', usage },
            { unit: 'token', usage: 4096 },
          ],
        },
      },
    }) as unknown as SessionUpdate;

  test('a duplicate turn_completion does not publish (or count) the turn twice', () => {
    const { ctx, of } = harness();
    mapAcpSessionUpdate(completion(0.25), ctx);
    mapAcpSessionUpdate(completion(0.25), ctx);
    expect(of('token-usage.updated').map((e) => e.reportedCost)).toEqual([
      { amount: 0.25, unit: 'credit', scope: 'turn' },
    ]);
  });

  test('a changed figure for the same engine turn replaces it (assign, not add)', () => {
    const { ctx, of } = harness();
    mapAcpSessionUpdate(completion(0.25), ctx);
    mapAcpSessionUpdate(completion(0.4), ctx);
    expect(
      of('token-usage.updated').map((e) => e.reportedCost?.amount),
    ).toEqual([0.25, 0.4]);
  });

  test("a subagent's turn_completion is not this turn's cost", () => {
    const { ctx, events } = harness();
    const update = completion(0.3) as any;
    update._meta.kiro.agentSubtaskId = 'sub-1';
    mapAcpSessionUpdate(update, ctx);
    expect(events).toEqual([]);
  });

  test('core usage_update.cost is carried in its own unit, scope session', () => {
    const { ctx, of } = harness();
    mapAcpSessionUpdate(
      {
        sessionUpdate: 'usage_update',
        used: 1000,
        size: 200000,
        cost: { amount: 1.5, currency: 'EUR' },
      } as SessionUpdate,
      ctx,
    );
    expect(of('token-usage.updated')).toEqual([
      expect.objectContaining({
        contextTokens: 1000,
        contextWindowTokens: 200000,
        reportedCost: { amount: 1.5, unit: 'EUR', scope: 'session' },
      }),
    ]);
    expect(of('token-usage.updated')[0]).not.toHaveProperty('reportedCostUsd');
  });

  test('a usage_update cost without a usable context pair still reports the cost', () => {
    const { ctx, of } = harness();
    mapAcpSessionUpdate(
      {
        sessionUpdate: 'usage_update',
        used: -1,
        size: 0,
        cost: { amount: 2, currency: 'USD' },
      } as SessionUpdate,
      ctx,
    );
    expect(of('token-usage.updated')).toEqual([
      expect.objectContaining({
        reportedCost: { amount: 2, unit: 'USD', scope: 'session' },
      }),
    ]);
    expect(of('token-usage.updated')[0]).not.toHaveProperty('contextTokens');
  });

  test.each([
    [{ amount: -1, currency: 'USD' }],
    [{ amount: Number.NaN, currency: 'USD' }],
    [{ amount: 1, currency: '' }],
    [{ amount: 1, currency: 'not a unit!' }],
    ['1 USD'],
  ])('an unusable cost %j is dropped', (cost) => {
    const { ctx, events } = harness();
    mapAcpSessionUpdate(
      { sessionUpdate: 'usage_update', used: -1, size: 0, cost } as any,
      ctx,
    );
    expect(events).toEqual([]);
  });
});

describe('engine extension events: kirocrew golden frames', () => {
  const frames = goldenFrames();
  const pick = (predicate: (msg: Frame) => boolean) =>
    frames.filter(({ msg }) => predicate(msg)).map(({ msg }) => msg);

  test('v2 model_fallback: the hop is turn-scope, the promotion moves the session model', () => {
    const { feed, of, session } = harness();
    const [hop, promotion] = pick(
      (msg) => msg.method === '_kiro.dev/session/update',
    );
    feed(hop!);
    expect(session.model).toBe('claude-opus-4.6');
    feed(promotion!);
    expect(of('model.rerouted')).toEqual([
      expect.objectContaining({
        fromModel: 'claude-opus-4.6',
        toModel: 'claude-sonnet-4.6',
        trigger: 'refusal',
        scope: 'turn',
      }),
      expect.objectContaining({ scope: 'session', trigger: 'refusal' }),
    ]);
    expect(session.model).toBe('claude-sonnet-4.6');
  });

  test('v3 model_fallback with scope session updates the current model', () => {
    const { feed, of, session } = harness();
    const [kas] = pick(
      (msg) =>
        msg.params?.update?._meta?.kiro?.kind === 'model_fallback' &&
        !msg.params.update._meta.kiro.agentSubtaskId,
    );
    feed(kas!);
    expect(of('model.rerouted')).toEqual([
      expect.objectContaining({
        fromModel: 'claude-opus-4.6',
        toModel: 'claude-sonnet-4.6',
        scope: 'session',
      }),
    ]);
    expect(session.model).toBe('claude-sonnet-4.6');
  });

  test("a subagent's model fallback is reported against the child and never moves the session model", () => {
    const { feed, of, session } = harness();
    const [sub] = pick(
      (msg) => msg.params?.update?._meta?.kiro?.agentSubtaskId === 'sub-1',
    );
    feed(sub!);
    expect(of('model.rerouted')).toEqual([
      expect.objectContaining({
        childWorkId: 'sub-1',
        toModel: 'claude-sonnet-4.6',
      }),
    ]);
    expect(session.model).toBe('claude-opus-4.6');
  });

  test('a fallback naming a model outside the id grammar is dropped', () => {
    const { ctx, events, session } = harness();
    mapAcpSessionUpdate(
      {
        sessionUpdate: 'session_info_update',
        _meta: {
          kiro: {
            kind: 'model_fallback',
            from: 'claude-opus-4.6',
            to: 'x <script>',
            trigger: 'refusal',
            scope: 'session',
          },
        },
      } as any,
      ctx,
    );
    expect(events).toEqual([]);
    expect(session.model).toBe('claude-opus-4.6');
  });

  test('v2 metadata carries the context reading', () => {
    const { feed, of } = harness();
    for (const msg of pick((msg) => msg.method === '_kiro.dev/metadata'))
      feed(msg);
    expect(
      of('token-usage.updated').map((event) => event.contextPercent),
    ).toEqual([12.5, 21.99090003967285]);
  });

  test('v2 server_initialized and server_init_failure are per-server, incomplete reports', () => {
    const { feed, of } = harness();
    for (const msg of pick((msg) =>
      /^_kiro\.dev\/mcp\/server_/.test(msg.method ?? ''),
    ))
      feed(msg);
    expect(
      of('engine-mcp.status').map(({ servers, complete }) => ({
        servers,
        complete,
      })),
    ).toEqual([
      {
        servers: [
          { name: 'core-server', state: 'ready', scope: 'engine-config' },
        ],
        complete: false,
      },
      {
        servers: [
          {
            name: 'cron-server',
            state: 'failed',
            error: 'spawn failed',
            scope: 'engine-config',
          },
        ],
        complete: false,
      },
    ]);
  });

  test('v3 mcp/status: needs-auth, the passive sign-in link, tool count and provenance', () => {
    const { feed, of } = harness();
    for (const msg of pick((msg) => msg.method === '_kiro/mcp/status'))
      feed(msg);
    expect(of('engine-mcp.status')).toEqual([
      expect.objectContaining({
        complete: true,
        servers: [
          {
            name: 'remote',
            state: 'needs-auth',
            error: 'Unauthorized',
            authUrl: 'https://example.invalid/oauth/authorize?state=dead',
            scope: 'engine-config',
          },
          { name: 'local', state: 'ready', toolCount: 1, scope: 'session' },
          { name: 'starting-one', state: 'starting', scope: 'engine-config' },
        ],
      }),
    ]);
  });

  test('v3 agent-subtask tool calls publish the child running, then settled, and stay ordinary tool calls', () => {
    const { feed, of, state } = harness();
    for (const msg of pick(
      (msg) => msg.params?.update?._meta?.kiro?.kind === 'agent-subtask',
    ))
      feed(msg);
    expect(of('child-work.updated').map((event) => event.delta)).toEqual([
      {
        kind: 'snapshot',
        producer: 'engine-subagent',
        reporterThreadId: 'thread-1',
        running: [
          expect.objectContaining({
            childId: 'sa-1',
            status: 'running',
            title: 'Sub-agent: researcher',
            kindLabel: 'researcher',
            workKind: 'agent',
            parent: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              toolCallId: 'tc1',
            },
          }),
        ],
      },
      expect.objectContaining({
        kind: 'settle',
        childId: 'sa-1',
        status: 'completed',
      }),
      {
        kind: 'snapshot',
        producer: 'engine-subagent',
        reporterThreadId: 'thread-1',
        running: [],
      },
    ]);
    expect(state.acpSubagents?.size).toBe(0);
    // The subagent's tool call is still an ordinary tool call.
    expect(of('tool.completed')).toEqual([
      expect.objectContaining({ itemId: 'tc1' }),
    ]);
  });

  test('a v2 subagent roster settles its terminal entries and lists the running ones', () => {
    const { feed, of } = harness();
    const [roster] = pick(
      (msg) => msg.method === '_kiro.dev/subagent/list_update',
    );
    feed(roster!);
    expect(of('child-work.updated').map((event) => event.delta)).toEqual([
      expect.objectContaining({
        kind: 'settle',
        childId: 'sub-2',
        status: 'failed',
        identity: expect.objectContaining({
          title: 'write tests',
          kindLabel: 'tester',
        }),
      }),
      {
        kind: 'snapshot',
        producer: 'engine-subagent',
        reporterThreadId: 'thread-1',
        running: [
          expect.objectContaining({
            childId: 'sub-1',
            title: 'review the diff',
            kindLabel: 'reviewer',
          }),
        ],
      },
    ]);
    // The opaque envelope is still published beside it (host chrome).
    expect(of('extension.notification')).toHaveLength(1);
  });

  test('a session whose handshake names no subagent wire maps none of the Kiro subagent frames', () => {
    const { feed, of, state } = harness();
    state.acpSubagentWires = new Set();
    for (const msg of pick(
      (msg) =>
        msg.method === '_kiro.dev/subagent/list_update' ||
        msg.params?.update?._meta?.kiro?.kind === 'agent-subtask',
    ))
      feed(msg);
    expect(of('child-work.updated')).toEqual([]);
    // Each wire is gated on its own: the roster alone does not admit the
    // agent-service tool calls.
    state.acpSubagentWires = new Set(['roster']);
    for (const msg of pick(
      (msg) => msg.params?.update?._meta?.kiro?.kind === 'agent-subtask',
    ))
      feed(msg);
    expect(of('child-work.updated')).toEqual([]);
  });

  test('a repeated roster settles a finished child once', () => {
    const { feed, of } = harness();
    const [roster] = pick(
      (msg) => msg.method === '_kiro.dev/subagent/list_update',
    );
    feed(roster!);
    feed(structuredClone(roster!));
    expect(
      of('child-work.updated').filter((event) => event.delta.kind === 'settle'),
    ).toHaveLength(1);
  });

  test('a roster past the child-work bound publishes no running set, and says so', () => {
    const { feed, of, warn } = harness();
    // CHILD_WORK_ITEMS_MAX_PER_REPORTER is 64: 64 running children are one
    // snapshot, 65 are none.
    const roster = (count: number) => ({
      method: '_kiro.dev/subagent/list_update',
      params: {
        subagents: Array.from({ length: count }, (_, index) => ({
          sessionId: `sub-${index}`,
          status: { type: 'working' },
        })),
      },
    });
    feed(roster(64));
    expect(of('child-work.updated')).toEqual([
      expect.objectContaining({
        delta: expect.objectContaining({
          kind: 'snapshot',
          running: expect.arrayContaining([
            expect.objectContaining({ childId: 'sub-63' }),
          ]),
        }),
      }),
    ]);
    feed(roster(65));
    expect(of('child-work.updated')).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      'ACP subagent roster exceeds the child-work bound; its running set is not published',
      { running: 65, max: 64 },
    );
  });

  test('a subagent frame with no usable id, or an unknown status word, maps fail-closed', () => {
    const { feed, of } = harness();
    feed({
      method: '_kiro.dev/subagent/list_update',
      params: {
        subagents: [
          { sessionId: '', status: { type: 'working' } },
          { sessionId: 'x'.repeat(257), status: { type: 'working' } },
          { sessionId: 'odd', status: { type: 'vanished' } },
          { sessionId: 'no-status' },
        ],
      },
    });
    expect(of('child-work.updated').map((event) => event.delta)).toEqual([
      expect.objectContaining({
        kind: 'settle',
        childId: 'odd',
        status: 'unresolved',
      }),
      expect.objectContaining({ kind: 'snapshot', running: [] }),
    ]);
  });

  test('an update the engine marks as replayed is dropped whole', () => {
    const { feed, events } = harness();
    const [replayed] = pick(
      (msg) => msg.params?.update?._meta?.kiro?.replay === true,
    );
    feed(replayed!);
    expect(events).toEqual([]);
    // The same frame without the marker is a live tool call.
    const live = structuredClone(replayed!);
    delete live.params.update._meta.kiro.replay;
    feed(live);
    expect(events.map((event) => event.method)).toEqual(['tool.started']);
  });
});

describe('engine extension events: unbound tuples', () => {
  test('an unbound session_info_update kind is logged once per process', () => {
    const first = harness();
    const second = harness();
    const update = {
      sessionUpdate: 'session_info_update',
      _meta: { kiro: { kind: 'lane4_test_unbound_kind' } },
    } as unknown as SessionUpdate;
    mapAcpSessionUpdate(update, first.ctx);
    mapAcpSessionUpdate(update, first.ctx);
    mapAcpSessionUpdate(update, second.ctx);
    expect(first.warn).toHaveBeenCalledTimes(1);
    expect(first.warn).toHaveBeenCalledWith(
      expect.stringContaining('Unbound session_info_update kind'),
      expect.objectContaining({
        namespace: 'session_info_update._meta.kiro',
        type: 'lane4_test_unbound_kind',
      }),
    );
    expect(second.warn).not.toHaveBeenCalled();
    expect(first.events).toEqual([]);
  });

  test('an unbound extension notification is logged once and still published opaquely', () => {
    const { ctx, warn, of } = harness();
    mapAcpExtensionNotification('_lane4.test/unbound', { a: 1 }, ctx);
    mapAcpExtensionNotification('_lane4.test/unbound', { a: 2 }, ctx);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(of('extension.notification')).toHaveLength(2);
  });
});

describe('engine extension events: table coverage', () => {
  test('every row of an implemented consumer has a reader, or is client-owned', () => {
    const missing = ENGINE_EXTENSION_BINDINGS.filter((row) => {
      if (row.wire.kind === 'request') return false;
      if (row.wire.kind === 'tool-call-meta-kind') return false;
      const consumer = row.consumer as EngineExtensionConsumerId;
      if (
        !Object.hasOwn(ENGINE_EXTENSION_CONSUMERS, consumer) ||
        !ENGINE_EXTENSION_CONSUMERS[consumer].implemented
      )
        return false;
      if (ENGINE_CONSUMERS_WITHOUT_SERVER_READER.has(row.consumer))
        return false;
      if (row.consumer === 'session.message-id') return false;
      return !Object.hasOwn(ENGINE_EXTENSION_READERS, row.id);
    }).map(({ id }) => id);
    expect(missing).toEqual([]);
  });

  test('every reader names a row of the table', () => {
    const ids = new Set(ENGINE_EXTENSION_BINDINGS.map(({ id }) => id));
    expect(
      Object.keys(ENGINE_EXTENSION_READERS).filter((id) => !ids.has(id)),
    ).toEqual([]);
  });
});

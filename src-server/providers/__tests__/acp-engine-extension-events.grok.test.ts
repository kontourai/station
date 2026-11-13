import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import {
  ENGINE_EXTENSION_BINDINGS,
  extensionNotificationBinding,
  GROK_LIVE_CAPTURE,
} from '../../../src-shared/extension-notification-bindings.js';
import {
  matchesAcpHandshakeIdentity,
  projectAcpDeclaredHandshake,
  resolveAcpEngineVariant,
} from '../../services/acp/acp-handshake-facts.js';
import type { InitializeResult } from '../../services/acp/acp-process.js';
import type {
  CanonicalRuntimeEvent,
  ProviderSession,
} from '../adapter-shape.js';
import {
  type AcpMapperContext,
  type AcpMapperState,
  mapAcpExtensionNotification,
} from '../adapters/acp-adapter-events.js';
import { ACP_CHILD_WORK_REPORTERS } from '../adapters/acp-child-work.js';
import { AcpToolUpdateSupervisor } from '../adapters/acp-tool-update-supervisor.js';

type Frame = { method?: string; id?: unknown; params?: any; result?: any };

function capture(name: string, dir: 'E->C' | 'C->E' = 'E->C'): Frame[] {
  return readFileSync(
    new URL(`../../../${GROK_LIVE_CAPTURE}`, import.meta.url),
    'utf8',
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.capture === name && entry.dir === dir)
    .map((entry) => entry.msg as Frame);
}

function harness(state: AcpMapperState = {}) {
  const events: CanonicalRuntimeEvent[] = [];
  const session: ProviderSession = {
    provider: 'acp',
    threadId: 'thread-grok',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const engineTurns = { started: vi.fn(), ended: vi.fn() };
  const ctx: AcpMapperContext = {
    provider: 'acp',
    session,
    activeTurnId: 'turn-1',
    publish: (event) => events.push(event),
    state,
    logger: { warn: vi.fn() },
    engineTurns,
    toolUpdateSupervisor: new AcpToolUpdateSupervisor(session, (event) =>
      events.push(event),
    ),
  };
  const notify = (method: string, params: Record<string, unknown>) =>
    mapAcpExtensionNotification(method, params, ctx);
  const of = <M extends CanonicalRuntimeEvent['method']>(method: M) =>
    events.filter(
      (event): event is Extract<CanonicalRuntimeEvent, { method: M }> =>
        event.method === method,
    );
  return { events, notify, of, engineTurns, state };
}

describe('Grok handshake identity', () => {
  const init = capture('handshake').find((msg) => msg.id === 1 && msg.result)
    ?.result as InitializeResult;

  test('the live initialize answer resolves to grok-build by its own flag', () => {
    expect(init).toBeDefined();
    expect(init.agentInfo).toBeUndefined();
    expect(resolveAcpEngineVariant(init)).toBe('grok-build');
    expect(projectAcpDeclaredHandshake(init).engineVariant).toBe('grok-build');
  });

  test('only a literal true flag identifies it', () => {
    expect(
      matchesAcpHandshakeIdentity({ _meta: { grokShell: 'true' } } as never, {
        initializeMetaFlag: 'grokShell',
      }),
    ).toBe(false);
    expect(resolveAcpEngineVariant({ _meta: {} } as never)).toBeUndefined();
  });

  test('every notification the live engine sent is bound, so none is logged as unknown', () => {
    const methods = new Set(
      [
        'handshake',
        'background-bash-interject',
        'background-subagent',
        'mcp-passed-server-fails',
        'ask-user-question-answered',
        'monitor-wake-turns',
      ].flatMap((name) =>
        capture(name).flatMap((msg) =>
          msg.method && msg.id === undefined && msg.method !== 'session/update'
            ? [msg.method]
            : [],
        ),
      ),
    );
    const unbound = [...methods].filter((method) => {
      const slash = method.indexOf('/');
      return !extensionNotificationBinding(
        method.slice(0, slash),
        method.slice(slash + 1),
      );
    });
    expect(unbound).toEqual([]);
  });

  test('the child-work reporter list names only live, non-pending child-work rows', () => {
    for (const ids of Object.values(ACP_CHILD_WORK_REPORTERS))
      for (const id of ids ?? []) {
        const row = ENGINE_EXTENSION_BINDINGS.find((entry) => entry.id === id);
        expect(row, id).toBeDefined();
        expect(row?.consumer).toBe('child-work');
        expect(row?.pending).toBeUndefined();
      }
    // And every Grok child-work row is listed: none is bound but unclaimed.
    expect(
      ENGINE_EXTENSION_BINDINGS.filter(
        (row) => row.id.startsWith('grok.') && row.consumer === 'child-work',
      )
        .map(({ id }) => id)
        .sort(),
    ).toEqual([...(ACP_CHILD_WORK_REPORTERS['grok-build'] ?? [])].sort());
  });
});

describe('Grok MCP server status', () => {
  const statuses = capture('mcp-passed-server-fails').filter(
    (msg) => msg.method === '_x.ai/mcp/server_status',
  );

  test('a server Station passed is session scope; a failed handshake is failed with its detail', () => {
    const { notify, of } = harness({ mcpServers: [{ name: 'probe-broken' }] });
    for (const msg of statuses) notify(msg.method!, msg.params);
    const servers = of('engine-mcp.status').flatMap((event) => event.servers);
    expect(servers[0]).toMatchObject({
      name: 'probe-broken',
      state: 'failed',
      scope: 'session',
    });
    expect(servers[0]?.error).toMatch(/handshake failed/);
    expect(servers).toContainEqual({
      name: 'example-docs',
      state: 'ready',
      scope: 'engine-config',
    });
    // Each report updates the servers it names; it is never the whole list.
    expect(
      of('engine-mcp.status').every((event) => event.complete === false),
    ).toBe(true);
  });

  test('a state Grok was not observed sending reports nothing', () => {
    const { notify, events } = harness();
    notify('_x.ai/mcp/server_status', {
      name: 'docs',
      status: 'needs_auth',
      source: 'local',
    });
    notify('_x.ai/mcp/server_status', { status: 'ready' });
    expect(
      events.filter((event) => event.method === 'engine-mcp.status'),
    ).toEqual([]);
  });
});

describe('Grok turn cost', () => {
  const turnCompleted = (usage: unknown, promptId = 'p-1') => ({
    sessionId: 's',
    update: {
      sessionUpdate: 'turn_completed',
      prompt_id: promptId,
      stop_reason: 'end_turn',
      usage,
    },
  });

  test('costUsdTicks is 10^10 ticks to the dollar, per turn', () => {
    const { notify, of, engineTurns } = harness();
    notify(
      '_x.ai/session_notification',
      turnCompleted({ costUsdTicks: 91_782_320 }),
    );
    expect(of('token-usage.updated')).toEqual([
      expect.objectContaining({
        turnId: 'turn-1',
        reportedCost: { amount: 0.009178232, unit: 'USD', scope: 'turn' },
      }),
    ]);
    expect(engineTurns.ended).toHaveBeenCalledWith(
      'p-1',
      'end_turn',
      undefined,
    );
  });

  test('zero ticks is an unknown price, not a free turn; the turn still ends', () => {
    const { notify, of, engineTurns } = harness();
    notify(
      '_x.ai/session_notification',
      turnCompleted({ costUsdTicks: 0 }, 'p-zero'),
    );
    notify(
      '_x.ai/session_notification',
      turnCompleted({ costUsdTicks: -5 }, 'p-negative'),
    );
    notify('_x.ai/session_notification', turnCompleted('nope', 'p-shapeless'));
    expect(of('token-usage.updated')).toEqual([]);
    expect(engineTurns.ended).toHaveBeenCalledTimes(3);
  });

  test('tokens: the prompt is what is left of the input after the cache', () => {
    const { notify, of } = harness();
    notify(
      '_x.ai/session_notification',
      turnCompleted({
        inputTokens: 87463,
        outputTokens: 309,
        totalTokens: 87772,
        cachedReadTokens: 65536,
        cacheCreationTokens: 0,
        reasoningTokens: 127,
        costUsdTicks: 222253920,
      }),
    );
    expect(of('token-usage.updated')).toEqual([
      expect.objectContaining({
        promptTokens: 21927,
        completionTokens: 309,
        totalTokens: 87772,
        cacheReadTokens: 65536,
        cacheWriteTokens: 0,
        reasoningTokens: 127,
        reportedCost: { amount: 0.022225392, unit: 'USD', scope: 'turn' },
      }),
    ]);
  });

  test('a repeated turn figure is not counted twice', () => {
    const { notify, of } = harness();
    const frame = turnCompleted({ costUsdTicks: 10_000_000_000 });
    notify('_x.ai/session_notification', frame);
    notify('_x.ai/session_notification', frame);
    expect(of('token-usage.updated')).toHaveLength(1);
  });
});

describe('Grok background task verdicts', () => {
  const completed = (snapshot: Record<string, unknown>) => ({
    sessionId: 's',
    update: {
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 't-1', command: 'make', ...snapshot },
    },
  });
  const settled = (snapshot: Record<string, unknown>) => {
    const { notify, of } = harness();
    notify('_x.ai/task_backgrounded', {
      sessionId: 's',
      update: { task_id: 't-1', command: 'make', tool_call_id: 'call-1' },
    });
    notify('_x.ai/task_completed', completed(snapshot));
    return of('child-work.updated')
      .map((event) => event.delta)
      .find((delta) => delta.kind === 'settle');
  };

  test('exit 0 completes, a nonzero exit or a signal fails, a kill cancels, nothing else is guessed', () => {
    expect(settled({ exit_code: 0 })).toMatchObject({ status: 'completed' });
    expect(settled({ exit_code: 2 })).toMatchObject({ status: 'failed' });
    expect(settled({ exit_code: null, signal: 'SIGKILL' })).toMatchObject({
      status: 'failed',
    });
    expect(settled({ exit_code: null, explicitly_killed: true })).toMatchObject(
      { status: 'cancelled' },
    );
    expect(settled({ exit_code: null })).toMatchObject({
      status: 'unresolved',
    });
  });

  test('output is redacted and bounded before it becomes a result', () => {
    const delta = settled({
      exit_code: 0,
      output: `token=sk-ant-api03-${'a'.repeat(40)}\n${'x'.repeat(5000)}`,
    });
    const summary =
      delta?.kind === 'settle' ? (delta.result?.summary ?? '') : '';
    expect(summary).not.toContain('sk-ant-api03-');
    expect(summary.length).toBeLessThanOrEqual(4000);
    expect(delta).toMatchObject({ result: { summaryTruncated: true } });
  });

  test('a task with no id is ignored, and a repeated start is not a second child', () => {
    const { notify, of } = harness();
    notify('_x.ai/task_backgrounded', { update: { command: 'x' } });
    const start = { sessionId: 's', update: { task_id: 't-1', command: 'x' } };
    notify('_x.ai/task_backgrounded', start);
    notify('_x.ai/task_backgrounded', start);
    expect(
      of('child-work.updated').filter(
        (event) => event.delta.kind === 'snapshot',
      ),
    ).toHaveLength(1);
  });

  test('a subagent status Grok was not observed sending settles unresolved', () => {
    const { notify, of } = harness();
    notify('_x.ai/session_notification', {
      sessionId: 's',
      update: {
        sessionUpdate: 'subagent_finished',
        subagent_id: 'a-1',
        status: 'paused',
      },
    });
    expect(of('child-work.updated').map((event) => event.delta)).toEqual([
      expect.objectContaining({ kind: 'settle', status: 'unresolved' }),
    ]);
  });
});

describe('Grok engine turns', () => {
  test('the running prompt goes to the adapter; a queue with nothing running says nothing', () => {
    const { notify, engineTurns } = harness();
    for (const msg of capture('monitor-wake-turns').filter(
      (frame) => frame.method === '_x.ai/queue/changed',
    ))
      notify(msg.method!, msg.params);
    const started = engineTurns.started.mock.calls.map(([id]) => id);
    expect(started.length).toBeGreaterThan(0);
    expect(new Set(started).size).toBe(4);
    expect(started.some((id) => id.startsWith('notifications-'))).toBe(true);
    expect(started.some((id) => id.startsWith('task-completed-'))).toBe(true);
  });
});

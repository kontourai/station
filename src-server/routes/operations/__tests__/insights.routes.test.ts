import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { K, OP, SPAN } from '../../../../src-shared/monitoring-keys.js';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { MonitoringEmitter } from '../../../monitoring/emitter.js';
import { RuntimeEventLog } from '../../../runtime/conversation/runtime-event-log.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  insightOps: { add: vi.fn() },
}));
// archive#3130: the route now resolves the caller the same way
// /monitoring/events does, alias fallback included. Pinning the alias to the
// fixtures' user means these tests exercise the DEFAULT (no ?userId=) call —
// the only one `fetchInsights` actually makes, and the one that was unscoped.
vi.mock('../../system/auth.js', () => ({
  getCachedUser: () => ({ alias: 'user-1' }),
}));

const { createInsightsRoutes } = await import('../insights.js');

describe('Insights Routes', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'insights-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('GET / returns empty data when no monitoring dir', async () => {
    const app = createInsightsRoutes(join(dir, 'nope'));
    const body = await json(await app.request('/'));
    expect(body.data.totalChats).toBe(0);
    expect(body.data.hourlyActivity).toHaveLength(24);
  });

  test('GET / derives metrics from MonitoringEmitter events persisted by RuntimeEventLog', async () => {
    const eventLog = new RuntimeEventLog(dir, {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });
    const emitter = new MonitoringEmitter(new EventEmitter(), (event) =>
      eventLog.persist(event),
    );
    emitter.emitAgentStart({
      slug: 'default',
      conversationId: 'conversation-1',
      userId: 'user-1',
      traceId: 'trace-1',
      input: 'hello',
      model: 'claude-3',
    });
    emitter.emitToolCall({
      slug: 'default',
      conversationId: 'conversation-1',
      userId: 'user-1',
      traceId: 'trace-1',
      toolName: 'read_file',
      toolCallId: 'tool-1',
    });
    emitter.emitToolResult({
      slug: 'default',
      conversationId: 'conversation-1',
      userId: 'user-1',
      traceId: 'trace-1',
      toolName: 'read_file',
      toolCallId: 'tool-1',
      result: 'permission denied',
      outcome: 'error',
    });
    emitter.emitToolCall({
      slug: 'default',
      conversationId: 'conversation-1',
      userId: 'user-1',
      traceId: 'trace-1',
      toolName: 'write_file',
      toolCallId: 'tool-2',
    });
    emitter.emitToolResult({
      slug: 'default',
      conversationId: 'conversation-1',
      userId: 'user-1',
      traceId: 'trace-1',
      toolName: 'write_file',
      toolCallId: 'tool-2',
      result: 'ok',
      outcome: 'success',
    });
    emitter.emitToolCall({
      slug: 'default',
      conversationId: 'conversation-1',
      userId: 'user-1',
      traceId: 'trace-1',
      toolName: 'legacy_tool',
      toolCallId: 'tool-3',
    });
    emitter.emitToolResult({
      slug: 'default',
      conversationId: 'conversation-1',
      userId: 'user-1',
      traceId: 'trace-1',
      toolName: 'legacy_tool',
      toolCallId: 'tool-3',
      result: { arbitrary: 'output' },
    });
    // station#1558: an explicitly reported non-outcome — the session ended
    // with the call still open. Neither an error nor a silent non-report.
    emitter.emitToolCall({
      slug: 'default',
      conversationId: 'conversation-1',
      userId: 'user-1',
      traceId: 'trace-1',
      toolName: 'open_tool',
      toolCallId: 'tool-4',
    });
    emitter.emitToolResult({
      slug: 'default',
      conversationId: 'conversation-1',
      userId: 'user-1',
      traceId: 'trace-1',
      toolName: 'open_tool',
      toolCallId: 'tool-4',
      result:
        'No result was reported before the session ended; whether the tool ran is unknown.',
      outcome: 'unresolved',
    });
    emitter.emitAgentComplete({
      slug: 'default',
      conversationId: 'conversation-1',
      userId: 'user-1',
      traceId: 'trace-1',
      reason: 'stop',
      model: 'claude-3',
    });
    emitter.emitHealth({
      slug: 'default',
      userId: 'user-1',
      traceId: 'health:default:1',
      healthy: true,
    });
    await emitter.flush();

    const app = createInsightsRoutes(dir);
    const body = await json(await app.request('/?days=1'));
    expect(body.data.totalChats).toBe(1);
    expect(body.data.totalToolCalls).toBe(4);
    expect(body.data.agentUsage.default.chats).toBe(1);
    expect(body.data.modelUsage['claude-3']).toBe(1);
    expect(body.data.totalErrors).toBe(1);
    // outcomeUnknown is new (archive#3075): results whose producer reported
    // no terminal status are counted explicitly instead of disappearing into
    // `calls`, which made the error RATE read better than reality.
    // `legacy_tool` is exactly that case — it has an END span with no
    // outcome — so the number is load-bearing here, not decoration.
    expect(body.data.toolUsage).toEqual({
      read_file: { calls: 1, errors: 1, outcomeUnknown: 0, unresolved: 0 },
      write_file: { calls: 1, errors: 0, outcomeUnknown: 0, unresolved: 0 },
      legacy_tool: { calls: 1, errors: 0, outcomeUnknown: 1, unresolved: 0 },
      // station#1558: counted in neither `errors` nor `outcomeUnknown`.
      open_tool: { calls: 1, errors: 0, outcomeUnknown: 0, unresolved: 1 },
    });
    expect(body.data.totalOutcomeUnknown).toBe(1);
    expect(body.data.totalUnresolved).toBe(1);
    // The error rate must not move because a session ended mid-tool.
    expect(body.data.totalErrors).toBe(1);
    expect(
      body.data.hourlyActivity.reduce(
        (sum: number, value: number) => sum + value,
        0,
      ),
      // 8 before station#1558 added a fourth tool call (its own start and
      // end spans are both activity).
    ).toBe(10);
  });

  test('counts each no-session terminal span while retaining real-trace deduplication', async () => {
    const now = Date.now();
    const event = (traceId: string, spanKind: string, agent = 'default') => ({
      [K.TIMESTAMP_MS]: now,
      [K.USER_ID]: 'user-1',
      [K.OP_NAME]: OP.INVOKE_AGENT,
      [K.SPAN_KIND]: spanKind,
      [K.TRACE_ID]: traceId,
      [K.AGENT_SLUG]: agent,
      [K.MODEL]: 'claude-3',
    });
    writeFileSync(
      join(dir, 'events-test.ndjson'),
      [
        event('no-session', SPAN.END),
        event('no-session', SPAN.START),
        event('no-session', SPAN.END),
        event('trace-1', SPAN.START),
        event('trace-1', SPAN.END),
        event('trace-1', SPAN.END),
        event('trace-2', SPAN.END, 'coder'),
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    );

    const body = await json(
      await createInsightsRoutes(dir).request('/?days=1'),
    );
    expect(body.data.totalChats).toBe(4);
    expect(body.data.agentUsage.default.chats).toBe(3);
    expect(body.data.agentUsage.coder.chats).toBe(1);
  });

  test('an unnamed tool is its own bucket, distinct from a tool named unknown (#3073)', async () => {
    // Two eras in one file: a legacy event that baked the literal 'unknown'
    // in at write time, and a post-fix event that simply omits the name.
    // They must not merge — otherwise a reader cannot tell a real tool
    // called `unknown` from a name nobody reported.
    const now = Date.now();
    const toolEvent = (name?: string) => ({
      [K.TIMESTAMP]: new Date(now).toISOString(),
      [K.TIMESTAMP_MS]: now,
      [K.USER_ID]: 'user-1',
      [K.OP_NAME]: OP.EXECUTE_TOOL,
      [K.SPAN_KIND]: SPAN.START,
      [K.TRACE_ID]: 'trace-tools',
      [K.AGENT_SLUG]: 'default',
      ...(name !== undefined ? { [K.TOOL_NAME]: name } : {}),
    });
    writeFileSync(
      join(dir, 'events-tools.ndjson'),
      [toolEvent('unknown'), toolEvent(), toolEvent('Bash')]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    );

    const body = await json(
      await createInsightsRoutes(dir).request('/?days=1'),
    );
    expect(body.data.toolUsage.unknown.calls).toBe(1);
    expect(body.data.toolUsage['(unnamed)'].calls).toBe(1);
    expect(body.data.toolUsage.Bash.calls).toBe(1);
  });

  test('an unnamed agent is its own bucket too (#3082)', async () => {
    const now = Date.now();
    const agentEvent = (slug?: string) => ({
      [K.TIMESTAMP]: new Date(now).toISOString(),
      [K.TIMESTAMP_MS]: now,
      [K.USER_ID]: 'user-1',
      [K.OP_NAME]: OP.INVOKE_AGENT,
      [K.SPAN_KIND]: SPAN.START,
      [K.TRACE_ID]: `trace-${slug ?? 'none'}`,
      ...(slug !== undefined ? { [K.AGENT_SLUG]: slug } : {}),
    });
    writeFileSync(
      join(dir, 'events-agents.ndjson'),
      [agentEvent('unknown'), agentEvent(), agentEvent('coder')]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    );

    const body = await json(
      await createInsightsRoutes(dir).request('/?days=1'),
    );
    expect(body.data.agentUsage.unknown.chats).toBe(1);
    expect(body.data.agentUsage['(unnamed)'].chats).toBe(1);
    expect(body.data.agentUsage.coder.chats).toBe(1);
  });

  test('skips an event file that disappears after directory listing', async () => {
    writeFileSync(
      join(dir, 'events-good.ndjson'),
      JSON.stringify({
        [K.TIMESTAMP_MS]: Date.now(),
        [K.USER_ID]: 'user-1',
        [K.OP_NAME]: OP.INVOKE_AGENT,
        [K.SPAN_KIND]: SPAN.END,
        [K.TRACE_ID]: 'trace-good',
        [K.AGENT_SLUG]: 'default',
      }),
    );
    symlinkSync(
      join(dir, 'rotated-away.ndjson'),
      join(dir, 'events-missing.ndjson'),
    );

    const response = await createInsightsRoutes(dir).request('/?days=1');
    expect(response.status).toBe(200);
    expect((await json(response)).data.totalChats).toBe(1);
  });
});

describe('Insights slicing and export (#3075, #3076)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'insights-slice-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const now = Date.now();
  const toolEvent = (
    over: Record<string, unknown>,
    kind: string = SPAN.START,
  ) => ({
    [K.TIMESTAMP]: new Date(now).toISOString(),
    [K.TIMESTAMP_MS]: now,
    [K.USER_ID]: 'user-1',
    [K.OP_NAME]: OP.EXECUTE_TOOL,
    [K.SPAN_KIND]: kind,
    [K.TRACE_ID]: 'trace-1',
    [K.AGENT_SLUG]: 'alpha',
    ...over,
  });

  const write = (events: Record<string, unknown>[]) =>
    writeFileSync(
      join(dir, 'events-slice.ndjson'),
      events.map((entry) => JSON.stringify(entry)).join('\n'),
    );

  it('an agent filter of (unnamed) selects the slug-less rows', async () => {
    // The dashboard renders that bucket as a clickable row, and it is the
    // one agent name the codebase expects a human to click — it exists so
    // slug-less rows are reachable at all (archive#3086). Comparing the raw
    // field against it matched nothing, so a row reading "(unnamed): N"
    // filtered to an all-zero rollup.
    write([
      toolEvent({ [K.TOOL_NAME]: 'Bash' }),
      toolEvent({ [K.TOOL_NAME]: 'Read', [K.AGENT_SLUG]: undefined }),
      toolEvent({ [K.TOOL_NAME]: 'Grep', [K.AGENT_SLUG]: undefined }),
    ]);

    const body = await json(
      await createInsightsRoutes(dir).request('/?days=1&agent=(unnamed)'),
    );
    expect(Object.keys(body.data.toolUsage).sort()).toEqual(['Grep', 'Read']);
  });

  it('filters tool usage by agent', async () => {
    // The dimension was on every row already; only the endpoint refused to
    // use it, so "tool usage for THIS agent" meant writing a new consumer.
    write([
      toolEvent({ [K.TOOL_NAME]: 'Bash' }),
      toolEvent({ [K.TOOL_NAME]: 'Read', [K.AGENT_SLUG]: 'beta' }),
    ]);

    const body = await json(
      await createInsightsRoutes(dir).request('/?days=1&agent=alpha'),
    );
    expect(Object.keys(body.data.toolUsage)).toEqual(['Bash']);
    expect(body.data.applied).toMatchObject({ agent: 'alpha' });
  });

  it('filters by engine, which older events cannot satisfy', async () => {
    write([
      toolEvent({ [K.TOOL_NAME]: 'Bash', [K.PROVIDER]: 'codex' }),
      // No provider: written before engine attribution shipped.
      toolEvent({ [K.TOOL_NAME]: 'Read' }),
    ]);

    const body = await json(
      await createInsightsRoutes(dir).request('/?days=1&engine=codex'),
    );
    expect(Object.keys(body.data.toolUsage)).toEqual(['Bash']);
  });

  it('reports results with no producer-reported outcome instead of flattering the error rate', async () => {
    write([
      toolEvent({ [K.TOOL_NAME]: 'Bash' }),
      toolEvent(
        { [K.TOOL_NAME]: 'Bash', [K.TOOL_CALL_OUTCOME]: 'error' },
        SPAN.END,
      ),
      // The emitter omits the outcome when the producer reported none.
      toolEvent({ [K.TOOL_NAME]: 'Bash' }, SPAN.END),
    ]);

    const body = await json(
      await createInsightsRoutes(dir).request('/?days=1'),
    );
    expect(body.data.totalErrors).toBe(1);
    expect(body.data.totalOutcomeUnknown).toBe(1);
    expect(body.data.toolUsage.Bash).toMatchObject({
      errors: 1,
      outcomeUnknown: 1,
    });
  });

  it('applies top-N server side', async () => {
    write([
      toolEvent({ [K.TOOL_NAME]: 'Bash' }),
      toolEvent({ [K.TOOL_NAME]: 'Bash' }),
      toolEvent({ [K.TOOL_NAME]: 'Read' }),
    ]);

    const body = await json(
      await createInsightsRoutes(dir).request('/?days=1&limit=1'),
    );
    expect(Object.keys(body.data.toolUsage)).toEqual(['Bash']);
    expect(body.data.applied).toMatchObject({ limit: 1 });
  });

  test("does not aggregate another user's rows (station#3130)", async () => {
    // /monitoring/events scopes rows two ways; this route read the SAME
    // directory and applied neither, so on a multi-user or hosted install it
    // rolled up everyone's events into one number.
    const eventLog = new RuntimeEventLog(dir, {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });
    const emitter = new MonitoringEmitter(new EventEmitter(), (event) =>
      eventLog.persist(event),
    );
    for (const userId of ['user-1', 'user-2']) {
      emitter.emitToolCall({
        slug: 'default',
        conversationId: `conversation-${userId}`,
        userId,
        traceId: `trace-${userId}`,
        toolName: 'read_file',
        toolCallId: `tool-${userId}`,
        input: {},
      });
      emitter.emitToolResult({
        slug: 'default',
        conversationId: `conversation-${userId}`,
        userId,
        traceId: `trace-${userId}`,
        toolName: 'read_file',
        toolCallId: `tool-${userId}`,
        result: { ok: true },
      });
    }
    await emitter.flush();

    const app = createInsightsRoutes(dir);
    const scoped = await json(await app.request('/?days=1&userId=user-1'));
    expect(scoped.data.totalToolCalls).toBe(1);

    const other = await json(await app.request('/?days=1&userId=user-2'));
    expect(other.data.totalToolCalls).toBe(1);
  });

  test('an unattributed row is not admitted to a scoped read (station#3130)', async () => {
    // "unowned means everyone's" is the wrong default on a hosted install —
    // the issue says so explicitly. A row with no user id must not appear in a
    // caller-scoped rollup.
    const eventLog = new RuntimeEventLog(dir, {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });
    const emitter = new MonitoringEmitter(new EventEmitter(), (event) =>
      eventLog.persist(event),
    );
    emitter.emitToolCall({
      slug: 'default',
      conversationId: 'conversation-1',
      traceId: 'trace-1',
      toolName: 'read_file',
      toolCallId: 'tool-1',
      input: {},
    });
    emitter.emitToolResult({
      slug: 'default',
      conversationId: 'conversation-1',
      traceId: 'trace-1',
      toolName: 'read_file',
      toolCallId: 'tool-1',
      result: { ok: true },
    });
    await emitter.flush();

    const app = createInsightsRoutes(dir);
    const scoped = await json(await app.request('/?days=1&userId=user-1'));
    expect(scoped.data.totalToolCalls).toBe(0);
  });

  test('the DEFAULT call is scoped to the resolved caller, not unscoped (station#3130)', async () => {
    // fetchInsights sends `?days=N` and nothing else, and no client emits
    // x-user-id — so the alias fallback is the ONLY thing scoping the call the
    // product actually makes. Removing it must fail here.
    const eventLog = new RuntimeEventLog(dir, {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });
    const emitter = new MonitoringEmitter(new EventEmitter(), (event) =>
      eventLog.persist(event),
    );
    for (const userId of ['user-1', 'user-2']) {
      emitter.emitToolCall({
        slug: 'default',
        conversationId: `conversation-${userId}`,
        userId,
        traceId: `trace-${userId}`,
        toolName: 'read_file',
        toolCallId: `tool-${userId}`,
        input: {},
      });
      emitter.emitToolResult({
        slug: 'default',
        conversationId: `conversation-${userId}`,
        userId,
        traceId: `trace-${userId}`,
        toolName: 'read_file',
        toolCallId: `tool-${userId}`,
        result: { ok: true },
      });
    }
    await emitter.flush();

    // No ?userId= — the mocked alias resolves the caller to user-1.
    const body = await json(
      await createInsightsRoutes(dir).request('/?days=1'),
    );
    expect(body.data.totalToolCalls).toBe(1);
  });

  test('an authz-composed route applies the shared session predicate (station#3130)', async () => {
    // Nothing previously passed `authz`, so the entire tenant layer — and the
    // absent-authority branch — was uncovered.
    const eventLog = new RuntimeEventLog(dir, {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });
    const emitter = new MonitoringEmitter(new EventEmitter(), (event) =>
      eventLog.persist(event),
    );
    emitter.emitToolCall({
      slug: 'default',
      conversationId: 'conversation-1',
      userId: 'user-1',
      traceId: 'trace-1',
      toolName: 'read_file',
      toolCallId: 'tool-1',
      input: {},
    });
    emitter.emitToolResult({
      slug: 'default',
      conversationId: 'conversation-1',
      userId: 'user-1',
      traceId: 'trace-1',
      toolName: 'read_file',
      toolCallId: 'tool-1',
      result: { ok: true },
    });
    await emitter.flush();

    const denied = createInsightsRoutes(dir, {
      readAuthorityForRequest: () =>
        ({ mode: 'personal', userId: 'user-1' }) as never,
      canReadMonitoringEvent: () => false,
    });
    expect(
      (await json(await denied.request('/?days=1'))).data.totalToolCalls,
    ).toBe(0);

    const allowed = createInsightsRoutes(dir, {
      readAuthorityForRequest: () =>
        ({ mode: 'personal', userId: 'user-1' }) as never,
      canReadMonitoringEvent: () => true,
    });
    expect(
      (await json(await allowed.request('/?days=1'))).data.totalToolCalls,
    ).toBe(1);

    // A composition supplying the predicate but NOT the authority resolver:
    // the shared predicate denies session-bearing rows in that state, so this
    // must too. Short-circuiting `!authority -> true` would admit them and put
    // the two surfaces back into disagreement.
    const noAuthority = createInsightsRoutes(dir, {
      canReadMonitoringEvent: () => true,
    });
    expect(
      (await json(await noAuthority.request('/?days=1'))).data.totalToolCalls,
    ).toBe(0);
  });
});

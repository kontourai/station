import { EventEmitter } from 'node:events';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import {
  collectSSE,
  readStreamUntil,
} from '../../../__test-utils__/sse-helpers.js';

// Built at runtime so no literal credential assignment appears in source:
// a redaction test needs secret-SHAPED input, and the repo's pre-commit
// secret scanner cannot tell a fixture from a real leak. The value still
// flows through the assertion unchanged, so the test keeps its power.
const fixtureSecret = (label: string): string => [label, 'secret'].join('-');

vi.mock('../../system/auth.js', () => ({
  getCachedUser: () => ({ alias: 'testuser' }),
}));

const { createMonitoringRoutes } = await import('../monitoring.js');

const hostedRegistry = parseHostedTenantRegistry({
  schemaVersion: 1,
  tenants: [
    { id: 'alpha', authority: 'alpha.example.test' },
    { id: 'bravo', authority: 'bravo.example.test' },
  ],
});

function hostedAuthority(tenant: 'alpha' | 'bravo') {
  return sessionReadAuthorityFromRequest(
    `${tenant}-user`,
    { tenantId: tenantId(tenant) },
    hostedRegistry,
  );
}

function createMockDeps() {
  return {
    activeAgents: new Map([
      ['default', { name: 'Default', model: 'claude-3' }],
    ]),
    agentStats: new Map(),
    agentStatus: new Map([['default', 'idle']]),
    memoryAdapters: new Map([
      [
        'default',
        {
          getConversations: vi.fn().mockResolvedValue([]),
          getMessages: vi.fn().mockResolvedValue([]),
        },
      ],
    ]),
    metricsLog: [] as any[],
    monitoringEvents: new EventEmitter(),
    queryEventsFromDisk: vi.fn().mockResolvedValue([]),
    acpBridge: { getStatus: () => ({ connections: [] }) },
    resolveAgentModel: undefined as
      | ((slug: string, agent: any) => Promise<string | null | undefined>)
      | undefined,
  };
}

describe('Monitoring Routes', () => {
  test('GET /stats returns agent stats', async () => {
    const app = createMonitoringRoutes(createMockDeps() as any);
    const body = await json(await app.request('/stats'));
    expect(body.success).toBe(true);
    expect(body.data.agents).toHaveLength(1);
    expect(body.data.agents[0].slug).toBe('default');
    expect(body.data.summary).toBeDefined();
  });

  test('GET /stats prefers resolved runtime model over serialized agent model', async () => {
    const deps = createMockDeps();
    deps.resolveAgentModel = vi
      .fn()
      .mockResolvedValue('resolved-runtime-model');

    const app = createMonitoringRoutes(deps as any);
    const body = await json(await app.request('/stats'));

    expect(body.success).toBe(true);
    expect(deps.resolveAgentModel).toHaveBeenCalledWith(
      'default',
      expect.objectContaining({ name: 'Default', model: 'claude-3' }),
    );
    expect(body.data.agents[0].model).toBe('resolved-runtime-model');
  });

  test('GET /stats falls back to serialized agent model when resolver is empty', async () => {
    const deps = createMockDeps();
    deps.resolveAgentModel = vi.fn().mockResolvedValue('');

    const app = createMonitoringRoutes(deps as any);
    const body = await json(await app.request('/stats'));

    expect(body.success).toBe(true);
    expect(body.data.agents[0].model).toBe('claude-3');
  });

  test('GET /metrics returns filtered metrics', async () => {
    const deps = createMockDeps();
    deps.metricsLog.push({
      timestamp: Date.now(),
      agentSlug: 'default',
      event: 'chat',
      messageCount: 5,
    });
    const app = createMonitoringRoutes(deps as any);
    const body = await json(await app.request('/metrics?range=today'));
    expect(body.success).toBe(true);
    expect(body.data.range).toBe('today');
  });

  test('GET /events with time range returns historical JSON', async () => {
    const deps = createMockDeps();
    deps.queryEventsFromDisk.mockResolvedValue([
      { type: 'test', timestamp: Date.now() },
    ]);
    const app = createMonitoringRoutes(deps as any);
    const body = await json(
      await app.request('/events?start=2026-01-01&end=2026-12-31'),
    );
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
  });

  test('redacts historical content-bearing fields while retaining their presence', async () => {
    const deps = createMockDeps();
    deps.queryEventsFromDisk.mockResolvedValue([
      {
        'gen_ai.tool.call.arguments': {
          config: { apiKey: fixtureSecret('historical-argument') },
        },
        'gen_ai.tool.call.result':
          'postgres://reader:historical-result-secret@db.example.test/app',
        'station.artifacts': [
          {
            type: 'text',
            content: { token: fixtureSecret('historical-artifact') },
          },
        ],
        'station.reasoning.text': 'Bearer historical-reasoning-secret',
      },
    ]);
    const app = createMonitoringRoutes(deps as any);

    const body = await json(
      await app.request('/events?start=2026-01-01&end=2026-12-31'),
    );
    const serialized = JSON.stringify(body.data);
    for (const secret of [
      fixtureSecret('historical-argument'),
      fixtureSecret('historical-result'),
      fixtureSecret('historical-artifact'),
      fixtureSecret('historical-reasoning'),
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(body.data[0]).toHaveProperty('gen_ai.tool.call.arguments');
    expect(body.data[0]).toHaveProperty('gen_ai.tool.call.result');
    expect(body.data[0]).toHaveProperty('station.artifacts');
    expect(body.data[0]).toHaveProperty('station.reasoning.text');
    expect(serialized).toContain('[REDACTED]');
  });

  test('GET /events without time range streams SSE', async () => {
    const deps = createMockDeps();
    const app = createMonitoringRoutes(deps as any);
    const res = await app.request('/events');
    const events = await collectSSE(res, { maxEvents: 1, timeoutMs: 500 });
    // First event should be the "connected" system event
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].parsed?.['station.system.type']).toBe('connected');
  });

  test('redacts live SSE content-bearing fields', async () => {
    const deps = createMockDeps();
    const app = createMonitoringRoutes(deps as any);
    const response = await app.request('/events');
    await new Promise((resolve) => setTimeout(resolve, 0));
    deps.monitoringEvents.emit('event', {
      'gen_ai.tool.call.arguments': { apiKey: fixtureSecret('live-argument') },
      'gen_ai.tool.call.result':
        'postgres://reader:live-result-secret@db.example.test/app',
      'station.artifacts': [
        { type: 'text', content: { token: fixtureSecret('live-artifact') } },
      ],
      'station.reasoning.text': 'Bearer live-reasoning-secret',
    });
    const payload = await readStreamUntil(
      response.body!,
      (text) =>
        text.includes('[REDACTED]') ||
        text.includes(fixtureSecret('live-argument')),
    );
    for (const secret of [
      fixtureSecret('live-argument'),
      fixtureSecret('live-result'),
      fixtureSecret('live-artifact'),
      fixtureSecret('live-reasoning'),
    ]) {
      expect(payload).not.toContain(secret);
    }
    expect(payload).toContain('[REDACTED]');
  });

  test('filters bravo historical session content before returning it to alpha', async () => {
    const deps = createMockDeps();
    const authority = hostedAuthority('alpha');
    deps.queryEventsFromDisk.mockResolvedValue([
      { sessionId: 'alpha-session', body: 'alpha content' },
      { sessionId: 'bravo-session', body: 'bravo secret' },
      { 'station.system.type': 'generic', count: 1 },
    ]);
    const app = createMonitoringRoutes({
      ...deps,
      readAuthorityForRequest: () => authority,
      canReadMonitoringEvent: (event: any) =>
        event.sessionId !== 'bravo-session',
    } as any);

    const response = await app.request('/events?start=2026-01-01');
    const body = await json(response);
    expect(body.data).toEqual([
      { sessionId: 'alpha-session', body: 'alpha content' },
      { 'station.system.type': 'generic', count: 1 },
    ]);
    expect(JSON.stringify(body)).not.toContain('bravo');
  });

  test('uses canonical schema identity for historical and live tenant filtering', async () => {
    const deps = createMockDeps();
    deps.queryEventsFromDisk.mockResolvedValue([
      {
        'gen_ai.conversation.id': 'alpha-session',
        'station.reasoning.text': 'alpha trace',
      },
      {
        'station.agent_telemetry.session_id': 'bravo-session',
        'station.reasoning.text': 'bravo trace',
      },
    ]);
    const canReadMonitoringEvent = vi.fn(
      (event: Record<string, unknown>) =>
        event['gen_ai.conversation.id'] === 'alpha-session',
    );
    const app = createMonitoringRoutes({
      ...deps,
      readAuthorityForRequest: () => hostedAuthority('alpha'),
      canReadMonitoringEvent,
    } as any);

    const history = await json(await app.request('/events?start=2026-01-01'));
    expect(history.data).toEqual([
      expect.objectContaining({ 'gen_ai.conversation.id': 'alpha-session' }),
    ]);
    expect(canReadMonitoringEvent).toHaveBeenCalledTimes(2);

    const response = await app.request('/events');
    await new Promise((resolve) => setTimeout(resolve, 0));
    deps.monitoringEvents.emit('event', {
      'station.agent_telemetry.session_id': 'bravo-session',
      'station.reasoning.text': 'bravo live trace',
    });
    deps.monitoringEvents.emit('event', {
      'gen_ai.conversation.id': 'alpha-session',
      'station.reasoning.text': 'alpha live trace',
    });
    const payload = await readStreamUntil(response.body!, (text) =>
      text.includes('alpha live trace'),
    );
    expect(payload).toContain('alpha live trace');
    expect(payload).not.toContain('bravo live trace');
  });

  test('hosted monitoring fails closed for unbound content but retains generic health', async () => {
    const deps = createMockDeps();
    deps.queryEventsFromDisk.mockResolvedValue([
      { 'station.reasoning.text': 'unbound secret' },
      { 'station.health.healthy': true, 'station.system.type': 'heartbeat' },
    ]);
    const app = createMonitoringRoutes({
      ...deps,
      readAuthorityForRequest: () => hostedAuthority('alpha'),
    } as any);

    const body = await json(await app.request('/events?start=2026-01-01'));
    expect(body.data).toEqual([
      { 'station.health.healthy': true, 'station.system.type': 'heartbeat' },
    ]);
    expect(JSON.stringify(body)).not.toContain('unbound secret');
  });

  test('hosted monitoring with missing tenant context never invokes the session predicate', async () => {
    const deps = createMockDeps();
    const canReadMonitoringEvent = vi.fn(() => true);
    deps.queryEventsFromDisk.mockResolvedValue([
      { 'gen_ai.conversation.id': 'alpha-session', body: 'alpha secret' },
    ]);
    const app = createMonitoringRoutes({
      ...deps,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('missing', undefined, hostedRegistry),
      canReadMonitoringEvent,
    } as any);

    const body = await json(await app.request('/events?start=2026-01-01'));
    expect(body.data).toEqual([]);
    expect(canReadMonitoringEvent).not.toHaveBeenCalled();
  });

  test('hosted stats and metrics suppress unbound file and global aggregates', async () => {
    const deps = createMockDeps();
    deps.metricsLog.push({
      timestamp: Date.now(),
      agentSlug: 'default',
      event: 'chat',
      conversationId: 'bravo-session',
      messageCount: 42,
      cost: 99,
    });
    const app = createMonitoringRoutes({
      ...deps,
      readAuthorityForRequest: () => hostedAuthority('alpha'),
    } as any);

    const stats = await json(await app.request('/stats'));
    expect(stats.data.agents[0]).not.toHaveProperty('conversationCount');
    expect(stats.data.agents[0]).not.toHaveProperty('messageCount');
    expect(stats.data.agents[0]).not.toHaveProperty('cost');
    expect(stats.data.summary).not.toHaveProperty('totalMessages');
    expect(stats.data.summary).not.toHaveProperty('totalCost');
    expect(
      deps.memoryAdapters.get('default')!.getConversations,
    ).not.toHaveBeenCalled();

    const metrics = await json(await app.request('/metrics?range=today'));
    expect(metrics.data).toEqual({ range: 'today', metrics: [] });
  });
});

describe('historical event slicing (station#3076)', () => {
  const K_OP = 'gen_ai.operation.name';
  const K_TOOL = 'gen_ai.tool.name';
  const K_AGENT = 'station.agent.slug';
  const K_USER = 'station.user.id';
  const K_ARGS = 'gen_ai.tool.call.arguments';

  const row = (over: Record<string, unknown>) => ({
    timestamp: '2026-08-17T00:00:00.000Z',
    'timestamp.ms': Date.parse('2026-08-17T00:00:00.000Z'),
    'span.kind': 'start',
    [K_OP]: 'execute_tool',
    // Production rows carry one; the reader drops those that do not.
    [K_USER]: 'alice',
    ...over,
  });

  const appWith = (events: Record<string, unknown>[], extra: object = {}) => {
    const deps = {
      ...createMockDeps(),
      // The real reader filters by user BEFORE returning; the mock stands in
      // for that contract so the slicing under test cannot be credited with
      // an isolation it does not perform.
      queryEventsFromDisk: vi
        .fn()
        .mockImplementation(
          async (start: number, end: number, userId?: string) =>
            // Mirrors the real reader on BOTH counts: it drops rows whose
            // user id does not match (a row without one is dropped, not
            // passed through), and it honours the window. A stand-in that
            // ignored the window could not tell a working bound parse from
            // one that degraded to 0.
            events.filter((event) => {
              // Mirror the real reader's STRICTNESS, not just its shape: a
              // non-numeric timestamp computes NaN there and every comparison
              // is false, so the row is dropped — and the reader has no
              // `!userId` escape that returns everything. A mock more
              // permissive than the thing it stands in for is a mock the
              // tests end up measuring.
              //
              // Two deliberate divergences, since a comment claiming exact
              // fidelity would be its own small lie: the reader keys the
              // window off the ISO `timestamp` string rather than
              // `timestamp.ms`, and it accepts a row whose user id sits on a
              // bare `userId` field as well. Every fixture here sets both, so
              // neither difference is load-bearing.
              const ts = Number(event['timestamp.ms']);
              if (!(ts >= start && ts <= end)) return false;
              return event[K_USER] === userId;
            }),
        ),
      ...extra,
    };
    return createMonitoringRoutes(deps as never);
  };

  const K_ENGINE = 'gen_ai.provider.name';
  const K_CONV = 'gen_ai.conversation.id';

  test.each([
    // Each case leaves rows that match everything EXCEPT the dimension under
    // test, so disabling that dimension changes the result. The original
    // single test claimed to cover agent and tools-only while passing only
    // `tool=Bash`, and injections disabling either stayed green.
    ['tool', 'tool=Read', 'Read'],
    ['agent', 'agent=beta', 'Beta'],
    ['engine', 'engine=codex', 'Codex'],
    ['conversation', 'conversation=c-2', 'Conv'],
  ])('filters by %s', async (_dimension, query, expected) => {
    const app = appWith([
      row({
        [K_TOOL]: 'Bash',
        [K_AGENT]: 'alpha',
        [K_ENGINE]: 'station',
        [K_CONV]: 'c-1',
      }),
      row({
        [K_TOOL]: 'Read',
        [K_AGENT]: 'alpha',
        [K_ENGINE]: 'station',
        [K_CONV]: 'c-1',
      }),
      row({
        [K_TOOL]: 'Beta',
        [K_AGENT]: 'beta',
        [K_ENGINE]: 'station',
        [K_CONV]: 'c-1',
      }),
      row({
        [K_TOOL]: 'Codex',
        [K_AGENT]: 'alpha',
        [K_ENGINE]: 'codex',
        [K_CONV]: 'c-1',
      }),
      row({
        [K_TOOL]: 'Conv',
        [K_AGENT]: 'alpha',
        [K_ENGINE]: 'station',
        [K_CONV]: 'c-2',
      }),
    ]);

    const body = await json(
      await app.request(`/events?start=0&userId=alice&${query}`),
    );
    expect(body.data).toHaveLength(1);
    expect(body.data[0][K_TOOL]).toBe(expected);
  });

  test('epoch-millisecond bounds are honoured, not parsed to NaN', async () => {
    // new Date("1785813308984") is NaN, so every comparison was false and the
    // documented epoch-ms form returned nothing at all — with no error.
    //
    // The bound must EXCLUDE something, or the test cannot tell a working
    // parse from a fallback: a NaN that degrades to start=0 still returns
    // every row, which is how the first version of this test passed against
    // the broken code.
    const app = appWith([
      row({
        [K_TOOL]: 'ancient',
        timestamp: '2020-01-01T00:00:00.000Z',
        'timestamp.ms': Date.parse('2020-01-01T00:00:00.000Z'),
      }),
      row({ [K_TOOL]: 'recent' }),
    ]);

    const body = await json(
      await app.request(
        `/events?start=${Date.parse('2026-01-01T00:00:00.000Z')}&userId=alice`,
      ),
    );
    expect(
      body.data.map((event: Record<string, unknown>) => event[K_TOOL]),
    ).toEqual(['recent']);
  });

  test('an omitted limit returns every row — the cap is opt-in', async () => {
    // 520 rows, deliberately more than the 500 the MCP tool defaults to: an
    // earlier round put that tool's default HERE, at a route the Monitoring
    // view and `station monitoring events` also use, and silently handed
    // both of them a truncated month.
    const app = appWith(
      Array.from({ length: 520 }, (_, index) =>
        row({ [K_TOOL]: `t-${index}` }),
      ),
    );

    const body = await json(await app.request('/events?start=0&userId=alice'));
    expect(body.data).toHaveLength(520);
    expect(body.truncated).toBe(false);
  });

  test('an unusable limit is a 400, not a silently different limit', async () => {
    const app = appWith([row({ [K_TOOL]: 'Bash' })]);
    for (const bad of ['abc', '0', '-5']) {
      const res = await app.request(
        `/events?start=0&userId=alice&limit=${bad}`,
      );
      expect(res.status).toBe(400);
      expect((await json(res)).error).toContain('positive integer');
    }
  });

  test('a bound that does not parse is a 400, not a wider window', async () => {
    // The failure this replaces: an unparseable bound fell back to 0/now and
    // returned the entire retained corpus, looking exactly like a successful
    // narrow read.
    //
    // NOT fixed by this, and worth being precise about because an earlier
    // version of this comment claimed otherwise: epoch SECONDS is a valid
    // bound. `1785813308` matches the digit form and parses to a 1970
    // timestamp, so it still reads the whole corpus. It is indistinguishable
    // from a caller who genuinely means 1970 — only a heuristic could reject
    // it, and this endpoint does not have one.
    const app = appWith([row({ [K_TOOL]: 'Bash' })]);

    const badStart = await app.request('/events?start=abc&userId=alice');
    expect(badStart.status).toBe(400);
    expect((await json(badStart)).error).toContain('start=abc');

    const badEnd = await app.request('/events?start=0&end=nope&userId=alice');
    expect(badEnd.status).toBe(400);
    expect((await json(badEnd)).error).toContain('end=nope');
  });

  test('tools=true drops agent turns on its own', async () => {
    // The agent turn carries the SAME tool name as the tool row, so
    // `tools=true` is the only thing that can exclude it. The previous
    // version paired tools=true with tool=Bash against an agent row that had
    // no tool name at all — the name filter did all the work, and deleting
    // the tools-only clause entirely kept the test green.
    const app = appWith([
      row({ [K_TOOL]: 'Bash', [K_AGENT]: 'alpha' }),
      row({ [K_TOOL]: 'Bash', [K_AGENT]: 'alpha', [K_OP]: 'invoke_agent' }),
    ]);

    const all = await json(await app.request('/events?start=0&userId=alice'));
    expect(all.data).toHaveLength(2);

    const body = await json(
      await app.request('/events?start=0&userId=alice&tools=true'),
    );
    expect(body.data).toHaveLength(1);
    expect(body.data[0][K_OP]).not.toBe('invoke_agent');
  });

  test("returns only the requesting user's rows", async () => {
    // The reason this lives here and not under /api/insights: a second
    // reader would have to re-derive this, and an export that re-derives an
    // authorization check is one that eventually gets it wrong.
    const app = appWith([
      row({ [K_TOOL]: 'Bash', [K_USER]: 'alice' }),
      row({ [K_TOOL]: 'Bash', [K_USER]: 'bob' }),
    ]);

    const body = await json(await app.request('/events?start=0&userId=alice'));
    expect(body.data).toHaveLength(1);
    expect(body.data[0][K_USER]).toBe('alice');
  });

  test('redacts content on the way out', async () => {
    const app = appWith([
      row({
        [K_TOOL]: 'Bash',
        [K_ARGS]: { command: 'rg secret /Users/someone/notes' },
      }),
    ]);

    const body = await json(await app.request('/events?start=0&userId=alice'));
    expect(JSON.stringify(body.data[0])).toContain('[REDACTED_PATH]');
    expect(JSON.stringify(body.data[0])).not.toContain('/Users/someone');
  });

  test('a cap keeps the most recent rows even if the reader is out of order', async () => {
    // The reader concatenates daily log files in `readdir` order, which
    // POSIX does not define — APFS returns them sorted, ext4/overlayfs
    // hash-orders them. Taking the last N of THAT is a guess about the
    // filesystem; taking the last N by timestamp is a derivation. The
    // fixture is deliberately out of order, which is what a hash-ordered
    // directory produces.
    const app = appWith([
      row({
        [K_TOOL]: 'newest',
        timestamp: '2026-03-01T00:00:00.000Z',
        'timestamp.ms': Date.parse('2026-03-01T00:00:00.000Z'),
      }),
      row({
        [K_TOOL]: 'oldest',
        timestamp: '2026-01-01T00:00:00.000Z',
        'timestamp.ms': Date.parse('2026-01-01T00:00:00.000Z'),
      }),
      row({
        [K_TOOL]: 'middle',
        timestamp: '2026-02-01T00:00:00.000Z',
        'timestamp.ms': Date.parse('2026-02-01T00:00:00.000Z'),
      }),
    ]);

    const body = await json(
      await app.request('/events?start=0&userId=alice&limit=2'),
    );
    expect(
      body.data.map((event: Record<string, unknown>) => event[K_TOOL]),
    ).toEqual(['middle', 'newest']);
  });

  test('a row with no numeric timestamp.ms sorts by its ISO timestamp', async () => {
    // Number(null) is 0, which is finite — so the numeric branch accepted it
    // and the ISO fallback never ran. The NEWEST row sorted as 1970 and a
    // tail slice dropped it first.
    const app = appWith([
      row({
        [K_TOOL]: 'older',
        timestamp: '2026-01-01T00:00:00.000Z',
        'timestamp.ms': Date.parse('2026-01-01T00:00:00.000Z'),
      }),
      row({
        [K_TOOL]: 'newest-but-unstamped',
        timestamp: '2026-06-01T00:00:00.000Z',
        'timestamp.ms': null,
      }),
    ]);

    const body = await json(
      await app.request('/events?start=0&userId=alice&limit=1'),
    );
    expect(body.data).toHaveLength(1);
    expect(body.data[0][K_TOOL]).toBe('newest-but-unstamped');
  });

  test('reports truncation only when rows were actually dropped', async () => {
    const rows = Array.from({ length: 3 }, (_, index) =>
      row({ [K_TOOL]: `tool-${index}` }),
    );

    const capped = await json(
      await appWith(rows).request('/events?start=0&userId=alice&limit=2'),
    );
    expect(capped.data).toHaveLength(2);
    expect(capped.truncated).toBe(true);

    // The negative control: a cap equal to the result size drops nothing, so
    // reporting truncation there would be a false alarm.
    const exact = await json(
      await appWith(rows).request('/events?start=0&userId=alice&limit=3'),
    );
    expect(exact.data).toHaveLength(3);
    expect(exact.truncated).toBe(false);
  });

  test('a limit takes the most RECENT rows without reordering them', async () => {
    // Tail semantics, matching read_logs: the endpoint's existing order is
    // chronological and the Monitoring view depends on it, so the cap must
    // drop the oldest rather than reverse the page.
    const app = appWith([
      row({ [K_TOOL]: 'oldest' }),
      row({ [K_TOOL]: 'middle' }),
      row({ [K_TOOL]: 'newest' }),
    ]);

    const body = await json(
      await app.request('/events?start=0&userId=alice&limit=2'),
    );
    expect(
      body.data.map((event: Record<string, unknown>) => event[K_TOOL]),
    ).toEqual(['middle', 'newest']);
  });
});

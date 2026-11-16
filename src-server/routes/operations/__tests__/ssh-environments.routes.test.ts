import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import {
  SSH_PROBE_ATTEMPT_MAX_SECONDS,
  SSH_PROBE_MAX_SECONDS,
} from '../../../services/ssh/openssh-reachability.js';
import { SshProbeAdmission } from '../../../services/ssh/ssh-probe-admission.js';
import { createSshEnvironmentRoutes } from '../ssh-environments.js';

/** The bound, current owner on a personal Station: the one admitted caller. */
const OWNER_READS = {
  hosted: false,
  current: () => true,
  owner: () => true,
};

function service() {
  const view = {
    profile: {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Home media',
    },
    state: { phase: 'idle' },
  };
  return {
    discover: vi.fn(async () => ({ hosts: [], unavailableAliases: [] })),
    list: vi.fn(() => [view]),
    get: vi.fn(() => view),
    add: vi.fn(() => view),
    connect: vi.fn(async () => ({
      ...view,
      state: { phase: 'connected', localUrl: 'http://127.0.0.1:45123' },
    })),
    disconnect: vi.fn(async () => ({
      ...view,
      state: { phase: 'disconnected', reason: 'stopped' },
    })),
    remove: vi.fn(async () => true),
    probe: vi.fn(async () => ({
      evidenceVersion: 1,
      level: 'discovered',
      freshness: 'fresh',
      observedAt: '2026-08-22T00:00:00.000Z',
      reachable: false,
      summary: 'Connection refused on port 22 — is sshd running on box-b?',
      action: 'Start the SSH server on box-b, then test again.',
      failure: { code: 'connection-refused', detail: 'ssh: connect to host' },
    })),
  };
}

describe('SSH environment routes', () => {
  test('discovers, creates, connects, and disconnects through typed routes', async () => {
    const mock = service();
    const app = createSshEnvironmentRoutes(mock as any);
    expect((await json(await app.request('/hosts'))).success).toBe(true);
    const created = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostAlias: 'home-media',
        remoteProjectPath: '~/dev/station',
      }),
    });
    expect(created.status).toBe(201);
    expect(mock.add).toHaveBeenCalledWith({
      hostAlias: 'home-media',
      remoteProjectPath: '~/dev/station',
    });
    const id = '11111111-1111-4111-8111-111111111111';
    expect(
      (await json(await app.request(`/${id}/connect`, { method: 'POST' }))).data
        .state.phase,
    ).toBe('connected');
    expect(
      (await json(await app.request(`/${id}/disconnect`, { method: 'POST' })))
        .data.state.phase,
    ).toBe('disconnected');
  });

  test('passes launchMode through to the service unmodified when supplied', async () => {
    const mock = service();
    const app = createSshEnvironmentRoutes(mock as any);
    const created = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostAlias: 'home-media',
        remoteProjectPath: '~/dev/station',
        launchMode: 'managed',
      }),
    });
    expect(created.status).toBe(201);
    expect(mock.add).toHaveBeenCalledWith({
      hostAlias: 'home-media',
      remoteProjectPath: '~/dev/station',
      launchMode: 'managed',
    });
  });

  test('rejects an unrecognized launchMode before service code', async () => {
    const mock = service();
    const app = createSshEnvironmentRoutes(mock as any);
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostAlias: 'home-media',
        remoteProjectPath: '~/dev/station',
        launchMode: 'launch-everything',
      }),
    });
    expect(response.status).toBe(400);
    expect(mock.add).not.toHaveBeenCalled();
  });

  // sol review finding 2: `allowUnknownHost` is retired, so an unknown
  // hostname must be an ORDINARY create — no flag to supply, and nothing
  // silently added to the body on the way through.
  test('an unconfigured hostname creates with no extra flag, and the body reaches the service unmodified', async () => {
    const mock = service();
    const app = createSshEnvironmentRoutes(mock as any);
    const created = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostAlias: '203.0.113.42',
        remoteProjectPath: '~/dev/station',
      }),
    });
    expect(created.status).toBe(201);
    expect(mock.add).toHaveBeenCalledWith({
      hostAlias: '203.0.113.42',
      remoteProjectPath: '~/dev/station',
    });
  });

  // The retired flag must not survive as an accepted-but-ignored field: the
  // schema strips unknown keys, so a caller still sending it gets a profile
  // created without it rather than a silent no-op they think did something.
  test('a request still sending the retired allowUnknownHost flag has it stripped before the service sees it', async () => {
    const mock = service();
    const app = createSshEnvironmentRoutes(mock as any);
    const created = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostAlias: '203.0.113.42',
        remoteProjectPath: '~/dev/station',
        allowUnknownHost: true,
      }),
    });
    expect(created.status).toBe(201);
    expect(mock.add).toHaveBeenCalledWith({
      hostAlias: '203.0.113.42',
      remoteProjectPath: '~/dev/station',
    });
  });

  // The alias FORMAT guard still lives in SshEnvironmentService#add, not the
  // route — this proves the route surfaces that rejection as a 400 with the
  // service's own message rather than swallowing or reshaping it.
  test('surfaces a rejected add() as a 400 with the service message', async () => {
    const mock: Record<string, unknown> = service();
    mock.add = vi.fn(async () => {
      throw new Error(
        'SSH host alias "raw host" is not a valid OpenSSH alias.',
      );
    });
    const app = createSshEnvironmentRoutes(mock as any);
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostAlias: 'raw-host',
        remoteProjectPath: '~/dev/station',
      }),
    });
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/not a valid OpenSSH alias/);
  });

  test('rejects flag-like aliases and invalid remote ports before service code', async () => {
    const mock = service();
    const app = createSshEnvironmentRoutes(mock as any);
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostAlias: '-oProxyCommand=bad',
        remoteProjectPath: '/srv/station',
        remotePort: 70_000,
      }),
    });
    expect(response.status).toBe(400);
    expect(mock.add).not.toHaveBeenCalled();
  });

  // archive#1097 R1: '/sessions' is registered ahead of '/:id' so it is
  // matched literally rather than swallowed as `id === 'sessions'`.
  test('routes GET /sessions through the injected remote-session aggregator, not the /:id handler', async () => {
    const mock = service();
    const listRemoteSessions = vi.fn(async () => ({
      environments: [
        {
          environmentId: 'env-1',
          environmentName: 'Home media',
          sessions: [],
        },
      ],
      unavailable: [],
      authenticationRequired: [],
    }));
    const app = createSshEnvironmentRoutes(
      mock as any,
      listRemoteSessions,
      undefined,
      undefined,
      undefined,
      OWNER_READS,
    );
    const response = await app.request('/sessions');
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toEqual({
      success: true,
      data: {
        environments: [
          {
            environmentId: 'env-1',
            environmentName: 'Home media',
            sessions: [],
          },
        ],
        unavailable: [],
        authenticationRequired: [],
      },
    });
    expect(listRemoteSessions).toHaveBeenCalledWith(mock);
    expect(mock.get).not.toHaveBeenCalled();
  });

  test('/sessions degrades to a 503 envelope rather than throwing when the aggregator rejects', async () => {
    const mock = service();
    const listRemoteSessions = vi.fn(async () => {
      throw new Error('boom');
    });
    const app = createSshEnvironmentRoutes(
      mock as any,
      listRemoteSessions,
      undefined,
      undefined,
      undefined,
      OWNER_READS,
    );
    const response = await app.request('/sessions');
    expect(response.status).toBe(503);
    expect((await json(response)).success).toBe(false);
  });

  // Audit CI-R1/CI-R14: "Test connection" before anything is saved. It must
  // be reachable as its own literal path (Hono matches in definition order,
  // so `/:id` would otherwise swallow it) and must answer with the server's
  // named cause and next step rather than a bare error.
  test('probes a prospective host without creating anything', async () => {
    const mock = service();
    const app = createSshEnvironmentRoutes(mock as any);
    const response = await app.request('/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostAlias: 'box-b' }),
    });
    const body = await json(response);
    expect(response.status).toBe(200);
    expect(mock.probe).toHaveBeenCalledWith({ hostAlias: 'box-b' });
    expect(mock.add).not.toHaveBeenCalled();
    expect(body.data.summary).toContain('is sshd running on box-b?');
    expect(body.data.action).toContain('Start the SSH server');
  });

  test('rejects a probe host that is not a valid SSH destination', async () => {
    const mock = service();
    const app = createSshEnvironmentRoutes(mock as any);
    const response = await app.request('/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostAlias: '-oProxyCommand=touch /tmp/x' }),
    });
    expect(response.status).toBe(400);
    expect(mock.probe).not.toHaveBeenCalled();
  });
});

/**
 * sol review finding 4: `POST /probe` starts a real outbound process at a
 * caller-named host. These drive the ROUTE (not the gate class) so the 429,
 * its `Retry-After`, and the slot release are proven where a caller meets
 * them.
 */
describe('SSH probe admission', () => {
  /**
   * A refusal must ARRIVE, and quickly. Awaiting the response directly is
   * not enough: when the bound is missing the request is admitted and hangs
   * on the blocking probe, so the test dies on vitest's generic "test timed
   * out" — red, but naming nothing. Racing a deadline makes the failure text
   * say which bound stopped bounding.
   */
  async function expectRefused(
    pending: Response | Promise<Response>,
    reason: string,
  ): Promise<Response> {
    const settled = await Promise.race([
      Promise.resolve(pending),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
    ]);
    expect(settled, reason).not.toBeNull();
    return settled as Response;
  }

  /** A probe that stays in flight until the test lets it finish. */
  function blockingService() {
    const started: Array<() => void> = [];
    const mock = service();
    mock.probe = vi.fn(
      () =>
        new Promise((resolvePromise) => {
          started.push(() => resolvePromise({ reachable: false } as never));
        }),
    );
    return { mock, started };
  }

  test('a second concurrent probe from the same caller is refused with 429 and a Retry-After', async () => {
    const { mock, started } = blockingService();
    const app = createSshEnvironmentRoutes(
      mock as any,
      undefined,
      undefined,
      new SshProbeAdmission({ retryAfterSeconds: 15 }),
    );
    const probe = () =>
      app.request('/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostAlias: 'box-b' }),
      });

    const first = probe();
    await vi.waitFor(() => expect(started.length).toBe(1));

    const refused = await expectRefused(
      probe(),
      'a second concurrent probe from the same caller was ADMITTED — the per-principal bound did not refuse it',
    );
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBe('15');
    expect((await json(refused)).error).toMatch(
      /connection test is already running/i,
    );
    // Refused means REFUSED: no second process was started.
    expect(mock.probe).toHaveBeenCalledTimes(1);

    // Releasing the slot lets the next one through — a bound, not a ban.
    started[0]?.();
    await first;
    const after = probe();
    await vi.waitFor(() => expect(started.length).toBe(2));
    started[1]?.();
    expect((await after).status).toBe(200);
  });

  /**
   * sol delta finding 5. The route's OWN default is under test here — the
   * other cases inject an explicit number, which would keep passing if the
   * wiring reverted to a constant. `Retry-After` has to be the probe's whole
   * sequential ceiling (resolve + attempt + key scan); the attempt's ceiling
   * alone sends a caller back while the first probe is still scanning.
   */
  test("the route's default Retry-After is the probe's full sequential ceiling", async () => {
    const { mock, started } = blockingService();
    // No admission argument: this exercises what production constructs.
    const app = createSshEnvironmentRoutes(mock as any);
    const probe = () =>
      app.request('/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostAlias: 'box-b' }),
      });

    const first = probe();
    await vi.waitFor(() => expect(started.length).toBe(1));
    const refused = await expectRefused(
      probe(),
      'the default admission did not refuse a second concurrent probe',
    );

    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBe(
      String(SSH_PROBE_MAX_SECONDS),
    );
    // Not the attempt leg on its own — the bug this replaces.
    expect(refused.headers.get('Retry-After')).not.toBe(
      String(SSH_PROBE_ATTEMPT_MAX_SECONDS),
    );

    started[0]?.();
    await first;
  });

  test('releasing a ticket twice frees one slot, not two', async () => {
    const admission = new SshProbeAdmission({ retryAfterSeconds: 15 });
    const ticket = admission.admit('principal:a');
    expect('release' in ticket).toBe(true);
    expect(admission.inFlight).toBe(1);
    (ticket as { release(): void }).release();
    (ticket as { release(): void }).release();
    // Without the idempotence guard the counter goes NEGATIVE here, which
    // silently raises the global cap for every later caller.
    expect(admission.inFlight).toBe(0);
    admission.admit('principal:a');
    expect(admission.inFlight).toBe(1);
  });

  test('a global cap of three holds across distinct callers, and a probe that throws still frees its slot', async () => {
    const { mock, started } = blockingService();
    // Each caller is under its own per-principal limit; only the global cap
    // can refuse here, which is the property this pins.
    const admission = new SshProbeAdmission({
      retryAfterSeconds: 15,
      perPrincipalLimit: 10,
    });
    const app = createSshEnvironmentRoutes(
      mock as any,
      undefined,
      undefined,
      admission,
    );
    const probe = () =>
      app.request('/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostAlias: 'box-b' }),
      });

    const inFlight = [probe(), probe(), probe()];
    await vi.waitFor(() => expect(started.length).toBe(3));
    expect(admission.inFlight).toBe(3);

    const refused = await expectRefused(
      probe(),
      'a fourth concurrent probe was ADMITTED — the global cap of three did not refuse it',
    );
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBe('15');
    expect((await json(refused)).error).toMatch(/as many connection tests/i);
    expect(mock.probe).toHaveBeenCalledTimes(3);

    for (const release of started) release();
    await Promise.all(inFlight);
    expect(admission.inFlight).toBe(0);

    // A probe that REJECTS must release too, or one bad host permanently
    // burns a slot — the `finally` is what makes the bound self-healing.
    const failing = service();
    failing.probe = vi.fn(async () => {
      throw new Error('SSH host alias "box b" is not a valid OpenSSH alias.');
    });
    const failingApp = createSshEnvironmentRoutes(
      failing as any,
      undefined,
      undefined,
      admission,
    );
    const rejected = await failingApp.request('/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostAlias: 'box-b' }),
    });
    expect(rejected.status).toBe(400);
    expect(admission.inFlight).toBe(0);
  });
});

describe('remote session history (read-only, over a connected environment)', () => {
  const ENV_ID = '22222222-2222-4222-8222-222222222222';
  const THREAD = 'external:claude:0123456789abcdef0123456789abcdef';

  function remoteService(phase: 'connected' | 'idle' = 'connected') {
    const view = {
      profile: { id: ENV_ID, name: 'Home media', environmentId: 'peer-env' },
      state:
        phase === 'connected'
          ? { phase, localUrl: 'http://127.0.0.1:45999' }
          : { phase },
    };
    return {
      list: vi.fn(() => [view]),
      connect: vi.fn(async () => view),
    };
  }

  const peerCredentials = {
    get: vi.fn((environmentId: string) =>
      environmentId === 'peer-env'
        ? ({ credential: 'peer-bearer-for-test' } as any)
        : null,
    ),
  };

  function window(threadId = THREAD, extra: Record<string, unknown> = {}) {
    return {
      protocolVersion: 1 as const,
      session: {
        threadId,
        provider: 'claude',
        controlMode: 'read-only-attached',
      } as any,
      events: [
        {
          sequence: 7,
          event: { eventId: 'evt-1', type: 'message.user', threadId } as any,
        },
      ],
      hasMore: true,
      nextCursor: 'cursor-1',
      watermark: 7,
      ...extra,
    };
  }

  test('relays one bounded page from the connected environment with its peer bearer, labeled by this Station', async () => {
    const svc = remoteService();
    const fetchHistory = vi.fn(async () =>
      window(THREAD, { environmentName: 'spoofed', remoteOnly: 'drop-me' }),
    );
    const app = createSshEnvironmentRoutes(
      svc as any,
      undefined,
      peerCredentials,
      undefined,
      fetchHistory,
      OWNER_READS,
    );
    const client = new AbortController();
    const response = await app.request(
      new Request(
        `http://station.test/sessions/${ENV_ID}/${encodeURIComponent(THREAD)}/history?turnLimit=5&cursor=c0`,
        { signal: client.signal },
      ),
    );
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(fetchHistory).toHaveBeenCalledWith(
      'http://127.0.0.1:45999',
      THREAD,
      { cursor: 'c0', turnLimit: 5 },
      {
        headers: { Authorization: 'Bearer peer-bearer-for-test' },
        signal: expect.any(AbortSignal),
      },
    );
    // The caller's own signal: a client that goes away cancels the remote read.
    const forwarded = (
      fetchHistory.mock.calls[0] as unknown as [
        string,
        string,
        unknown,
        { signal: AbortSignal },
      ]
    )[3].signal;
    expect(forwarded.aborted).toBe(false);
    client.abort();
    expect(forwarded.aborted).toBe(true);
    expect(svc.connect).not.toHaveBeenCalled();
    expect(body.data.environmentId).toBe(ENV_ID);
    expect(body.data.environmentName).toBe('Home media');
    expect(body.data.window.events).toHaveLength(1);
    expect(body.data.window.nextCursor).toBe('cursor-1');
    expect(body.data.window.session.threadId).toBe(THREAD);
    // Only the page's own fields cross; the remote cannot add others.
    expect(body.data.window).not.toHaveProperty('remoteOnly');
    expect(body.data.window).not.toHaveProperty('environmentName');
    expect(JSON.stringify(body)).not.toContain('peer-bearer-for-test');
  });

  test('never dials: an environment that is not connected is unavailable and nothing is fetched', async () => {
    const svc = remoteService('idle');
    const fetchHistory = vi.fn();
    const app = createSshEnvironmentRoutes(
      svc as any,
      undefined,
      peerCredentials,
      undefined,
      fetchHistory as any,
      OWNER_READS,
    );
    const response = await app.request(
      `/sessions/${ENV_ID}/${encodeURIComponent(THREAD)}/history`,
    );
    expect(response.status).toBe(409);
    expect((await json(response)).code).toBe('environment_unavailable');
    expect(fetchHistory).not.toHaveBeenCalled();
    expect(svc.connect).not.toHaveBeenCalled();
  });

  test('a missing peer credential is a repairable state, never an unauthenticated read', async () => {
    const svc = remoteService();
    const fetchHistory = vi.fn();
    const app = createSshEnvironmentRoutes(
      svc as any,
      undefined,
      { get: () => null } as any,
      undefined,
      fetchHistory as any,
      OWNER_READS,
    );
    const response = await app.request(
      `/sessions/${ENV_ID}/${encodeURIComponent(THREAD)}/history`,
    );
    expect(response.status).toBe(409);
    expect((await json(response)).code).toBe('authentication_required');
    expect(fetchHistory).not.toHaveBeenCalled();
  });

  test("the remote's 401 is reported as authentication_required, not as this Station's own 401", async () => {
    const { StationHttpError } = await import('@kontourai/station-sdk/client');
    const app = createSshEnvironmentRoutes(
      remoteService() as any,
      undefined,
      peerCredentials,
      undefined,
      async () => {
        throw new StationHttpError(401, 'Unauthorized');
      },
      OWNER_READS,
    );
    const response = await app.request(
      `/sessions/${ENV_ID}/${encodeURIComponent(THREAD)}/history`,
    );
    expect(response.status).toBe(409);
    expect((await json(response)).code).toBe('authentication_required');
  });

  test('refuses a page naming another session, or one past the event bound, instead of relaying it', async () => {
    const { MAX_REMOTE_SESSION_HISTORY_EVENTS } = await import(
      '../../../services/ssh/remote-session-reader.js'
    );
    const other = createSshEnvironmentRoutes(
      remoteService() as any,
      undefined,
      peerCredentials,
      undefined,
      async () => window('external:claude:ffffffffffffffffffffffffffffffff'),
      OWNER_READS,
    );
    const otherResponse = await other.request(
      `/sessions/${ENV_ID}/${encodeURIComponent(THREAD)}/history`,
    );
    expect(otherResponse.status).toBe(502);
    expect((await json(otherResponse)).code).toBe('invalid_response');

    const oversized = window();
    oversized.events = Array.from(
      { length: MAX_REMOTE_SESSION_HISTORY_EVENTS + 1 },
      (_, index) => ({
        sequence: index,
        event: { eventId: `evt-${index}` } as any,
      }),
    );
    const big = createSshEnvironmentRoutes(
      remoteService() as any,
      undefined,
      peerCredentials,
      undefined,
      async () => oversized,
      OWNER_READS,
    );
    const bigResponse = await big.request(
      `/sessions/${ENV_ID}/${encodeURIComponent(THREAD)}/history`,
    );
    expect(bigResponse.status).toBe(502);
    expect((await json(bigResponse)).code).toBe('invalid_response');
  });

  test.each([
    ['turnLimit above the remote bound', '?turnLimit=21'],
    ['a non-numeric turnLimit', '?turnLimit=ten'],
    ['an oversized cursor', `?cursor=${'c'.repeat(513)}`],
  ])('rejects %s before any remote read', async (_label, query) => {
    const fetchHistory = vi.fn();
    const app = createSshEnvironmentRoutes(
      remoteService() as any,
      undefined,
      peerCredentials,
      undefined,
      fetchHistory as any,
      OWNER_READS,
    );
    const response = await app.request(
      `/sessions/${ENV_ID}/${encodeURIComponent(THREAD)}/history${query}`,
    );
    expect(response.status).toBe(400);
    expect(fetchHistory).not.toHaveBeenCalled();
  });
});

describe("remote reads are the bound owner's alone (security review H1)", () => {
  const ENV_ID = '22222222-2222-4222-8222-222222222222';
  const THREAD = 'external:claude:0123456789abcdef0123456789abcdef';
  const HISTORY = `/sessions/${ENV_ID}/${encodeURIComponent(THREAD)}/history`;

  function connected() {
    return {
      list: vi.fn(() => [
        {
          profile: {
            id: ENV_ID,
            name: 'Home media',
            environmentId: 'peer-env',
          },
          state: { phase: 'connected', localUrl: 'http://127.0.0.1:45999' },
        },
      ]),
    };
  }
  const peers = { get: () => ({ credential: 'peer-bearer-for-test' }) as any };

  function routes(remoteReads: unknown) {
    const fetchHistory = vi.fn(async () => ({
      protocolVersion: 1 as const,
      session: { threadId: THREAD } as any,
      events: [],
      hasMore: false,
      watermark: 0,
    }));
    const listRemoteSessions = vi.fn(async () => ({
      environments: [],
      unavailable: [],
      authenticationRequired: [],
    }));
    const app = createSshEnvironmentRoutes(
      connected() as any,
      listRemoteSessions,
      peers,
      undefined,
      fetchHistory,
      remoteReads as any,
    );
    return { app, fetchHistory, listRemoteSessions };
  }

  test.each([
    [
      'a paired device bound to someone else',
      { hosted: false, current: () => true, owner: () => false },
      {},
    ],
    [
      'a principal that is no longer current',
      { hosted: false, current: () => false, owner: () => true },
      {},
    ],
    [
      'an agent-originated request, even from the owner',
      OWNER_READS,
      { 'x-station-control-origin': 'agent-tool' },
    ],
    ['a Station that composed no read authority', undefined, {}],
  ])(
    'refuses %s on both remote reads, reaching no remote',
    async (_label, reads, headers) => {
      const { app, fetchHistory, listRemoteSessions } = routes(reads);
      const history = await app.request(HISTORY, { headers });
      expect(history.status).toBe(403);
      const list = await app.request('/sessions', { headers });
      expect(list.status).toBe(403);
      expect(fetchHistory).not.toHaveBeenCalled();
      expect(listRemoteSessions).not.toHaveBeenCalled();
    },
  );

  test('a hosted Station serves no remote reads: no tenant binds the Station-wide peer bearer', async () => {
    const { app, fetchHistory, listRemoteSessions } = routes({
      ...OWNER_READS,
      hosted: true,
    });
    expect((await app.request(HISTORY)).status).toBe(404);
    expect((await app.request('/sessions')).status).toBe(404);
    expect(fetchHistory).not.toHaveBeenCalled();
    expect(listRemoteSessions).not.toHaveBeenCalled();
  });

  test('the bound, current owner reads both', async () => {
    const { app, fetchHistory, listRemoteSessions } = routes(OWNER_READS);
    expect((await app.request(HISTORY)).status).toBe(200);
    expect((await app.request('/sessions')).status).toBe(200);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    expect(listRemoteSessions).toHaveBeenCalledTimes(1);
  });
});

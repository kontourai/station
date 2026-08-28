import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import {
  SSH_PROBE_ATTEMPT_MAX_SECONDS,
  SSH_PROBE_MAX_SECONDS,
} from '../../../services/ssh/openssh-reachability.js';
import { SshProbeAdmission } from '../../../services/ssh/ssh-probe-admission.js';
import { createSshEnvironmentRoutes } from '../ssh-environments.js';

function service() {
  const view = {
    profile: {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Brian media',
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
        hostAlias: 'brian-media',
        remoteProjectPath: '~/dev/station',
      }),
    });
    expect(created.status).toBe(201);
    expect(mock.add).toHaveBeenCalledWith({
      hostAlias: 'brian-media',
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
        hostAlias: 'brian-media',
        remoteProjectPath: '~/dev/station',
        launchMode: 'managed',
      }),
    });
    expect(created.status).toBe(201);
    expect(mock.add).toHaveBeenCalledWith({
      hostAlias: 'brian-media',
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
        hostAlias: 'brian-media',
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
          environmentName: 'Brian media',
          sessions: [],
        },
      ],
      unavailable: [],
      authenticationRequired: [],
    }));
    const app = createSshEnvironmentRoutes(mock as any, listRemoteSessions);
    const response = await app.request('/sessions');
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toEqual({
      success: true,
      data: {
        environments: [
          {
            environmentId: 'env-1',
            environmentName: 'Brian media',
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
    const app = createSshEnvironmentRoutes(mock as any, listRemoteSessions);
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

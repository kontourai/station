/**
 * The remote task engine routes over the real service: every entry point is
 * refused with the preview off, with the managed policy not naming the
 * vendor, without the per-connection acknowledgement, and for a request that
 * may be an agent's, and each refusal sends nothing to the vendor. Two
 * connections never see each other's credential.
 */
import { remoteTaskAcknowledgementStatement } from '@kontourai/station-contracts/remote-task-engine';
import { afterEach, describe, expect, test } from 'vitest';
import { harness } from '../../../services/remote-task-engines/__tests__/harness.js';
import { devinFake } from '../../../services/remote-task-engines/__tests__/vendor-fakes.js';
import { REMOTE_TASK_CREDENTIAL_KEY } from '../../../services/remote-task-engines/credentials.js';
import { RemoteTaskTracker } from '../../../services/remote-task-engines/tracker.js';
import { createLogger } from '../../../utils/logger.js';
import { createRemoteTaskEngineRoutes } from '../remote-task-engine-routes.js';

const ORG_A = 'org-aaaaaaaaaaaa';
const ORG_B = 'org-bbbbbbbbbbbb';
const TOKEN_A = 'cog_token_for_connection_a';
const TOKEN_B = 'cog_token_for_connection_b';

const trackers: RemoteTaskTracker[] = [];
afterEach(() => {
  while (trackers.length > 0) trackers.pop()?.stop();
});

function setup() {
  const devinA = devinFake(ORG_A);
  const devinB = devinFake(ORG_B);
  // One fake origin: route by org path to the right fake.
  const fetchImpl: typeof fetch = (input, init) =>
    String(input).includes(ORG_B)
      ? devinB.fake.fetch(input, init)
      : devinA.fake.fetch(input, init);
  const h = harness(fetchImpl);
  const timers: Array<() => void> = [];
  const tracker = new RemoteTaskTracker({
    service: h.service,
    logger: createLogger({ name: 'remote-task-routes-test' }),
    // Polls are held, never run on their own, so a test controls every call.
    setTimer: (run) => {
      timers.push(run);
      return timers.length;
    },
    clearTimer: () => {},
  });
  trackers.push(tracker);
  const person = { allowed: true };
  const app = createRemoteTaskEngineRoutes({
    service: h.service,
    tracker,
    logger: createLogger({ name: 'remote-task-routes-test' }),
    isPersonRequest: () => person.allowed,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(path, {
      method,
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
        : {}),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
      headers: response.headers,
    };
  };
  const vendorRequests = () =>
    devinA.fake.requests.length + devinB.fake.requests.length;
  return { h, app, call, person, devinA, devinB, vendorRequests, timers };
}

async function readyConnection(
  s: ReturnType<typeof setup>,
  orgId = ORG_A,
  token = TOKEN_A,
) {
  const created = await s.call('POST', '/connections', {
    vendor: 'devin',
    settings: { orgId },
  });
  expect(created.status).toBe(201);
  const id = (created.body.data as { id: string }).id;
  expect(
    (
      await s.call('POST', `/connections/${id}/acknowledgement`, {
        statement: remoteTaskAcknowledgementStatement('devin'),
      })
    ).status,
  ).toBe(200);
  expect(
    (await s.call('PUT', `/connections/${id}/credential`, { token })).status,
  ).toBe(200);
  return id;
}

/** Every route that reads or sends feature state, with a body where needed. */
function featureRoutes(id: string, taskId: string) {
  return [
    ['GET', '/connections'],
    ['POST', '/connections', { vendor: 'devin', settings: { orgId: ORG_A } }],
    ['GET', `/connections/${id}`],
    ['PATCH', `/connections/${id}`, { label: 'Renamed' }],
    [
      'POST',
      `/connections/${id}/acknowledgement`,
      { statement: remoteTaskAcknowledgementStatement('devin') },
    ],
    ['PUT', `/connections/${id}/credential`, { token: 'cog_other' }],
    ['GET', `/connections/${id}/tasks`],
    ['POST', `/connections/${id}/tasks`, { prompt: 'Go' }],
    ['GET', `/connections/${id}/tasks/${taskId}`],
    ['POST', `/connections/${id}/tasks/${taskId}/messages`, { text: 'More' }],
    ['POST', `/connections/${id}/tasks/${taskId}/cancel`],
    ['POST', `/connections/${id}/tasks/${taskId}/sync`],
    ['GET', `/connections/${id}/tasks/${taskId}/events?after=0`],
  ] as Array<[string, string, unknown?]>;
}

/** Routes that only reach a vendor once the connection is acknowledged. */
function vendorRoutes(id: string, taskId: string) {
  return featureRoutes(id, taskId).filter(([, path]) => path.includes('/tasks'))
    .filter(([, path]) => !path.endsWith('/events?after=0'));
}

describe('remote task engine routes', () => {
  test('a ready connection runs a task end to end', async () => {
    const s = setup();
    const id = await readyConnection(s);
    const created = await s.call('POST', `/connections/${id}/tasks`, {
      prompt: 'Fix it',
    });
    expect(created.status).toBe(201);
    const taskId = (created.body.data as { taskId: string }).taskId;
    s.devinA.reply(taskId, 'On it');
    const synced = await s.call('POST', `/connections/${id}/tasks/${taskId}/sync`);
    expect(synced.status).toBe(200);
    const events = await s.call(
      'GET',
      `/connections/${id}/tasks/${taskId}/events?after=0`,
    );
    const texts = (events.body.data as { events: Array<{ text: string }> }).events.map(
      (e) => e.text,
    );
    expect(texts).toContain('On it');
    // Resume: only what follows the sequence a client holds.
    const last = (events.body.data as { events: Array<{ sequence: number }> }).events.at(-1)
      ?.sequence as number;
    s.devinA.reply(taskId, 'Done');
    await s.call('POST', `/connections/${id}/tasks/${taskId}/sync`);
    const resumed = await s.app.request(
      `/connections/${id}/tasks/${taskId}/events`,
      { headers: { 'last-event-id': String(last) } },
    );
    const resumedTexts = (
      ((await resumed.json()) as { data: { events: Array<{ text: string }> } }).data
        .events
    ).map((e) => e.text);
    expect(resumedTexts).toEqual(['Done']);
  });

  test('with the preview off every feature route answers 404 feature_preview_disabled and sends nothing', async () => {
    const s = setup();
    const id = await readyConnection(s);
    const before = s.vendorRequests();
    s.h.switches.preview = false;
    for (const [method, path, body] of featureRoutes(id, 'devin-000000000001')) {
      const answer = await s.call(method, path, body);
      expect(answer.status, `${method} ${path}`).toBe(404);
      expect(answer.body, `${method} ${path}`).toMatchObject({
        success: false,
        code: 'feature_preview_disabled',
        previewId: 'remote-task-engines',
        settingsPath: '/settings?view=feature-previews&highlight=feature-previews',
      });
    }
    expect(s.vendorRequests()).toBe(before);
    // Retained maintenance: withdrawing and removing still work.
    expect((await s.call('DELETE', `/connections/${id}/acknowledgement`)).status).toBe(200);
    expect((await s.call('DELETE', `/connections/${id}/credential`)).status).toBe(200);
    expect((await s.call('DELETE', `/connections/${id}`)).status).toBe(200);
    s.h.switches.preview = true;
    expect((await s.call('GET', '/connections')).body.data).toEqual([]);
  });

  test('a managed policy that does not name the vendor refuses every route that would use it', async () => {
    const s = setup();
    const id = await readyConnection(s);
    const before = s.vendorRequests();
    // A managed machine whose policy says nothing about remote tasks.
    s.h.switches.policy = { engines: {} };
    const refused = featureRoutes(id, 'devin-000000000001').filter(
      ([method, path]) => !(method === 'GET' && /^\/connections(\/[^/]+)?$/.test(path)),
    );
    for (const [method, path, body] of refused) {
      const answer = await s.call(method, path, body);
      expect(answer.status, `${method} ${path}`).toBe(403);
      expect(answer.body.code, `${method} ${path}`).toBe('remote-task-policy-refused');
      expect(String(answer.body.error)).toContain('Example Corp');
    }
    expect(s.vendorRequests()).toBe(before);
    // Allowing another vendor does not allow this one.
    s.h.switches.policy = { engines: { remoteTasks: ['cursor'] } };
    expect(
      (await s.call('POST', `/connections/${id}/tasks`, { prompt: 'Go' })).body.code,
    ).toBe('remote-task-policy-refused');
    // Naming it does.
    s.h.switches.policy = { engines: { remoteTasks: ['devin'] } };
    expect((await s.call('POST', `/connections/${id}/tasks`, { prompt: 'Go' })).status).toBe(
      201,
    );
  });

  test('nothing is sent before the vendor-naming acknowledgement', async () => {
    const s = setup();
    const created = await s.call('POST', '/connections', {
      vendor: 'devin',
      settings: { orgId: ORG_A },
      // A client cannot acknowledge on creation.
      acknowledgement: { vendor: 'devin' },
    });
    const id = (created.body.data as { id: string; acknowledged: boolean }).id;
    expect((created.body.data as { acknowledged: boolean }).acknowledged).toBe(false);
    await s.call('PUT', `/connections/${id}/credential`, { token: TOKEN_A });
    for (const [method, path, body] of vendorRoutes(id, 'devin-000000000001')) {
      const answer = await s.call(method, path, body);
      expect(answer.status, `${method} ${path}`).toBe(403);
      expect(answer.body.code, `${method} ${path}`).toBe(
        'remote-task-acknowledgement-required',
      );
    }
    // Another vendor's statement, or an edited one, does not count.
    for (const statement of [
      remoteTaskAcknowledgementStatement('cursor'),
      `${remoteTaskAcknowledgementStatement('devin')} `,
    ]) {
      const answer = await s.call('POST', `/connections/${id}/acknowledgement`, {
        statement,
      });
      expect(answer.status).toBe(400);
    }
    expect(s.vendorRequests()).toBe(0);
    await s.call('POST', `/connections/${id}/acknowledgement`, {
      statement: remoteTaskAcknowledgementStatement('devin'),
    });
    expect((await s.call('POST', `/connections/${id}/tasks`, { prompt: 'Go' })).status).toBe(
      201,
    );
    // Withdrawing it stops sending again.
    await s.call('DELETE', `/connections/${id}/acknowledgement`);
    expect(
      (await s.call('POST', `/connections/${id}/tasks`, { prompt: 'Go' })).body.code,
    ).toBe('remote-task-acknowledgement-required');
  });

  test('a request that may be an agent is refused on every route', async () => {
    const s = setup();
    const id = await readyConnection(s);
    s.person.allowed = false;
    const routes = [
      ...featureRoutes(id, 'devin-000000000001'),
      ['DELETE', `/connections/${id}`],
      ['DELETE', `/connections/${id}/credential`],
    ] as Array<[string, string, unknown?]>;
    for (const [method, path, body] of routes) {
      const answer = await s.call(method, path, body);
      expect(answer.status, `${method} ${path}`).toBe(403);
      expect(answer.body.code).toBe('remote-task-not-granted');
    }
    expect(s.vendorRequests()).toBe(0);
  });

  test('each connection uses only its own credential, and none is ever returned', async () => {
    const s = setup();
    const a = await readyConnection(s, ORG_A, TOKEN_A);
    const b = await readyConnection(s, ORG_B, TOKEN_B);
    await s.call('POST', `/connections/${a}/tasks`, { prompt: 'A' });
    await s.call('POST', `/connections/${b}/tasks`, { prompt: 'B' });
    expect(s.devinA.fake.requests.map((r) => r.headers.get('authorization'))).toEqual([
      `Bearer ${TOKEN_A}`,
    ]);
    expect(s.devinB.fake.requests.map((r) => r.headers.get('authorization'))).toEqual([
      `Bearer ${TOKEN_B}`,
    ]);
    const listing = JSON.stringify((await s.call('GET', '/connections')).body);
    expect(listing).not.toContain(TOKEN_A);
    expect(listing).not.toContain(TOKEN_B);
    expect(listing).toContain('"credential":"set"');
    // Separate vault buckets, and removing A leaves B's alone.
    expect(s.h.vault.bucketIds().sort()).toEqual(
      [`engine-secret:${a}:default`, `engine-secret:${b}:default`].sort(),
    );
    await s.call('DELETE', `/connections/${a}`);
    expect(s.h.vault.bucketIds()).toEqual([`engine-secret:${b}:default`]);
    expect(
      s.h.vault.readSecret(
        { connectionId: b, credentialProfileRef: 'default' },
        REMOTE_TASK_CREDENTIAL_KEY,
      ),
    ).toBe(TOKEN_B);
    // Clearing B's credential stops its calls before any request.
    await s.call('DELETE', `/connections/${b}/credential`);
    const sent = s.vendorRequests();
    expect(
      (await s.call('POST', `/connections/${b}/tasks`, { prompt: 'B' })).body.code,
    ).toBe('remote-task-credential-missing');
    expect(s.vendorRequests()).toBe(sent);
  });

  test('out-of-range polling is refused, never clamped', async () => {
    const s = setup();
    for (const polling of [
      { intervalMs: 1_000, maxBackoffMs: 60_000 },
      { intervalMs: 60_000, maxBackoffMs: 10_000 },
      { intervalMs: 15_000, maxBackoffMs: 3_600_000 },
      { intervalMs: 15_000 },
    ]) {
      const answer = await s.call('POST', '/connections', {
        vendor: 'devin',
        settings: { orgId: ORG_A },
        polling,
      });
      expect(answer.status, JSON.stringify(polling)).toBe(400);
      expect(answer.body.code).toBe('remote-task-invalid');
    }
    expect((await s.call('GET', '/connections')).body.data).toEqual([]);
  });

  test('a rate-limited vendor answers 429 with Retry-After', async () => {
    const s = setup();
    const id = await readyConnection(s);
    s.devinA.fake.inject(1, () =>
      new Response(JSON.stringify({ title: 'Too Many Requests', status: 429 }), {
        status: 429,
        headers: { 'retry-after': '12' },
      }),
    );
    const answer = await s.call('POST', `/connections/${id}/tasks`, { prompt: 'Go' });
    expect(answer.status).toBe(429);
    expect(answer.headers.get('retry-after')).toBe('12');
    expect(answer.body).toMatchObject({
      code: 'remote-task-rate-limited',
      retryAfterMs: 12_000,
    });
  });
});

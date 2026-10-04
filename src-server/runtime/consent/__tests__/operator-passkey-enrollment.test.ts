/**
 * Operator passkey enrollment, end to end through the real routes (#3257, S2b):
 * the consent-origin routes the browser calls, the host routes the CLI calls,
 * the real `@simplewebauthn/server` verification (fed by a software
 * authenticator that builds genuine attestation-none responses), and the real
 * private SQLite registry.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SoftwareAuthenticator } from '../../../__test-utils__/software-authenticator.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createOperatorPasskeyHostRoutes } from '../../../routes/operator-passkeys/operator-passkey-host-routes.js';
import { ConsentChannelService } from '../../../services/consent/consent-channel.js';
import {
  ENROLLMENT_CEREMONY_TTL_MS,
  ENROLLMENT_CHALLENGE_TTL_MS,
  ENROLLMENT_CODE_FAILURE_LIMIT,
  ENROLLMENT_CODE_FAILURE_WINDOW_MS,
  ENROLLMENT_ERROR_CODES,
  ENROLLMENT_MAX_LIVE_REQUESTS,
  ENROLLMENT_REQUEST_TTL_MS,
  type EnrollmentErrorCode,
  OperatorPasskeyEnrollmentError,
  OperatorPasskeyEnrollmentService,
  publicEnrollmentMessage,
} from '../../../services/identity/operator-passkey-enrollment.js';
import {
  LazyOperatorPasskeyRegistry,
  OPERATOR_PASSKEY_DB_RELATIVE_PATH,
  OperatorPasskeyRegistry,
} from '../../../services/identity/operator-passkey-registry.js';
import { operatorPasskeyEnrollmentOps } from '../../../telemetry/metrics.js';
import type { Logger } from '../../../utils/logger.js';
import { createConsentApp } from '../consent-listener.js';

const ORIGIN = 'https://station.example.ts.net';
const HOST = 'station.example.ts.net';
const PHONE_COOKIE = `__Host-station-device=${'P'.repeat(43)}`;
const LAPTOP_COOKIE = `__Host-station-device=${'L'.repeat(43)}`;
const SPOOF_COOKIE = `__Host-station-device=${'S'.repeat(43)}`;
/** What the pairing registry knows; the NAME is the device's own claim. */
const DEVICES: Record<
  string,
  { id: string; name: string; scope: string; createdAt: number }
> = {
  [`${'P'.repeat(43)}`]: {
    id: 'aaaa1111-0000-4000-8000-000000000001',
    name: 'Phone browser',
    scope: 'orchestration:read',
    createdAt: 1_790_000_000_000,
  },
  [`${'L'.repeat(43)}`]: {
    id: 'bbbb2222-0000-4000-8000-000000000002',
    name: 'Laptop browser',
    scope: 'orchestration:read orchestration:operate',
    createdAt: 1_791_000_000_000,
  },
  [`${'S'.repeat(43)}`]: {
    id: 'cccc3333-0000-4000-8000-000000000003',
    name: 'station operator BROWSER',
    scope: 'orchestration:read',
    createdAt: 1_792_000_000_000,
  },
};
const OPERATOR_HEADER = 'x-test-operator';
const PATH = '/operator/passkeys/enroll';

const makeTempDir = trackTempDirs();

function makeLogger() {
  const calls: unknown[][] = [];
  const record = (...args: unknown[]) => {
    calls.push(args);
  };
  const logger = {
    trace: record,
    debug: record,
    info: record,
    warn: record,
    error: record,
    fatal: record,
    child: () => logger,
  } as unknown as Logger;
  return { logger, calls };
}

interface Harness {
  home: string;
  clock: { now: number };
  registry: OperatorPasskeyRegistry;
  service: OperatorPasskeyEnrollmentService;
  consent: Hono;
  host: Hono;
  logCalls: unknown[][];
}

function build(origin: string | null = ORIGIN): Harness {
  const home = makeTempDir('station-passkey-');
  const clock = { now: 1_800_000_000_000 };
  const registry = OperatorPasskeyRegistry.open(home, () => clock.now);
  const { logger, calls } = makeLogger();
  const service = new OperatorPasskeyEnrollmentService({
    registry,
    origin,
    now: () => clock.now,
    logger,
  });
  const channel = new ConsentChannelService({ trustedOrigin: origin });
  channel.markListening(4321);
  const consent = createConsentApp({
    channel,
    credentials: {
      verifyOperatorCredential: () => false,
      identifyDevice: (candidate) =>
        candidate === 'N'.repeat(43)
          ? { name: 'No id' }
          : (DEVICES[candidate] ?? null),
    },
    passkeys: service,
  });
  const host = new Hono();
  host.route(
    '/api/pairing/operator-passkeys',
    createOperatorPasskeyHostRoutes({
      service,
      isOperator: (c) =>
        (c as { req: { header(name: string): string | undefined } }).req.header(
          OPERATOR_HEADER,
        ) === 'yes',
    }),
  );
  return { home, clock, registry, service, consent, host, logCalls: calls };
}

function browserHeaders(
  cookie = PHONE_COOKIE,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const headers: Record<string, string | undefined> = {
    host: HOST,
    origin: ORIGIN,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    cookie,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

const post = (
  h: Harness,
  path: string,
  body: unknown = {},
  cookie = PHONE_COOKIE,
  overrides: Record<string, string | undefined> = {},
) =>
  h.consent.request(path, {
    method: 'POST',
    headers: browserHeaders(cookie, overrides),
    body: JSON.stringify(body),
  });

const hostCall = (h: Harness, path: string, init: RequestInit = {}) =>
  h.host.request(`/api/pairing/operator-passkeys${path}`, {
    ...init,
    headers: {
      [OPERATOR_HEADER]: 'yes',
      'content-type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });

async function startRequest(h: Harness, cookie = PHONE_COOKIE) {
  const res = await post(h, `${PATH}/requests`, {}, cookie);
  expect(res.status).toBe(201);
  return (await json(res)) as {
    requestId: string;
    code: string;
    expiresAt: number;
    rpId: string;
  };
}

async function confirm(h: Harness, code: string) {
  return hostCall(h, '/requests/approve', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

async function optionsFor(
  h: Harness,
  requestId: string,
  cookie = PHONE_COOKIE,
) {
  const res = await post(
    h,
    `${PATH}/requests/${requestId}/options`,
    {},
    cookie,
  );
  return { res, body: await json(res) };
}

const verify = (
  h: Harness,
  requestId: string,
  response: unknown,
  label?: string,
  cookie = PHONE_COOKIE,
) =>
  post(h, `${PATH}/requests/${requestId}/verify`, { response, label }, cookie);

/** Full ceremony to a confirmed request with options minted. */
async function confirmedWithOptions(h: Harness, cookie = PHONE_COOKIE) {
  const started = await startRequest(h, cookie);
  expect((await confirm(h, started.code)).status).toBe(200);
  const { res, body } = await optionsFor(h, started.requestId, cookie);
  expect(res.status).toBe(200);
  return {
    started,
    options: body as { challenge: string; rp: { id: string } },
  };
}

let h: Harness;
const metricSpy = vi.spyOn(operatorPasskeyEnrollmentOps, 'add');

beforeEach(() => {
  metricSpy.mockClear();
  h = build();
});
afterEach(() => {
  h.registry.close();
});

describe('enrollment happy path', () => {
  test('browser requests, host confirms the displayed code, ceremony stores the public key', async () => {
    const started = await startRequest(h);
    expect(started.code).toMatch(/^[0-9]{6}$/);
    expect(started.rpId).toBe(HOST);

    // Not confirmed yet: the ceremony is closed.
    const early = await optionsFor(h, started.requestId);
    expect(early.res.status).toBe(409);
    expect(early.body.error).toBe('request_not_confirmed');

    // The host's listing shows the request but never its code.
    const listing = await json(await hostCall(h, ''));
    expect(listing.pending).toHaveLength(1);
    expect(listing.pending[0].deviceLabel).toBe('Phone browser');
    expect(listing.pending[0].rpId).toBe(HOST);
    expect(JSON.stringify(listing)).not.toContain(started.code);
    expect(JSON.stringify(listing)).not.toContain(started.requestId);

    expect(await json(await confirm(h, started.code))).toMatchObject({
      deviceLabel: 'Phone browser',
      rpId: HOST,
    });
    expect((await json(await fetchStatus(h, started.requestId))).state).toBe(
      'confirmed',
    );

    const { res, body: options } = await optionsFor(h, started.requestId);
    expect(res.status).toBe(200);
    // D7: UV required, attestation none, no authenticator allowlist, RP from config.
    expect(options.rp.id).toBe(HOST);
    expect(options.attestation).toBe('none');
    expect(options.authenticatorSelection.userVerification).toBe('required');
    expect(
      options.authenticatorSelection.authenticatorAttachment,
    ).toBeUndefined();
    expect(options.excludeCredentials ?? []).toEqual([]);

    const authenticator = new SoftwareAuthenticator();
    const stored = await verify(
      h,
      started.requestId,
      authenticator.register(options as never, { origin: ORIGIN }),
      'Primary',
    );
    expect(stored.status).toBe(201);
    const passkey = (await json(stored)).passkey;
    expect(passkey).toMatchObject({
      label: 'Primary',
      rpId: HOST,
      origin: ORIGIN,
    });
    // The response and the host listing expose metadata only.
    expect(JSON.stringify(passkey)).not.toContain(
      authenticator.credentialIdBase64Url,
    );
    expect(Object.keys(passkey)).not.toContain('publicKey');

    const after = await json(await hostCall(h, ''));
    expect(after.passkeys).toHaveLength(1);
    expect(after.pending).toHaveLength(0);
  });

  test('an operator may hold several passkeys; the next ceremony excludes the first', async () => {
    const first = new SoftwareAuthenticator();
    const a = await confirmedWithOptions(h);
    expect(
      (
        await verify(
          h,
          a.started.requestId,
          first.register(a.options, { origin: ORIGIN }),
          'Primary',
        )
      ).status,
    ).toBe(201);

    const b = await confirmedWithOptions(h);
    const exclusions = (
      b.options as unknown as { excludeCredentials: Array<{ id: string }> }
    ).excludeCredentials;
    expect(exclusions.map((entry) => entry.id)).toEqual([
      first.credentialIdBase64Url,
    ]);
    const second = new SoftwareAuthenticator();
    expect(
      (
        await verify(
          h,
          b.started.requestId,
          second.register(b.options, { origin: ORIGIN }),
          'Backup',
        )
      ).status,
    ).toBe(201);
    expect((await json(await hostCall(h, ''))).passkeys).toHaveLength(2);
  });

  test('one confirmation enrolls one passkey: the consumed request cannot enroll another', async () => {
    const { started, options } = await confirmedWithOptions(h);
    expect(
      (
        await verify(
          h,
          started.requestId,
          new SoftwareAuthenticator().register(options, { origin: ORIGIN }),
        )
      ).status,
    ).toBe(201);
    const again = await optionsFor(h, started.requestId);
    expect(again.res.status).toBe(409);
    expect(again.body.error).toBe('request_closed');
  });
});

async function fetchStatus(
  h: Harness,
  requestId: string,
  cookie = PHONE_COOKIE,
) {
  return h.consent.request(`${PATH}/requests/${requestId}`, {
    headers: browserHeaders(cookie),
  });
}

describe('code confirmation', () => {
  test('a wrong code confirms nothing', async () => {
    const started = await startRequest(h);
    const wrong = String((Number(started.code) + 1) % 1_000_000).padStart(
      6,
      '0',
    );
    const res = await confirm(h, wrong);
    expect(res.status).toBe(404);
    expect((await json(res)).error).toBe('invalid_code');
    expect((await json(await fetchStatus(h, started.requestId))).state).toBe(
      'pending',
    );
  });

  test('a malformed code is a failure, not a crash', async () => {
    await startRequest(h);
    for (const bad of ['', '12345', '1234567', 'abcdef', 123456]) {
      const res = await confirm(h, bad as string);
      expect(res.status).toBe(404);
    }
  });

  test('a code works once: a replay of a confirmed code is refused', async () => {
    const started = await startRequest(h);
    expect((await confirm(h, started.code)).status).toBe(200);
    expect((await confirm(h, started.code)).status).toBe(404);
  });

  test('an expired code is refused and the request reads as expired', async () => {
    const started = await startRequest(h);
    h.clock.now += ENROLLMENT_REQUEST_TTL_MS + 1;
    expect((await confirm(h, started.code)).status).toBe(404);
    expect((await fetchStatus(h, started.requestId)).status).toBe(404);
  });

  test('a confirmed request whose ceremony window lapsed cannot mint options', async () => {
    const started = await startRequest(h);
    expect((await confirm(h, started.code)).status).toBe(200);
    h.clock.now += ENROLLMENT_CEREMONY_TTL_MS + 1;
    const late = await optionsFor(h, started.requestId);
    expect(late.res.status).toBe(404);
  });

  test('wrong codes are rate limited, and the limit also locks out the right code', async () => {
    const started = await startRequest(h);
    const wrong = String((Number(started.code) + 1) % 1_000_000).padStart(
      6,
      '0',
    );
    for (let i = 0; i < ENROLLMENT_CODE_FAILURE_LIMIT; i += 1) {
      expect((await confirm(h, wrong)).status).toBe(404);
    }
    const locked = await confirm(h, started.code);
    expect(locked.status).toBe(429);
    const body = await json(locked);
    expect(body.error).toBe('rate_limited');
    expect(body.retryAfterMs).toBeGreaterThan(0);
    // The window passes; the real code works again.
    h.clock.now += ENROLLMENT_CODE_FAILURE_WINDOW_MS + 1;
    const fresh = await startRequest(h, LAPTOP_COOKIE);
    expect((await confirm(h, fresh.code)).status).toBe(200);
  });

  test('deny closes the request and its code', async () => {
    const started = await startRequest(h);
    const res = await hostCall(h, '/requests/deny', {
      method: 'POST',
      body: JSON.stringify({ code: started.code }),
    });
    expect(res.status).toBe(200);
    expect((await optionsFor(h, started.requestId)).res.status).toBe(409);
    expect((await confirm(h, started.code)).status).toBe(404);
  });

  test('the number of live requests is capped', async () => {
    const many = build();
    for (let i = 0; i < ENROLLMENT_MAX_LIVE_REQUESTS; i += 1) {
      many.service.createRequest({
        requester: {
          kind: 'paired-device',
          deviceId: 'test-device',
          pairedAt: null,
          scope: '',
        },
        credential: `c${i}`,
        deviceLabel: `d${i}`,
      });
    }
    expect(() =>
      many.service.createRequest({
        requester: {
          kind: 'paired-device',
          deviceId: 'test-device',
          pairedAt: null,
          scope: '',
        },
        credential: 'extra',
        deviceLabel: 'x',
      }),
    ).toThrowError(/Too many enrollment requests/);
    many.registry.close();
  });
});

describe('origin, RP ID and user verification', () => {
  test('a response from the wrong origin stores nothing', async () => {
    const { started, options } = await confirmedWithOptions(h);
    const res = await verify(
      h,
      started.requestId,
      new SoftwareAuthenticator().register(options, {
        origin: 'https://evil.example.ts.net',
      }),
    );
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('verification_failed');
    expect((await json(await hostCall(h, ''))).passkeys).toHaveLength(0);
  });

  test('an http or port-variant origin is not the configured origin', async () => {
    for (const origin of ['http://station.example.ts.net', `${ORIGIN}:8443`]) {
      const { started, options } = await confirmedWithOptions(h);
      const res = await verify(
        h,
        started.requestId,
        new SoftwareAuthenticator().register(options, { origin }),
      );
      expect(res.status).toBe(400);
    }
    expect((await json(await hostCall(h, ''))).passkeys).toHaveLength(0);
  });

  test('an authenticator that hashed another RP ID is refused', async () => {
    const { started, options } = await confirmedWithOptions(h);
    const res = await verify(
      h,
      started.requestId,
      new SoftwareAuthenticator().register(options, {
        origin: ORIGIN,
        rpId: 'example.ts.net',
      }),
    );
    expect(res.status).toBe(400);
    expect((await json(await hostCall(h, ''))).passkeys).toHaveLength(0);
  });

  test('user verification is required', async () => {
    const { started, options } = await confirmedWithOptions(h);
    const res = await verify(
      h,
      started.requestId,
      new SoftwareAuthenticator().register(options, {
        origin: ORIGIN,
        userVerified: false,
      }),
    );
    expect(res.status).toBe(400);
    expect((await json(await hostCall(h, ''))).passkeys).toHaveLength(0);
  });

  test('a framed (cross-origin) ceremony is refused', async () => {
    const { started, options } = await confirmedWithOptions(h);
    const res = await verify(
      h,
      started.requestId,
      new SoftwareAuthenticator().register(options, {
        origin: ORIGIN,
        crossOrigin: true,
      }),
    );
    expect(res.status).toBe(400);
  });

  test('the request itself must come from the configured origin and host', async () => {
    const cases: Array<[string, Record<string, string | undefined>]> = [
      ['wrong origin', { origin: 'https://evil.example' }],
      ['missing origin', { origin: undefined }],
      ['null origin', { origin: 'null' }],
      ['cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
      ['no fetch metadata', { 'sec-fetch-site': undefined }],
      ['wrong host', { host: 'evil.example' }],
      [
        'form content type',
        { 'content-type': 'application/x-www-form-urlencoded' },
      ],
    ];
    for (const [name, overrides] of cases) {
      const res = await post(
        h,
        `${PATH}/requests`,
        {},
        PHONE_COOKIE,
        overrides,
      );
      expect(res.status, name).toBeGreaterThanOrEqual(400);
      expect(res.status, name).toBeLessThan(500);
    }
    // None of them created a request.
    expect((await json(await hostCall(h, ''))).pending).toHaveLength(0);
  });

  test('an unpaired browser cannot request enrollment', async () => {
    const res = await post(
      h,
      `${PATH}/requests`,
      {},
      `__Host-station-device=${'X'.repeat(43)}`,
    );
    expect(res.status).toBe(401);
    expect((await post(h, `${PATH}/requests`, {}, '')).status).toBe(401);
  });
});

describe('challenge handling', () => {
  test('a challenge verifies once: a replayed response is refused', async () => {
    const { started, options } = await confirmedWithOptions(h);
    const response = new SoftwareAuthenticator().register(options, {
      origin: ORIGIN,
    });
    expect((await verify(h, started.requestId, response)).status).toBe(201);
    const replay = await verify(h, started.requestId, response);
    expect(replay.status).toBe(409);
    expect((await json(await hostCall(h, ''))).passkeys).toHaveLength(1);
  });

  test('a failed attempt burns the challenge: the correct response for it is then refused', async () => {
    const { started, options } = await confirmedWithOptions(h);
    const authenticator = new SoftwareAuthenticator();
    expect(
      (
        await verify(
          h,
          started.requestId,
          authenticator.register(options, { origin: 'https://evil.example' }),
        )
      ).status,
    ).toBe(400);
    const retry = await verify(
      h,
      started.requestId,
      authenticator.register(options, { origin: ORIGIN }),
    );
    expect(retry.status).toBe(400);
    expect((await json(retry)).error).toBe('challenge_invalid');
    expect((await json(await hostCall(h, ''))).passkeys).toHaveLength(0);
  });

  test('a response made for an earlier challenge is refused after new options', async () => {
    const { started, options } = await confirmedWithOptions(h);
    const stale = new SoftwareAuthenticator().register(options, {
      origin: ORIGIN,
    });
    const fresh = await optionsFor(h, started.requestId);
    expect(fresh.body.challenge).not.toBe(options.challenge);
    expect((await verify(h, started.requestId, stale)).status).toBe(400);
  });

  test('a response for one confirmed request is refused on another', async () => {
    const first = await confirmedWithOptions(h);
    const second = await confirmedWithOptions(h, LAPTOP_COOKIE);
    const forFirst = new SoftwareAuthenticator().register(first.options, {
      origin: ORIGIN,
    });
    const res = await verify(
      h,
      second.started.requestId,
      forFirst,
      undefined,
      LAPTOP_COOKIE,
    );
    expect(res.status).toBe(400);
  });

  test('an expired challenge is refused', async () => {
    const { started, options } = await confirmedWithOptions(h);
    h.clock.now += ENROLLMENT_CHALLENGE_TTL_MS + 1;
    const res = await verify(
      h,
      started.requestId,
      new SoftwareAuthenticator().register(options, { origin: ORIGIN }),
    );
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('challenge_invalid');
  });

  test('another browser cannot use the request id (it is bound to its browser)', async () => {
    const started = await startRequest(h);
    expect((await confirm(h, started.code)).status).toBe(200);
    const stolen = await optionsFor(h, started.requestId, LAPTOP_COOKIE);
    expect(stolen.res.status).toBe(404);
    expect(
      (await fetchStatus(h, started.requestId, LAPTOP_COOKIE)).status,
    ).toBe(404);
  });
});

describe('registry', () => {
  test('is private, holds only the public key, and survives a reopen', async () => {
    const { started, options } = await confirmedWithOptions(h);
    const authenticator = new SoftwareAuthenticator();
    expect(
      (
        await verify(
          h,
          started.requestId,
          authenticator.register(options, { origin: ORIGIN }),
          'Primary',
        )
      ).status,
    ).toBe(201);

    const file = join(h.home, OPERATOR_PASSKEY_DB_RELATIVE_PATH);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(h.home, 'authentication')).mode & 0o777).toBe(0o700);
    }
    const bytes = readFileSync(file);
    // The private key never reaches Station, so it cannot be on disk.
    expect(bytes.includes(authenticator.privateKeyDer.subarray(-32))).toBe(
      false,
    );
    // What IS stored is the public key: the authenticator's P-256 x coordinate
    // (the first half of the last 64 bytes of its SPKI) is in the row.
    const db = new DatabaseSync(file, { readOnly: true });
    const row = db
      .prepare('SELECT public_key FROM operator_passkeys')
      .get() as { public_key: Uint8Array };
    db.close();
    expect(
      Buffer.from(row.public_key).includes(
        authenticator.publicKeyDer.subarray(-64, -32),
      ),
    ).toBe(true);

    h.registry.close();
    const reopened = OperatorPasskeyRegistry.open(h.home);
    expect(reopened.listActive().map((p) => p.label)).toEqual(['Primary']);
    reopened.close();
    h.registry = OperatorPasskeyRegistry.open(h.home);
  });

  test('revoke removes a passkey from the active list and from exclusions', async () => {
    const { started, options } = await confirmedWithOptions(h);
    const authenticator = new SoftwareAuthenticator();
    const stored = await json(
      await verify(
        h,
        started.requestId,
        authenticator.register(options, { origin: ORIGIN }),
      ),
    );
    const id = stored.passkey.id as string;

    expect(
      (await hostCall(h, '/does-not-exist', { method: 'DELETE' })).status,
    ).toBe(404);
    const revoked = await hostCall(h, `/${id}`, { method: 'DELETE' });
    expect(revoked.status).toBe(200);
    expect((await json(revoked)).revokedAt).toBe(h.clock.now);
    expect((await hostCall(h, `/${id}`, { method: 'DELETE' })).status).toBe(
      404,
    );
    expect((await json(await hostCall(h, ''))).passkeys).toHaveLength(0);
    expect(h.registry.activeCredentialIds()).toEqual([]);
  });
});

describe('host routes', () => {
  test('only the operator may use them', async () => {
    const started = await startRequest(h);
    const calls: Array<[string, RequestInit]> = [
      ['', {}],
      [
        '/requests/approve',
        { method: 'POST', body: JSON.stringify({ code: started.code }) },
      ],
      [
        '/requests/deny',
        { method: 'POST', body: JSON.stringify({ code: started.code }) },
      ],
      ['/anything', { method: 'DELETE' }],
    ];
    for (const [path, init] of calls) {
      const res = await h.host.request(
        `/api/pairing/operator-passkeys${path}`,
        init,
      );
      expect(res.status, path).toBe(401);
    }
    expect((await json(await fetchStatus(h, started.requestId))).state).toBe(
      'pending',
    );
  });
});

describe('without STATION_TRUSTED_CONSENT_ORIGIN', () => {
  test('enrollment is unavailable everywhere, with a clear message', async () => {
    const off = build(null);
    try {
      const page = await off.consent.request(PATH);
      expect(page.status).toBe(503);
      expect(await page.text()).toContain('STATION_TRUSTED_CONSENT_ORIGIN');

      const created = await post(off, `${PATH}/requests`);
      expect(created.status).toBe(503);
      const body = await json(created);
      expect(body.error).toBe('enrollment_unavailable');
      expect(body.message).toContain('STATION_TRUSTED_CONSENT_ORIGIN');
      expect(body.message).toContain('IP');

      const listing = await json(await hostCall(off, ''));
      expect(listing.enrollment.available).toBe(false);
      const approve = await confirm(off, '123456');
      expect(approve.status).toBe(503);
      expect(() =>
        off.service.createRequest({
          requester: {
            kind: 'paired-device',
            deviceId: 'test-device',
            pairedAt: null,
            scope: '',
          },
          credential: 'c',
          deviceLabel: 'd',
        }),
      ).toThrowError(/STATION_TRUSTED_CONSENT_ORIGIN/);
    } finally {
      off.registry.close();
    }
  });
});

describe('the enrollment page', () => {
  test('is script-src self with no inline script, and its script is served', async () => {
    const page = await h.consent.request(PATH);
    expect(page.status).toBe(200);
    const csp = page.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("'unsafe-inline'; script");
    const html = await page.text();
    expect(html).toContain(`<script src="${PATH}.js"></script>`);
    expect(html.match(/<script(?![^>]*\bsrc=)/g)).toBeNull();
    const script = await h.consent.request(`${PATH}.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('javascript');
    expect(await script.text()).toContain('navigator.credentials.create');
  });
});

describe('what logs and metrics carry', () => {
  test('never a code, request id, challenge or credential', async () => {
    const authenticator = new SoftwareAuthenticator();
    const { started, options } = await confirmedWithOptions(h);
    await confirm(h, '000000');
    const stored = await json(
      await verify(
        h,
        started.requestId,
        authenticator.register(options, { origin: ORIGIN }),
        'Primary',
      ),
    );
    await hostCall(h, `/${stored.passkey.id}`, { method: 'DELETE' });

    const observed = JSON.stringify([h.logCalls, metricSpy.mock.calls]);
    for (const secret of [
      started.code,
      started.requestId,
      options.challenge,
      authenticator.credentialIdBase64Url,
      PHONE_COOKIE.split('=')[1] as string,
    ]) {
      expect(observed).not.toContain(secret);
    }
    // And they do record that the steps happened.
    const steps = metricSpy.mock.calls.map(
      (call) => (call[1] as { step: string }).step,
    );
    expect(steps).toEqual(
      expect.arrayContaining([
        'requested',
        'confirmed',
        'enrolled',
        'revoked',
        'refused',
      ]),
    );
  });
});

describe('approval context', () => {
  test('the host listing names the requester by id, pairing date and scopes, not just its label', async () => {
    await startRequest(h);
    await startRequest(h, LAPTOP_COOKIE);
    const listing = await json(await hostCall(h, ''));
    const byLabel = Object.fromEntries(
      listing.pending.map((entry: Record<string, any>) => [
        entry.deviceLabel,
        entry.requester,
      ]),
    );
    expect(byLabel['Phone browser']).toEqual({
      active: true,
      kind: 'paired-device',
      deviceId: 'aaaa1111',
      pairedAt: 1_790_000_000_000,
      scope: 'orchestration:read',
    });
    expect(byLabel['Laptop browser']).toMatchObject({
      deviceId: 'bbbb2222',
      scope: 'orchestration:read orchestration:operate',
    });
  });

  test('a device cannot borrow the operator browser label', async () => {
    h.service.createRequest({
      credential: 'op',
      deviceLabel: 'Station operator browser',
      requester: {
        kind: 'operator-credential',
        deviceId: 'operator',
        pairedAt: null,
        scope: '',
      },
    });
    await startRequest(h, SPOOF_COOKIE);
    const labels = (await json(await hostCall(h, ''))).pending.map(
      (entry: Record<string, any>) => entry.deviceLabel as string,
    );
    expect(labels).toContain('Station operator browser');
    const spoof = labels.find((label: string) => label.includes('BROWSER'));
    expect(spoof).toMatch(/not the operator/);
    expect(spoof).not.toBe('Station operator browser');
  });

  test('inspect shows the requester without confirming', async () => {
    const started = await startRequest(h);
    const res = await hostCall(h, '/requests/inspect', {
      method: 'POST',
      body: JSON.stringify({ code: started.code }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).requester.deviceId).toBe('aaaa1111');
    expect((await json(await fetchStatus(h, started.requestId))).state).toBe(
      'pending',
    );
  });

  test('approve --device must match the requesting device, or nothing is confirmed', async () => {
    const started = await startRequest(h);
    const approve = (device: unknown) =>
      hostCall(h, '/requests/approve', {
        method: 'POST',
        body: JSON.stringify({ code: started.code, device }),
      });
    for (const wrong of ['bbbb2222', 'cccc', 'aaa', '', 7]) {
      const res = await approve(wrong);
      expect(res.status, String(wrong)).toBe(409);
      expect((await json(res)).error).toBe('device_mismatch');
    }
    expect((await json(await fetchStatus(h, started.requestId))).state).toBe(
      'pending',
    );
    // A mismatch is not a wrong code: it does not spend the lockout budget.
    expect((await approve('AAAA1111')).status).toBe(200);
    expect((await json(await fetchStatus(h, started.requestId))).state).toBe(
      'confirmed',
    );
  });

  test('deny withdraws a confirmed request before the passkey is created', async () => {
    const started = await startRequest(h);
    expect((await confirm(h, started.code)).status).toBe(200);
    const { options } = await optionsFor(h, started.requestId).then((r) => ({
      options: r.body as { challenge: string; rp: { id: string } },
    }));
    const denied = await hostCall(h, '/requests/deny', {
      method: 'POST',
      body: JSON.stringify({ code: started.code }),
    });
    expect(denied.status).toBe(200);
    // The ceremony is closed even though a challenge was outstanding.
    const res = await verify(
      h,
      started.requestId,
      new SoftwareAuthenticator().register(options, { origin: ORIGIN }),
    );
    expect(res.status).toBe(409);
    expect((await json(await hostCall(h, ''))).passkeys).toHaveLength(0);
    // And approve cannot be replayed to revive it.
    expect((await confirm(h, started.code)).status).toBe(404);
  });
});

describe('request bodies are bounded', () => {
  test('oversized host and browser bodies are refused with 413', async () => {
    const big = JSON.stringify({ code: '1'.repeat(2_000) });
    const host = await hostCall(h, '/requests/approve', {
      method: 'POST',
      body: big,
    });
    expect(host.status).toBe(413);
    const browser = await post(h, `${PATH}/requests`, {
      pad: 'x'.repeat(40_000),
    });
    expect(browser.status).toBe(413);
    expect((await json(await hostCall(h, ''))).pending).toHaveLength(0);
  });
});

describe('the passkey database is created only when needed', () => {
  const dbFile = (home: string) =>
    join(home, OPERATOR_PASSKEY_DB_RELATIVE_PATH);

  test('a Station without the consent origin never creates it', () => {
    const home = makeTempDir('station-passkey-lazy-');
    const lazy = new LazyOperatorPasskeyRegistry(home);
    const off = new OperatorPasskeyEnrollmentService({
      registry: lazy,
      origin: null,
    });
    expect(off.availability().available).toBe(false);
    expect(off.listPasskeys()).toEqual([]);
    expect(off.listPending()).toEqual([]);
    expect(() =>
      off.createRequest({
        requester: {
          kind: 'paired-device',
          deviceId: 'test-device',
          pairedAt: null,
          scope: '',
        },
        credential: 'c',
        deviceLabel: 'd',
      }),
    ).toThrowError(/STATION_TRUSTED_CONSENT_ORIGIN/);
    expect(() => off.revokePasskey('x')).toThrowError(/No active/);
    lazy.close();
    expect(existsSync(dbFile(home))).toBe(false);
  });

  test('with the origin set it is created at the first ceremony, not at startup', async () => {
    const home = makeTempDir('station-passkey-lazy-');
    const lazy = new LazyOperatorPasskeyRegistry(home);
    const service = new OperatorPasskeyEnrollmentService({
      registry: lazy,
      origin: ORIGIN,
    });
    expect(service.listPasskeys()).toEqual([]);
    const { requestId, code } = service.createRequest({
      requester: {
        kind: 'paired-device',
        deviceId: 'test-device',
        pairedAt: null,
        scope: '',
      },
      credential: 'c',
      deviceLabel: 'd',
    });
    service.confirm(code);
    expect(existsSync(dbFile(home))).toBe(false);
    await service.beginRegistration(requestId, 'c');
    expect(existsSync(dbFile(home))).toBe(true);
    lazy.close();
  });
});

describe('review round: races and live device state', () => {
  test('a deny that lands while verification is in flight stops the enrollment', async () => {
    const { started, options } = await confirmedWithOptions(h);
    const response = new SoftwareAuthenticator().register(options, {
      origin: ORIGIN,
    });
    // finishRegistration runs synchronously up to its first await (the
    // WebAuthn verification), so the deny below lands inside that window.
    const finishing = h.service.finishRegistration(
      started.requestId,
      'P'.repeat(43),
      response as never,
      'Raced',
    );
    h.service.deny(started.code);
    await expect(finishing).rejects.toMatchObject({ code: 'request_closed' });
    expect(h.registry.listActive()).toEqual([]);
    expect((await json(await hostCall(h, ''))).passkeys).toHaveLength(0);
  });

  test('a request whose ceremony window lapses during verification stores nothing', async () => {
    const { started, options } = await confirmedWithOptions(h);
    const response = new SoftwareAuthenticator().register(options, {
      origin: ORIGIN,
    });
    const finishing = h.service.finishRegistration(
      started.requestId,
      'P'.repeat(43),
      response as never,
      undefined,
    );
    h.clock.now += ENROLLMENT_CEREMONY_TTL_MS + 1;
    await expect(finishing).rejects.toMatchObject({ code: 'request_closed' });
    expect(h.registry.listActive()).toEqual([]);
  });

  test('approve re-resolves the device: a revoked one is refused, and the current scope is shown', async () => {
    const live = { scope: 'orchestration:read' } as { scope: string } | null;
    const service = new OperatorPasskeyEnrollmentService({
      registry: h.registry,
      origin: ORIGIN,
      now: () => h.clock.now,
      resolveDevice: () => live,
    });
    const host = new Hono();
    host.route(
      '/api/pairing/operator-passkeys',
      createOperatorPasskeyHostRoutes({ service, isOperator: () => true }),
    );
    const call = (path: string, body?: unknown) =>
      host.request(`/api/pairing/operator-passkeys${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const { code } = service.createRequest({
      credential: 'c',
      deviceLabel: 'Phone',
      requester: {
        kind: 'paired-device',
        deviceId: 'aaaa1111-x',
        pairedAt: 1,
        scope: 'orchestration:read',
      },
    });
    // The device was widened after it asked: the host sees the CURRENT scope.
    live!.scope = 'orchestration:read orchestration:operate terminal:operate';
    const shown = (await json(await call(''))).pending[0].requester;
    expect(shown).toMatchObject({
      active: true,
      scope: 'orchestration:read orchestration:operate terminal:operate',
    });
    expect(
      (await json(await call('/requests/inspect', { code }))).requester.scope,
    ).toContain('terminal:operate');

    // Then it was revoked: nothing can be confirmed or even listed as live.
    const revoked = null as { scope: string } | null;
    const gone = new OperatorPasskeyEnrollmentService({
      registry: h.registry,
      origin: ORIGIN,
      now: () => h.clock.now,
      resolveDevice: () => revoked,
    });
    const created = gone.createRequest({
      credential: 'd',
      deviceLabel: 'Revoked phone',
      requester: {
        kind: 'paired-device',
        deviceId: 'bbbb2222-x',
        pairedAt: 1,
        scope: 'orchestration:read',
      },
    });
    expect(gone.listPending()[0]?.requester.active).toBe(false);
    expect(() => gone.confirm(created.code)).toThrowError(/no longer paired/);
    expect(() => gone.confirm(created.code)).toThrowError(
      expect.objectContaining({ code: 'device_gone' }),
    );
    expect(gone.listPending()).toHaveLength(1);
  });

  test('a device without an id cannot open a request (no invented id)', async () => {
    const res = await post(
      h,
      `${PATH}/requests`,
      {},
      `__Host-station-device=${'N'.repeat(43)}`,
    );
    expect(res.status).toBe(401);
    expect((await json(await hostCall(h, ''))).pending).toHaveLength(0);
  });

  test('an unreadable existing store fails the list and revoke paths as typed 503, not a raw error', async () => {
    const home = makeTempDir('station-passkey-broken-');
    // The database path is a directory: it exists, and cannot be opened privately.
    mkdirSync(join(home, OPERATOR_PASSKEY_DB_RELATIVE_PATH), {
      recursive: true,
    });
    const lazy = new LazyOperatorPasskeyRegistry(home);
    const service = new OperatorPasskeyEnrollmentService({
      registry: lazy,
      origin: ORIGIN,
    });
    const host = new Hono();
    host.route(
      '/api/pairing/operator-passkeys',
      createOperatorPasskeyHostRoutes({ service, isOperator: () => true }),
    );
    const list = await host.request('/api/pairing/operator-passkeys');
    expect(list.status).toBe(503);
    expect((await json(list)).error).toBe('store_unavailable');
    const revoke = await host.request('/api/pairing/operator-passkeys/x', {
      method: 'DELETE',
    });
    expect(revoke.status).toBe(503);
    expect((await json(revoke)).error).toBe('store_unavailable');
    lazy.close();
  });

  test('an unexpected error is logged with its cause and never reaches the client as text', async () => {
    const SECRET = 'ENOENT /Users/operator/.station/secret-path';
    class Exploding extends OperatorPasskeyEnrollmentService {
      override listPasskeys(): never {
        throw new Error(SECRET);
      }
      override createRequest(): never {
        throw new Error(SECRET);
      }
    }
    const exploding = new Exploding({ registry: h.registry, origin: ORIGIN });
    // Host side: the route rethrows, so the runtime's onError owns the log and
    // the standard sanitized 500 (asserted against the real runtime in
    // device-pairing-routes.test.ts).
    const host = new Hono();
    const seen: unknown[] = [];
    host.onError((error, c) => {
      seen.push(error);
      return c.text('handled by onError', 500);
    });
    host.route(
      '/api/pairing/operator-passkeys',
      createOperatorPasskeyHostRoutes({
        service: exploding,
        isOperator: () => true,
      }),
    );
    const hostRes = await host.request('/api/pairing/operator-passkeys');
    expect(await hostRes.text()).toBe('handled by onError');
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe(SECRET);

    // Consent side: no onError here, so the route logs and answers itself.
    const { logger, calls } = makeLogger();
    const channel = new ConsentChannelService({ trustedOrigin: ORIGIN });
    channel.markListening(4321);
    const consent = createConsentApp({
      channel,
      logger,
      credentials: {
        verifyOperatorCredential: () => false,
        identifyDevice: (c) => DEVICES[c] ?? null,
      },
      passkeys: exploding,
    });
    const res = await consent.request(`${PATH}/requests`, {
      method: 'POST',
      headers: browserHeaders(),
      body: '{}',
    });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('ENOENT');
    expect(text).not.toContain('/Users/operator');
    const body = JSON.parse(text) as Record<string, string>;
    expect(body).toMatchObject({
      error: 'internal_error',
      message: 'The request could not be completed.',
    });
    // The operator's log carries the cause and the same correlation id.
    const logged = JSON.stringify(calls);
    expect(logged).toContain('Operator passkey enrollment request failed');
    expect(logged).toContain(body.correlationId as string);
    // The cause is kept (paths are redacted by the shared sanitizer).
    expect(logged).toContain('ENOENT');
  });

  test('every typed error code answers its fixed public sentence, never the error message', async () => {
    const SENTINEL = 'SENTINEL-leak-/etc/passwd';
    let raised: EnrollmentErrorCode =
      ENROLLMENT_ERROR_CODES[0] as EnrollmentErrorCode;
    class Raising extends OperatorPasskeyEnrollmentService {
      override listPasskeys(): never {
        throw new OperatorPasskeyEnrollmentError(raised, SENTINEL);
      }
      override createRequest(): never {
        throw new OperatorPasskeyEnrollmentError(raised, SENTINEL);
      }
    }
    const raising = new Raising({ registry: h.registry, origin: ORIGIN });
    const host = new Hono();
    host.route(
      '/api/pairing/operator-passkeys',
      createOperatorPasskeyHostRoutes({
        service: raising,
        isOperator: () => true,
      }),
    );
    const channel = new ConsentChannelService({ trustedOrigin: ORIGIN });
    channel.markListening(4321);
    const consent = createConsentApp({
      channel,
      credentials: {
        verifyOperatorCredential: () => false,
        identifyDevice: (c) => DEVICES[c] ?? null,
      },
      passkeys: raising,
    });
    expect(ENROLLMENT_ERROR_CODES.length).toBeGreaterThan(10);
    for (const code of ENROLLMENT_ERROR_CODES) {
      raised = code;
      const expected = publicEnrollmentMessage(
        new OperatorPasskeyEnrollmentError(code, 'internal'),
      );
      expect(expected.length, code).toBeGreaterThan(10);
      expect(expected, code).not.toContain('SENTINEL');
      const responses = [
        await host.request('/api/pairing/operator-passkeys'),
        await consent.request(`${PATH}/requests`, {
          method: 'POST',
          headers: browserHeaders(),
          body: '{}',
        }),
      ];
      for (const res of responses) {
        const text = await res.text();
        expect(text, code).not.toContain('SENTINEL');
        const body = JSON.parse(text) as { error: string; message: string };
        expect(body.error, code).toBe(code);
        expect(body.message, code).toBe(expected);
      }
    }
  });
});

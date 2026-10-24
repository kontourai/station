import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  ACCESS_TTL,
  CODE_TTL,
  DAY,
  GRANT_TTL,
  IDLE_TTL,
  MINUTE,
  PENDING_TTL,
  type Records,
  type Supersession,
} from '../oauth-records.js';
import { pkceChallenge } from '../oauth-registration.js';
import {
  OutsideAgentGrantStore,
  type OutsideOAuthStoreOptions,
} from '../oauth-store.js';

const temp = trackTempDirs();
const stores: OutsideAgentGrantStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const issuer = 'https://station.test';
const resource = `${issuer}/mcp`;
const redirectUri = 'http://127.0.0.1:43197/callback';
const metadata = {
  application_type: 'native',
  client_name: 'Outside test client',
  redirect_uris: [redirectUri],
};
function fixture(limits?: OutsideOAuthStoreOptions['limits']) {
  const home = temp('outside-oauth-r1-');
  let now = 1_800_000_000_000;
  const validateReview = vi.fn(() => true);
  const open = (bootId = 'test-boot') => {
    const store = OutsideAgentGrantStore.open(home, {
      stationId: 'test-station',
      bootId,
      issuer,
      now: () => now,
      validateReview,
      limits,
    });
    stores.push(store);
    return store;
  };
  const store = open();
  const client = store.register(metadata);
  function prepare(
    clientId = client.id,
    supersessions: Supersession[] = [],
    expiry = now + GRANT_TTL,
    extra: {
      ticket?: string;
      redirectUri?: string;
      scopes?: string[];
      peer?: string;
    } = {},
  ) {
    const verifier = randomBytes(32).toString('base64url');
    const start = store.start({
      clientId,
      redirectUri,
      resource,
      state: randomBytes(32).toString('base64url'),
      challenge: pkceChallenge(verifier),
      ...extra,
    });
    const selection = {
      delegatingPrincipalId: 'operator',
      actor: {
        kind: 'host' as const,
        id: 'host-channel',
        authorityRevision: '1',
      },
      projectScope: { kind: 'project' as const, projectId: 'project-a' },
      accessLevel: 'read-only' as const,
      scopes: ['station-control:read'] as ['station-control:read'],
      expiresAt: expiry,
      redirectPolicyRevision: 0,
    };
    const decision = {
      decisionId: randomBytes(16).toString('hex'),
      requestId: start.request.id,
      expectedVersion: 1,
      registrationDigest: client.digest,
      selection,
      supersessions,
    };
    const intent = store.approve(decision);
    const completion = store.complete(
      start.request.id,
      start.ticket,
      start.nonce,
    );
    const exchange = {
      code: completion.code,
      clientId,
      redirectUri: start.request.redirectUri,
      resource,
      verifier,
    };
    return { ...start, intent, completion, exchange, decision };
  }
  function login(clientId = client.id, supersessions: Supersession[] = []) {
    const flow = prepare(clientId, supersessions);
    return { flow, ...store.exchange(flow.exchange) };
  }
  return {
    home,
    store,
    client,
    open,
    prepare,
    login,
    validateReview,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
function selected(
  store: OutsideAgentGrantStore,
  grant: Records['grant'],
): Supersession {
  return {
    grantId: grant.id,
    expectedVersion: grant.version,
    expectedDigest: store.grantDigest(grant),
  };
}
function rotate(
  store: OutsideAgentGrantStore,
  clientId: string,
  refreshToken: string,
) {
  return store.rotate({ clientId, resource, refreshToken });
}

describe('private R1 store boundary', () => {
  test('immutable accepted registration, private files, hash-only database/WAL/outbox and no logging', () => {
    const log = vi.spyOn(console, 'log');
    const info = vi.spyOn(console, 'info');
    const f = fixture();
    const input = {
      ...metadata,
      software_id: 'unverified-software',
      logo_uri: 'https://untrusted.test/image',
      ignored: 'not accepted',
    };
    const client = f.store.register(input);
    input.client_name = 'changed';
    client.metadata.client_name = 'also changed';
    const persisted = f.store.client(client.id)!;
    expect(persisted.metadata.client_name).toBe('Outside test client');
    expect(persisted.metadata).not.toHaveProperty('ignored');
    expect(persisted.metadata.application_type).toBe('native');
    expect(Buffer.from(client.id, 'base64url').length).toBeGreaterThanOrEqual(
      16,
    );
    const issued = f.login();
    const successor = rotate(f.store, f.client.id, issued.refreshToken);
    const dir = join(f.home, 'authentication');
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      for (const name of readdirSync(dir))
        expect(statSync(join(dir, name)).mode & 0o077).toBe(0);
    }
    const disk = Buffer.concat(
      readdirSync(dir).map((name) => readFileSync(join(dir, name))),
    );
    for (const secret of [
      issued.flow.completion.code,
      issued.flow.ticket,
      issued.flow.nonce,
      issued.flow.completion.state,
      issued.flow.exchange.verifier,
      issued.accessToken,
      issued.refreshToken,
      successor.accessToken,
      successor.refreshToken,
      issued.flow.comparisonCode,
    ]) {
      expect(
        disk.includes(Buffer.from(secret)),
        `persisted secret ${secret.slice(0, 4)}`,
      ).toBe(false);
      expect(JSON.stringify(f.store.outbox(1000))).not.toContain(secret);
    }
    expect(
      readdirSync(dir).every((name) =>
        /^outside-agent-oauth\.sqlite(?:-wal|-shm)?$/.test(name),
      ),
    ).toBe(true);
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    log.mockRestore();
    info.mockRestore();
  });

  test('registration TTL, persistent daily admission and reserved tombstones survive restart', () => {
    const f = fixture({ registrationsPerDay: 2, tombstones: 61 });
    f.store.register(metadata);
    expect(() => f.store.register(metadata)).toThrow('capacity');
    const reopened = f.open();
    expect(() => reopened.register(metadata)).toThrow('capacity');
    f.advance(DAY);
    f.store.sweep();
    expect(f.store.client(f.client.id)).toBeUndefined();
    expect(f.store.recovery(f.client.id)).toMatchObject({
      id: f.client.id,
      reason: 'expired',
    });
    expect(f.store.recovery('unknown')).toBeUndefined();
    expect(f.store.recovery(f.client.id)).not.toHaveProperty('redirectUri');
    f.store.register(metadata);
    f.advance(30 * DAY);
    expect(f.store.recovery(f.client.id)).toBeUndefined();
  });

  test('registration and pending instance caps refuse without evicting existing records', () => {
    const f = fixture({ registrations: 1, pending: 1 });
    expect(() => f.store.register(metadata)).toThrow('capacity');
    const first = f.prepare();
    expect(() =>
      f.store.start({
        clientId: f.client.id,
        redirectUri,
        resource,
        state: 'other',
        challenge: pkceChallenge('x'.repeat(43)),
      }),
    ).toThrow('capacity');
    expect(f.store.request(first.request.id)?.state).toBe('coded');
    expect(f.store.exchange(first.exchange).grant.state).toBe('active');
  });

  test('same-ticket/client/exact-redirect replacement invalidates code, nonce and intent, preserving other browsers and active grants', () => {
    const f = fixture();
    const active = f.login();
    const old = f.prepare();
    const independent = f.prepare();
    const replacement = f.prepare(f.client.id, [], f.now() + GRANT_TTL, {
      ticket: old.ticket,
    });
    expect(f.store.request(old.request.id)?.state).toBe('replaced');
    expect(() =>
      f.store.complete(old.request.id, old.ticket, old.nonce),
    ).toThrow('invalid_grant');
    expect(() => f.store.exchange(old.exchange)).toThrow('invalid_grant');
    expect(f.store.request(independent.request.id)?.state).toBe('coded');
    expect(f.store.access(active.accessToken, resource)?.id).toBe(
      active.grant.id,
    );
    expect(f.store.exchange(replacement.exchange).grant.state).toBe('active');
    expect(f.store.exchange(independent.exchange).grant.state).toBe('active');
  });

  test('per-ticket/client, per-ticket and verifiable-peer bounds preserve other pending requests', () => {
    const f = fixture();
    const start = (
      clientId: string,
      port: number,
      ticket?: string,
      peer?: string,
    ) =>
      f.store.start({
        clientId,
        redirectUri: `http://127.0.0.1:${port}/callback`,
        resource,
        state: 'state',
        challenge: pkceChallenge('x'.repeat(43)),
        ticket,
        peer,
      });
    const first = start(f.client.id, 43201);
    start(f.client.id, 43202, first.ticket);
    start(f.client.id, 43203, first.ticket);
    expect(() => start(f.client.id, 43204, first.ticket)).toThrow('capacity');
    expect(start(f.client.id, 43204).request.state).toBe('pending');
    const secondClient = f.store.register(metadata);
    start(secondClient.id, 43205, first.ticket);
    start(secondClient.id, 43206, first.ticket);
    expect(() => start(secondClient.id, 43207, first.ticket)).toThrow(
      'capacity',
    );
    for (let n = 0; n < 5; n++)
      start(f.client.id, 43300 + n, undefined, 'verified-peer');
    expect(() =>
      start(secondClient.id, 43400, undefined, 'verified-peer'),
    ).toThrow('capacity');
    expect(f.store.request(first.request.id)?.state).toBe('pending');
  });

  test('ticket absolute cap, fixed pending expiry and code TTL are independent', () => {
    const f = fixture();
    const flow = f.prepare();
    f.advance(CODE_TTL);
    expect(() => f.store.exchange(flow.exchange)).toThrow('invalid_grant');
    expect(f.store.request(flow.request.id)?.state).toBe('expired');
    f.advance(20 * MINUTE);
    expect(() =>
      f.store.start({
        clientId: f.client.id,
        redirectUri,
        resource,
        state: 'state',
        challenge: pkceChallenge('x'.repeat(43)),
        ticket: flow.ticket,
      }),
    ).toThrow('capacity');
    const fresh = f.store.start({
      clientId: f.client.id,
      redirectUri,
      resource,
      state: 'state',
      challenge: pkceChallenge('x'.repeat(43)),
    });
    f.advance(PENDING_TTL - 1);
    expect(f.store.request(fresh.request.id)?.state).toBe('pending');
    f.advance(1);
    expect(f.store.request(fresh.request.id)?.state).toBe('expired');
  });

  test('approval is immutable/idempotent, creates no grant, and completion is nonce/ticket single use', () => {
    const f = fixture();
    const flow = f.prepare();
    expect(f.store.grants()).toEqual([]);
    expect(f.store.approve(flow.decision)).toEqual(flow.intent);
    expect(() =>
      f.store.approve({
        ...flow.decision,
        selection: { ...flow.decision.selection, expiresAt: f.now() + DAY },
      }),
    ).toThrow('target_changed');
    expect(() =>
      f.store.complete(flow.request.id, flow.ticket, flow.nonce),
    ).toThrow('invalid_grant');
    expect(() =>
      f.store.complete(flow.request.id, 'wrong', flow.nonce),
    ).toThrow('invalid_grant');
    expect(f.store.outbox().filter((e) => e.kind === 'approved')).toHaveLength(
      1,
    );
  });

  test('supersession survives refresh between approval and exchange, and revokes the refreshed credentials', () => {
    const f = fixture();
    const old = f.login();
    const replacement = f.prepare(f.client.id, [selected(f.store, old.grant)]);
    f.advance(1);
    const refreshed = rotate(f.store, f.client.id, old.refreshToken);
    expect(f.store.access(refreshed.accessToken, resource)?.lastUsedAt).toBe(
      f.now(),
    );
    const activated = f.store.exchange(replacement.exchange);
    expect(f.store.access(activated.accessToken, resource)?.id).toBe(
      activated.grant.id,
    );
    expect(f.store.grants().find((g) => g.id === old.grant.id)).toMatchObject({
      state: 'revoked',
      reason: 'superseded',
      version: 2,
    });
    expect(f.store.access(refreshed.accessToken, resource)).toBeUndefined();
    expect(() => rotate(f.store, f.client.id, refreshed.refreshToken)).toThrow(
      'invalid_grant',
    );
  });

  test('activation refuses a revoked supersession target, expired code or lost live approval', () => {
    const f = fixture();
    const old = f.login();
    const stale = f.prepare(f.client.id, [selected(f.store, old.grant)]);
    f.store.revoke(old.grant.id, old.grant.version);
    expect(() => f.store.exchange(stale.exchange)).toThrow('invalid_grant');
    expect(f.store.grants()).toMatchObject([
      { id: old.grant.id, state: 'revoked' },
    ]);
    const current = f.login();
    const expired = f.prepare(f.client.id, [selected(f.store, current.grant)]);
    f.advance(CODE_TTL);
    expect(() => f.store.exchange(expired.exchange)).toThrow('invalid_grant');
    expect(f.store.access(current.accessToken, resource)?.state).toBe('active');
    const revokedAuthority = f.prepare();
    f.validateReview.mockReturnValue(false);
    expect(() => f.store.exchange(revokedAuthority.exchange)).toThrow(
      'invalid_grant',
    );
    expect(f.store.grants().filter((g) => g.state === 'active')).toHaveLength(
      1,
    );
  });

  test('cap enforcement follows selected supersessions, and a refused activation never partially supersedes', () => {
    const f = fixture({ grants: 5 });
    const existing = Array.from({ length: 5 }, () => f.login());
    const replacement = f.prepare(f.client.id, [
      selected(f.store, existing[0].grant),
    ]);
    expect(f.store.grants().filter((g) => g.state === 'active')).toHaveLength(
      5,
    );
    const activated = f.store.exchange(replacement.exchange);
    expect(
      f.store.grants().find((g) => g.id === existing[0].grant.id),
    ).toMatchObject({ state: 'revoked', reason: 'superseded', version: 2 });
    expect(f.store.grants().filter((g) => g.state === 'active')).toHaveLength(
      5,
    );
    const noSlot = f.prepare();
    expect(() => f.store.exchange(noSlot.exchange)).toThrow('invalid_grant');
    expect(
      f.store.grants().find((g) => g.id === activated.grant.id)?.state,
    ).toBe('active');
  });

  test('refresh replay ends family and grant, invalidates successor, bumps version and frees client capacity through five cycles', () => {
    const f = fixture({ grantsPerClient: 1 });
    for (let cycle = 0; cycle < 5; cycle++) {
      const issued = f.login();
      const next = rotate(f.store, f.client.id, issued.refreshToken);
      // Immediate predecessor reuse, before ever redeeming the successor.
      expect(() => rotate(f.store, f.client.id, issued.refreshToken)).toThrow(
        'invalid_grant',
      );
      expect(f.store.access(issued.accessToken, resource)).toBeUndefined();
      expect(f.store.access(next.accessToken, resource)).toBeUndefined();
      const db = new DatabaseSync(
        join(f.home, 'authentication/outside-agent-oauth.sqlite'),
      );
      try {
        const row = db
          .prepare(
            "SELECT data FROM outside_oauth_records WHERE kind='family' AND id=?",
          )
          .get(issued.grant.familyId);
        expect(JSON.parse(String(row?.data)).state).toBe('revoked');
      } finally {
        db.close();
      }

      expect(() => rotate(f.store, f.client.id, next.refreshToken)).toThrow(
        'invalid_grant',
      );
      expect(
        f.store.grants().find((g) => g.id === issued.grant.id),
      ).toMatchObject({
        state: 'revoked',
        reason: 'refresh_replay',
        version: 2,
      });
      expect(f.store.grants().filter((g) => g.state === 'active')).toHaveLength(
        0,
      );
      expect(
        f.store
          .outbox(1000)
          .filter(
            (e) => e.grantId === issued.grant.id && e.kind === 'terminal',
          ),
      ).toMatchObject([{ reason: 'refresh_replay', version: 2 }]);
    }
    expect(f.login().grant.state).toBe('active');
  });

  test('older consumed refresh and correctly bound code reuse revoke their sole family/grant', () => {
    const f = fixture();
    const issued = f.login();
    const next = rotate(f.store, f.client.id, issued.refreshToken);
    const newest = rotate(f.store, f.client.id, next.refreshToken);
    expect(() => rotate(f.store, f.client.id, issued.refreshToken)).toThrow(
      'invalid_grant',
    );
    expect(f.store.access(newest.accessToken, resource)).toBeUndefined();
    const other = f.login();
    f.advance(2 * MINUTE); // Consumed code binding survives the original code TTL.
    expect(() => f.store.exchange(other.flow.exchange)).toThrow(
      'invalid_grant',
    );
    expect(f.store.grants().find((g) => g.id === other.grant.id)).toMatchObject(
      { state: 'revoked', reason: 'code_replay', version: 2 },
    );
    expect(f.store.access(other.accessToken, resource)).toBeUndefined();
    expect(() => rotate(f.store, f.client.id, other.refreshToken)).toThrow(
      'invalid_grant',
    );
  });

  test('idle expiry ends family and grant without replay, and frees capacity on admission/allocation/sweep', () => {
    for (const admission of ['grants', 'register', 'sweep'] as const) {
      const f = fixture({ grantsPerClient: 1 });
      const issued = f.login();
      f.advance(IDLE_TTL);
      if (admission === 'register') f.store.register(metadata);
      else f.store[admission]();
      expect(
        f.store.grants().find((g) => g.id === issued.grant.id),
      ).toMatchObject({ state: 'expired', reason: 'idle', version: 2 });
      expect(() => rotate(f.store, f.client.id, issued.refreshToken)).toThrow(
        'invalid_grant',
      );
      expect(f.store.access(issued.accessToken, resource)).toBeUndefined();
      expect(f.login().grant.state).toBe('active');
      expect(
        f.store.outbox().filter((e) => e.kind === 'terminal'),
      ).toMatchObject([{ reason: 'idle' }]);
    }
  });

  test('unknown and misbound refresh/code probes cannot revoke, and verifier failures stop after five', () => {
    const f = fixture();
    const issued = f.login();
    for (const exchange of [
      { ...issued.flow.exchange, clientId: 'foreign' },
      { ...issued.flow.exchange, redirectUri: `${redirectUri}?other=1` },
      { ...issued.flow.exchange, resource: 'https://foreign.test/mcp' },
      { ...issued.flow.exchange, verifier: 'x'.repeat(43) },
      { ...issued.flow.exchange, code: 'oac_unknown' },
    ])
      expect(() => f.store.exchange(exchange)).toThrow('invalid_grant');
    for (const input of [
      { refreshToken: issued.refreshToken, clientId: 'foreign', resource },
      {
        refreshToken: issued.refreshToken,
        clientId: f.client.id,
        resource: 'https://foreign.test/mcp',
      },
      { refreshToken: 'ort_unknown', clientId: f.client.id, resource },
    ])
      expect(() => f.store.rotate(input)).toThrow('invalid_grant');
    expect(f.store.access(issued.accessToken, resource)?.state).toBe('active');
    expect(
      f.store.access(issued.accessToken, 'https://foreign.test/mcp'),
    ).toBeUndefined();
    const pending = f.prepare();
    for (let n = 0; n < 5; n++)
      expect(() =>
        f.store.exchange({ ...pending.exchange, verifier: 'x'.repeat(43) }),
      ).toThrow('invalid_grant');
    expect(() => f.store.exchange(pending.exchange)).toThrow('invalid_grant');
    expect(f.store.grants()).toHaveLength(1);
  });

  test('hourly access, absolute maximum, final-five-minute refusal leaves refresh unconsumed', () => {
    const f = fixture();
    const issued = f.login();
    expect(issued.expiresIn).toBe(3600);
    f.advance(ACCESS_TTL);
    expect(f.store.access(issued.accessToken, resource)).toBeUndefined();
    const late = f.prepare(f.client.id, [], f.now() + 6 * MINUTE);
    const short = f.store.exchange(late.exchange);
    expect(short.expiresIn).toBe(360);
    f.advance(MINUTE + 1);
    expect(() => rotate(f.store, f.client.id, short.refreshToken)).toThrow(
      'invalid_grant',
    );
    expect(f.store.access(short.accessToken, resource)?.state).toBe('active');
    expect(() => rotate(f.store, f.client.id, short.refreshToken)).toThrow(
      'invalid_grant',
    );
    expect(f.store.grants().find((g) => g.id === short.grant.id)?.version).toBe(
      1,
    );
    f.advance(5 * MINUTE);
    expect(f.store.grants().find((g) => g.id === short.grant.id)).toMatchObject(
      { state: 'expired', reason: 'absolute', version: 2 },
    );
    expect(f.store.access(short.accessToken, resource)).toBeUndefined();
  });

  test('restart preserves active credentials and replay records while pending flows require a fresh boot', () => {
    const f = fixture();
    const issued = f.login();
    const unredeemed = f.prepare();
    const reopened = f.open('next-boot');
    expect(reopened.access(issued.accessToken, resource)?.id).toBe(
      issued.grant.id,
    );
    expect(() => reopened.exchange(unredeemed.exchange)).toThrow(
      'invalid_grant',
    );
    expect(() => reopened.exchange(issued.flow.exchange)).toThrow(
      'invalid_grant',
    );
    expect(reopened.grants()[0]).toMatchObject({
      state: 'revoked',
      reason: 'code_replay',
    });
  });

  test('atomic outbox rollback cannot leave a consumed code, grant or supersession after an audit failure', () => {
    const f = fixture();
    const old = f.login();
    const flow = f.prepare(f.client.id, [selected(f.store, old.grant)]);
    const db = new DatabaseSync(
      join(f.home, 'authentication/outside-agent-oauth.sqlite'),
    );
    try {
      db.exec(
        "CREATE TRIGGER stop_audit BEFORE INSERT ON outside_oauth_records WHEN NEW.kind='event' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
      );
      expect(() => f.store.exchange(flow.exchange)).toThrow(
        'audit unavailable',
      );
      expect(f.store.access(old.accessToken, resource)?.state).toBe('active');
      expect(f.store.grants()).toHaveLength(1);
      db.exec('DROP TRIGGER stop_audit');
      const active = f.store.exchange(flow.exchange);
      expect(active.grant.state).toBe('active');
      const events = f.store.outbox(1000);
      expect(events.filter((e) => e.kind === 'activated')).toHaveLength(2);
      f.store.acknowledge(events[0].id);
      f.store.acknowledge(events[0].id);
      expect(f.store.outbox(1000).map((e) => e.id)).not.toContain(events[0].id);
      expect(
        f
          .open()
          .outbox(1000)
          .map((e) => e.id),
      ).not.toContain(events[0].id);
    } finally {
      db.close();
    }
  });

  test('private storage, instance mismatch, malformed records and closed storage fail shut', () => {
    const f = fixture();
    const issued = f.login();
    expect(() =>
      OutsideAgentGrantStore.open(f.home, {
        stationId: 'other-station',
        bootId: 'test-boot',
        issuer,
        validateReview: () => true,
      }),
    ).toThrow('instance/issuer');
    const db = new DatabaseSync(
      join(f.home, 'authentication/outside-agent-oauth.sqlite'),
    );
    try {
      db.prepare(
        "UPDATE outside_oauth_records SET data='{}' WHERE kind='grant' AND id=?",
      ).run(issued.grant.id);
      expect(() => f.store.access(issued.accessToken, resource)).toThrow();
    } finally {
      db.close();
    }
    const closed = f.open();
    closed.close();
    stores.splice(stores.indexOf(closed), 1);
    expect(() => closed.access(issued.accessToken, resource)).toThrow();
  });

  test('tombstone reservations refuse admission without evicting live recovery history', () => {
    const f = fixture({ registrationsPerDay: 2, tombstones: 61 });
    f.store.register(metadata);
    for (let day = 0; day < 29; day++) {
      f.advance(DAY);
      f.store.register(metadata);
      f.store.register(metadata);
    }
    f.advance(DAY);
    f.store.register(metadata);
    expect(() => f.store.register(metadata)).toThrow('capacity');
    expect(f.store.recovery(f.client.id)?.expiresAt).toBeGreaterThan(f.now());
  });

  test.each([
    { ...metadata, redirect_uris: ['http://127.0.0.2:43199/callback'] },
    { ...metadata, redirect_uris: ['http://127.1:43199/callback'] },
    { ...metadata, redirect_uris: ['http://localhost.attacker.test/callback'] },
    { ...metadata, redirect_uris: ['https://remote.test/callback'] },
    { ...metadata, redirect_uris: ['http://user@127.0.0.1:43199/callback'] },
    { ...metadata, redirect_uris: [`${redirectUri}#fragment`] },
    { ...metadata, redirect_uris: [`${redirectUri}%xx`] },
    { ...metadata, application_type: 'web' },
    { ...metadata, client_name: 'x'.repeat(129) },
    { ...metadata, token_endpoint_auth_method: 'client_secret_basic' },
    { ...metadata, grant_types: ['implicit'] },
    { ...metadata, unknown: 'x'.repeat(16 * 1024) },
  ])('refuses incompatible or unbounded registration %j', (input) => {
    const f = fixture();
    expect(() => f.store.register(input)).toThrow();
    expect(f.store.client(f.client.id)?.id).toBe(f.client.id);
  });

  test('literal-loopback port exception preserves path/query bytes; localhost binds its exact port', () => {
    const f = fixture();
    const native = f.store.register({
      ...metadata,
      redirect_uris: [
        'http://[::1]:43111/callback?q=one',
        'http://localhost:43112/callback',
      ],
    });
    const start = (redirect: string) =>
      f.store.start({
        clientId: native.id,
        redirectUri: redirect,
        resource,
        state: 'state',
        challenge: pkceChallenge('x'.repeat(43)),
      });
    expect(start('http://[::1]:43113/callback?q=one').request.redirectUri).toBe(
      'http://[::1]:43113/callback?q=one',
    );
    expect(start('http://localhost:43112/callback').request.state).toBe(
      'pending',
    );
    for (const redirect of [
      'http://localhost:43113/callback',
      'http://[::1]:43113/other?q=one',
      'http://[::1]:43113/callback?q=two',
      'http://[::1]:43113/%63allback?q=one',
    ])
      expect(() => start(redirect)).toThrow('invalid_request');
  });

  test('approval near pending expiry permits a full code minute but unredeemed intent never supersedes', () => {
    const f = fixture();
    const old = f.login();
    const verifier = randomBytes(32).toString('base64url');
    const start = f.store.start({
      clientId: f.client.id,
      redirectUri,
      resource,
      state: 'state',
      challenge: pkceChallenge(verifier),
    });
    f.advance(PENDING_TTL - 1);
    f.store.approve({
      decisionId: 'late-decision',
      requestId: start.request.id,
      expectedVersion: 1,
      registrationDigest: f.client.digest,
      selection: { ...old.grant.selection, expiresAt: f.now() + DAY },
      supersessions: [selected(f.store, old.grant)],
    });
    const completion = f.store.complete(
      start.request.id,
      start.ticket,
      start.nonce,
    );
    f.advance(2);
    expect(
      f.store.exchange({
        code: completion.code,
        clientId: f.client.id,
        redirectUri,
        resource,
        verifier,
      }).grant.state,
    ).toBe('active');
    const pending = f.prepare();
    f.advance(PENDING_TTL + CODE_TTL);
    expect(() => f.store.exchange(pending.exchange)).toThrow('invalid_grant');
    expect(f.store.grants().filter((g) => g.state === 'active')).toHaveLength(
      1,
    );
  });

  test('rotation persistence failure restores the current token; successful refreshes do not fill the audit outbox', () => {
    const f = fixture();
    const issued = f.login();
    const db = new DatabaseSync(
      join(f.home, 'authentication/outside-agent-oauth.sqlite'),
    );
    try {
      db.exec(
        "CREATE TRIGGER stop_audit BEFORE INSERT ON outside_oauth_records WHEN NEW.kind='refresh' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
      );
      expect(() => rotate(f.store, f.client.id, issued.refreshToken)).toThrow(
        'audit unavailable',
      );
      expect(f.store.access(issued.accessToken, resource)?.state).toBe(
        'active',
      );
      db.exec('DROP TRIGGER stop_audit');
      expect(rotate(f.store, f.client.id, issued.refreshToken).expiresIn).toBe(
        3600,
      );
      expect(f.store.outbox()).toHaveLength(4);
    } finally {
      db.close();
    }
  });

  test('revoke versions refuse stale decisions; last-live-grant retirement waits thirty days after termination', () => {
    const f = fixture();
    const issued = f.login();
    f.advance(6 * DAY);
    rotate(f.store, f.client.id, issued.refreshToken);
    expect(() => f.store.revoke(issued.grant.id, 99)).toThrow('target_changed');
    f.store.revoke(issued.grant.id, 1);
    expect(f.store.access(issued.accessToken, resource)).toBeUndefined();
    f.advance(25 * DAY);
    expect(f.store.client(f.client.id)?.id).toBe(f.client.id);
    f.advance(5 * DAY);
    expect(f.store.client(f.client.id)).toBeUndefined();
    expect(f.store.recovery(f.client.id)).toMatchObject({ reason: 'expired' });
  });

  test('owner-selected audit ceiling is 100,000, can only decrease, and exposes an operator diagnostic', () => {
    const f = fixture();
    expect(f.store.diagnostics()).toMatchObject({
      auditCapacity: 100_000,
      health: 'ok',
      admissionClosed: false,
      retainedEvents: 1,
    });
    expect(() =>
      OutsideAgentGrantStore.open(temp('outside-audit-too-large-'), {
        stationId: 'test',
        bootId: 'boot',
        issuer,
        validateReview: () => true,
        limits: { audit: 100_001 },
      }),
    ).toThrow('only be lowered');
  });

  test('audit saturation refuses new OAuth state clearly while revocation succeeds and keeps its terminal audit', () => {
    const f = fixture({ audit: 5 });
    const issued = f.login();
    f.store.register(metadata);
    expect(f.store.diagnostics()).toMatchObject({
      auditCapacity: 5,
      health: 'audit_capacity',
      admissionClosed: true,
      undeliveredEvents: 5,
    });
    expect(() => f.store.register(metadata)).toThrow('audit_capacity');
    expect(() => f.prepare()).toThrow('audit_capacity');
    expect(() => rotate(f.store, f.client.id, issued.refreshToken)).toThrow(
      'Revocation remains available',
    );
    f.store.revoke(issued.grant.id, 1);
    expect(f.store.grants()[0]).toMatchObject({
      state: 'revoked',
      reason: 'revoked',
      version: 2,
    });
    expect(f.store.access(issued.accessToken, resource)).toBeUndefined();
    expect(f.store.outbox(1000)).toHaveLength(6);
    expect(
      f.store.outbox(1000).filter((e) => e.kind === 'terminal'),
    ).toMatchObject([{ reason: 'revoked', version: 2 }]);
  });

  test.each(['refresh_replay', 'code_replay', 'idle'] as const)(
    'audit saturation still permits the %s security transition',
    (reason) => {
      const f = fixture({ audit: 5 });
      const issued = f.login();
      const successor = rotate(f.store, f.client.id, issued.refreshToken);
      f.store.register(metadata);
      if (reason === 'refresh_replay')
        expect(() => rotate(f.store, f.client.id, issued.refreshToken)).toThrow(
          'invalid_grant',
        );
      else if (reason === 'code_replay')
        expect(() => f.store.exchange(issued.flow.exchange)).toThrow(
          'invalid_grant',
        );
      else {
        f.advance(IDLE_TTL);
        f.store.sweep();
      }
      expect(f.store.grants()[0]).toMatchObject({
        state: reason === 'idle' ? 'expired' : 'revoked',
        reason,
        version: 2,
      });
      expect(f.store.access(successor.accessToken, resource)).toBeUndefined();
      expect(
        f.store.outbox(1000).filter((e) => e.kind === 'terminal'),
      ).toMatchObject([{ reason }]);
    },
  );

  test('ninety-day pruning precedes admission and never evicts undelivered events', () => {
    const f = fixture({ audit: 4 });
    f.store.retire(f.client.id, 'denied');
    const second = f.store.register(metadata);
    f.store.retire(second.id, 'revoked');
    expect(f.store.diagnostics().retainedEvents).toBe(4);
    f.advance(90 * DAY);
    expect(() => f.store.register(metadata)).toThrow('audit_capacity');
    expect(f.store.outbox()).toHaveLength(4);
    for (const event of f.store.outbox()) f.store.acknowledge(event.id);
    // Admission itself must prune, without a preceding diagnostic/sweep call.
    const admitted = f.store.register(metadata);
    expect(admitted.version).toBe(1);
    expect(f.store.diagnostics()).toMatchObject({
      health: 'ok',
      retainedEvents: 1,
    });
  });

  test('explicit retirement preserves clients still needed by pending requests or live grants', () => {
    const f = fixture();
    const issued = f.login();
    expect(() => f.store.retire(f.client.id, 'revoked')).toThrow(
      'target_changed',
    );
    const pendingClient = f.store.register(metadata);
    f.store.start({
      clientId: pendingClient.id,
      redirectUri,
      resource,
      state: 'state',
      challenge: pkceChallenge('x'.repeat(43)),
    });
    expect(() => f.store.retire(pendingClient.id, 'denied')).toThrow(
      'target_changed',
    );
    expect(f.store.access(issued.accessToken, resource)?.state).toBe('active');
  });
});

test('terminal grant records are immutable even at the storage boundary', () => {
  const f = fixture();
  const issued = f.login();
  f.store.revoke(issued.grant.id, issued.grant.version);
  const terminal = f.store.grants()[0]!;
  const db = new DatabaseSync(
    join(f.home, 'authentication', 'outside-agent-oauth.sqlite'),
  );
  try {
    expect(() =>
      db
        .prepare(
          "UPDATE outside_oauth_records SET data=? WHERE kind='grant' AND id=?",
        )
        .run(
          JSON.stringify({
            ...terminal,
            selection: {
              ...terminal.selection,
              projectScope: { kind: 'global' },
            },
          }),
          terminal.id,
        ),
    ).toThrow('terminal grant is immutable');
  } finally {
    db.close();
  }
  expect(f.store.grants()[0]).toEqual(terminal);
});

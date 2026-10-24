import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, expect, test } from 'vitest';
import { spawnSyncBounded } from '../../../../scripts/lib/bounded-capture.mjs';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { DAY } from '../oauth-records.js';
import { pkceChallenge } from '../oauth-registration.js';
import { OutsideAgentGrantStore } from '../oauth-store.js';

const temp = trackTempDirs();
const stores: OutsideAgentGrantStore[] = [];
const workers: Worker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.terminate()));
  for (const s of stores.splice(0)) s.close();
});
const issuer = 'https://station.test';
const resource = `${issuer}/mcp`;
const redirectUri = 'http://127.0.0.1:43199/callback';
const now = 1_800_000_000_000;
const modulePath = fileURLToPath(new URL('../oauth-store.ts', import.meta.url));
const workerSource = `
require('tsx/cjs');
const { parentPort, workerData } = require('node:worker_threads');
const { OutsideAgentGrantStore } = require(workerData.modulePath);
const store = OutsideAgentGrantStore.open(workerData.home, {
  ...workerData.options, now: () => workerData.now, validateReview: () => true,
});
parentPort.once('message', () => {
  try {
    const result = store[workerData.method](workerData.input);
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    parentPort.postMessage({ ok: false, code: error.code, message: error.message });
  } finally { store.close(); }
});
parentPort.postMessage({ ready: true });
`;
type Outcome =
  | {
      ok: true;
      result: {
        accessToken: string;
        refreshToken: string;
        grant?: { id: string };
      };
    }
  | { ok: false; code: string; message: string };
async function race(
  home: string,
  options: object,
  method: 'exchange' | 'rotate',
  inputs: object[],
): Promise<Outcome[]> {
  const pending = inputs.map((input) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { modulePath, home, options, now, method, input },
    });
    workers.push(worker);
    let readyResolve: () => void;
    let resultResolve: (outcome: Outcome) => void;
    let rejectReady: (error: Error) => void;
    let rejectResult: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      rejectReady = reject;
    });
    const result = new Promise<Outcome>((resolve, reject) => {
      resultResolve = resolve;
      rejectResult = reject;
    });
    worker.on('message', (message) => {
      if (message.ready) readyResolve();
      else resultResolve(message);
    });
    worker.on('error', (error) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      rejectReady(failure);
      rejectResult(failure);
    });
    worker.on('exit', (code) => {
      if (code) {
        const error = new Error(`OAuth worker exited ${code}`);
        rejectReady(error);
        rejectResult(error);
      }
    });
    return { worker, ready, result };
  });
  await Promise.all(pending.map((p) => p.ready));
  for (const p of pending) p.worker.postMessage('go');
  return Promise.all(pending.map((p) => p.result));
}
function harness(limits: { grants?: number; grantsPerClient?: number } = {}) {
  const home = temp('outside-oauth-concurrent-');
  const options = {
    stationId: 'test-station',
    bootId: 'shared-runtime-boot',
    issuer,
    limits,
  };
  const store = OutsideAgentGrantStore.open(home, {
    ...options,
    now: () => now,
    validateReview: () => true,
  });
  stores.push(store);
  const client = store.register({
    application_type: 'native',
    redirect_uris: [redirectUri],
  });
  const prepare = (clientId = client.id) => {
    const verifier = randomBytes(32).toString('base64url');
    const request = store.start({
      clientId,
      resource,
      redirectUri,
      state: 'state',
      challenge: pkceChallenge(verifier),
    });
    store.approve({
      decisionId: randomBytes(16).toString('hex'),
      requestId: request.request.id,
      expectedVersion: 1,
      registrationDigest: store.client(clientId)!.digest,
      selection: {
        actor: { kind: 'host', id: 'host', authorityRevision: '1' },
        delegatingPrincipalId: 'operator',
        projectScope: { kind: 'global' },
        accessLevel: 'read-only',
        scopes: ['station-control:read'],
        expiresAt: now + 30 * DAY,
        redirectPolicyRevision: 0,
      },
      supersessions: [],
    });
    const { code } = store.complete(
      request.request.id,
      request.ticket,
      request.nonce,
    );
    return { code, clientId, resource, redirectUri, verifier };
  };
  return { home, options, store, client, prepare };
}

test('two concurrent exchanges of one code yield exactly one winner and bound reuse revokes that issued grant', async () => {
  const f = harness();
  const input = f.prepare();
  const outcomes = await race(f.home, f.options, 'exchange', [input, input]);
  expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
  expect(outcomes.filter((o) => !o.ok)).toMatchObject([
    { code: 'invalid_grant' },
  ]);
  const winner = outcomes.find((o) => o.ok)!;
  expect(f.store.grants()).toMatchObject([
    { state: 'revoked', reason: 'code_replay', version: 2 },
  ]);
  expect(f.store.access(winner.result.accessToken, resource)).toBeUndefined();
});

test('concurrent refresh across independent connections rotates once and replay atomically ends its only grant', async () => {
  const f = harness();
  const issued = f.store.exchange(f.prepare());
  const input = {
    clientId: f.client.id,
    resource,
    refreshToken: issued.refreshToken,
  };
  const outcomes = await race(f.home, f.options, 'rotate', [input, input]);
  expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
  expect(outcomes.filter((o) => !o.ok)).toMatchObject([
    { code: 'invalid_grant' },
  ]);
  const winner = outcomes.find((o) => o.ok)!;
  expect(f.store.grants()).toMatchObject([
    { state: 'revoked', reason: 'refresh_replay', version: 2 },
  ]);
  expect(f.store.access(issued.accessToken, resource)).toBeUndefined();
  expect(f.store.access(winner.result.accessToken, resource)).toBeUndefined();
});

test.each(['client', 'instance'] as const)(
  'two approved intents racing for the last %s slot activate exactly one',
  async (cap) => {
    const f = harness(
      cap === 'client' ? { grantsPerClient: 1 } : { grants: 1 },
    );
    const first = f.prepare();
    const clientId =
      cap === 'client'
        ? f.client.id
        : f.store.register({
            application_type: 'native',
            redirect_uris: [redirectUri],
          }).id;
    const second = f.prepare(clientId);
    const outcomes = await race(f.home, f.options, 'exchange', [first, second]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok)).toMatchObject([
      { code: 'invalid_grant', message: expect.stringContaining('new review') },
    ]);
    expect(f.store.grants()).toHaveLength(1);
    expect(f.store.grants()[0].state).toBe('active');
    expect(f.store.outbox().filter((e) => e.kind === 'activated')).toHaveLength(
      1,
    );
  },
);

// The crash process receives credentials on stdin, never in argv or captured output.
const crashSource = `
require('tsx/cjs');
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const { DatabaseSync } = require('node:sqlite');
const original = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  if (sql === 'COMMIT' && input.point === 'before') process.kill(process.pid, 'SIGKILL');
  const result = original.call(this, sql);
  if (sql === 'COMMIT' && input.point === 'after') process.kill(process.pid, 'SIGKILL');
  return result;
};
const { OutsideAgentGrantStore } = require(input.modulePath);
const store = OutsideAgentGrantStore.open(input.home, {
  ...input.options, now: () => input.now, validateReview: () => true,
});
store[input.method](input.input);
throw new Error('crash landmark was not reached');
`;
function crash(
  f: ReturnType<typeof harness>,
  point: 'before' | 'after',
  method: 'exchange' | 'rotate',
  input: object,
) {
  const child = spawnSyncBounded(process.execPath, ['-e', crashSource], {
    input: JSON.stringify({
      modulePath,
      home: f.home,
      options: f.options,
      now,
      point,
      method,
      input,
    }),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 64 * 1024,
  });
  expect(child.error).toBeUndefined();
  expect(child.signal, child.stderr).toBe('SIGKILL');
  expect(child.stdout).toBe('');
}

test.each(['before', 'after'] as const)(
  'process death %s code-exchange commit preserves one activation and its atomic audit',
  (point) => {
    const f = harness();
    const input = f.prepare();
    crash(f, point, 'exchange', input);
    if (point === 'before') {
      expect(f.store.grants()).toHaveLength(0);
      expect(
        f.store.outbox().filter((e) => e.kind === 'activated'),
      ).toHaveLength(0);
      expect(f.store.exchange(input).grant.state).toBe('active');
    } else {
      expect(f.store.grants()).toMatchObject([{ state: 'active', version: 1 }]);
      expect(() => f.store.exchange(input)).toThrow('invalid_grant');
      expect(f.store.grants()).toMatchObject([
        { state: 'revoked', reason: 'code_replay', version: 2 },
      ]);
    }
    expect(f.store.grants()).toHaveLength(1);
    expect(f.store.outbox().filter((e) => e.kind === 'activated')).toHaveLength(
      1,
    );
  },
);

test.each(['before', 'after'] as const)(
  'process death %s refresh commit preserves strict rotation without a recoverable response',
  (point) => {
    const f = harness();
    const issued = f.store.exchange(f.prepare());
    const input = {
      clientId: f.client.id,
      resource,
      refreshToken: issued.refreshToken,
    };
    crash(f, point, 'rotate', input);
    if (point === 'before') {
      expect(f.store.rotate(input).expiresIn).toBe(3600);
      expect(f.store.grants()).toMatchObject([{ state: 'active', version: 1 }]);
    } else {
      expect(() => f.store.rotate(input)).toThrow('invalid_grant');
      expect(f.store.grants()).toMatchObject([
        { state: 'revoked', reason: 'refresh_replay', version: 2 },
      ]);
      expect(f.store.access(issued.accessToken, resource)).toBeUndefined();
    }
    expect(f.store.grants()).toHaveLength(1);
  },
);

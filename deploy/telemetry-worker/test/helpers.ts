import { DatabaseSync } from 'node:sqlite';
import { dailyPing } from '../../../packages/telemetry-broker/src/__tests__/lite-fixture.ts';
import {
  LiteReceiver,
  type ReceiverNamespace,
  type ReceiverStorage,
} from '../src/receiver.ts';
import worker, { type Env, type RateLimiter } from '../src/worker.ts';

export { dailyPing };

export const OPERATOR_KEY = `sto_${'o'.repeat(43)}`;
const ORIGIN = 'https://telemetry.kontourai.io';

/**
 * A Durable Object's storage over one in-memory SQLite database (node:sqlite).
 * Like `ctx.storage.sql.exec`, a statement runs at the call; the cursor only
 * hands back its rows. `transactionSync` rolls back on a throw.
 */
export function fakeStorage(db = new DatabaseSync(':memory:')) {
  let alarm: number | null = null;
  let depth = 0;
  const storage: ReceiverStorage & {
    db: DatabaseSync;
    alarmAt(): number | null;
  } = {
    db,
    sql: {
      exec: (query, ...bindings) => {
        const rows = db.prepare(query).all(...bindings) as Record<
          string,
          unknown
        >[];
        return { toArray: () => rows };
      },
      get databaseSize() {
        const [{ size }] = db
          .prepare(
            'SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()',
          )
          .all() as { size: number }[];
        return size;
      },
    },
    transactionSync(operation) {
      const name = `sp${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = operation();
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        depth--;
      }
    },
    getAlarm: async () => alarm,
    setAlarm: async (time) => {
      alarm = time;
    },
    alarmAt: () => alarm,
  };
  return storage;
}

/**
 * The real LiteReceiver over node:sqlite behind a Durable Object namespace
 * binding. `restart()` replaces the object with a fresh instance over the
 * same database, as when Cloudflare evicts it and later reconstructs it.
 */
export function fakeReceiver(vars: Partial<Env> = {}) {
  const storage = fakeStorage();
  let object = new LiteReceiver({ storage }, vars);
  const state = { requests: 0 };
  const namespace: ReceiverNamespace = {
    idFromName: (name) => name,
    get: () => ({
      fetch: async (request: Request) => {
        state.requests += 1;
        return object.fetch(request);
      },
    }),
  };
  return {
    storage,
    namespace,
    state,
    get object() {
      return object;
    },
    restart() {
      object = new LiteReceiver({ storage }, vars);
    },
    rows: (query: string, ...bindings: (string | number | null)[]) =>
      storage.db.prepare(query).all(...bindings) as Record<string, unknown>[],
  };
}

export const allow: RateLimiter = { limit: async () => ({ success: true }) };

/** A limiter that refuses after `limit` calls and records each key it saw. */
export function countingLimiter(limit = Number.POSITIVE_INFINITY) {
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success: keys.length <= limit };
    },
  };
}

export function testEnv(
  receiver: ReturnType<typeof fakeReceiver>,
  overrides: Partial<Env> = {},
): Env {
  return {
    LITE_RECEIVER: receiver.namespace,
    OPERATOR_KEY,
    LITE_PER_IP_LIMITER: allow,
    LITE_GLOBAL_LIMITER: allow,
    READ_PER_IP_LIMITER: allow,
    ...overrides,
  };
}

export function call(
  env: Env,
  path: string,
  init: RequestInit & { ip?: string; operator?: boolean | string } = {},
) {
  const headers = new Headers(init.headers);
  headers.set('cf-connecting-ip', init.ip ?? '203.0.113.7');
  if (init.operator)
    headers.set(
      'authorization',
      `Bearer ${init.operator === true ? OPERATOR_KEY : init.operator}`,
    );
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, { ...init, headers }),
    env,
  );
}

export const post = (
  env: Env,
  path: string,
  body: unknown,
  init: { ip?: string; operator?: boolean | string } = {},
) =>
  call(env, path, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

/** The Lite ingest path of the source `provision` creates. */
export const LITE_PATH = '/v1/lite/station';

/** The official source, as the Worker README provisions it. */
export async function provision(env: Env) {
  const response = await post(
    env,
    '/v1/operator/lite/sources',
    {
      id: 'station',
      publisher: 'kontour',
      channels: ['nightly', 'preview', 'stable'],
      registryIds: ['public.plugin'],
      releaseVersions: ['1.2.3'],
      versionPolicy: 'semver',
    },
    { operator: true },
  );
  if (response.status !== 201)
    throw new Error(`provisioning answered ${response.status}`);
}

export const ping = (overrides: Record<string, unknown> = {}) => ({
  ...dailyPing(),
  channel: 'nightly',
  ...overrides,
});

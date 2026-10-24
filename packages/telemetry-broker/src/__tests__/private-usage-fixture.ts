import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import type { QueryResultRow } from 'pg';
import { vi } from 'vitest';
import {
  PrivateUsageClientRejected,
  type PrivateUsageTarget,
  privateCheckpointSchema,
  privateReceiptSchema,
} from '../../../../src-server/analytics/private-usage-client.js';
import { createProductBroker } from '../app.js';
import {
  migratePrivateUsage,
  PrivateUsageRepository,
} from '../private-usage-store.js';
import type { ProductRepository } from '../store.js';

/** Real PG semantics and HTTP handlers; resource custody/TLS are deliberately controlled separately. */
export async function privateUsageFixture() {
  const db = new PGlite();
  const client = (connection: Pick<PGliteInterface, 'query' | 'exec'>) => ({
    async query<Row extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: unknown[],
    ) {
      if (text.includes(';')) {
        await connection.exec(text);
        return { rows: [], rowCount: 0 };
      }
      const r = await connection.query<Row>(text, values);
      return { rows: r.rows, rowCount: r.affectedRows ?? 0 };
    },
  });
  await db.transaction((tx) => migratePrivateUsage(client(tx)));
  const repository = new PrivateUsageRepository((operation) =>
    db.transaction(async (tx) => {
      await tx.exec('SET LOCAL search_path=pg_catalog');
      return operation(client(tx));
    }),
  );
  const operator = `sto_${'o'.repeat(43)}`;
  const product: ProductRepository = {
    privateUsage: repository,
    hasCredential: () => false,
    authenticate: vi.fn(),
    ingest: vi.fn(),
    probe: vi.fn(),
    createSource: vi.fn(),
    revokeSource: vi.fn(),
    receipt: vi.fn(),
    trends: vi.fn(),
    ready: vi.fn(),
  };
  const app = createProductBroker(product, operator);
  let operatorAllowed = true,
    dropReply = false,
    available = true;
  let beforeWrite: (() => Promise<void>) | undefined;
  let commits = 0;
  const target = (assertPerson: () => Promise<void>): PrivateUsageTarget => {
    const assertCurrent = async () => {
      await assertPerson();
      if (!available)
        throw new PrivateUsageClientRejected(503, 'private_usage_unavailable');
    };
    const call = async (
      path: string,
      key: string,
      method: 'GET' | 'POST',
      body?: unknown,
      assertSource?: () => Promise<void>,
    ) => {
      await assertCurrent();
      if (path.startsWith('/v1/private-usage/')) {
        if (!/^stai_[A-Za-z0-9_-]{43}$/.test(key))
          throw new Error(
            'Wrong credential family at private storage boundary',
          );
        if (body && JSON.stringify(body).includes('stax_'))
          throw new Error('Source bearer crossed storage boundary');
      }
      if (assertSource) await assertSource();
      const response = await app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data: unknown = await response.json();
      await assertCurrent();
      return { response, data };
    };
    const status = (n: number) => {
      if (n < 200 || n >= 300)
        throw new PrivateUsageClientRejected(
          n === 409 ? 409 : 503,
          n === 409 ? 'private_usage_conflict' : 'private_usage_unavailable',
        );
    };
    return {
      installationId: 'a'.repeat(64),
      custody: 'b'.repeat(64),
      assertCurrent,
      provision: async (credentialHash) => {
        if (!operatorAllowed)
          throw new PrivateUsageClientRejected(
            403,
            'private_usage_provision_required',
          );
        const r = await call(
          '/v1/operator/private-usage-vaults',
          operator,
          'POST',
          { credentialHash },
        );
        status(r.response.status);
        const body = r.data;
        if (
          !body ||
          typeof body !== 'object' ||
          !('receiverEpoch' in body) ||
          typeof body.receiverEpoch !== 'string'
        )
          throw new Error('Missing receiver epoch');
        return { receiverEpoch: body.receiverEpoch };
      },
      checkpoint: async (key, window) => {
        const r = await call(
          `/v1/private-usage/checkpoint?${new URLSearchParams(window)}`,
          key,
          'GET',
        );
        if (r.response.status === 401) return null;
        status(r.response.status);
        const body = r.data;
        if (
          !body ||
          typeof body !== 'object' ||
          !('receiverEpoch' in body) ||
          typeof body.receiverEpoch !== 'string' ||
          !('checkpoint' in body)
        )
          throw new Error('Invalid checkpoint');
        return {
          receiverEpoch: body.receiverEpoch,
          checkpoint:
            body.checkpoint === null
              ? null
              : privateCheckpointSchema.parse(body.checkpoint),
        };
      },
      receipt: async (key, id) => {
        const r = await call(`/v1/private-usage/commits/${id}`, key, 'GET');
        if (r.response.status === 404) return null;
        status(r.response.status);
        const body = r.data;
        if (!body || typeof body !== 'object' || !('receipt' in body))
          throw new Error('Missing receipt');
        return privateReceiptSchema.parse(body.receipt);
      },
      commit: async (key, body, assertSource) => {
        if (beforeWrite) await beforeWrite();
        const r = await call(
          '/v1/private-usage/pages',
          key,
          'POST',
          body,
          assertSource,
        );
        status(r.response.status);
        commits++;
        if (dropReply) {
          dropReply = false;
          throw new PrivateUsageClientRejected(
            503,
            'private_usage_unavailable',
          );
        }
        const result = r.data;
        if (!result || typeof result !== 'object' || !('receipt' in result))
          throw new Error('Missing commit receipt');
        return privateReceiptSchema.parse(result.receipt);
      },
    };
  };
  return {
    db,
    target,
    close: () => db.close(),
    operatorAllowed: (value: boolean) => {
      operatorAllowed = value;
    },
    dropNextReply: () => {
      dropReply = true;
    },
    available: (value: boolean) => {
      available = value;
    },
    beforeWrite: (value: (() => Promise<void>) | undefined) => {
      beforeWrite = value;
    },
    commits: () => commits,
  };
}

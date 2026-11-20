import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PUBLIC_STATION_HANDSHAKE_PATH } from '@kontourai/station-contracts/environment-security';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PeerReadinessService } from '../peer-readiness-service.js';

/**
 * A real HTTP peer answering the public handshake path. `answer` decides each
 * response; `hits` counts handshake requests and `headers` keeps what the
 * prober sent, so caching and "no credential" are observed on the wire.
 */
type Answer =
  | { status: number; body: string; contentType?: string }
  | 'hang'
  | 'destroy';
const servers: Server[] = [];
async function peer(answer: () => Answer) {
  const seen = { hits: 0, headers: [] as Record<string, unknown>[] };
  const server = createServer((request, response) => {
    if (request.url !== PUBLIC_STATION_HANDSHAKE_PATH) {
      response.writeHead(404).end();
      return;
    }
    seen.hits += 1;
    seen.headers.push({ ...request.headers });
    const next = answer();
    if (next === 'hang') return;
    if (next === 'destroy') {
      request.socket.destroy();
      return;
    }
    response
      .writeHead(next.status, {
        'Content-Type': next.contentType ?? 'application/json',
      })
      .end(next.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { apiBase: `http://127.0.0.1:${port}`, seen };
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

const handshake = (environmentId: string) => ({
  status: 200,
  body: JSON.stringify({ schemaVersion: 1, environmentId }),
});
const PROXY_UNAVAILABLE = JSON.stringify({
  ready: false,
  status: 'unavailable',
});

async function closedPort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

describe('PeerReadinessService', () => {
  test('a Station handshake for the stored identity is online, probed without any credential', async () => {
    const box = await peer(() => handshake('env-b'));
    const readiness = await new PeerReadinessService({ now: () => 50 }).probe({
      environmentId: 'env-b',
      apiBase: box.apiBase,
    });
    expect(readiness).toEqual({ status: 'online', checkedAt: 50 });
    expect(box.seen.hits).toBe(1);
    expect(box.seen.headers[0]).not.toHaveProperty('authorization');
    expect(box.seen.headers[0]).not.toHaveProperty('cookie');
  });

  test.each([503, 504])(
    'the Station UI proxy unavailable envelope (%i) is recovering',
    async (status) => {
      const box = await peer(() => ({ status, body: PROXY_UNAVAILABLE }));
      const readiness = await new PeerReadinessService().probe({
        environmentId: 'env-b',
        apiBase: box.apiBase,
      });
      expect(readiness.status).toBe('recovering');
    },
  );

  test.each([
    ['a 503 without the envelope', 503, '{"error":"busy"}'],
    ['an HTML page', 200, '<!doctype html><title>router</title>'],
    [
      'a 200 with another schema version',
      200,
      '{"schemaVersion":2,"environmentId":"env-b"}',
    ],
    ['a 401', 401, '{"error":"unauthorized"}'],
  ])('%s is unconfirmed', async (_name, status, body) => {
    const box = await peer(() => ({ status, body }));
    const readiness = await new PeerReadinessService().probe({
      environmentId: 'env-b',
      apiBase: box.apiBase,
    });
    expect(readiness.status).toBe('unconfirmed');
    expect(readiness.reason).toBeUndefined();
  });

  test('a handshake for a different environmentId is an identity mismatch', async () => {
    const box = await peer(() => handshake('env-someone-else'));
    const readiness = await new PeerReadinessService().probe({
      environmentId: 'env-b',
      apiBase: box.apiBase,
    });
    expect(readiness).toMatchObject({
      status: 'unconfirmed',
      reason: 'identity-mismatch',
    });
  });

  test('an oversized answer is not read in full and is unconfirmed', async () => {
    const box = await peer(() => ({
      status: 200,
      body: JSON.stringify({
        schemaVersion: 1,
        environmentId: 'env-b',
        pad: 'x'.repeat(64_000),
      }),
    }));
    const readiness = await new PeerReadinessService().probe({
      environmentId: 'env-b',
      apiBase: box.apiBase,
    });
    expect(readiness.status).toBe('unconfirmed');
  });

  test('a refused connection, a torn connection and a deadline are unreachable', async () => {
    const service = new PeerReadinessService({ timeoutMs: 200 });
    expect(
      (
        await service.probe({
          environmentId: 'env-b',
          apiBase: await closedPort(),
        })
      ).status,
    ).toBe('unreachable');
    const torn = await peer(() => 'destroy');
    expect(
      (await service.probe({ environmentId: 'env-c', apiBase: torn.apiBase }))
        .status,
    ).toBe('unreachable');
    const hung = await peer(() => 'hang');
    const started = Date.now();
    expect(
      (await service.probe({ environmentId: 'env-d', apiBase: hung.apiBase }))
        .status,
    ).toBe('unreachable');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('online is reused within its TTL; a failure is reused only briefly and never on the dispatch path', async () => {
    let clock = 1_000;
    let answer: Answer = handshake('env-b');
    const box = await peer(() => answer);
    const service = new PeerReadinessService({
      now: () => clock,
      onlineTtlMs: 10_000,
      failureTtlMs: 2_000,
    });
    const target = { environmentId: 'env-b', apiBase: box.apiBase };
    await service.probe(target);
    clock += 9_000;
    expect((await service.probe(target)).status).toBe('online');
    expect(box.seen.hits).toBe(1);
    // A cached online answer also satisfies the dispatch path.
    expect(
      (await service.probe(target, { revalidateFailures: true })).status,
    ).toBe('online');
    expect(box.seen.hits).toBe(1);

    clock += 2_000;
    answer = { status: 503, body: PROXY_UNAVAILABLE };
    expect((await service.probe(target)).status).toBe('recovering');
    expect(box.seen.hits).toBe(2);
    clock += 1_000;
    expect((await service.probe(target)).status).toBe('recovering');
    expect(box.seen.hits).toBe(2);
    // The dispatch path never refuses on a cached failure: it probes again.
    answer = handshake('env-b');
    expect(
      (await service.probe(target, { revalidateFailures: true })).status,
    ).toBe('online');
    expect(box.seen.hits).toBe(3);
  });

  test('snapshot answers at once from the store and refreshes stale peers in the background', async () => {
    let clock = 1_000;
    let answer: Answer = 'hang';
    const box = await peer(() => answer);
    const service = new PeerReadinessService({
      now: () => clock,
      onlineTtlMs: 10_000,
      failureTtlMs: 2_000,
    });
    const target = { environmentId: 'env-b', apiBase: box.apiBase };
    // Never probed: no answer yet, and a hanging peer does not hold the read.
    const started = Date.now();
    expect(service.snapshot([target])).toEqual([undefined]);
    expect(Date.now() - started).toBeLessThan(100);
    await vi.waitFor(() => expect(box.seen.hits).toBe(1));

    answer = handshake('env-b');
    const fresh = new PeerReadinessService({ now: () => clock });
    fresh.snapshot([target]);
    await vi.waitFor(() =>
      expect(fresh.snapshot([target])[0]?.status).toBe('online'),
    );
    const hits = box.seen.hits;
    // Within its TTL the stored answer is served without probing again.
    clock += 5_000;
    expect(fresh.snapshot([target])[0]?.status).toBe('online');
    expect(box.seen.hits).toBe(hits);
    // Past it, the stale answer is still served at once, and refreshed.
    answer = { status: 503, body: PROXY_UNAVAILABLE };
    clock += 10_000;
    expect(fresh.snapshot([target])[0]?.status).toBe('online');
    await vi.waitFor(() =>
      expect(fresh.snapshot([target])[0]?.status).toBe('recovering'),
    );
    // A peer that is no longer listed is dropped from the store.
    expect(fresh.snapshot([])).toEqual([]);
    expect(fresh.snapshot([target])).toEqual([undefined]);
  });

  test('concurrent probes of one peer share a request, and probeAll keeps order under its concurrency bound', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl: typeof fetch = async (input) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      const id = new URL(String(input)).hostname.split('.')[0]!;
      return new Response(
        JSON.stringify({ schemaVersion: 1, environmentId: id }),
        {
          status: 200,
        },
      );
    };
    const service = new PeerReadinessService({
      fetch: fetchImpl,
      concurrency: 2,
    });
    const peers = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
      environmentId: id,
      apiBase: `https://${id}.example.test`,
    }));
    const [all, again] = await Promise.all([
      service.probeAll(peers),
      service.probe(peers[0]!),
    ]);
    expect(all.map((entry) => entry.status)).toEqual(Array(5).fill('online'));
    expect(again).toBe(all[0]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

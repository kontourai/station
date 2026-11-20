/**
 * Delegation to a paired Station that is not ready fails fast with the
 * reason, before any request reaches the peer's API. Real HTTP servers on
 * loopback: "this Station" answers its own handshake, and the peer answers
 * its handshake as the Station UI proxy does while the server restarts. The
 * dispatch functions are called the way the routes call them, with a real
 * forwarder and a real readiness service.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import { environmentId } from '@kontourai/station-contracts/execution-target';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
import { PeerReadinessService } from '../../services/peers/peer-readiness-service.js';
import {
  createRemoteStationForwarder,
  PeerStationNotReadyError,
} from '../../services/remote-stations/remote-station-forwarder.js';
import {
  delegateTask,
  discoverDelegationOptions,
} from '../station-control-delegation.js';

const PEER_ENV = 'environment-restarting-peer';
const servers: Server[] = [];
let currentBase = '';
let peerBase = '';
let peerHandshake: 'recovering' | 'online' = 'recovering';
/** Every request the peer received other than its public handshake. */
const peerApiRequests: string[] = [];
const ambientApiBase = process.env.STATION_API_BASE;

function listen(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    );
  });
}

beforeAll(async () => {
  currentBase = await listen(
    createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/.well-known/station/v1') {
        response.end(JSON.stringify({ environmentId: 'env-self' }));
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    }),
  );
  peerBase = await listen(
    createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/.well-known/station/v1') {
        if (peerHandshake === 'recovering') {
          response.statusCode = 503;
          response.end(JSON.stringify({ ready: false, status: 'unavailable' }));
        } else {
          response.end(
            JSON.stringify({ schemaVersion: 1, environmentId: PEER_ENV }),
          );
        }
        return;
      }
      peerApiRequests.push(`${request.method} ${request.url}`);
      response.statusCode = 503;
      response.end('{}');
    }),
  );
  process.env.STATION_API_BASE = currentBase;
});

beforeEach(() => {
  peerHandshake = 'recovering';
  peerApiRequests.length = 0;
});

afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (ambientApiBase === undefined) delete process.env.STATION_API_BASE;
  else process.env.STATION_API_BASE = ambientApiBase;
});

function forwarder() {
  return createRemoteStationForwarder({
    ssh: {
      list: () => [],
      connect: async () => {
        throw new Error('no SSH profile');
      },
    },
    peers: {
      get: (id: string) =>
        id === PEER_ENV
          ? {
              environmentId: id,
              apiBase: peerBase,
              scope: 'orchestration:read orchestration:operate',
              credential: 'peer-readiness-credential-0123456789',
              label: 'Restarting peer',
              createdAt: 0,
              updatedAt: 0,
            }
          : null,
    },
    readiness: new PeerReadinessService(),
  });
}

describe('delegation to a paired Station that is not ready', () => {
  test('delegate_task is refused at once with the reason, and nothing reaches the peer API', async () => {
    const started = Date.now();
    const error = await delegateTask(
      {
        prompt: 'Run the checks',
        target: {
          environment: { kind: 'saved', id: environmentId(PEER_ENV) },
          agent: agentId('reviewer'),
        },
      },
      undefined,
      forwarder(),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PeerStationNotReadyError);
    expect((error as Error).message).toBe(
      "Paired Station 'Restarting peer' is not ready: Recovering · server down or restarting",
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(peerApiRequests).toEqual([]);
  });

  test('target discovery is refused the same way; once the peer is back it is reached', async () => {
    const remote = forwarder();
    await expect(
      discoverDelegationOptions({ environmentId: PEER_ENV }, remote),
    ).rejects.toThrow('is not ready: Recovering');
    expect(peerApiRequests).toEqual([]);
    peerHandshake = 'online';
    // The refusal was not cached: the peer's API is now asked (and its own
    // 503 is reported as a dispatch failure, not a readiness refusal).
    const error = await discoverDelegationOptions(
      { environmentId: PEER_ENV },
      remote,
    ).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(PeerStationNotReadyError);
    expect(peerApiRequests.length).toBeGreaterThan(0);
  });
});

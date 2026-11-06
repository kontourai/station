import { afterEach, describe, expect, test, vi } from 'vitest';
import { resetPublicStationCapabilities } from '../client/publicStationCapabilities.js';
import {
  createPrivateMemoryClient,
  PrivateMemoryRequestError,
  privateMemoryHostSupport,
} from '../private-memory.js';

/** The shape a host serves at the public handshake path; only `capabilities` varies. */
const hostHandshake = (capabilities: Record<string, boolean>) => ({
  schemaVersion: 1,
  environmentId: '00000000-0000-4000-8000-000000000000',
  authentication: { scheme: 'bearer', protocolVersion: 1 },
  transports: { http: 1, sse: 1, websocket: 1 },
  compatibility: {
    serverVersion: '0.1.11',
    protocolVersion: 3,
    minClientProtocol: 1,
    capabilities: {
      productTelemetryAcknowledgement: 2,
      remoteAuth: 1,
      devicePairing: 1,
      environmentProof: 1,
      clientProtocolHeader: 1,
    },
  },
  capabilities,
});

const ok = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: true, data }), { status });

afterEach(() => {
  vi.unstubAllGlobals();
  resetPublicStationCapabilities();
});

describe('private memory client', () => {
  test('reads the queue and posts a decision with only the decision fields', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith('/queue')
        ? ok({ items: [], recallableWithoutReview: 2 })
        : ok(
            {
              itemId: 'memory-change.x',
              outcome: 'accept',
              reviewerKind: 'human',
              promoted: true,
              reviewSeconds: null,
            },
            201,
          ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createPrivateMemoryClient({
      apiBase: 'http://station.test',
    });
    expect(await client.queue()).toEqual({
      items: [],
      recallableWithoutReview: 2,
    });
    await client.decide('memory-change.x', {
      outcome: 'accept',
      requestKey: 'k1',
    });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(
      'http://station.test/api/knowledge/memory/queue/memory-change.x/decision',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      outcome: 'accept',
      requestKey: 'k1',
    });
  });

  test('maps refusals to a failure the screen can explain', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            '{"success":false,"error":"Private memory not found."}',
            { status: 404 },
          ),
      ),
    );
    const client = createPrivateMemoryClient({
      apiBase: 'http://station.test',
    });
    await expect(client.recall('widget')).rejects.toMatchObject({
      failure: 'not-available',
      status: 404,
      message: 'Private memory not found.',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 503 })),
    );
    await expect(client.brief()).rejects.toBeInstanceOf(
      PrivateMemoryRequestError,
    );
    await expect(client.brief()).rejects.toMatchObject({
      failure: 'unavailable',
    });
  });

  test('gates on the host capability: supported, unsupported and unknown stay distinct', async () => {
    const handshake = (capabilities: Record<string, boolean>) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify(hostHandshake(capabilities)), {
              status: 200,
            }),
        ),
      );
    handshake({ privateMemoryReview: true });
    expect(await privateMemoryHostSupport('http://a.test')).toBe('supported');
    resetPublicStationCapabilities();
    handshake({ sshEnvironments: true });
    expect(await privateMemoryHostSupport('http://b.test')).toBe('unsupported');
    resetPublicStationCapabilities();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x', { status: 500 })),
    );
    expect(await privateMemoryHostSupport('http://c.test')).toBe('unknown');
  });
});

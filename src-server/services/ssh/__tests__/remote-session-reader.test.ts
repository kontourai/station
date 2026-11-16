import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts';
import { StationRequestTimeoutError } from '@kontourai/station-sdk/client';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/** The reader's own logger, so a refused oversized answer is observable. */
const readerLog = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../utils/logger.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../../utils/logger.js')>();
  return {
    ...real,
    createLogger: (options: { name: string }) =>
      options.name === 'remote-session-reader'
        ? { ...real.createLogger(options), warn: readerLog.warn }
        : real.createLogger(options),
  };
});

beforeEach(() => {
  readerLog.warn.mockClear();
});

import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import {
  listConnectedRemoteSessions,
  MAX_CONCURRENT_REMOTE_ENVIRONMENTS,
  MAX_REMOTE_MESSAGE_SEARCH_ENVIRONMENTS,
  type RemoteMessageSearchMatch,
  searchConnectedRemoteMessages,
} from '../remote-session-reader.js';

function connectedView(
  id: string,
  name: string,
  localUrl: string,
  environmentId: string | null = id,
) {
  return {
    profile: { id, name, environmentId },
    state: { phase: 'connected' as const, localUrl },
  };
}

describe('listConnectedRemoteSessions', () => {
  test('fetches sessions only from connected environments, skipping idle/disconnected/error ones without a new connect attempt', async () => {
    const service = {
      list: vi.fn(() => [
        connectedView('env-1', 'Home media', 'http://127.0.0.1:1'),
        {
          profile: { id: 'env-2', name: 'Idle box' },
          state: { phase: 'idle' },
        },
        {
          profile: { id: 'env-3', name: 'Disconnected box' },
          state: { phase: 'disconnected', reason: 'stopped' },
        },
        {
          profile: { id: 'env-4', name: 'Errored box' },
          state: { phase: 'error', reason: 'timeout', action: 'retry' },
        },
      ]),
    };
    const fetchSessions = vi.fn(async (apiBase: string) => {
      expect(apiBase).toBe('http://127.0.0.1:1');
      return [{ threadId: 'thread-1' }] as any;
    });

    const result = await listConnectedRemoteSessions(
      service as any,
      fetchSessions,
    );

    expect(fetchSessions).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      environments: [
        {
          environmentId: 'env-1',
          environmentName: 'Home media',
          // archive#1778: the reader normalizes an undecorated remote session at
          // the wire boundary, so the decoration appears here even though the
          // fetcher above returned none.
          sessions: [
            { threadId: 'thread-1', answerability: { answerable: true } },
          ],
        },
      ],
      unavailable: [],
      authenticationRequired: [],
    });
  });

  test('one unreachable/slow environment never blocks or drops another that answers (R3)', async () => {
    const service = {
      list: vi.fn(() => [
        connectedView('env-slow', 'Slow box', 'http://127.0.0.1:1'),
        connectedView('env-fast', 'Fast box', 'http://127.0.0.1:2'),
      ]),
    };
    const fetchSessions = vi.fn(async (apiBase: string) => {
      if (apiBase === 'http://127.0.0.1:1') {
        throw new Error('timed out');
      }
      return [{ threadId: 'thread-fast' }] as any;
    });

    const result = await listConnectedRemoteSessions(
      service as any,
      fetchSessions,
    );

    expect(result.environments).toEqual([
      {
        environmentId: 'env-fast',
        environmentName: 'Fast box',
        sessions: [
          { threadId: 'thread-fast', answerability: { answerable: true } },
        ],
      },
    ]);
    expect(result.unavailable).toEqual([
      { environmentId: 'env-slow', environmentName: 'Slow box' },
    ]);
  });

  test('a malformed (non-array) remote response is treated as unavailable, not thrown to the caller', async () => {
    const service = {
      list: vi.fn(() => [
        connectedView('env-1', 'Home media', 'http://127.0.0.1:1'),
      ]),
    };
    const fetchSessions = vi.fn(async () => ({ notAnArray: true }) as any);

    const result = await listConnectedRemoteSessions(
      service as any,
      fetchSessions,
    );

    expect(result.environments).toEqual([]);
    expect(result.unavailable).toEqual([
      { environmentId: 'env-1', environmentName: 'Home media' },
    ]);
  });

  test('bounds one environment session count independent of what the remote returns', async () => {
    const service = {
      list: vi.fn(() => [
        connectedView('env-1', 'Home media', 'http://127.0.0.1:1'),
      ]),
    };
    const oversized = Array.from({ length: 500 }, (_, index) => ({
      threadId: `thread-${index}`,
    }));
    const fetchSessions = vi.fn(async () => oversized as any);

    const result = await listConnectedRemoteSessions(
      service as any,
      fetchSessions,
    );

    expect(result.environments[0].sessions).toHaveLength(200);
  });

  test('no connected environments returns an empty result without invoking the fetcher', async () => {
    const service = { list: vi.fn(() => []) };
    const fetchSessions = vi.fn();

    const result = await listConnectedRemoteSessions(
      service as any,
      fetchSessions,
    );

    expect(result).toEqual({
      environments: [],
      unavailable: [],
      authenticationRequired: [],
    });
    expect(fetchSessions).not.toHaveBeenCalled();
  });

  // archive#1097: a large saved-profile list must not
  // open an unbounded number of simultaneous outbound connections from one
  // Home-view read.
  test('never runs more than MAX_CONCURRENT_REMOTE_ENVIRONMENTS fetches at once, and still resolves every environment', async () => {
    const totalEnvironments = MAX_CONCURRENT_REMOTE_ENVIRONMENTS * 2 + 3;
    const service = {
      list: vi.fn(() =>
        Array.from({ length: totalEnvironments }, (_, index) =>
          connectedView(
            `env-${index}`,
            `Box ${index}`,
            `http://127.0.0.1:${index + 1}`,
          ),
        ),
      ),
    };

    let inFlight = 0;
    let peakInFlight = 0;
    const fetchSessions = vi.fn(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      // Yield so every environment that COULD start concurrently gets the
      // chance to before any of them resolve.
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return [] as any;
    });

    const result = await listConnectedRemoteSessions(
      service as any,
      fetchSessions,
    );

    expect(fetchSessions).toHaveBeenCalledTimes(totalEnvironments);
    expect(result.environments).toHaveLength(totalEnvironments);
    expect(result.unavailable).toEqual([]);
    expect(peakInFlight).toBeLessThanOrEqual(
      MAX_CONCURRENT_REMOTE_ENVIRONMENTS,
    );
    // Not a trivial pass: the batching genuinely used more than one batch
    // (otherwise "never exceeded the cap" would be true by accident of a
    // single small batch, not because the cap was enforced).
    expect(peakInFlight).toBe(MAX_CONCURRENT_REMOTE_ENVIRONMENTS);
  });
});

describe('SSH tunnel remote-runtime authentication composition', () => {
  const validCredential = 'valid-peer-bearer';
  const tunnelUrl = 'http://127.0.0.1:45887';

  function remoteRuntime() {
    const app = new Hono();
    configureRuntimeHttp({
      app: app as never,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
        trace() {},
        fatal() {},
        child() {
          return this;
        },
        setLevel() {},
        getLevel() {
          return 'info';
        },
      } as never,
      eventBus: { emit() {} } as never,
      security: {
        verifyCredential: (credential) => credential === validCredential,
        resolveGrantedScope: (credential) =>
          credential === validCredential
            ? DEFAULT_GRANT_PAIRING_SCOPE
            : undefined,
        allowedOrigins: [],
      },
    });
    app.get('/api/orchestration/sessions/read-model', (c) =>
      c.json({ success: true, data: [{ threadId: 'through-tunnel' }] }),
    );
    return app;
  }

  function connectedService() {
    return {
      list: vi.fn(() => [
        connectedView(
          'ssh-profile-1',
          'Remote Station',
          tunnelUrl,
          'peer-environment-1',
        ),
      ]),
    };
  }

  test('presents the stored peer bearer through the connected tunnel and the remote runtime accepts it', async () => {
    const app = remoteRuntime();
    const fetchImpl = vi.fn((url: string, init?: RequestInit) =>
      app.request(url, init, {
        incoming: { socket: { remoteAddress: '100.96.12.7' } },
      } as never),
    );
    vi.stubGlobal('fetch', fetchImpl);

    const peerCredentials = {
      get: vi.fn((environmentId) =>
        environmentId === 'peer-environment-1'
          ? { credential: validCredential }
          : null,
      ),
    };
    const result = await listConnectedRemoteSessions(
      connectedService() as never,
      undefined,
      peerCredentials as never,
    );

    expect(peerCredentials.get).toHaveBeenCalledWith('peer-environment-1');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${tunnelUrl}/api/orchestration/sessions/read-model?limit=200`,
    );
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('Authorization')).toBe(
      `Bearer ${validCredential}`,
    );
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
    expect(result).toEqual({
      environments: [
        {
          environmentId: 'ssh-profile-1',
          environmentName: 'Remote Station',
          sessions: [
            {
              threadId: 'through-tunnel',
              answerability: { answerable: true },
            },
          ],
        },
      ],
      unavailable: [],
      authenticationRequired: [],
    });
  });

  test('reports a missing stored bearer as actionable authentication-required instead of unavailable', async () => {
    const fetchSessions = vi.fn();
    const result = await listConnectedRemoteSessions(
      connectedService() as never,
      fetchSessions,
      { get: vi.fn(() => null) } as never,
    );

    expect(fetchSessions).not.toHaveBeenCalled();
    expect(result).toEqual({
      environments: [],
      unavailable: [],
      authenticationRequired: [
        {
          environmentId: 'ssh-profile-1',
          environmentName: 'Remote Station',
          action: 'provision_peer_credential',
        },
      ],
    });
  });

  test('reports a rejected stored bearer as actionable authentication-required instead of unavailable', async () => {
    const app = remoteRuntime();
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
      app.request(url, init, {
        incoming: { socket: { remoteAddress: '100.96.12.7' } },
      } as never),
    );

    const result = await listConnectedRemoteSessions(
      connectedService() as never,
      undefined,
      { get: () => ({ credential: 'rejected-peer-bearer' }) } as never,
    );

    expect(result).toEqual({
      environments: [],
      unavailable: [],
      authenticationRequired: [
        {
          environmentId: 'ssh-profile-1',
          environmentName: 'Remote Station',
          action: 'provision_peer_credential',
        },
      ],
    });
  });
});

describe('federated message search', () => {
  const peerCredentials = {
    get: vi.fn(() => ({ credential: 'valid-peer-bearer' })),
  };

  test('finds a phrase on a second connected Station through its peer bearer', async () => {
    const fetchMessages = vi.fn(async (_apiBase, _query, options) => {
      expect(options).toMatchObject({
        headers: { Authorization: 'Bearer valid-peer-bearer' },
      });
      return [
        {
          conversationId: 'remote-thread',
          messageId: 'remote-message',
          role: 'assistant' as const,
          excerpt: 'cobalt albatross from the second Station',
          agentSlug: 'claude',
        },
      ];
    });
    const result = await searchConnectedRemoteMessages(
      {
        list: vi.fn(() => [
          connectedView(
            'env-remote',
            'Second Station',
            'http://127.0.0.1:2',
            'peer-remote',
          ),
        ]),
      } as never,
      'cobalt albatross',
      undefined,
      fetchMessages,
      peerCredentials as never,
    );

    expect(result).toEqual({
      matches: [
        expect.objectContaining({
          conversationId: 'remote-thread',
          sourceInstanceId: 'env-remote',
          sourceInstanceName: 'Second Station',
        }),
      ],
      instances: [
        {
          instanceId: 'env-remote',
          instanceName: 'Second Station',
          status: 'available',
        },
      ],
      deferredInstanceCount: 0,
    });
    expect(fetchMessages).toHaveBeenCalledTimes(1);
  });

  test('reports a refused remote distinctly from an empty remote', async () => {
    const refused = new Error('connect ECONNREFUSED');
    Object.assign(refused, { cause: { code: 'ECONNREFUSED' } });
    const result = await searchConnectedRemoteMessages(
      {
        list: vi.fn(() => [
          connectedView(
            'env-refused',
            'Refused Station',
            'http://127.0.0.1:3',
            'peer-refused',
          ),
        ]),
      } as never,
      'cobalt',
      undefined,
      async () => {
        throw refused;
      },
      peerCredentials as never,
    );

    expect(result).toEqual({
      matches: [],
      instances: [
        {
          instanceId: 'env-refused',
          instanceName: 'Refused Station',
          status: 'refused',
        },
      ],
      deferredInstanceCount: 0,
    });
  });

  // #2708: an envelope `code` now rides on the SDK error. A peer that ANSWERS
  // with `code: 'ECONNREFUSED'` answered, so it is not a refused connection.
  test('a peer answer labelled ECONNREFUSED is not a refused connection', async () => {
    const { searchConversationMessages } = await import(
      '@kontourai/station-sdk/client'
    );
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            code: 'ECONNREFUSED',
            error: 'labelled refusal',
          }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await searchConnectedRemoteMessages(
        {
          list: vi.fn(() => [
            connectedView(
              'env-labelled',
              'Labelled Station',
              'http://127.0.0.1:7',
              'peer-labelled',
            ),
          ]),
        } as never,
        'cobalt',
        undefined,
        (apiBase, query, options) =>
          searchConversationMessages(apiBase, query, options),
        peerCredentials as never,
      );

      expect(fetchMock).toHaveBeenCalled();
      expect(result.instances).toEqual([
        {
          instanceId: 'env-labelled',
          instanceName: 'Labelled Station',
          status: 'unreachable',
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('reports a timed-out remote distinctly from a refused remote', async () => {
    const result = await searchConnectedRemoteMessages(
      {
        list: vi.fn(() => [
          connectedView(
            'env-timeout',
            'Slow Station',
            'http://127.0.0.1:5',
            'peer-timeout',
          ),
        ]),
      } as never,
      'cobalt',
      undefined,
      async () => {
        throw new StationRequestTimeoutError('http://127.0.0.1:5', 2_000);
      },
      peerCredentials as never,
    );

    expect(result.instances).toEqual([
      {
        instanceId: 'env-timeout',
        instanceName: 'Slow Station',
        status: 'timed_out',
      },
    ]);
  });

  test('uses the peer bearer through the runtime authentication boundary before the remote route reads excerpts', async () => {
    const remoteReader = {
      searchSessionMessages: vi.fn(
        (_query: string, authority: { userId: string }) =>
          authority.userId === 'remote-owner'
            ? [
                {
                  conversationId: 'private-remote-thread',
                  messageId: 'private-remote-message',
                  role: 'assistant' as const,
                  excerpt: 'remote-only cobalt albatross',
                  agentSlug: 'claude',
                },
              ]
            : [],
      ),
      readSessionConversation: vi.fn(),
      listConversationHistoryPage: vi.fn(),
    };
    const { createGlobalConversationRoutes } = await import(
      '../../../routes/chat/conversations.js'
    );
    const remote = new Hono();
    const verifyCredential = vi.fn(
      (candidate: string) => candidate === 'valid-peer-bearer',
    );
    configureRuntimeHttp({
      app: remote as never,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
        trace() {},
        fatal() {},
        child() {
          return this;
        },
        setLevel() {},
        getLevel() {
          return 'info' as const;
        },
      } as never,
      eventBus: { emit: vi.fn() } as never,
      security: {
        verifyCredential,
        resolveGrantedScope: () => DEFAULT_GRANT_PAIRING_SCOPE,
        allowedOrigins: [],
        audit: vi.fn(),
      },
    } as never);
    remote.route(
      '/api/conversations',
      createGlobalConversationRoutes(
        new Map(),
        { getConversation: () => null },
        {
          info() {},
          warn() {},
          error() {},
          debug() {},
          trace() {},
          fatal() {},
          child() {
            return this;
          },
          setLevel() {},
          getLevel() {
            return 'info' as const;
          },
        } as never,
        undefined,
        remoteReader as never,
        () => 'remote-owner',
      ),
    );

    const rejected = await remote.request(
      '/api/conversations/search?query=cobalt%20albatross',
    );
    expect(rejected.status).toBe(401);
    expect(remoteReader.searchSessionMessages).not.toHaveBeenCalled();

    const result = await searchConnectedRemoteMessages(
      {
        list: vi.fn(() => [
          connectedView(
            'env-private',
            'Private Station',
            'http://127.0.0.1:4',
            'peer-private',
          ),
        ]),
      } as never,
      'cobalt albatross',
      undefined,
      async (_apiBase, query, options) => {
        const response = await remote.request(
          `/api/conversations/search?query=${encodeURIComponent(query)}`,
          { headers: options?.headers },
        );
        expect(response.status).toBe(200);
        return (
          (await response.json()) as {
            data: RemoteMessageSearchMatch[];
          }
        ).data;
      },
      peerCredentials as never,
    );

    expect(remoteReader.searchSessionMessages).toHaveBeenCalledWith(
      'cobalt albatross',
      expect.objectContaining({ userId: 'remote-owner' }),
      20,
    );
    expect(result).toEqual({
      matches: [
        expect.objectContaining({
          conversationId: 'private-remote-thread',
          sourceInstanceId: 'env-private',
          sourceInstanceName: 'Private Station',
        }),
      ],
      instances: [
        {
          instanceId: 'env-private',
          instanceName: 'Private Station',
          status: 'available',
        },
      ],
      deferredInstanceCount: 0,
    });
    expect(verifyCredential).toHaveBeenCalledWith(
      'valid-peer-bearer',
      expect.objectContaining({ path: '/api/conversations/search' }),
    );
  });

  test('caps active peer requests and propagates a superseding query cancellation', async () => {
    const environments = Array.from(
      { length: MAX_CONCURRENT_REMOTE_ENVIRONMENTS * 2 + 1 },
      (_, index) =>
        connectedView(
          `env-${index}`,
          `Station ${index}`,
          `http://127.0.0.1:${index + 1}`,
          `peer-${index}`,
        ),
    );
    let inFlight = 0;
    let peakInFlight = 0;
    const fetchMessages = vi.fn(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return [];
    });
    const result = await searchConnectedRemoteMessages(
      { list: vi.fn(() => environments) } as never,
      'cobalt',
      undefined,
      fetchMessages,
      peerCredentials as never,
    );
    expect(result.instances).toHaveLength(
      MAX_REMOTE_MESSAGE_SEARCH_ENVIRONMENTS,
    );
    expect(peakInFlight).toBe(MAX_CONCURRENT_REMOTE_ENVIRONMENTS);
    expect(fetchMessages).toHaveBeenCalledTimes(
      MAX_REMOTE_MESSAGE_SEARCH_ENVIRONMENTS,
    );
    expect(result.deferredInstanceCount).toBe(
      environments.length - MAX_REMOTE_MESSAGE_SEARCH_ENVIRONMENTS,
    );

    const controller = new AbortController();
    const slow = searchConnectedRemoteMessages(
      { list: vi.fn(() => [environments[0]]) } as never,
      'cobalt',
      controller.signal,
      (_apiBase, _query, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
      peerCredentials as never,
    );
    controller.abort();
    await expect(slow).rejects.toMatchObject({ name: 'AbortError' });
  });
});

/**
 * archive#1778 — THE WIRE BOUNDARY THE COMPILER
 * CANNOT SEE.
 *
 * `answerability` is a REQUIRED member of `OrchestrationSessionSummary`, and
 * the required-member design is only enforcement where the compiler watched
 * the value being built. Here it did not:
 * `listOrchestrationSessions<OrchestrationSessionSummary[]>` is a type
 * ASSERTION over HTTP, so a remote Station older than ADR 0012 sends no
 * decoration and TypeScript still types it as present — a required field that
 * is `undefined` at runtime, in the one place a cross-version peer exists.
 */
describe('remote answerability normalization (station#1778)', () => {
  const env = [connectedView('env-1', 'Remote', 'http://127.0.0.1:1')];

  test('an undecorated remote session is normalized rather than typed-as-present', async () => {
    const result = await listConnectedRemoteSessions(
      { list: vi.fn(() => env) } as any,
      async () => [{ threadId: 'thread-old-peer' }] as any,
    );

    // NOT `toBeDefined()`: the value matters. This process cannot observe a
    // remote's adapter registry, so it has no standing to claim
    // `unanswerable` about a remote session — and the absence of a claim is
    // not a claim.
    expect(result.environments[0].sessions[0].answerability).toEqual({
      answerable: true,
    });
  });

  test('a decorated remote session keeps its OWN observer, untouched', async () => {
    // The whole point of carrying `observedBy` on the wire: the remote's
    // answer is the remote's, and overwriting it here would replace a real
    // observation with a local guess.
    const remote = {
      answerable: false,
      qualification: 'provider_absent',
      observedBy: 'remote-station#99',
      observedAt: '2026-08-03T12:04:03.000Z',
    };
    const result = await listConnectedRemoteSessions(
      { list: vi.fn(() => env) } as any,
      async () =>
        [{ threadId: 'thread-new-peer', answerability: remote }] as any,
    );

    expect(result.environments[0].sessions[0].answerability).toEqual(remote);
  });
});

describe('readConnectedRemoteSessionHistory through the real SDK fetcher', () => {
  test("reads the remote Station's bounded window over the tunnel origin with the peer bearer", async () => {
    const { createServer } = await import('node:http');
    const { readConnectedRemoteSessionHistory } = await import(
      '../remote-session-reader.js'
    );
    const thread = 'external:codex:0123456789abcdef0123456789abcdef';
    const seen: { url?: string; authorization?: string } = {};
    const server = createServer((request, response) => {
      seen.url = request.url;
      seen.authorization = request.headers.authorization;
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          success: true,
          data: {
            protocolVersion: 1,
            session: { threadId: thread, controlMode: 'read-only-attached' },
            events: [{ sequence: 3, event: { eventId: 'evt-3' } }],
            hasMore: false,
            watermark: 3,
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address() as { port: number };
      const page = await readConnectedRemoteSessionHistory(
        {
          list: () =>
            [
              connectedView(
                'env-1',
                'Home media',
                `http://127.0.0.1:${address.port}`,
                'peer-env',
              ),
            ] as any,
        },
        'env-1',
        thread,
        { turnLimit: 50 },
        undefined,
        { get: () => ({ credential: 'peer-bearer-for-test' }) as any },
      );
      expect(seen.authorization).toBe('Bearer peer-bearer-for-test');
      const url = new URL(seen.url!, 'http://x');
      expect(url.pathname).toBe(
        `/api/orchestration/sessions/${encodeURIComponent(thread)}`,
      );
      expect(url.searchParams.get('view')).toBe('window-v1');
      // The relay clamps to the remote route's own turn bound.
      expect(url.searchParams.get('turnLimit')).toBe('20');
      expect(page.environmentName).toBe('Home media');
      expect(page.window.events).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('the relayed history page has a byte ceiling (security review M2)', () => {
  const thread = 'external:claude:0123456789abcdef0123456789abcdef';

  /** A valid envelope padded to exactly `bytes` UTF-8 bytes. */
  function envelopeOf(bytes: number): string {
    const build = (pad: string) =>
      JSON.stringify({
        success: true,
        data: {
          protocolVersion: 1,
          session: { threadId: thread, pad },
          events: [],
          hasMore: false,
          watermark: 0,
        },
      });
    const body = build('x'.repeat(bytes - build('').length));
    expect(Buffer.byteLength(body)).toBe(bytes);
    return body;
  }

  async function readServing(body: string) {
    const { createServer } = await import('node:http');
    const { readConnectedRemoteSessionHistory } = await import(
      '../remote-session-reader.js'
    );
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(body);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const { port } = server.address() as { port: number };
      return await readConnectedRemoteSessionHistory(
        {
          list: () =>
            [
              connectedView(
                'env-1',
                'Home media',
                `http://127.0.0.1:${port}`,
                'peer-env',
              ),
            ] as any,
        },
        'env-1',
        thread,
        { turnLimit: 10 },
        undefined,
        { get: () => ({ credential: 'peer-bearer-for-test' }) as any },
      ).then(
        (page) => ({ ok: true as const, page }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  test('a page of exactly the ceiling is relayed; one byte more is refused as too_large', async () => {
    const {
      MAX_REMOTE_SESSION_HISTORY_RESPONSE_BYTES,
      RemoteSessionHistoryError,
    } = await import('../remote-session-reader.js');
    // Pinned beside the constant so a change to both still reds.
    expect(MAX_REMOTE_SESSION_HISTORY_RESPONSE_BYTES).toBe(262_144);

    const atCeiling = await readServing(
      envelopeOf(MAX_REMOTE_SESSION_HISTORY_RESPONSE_BYTES),
    );
    expect(atCeiling.ok).toBe(true);
    // An answer at the ceiling is not a refusal, so nothing is logged.
    expect(readerLog.warn).not.toHaveBeenCalled();

    const over = await readServing(
      envelopeOf(MAX_REMOTE_SESSION_HISTORY_RESPONSE_BYTES + 1),
    );
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.error).toBeInstanceOf(
      RemoteSessionHistoryError,
    );
    expect(
      over.ok === false && (over.error as { reason?: string }).reason,
    ).toBe('too_large');
    // Logged once, by environment id alone (no name, address or content).
    expect(readerLog.warn).toHaveBeenCalledTimes(1);
    expect(readerLog.warn).toHaveBeenCalledWith(
      'Remote Station answer exceeded its byte ceiling',
      { environmentId: 'env-1', read: 'session-history' },
    );
  });
});

describe('the list and search fetchers have byte ceilings too (delta review)', () => {
  /** A valid envelope whose `data` is `build(pad)`, padded to exactly `bytes`. */
  function envelopeOf(bytes: number, build: (pad: string) => unknown): string {
    const text = (pad: string) =>
      JSON.stringify({ success: true, data: build(pad) });
    const body = text('x'.repeat(bytes - text('').length));
    expect(Buffer.byteLength(body)).toBe(bytes);
    return body;
  }

  async function serving<T>(
    body: string,
    run: (service: { list: () => never }) => Promise<T>,
  ): Promise<T> {
    const { createServer } = await import('node:http');
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(body);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const { port } = server.address() as { port: number };
      return await run({
        list: () =>
          [
            connectedView(
              'env-1',
              'Home media',
              `http://127.0.0.1:${port}`,
              'peer-env',
            ),
          ] as never,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  const peers = { get: () => ({ credential: 'peer-bearer-for-test' }) as any };

  test('a session list of exactly its ceiling is listed; one byte more is unavailable', async () => {
    const { MAX_REMOTE_SESSION_LIST_RESPONSE_BYTES } = await import(
      '../remote-session-reader.js'
    );
    // Sized from measured summaries (132 real attached sessions: p50 4,128,
    // p90 6,502, max 30,840 bytes): 200 at the observed maximum, or about
    // 2,000 typical ones from an older remote that ignores `limit`.
    expect(MAX_REMOTE_SESSION_LIST_RESPONSE_BYTES).toBe(8_388_608);
    const list = (pad: string) => [{ threadId: 'thread-1', pad }];
    const atCeiling = await serving(
      envelopeOf(MAX_REMOTE_SESSION_LIST_RESPONSE_BYTES, list),
      (service) => listConnectedRemoteSessions(service, undefined, peers),
    );
    expect(atCeiling.environments).toHaveLength(1);
    // An answer at the ceiling is not a refusal, so nothing is logged.
    expect(readerLog.warn).not.toHaveBeenCalled();
    const over = await serving(
      envelopeOf(MAX_REMOTE_SESSION_LIST_RESPONSE_BYTES + 1, list),
      (service) => listConnectedRemoteSessions(service, undefined, peers),
    );
    expect(over.environments).toEqual([]);
    expect(over.unavailable).toEqual([
      { environmentId: 'env-1', environmentName: 'Home media' },
    ]);
    // Logged, by environment id alone (no name, address or content).
    expect(readerLog.warn).toHaveBeenCalledWith(
      'Remote Station answer exceeded its byte ceiling',
      { environmentId: 'env-1', read: 'session-list' },
    );
  });

  test('a search answer of exactly its ceiling is used; one byte more relays nothing', async () => {
    const { MAX_REMOTE_MESSAGE_SEARCH_RESPONSE_BYTES } = await import(
      '../remote-session-reader.js'
    );
    expect(MAX_REMOTE_MESSAGE_SEARCH_RESPONSE_BYTES).toBe(262_144);
    const matches = (pad: string) => [
      {
        conversationId: 'remote-conversation',
        messageId: 'remote-message',
        role: 'assistant',
        excerpt: pad,
      },
    ];
    const atCeiling = await serving(
      envelopeOf(MAX_REMOTE_MESSAGE_SEARCH_RESPONSE_BYTES, matches),
      (service) =>
        searchConnectedRemoteMessages(
          service,
          'cobalt',
          undefined,
          undefined,
          peers,
        ),
    );
    expect(atCeiling.matches).toHaveLength(1);
    // An answer at the ceiling is not a refusal, so nothing is logged.
    expect(readerLog.warn).not.toHaveBeenCalled();
    const over = await serving(
      envelopeOf(MAX_REMOTE_MESSAGE_SEARCH_RESPONSE_BYTES + 1, matches),
      (service) =>
        searchConnectedRemoteMessages(
          service,
          'cobalt',
          undefined,
          undefined,
          peers,
        ),
    );
    expect(over.matches).toEqual([]);
    expect(over.instances).toEqual([
      expect.objectContaining({ instanceId: 'env-1', status: 'unreachable' }),
    ]);
    expect(readerLog.warn).toHaveBeenCalledWith(
      'Remote Station answer exceeded its byte ceiling',
      { environmentId: 'env-1', read: 'message-search' },
    );
  });
});

describe('a legacy remote without the bounded window is classified structurally', () => {
  test('a remote answering detail without window-v1 is invalid_response, by error type', async () => {
    const { readConnectedRemoteSessionHistory, RemoteSessionHistoryError } =
      await import('../remote-session-reader.js');
    const { SessionDetailWindowUnsupportedError } = await import(
      '@kontourai/station-sdk/client'
    );
    const read = (error: Error) =>
      readConnectedRemoteSessionHistory(
        {
          list: () =>
            [
              connectedView('env-1', 'Box', 'http://127.0.0.1:1', 'peer'),
            ] as any,
        },
        'env-1',
        'external:claude:abc',
        { turnLimit: 10 },
        async () => {
          throw error;
        },
        { get: () => ({ credential: 'peer-bearer-for-test' }) as any },
      ).catch((caught: unknown) => caught);
    const typed = await read(new SessionDetailWindowUnsupportedError());
    expect(typed).toBeInstanceOf(RemoteSessionHistoryError);
    expect((typed as { reason: string }).reason).toBe('invalid_response');
    // The same words on an unrelated error are not that answer.
    const lookalike = await read(
      new Error('Station does not support bounded session detail'),
    );
    expect((lookalike as { reason: string }).reason).toBe('unreachable');
  });
});

describe('the remote session list asks for at most 200 and keeps the newest (delta review)', () => {
  async function servingList(count: number) {
    const { createServer } = await import('node:http');
    const seen: string[] = [];
    const server = createServer((request, response) => {
      seen.push(request.url ?? '');
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          success: true,
          // An older remote ignores `limit`: oldest first, all of them.
          data: Array.from({ length: count }, (_, index) => ({
            threadId: `thread-${index}`,
          })),
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as { port: number };
    try {
      const result = await listConnectedRemoteSessions(
        {
          list: () =>
            [
              connectedView(
                'env-1',
                'Home media',
                `http://127.0.0.1:${port}`,
                'peer-env',
              ),
            ] as never,
        },
        undefined,
        { get: () => ({ credential: 'peer-bearer-for-test' }) as any },
      );
      return { result, seen };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  test('asks the remote for its newest 200, and keeps the newest 200 when an older remote sends more', async () => {
    const { result, seen } = await servingList(250);
    expect(new URL(seen[0]!, 'http://x').searchParams.get('limit')).toBe('200');
    const ids = result.environments[0]!.sessions.map((s) => s.threadId);
    expect(ids).toHaveLength(200);
    expect(ids[0]).toBe('thread-50');
    expect(ids.at(-1)).toBe('thread-249');
  });
});

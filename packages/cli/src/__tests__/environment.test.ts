import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildStationProofMessage,
  PUBLIC_STATION_PROOF_PATH,
  STATION_PROOF_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type EnvironmentSecurityServiceFactory,
  type EnvironmentSecurityServiceLike,
  type EnvironmentSecuritySnapshot,
  runEnvironmentCommand,
} from '../commands/environment.js';
import { DEFAULT_SERVER_PORT } from '../commands/helpers.js';
import { upsertProfile } from '../commands/profile-store.js';

/**
 * Pre-existing at HEAD (c4229f43f), unrelated to station#4515: the loopback
 * fallback's default port moved from a flat 3141 to per-channel ports (this
 * process's `DEFAULT_SERVER_PORT` resolves to the STABLE channel's 18141)
 * without these four hardcoded literals being updated, so they were already
 * red before this change. Fixed forward here rather than left red, since the
 * new profile-addressed tests below share this file and its default-port
 * fallback.
 */
const DEFAULT_LOOPBACK_API_BASE = `http://127.0.0.1:${DEFAULT_SERVER_PORT}`;

type OperatorJsonRequest = NonNullable<
  Parameters<typeof runEnvironmentCommand>[1]['request']
>;

const INITIAL = {
  schemaVersion: 1 as const,
  environmentId: '11111111-1111-4111-8111-111111111111',
  credential: 'initial-secret-that-must-not-leak',
};
const ROTATED = {
  ...INITIAL,
  credential: 'rotated-secret-only-for-explicit-stdout',
};
const RESET = {
  schemaVersion: 1 as const,
  environmentId: '22222222-2222-4222-8222-222222222222',
  credential: 'reset-secret-that-must-not-leak',
};

function makeService(): EnvironmentSecurityServiceLike {
  return {
    initialize: vi.fn().mockResolvedValue(INITIAL),
    rotateCredential: vi.fn().mockResolvedValue(ROTATED),
    resetEnvironment: vi.fn().mockResolvedValue(RESET),
  };
}

function proofResponse(init?: RequestInit): Record<string, unknown> {
  const body = JSON.parse(String(init?.body)) as {
    protocolVersion: number;
    nonce: string;
  };
  return {
    protocolVersion: STATION_PROOF_PROTOCOL_VERSION,
    environmentId: INITIAL.environmentId,
    nonce: body.nonce,
    signature: createHmac(
      'sha256',
      Buffer.from(INITIAL.credential, 'base64url'),
    )
      .update(buildStationProofMessage(INITIAL.environmentId, body.nonce))
      .digest('base64url'),
  };
}

function makeAccessApi(
  requests: unknown[],
  updated?: unknown,
): ReturnType<typeof vi.fn<OperatorJsonRequest>> {
  return vi
    .fn<OperatorJsonRequest>()
    .mockImplementation(
      async (_apiBase: string, path: string, init?: RequestInit) => {
        if (path === '/.well-known/station/v1') {
          return { environmentId: INITIAL.environmentId };
        }
        if (path === PUBLIC_STATION_PROOF_PATH) return proofResponse(init);
        if (path === '/api/pairing/requests') return { requests };
        if (updated !== undefined) return updated;
        throw new Error(`Unexpected test request: ${path}`);
      },
    );
}

describe('environment CLI commands', () => {
  const stdout = vi.fn();
  const stderr = vi.fn();

  beforeEach(() => {
    stdout.mockReset();
    stderr.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('shows stable non-secret environment metadata from the resolved Station home', async () => {
    const service = makeService();
    const createService = vi.fn(() => service);

    await runEnvironmentCommand(['show'], {
      createService,
      projectHome: '/tmp/resolved-station-home',
      stdout,
      stderr,
      isInteractive: false,
    });

    expect(createService).toHaveBeenCalledWith('/tmp/resolved-station-home');
    expect(stdout).toHaveBeenCalledWith(
      JSON.stringify({
        schemaVersion: 1,
        environmentId: INITIAL.environmentId,
        credential: 'configured',
      }),
    );
    expect(JSON.stringify(stdout.mock.calls)).not.toContain(INITIAL.credential);
    expect(stderr).not.toHaveBeenCalled();
  });

  test('reveals the credential only for the explicit credential show command', async () => {
    await runEnvironmentCommand(['credential', 'show'], {
      createService: () => makeService(),
      projectHome: '/tmp/station-home',
      stdout,
      stderr,
      isInteractive: false,
    });

    expect(stdout).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalledWith(INITIAL.credential);
    expect(stderr).not.toHaveBeenCalled();
  });

  test.each([
    ['credential rotation', ['credential', 'rotate']],
    ['environment reset', ['reset']],
  ])('requires --force for non-interactive %s', async (_label, args) => {
    const service = makeService();

    await expect(
      runEnvironmentCommand(args, {
        createService: () => service,
        projectHome: '/tmp/station-home',
        stdout,
        stderr,
        isInteractive: false,
      }),
    ).rejects.toThrow(/--force/);

    expect(service.rotateCredential).not.toHaveBeenCalled();
    expect(service.resetEnvironment).not.toHaveBeenCalled();
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(INITIAL.credential);
  });

  test('rotates after --force and prints only the replacement credential', async () => {
    const service = makeService();

    await runEnvironmentCommand(['credential', 'rotate', '--force'], {
      createService: () => service,
      projectHome: '/tmp/station-home',
      stdout,
      stderr,
      isInteractive: false,
    });

    expect(service.rotateCredential).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalledWith(ROTATED.credential);
    expect(JSON.stringify(stdout.mock.calls)).not.toContain(INITIAL.credential);
    expect(stderr).not.toHaveBeenCalled();
  });

  test('reset confirms interactively and never prints either credential', async () => {
    const service = makeService();
    const confirm = vi.fn().mockResolvedValue(true);

    await runEnvironmentCommand(['reset'], {
      createService: () => service,
      projectHome: '/tmp/station-home',
      stdout,
      stderr,
      isInteractive: true,
      confirm,
    });

    expect(confirm).toHaveBeenCalledOnce();
    expect(service.resetEnvironment).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalledWith(
      JSON.stringify({
        schemaVersion: 1,
        environmentId: RESET.environmentId,
        credential: 'rotated',
      }),
    );
    const allOutput = JSON.stringify([stdout.mock.calls, stderr.mock.calls]);
    expect(allOutput).not.toContain(INITIAL.credential);
    expect(allOutput).not.toContain(RESET.credential);
  });

  test('cancels an interactive destructive command without mutation', async () => {
    const service = makeService();

    await runEnvironmentCommand(['credential', 'rotate'], {
      createService: () => service,
      projectHome: '/tmp/station-home',
      stdout,
      stderr,
      isInteractive: true,
      confirm: vi.fn().mockResolvedValue(false),
    });

    expect(service.rotateCredential).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith('Cancelled.');
  });

  test('lists local access requests with an internally loaded operator credential', async () => {
    const request = makeAccessApi([]);

    await runEnvironmentCommand(['access', 'list'], {
      createService: () => makeService(),
      projectHome: '/tmp/station-home',
      request,
      stdout,
      stderr,
      isInteractive: false,
    });

    expect(request).toHaveBeenCalledWith(
      DEFAULT_LOOPBACK_API_BASE,
      '/api/pairing/requests',
      expect.objectContaining({
        headers: { Authorization: `Bearer ${INITIAL.credential}` },
      }),
    );
    expect(stdout).toHaveBeenCalledWith(
      JSON.stringify({ requests: [] }, null, 2),
    );
    expect(JSON.stringify(stdout.mock.calls)).not.toContain(INITIAL.credential);
  });

  test('lists access requests leading with device name and requester identity', async () => {
    const request = makeAccessApi([
      {
        requestId: 'request-tailnet-list',
        offerId: 'offer-tailnet-list',
        deviceName: 'Brian phone',
        source: 'tailnet',
        requester: {
          provider: 'tailscale-serve',
          login: 'brian@example.test',
          displayName: 'Brian',
        },
        createdAt: 10,
        expiresAt: 20,
        status: 'pending',
      },
    ]);

    await runEnvironmentCommand(['access', 'list'], {
      createService: () => makeService(),
      projectHome: '/tmp/station-home',
      request,
      stdout,
      stderr,
      isInteractive: false,
    });

    const printed = JSON.parse(stdout.mock.calls[0]?.[0] as string) as {
      requests: Array<Record<string, unknown>>;
    };
    const entry = printed.requests[0]!;
    expect(Object.keys(entry).slice(0, 2)).toEqual([
      'deviceName',
      'requestedBy',
    ]);
    expect(entry).toMatchObject({
      deviceName: 'Brian phone',
      requestedBy: 'Brian',
      requestId: 'request-tailnet-list',
      offerId: 'offer-tailnet-list',
    });
  });

  test('approves using the offerId that access list printed, not just the requestId', async () => {
    const pending = {
      requestId: 'request-by-offer',
      offerId: 'offer-by-offer',
      deviceName: 'Phone via offer id',
      source: 'same-origin' as const,
      createdAt: 10,
      expiresAt: 20,
      status: 'pending' as const,
    };
    const request = makeAccessApi([pending], {
      ...pending,
      status: 'confirmed',
    });

    await runEnvironmentCommand(
      ['access', 'approve', 'offer-by-offer', '--force'],
      {
        createService: () => makeService(),
        projectHome: '/tmp/station-home',
        request,
        stdout,
        stderr,
        isInteractive: false,
      },
    );

    expect(request).toHaveBeenLastCalledWith(
      DEFAULT_LOOPBACK_API_BASE,
      '/api/pairing/requests/request-by-offer/confirm',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('explains the --force guard and prints the exact rerun command', async () => {
    const request = makeAccessApi([
      {
        requestId: 'request-needs-force',
        offerId: 'offer-needs-force',
        deviceName: 'Kitchen tablet',
        source: 'same-origin',
        createdAt: 10,
        expiresAt: 20,
        status: 'pending',
      },
    ]);

    await expect(
      runEnvironmentCommand(['access', 'approve'], {
        createService: () => makeService(),
        projectHome: '/tmp/station-home',
        request,
        stdout,
        stderr,
        isInteractive: false,
      }),
    ).rejects.toThrow(
      /requires --force when stdin is non-interactive, so a script can never silently grant a stranger's device access.*Rerun: station environment access approve request-needs-force --force/s,
    );
  });

  test('surfaces a pairing-approval error body instead of only its HTTP status', async () => {
    const pending = {
      requestId: 'request-approval-failed',
      deviceName: 'Pixel 10 Pro XL',
      source: 'same-origin' as const,
      createdAt: 10,
      expiresAt: 20,
      status: 'pending' as const,
    };
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/.well-known/station/v1')) {
          return new Response(
            JSON.stringify({
              environmentId: INITIAL.environmentId,
            }),
          );
        }
        if (url.endsWith(PUBLIC_STATION_PROOF_PATH)) {
          return new Response(JSON.stringify(proofResponse(init)));
        }
        if (url.endsWith('/api/pairing/requests')) {
          return new Response(JSON.stringify({ requests: [pending] }));
        }
        if (
          url.endsWith('/api/pairing/requests/request-approval-failed/confirm')
        ) {
          return new Response(
            JSON.stringify({
              error:
                'Cannot read private member #state from an object whose class did not declare it',
            }),
            { status: 500 },
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      runEnvironmentCommand(
        ['access', 'approve', 'request-approval-failed', '--force'],
        {
          createService: () => makeService(),
          projectHome: '/tmp/station-home',
          stdout,
          stderr,
          isInteractive: false,
        },
      ),
    ).rejects.toThrow(
      'Station request failed with HTTP 500: Cannot read private member #state from an object whose class did not declare it',
    );
    expect(
      JSON.stringify([stdout.mock.calls, stderr.mock.calls]),
    ).not.toContain(INITIAL.credential);
  });

  test('interactively approves the only pending local request without printing a credential', async () => {
    const pending = {
      requestId: 'request-tailnet',
      deviceName: 'Brian phone',
      source: 'tailnet' as const,
      requester: {
        provider: 'tailscale-serve' as const,
        login: 'brian@example.test',
        displayName: 'Brian',
      },
      createdAt: 10,
      expiresAt: 20,
      status: 'pending' as const,
    };
    const request = makeAccessApi([pending], {
      ...pending,
      status: 'confirmed',
    });
    const confirm = vi.fn().mockResolvedValue(true);

    await runEnvironmentCommand(['access', 'approve'], {
      createService: () => makeService(),
      projectHome: '/tmp/station-home',
      request,
      stdout,
      stderr,
      isInteractive: true,
      confirm,
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('verified Tailscale user "Brian"'),
    );
    expect(request).toHaveBeenLastCalledWith(
      DEFAULT_LOOPBACK_API_BASE,
      '/api/pairing/requests/request-tailnet/confirm',
      expect.objectContaining({ method: 'POST' }),
    );
    const allOutput = JSON.stringify([stdout.mock.calls, stderr.mock.calls]);
    expect(allOutput).toContain('confirmed');
    expect(allOutput).not.toContain(INITIAL.credential);
  });

  test('requires explicit force for non-interactive SSH approval', async () => {
    const request = makeAccessApi([
      {
        requestId: 'request-phone',
        deviceName: 'Phone',
        source: 'same-origin',
        createdAt: 10,
        expiresAt: 20,
        status: 'pending',
      },
    ]);

    await expect(
      runEnvironmentCommand(['access', 'approve'], {
        createService: () => makeService(),
        projectHome: '/tmp/station-home',
        request,
        stdout,
        stderr,
        isInteractive: false,
      }),
    ).rejects.toThrow(/requires --force/);

    expect(request).toHaveBeenCalledTimes(3);
  });

  test('selects the newest pending request only when --latest is explicit', async () => {
    const older = {
      requestId: 'request-older',
      deviceName: 'Older phone',
      source: 'same-origin' as const,
      createdAt: 10,
      expiresAt: 30,
      status: 'pending' as const,
    };
    const newer = {
      ...older,
      requestId: 'request-newer',
      deviceName: 'Newer phone',
      createdAt: 20,
    };
    const request = makeAccessApi([older, newer], {
      ...newer,
      status: 'confirmed',
    });

    await runEnvironmentCommand(['access', 'approve', '--latest', '--force'], {
      createService: () => makeService(),
      projectHome: '/tmp/station-home',
      request,
      stdout,
      stderr,
      isInteractive: false,
    });

    expect(request).toHaveBeenLastCalledWith(
      DEFAULT_LOOPBACK_API_BASE,
      '/api/pairing/requests/request-newer/confirm',
      expect.anything(),
    );
  });

  test('refuses to load or send the local credential to a non-loopback API base', async () => {
    const createService = vi.fn(() => makeService());
    const request = vi.fn<OperatorJsonRequest>();

    await expect(
      runEnvironmentCommand(
        ['access', 'list', '--api-base=https://station.example.test'],
        {
          createService,
          projectHome: '/tmp/station-home',
          request,
          stdout,
          stderr,
          isInteractive: false,
        },
      ),
    ).rejects.toThrow(/loopback/);

    expect(createService).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  test('binds local authorization to the matching public environment identity', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ environmentId: 'different-environment' });

    await expect(
      runEnvironmentCommand(['access', 'list'], {
        createService: () => makeService(),
        projectHome: '/tmp/station-home',
        request,
        stdout,
        stderr,
        isInteractive: false,
      }),
    ).rejects.toThrow(/does not match/);

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[2]).toBeUndefined();
  });

  test('sends no authorization when the loopback proof is invalid', async () => {
    const calls: Array<[string, string, RequestInit | undefined]> = [];
    const request = async <T>(
      apiBase: string,
      path: string,
      init?: RequestInit,
    ): Promise<T> => {
      calls.push([apiBase, path, init]);
      if (path === '/.well-known/station/v1') {
        return { environmentId: INITIAL.environmentId } as T;
      }
      if (path === PUBLIC_STATION_PROOF_PATH) {
        return {
          protocolVersion: STATION_PROOF_PROTOCOL_VERSION,
          environmentId: INITIAL.environmentId,
          nonce: 'wrong-nonce',
          signature: 'x'.repeat(43),
        } as T;
      }
      throw new Error('Authorization should not be attempted');
    };

    await expect(
      runEnvironmentCommand(['access', 'list'], {
        createService: () => makeService(),
        projectHome: '/tmp/station-home',
        request,
        stdout,
        stderr,
        isInteractive: false,
      }),
    ).rejects.toThrow(/No credential was sent/);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(JSON.stringify(call[2] ?? {})).not.toContain('Authorization');
      expect(JSON.stringify(call[2] ?? {})).not.toContain(INITIAL.credential);
    }
  });

  test('rejects an ambiguous --latest timestamp tie before approval', async () => {
    const requests = ['request-a', 'request-b'].map((requestId) => ({
      requestId,
      deviceName: requestId,
      source: 'same-origin' as const,
      createdAt: 10,
      expiresAt: 20,
      status: 'pending' as const,
    }));
    const request = makeAccessApi(requests);

    await expect(
      runEnvironmentCommand(['access', 'approve', '--latest', '--force'], {
        createService: () => makeService(),
        projectHome: '/tmp/station-home',
        request,
        stdout,
        stderr,
        isInteractive: false,
      }),
    ).rejects.toThrow(/ambiguous/);

    expect(request).toHaveBeenCalledTimes(3);
  });

  test('escapes terminal format controls in access-list output', async () => {
    const request = makeAccessApi([
      {
        requestId: 'request-bidi',
        deviceName: 'Phone\u202egpj.exe',
        source: 'same-origin',
        createdAt: 10,
        expiresAt: 20,
        status: 'pending',
      },
    ]);

    await runEnvironmentCommand(['access', 'list'], {
      createService: () => makeService(),
      projectHome: '/tmp/station-home',
      request,
      stdout,
      stderr,
      isInteractive: false,
    });

    expect(stdout.mock.calls[0]?.[0]).toContain('Phone\\u202egpj.exe');
    expect(stdout.mock.calls[0]?.[0]).not.toContain('\u202e');
  });

  test('rejects a mismatched mutation result instead of printing success', async () => {
    const pending = {
      requestId: 'request-selected',
      deviceName: 'Selected phone',
      source: 'same-origin' as const,
      createdAt: 10,
      expiresAt: 20,
      status: 'pending' as const,
    };
    const request = makeAccessApi([pending], {
      ...pending,
      requestId: 'request-other',
      status: 'confirmed',
    });

    await expect(
      runEnvironmentCommand(
        ['access', 'approve', 'request-selected', '--force'],
        {
          createService: () => makeService(),
          projectHome: '/tmp/station-home',
          request,
          stdout,
          stderr,
          isInteractive: false,
        },
      ),
    ).rejects.toThrow(/mismatched/);

    expect(stdout).not.toHaveBeenCalled();
  });

  test('uses the pairing routes bare-JSON contract over a real loopback server', async () => {
    const pending = {
      requestId: 'request-live',
      deviceName: 'Live browser',
      source: 'same-origin' as const,
      createdAt: 10,
      expiresAt: 20,
      status: 'pending' as const,
    };
    const observedAuthorization: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/.well-known/station/v1') {
        response.end(JSON.stringify({ environmentId: INITIAL.environmentId }));
        return;
      }
      if (request.url === PUBLIC_STATION_PROOF_PATH) {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
          body += chunk;
        });
        request.on('end', () => {
          const value = JSON.parse(body) as { nonce: string };
          response.end(
            JSON.stringify({
              protocolVersion: STATION_PROOF_PROTOCOL_VERSION,
              environmentId: INITIAL.environmentId,
              nonce: value.nonce,
              signature: createHmac(
                'sha256',
                Buffer.from(INITIAL.credential, 'base64url'),
              )
                .update(
                  buildStationProofMessage(INITIAL.environmentId, value.nonce),
                )
                .digest('base64url'),
            }),
          );
        });
        return;
      }
      observedAuthorization.push(request.headers.authorization);
      if (request.url === '/api/pairing/requests') {
        response.end(JSON.stringify({ requests: [pending] }));
        return;
      }
      if (
        request.method === 'POST' &&
        request.url === '/api/pairing/requests/request-live/confirm'
      ) {
        response.end(JSON.stringify({ ...pending, status: 'confirmed' }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not_found' }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No test port');

    try {
      await runEnvironmentCommand(
        [
          'access',
          'approve',
          'request-live',
          '--force',
          `--api-base=http://127.0.0.1:${address.port}`,
        ],
        {
          createService: () => makeService(),
          projectHome: '/tmp/station-home',
          stdout,
          stderr,
          isInteractive: false,
        },
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    expect(observedAuthorization).toEqual([
      `Bearer ${INITIAL.credential}`,
      `Bearer ${INITIAL.credential}`,
    ]);
    expect(stdout.mock.calls[0]?.[0]).toContain('confirmed');
    expect(stdout.mock.calls[0]?.[0]).not.toContain(INITIAL.credential);
  });

  test.each([
    [[]],
    [['unknown']],
    [['credential']],
    [['credential', 'unknown']],
    [['show', '--force']],
    [['access']],
    [['access', 'unknown']],
  ])('rejects unsupported syntax: %j', async (args: string[]) => {
    await expect(
      runEnvironmentCommand(args, {
        createService: () => makeService(),
        projectHome: '/tmp/station-home',
        stdout,
        stderr,
        isInteractive: false,
      }),
    ).rejects.toThrow(/Usage:/);
  });

  describe('environment peers (station#1123 slice 2)', () => {
    function makePeerStore() {
      const summary = {
        environmentId: 'environment-peer-b',
        apiBase: 'https://box-b.example.test',
        scope: 'orchestration:read orchestration:operate',
        label: 'box-b',
        createdAt: 1,
        updatedAt: 1,
      };
      return {
        list: vi.fn(() => [summary]),
        upsert: vi.fn(async () => summary),
        remove: vi.fn(async () => true),
      };
    }

    test('lists peers via the injected local store, never over the network', async () => {
      const store = makePeerStore();
      const createPeerCredentialStore = vi.fn(() => store);

      await runEnvironmentCommand(['peers', 'list'], {
        createPeerCredentialStore,
        projectHome: '/tmp/resolved-station-home',
        stdout,
        stderr,
        isInteractive: false,
      });

      expect(createPeerCredentialStore).toHaveBeenCalledWith(
        '/tmp/resolved-station-home',
      );
      expect(store.list).toHaveBeenCalled();
      expect(stdout).toHaveBeenCalledWith(
        JSON.stringify({ peers: store.list() }),
      );
    });

    test('provisions a peer credential with the exact provided fields', async () => {
      const store = makePeerStore();

      await runEnvironmentCommand(
        [
          'peers',
          'add',
          '--environment-id',
          'environment-peer-b',
          '--api-base',
          'https://box-b.example.test',
          '--credential',
          'peer-bearer-credential-0123456789abcdef',
          '--scope',
          'orchestration:read orchestration:operate',
          '--label',
          'box-b',
        ],
        {
          createPeerCredentialStore: () => store,
          projectHome: '/tmp/resolved-station-home',
          stdout,
          stderr,
          isInteractive: false,
        },
      );

      expect(store.upsert).toHaveBeenCalledWith({
        environmentId: 'environment-peer-b',
        apiBase: 'https://box-b.example.test',
        credential: 'peer-bearer-credential-0123456789abcdef',
        scope: 'orchestration:read orchestration:operate',
        label: 'box-b',
      });
    });

    test('removes a peer credential by environmentId', async () => {
      const store = makePeerStore();

      await runEnvironmentCommand(['peers', 'remove', 'environment-peer-b'], {
        createPeerCredentialStore: () => store,
        projectHome: '/tmp/resolved-station-home',
        stdout,
        stderr,
        isInteractive: false,
      });

      expect(store.remove).toHaveBeenCalledWith('environment-peer-b');
      expect(stdout).toHaveBeenCalledWith(JSON.stringify({ removed: true }));
    });

    test('requires the repository launcher when no store factory is injected', async () => {
      await expect(
        runEnvironmentCommand(['peers', 'list'], {
          projectHome: '/tmp/resolved-station-home',
          stdout,
          stderr,
          isInteractive: false,
        }),
      ).rejects.toThrow(/repository launcher/);
    });

    test('rejects an add missing a required flag', async () => {
      const store = makePeerStore();
      await expect(
        runEnvironmentCommand(
          ['peers', 'add', '--environment-id', 'environment-peer-b'],
          {
            createPeerCredentialStore: () => store,
            projectHome: '/tmp/resolved-station-home',
            stdout,
            stderr,
            isInteractive: false,
          },
        ),
      ).rejects.toThrow();
    });

    describe('SSH-precedence warning (review fix, PR #1178)', () => {
      function makeSshProfileStore(environmentIds: Array<string | null>) {
        return {
          initialize: vi.fn(async () => {}),
          list: vi.fn(() =>
            environmentIds.map((environmentId) => ({ environmentId })),
          ),
        };
      }

      test('warns, but still provisions, when the environmentId already has a saved SSH profile', async () => {
        const store = makePeerStore();
        const sshStore = makeSshProfileStore(['environment-peer-b']);

        await runEnvironmentCommand(
          [
            'peers',
            'add',
            '--environment-id',
            'environment-peer-b',
            '--api-base',
            'https://box-b.example.test',
            '--credential',
            'peer-bearer-credential-0123456789abcdef',
            '--scope',
            'orchestration:read orchestration:operate',
          ],
          {
            createPeerCredentialStore: () => store,
            createSshEnvironmentProfileStore: () => sshStore,
            projectHome: '/tmp/resolved-station-home',
            stdout,
            stderr,
            isInteractive: false,
          },
        );

        expect(sshStore.initialize).toHaveBeenCalled();
        expect(stderr).toHaveBeenCalledWith(
          expect.stringContaining(
            "environment 'environment-peer-b' already has a saved SSH profile",
          ),
        );
        // Still provisions — this is a warning, not a refusal.
        expect(store.upsert).toHaveBeenCalled();
      });

      test('does not warn when no SSH profile matches the environmentId', async () => {
        const store = makePeerStore();
        const sshStore = makeSshProfileStore(['some-other-environment', null]);

        await runEnvironmentCommand(
          [
            'peers',
            'add',
            '--environment-id',
            'environment-peer-b',
            '--api-base',
            'https://box-b.example.test',
            '--credential',
            'peer-bearer-credential-0123456789abcdef',
            '--scope',
            'orchestration:read orchestration:operate',
          ],
          {
            createPeerCredentialStore: () => store,
            createSshEnvironmentProfileStore: () => sshStore,
            projectHome: '/tmp/resolved-station-home',
            stdout,
            stderr,
            isInteractive: false,
          },
        );

        expect(stderr).not.toHaveBeenCalled();
        expect(store.upsert).toHaveBeenCalled();
      });

      test('skips the check (never throws) when no SSH-store factory is injected', async () => {
        const store = makePeerStore();

        await runEnvironmentCommand(
          [
            'peers',
            'add',
            '--environment-id',
            'environment-peer-b',
            '--api-base',
            'https://box-b.example.test',
            '--credential',
            'peer-bearer-credential-0123456789abcdef',
            '--scope',
            'orchestration:read orchestration:operate',
          ],
          {
            createPeerCredentialStore: () => store,
            projectHome: '/tmp/resolved-station-home',
            stdout,
            stderr,
            isInteractive: false,
          },
        );

        expect(stderr).not.toHaveBeenCalled();
        expect(store.upsert).toHaveBeenCalled();
      });

      test('is best-effort: an SSH-side lookup failure never blocks provisioning', async () => {
        const store = makePeerStore();
        const sshStore = {
          initialize: vi.fn(async () => {
            throw new Error('ssh.json is corrupt');
          }),
          list: vi.fn(() => []),
        };

        await runEnvironmentCommand(
          [
            'peers',
            'add',
            '--environment-id',
            'environment-peer-b',
            '--api-base',
            'https://box-b.example.test',
            '--credential',
            'peer-bearer-credential-0123456789abcdef',
            '--scope',
            'orchestration:read orchestration:operate',
          ],
          {
            createPeerCredentialStore: () => store,
            createSshEnvironmentProfileStore: () => sshStore,
            projectHome: '/tmp/resolved-station-home',
            stdout,
            stderr,
            isInteractive: false,
          },
        );

        expect(stderr).not.toHaveBeenCalled();
        expect(store.upsert).toHaveBeenCalled();
      });
    });
  });
});

describe('environment-security verbs honor saved Stations (station#4515)', () => {
  const stdout = vi.fn();
  const stderr = vi.fn();
  let stationRoot: string;
  let previousRoot: string | undefined;
  let previousHome: string | undefined;

  // station#4515 review H1: what actually grants trust for a profile-
  // addressed target is `localService.baseDir` selecting WHICH home the
  // security service reads — not the profile's own recorded `environmentId`.
  // A fake whose identity is the SAME regardless of the home it's asked
  // about (like `makeService()` above) cannot prove that; these tests use a
  // home-aware fake so an accept can only happen when the code actually
  // resolved and read the CORRECT home.
  const DEFAULT_HOME = '/tmp/default-cli-home';
  const NIGHTLY_HOME = '/tmp/nightly-station-home';
  const NIGHTLY_API_BASE = 'http://127.0.0.1:38141';
  const DEFAULT_HOME_IDENTITY = {
    schemaVersion: 1 as const,
    environmentId: 'default-home-environment',
    credential: 'default-home-credential-must-not-leak',
  };
  const NIGHTLY_HOME_IDENTITY = {
    schemaVersion: 1 as const,
    environmentId: 'nightly-home-environment',
    credential: 'nightly-home-credential-must-not-leak',
  };

  function makeHomeAwareService(
    identitiesByHome: Record<string, EnvironmentSecuritySnapshot>,
  ): EnvironmentSecurityServiceFactory {
    return (projectHome: string) => {
      const identity = identitiesByHome[projectHome];
      if (!identity) {
        throw new Error(
          `Test bug: no fake identity registered for home ${projectHome}`,
        );
      }
      return {
        initialize: vi.fn().mockResolvedValue(identity),
        rotateCredential: vi.fn(),
        resetEnvironment: vi.fn(),
      };
    };
  }

  /**
   * Like the module-level `makeAccessApi`, but the handshake identity and
   * proof signature are parameterized on a real server identity instead of
   * hardcoded to `INITIAL` — required once a home-aware fake can resolve to
   * an identity other than `INITIAL`.
   */
  function makeServerAccessApi(
    serverIdentity: EnvironmentSecuritySnapshot,
    requests: unknown[],
    updated?: unknown,
  ): ReturnType<typeof vi.fn<OperatorJsonRequest>> {
    return vi
      .fn<OperatorJsonRequest>()
      .mockImplementation(
        async (_apiBase: string, path: string, init?: RequestInit) => {
          if (path === '/.well-known/station/v1') {
            return { environmentId: serverIdentity.environmentId };
          }
          if (path === PUBLIC_STATION_PROOF_PATH) {
            const body = JSON.parse(String(init?.body)) as {
              protocolVersion: number;
              nonce: string;
            };
            return {
              protocolVersion: STATION_PROOF_PROTOCOL_VERSION,
              environmentId: serverIdentity.environmentId,
              nonce: body.nonce,
              signature: createHmac(
                'sha256',
                Buffer.from(serverIdentity.credential, 'base64url'),
              )
                .update(
                  buildStationProofMessage(
                    serverIdentity.environmentId,
                    body.nonce,
                  ),
                )
                .digest('base64url'),
            };
          }
          if (path === '/api/pairing/requests') return { requests };
          if (updated !== undefined) return updated;
          throw new Error(`Unexpected test request: ${path}`);
        },
      );
  }

  beforeEach(() => {
    stationRoot = mkdtempSync(join(tmpdir(), 'station-security-verbs-'));
    previousRoot = process.env.STATION_ROOT;
    previousHome = process.env.STATION_HOME;
    process.env.STATION_ROOT = stationRoot;
    process.env.STATION_HOME = stationRoot;
    stdout.mockReset();
    stderr.mockReset();
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.STATION_ROOT;
    else process.env.STATION_ROOT = previousRoot;
    if (previousHome === undefined) delete process.env.STATION_HOME;
    else process.env.STATION_HOME = previousHome;
    rmSync(stationRoot, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  test('accepts --station=<name> for a profile with a recorded localService.baseDir whose home identity matches the loopback listener', async () => {
    upsertProfile({
      name: 'nightly-local',
      endpoint: NIGHTLY_API_BASE,
      environmentId: NIGHTLY_HOME_IDENTITY.environmentId,
      setupSource: 'local',
      configurationState: 'configured',
      localService: {
        instanceId: 'nightly-instance',
        baseDir: NIGHTLY_HOME,
        serverPort: 38141,
        uiPort: 38142,
      },
    });
    const createService = vi.fn(
      makeHomeAwareService({
        [DEFAULT_HOME]: DEFAULT_HOME_IDENTITY,
        [NIGHTLY_HOME]: NIGHTLY_HOME_IDENTITY,
      }),
    );
    const request = makeServerAccessApi(NIGHTLY_HOME_IDENTITY, []);

    await runEnvironmentCommand(['access', 'list', '--station=nightly-local'], {
      createService,
      // Deliberately the WRONG/default home. If the fix regressed to
      // reading this instead of the profile's `localService.baseDir`, the
      // home-aware fake would report `DEFAULT_HOME_IDENTITY` here — a
      // different environmentId than the loopback listener advertises —
      // and this call would reject instead of succeeding.
      projectHome: DEFAULT_HOME,
      request,
      stdout,
      stderr,
      isInteractive: false,
    });

    expect(createService).toHaveBeenCalledWith(NIGHTLY_HOME);
    expect(request).toHaveBeenCalledWith(
      NIGHTLY_API_BASE,
      '/api/pairing/requests',
      expect.objectContaining({
        headers: {
          Authorization: `Bearer ${NIGHTLY_HOME_IDENTITY.credential}`,
        },
      }),
    );
    expect(stdout).toHaveBeenCalledWith(
      JSON.stringify({ requests: [] }, null, 2),
    );
  });

  test('refuses --station when the saved Station records no local home, before ever touching the network, naming a working remedy by value', async () => {
    upsertProfile({
      name: 'nightly-paired',
      endpoint: NIGHTLY_API_BASE,
      environmentId: NIGHTLY_HOME_IDENTITY.environmentId,
      // Paired (or added via `stations add`), not installed by
      // `station setup local` — deliberately no `localService`.
      setupSource: 'paired',
      configurationState: 'configured',
    });
    const createService = vi.fn(
      makeHomeAwareService({ [DEFAULT_HOME]: DEFAULT_HOME_IDENTITY }),
    );
    const request = vi.fn<OperatorJsonRequest>();

    await expect(
      runEnvironmentCommand(['access', 'list', '--station=nightly-paired'], {
        createService,
        projectHome: DEFAULT_HOME,
        request,
        stdout,
        stderr,
        isInteractive: false,
      }),
    ).rejects.toThrow(
      'Station "nightly-paired" has no recorded local home. It was saved by pairing ' +
        '(or `stations add`), not `station setup local`, so this saved Station does not ' +
        'record the home directory environment-security commands need in order to read ' +
        "that Station's own operator credential from disk. Set STATION_HOME to that " +
        "Station's home directory, then run: station environment access list " +
        `--api-base=${NIGHTLY_API_BASE}.`,
    );

    // Refused before ever reading a (wrong) local credential or reaching
    // the network — the shape gate is the first thing checked.
    expect(createService).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  test('refuses --station approve with no recorded local home, naming the interactive-vs-scripted remedy by value', async () => {
    upsertProfile({
      name: 'nightly-paired',
      endpoint: NIGHTLY_API_BASE,
      environmentId: NIGHTLY_HOME_IDENTITY.environmentId,
      setupSource: 'paired',
      configurationState: 'configured',
    });
    // Registered so this test can prove the gate fires BEFORE any home is
    // read, not merely that some later step also happened to fail: the
    // default home here resolves to a valid identity, so if the shape gate
    // were bypassed this call would proceed past it (station#4515 review
    // fault-injection: this distinguished the gate from the shared mismatch
    // message, which reuses the same remedy text — a naive substring check
    // on the remedy alone did not).
    const createService = vi.fn(
      makeHomeAwareService({ [DEFAULT_HOME]: DEFAULT_HOME_IDENTITY }),
    );
    const request = vi.fn<OperatorJsonRequest>();

    await expect(
      runEnvironmentCommand(['access', 'approve', '--station=nightly-paired'], {
        createService,
        projectHome: DEFAULT_HOME,
        request,
        stdout,
        stderr,
        isInteractive: false,
      }),
    ).rejects.toThrow(
      'Station "nightly-paired" has no recorded local home. It was saved by pairing ' +
        `(or \`stations add\`), not \`station setup local\`, so this saved Station does not ` +
        `record the home directory environment-security commands need in order to read ` +
        `that Station's own operator credential from disk. Set STATION_HOME to that ` +
        `Station's home directory, then run: station environment access approve ` +
        `--api-base=${NIGHTLY_API_BASE} <request-id>. Interactively this prompts for ` +
        'confirmation; pass --force only for non-interactive/scripted use.',
    );
    expect(createService).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  test('refuses when the profile record matches what the listener advertises but the resolved home has since moved on (station#4515 review NEW-1)', async () => {
    // The coarse identity check must compare the handshake against the
    // RESOLVED HOME's actual identity (`snapshot.environmentId`), never the
    // profile's own recorded `environmentId` — those two normally agree in
    // every other fixture here, so only a scenario where they DIVERGE can
    // discriminate the two possible comparison operands. Here the loopback
    // listener advertises exactly what the profile's (stale) record says —
    // a "port squatter" shape: something is answering with the OLD identity
    // this Station was paired under — while the resolved home has since
    // moved on to a different real current identity. Comparing against the
    // profile's record would read this as a match and proceed to send a
    // credential to whatever is on that port; comparing against the
    // resolved home's own snapshot (what this fix does) refuses it.
    // Reverting environment.ts's comparison operand to
    // `targetProfile?.environmentId ?? snapshot.environmentId` leaves every
    // OTHER test in this file green — only this fixture reds under it.
    const staleRecordedEnvironmentId =
      'stale-record-matches-listener-environment';
    const squatterIdentity = {
      schemaVersion: 1 as const,
      environmentId: staleRecordedEnvironmentId,
      credential: 'irrelevant-never-reaches-the-proof-step',
    };
    upsertProfile({
      name: 'nightly-local',
      endpoint: NIGHTLY_API_BASE,
      // Matches what the listener advertises below — NOT the resolved
      // home's real current identity (`NIGHTLY_HOME_IDENTITY`).
      environmentId: staleRecordedEnvironmentId,
      setupSource: 'local',
      configurationState: 'configured',
      localService: {
        instanceId: 'nightly-instance',
        baseDir: NIGHTLY_HOME,
        serverPort: 38141,
        uiPort: 38142,
      },
    });
    const request = makeServerAccessApi(squatterIdentity, []);

    await expect(
      runEnvironmentCommand(['access', 'list', '--station=nightly-local'], {
        createService: vi.fn(
          makeHomeAwareService({ [NIGHTLY_HOME]: NIGHTLY_HOME_IDENTITY }),
        ),
        projectHome: DEFAULT_HOME,
        request,
        stdout,
        stderr,
        isInteractive: false,
      }),
    ).rejects.toThrow(
      new RegExp(
        `"nightly-local" targets .*but the loopback listener there advertised ` +
          `environment ${staleRecordedEnvironmentId}, not the environment ` +
          `\\(${NIGHTLY_HOME_IDENTITY.environmentId}\\)`,
        's',
      ),
    );
  });

  test("enriches an identity mismatch with a stale-pairing-record note when the profile's own recorded environmentId also disagrees with its resolved home", async () => {
    const staleRecordedEnvironmentId = 'stale-pairing-record-environment';
    const rogueListenerIdentity = {
      schemaVersion: 1 as const,
      environmentId: 'rogue-listener-environment',
      credential: 'irrelevant-never-reaches-the-proof-step',
    };
    upsertProfile({
      name: 'nightly-local',
      endpoint: NIGHTLY_API_BASE,
      // Deliberately NOT `NIGHTLY_HOME_IDENTITY.environmentId` — this
      // saved Station's own pairing record has drifted from what its
      // recorded home currently reports (e.g. a reset/re-provision since
      // it was paired).
      environmentId: staleRecordedEnvironmentId,
      setupSource: 'local',
      configurationState: 'configured',
      localService: {
        instanceId: 'nightly-instance',
        baseDir: NIGHTLY_HOME,
        serverPort: 38141,
        uiPort: 38142,
      },
    });
    const createService = vi.fn(
      makeHomeAwareService({ [NIGHTLY_HOME]: NIGHTLY_HOME_IDENTITY }),
    );
    // The loopback listener is some OTHER Station entirely — the ordinary
    // mismatch case the stale-record note is layered onto, not caused by.
    const request = makeServerAccessApi(rogueListenerIdentity, []);

    await expect(
      runEnvironmentCommand(['access', 'list', '--station=nightly-local'], {
        createService,
        projectHome: DEFAULT_HOME,
        request,
        stdout,
        stderr,
        isInteractive: false,
      }),
    ).rejects.toThrow(
      new RegExp(
        `"nightly-local".*${rogueListenerIdentity.environmentId}.*${NIGHTLY_HOME_IDENTITY.environmentId}.*` +
          `${staleRecordedEnvironmentId}.*out of date.*re-pair or re-provision`,
        's',
      ),
    );
    expect(JSON.stringify(stdout.mock.calls)).not.toContain(
      NIGHTLY_HOME_IDENTITY.credential,
    );
  });

  test('refuses an identity mismatch without the stale-record note when the profile record itself is current', async () => {
    const rogueListenerIdentity = {
      schemaVersion: 1 as const,
      environmentId: 'rogue-listener-environment',
      credential: 'irrelevant-never-reaches-the-proof-step',
    };
    upsertProfile({
      name: 'nightly-local',
      endpoint: NIGHTLY_API_BASE,
      // Matches the resolved home's real identity — this saved Station's
      // own record is NOT stale; some other listener is just on that port.
      environmentId: NIGHTLY_HOME_IDENTITY.environmentId,
      setupSource: 'local',
      configurationState: 'configured',
      localService: {
        instanceId: 'nightly-instance',
        baseDir: NIGHTLY_HOME,
        serverPort: 38141,
        uiPort: 38142,
      },
    });
    const request = makeServerAccessApi(rogueListenerIdentity, []);

    const error = await runEnvironmentCommand(
      ['access', 'list', '--station=nightly-local'],
      {
        createService: vi.fn(
          makeHomeAwareService({ [NIGHTLY_HOME]: NIGHTLY_HOME_IDENTITY }),
        ),
        projectHome: DEFAULT_HOME,
        request,
        stdout,
        stderr,
        isInteractive: false,
      },
    ).then(
      () => undefined,
      (thrown: Error) => thrown,
    );

    expect(error?.message).toContain('"nightly-local"');
    expect(error?.message).not.toMatch(/out of date|re-pair or re-provision/);
  });

  test('sanitizes an untrusted handshake environmentId before it reaches the terminal (M2)', async () => {
    const hostileIdentity = {
      schemaVersion: 1 as const,
      // A right-to-left override plus an oversized tail — the handshake
      // response is attacker-controlled (any process on the resolved
      // loopback port can answer it), unlike `snapshot`/`targetProfile`
      // fields, which are read from owner-controlled local disk.
      environmentId: `rogue‮-listener-${'x'.repeat(300)}`,
      credential: 'irrelevant-never-reaches-the-proof-step',
    };
    upsertProfile({
      name: 'nightly-local',
      endpoint: NIGHTLY_API_BASE,
      environmentId: NIGHTLY_HOME_IDENTITY.environmentId,
      setupSource: 'local',
      configurationState: 'configured',
      localService: {
        instanceId: 'nightly-instance',
        baseDir: NIGHTLY_HOME,
        serverPort: 38141,
        uiPort: 38142,
      },
    });
    const request = makeServerAccessApi(hostileIdentity, []);

    const error = await runEnvironmentCommand(
      ['access', 'list', '--station=nightly-local'],
      {
        createService: vi.fn(
          makeHomeAwareService({ [NIGHTLY_HOME]: NIGHTLY_HOME_IDENTITY }),
        ),
        projectHome: DEFAULT_HOME,
        request,
        stdout,
        stderr,
        isInteractive: false,
      },
    ).then(
      () => undefined,
      (thrown: Error) => thrown,
    );

    expect(error).toBeDefined();
    expect(error!.message).not.toContain('‮');
    expect(error!.message).toContain('\\u202e');
    // The sanitizer caps the untrusted id itself at 128 characters; bound
    // the whole message generously above the surrounding fixed prose so
    // this catches an unbounded id, not the message's own wording length.
    expect(error!.message.length).toBeLessThan(800);
  });

  test('refuses --station when the saved Station endpoint is not loopback, and never loads or sends a credential', async () => {
    upsertProfile({
      name: 'remote-station',
      endpoint: 'https://station.example.test',
      environmentId: INITIAL.environmentId,
      setupSource: 'paired',
      configurationState: 'configured',
    });
    const createService = vi.fn(() => makeService());
    const request = vi.fn<OperatorJsonRequest>();

    await expect(
      runEnvironmentCommand(['access', 'list', '--station=remote-station'], {
        createService,
        projectHome: '/tmp/unrelated-default-home',
        request,
        stdout,
        stderr,
        isInteractive: false,
      }),
    ).rejects.toThrow(/"remote-station".*not a loopback/s);

    expect(createService).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  test('the non-loopback remedy for a plain (non-profile) target names the real default port, not a hardcoded literal (L7)', async () => {
    const request = vi.fn<OperatorJsonRequest>();

    await expect(
      runEnvironmentCommand(
        ['access', 'list', '--api-base=https://station.example.test'],
        {
          createService: vi.fn(() => makeService()),
          projectHome: '/tmp/unrelated-default-home',
          request,
          stdout,
          stderr,
          isInteractive: false,
        },
      ),
    ).rejects.toThrow(
      `--api-base=http://127.0.0.1:${DEFAULT_SERVER_PORT} if a remote Station is your default.`,
    );
  });

  test('applies the same trust derivation when a Station is addressed implicitly (default profile), not only via --station', async () => {
    upsertProfile({
      name: 'nightly-local',
      endpoint: NIGHTLY_API_BASE,
      environmentId: NIGHTLY_HOME_IDENTITY.environmentId,
      setupSource: 'local',
      configurationState: 'configured',
      localService: {
        instanceId: 'nightly-instance',
        baseDir: NIGHTLY_HOME,
        serverPort: 38141,
        uiPort: 38142,
      },
      makeDefault: true,
    });
    const request = makeServerAccessApi(NIGHTLY_HOME_IDENTITY, []);

    await runEnvironmentCommand(['access', 'list'], {
      createService: vi.fn(
        makeHomeAwareService({
          [DEFAULT_HOME]: DEFAULT_HOME_IDENTITY,
          [NIGHTLY_HOME]: NIGHTLY_HOME_IDENTITY,
        }),
      ),
      projectHome: DEFAULT_HOME,
      request,
      stdout,
      stderr,
      isInteractive: false,
    });

    expect(request).toHaveBeenCalledWith(
      NIGHTLY_API_BASE,
      '/api/pairing/requests',
      expect.anything(),
    );
  });

  describe('approve/deny name the resolved Station (station#4515 review M6)', () => {
    function pendingRequest() {
      return {
        requestId: 'request-nightly',
        deviceName: 'Nightly test device',
        source: 'same-origin' as const,
        createdAt: 10,
        expiresAt: 20,
        status: 'pending' as const,
      };
    }

    function seedNightlyLocalProfile() {
      upsertProfile({
        name: 'nightly-local',
        endpoint: NIGHTLY_API_BASE,
        environmentId: NIGHTLY_HOME_IDENTITY.environmentId,
        setupSource: 'local',
        configurationState: 'configured',
        localService: {
          instanceId: 'nightly-instance',
          baseDir: NIGHTLY_HOME,
          serverPort: 38141,
          uiPort: 38142,
        },
      });
    }

    function homeAwareCreateService() {
      return vi.fn(
        makeHomeAwareService({
          [DEFAULT_HOME]: DEFAULT_HOME_IDENTITY,
          [NIGHTLY_HOME]: NIGHTLY_HOME_IDENTITY,
        }),
      );
    }

    test('a --station approve past a real pending request names the resolved Station in the success JSON (L8: end-to-end, not just "no actionable requests")', async () => {
      seedNightlyLocalProfile();
      const pending = pendingRequest();
      const request = makeServerAccessApi(NIGHTLY_HOME_IDENTITY, [pending], {
        ...pending,
        status: 'confirmed',
      });

      await runEnvironmentCommand(
        ['access', 'approve', '--station=nightly-local', '--force'],
        {
          createService: homeAwareCreateService(),
          projectHome: DEFAULT_HOME,
          request,
          stdout,
          stderr,
          isInteractive: false,
        },
      );

      expect(stdout).toHaveBeenCalledWith(
        JSON.stringify(
          {
            requestId: pending.requestId,
            deviceName: pending.deviceName,
            source: pending.source,
            status: 'confirmed',
            station: {
              name: 'nightly-local',
              apiBase: NIGHTLY_API_BASE,
              resolvedVia: 'station-flag',
            },
          },
          null,
          2,
        ),
      );
    });

    test('names the resolved Station in the interactive confirmation prompt', async () => {
      seedNightlyLocalProfile();
      const pending = pendingRequest();
      const request = makeServerAccessApi(NIGHTLY_HOME_IDENTITY, [pending], {
        ...pending,
        status: 'confirmed',
      });
      const confirm = vi.fn().mockResolvedValue(true);

      await runEnvironmentCommand(
        ['access', 'approve', '--station=nightly-local'],
        {
          createService: homeAwareCreateService(),
          projectHome: DEFAULT_HOME,
          request,
          stdout,
          stderr,
          isInteractive: true,
          confirm,
        },
      );

      expect(confirm).toHaveBeenCalledWith(
        expect.stringContaining('on Station "nightly-local" (--station)?'),
      );
    });

    test('pins the --station rerun-hint branch for a non-interactive approve without --force (L8)', async () => {
      seedNightlyLocalProfile();
      const pending = pendingRequest();
      const request = makeServerAccessApi(NIGHTLY_HOME_IDENTITY, [pending]);

      await expect(
        runEnvironmentCommand(
          ['access', 'approve', '--station=nightly-local'],
          {
            createService: homeAwareCreateService(),
            projectHome: DEFAULT_HOME,
            request,
            stdout,
            stderr,
            isInteractive: false,
          },
        ),
      ).rejects.toThrow(
        `Rerun: station environment access approve ${pending.requestId} --force --station=nightly-local`,
      );
    });
  });

  describe('usage-honesty audit: every advertised flag for access list/approve/deny/request parses', () => {
    const FAMILY_LINE_PATTERN =
      /^ {2}station environment access (list|approve|deny|request)\b(.*)$/;
    // A REAL, loopback, identity-matching profile WITH a recorded
    // `localService.baseDir` — not a nonexistent name, and not a
    // baseDir-less one either. A nonexistent profile fails inside
    // `resolveApiBaseDetailed` before ever reaching a verb's own flag
    // allow-list (proven live: injecting the pre-fix rejection back into
    // `list`'s allow-list did NOT redden this audit until a real profile was
    // seeded here). A baseDir-less profile is refused by the H1 shape gate
    // before reaching that allow-list too — this profile must clear BOTH to
    // exercise the flag parser the audit is actually checking.
    const AUDIT_STATION_NAME = 'usage-audit-station';
    const AUDIT_STATION_HOME = '/tmp/usage-audit-station-home';
    const VALUE_SAMPLE: Record<string, string> = {
      'api-base': 'http://127.0.0.1:1',
      station: AUDIT_STATION_NAME,
      'device-name': 'usage-audit-device',
      timeout: '5',
    };

    async function liveUsageText(): Promise<string> {
      try {
        await runEnvironmentCommand(['not-a-real-verb'], {
          projectHome: '/tmp/station-home',
          stdout,
          stderr,
          isInteractive: false,
        });
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('Expected the unknown-verb invocation to reject.');
    }

    // station#4515 review NEW-5: this only checks one direction — every
    // flag the USAGE text advertises actually parses. It does NOT check the
    // reverse (every flag a verb actually accepts is advertised in USAGE);
    // that would need enumerating each verb's private `allowedFlags` set,
    // which this audit deliberately treats as opaque and drives only
    // through the USAGE text it can observe from the outside.
    test('every flag the family USAGE text advertises is recognized, not rejected to help', async () => {
      upsertProfile({
        name: AUDIT_STATION_NAME,
        endpoint: 'http://127.0.0.1:1',
        environmentId: INITIAL.environmentId,
        setupSource: 'local',
        configurationState: 'configured',
        localService: {
          instanceId: 'usage-audit-instance',
          baseDir: AUDIT_STATION_HOME,
          serverPort: 1,
          uiPort: 2,
        },
      });
      const usage = await liveUsageText();
      const cases: Array<{ verb: string; flag: string; args: string[] }> = [];

      for (const line of usage.split('\n')) {
        const match = FAMILY_LINE_PATTERN.exec(line);
        if (!match) continue;
        const verb = match[1]!;
        const flagNames = new Set(
          Array.from(line.matchAll(/--([a-z][a-z0-9-]*)/g), (m) => m[1]!),
        );
        for (const flag of flagNames) {
          const valued = line.includes(`--${flag}=`);
          const flagArg = valued
            ? `--${flag}=${VALUE_SAMPLE[flag] ?? 'sample-value'}`
            : `--${flag}`;
          const args =
            verb === 'request' && flag !== 'api-base'
              ? ['access', verb, '--api-base=http://127.0.0.1:1', flagArg]
              : ['access', verb, flagArg];
          cases.push({ verb, flag, args });
        }
      }

      // Guards the audit itself: if a future USAGE reformat stops matching
      // FAMILY_LINE_PATTERN, this fails loudly instead of silently auditing
      // nothing. New flags on these four verbs are picked up automatically;
      // a newly-added verb to the family needs a pattern update here too.
      expect(cases.map((c) => `${c.verb}:${c.flag}`).sort()).toEqual(
        [
          'list:api-base',
          'list:station',
          'approve:latest',
          'approve:force',
          'approve:api-base',
          'approve:station',
          'deny:latest',
          'deny:force',
          'deny:api-base',
          'deny:station',
          'request:api-base',
          'request:station',
          'request:device-name',
          'request:timeout',
          'request:force',
        ].sort(),
      );

      for (const { verb, flag, args } of cases) {
        const request = makeAccessApi([]);
        let message: string | undefined;
        try {
          await runEnvironmentCommand(args, {
            createService: () => makeService(),
            projectHome: '/tmp/station-home',
            request,
            pairing: {
              requestAccess: vi
                .fn()
                .mockRejectedValue(new Error('usage-audit-network-stop')),
            },
            stdout: () => {},
            stderr: () => {},
            isInteractive: false,
          });
        } catch (error) {
          message = (error as Error).message;
        }
        expect(
          message,
          `${verb} ${flag} (args: ${args.join(' ')}) is advertised in USAGE but fell to the generic help text — it does not actually parse`,
        ).not.toBe(usage);
      }
    });
  });
});

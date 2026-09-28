/**
 * #1796: the operator's device-access verbs through `runEnvironmentCommand`,
 * on the real host operator channel (loopback listener proof, then the
 * home's operator credential). Station's HTTP answers are scripted, the way
 * the sibling `access list/approve` tests script them; the real routes and
 * a real Station are exercised in the isolated-instance verification.
 */
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildStationProofMessage,
  PAIRING_SCOPE_DESCRIPTIONS,
  PUBLIC_STATION_PROOF_PATH,
  STATION_PROOF_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type EnvironmentSecurityServiceLike,
  runEnvironmentCommand,
} from '../commands/environment.js';

type OperatorJsonRequest = NonNullable<
  Parameters<typeof runEnvironmentCommand>[1]['request']
>;

const HOME = {
  schemaVersion: 1 as const,
  environmentId: '33333333-3333-4333-8333-333333333333',
  credential: 'operator-secret-that-must-not-leak',
};
const API = 'http://127.0.0.1:47811';

function makeService(): EnvironmentSecurityServiceLike {
  return {
    initialize: vi.fn().mockResolvedValue(HOME),
    readExistingRecord: vi.fn().mockResolvedValue(HOME),
    rotateCredential: vi.fn(),
    resetEnvironment: vi.fn(),
  };
}

function proofResponse(init?: RequestInit): Record<string, unknown> {
  const body = JSON.parse(String(init?.body)) as { nonce: string };
  return {
    protocolVersion: STATION_PROOF_PROTOCOL_VERSION,
    environmentId: HOME.environmentId,
    nonce: body.nonce,
    signature: createHmac('sha256', Buffer.from(HOME.credential, 'base64url'))
      .update(buildStationProofMessage(HOME.environmentId, body.nonce))
      .digest('base64url'),
  };
}

const DEVICES = [
  {
    id: 'aaaa1111-0000-4000-8000-000000000001',
    name: 'Laptop CLI',
    scope: 'orchestration:read orchestration:operate terminal:operate',
    kind: 'device',
    createdAt: 1,
    lastUsedAt: Date.UTC(2026, 8, 27, 12),
    revokedAt: null,
  },
  {
    id: 'aaaa2222-0000-4000-8000-000000000002',
    name: 'Phone',
    scope: 'orchestration:read orchestration:operate',
    kind: 'device',
    createdAt: 2,
    revokedAt: null,
  },
  {
    id: 'bbbb3333-0000-4000-8000-000000000003',
    name: 'Phone',
    scope: 'orchestration:read',
    kind: 'device',
    createdAt: 3,
    revokedAt: null,
  },
  {
    id: 'cccc4444-0000-4000-8000-000000000004',
    name: 'Old tablet',
    scope: 'orchestration:read',
    kind: 'device',
    createdAt: 4,
    revokedAt: 5,
  },
];

function station(
  onScope: (deviceId: string, body: Record<string, unknown>) => unknown = (
    deviceId,
    body,
  ) => ({
    ...DEVICES.find((device) => device.id === deviceId),
    scope: (body.scope as string[]).join(' '),
  }),
) {
  return vi
    .fn<OperatorJsonRequest>()
    .mockImplementation(async (_apiBase, path, init) => {
      if (path === '/.well-known/station/v1')
        return { environmentId: HOME.environmentId };
      if (path === PUBLIC_STATION_PROOF_PATH) return proofResponse(init);
      if (path === '/api/pairing/devices') return { devices: DEVICES };
      const scope = /^\/api\/pairing\/devices\/([^/]+)\/scope$/.exec(path);
      if (scope && init?.method === 'POST')
        return onScope(
          decodeURIComponent(scope[1]!),
          JSON.parse(String(init.body)) as Record<string, unknown>,
        );
      throw new Error(`Unexpected test request: ${path}`);
    });
}

describe('station environment access devices / scope / scopes (#1796)', () => {
  const stdout = vi.fn();
  const stderr = vi.fn();
  beforeEach(() => {
    stdout.mockReset();
    stderr.mockReset();
  });
  const run = (args: string[], request: OperatorJsonRequest) =>
    runEnvironmentCommand(['access', ...args, `--api-base=${API}`], {
      createService: () => makeService(),
      projectHome: '/tmp/station-home',
      request,
      stdout,
      stderr,
      isInteractive: false,
    });
  const printed = () => stdout.mock.calls.map((call) => call[0]).join('\n');

  test('lists the live paired devices with scopes and last seen, as the operator', async () => {
    const request = station();
    await run(['devices', '--json'], request);
    expect(request).toHaveBeenCalledWith(
      API,
      '/api/pairing/devices',
      expect.objectContaining({
        headers: { Authorization: `Bearer ${HOME.credential}` },
      }),
    );
    const listed = JSON.parse(printed()) as {
      devices: Array<Record<string, unknown>>;
    };
    expect(listed.devices.map((device) => device.name)).toEqual([
      'Laptop CLI',
      'Phone',
      'Phone',
    ]);
    expect(listed.devices[0]).toMatchObject({
      id: DEVICES[0]!.id,
      lastSeenAt: '2026-09-27T12:00:00.000Z',
      scopes: [
        'orchestration:read',
        'orchestration:operate',
        'terminal:operate',
      ],
    });
    expect(printed()).not.toContain(HOME.credential);
  });

  test('adds a scope by unique id prefix, computed from the current scope and sent with expectedScope', async () => {
    const request = station();
    await run(['scope', 'aaaa1111', '--add=approval:full-access'], request);
    expect(request).toHaveBeenCalledWith(
      API,
      `/api/pairing/devices/${DEVICES[0]!.id}/scope`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          scope: [
            'orchestration:read',
            'orchestration:operate',
            'terminal:operate',
            'approval:full-access',
          ],
          expectedScope: DEVICES[0]!.scope,
        }),
      }),
    );
    expect(printed()).toContain(
      'before: orchestration:read orchestration:operate terminal:operate',
    );
    expect(printed()).toContain(
      'after:  orchestration:read orchestration:operate terminal:operate approval:full-access',
    );
  });

  test('removes and sets, by exact name, in the vocabulary’s order', async () => {
    const request = station();
    await run(
      ['scope', 'Laptop CLI', '--set=approval:full-access,orchestration:read'],
      request,
    );
    const post = request.mock.calls.find(([, path]) =>
      path.endsWith('/scope'),
    )!;
    expect(JSON.parse(String(post[2]?.body))).toEqual({
      scope: ['orchestration:read', 'approval:full-access'],
      expectedScope: DEVICES[0]!.scope,
    });
    stdout.mockReset();
    await run(['scope', 'Laptop CLI', '--remove=terminal:operate'], station());
    expect(printed()).toContain(
      'after:  orchestration:read orchestration:operate',
    );
  });

  test('an ambiguous name or prefix is refused before anything is changed', async () => {
    for (const selector of ['Phone', 'aaaa']) {
      const request = station();
      await expect(
        run(['scope', selector, '--add=approval:full-access'], request),
      ).rejects.toThrow(/matches more than one paired device/);
      expect(
        request.mock.calls.some(([, path]) => path.endsWith('/scope')),
      ).toBe(false);
    }
    // A revoked device is not a candidate, and nothing matches.
    await expect(
      run(['scope', 'Old tablet', '--add=approval:full-access'], station()),
    ).rejects.toThrow(/No paired device matches/);
  });

  test('G4: precedence is exact id, then a unique id prefix, then an exact name', async () => {
    // One device is NAMED like another device's id prefix. The prefix must
    // win: a name is chosen by whoever paired the device, so it must never
    // redirect a scope change aimed at another device's id.
    const impostor = {
      id: 'dddd5555-0000-4000-8000-000000000005',
      name: 'aaaa1111',
      scope: 'orchestration:read',
      kind: 'device',
      createdAt: 5,
      revokedAt: null,
    };
    const request = vi
      .fn<OperatorJsonRequest>()
      .mockImplementation(async (_apiBase, path, init) => {
        if (path === '/.well-known/station/v1')
          return { environmentId: HOME.environmentId };
        if (path === PUBLIC_STATION_PROOF_PATH) return proofResponse(init);
        if (path === '/api/pairing/devices')
          return { devices: [...DEVICES, impostor] };
        const scope = /^\/api\/pairing\/devices\/([^/]+)\/scope$/.exec(path);
        if (scope && init?.method === 'POST') {
          const id = decodeURIComponent(scope[1]!);
          const body = JSON.parse(String(init.body)) as { scope: string[] };
          const device = [...DEVICES, impostor].find((d) => d.id === id)!;
          return { ...device, scope: body.scope.join(' ') };
        }
        throw new Error(`Unexpected test request: ${path}`);
      });
    await run(['scope', 'aaaa1111', '--add=approval:full-access'], request);
    const posted = request.mock.calls
      .filter(([, path]) => path.endsWith('/scope'))
      .map(([, path]) => path);
    expect(posted).toEqual([`/api/pairing/devices/${DEVICES[0]!.id}/scope`]);
    // And an exact id beats a device whose name is that id.
    request.mockClear();
    impostor.name = DEVICES[1]!.id;
    await run(['scope', DEVICES[1]!.id, '--add=approval:full-access'], request);
    expect(
      request.mock.calls
        .filter(([, path]) => path.endsWith('/scope'))
        .map(([, path]) => path),
    ).toEqual([`/api/pairing/devices/${DEVICES[1]!.id}/scope`]);
  });

  test('an unknown or ungrantable scope is refused before any Station is contacted', async () => {
    for (const flag of [
      '--add=approval:everything',
      '--set=access:manage',
      '--add=access:manage',
    ]) {
      const request = station();
      await expect(run(['scope', 'aaaa1111', flag], request)).rejects.toThrow(
        flag.includes('everything')
          ? /Unknown scope "approval:everything"/
          : /cannot be granted to a device/,
      );
      expect(request).not.toHaveBeenCalled();
    }
    for (const args of [
      [
        'scope',
        'aaaa1111',
        '--add=approval:full-access',
        '--remove=coding:exec',
      ],
      ['scope', 'aaaa1111'],
    ]) {
      const request = station();
      await expect(run(args, request)).rejects.toThrow(
        /exactly one of --add, --remove, or --set/,
      );
      expect(request).not.toHaveBeenCalled();
    }
  });

  test('G3: removing full access prints what was reset and what stays at full access', async () => {
    const request = station((deviceId, body) => ({
      ...DEVICES.find((device) => device.id === deviceId),
      scope: (body.scope as string[]).join(' '),
      fullAccessRevocation: {
        cause: 'scope-removed',
        reset: [{ conversationId: 'conversation:a', was: 'never' }],
        stillFullAccess: [
          {
            conversationId: 'conversation:b',
            title: 'Fix the \u001b[31mbuild',
            reason: 'agent-default',
          },
        ],
        reconfined: [{ conversationId: 'conversation:a' }],
        stillUnconfined: [
          { conversationId: 'conversation:c', until: 'engine-restart' },
        ],
        unattributedHostStarts: {
          sessions: [
            {
              conversationId: 'older-\u001b[31m',
              startedAt: '2026-09-01T00:00:00.000Z',
            },
          ],
          total: 3,
        },
      },
    }));
    await run(['scope', 'aaaa1111', '--remove=terminal:operate'], request);
    expect(printed()).toContain(
      'Reset to Ask (a turn already running finishes first; the next one asks):\n  conversation:a  was: its full-access decision',
    );
    expect(printed()).toContain(
      'Still at full access, not changed:\n  "Fix the [31mbuild" conversation:b  because of the Agent\'s default approval mode',
    );
    expect(printed()).toContain(
      '  older-\\u001b[31m  started 2026-09-01T00:00:00.000Z',
    );
    expect(printed()).toContain('  … and 2 more (3 in all).');
    expect(printed()).toContain(
      'Re-confined from its next turn (runs inside the workspace again):\n  conversation:a',
    );
    expect(printed()).toContain(
      'Still unconfined, not changed:\n  conversation:c  because its engine is running with no decision to re-apply',
    );
    expect(printed()).not.toContain('\u001b');
  });

  test('G3: a conversation title loses its bidi and zero-width characters', async () => {
    // RLO reverses what follows; LRI/PDI isolate; ZWSP/ZWJ are invisible.
    // Left in, a title could read as another conversation's.
    const hostile = '\u202Edliub eht xiF\u202C \u2066ops\u2069\u200B\u200D';
    const request = station((deviceId, body) => ({
      ...DEVICES.find((device) => device.id === deviceId),
      scope: (body.scope as string[]).join(' '),
      fullAccessRevocation: {
        cause: 'scope-removed',
        reset: [
          { conversationId: 'conversation:a', title: hostile, was: 'never' },
          // Nothing visible left: listed by id alone.
          { conversationId: 'conversation:z', title: '\u200B\u2067\u2069', was: 'never' },
        ],
        stillFullAccess: [],
        reconfined: [],
        stillUnconfined: [],
        unattributedHostStarts: { sessions: [], total: 0 },
      },
    }));
    await run(['scope', 'aaaa1111', '--remove=terminal:operate'], request);
    expect(printed()).toContain(
      '  "dliub eht xiF ops" conversation:a  was: its full-access decision',
    );
    expect(printed()).toContain(
      '\n  conversation:z  was: its full-access decision',
    );
    expect(printed()).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/u);
    expect(printed()).not.toMatch(/\\u(200[b-f]|202[a-e]|206[6-9])/iu);
  });

  test('G3: a reset that failed on the Station is an error, after the scope change', async () => {
    const request = station((deviceId, body) => ({
      ...DEVICES.find((device) => device.id === deviceId),
      scope: (body.scope as string[]).join(' '),
      fullAccessRevocationError: 'reset_failed',
    }));
    await expect(
      run(['scope', 'aaaa1111', '--remove=terminal:operate'], request),
    ).rejects.toThrow(/could not reset the conversations/);
  });

  test('H3: --remove approval:full-access on a device that no longer holds it re-runs the reset', async () => {
    const request = station((deviceId, body) => ({
      ...DEVICES.find((device) => device.id === deviceId),
      scope: (body.scope as string[]).join(' '),
      fullAccessRevocation: {
        cause: 'scope-removed',
        reset: [{ conversationId: 'conversation:a', was: 'never' }],
        stillFullAccess: [],
        reconfined: [],
        stillUnconfined: [],
        unattributedHostStarts: { sessions: [], total: 0 },
      },
    }));
    await run(['scope', 'aaaa1111', '--remove=approval:full-access'], request);
    const post = request.mock.calls.find(([, path]) =>
      path.endsWith('/scope'),
    )!;
    expect(JSON.parse(String(post[2]?.body))).toEqual({
      scope: [
        'orchestration:read',
        'orchestration:operate',
        'terminal:operate',
      ],
      expectedScope: DEVICES[0]!.scope,
      resetFullAccess: true,
    });
    expect(printed()).toContain('resetting the conversations');
    expect(printed()).toContain(
      'conversation:a  was: its full-access decision',
    );
    // Any other no-op change still sends nothing.
    const quiet = station();
    stdout.mockReset();
    await run(['scope', 'aaaa1111', '--remove=coding:exec'], quiet);
    expect(printed()).toContain('No change.');
    expect(quiet.mock.calls.some(([, path]) => path.endsWith('/scope'))).toBe(
      false,
    );
  });

  test('a dry run prints the change and sends nothing', async () => {
    const request = station();
    await run(
      ['scope', 'aaaa1111', '--add=approval:full-access', '--dry-run'],
      request,
    );
    expect(printed()).toContain('Dry run: nothing was changed.');
    expect(request.mock.calls.some(([, path]) => path.endsWith('/scope'))).toBe(
      false,
    );
  });

  test('a concurrent change is refused, not overwritten', async () => {
    const request = station(() => {
      throw Object.assign(
        new Error('Station request failed with HTTP 409: scope_changed'),
        { status: 409, code: 'scope_changed' },
      );
    });
    await expect(
      run(['scope', 'aaaa1111', '--add=approval:full-access'], request),
    ).rejects.toThrow(
      /access changed since it was read.*Nothing was overwritten/,
    );
  });

  test('a concurrent change answered by a real HTTP Station keeps its code through the default request path', async () => {
    const posts: unknown[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const reply = (status: number, body: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.url === '/.well-known/station/v1')
          return reply(200, { environmentId: HOME.environmentId });
        if (req.url === PUBLIC_STATION_PROOF_PATH)
          return reply(200, proofResponse({ body: raw }));
        if (req.url === '/api/pairing/devices')
          return reply(200, { devices: DEVICES });
        if (req.url?.endsWith('/scope') && req.method === 'POST') {
          posts.push(JSON.parse(raw));
          return reply(409, { error: 'scope_changed' });
        }
        return reply(404, { error: 'not_found' });
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      await expect(
        runEnvironmentCommand(
          [
            'access',
            'scope',
            'aaaa1111',
            '--add=approval:full-access',
            `--api-base=http://127.0.0.1:${port}`,
          ],
          {
            createService: () => makeService(),
            projectHome: '/tmp/station-home',
            stdout,
            stderr,
            isInteractive: false,
          },
        ),
      ).rejects.toThrow(
        /access changed since it was read.*Nothing was overwritten/,
      );
      expect(posts).toEqual([
        {
          scope: [
            'orchestration:read',
            'orchestration:operate',
            'terminal:operate',
            'approval:full-access',
          ],
          expectedScope: DEVICES[0]!.scope,
        },
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('a non-loopback Station (a paired remote CLI) is refused before any credential is read', async () => {
    const request = station();
    const createService = vi.fn(() => makeService());
    await expect(
      runEnvironmentCommand(
        [
          'access',
          'scope',
          'aaaa1111',
          '--add=approval:full-access',
          '--api-base=https://station.example.test',
        ],
        {
          createService,
          projectHome: '/tmp/station-home',
          request,
          stdout,
          stderr,
          isInteractive: false,
        },
      ),
    ).rejects.toThrow(
      /Operator access commands \(access list\/approve\/deny\/devices\/scope\) require a loopback --api-base/,
    );
    expect(request).not.toHaveBeenCalled();
    expect(createService).not.toHaveBeenCalled();
  });

  test('lists every scope with its meaning, from the contracts', async () => {
    await runEnvironmentCommand(['access', 'scopes', '--json'], {
      projectHome: '/tmp/station-home-unused',
      stdout,
      stderr,
      isInteractive: false,
    });
    const listed = JSON.parse(printed()) as {
      scopes: Array<{ scope: string; meaning: string; grantable: boolean }>;
    };
    expect(listed.scopes).toContainEqual({
      scope: 'approval:full-access',
      label: 'Allow full access',
      meaning: PAIRING_SCOPE_DESCRIPTIONS['approval:full-access'].summary,
      grantable: true,
    });
    expect(
      listed.scopes.find((row) => row.scope === 'access:manage')?.grantable,
    ).toBe(false);
  });
});

describe('a full-access refusal as the CLI prints it (#1796)', () => {
  test('an older Station without details keeps its words, made terminal-safe', async () => {
    const { describeCliError } = await import('../cli.js');
    const refusal = Object.assign(
      new Error('Full access was not applied for "\x1b[31mRED\x1b[0m".'),
      { code: 'approval-full-access-not-granted', status: 403 },
    );
    const printed = describeCliError(refusal);
    expect(printed).toContain('\\u001b[31mRED');
    expect(printed).not.toContain('\x1b');
    expect(printed).toMatch(
      /Refused by the Station (at \S+|this command targeted)/,
    );
    expect(printed).toContain('Nothing was sent at another approval mode.');
    // Any other failure keeps its own rendering.
    expect(describeCliError(new Error('boom'))).not.toContain('Refused by');
  });

  test('an Agent is told no grant exists', async () => {
    const { describeCliError } = await import('../cli.js');
    const printed = describeCliError(
      Object.assign(new Error('x'), {
        code: 'approval-full-access-not-granted',
        details: {
          requested: 'never',
          requester: { kind: 'agent' },
          station: {},
          grant: null,
        },
      }),
    );
    expect(printed).toContain('An agent can never put itself');
    expect(printed).not.toContain('station environment access scope');
  });
});

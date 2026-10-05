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
          {
            conversationId: 'conversation:d',
            sessionId: 'session:d',
            until: 'next-turn',
          },
          // An older Station's answer (before #2898).
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
      'Still unconfined:\n  conversation:d  because its engine is running: a turn already running finishes unconfined, and its next turn runs confined\n  conversation:c  because its engine is running with no decision to re-apply',
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
          {
            conversationId: 'conversation:z',
            title: '\u200B\u2067\u2069',
            was: 'never',
          },
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
      /Operator access commands \(access list\/approve\/deny\/devices\/scope\/revoke\/remove\) require a loopback --api-base/,
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

describe('station environment access revoke / remove (#3256)', () => {
  const stdout = vi.fn();
  const stderr = vi.fn();
  const REVOKED_AT = Date.UTC(2026, 9, 5);
  // A revoked tablet and a live one that share a name, so `remove` and
  // `revoke` each see only their own side of the list.
  const LIVE = DEVICES.filter((device) => device.revokedAt === null);
  const OLD = DEVICES[3]!;
  beforeEach(() => {
    stdout.mockReset();
    stderr.mockReset();
  });
  const printed = () => stdout.mock.calls.map((call) => call[0]).join('\n');

  function host(
    answer: (verb: 'revoke' | 'remove', deviceId: string) => unknown = (
      verb,
      deviceId,
    ) => ({
      ...DEVICES.find((device) => device.id === deviceId),
      revokedAt: verb === 'revoke' ? REVOKED_AT : OLD.revokedAt,
    }),
  ) {
    return vi
      .fn<OperatorJsonRequest>()
      .mockImplementation(async (_apiBase, path, init) => {
        if (path === '/.well-known/station/v1')
          return { environmentId: HOME.environmentId };
        if (path === PUBLIC_STATION_PROOF_PATH) return proofResponse(init);
        if (path === '/api/pairing/devices') return { devices: DEVICES };
        const match = /^\/api\/pairing\/devices\/([^/]+)(\/record)?$/.exec(
          path,
        );
        if (match && init?.method === 'DELETE')
          return answer(
            match[2] ? 'remove' : 'revoke',
            decodeURIComponent(match[1]!),
          );
        throw new Error(`Unexpected test request: ${path}`);
      });
  }
  const deletes = (request: ReturnType<typeof host>) =>
    request.mock.calls
      .filter(([, , init]) => init?.method === 'DELETE')
      .map(([, path]) => path);
  const run = (
    args: string[],
    request: OperatorJsonRequest,
    extra: {
      isInteractive?: boolean;
      confirm?: (question: string) => Promise<boolean>;
      apiBase?: string;
    } = {},
  ) =>
    runEnvironmentCommand(
      ['access', ...args, `--api-base=${extra.apiBase ?? API}`],
      {
        createService: () => makeService(),
        projectHome: '/tmp/station-home',
        request,
        stdout,
        stderr,
        isInteractive: extra.isInteractive ?? false,
        ...(extra.confirm ? { confirm: extra.confirm } : {}),
      },
    );

  test('revoke deletes the device chosen by id prefix, as the operator, and says what happened', async () => {
    const request = host();
    await run(['revoke', 'aaaa1111', '--force'], request);
    expect(request).toHaveBeenCalledWith(
      API,
      `/api/pairing/devices/${LIVE[0]!.id}`,
      expect.objectContaining({
        method: 'DELETE',
        headers: { Authorization: `Bearer ${HOME.credential}` },
      }),
    );
    expect(deletes(request)).toEqual([`/api/pairing/devices/${LIVE[0]!.id}`]);
    expect(printed()).toContain('Laptop CLI');
    expect(printed()).toContain('Revoked.');
  });

  test('revoke prints what its full-access reset did', async () => {
    const request = host((_verb, deviceId) => ({
      ...DEVICES.find((device) => device.id === deviceId),
      revokedAt: REVOKED_AT,
      fullAccessRevocation: {
        cause: 'device-revoked',
        reset: [{ conversationId: 'conversation:a', was: 'never' }],
        stillFullAccess: [],
      },
    }));
    await run(['revoke', 'Laptop CLI', '--force'], request);
    expect(printed()).toContain('conversation:a');
    stdout.mockReset();
    const failed = host((_verb, deviceId) => ({
      ...DEVICES.find((device) => device.id === deviceId),
      revokedAt: REVOKED_AT,
      fullAccessRevocationError: 'reset_failed',
    }));
    await expect(
      run(['revoke', 'Laptop CLI', '--force'], failed),
    ).rejects.toThrow(/The device was revoked, but Station could not reset/);
  });

  test('remove deletes only the record of a revoked device', async () => {
    const request = host();
    await run(['remove', 'Old tablet', '--force'], request);
    expect(request).toHaveBeenCalledWith(
      API,
      `/api/pairing/devices/${OLD.id}/record`,
      expect.objectContaining({
        method: 'DELETE',
        headers: { Authorization: `Bearer ${HOME.credential}` },
      }),
    );
    expect(deletes(request)).toEqual([`/api/pairing/devices/${OLD.id}/record`]);
    expect(printed()).toContain('Removed the revoked record.');
  });

  test('a device that is still paired is neither a remove candidate nor a revoked one', async () => {
    const request = host();
    await expect(
      run(['remove', 'aaaa1111', '--force'], request),
    ).rejects.toThrow(
      /No revoked device record matches "aaaa1111".*access revoke <device>/,
    );
    await expect(
      run(['revoke', 'Old tablet', '--force'], request),
    ).rejects.toThrow(/No paired device matches "Old tablet"/);
    expect(deletes(request)).toEqual([]);
  });

  test('an ambiguous name or prefix is refused before anything is deleted', async () => {
    for (const selector of ['Phone', 'aaaa']) {
      const request = host();
      await expect(
        run(['revoke', selector, '--force'], request),
      ).rejects.toThrow(/matches more than one paired device/);
      expect(deletes(request)).toEqual([]);
    }
    const twin = { ...OLD, id: 'cccc5555-0000-4000-8000-000000000005' };
    const request = vi
      .fn<OperatorJsonRequest>()
      .mockImplementation(async (_apiBase, path, init) => {
        if (path === '/.well-known/station/v1')
          return { environmentId: HOME.environmentId };
        if (path === PUBLIC_STATION_PROOF_PATH) return proofResponse(init);
        if (path === '/api/pairing/devices') return { devices: [OLD, twin] };
        throw new Error(`Unexpected test request: ${path}`);
      });
    await expect(run(['remove', 'cccc', '--force'], request)).rejects.toThrow(
      /matches more than one paired device/,
    );
  });

  test('a mismatched or unrevoked answer is refused, not reported as done', async () => {
    await expect(
      run(
        ['revoke', 'Laptop CLI', '--force'],
        host(() => ({ ...DEVICES[1]!, revokedAt: REVOKED_AT })),
      ),
    ).rejects.toThrow(/mismatched device after the revoke/);
    await expect(
      run(
        ['revoke', 'Laptop CLI', '--force'],
        host((_verb, deviceId) => ({
          ...DEVICES.find((device) => device.id === deviceId),
          revokedAt: null,
        })),
      ),
    ).rejects.toThrow(/mismatched device after the revoke/);
    await expect(
      run(
        ['remove', 'Old tablet', '--force'],
        host(() => ({ ...DEVICES[1]!, revokedAt: REVOKED_AT })),
      ),
    ).rejects.toThrow(/mismatched device after the record removal/);
    expect(printed()).not.toContain('Revoked.');
    expect(printed()).not.toContain('Removed');
  });

  test('without --force a non-interactive run is refused before any Station is contacted', async () => {
    for (const args of [
      ['revoke', 'aaaa1111'],
      ['remove', 'Old tablet'],
    ]) {
      const request = host();
      await expect(run(args, request)).rejects.toThrow(
        /is destructive and requires --force when stdin is non-interactive/,
      );
      expect(request).not.toHaveBeenCalled();
    }
  });

  test('an interactive run names the device in the question and deletes only on yes', async () => {
    const answers = [false, true];
    const confirm = vi.fn(async (_question: string) => answers.shift()!);
    const request = host();
    await expect(
      run(['revoke', 'aaaa1111'], request, { isInteractive: true, confirm }),
    ).rejects.toThrow(/the revoke was not approved/);
    expect(confirm.mock.calls[0]![0]).toContain('Laptop CLI');
    expect(confirm.mock.calls[0]![0]).toContain('cannot be restored');
    expect(deletes(request)).toEqual([]);
    await run(['revoke', 'aaaa1111'], request, {
      isInteractive: true,
      confirm,
    });
    expect(deletes(request)).toEqual([`/api/pairing/devices/${LIVE[0]!.id}`]);

    const removeConfirm = vi.fn(async (_question: string) => false);
    const removeRequest = host();
    await expect(
      run(['remove', 'Old tablet'], removeRequest, {
        isInteractive: true,
        confirm: removeConfirm,
      }),
    ).rejects.toThrow(/the removal was not approved/);
    expect(removeConfirm.mock.calls[0]![0]).toContain('Old tablet');
    expect(deletes(removeRequest)).toEqual([]);
  });

  test('a non-loopback Station is refused before any credential is read', async () => {
    for (const verb of ['revoke', 'remove']) {
      const request = host();
      const createService = vi.fn(() => makeService());
      await expect(
        runEnvironmentCommand(
          [
            'access',
            verb,
            'aaaa1111',
            '--force',
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
      ).rejects.toThrow(/require a loopback --api-base/);
      expect(request).not.toHaveBeenCalled();
      expect(createService).not.toHaveBeenCalled();
    }
  });

  test('a malformed command is a usage error before any Station is contacted', async () => {
    for (const args of [
      ['revoke'],
      ['revoke', 'a', 'b'],
      ['revoke', 'aaaa1111', '--add=terminal:operate'],
      ['remove', 'Old tablet', '--force=yes'],
    ]) {
      const request = host();
      await expect(run(args, request)).rejects.toThrow(/Usage:/);
      expect(request).not.toHaveBeenCalled();
    }
  });

  test('revoke and remove through the default request path against a real loopback Station', async () => {
    const seen: string[] = [];
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
        if (req.method === 'DELETE') {
          seen.push(`${req.method} ${req.url}`);
          const record = req.url!.endsWith('/record');
          return reply(
            200,
            record
              ? OLD
              : { ...LIVE[0], revokedAt: REVOKED_AT, fullAccessRevocation: {} },
          );
        }
        return reply(404, { error: 'not_found' });
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      for (const args of [
        ['revoke', 'aaaa1111', '--force'],
        ['remove', 'Old tablet', '--force'],
      ])
        await runEnvironmentCommand(
          ['access', ...args, `--api-base=http://127.0.0.1:${port}`],
          {
            createService: () => makeService(),
            projectHome: '/tmp/station-home',
            stdout,
            stderr,
            isInteractive: false,
          },
        );
      expect(seen).toEqual([
        `DELETE /api/pairing/devices/${LIVE[0]!.id}`,
        `DELETE /api/pairing/devices/${OLD.id}/record`,
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

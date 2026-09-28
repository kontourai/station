/**
 * #1796: the operator's device-access verbs through `runEnvironmentCommand`,
 * on the real host operator channel (loopback listener proof, then the
 * home's operator credential). Station's HTTP answers are scripted, the way
 * the sibling `access list/approve` tests script them; the real routes and
 * a real Station are exercised in the isolated-instance verification.
 */
import { createHmac } from 'node:crypto';
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
  test('keeps the Station’s words, names the Station that refused, and says nothing was retried', async () => {
    const { describeCliError } = await import('../cli.js');
    const refusal = Object.assign(
      new Error(
        'Full access was not applied. You asked for full access, but only this Station’s operator can allow it, for device "Laptop CLI" (154d4e68).',
      ),
      { code: 'approval-full-access-not-granted', status: 403 },
    );
    const printed = describeCliError(refusal);
    expect(printed).toContain('for device "Laptop CLI" (154d4e68)');
    expect(printed).toMatch(
      /Refused by the Station (at \S+|this command targeted)\./,
    );
    expect(printed).toContain('Nothing was sent at another approval mode.');
    // Any other failure keeps its own rendering.
    expect(describeCliError(new Error('boom'))).not.toContain('Refused by');
  });
});

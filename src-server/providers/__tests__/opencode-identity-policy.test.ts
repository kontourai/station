/**
 * Slice 5: the `opencode` engine's identity and managed policy.
 *
 * - #3355: `OpenCodeAdapter` runs saved ACP connection records, so it never
 *   reserves the ACP `opencode` connection id, whether its Feature Preview is
 *   on or off; it claims a connection for new chats only while it is on.
 * - Ruling R5′: the policy's `acp` entry alone governs OpenCode, for allow,
 *   deny and launch pins, on either provider (`acp`, `opencode`) and either
 *   transport, preview on or off. A policy cannot name `opencode`: it is
 *   refused exactly as on the base (an unknown engine id), because whether
 *   a connection runs OpenCode is read from user-controlled fields.
 */
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import {
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  assertEngineAllowedByManagedPolicy,
  engineAllowedByManagedPolicy,
  installManagedEngineLimits,
  managedEngineLaunch,
  managedEnginePin,
  managedEngineRefusalFor,
} from '../../security/managed-engine-limits.js';
import {
  acpConnectionRuntimeAdapter,
  nativeRuntimeConnectionIds,
} from '../adapter-identity.js';
import type { ProviderAdapterShape } from '../adapter-shape.js';
import { OpenCodeAdapter } from '../adapters/opencode-adapter.js';

const OPENCODE: ACPConnectionConfig = {
  id: 'opencode',
  name: 'OpenCode',
  command: '/opt/opencode/bin/opencode',
  args: ['acp'],
  enabled: true,
};
const CUSTOM_OPENCODE: ACPConnectionConfig = {
  ...OPENCODE,
  id: 'my-opencode',
};
const KIRO: ACPConnectionConfig = {
  id: 'kiro',
  name: 'Kiro',
  command: 'kiro-cli',
  args: ['acp'],
  enabled: true,
};

afterEach(() => installManagedEngineLimits(null));

function install(engines: Record<string, unknown>) {
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    limits: { engines },
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  installManagedEngineLimits({
    document: parsed.document,
    summary: summarizeManagedPolicy(parsed.document),
  });
}

function installAllowed(allowed: string[] | undefined) {
  install(allowed ? { allowed } : {});
}

function adapter(preview: { on: boolean }, overrides = {}) {
  return new OpenCodeAdapter({
    getConnections: async () => [OPENCODE, CUSTOM_OPENCODE, KIRO],
    createAcpAdapter: () =>
      ({
        provider: 'opencode',
        metadata: { displayName: 'inner', description: '', capabilities: [] },
        streamEvents: () => ({ [Symbol.asyncIterator]: () => ({}) }),
        stopAll: async () => undefined,
      }) as unknown as ProviderAdapterShape,
    nativeEnabled: () => preview.on,
    ...overrides,
  });
}

describe('OpenCodeAdapter identity (#3355)', () => {
  test.each([false, true])(
    'never reserves the ACP opencode connection id (preview on: %s)',
    (on) => {
      const ids = nativeRuntimeConnectionIds([adapter({ on })]);
      expect(ids.has('opencode')).toBe(false);
      expect(ids.size).toBe(0);
    },
  );

  test('claims OpenCode connections for new chats only while the preview is on', () => {
    const preview = { on: false };
    const openCode = adapter(preview);
    const adapters = [openCode];
    expect(acpConnectionRuntimeAdapter(adapters, OPENCODE)).toBeUndefined();
    preview.on = true;
    expect(acpConnectionRuntimeAdapter(adapters, OPENCODE)).toBe(openCode);
    expect(acpConnectionRuntimeAdapter(adapters, CUSTOM_OPENCODE)).toBe(
      openCode,
    );
    expect(acpConnectionRuntimeAdapter(adapters, KIRO)).toBeUndefined();
  });
});

describe('managed policy over OpenCode (ruling R5′)', () => {
  test.each([
    [{ allowed: ['opencode'] }, 'limits.engines.allowed[0]'],
    [{ allowed: ['acp', 'opencode'] }, 'limits.engines.allowed[1]'],
    [
      { instances: { opencode: { locked: true, binaryPath: '/x/opencode' } } },
      'limits.engines.instances.opencode',
    ],
  ])(
    'a policy naming opencode is refused as on the base: %j',
    (engines, path) => {
      const parsed = parseManagedPolicyDocument({
        schemaVersion: 1,
        organization: 'Acme',
        limits: { engines },
      });
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? [] : parsed.problems).toEqual(
        expect.arrayContaining([expect.objectContaining({ path })]),
      );
    },
  );

  // [allowed list, OpenCode and every other ACP engine may run]
  const cases: Array<[string[] | undefined, boolean]> = [
    [undefined, true],
    [['acp'], true],
    [['claude'], false],
    [['acp', 'claude'], true],
    [['codex', 'muse'], false],
  ];

  test.each(cases)(
    'allowed %j: the acp entry answers for both providers (%s)',
    (allowed, runs) => {
      installAllowed(allowed);
      // Preview on: a new OpenCode chat runs on `opencode`.
      expect(engineAllowedByManagedPolicy('opencode')).toBe(runs);
      // Preview off, or a chat from before: the same connection on `acp`.
      expect(engineAllowedByManagedPolicy('acp')).toBe(runs);
      for (const engine of ['acp', 'opencode'])
        for (const connection of [OPENCODE, CUSTOM_OPENCODE, KIRO]) {
          const assertion = () =>
            assertEngineAllowedByManagedPolicy(engine, connection);
          if (runs) expect(assertion).not.toThrow();
          else
            expect(assertion).toThrow(
              expect.objectContaining({
                code: 'managed-policy-engine-refused',
                message: expect.stringContaining('acp is not allowed'),
              }),
            );
        }
      expect(managedEngineRefusalFor('opencode')?.message).toBe(
        managedEngineRefusalFor('acp')?.message,
      );
    },
  );

  test('the acp pin is the opencode pin', () => {
    install({
      instances: {
        acp: {
          locked: true,
          binaryPath: '/pinned/opencode',
          environment: { HTTPS_PROXY: 'http://proxy' },
        },
      },
    });
    expect(managedEnginePin('opencode')).toEqual(managedEnginePin('acp'));
    expect(
      managedEngineLaunch(
        'opencode',
        { command: 'opencode', args: [], env: {} },
        'user',
      ),
    ).toEqual({
      command: '/pinned/opencode',
      args: [],
      env: { HTTPS_PROXY: 'http://proxy' },
    });
  });

  function nativeStart(
    preview: { on: boolean },
    acquire: ReturnType<typeof vi.fn>,
    findBinary: (command: string) => Promise<string | null> = async () =>
      OPENCODE.command,
  ) {
    const openCode = adapter(preview, {
      pool: { acquire, stopAll: async () => undefined },
      versionProbe: {
        probe: async () => ({ major: 2, minor: 3, patch: 0, text: '2.3.0' }),
      },
      findBinary,
      binaryIdentity: async () => 'id',
      launchEnv: async () => ({ TMPDIR: '/tmp/x' }),
    });
    return openCode.startSession({
      provider: 'opencode',
      threadId: 't1',
      cwd: '/tmp',
      metadata: { connectionId: 'opencode' },
    });
  }

  test.each([
    [['claude'], false],
    [['acp'], true],
    [['acp', 'claude'], true],
    [['codex'], false],
  ] as const)(
    'a native start under allowed %j runs: %s',
    async (allowed, runs) => {
      installAllowed([...allowed]);
      const acquire = vi.fn(async () => {
        throw new Error('pool reached');
      });
      const start = nativeStart({ on: true }, acquire);
      if (runs) {
        // The policy let it reach the pool; a server that does not start
        // falls back to ACP (this stub's inner adapter cannot start one).
        const outcome = await start.then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(outcome).not.toMatchObject({
          code: 'managed-policy-engine-refused',
        });
        expect(acquire).toHaveBeenCalledTimes(1);
      } else {
        await expect(start).rejects.toMatchObject({
          code: 'managed-policy-engine-refused',
        });
        expect(acquire).not.toHaveBeenCalled();
      }
    },
  );

  test("a native start resolves the acp entry's pinned binary", async () => {
    install({
      allowed: ['acp'],
      instances: { acp: { locked: true, binaryPath: '/pinned/opencode' } },
    });
    const findBinary = vi.fn(async (command: string) => command);
    const acquire = vi.fn(async () => {
      throw new Error('pool reached');
    });
    await nativeStart({ on: true }, acquire, findBinary).catch(() => undefined);
    expect(findBinary).toHaveBeenCalledWith('/pinned/opencode');
    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({ binary: '/pinned/opencode' }),
    );
  });
});

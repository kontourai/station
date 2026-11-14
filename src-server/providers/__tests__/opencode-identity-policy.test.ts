/**
 * Slice 5: the `opencode` engine's identity and managed policy.
 *
 * - #3355: `OpenCodeAdapter` runs saved ACP connection records, so it never
 *   reserves the ACP `opencode` connection id, whether its Feature Preview is
 *   on or off; it claims a connection for new chats only while it is on.
 * - Ruling R5: an `acp` policy entry keeps governing OpenCode, for allow and
 *   deny, unless the policy names `opencode`; and which provider an OpenCode
 *   chat runs on (the preview) never changes the answer.
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

function installAllowed(allowed: string[] | undefined) {
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    limits: { engines: allowed ? { allowed } : {} },
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  installManagedEngineLimits({
    document: parsed.document,
    summary: summarizeManagedPolicy(parsed.document),
  });
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

describe('managed policy over OpenCode (ruling R5)', () => {
  // [allowed list, OpenCode may run, Kiro (another ACP engine) may run]
  const cases: Array<[string[] | undefined, boolean, boolean]> = [
    [undefined, true, true],
    [['acp'], true, true],
    [['claude'], false, false],
    [['opencode'], true, false],
    [['claude', 'opencode'], true, false],
    [['acp', 'opencode'], true, true],
    [['acp', 'claude'], true, true],
  ];

  test.each(cases)(
    'allowed %j: OpenCode %s, Kiro %s, whichever provider runs OpenCode',
    (allowed, openCodeRuns, kiroRuns) => {
      installAllowed(allowed);
      // Preview on: a new OpenCode chat runs on `opencode`.
      expect(engineAllowedByManagedPolicy('opencode', OPENCODE)).toBe(
        openCodeRuns,
      );
      expect(engineAllowedByManagedPolicy('opencode')).toBe(openCodeRuns);
      // Preview off, or a chat from before: the same connection on `acp`.
      expect(engineAllowedByManagedPolicy('acp', OPENCODE)).toBe(openCodeRuns);
      expect(engineAllowedByManagedPolicy('acp', CUSTOM_OPENCODE)).toBe(
        openCodeRuns,
      );
      expect(
        engineAllowedByManagedPolicy('acp', { id: 'x', runsOpenCode: true }),
      ).toBe(openCodeRuns);
      // Another ACP engine never reads the `opencode` entry.
      expect(engineAllowedByManagedPolicy('acp', KIRO)).toBe(kiroRuns);
      const assertion = () =>
        assertEngineAllowedByManagedPolicy('acp', OPENCODE);
      if (openCodeRuns) expect(assertion).not.toThrow();
      else
        expect(assertion).toThrow(
          expect.objectContaining({ code: 'managed-policy-engine-refused' }),
        );
    },
  );

  test.each([
    [['claude'], false],
    [['acp'], true],
    [['claude', 'opencode'], true],
  ] as const)(
    'a native start under allowed %j runs: %s',
    async (allowed, runs) => {
      installAllowed([...allowed]);
      const acquire = vi.fn(async () => {
        throw new Error('pool reached');
      });
      const openCode = adapter(
        { on: true },
        {
          pool: { acquire, stopAll: async () => undefined },
          versionProbe: {
            probe: async () => ({
              major: 2,
              minor: 3,
              patch: 0,
              text: '2.3.0',
            }),
          },
          findBinary: async () => OPENCODE.command,
          binaryIdentity: async () => 'id',
          launchEnv: async () => ({ TMPDIR: '/tmp/x' }),
        },
      );
      const start = openCode.startSession({
        provider: 'opencode',
        threadId: 't1',
        cwd: '/tmp',
        metadata: { connectionId: 'opencode' },
      });
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
});

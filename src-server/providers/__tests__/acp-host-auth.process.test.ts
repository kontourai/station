/**
 * Engine host auth through the chat adapter's own client, across a real
 * process boundary. The fake ACP agent replays a recorded profile: for the
 * bundle, Kiro's agent service itself (`kas-bundle`, which asks for
 * `_kiro/auth/getAccessToken` before it answers `initialize` under
 * `--auth=acp-callback`); for the kiro-cli routes, kiro-cli v3 made to ask
 * the same. It records what Station answered and announced.
 *
 * - Launched from the built-in "Kiro (KAS, no CLI)" descriptor (its managed
 *   runtime pointed at the fake), the session receives the vault's access
 *   token and `initialize` announces `_meta.kiro.secretStorage`.
 * - The two kiro-cli routes (v2, and v3 with `--auth-method cli`, where
 *   kiro-cli owns the credential) and a user's custom command carrying the
 *   same delegation argument get neither: the request is refused -32601.
 *
 * Every route's connection is signed in to the vault first, so an absent
 * token is the launch rule's doing, not an empty vault's.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { managedRuntimeCommand } from '@kontourai/station-contracts/managed-engine-install';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { engineLaunchFactsFor } from '../../services/acp/acp-engine-descriptors.js';
import { ACPProcess } from '../../services/acp/acp-process.js';
import {
  EngineHostAuthService,
  registerEngineHostAuth,
} from '../../services/engine-host-auth/service.js';
import { registerManagedRuntimeInstalls } from '../../services/engines/managed-runtime-installs.js';
import { AcpAdapter } from '../adapters/acp-adapter.js';
import { BuiltinACPConnectionRegistryProvider } from '../llm/defaults.js';
import {
  clearAll,
  registerACPConnectionRegistryProvider,
} from '../registries/registry.js';
import { quietLogger } from './acp-engine-qualification-harness.js';

const FAKE_AGENT = fileURLToPath(
  new URL('./fixtures/fake-acp-agent.mjs', import.meta.url),
);
const KIRO_V3 = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('./fixtures/acp-scripted-profiles/kiro-v3.json', import.meta.url),
    ),
    'utf8',
  ),
) as Record<string, unknown>;

const KAS_BUNDLE = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        './fixtures/acp-scripted-profiles/kas-bundle.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as Record<string, unknown>;

const makeTempDir = trackTempDirs();
let home: string;
let service: EngineHostAuthService;
const adapters: AcpAdapter[] = [];

beforeEach(() => {
  home = makeTempDir('station-acp-host-auth-');
  registerACPConnectionRegistryProvider(
    new BuiltinACPConnectionRegistryProvider(() => false),
    'builtin-acp-connections',
    true,
  );
  service = new EngineHostAuthService({
    homeDir: home,
    policy: () => 'allowed',
    launchFacts: engineLaunchFactsFor,
  });
  registerEngineHostAuth(service);
});

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.stopAll()));
  registerEngineHostAuth(null);
  registerManagedRuntimeInstalls(null);
  clearAll();
});

async function signIn(connectionId: string) {
  await service.vault.write(
    'kiro.oidc-access-token',
    { connectionId, credentialProfileRef: 'default' },
    {
      identity: { kind: 'builder-id', region: 'us-east-1' },
      accessToken: 'vault-access-token',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshToken: 'vault-refresh-token',
      clientId: 'c',
      clientSecret: 's',
      attributes: { profileArn: 'arn:test', provider: 'BuilderId' },
      signedInAt: new Date().toISOString(),
    },
  );
}

/**
 * A script that runs the fake agent with this launch's profile and record,
 * whatever arguments the launch itself passed (the managed argv, kiro-cli's
 * `acp --agent-engine ...`).
 */
function fakeEngineScript(
  dir: string,
  engineProfile: Record<string, unknown> = {
    ...KIRO_V3,
    initializeRequests: [{ method: '_kiro/auth/getAccessToken', params: {} }],
  },
): { script: string; record: string } {
  const profile = join(dir, 'profile.json');
  const record = join(dir, 'record.jsonl');
  writeFileSync(profile, JSON.stringify(engineProfile));
  writeFileSync(record, '');
  const script = join(dir, 'engine.mjs');
  writeFileSync(
    script,
    [
      `process.argv.push('--engine-profile', ${JSON.stringify(profile)}, '--record', ${JSON.stringify(record)});`,
      `await import(${JSON.stringify(pathToFileURL(FAKE_AGENT).href)});`,
      '',
    ].join('\n'),
  );
  return { script, record };
}

async function startChat(
  connection: ACPConnectionConfig,
  kiroCli?: string,
): Promise<void> {
  const adapter = new AcpAdapter({
    getConnections: async () => [connection],
    logger: quietLogger,
    // `kiro-cli` is this test's stand-in, never whatever is installed.
    processFactory: (options) =>
      new ACPProcess({
        ...options,
        resolveCommand: async (command) =>
          command === 'kiro-cli' ? (kiroCli ?? null) : command,
      }),
  });
  adapters.push(adapter);
  void (async () => {
    for await (const _event of adapter.streamEvents());
  })();
  await adapter.startSession({
    provider: 'acp',
    threadId: `chat-${connection.id}`,
    cwd: makeTempDir('station-acp-host-auth-cwd-'),
    confinement: 'workspace',
    metadata: { connectionId: connection.id },
  } as never);
}

function recorded(record: string): Array<Record<string, unknown>> {
  return readFileSync(record, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const tokenAnswer = (entries: Array<Record<string, unknown>>) =>
  entries.find((entry) => entry.clientRequest === '_kiro/auth/getAccessToken');
const announced = (entries: Array<Record<string, unknown>>) =>
  entries.find((entry) => entry.method === 'initialize')?.clientMeta as
    | { kiro?: Record<string, unknown> }
    | undefined;

describe.skipIf(process.platform === 'win32')(
  'engine host auth through the chat adapter',
  () => {
    test('the bundle launch receives the vault token before initialize answers, and is offered secret storage', async () => {
      const { script, record } = fakeEngineScript(
        makeTempDir('kas-bundle-'),
        KAS_BUNDLE,
      );
      registerManagedRuntimeInstalls({
        installed: (installId) =>
          installId === 'kiro-kas'
            ? { runtime: process.execPath, script }
            : undefined,
      });
      await signIn('kiro-kas-bundle');
      await startChat({
        id: 'kiro-kas-bundle',
        name: 'Kiro (KAS, no CLI)',
        command: managedRuntimeCommand('kiro-kas'),
        args: [],
        enabled: true,
      });
      const entries = recorded(record);
      expect(tokenAnswer(entries)).toMatchObject({
        phase: 'initialize',
        result: {
          accessToken: 'vault-access-token',
          expiresAt: expect.any(String),
        },
      });
      expect(announced(entries)?.kiro).toMatchObject({ secretStorage: true });
      expect(JSON.stringify(entries)).not.toContain('vault-refresh-token');
    }, 60_000);

    test('a signed-out bundle is refused with the fixed signed-out answer, never a token, and still initializes', async () => {
      const { script, record } = fakeEngineScript(
        makeTempDir('kas-bundle-signed-out-'),
        KAS_BUNDLE,
      );
      registerManagedRuntimeInstalls({
        installed: (installId) =>
          installId === 'kiro-kas'
            ? { runtime: process.execPath, script }
            : undefined,
      });
      await startChat({
        id: 'kiro-kas-bundle',
        name: 'Kiro (KAS, no CLI)',
        command: managedRuntimeCommand('kiro-kas'),
        args: [],
        enabled: true,
      });
      const entries = recorded(record);
      expect(tokenAnswer(entries)).toMatchObject({
        phase: 'initialize',
        error: {
          code: -32000,
          message: 'Station has no signed-in credential for this engine',
        },
      });
      expect(tokenAnswer(entries)).not.toHaveProperty('result');
      expect(entries.some((entry) => entry.method === 'initialize')).toBe(true);
    }, 60_000);

    test.each([
      ['kiro', ['acp', '--agent-engine', 'v2']],
      ['kiro-kas', ['acp', '--agent-engine', 'v3', '--auth-method', 'cli']],
    ])(
      'the kiro-cli route %s is answered no token and offered no secret storage',
      async (id, args) => {
        const dir = makeTempDir(`${id}-`);
        const { script, record } = fakeEngineScript(dir);
        const kiroCli = join(dir, 'kiro-cli');
        writeFileSync(
          kiroCli,
          `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
        );
        chmodSync(kiroCli, 0o755);
        await signIn(id);
        await startChat(
          { id, name: 'Kiro', command: 'kiro-cli', args, enabled: true },
          kiroCli,
        );
        const entries = recorded(record);
        expect(tokenAnswer(entries)).toMatchObject({
          phase: 'initialize',
          error: { code: -32601 },
        });
        expect(tokenAnswer(entries)).not.toHaveProperty('result');
        expect(announced(entries)?.kiro).not.toHaveProperty('secretStorage');
        expect(JSON.stringify(entries)).not.toContain('vault-access-token');
      },
      60_000,
    );

    test("a custom command carrying the bundle's delegation argument is answered no token", async () => {
      const { script, record } = fakeEngineScript(makeTempDir('custom-'));
      await signIn('custom-kas');
      await startChat({
        id: 'custom-kas',
        name: 'My Kiro',
        command: process.execPath,
        args: [
          '--experimental-wasm-modules',
          script,
          '--transport=stdio',
          '--auth=acp-callback',
        ],
        enabled: true,
      });
      const entries = recorded(record);
      expect(tokenAnswer(entries)).toMatchObject({ error: { code: -32601 } });
      expect(announced(entries)?.kiro).not.toHaveProperty('secretStorage');
      expect(JSON.stringify(entries)).not.toContain('vault-access-token');
    }, 60_000);
  },
);

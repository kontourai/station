/**
 * End to end, across a real process boundary: a fake Kiro agent service that
 * asks for `_kiro/auth/getAccessToken` before it answers `initialize`.
 *
 * - Installed by the real ManagedInstaller and launched from the built-in
 *   "Kiro (KAS, no CLI)" descriptor's `managedRuntime`, through the real
 *   ACPProcess and the probe's client, it receives the vault's token.
 * - The same script launched as a user's custom command, with the same
 *   delegation argument, gets no responder: -32601 and no token.
 * - A managed connection whose runtime is not installed fails before
 *   anything is spawned, with an engine-facing message.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { managedRuntimeCommand } from '@kontourai/station-contracts/managed-engine-install';
import {
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { BuiltinACPConnectionRegistryProvider } from '../../../providers/llm/defaults.js';
import {
  clearAll,
  registerACPConnectionRegistryProvider,
} from '../../../providers/registries/registry.js';
import { installManagedEngineLimits } from '../../../security/managed-engine-limits.js';
import {
  engineLaunchFactsFor,
  ManagedRuntimeNotInstalledError,
  registryAuthFor,
  registryLaunchEnvFor,
} from '../../acp/acp-engine-descriptors.js';
import {
  AcpInboundExtensionRegistry,
  createAcpInboundExtensionRequestHandler,
} from '../../acp/acp-inbound-extension-policy.js';
import { ACPProbe, createProbeClient } from '../../acp/acp-probe.js';
import { ACPProcess } from '../../acp/acp-process.js';
import {
  sha256,
  startFixtureServer,
  tarGz,
} from '../../engines/__tests__/fixtures/managed-install-fixture.js';
import {
  defaultManagedInstallDeps,
  ManagedInstaller,
} from '../../engines/managed-install.js';
import { parseKasManifest } from '../../engines/managed-install-pins.js';
import { registerManagedRuntimeInstalls } from '../../engines/managed-runtime-installs.js';
import { installEngineHostAuthResponders } from '../responder.js';
import { EngineHostAuthService, registerEngineHostAuth } from '../service.js';

const makeTempDir = trackTempDirs();

const FAKE_ENGINE = readFileSync(
  join(import.meta.dirname, 'fixtures', 'fake-kas-engine.mjs'),
  'utf8',
);
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const HOST = `${process.platform}-${process.arch}`;
const ENGINE_KEY = process.platform === 'darwin' ? 'darwin-universal' : HOST;

const cleanups: Array<() => unknown> = [];
let home: string;
let service: EngineHostAuthService;

beforeEach(() => {
  home = makeTempDir('engine-host-auth-launch-');
  cleanups.push(() => {
    try {
      execFileSync('chmod', ['-R', 'u+w', home], { windowsHide: true });
    } catch {}
    rmSync(home, { recursive: true, force: true });
  });
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
  registerEngineHostAuth(null);
  registerManagedRuntimeInstalls(null);
  clearAll();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function installFakeKas(): Promise<ManagedInstaller> {
  const server = await startFixtureServer();
  cleanups.push(() => server.close());
  const engine = tarGz([
    {
      name: 'node_modules/@kiro/agent/dist/server/acp-server.js',
      body: FAKE_ENGINE,
    },
  ]);
  const runtime = tarGz([
    {
      name: 'node-v0/bin/node',
      body: `#!/bin/sh\nexec "${process.execPath}" "$@"\n`,
      mode: 0o755,
    },
  ]);
  server.put('/kas/0.66.104/engine.tar.gz', engine);
  server.put('/kas/0.66.104/runtime.tar.gz', runtime);
  const manifest = `${JSON.stringify({
    version: '0.66.104',
    package: '@kiro/agent',
    platforms: {
      [ENGINE_KEY]: {
        file: 'engine.tar.gz',
        sha256: sha256(engine),
        size: engine.length,
      },
    },
    node: {
      version: '0.0.0',
      builds: {
        [HOST]: {
          file: 'runtime.tar.gz',
          sha256: sha256(runtime),
          size: runtime.length,
        },
      },
    },
  })}\n`;
  server.put('/kas/0.66.104/manifest.json', manifest);
  const installer = new ManagedInstaller(
    home,
    [
      {
        pin: {
          installId: 'kiro-kas',
          version: '0.66.104',
          manifestUrl: 'https://kas.test/kas/0.66.104/manifest.json',
          manifestSha256: sha256(manifest),
          platforms: [
            'darwin-universal',
            'linux-x64',
            'linux-arm64',
            'win32-x64',
          ],
        },
        displayName: 'Kiro (KAS, no CLI)',
        parseManifest: parseKasManifest,
      },
    ],
    { ...defaultManagedInstallDeps(), fetch: server.fetch },
  );
  await installer.start('kiro-kas', { consent: true }).completion;
  expect(installer.state('kiro-kas').kind).toBe('installed');
  return installer;
}

async function launch(connection: {
  id: string;
  command: string;
  args: string[];
}) {
  const registry = new AcpInboundExtensionRegistry();
  const installed = installEngineHostAuthResponders(registry, { connection });
  const process_ = new ACPProcess({
    command: connection.command,
    args: connection.args,
    cwd: home,
    createClient: () =>
      createProbeClient(createAcpInboundExtensionRequestHandler({ registry })),
    clientCapabilities: {},
    logger: quiet,
  });
  cleanups.push(() => process_.destroy());
  const init = await process_.start();
  return {
    installed,
    fakeKas: (init as { _meta?: { fakeKas?: Record<string, unknown> } })._meta
      ?.fakeKas,
  };
}

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

test.skipIf(process.platform === 'win32')(
  'the managed bundle launch receives the vault token before initialize answers',
  async () => {
    const installer = await installFakeKas();
    registerManagedRuntimeInstalls(installer);
    await signIn('kiro-kas-bundle');
    const { installed, fakeKas } = await launch({
      id: 'kiro-kas-bundle',
      command: managedRuntimeCommand('kiro-kas'),
      args: [],
    });
    expect(installed.credentialMethods).toEqual(['_kiro/auth/getAccessToken']);
    expect(fakeKas).toMatchObject({
      argv: ['--transport=stdio', '--auth=acp-callback'],
      result: {
        accessToken: 'vault-access-token',
        expiresAt: expect.any(String),
        profileArn: 'arn:test',
        provider: 'BuilderId',
      },
    });
    expect(JSON.stringify(fakeKas)).not.toContain('vault-refresh-token');
  },
  60_000,
);

test('the same script as a custom command with the delegation argument gets no token', async () => {
  await signIn('custom-kas');
  const script = join(home, 'acp-server.js');
  writeFileSync(script, FAKE_ENGINE);
  const { installed, fakeKas } = await launch({
    id: 'custom-kas',
    command: process.execPath,
    args: [
      '--experimental-wasm-modules',
      script,
      '--transport=stdio',
      '--auth=acp-callback',
    ],
  });
  expect(installed).toEqual({ credentialMethods: [], secretMethods: [] });
  expect(fakeKas).toMatchObject({ error: { code: -32601 } });
  expect(fakeKas).not.toHaveProperty('result');
  expect(JSON.stringify(fakeKas)).not.toContain('vault-access-token');
}, 60_000);

test('a managed connection whose runtime is not installed fails before spawning, naming the engine', async () => {
  registerManagedRuntimeInstalls({ installed: () => undefined });
  const acpProcess = new ACPProcess({
    command: managedRuntimeCommand('kiro-kas'),
    args: [],
    cwd: home,
    createClient: () =>
      createProbeClient(createAcpInboundExtensionRequestHandler()),
    clientCapabilities: {},
    logger: quiet,
  });
  cleanups.push(() => acpProcess.destroy());
  const error = await acpProcess.start().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ManagedRuntimeNotInstalledError);
  expect((error as Error).message).toBe(
    "Kiro (KAS, no CLI) isn't installed yet. Install it from the engine's sign-in panel in Connections.",
  );
});

test('the probe records a managed engine that is not installed under a typed code', async () => {
  registerManagedRuntimeInstalls({ installed: () => undefined });
  const probe = new ACPProbe(
    {
      id: 'kiro-kas-bundle',
      name: 'Kiro (KAS, no CLI)',
      command: managedRuntimeCommand('kiro-kas'),
      args: [],
      enabled: true,
    },
    quiet,
    home,
    (options) => new ACPProcess(options),
    20_000,
  );
  cleanups.push(() => probe.dispose());
  expect(await probe.probe('request')).toBe(false);
  expect(probe.lastError).toMatchObject({
    code: 'managed-runtime-not-installed',
  });
});

test('a managed connection carrying arguments of its own is refused', async () => {
  registerManagedRuntimeInstalls({
    installed: () => ({ runtime: process.execPath, script: '/nonexistent' }),
  });
  const acpProcess = new ACPProcess({
    command: managedRuntimeCommand('kiro-kas'),
    args: ['--require', '/tmp/evil.js'],
    cwd: home,
    createClient: () =>
      createProbeClient(createAcpInboundExtensionRequestHandler()),
    clientCapabilities: {},
    logger: quiet,
  });
  cleanups.push(() => acpProcess.destroy());
  await expect(acpProcess.start()).rejects.toThrow(
    /runs only with the arguments Station pins/,
  );
});

test.skipIf(process.platform === 'win32')(
  "the availability probe answers the bundle's token request from the vault",
  async () => {
    const installer = await installFakeKas();
    registerManagedRuntimeInstalls(installer);
    await signIn('kiro-kas-bundle');
    const launched: ACPProcess[] = [];
    const probe = new ACPProbe(
      {
        id: 'kiro-kas-bundle',
        name: 'Kiro (KAS, no CLI)',
        command: managedRuntimeCommand('kiro-kas'),
        args: [],
        enabled: true,
      },
      quiet,
      home,
      (options) => {
        const acpProcess = new ACPProcess(options);
        launched.push(acpProcess);
        return acpProcess;
      },
      20_000,
    );
    cleanups.push(() => probe.dispose());
    // The fake engine refuses session/new, so the probe itself reports
    // failure; what matters is the token it was given during initialize.
    await probe.probe('request');
    const init = launched[0]?.initResult as
      | { _meta?: { fakeKas?: Record<string, unknown> } }
      | null
      | undefined;
    expect(init?._meta?.fakeKas).toMatchObject({
      result: { accessToken: 'vault-access-token' },
    });
  },
  60_000,
);

test.skipIf(process.platform === 'win32')(
  'a managed-policy pin that replaces the managed runtime gets no token, in the probe as in sessions',
  async () => {
    const installer = await installFakeKas();
    registerManagedRuntimeInstalls(installer);
    await signIn('kiro-kas-bundle');
    // The administrator's pinned binary runs the same engine script with the
    // same delegation argument, but it is not the runtime Station installed.
    const script = join(home, 'pinned-acp-server.js');
    writeFileSync(script, FAKE_ENGINE);
    const pinnedBinary = join(home, 'pinned-engine');
    writeFileSync(
      pinnedBinary,
      `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
      { mode: 0o755 },
    );
    const parsed = parseManagedPolicyDocument({
      schemaVersion: 1,
      organization: 'Acme',
      limits: {
        engines: {
          instances: {
            acp: {
              locked: true,
              binaryPath: pinnedBinary,
              launchArgs: ['--transport=stdio', '--auth=acp-callback'],
            },
          },
        },
      },
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
    installManagedEngineLimits({
      document: parsed.document,
      summary: summarizeManagedPolicy(parsed.document),
    });
    cleanups.push(() => installManagedEngineLimits(null));
    const launched: ACPProcess[] = [];
    const probe = new ACPProbe(
      {
        id: 'kiro-kas-bundle',
        name: 'Kiro (KAS, no CLI)',
        command: managedRuntimeCommand('kiro-kas'),
        args: [],
        enabled: true,
      },
      quiet,
      home,
      (options) => {
        const acpProcess = new ACPProcess(options);
        launched.push(acpProcess);
        return acpProcess;
      },
      20_000,
    );
    cleanups.push(() => probe.dispose());
    await probe.probe('request');
    const fakeKas = (
      launched[0]?.initResult as
        | { _meta?: { fakeKas?: Record<string, unknown> } }
        | null
        | undefined
    )?._meta?.fakeKas;
    // The pinned launch really ran...
    expect(fakeKas).toMatchObject({
      argv: ['--transport=stdio', '--auth=acp-callback'],
    });
    // ...and was not handed the vault's token.
    expect(fakeKas).toMatchObject({ error: { code: -32601 } });
    expect(JSON.stringify(fakeKas)).not.toContain('vault-access-token');
  },
  60_000,
);

test('descriptor lookups key a managed engine by its install id, never by the runtime name', () => {
  expect(
    registryAuthFor({ command: managedRuntimeCommand('kiro-kas') })?.auth
      .signInHint,
  ).toMatch(/sign in to Kiro here/);
  // A custom connection running node shares nothing with the managed engine.
  expect(registryAuthFor({ command: process.execPath })).toBeUndefined();
  expect(registryAuthFor({ command: 'node' })).toBeUndefined();
  // kiro-cli entries name Station to kiro-cli; the bundle runs no kiro-cli.
  expect(registryLaunchEnvFor({ command: 'kiro-cli' })).toEqual({
    KIRO_CLI_CLIENT_APPLICATION: 'station',
  });
  expect(
    registryLaunchEnvFor({ command: managedRuntimeCommand('kiro-kas') }),
  ).toBeUndefined();
  expect(
    engineLaunchFactsFor({ command: managedRuntimeCommand('kiro-kas') }),
  ).toEqual({
    builtinDescriptor: true,
    argv: [
      '--experimental-wasm-modules',
      '{script}',
      '--transport=stdio',
      '--auth=acp-callback',
    ],
  });
});

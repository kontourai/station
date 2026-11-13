/**
 * Readiness for a managed-runtime engine (the Kiro agent-service bundle,
 * `station-managed:kiro-kas`): it is not a program on PATH, so its CLI row
 * reads the install, and the sign-in row reads Station's own vault. Live
 * evidence: before this, an installed bundle that answered `initialize` was
 * reported "missing" with "ensure `station-managed:kiro-kas` is on PATH", and
 * its sign-in row was never evaluated.
 */
import { rmSync } from 'node:fs';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import { managedRuntimeCommand } from '@kontourai/station-contracts/managed-engine-install';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { requiredMissingPrerequisites } from '../../runtime/frameworks/runtime-adapter-readiness.js';
import { resetEngineAuthStatus } from '../../services/acp/engine-auth-status.js';
import { createConnectionInspector } from '../../services/connections/connection-inspector.js';
import {
  EngineHostAuthService,
  registerEngineHostAuth,
} from '../../services/engine-host-auth/service.js';
import { registerManagedRuntimeInstalls } from '../../services/engines/managed-runtime-installs.js';
import { AcpAdapter } from '../adapters/acp-adapter.js';
import { BUILTIN_ACP_ENGINES } from '../llm/builtin-acp-engines.js';
import {
  clearAll,
  registerACPConnectionRegistryProvider,
} from '../registries/registry.js';

const makeTempDir = trackTempDirs();
const cleanups: Array<() => unknown> = [];
beforeEach(() => {
  registerACPConnectionRegistryProvider(
    { listAvailable: () => BUILTIN_ACP_ENGINES.map((entry) => ({ ...entry })) },
    'builtin-acp-connections',
    true,
  );
});
afterEach(() => {
  clearAll();
  resetEngineAuthStatus();
  registerManagedRuntimeInstalls(null);
  registerEngineHostAuth(null);
  while (cleanups.length > 0) cleanups.pop()?.();
});

const BUNDLE: ACPConnectionConfig = {
  id: 'kiro-kas-bundle',
  name: 'Kiro (KAS, no CLI)',
  command: managedRuntimeCommand('kiro-kas'),
  args: [],
  enabled: true,
};

function adapterFor(connection: ACPConnectionConfig) {
  return new AcpAdapter({
    getConnections: async () => [connection],
    logger: { debug: () => {}, warn: () => {}, error: () => {} },
    processFactory: () => {
      throw new Error('readiness must not launch the engine');
    },
  } as ConstructorParameters<typeof AcpAdapter>[0]);
}

function signedOutVault() {
  const home = makeTempDir('managed-readiness-');
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const service = new EngineHostAuthService({
    homeDir: home,
    policy: () => 'allowed',
  });
  registerEngineHostAuth(service);
  return service;
}

function installedBundle() {
  registerManagedRuntimeInstalls({
    installed: (installId) =>
      installId === 'kiro-kas'
        ? { runtime: process.execPath, script: '/unused/acp-server.js' }
        : undefined,
  });
}

/** The engines list's row for the bundle, its handshake answered. */
async function engineRow() {
  const outcome = await createConnectionInspector({
    adapters: () => [adapterFor(BUNDLE)],
    appConfig: () => ({}) as never,
    acpConnections: () => [BUNDLE],
    acpStatus: () =>
      ({
        connections: [{ id: BUNDLE.id, status: 'available' }],
      }) as never,
    publicConnection: (runtimeId) => ({
      id: engineConnectionId(BUNDLE.id),
      engineId: runtimeId,
    }),
    now: () => Date.now(),
  }).inspect({ kind: 'runtime-capability-inventory' });
  return outcome.connections.find((connection) => connection.type === 'acp');
}

test('an installed bundle reads its runtime, and a signed-out vault gates the chat with the sign-in step', async () => {
  signedOutVault();
  // Any runnable binary stands in for the installed Node runtime.
  registerManagedRuntimeInstalls({
    installed: (installId) =>
      installId === 'kiro-kas'
        ? { runtime: process.execPath, script: '/unused/acp-server.js' }
        : undefined,
  });
  const prerequisites = await adapterFor(BUNDLE).getPrerequisites({
    connectionId: BUNDLE.id,
  });
  const cli = prerequisites.find((item) => item.id.endsWith('-cli'));
  const auth = prerequisites.find((item) => item.id.endsWith('-auth'));
  expect(cli?.status).toBe('installed');
  expect(auth).toMatchObject({ status: 'missing', category: 'required' });
  // A no-CLI engine Station signs in: neither row calls it a CLI.
  expect(cli?.name).toBe('Kiro (KAS, no CLI) runtime');
  expect(auth?.description).toBe(
    'Sign in to Kiro (KAS, no CLI) from its sign-in panel in Connections.',
  );
  expect(auth?.installGuide?.steps).toEqual([
    'Sign in to Kiro (KAS, no CLI) from its sign-in panel in Connections.',
  ]);
  expect(JSON.stringify(prerequisites)).not.toContain('on PATH');
  expect(requiredMissingPrerequisites(prerequisites).map((p) => p.id)).toEqual([
    auth?.id,
  ]);
});

test('a bundle not installed yet says to install it from Connections, not to put it on PATH', async () => {
  signedOutVault();
  registerManagedRuntimeInstalls({ installed: () => undefined });
  const prerequisites = await adapterFor(BUNDLE).getPrerequisites({
    connectionId: BUNDLE.id,
  });
  const cli = prerequisites.find((item) => item.id.endsWith('-cli'));
  expect(cli).toMatchObject({ status: 'missing' });
  expect(cli?.installGuide?.steps).toEqual([
    'Install Kiro (KAS, no CLI) from its sign-in panel in Connections.',
  ]);
  expect(JSON.stringify(prerequisites)).not.toContain('on PATH');
});

test('the engines list reads a signed-out bundle as needing sign-in, not Ready, though its handshake answered', async () => {
  signedOutVault();
  installedBundle();
  const row = await engineRow();
  expect(row?.status).toBe('missing_prerequisites');
  expect(row?.config).toMatchObject({
    readinessReason:
      'Sign in to Kiro (KAS, no CLI) from its sign-in panel in Connections.',
  });
});

test('signed in, the same bundle reads Ready', async () => {
  const service = signedOutVault();
  installedBundle();
  await service.vault.write(
    'kiro.oidc-access-token',
    { connectionId: BUNDLE.id, credentialProfileRef: 'default' },
    {
      identity: { kind: 'builder-id', region: 'us-east-1' },
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      signedInAt: new Date().toISOString(),
    },
  );
  expect((await engineRow())?.status).toBe('ready');
});

/** An ACP adapter whose readiness read the test scripts. */
function scriptedAcpAdapter(getPrerequisites: () => Promise<never>) {
  return {
    provider: 'acp',
    metadata: {
      displayName: 'ACP',
      description: 'test',
      capabilities: [],
      engineId: 'acp',
    },
    getPrerequisites,
  } as never;
}

const CUSTOM: ACPConnectionConfig = {
  id: 'custom-engine',
  name: 'Custom engine',
  command: 'custom-engine-cli',
  args: ['acp'],
  enabled: true,
};

function inventory(acpAdapter: never, signal?: AbortSignal) {
  return createConnectionInspector({
    adapters: () => [acpAdapter],
    appConfig: () => ({}) as never,
    acpConnections: () => [BUNDLE, CUSTOM],
    acpStatus: () =>
      ({
        connections: [
          { id: BUNDLE.id, status: 'available' },
          { id: CUSTOM.id, status: 'available' },
        ],
      }) as never,
    publicConnection: (runtimeId) => ({
      id: engineConnectionId(String(runtimeId)),
      engineId: runtimeId,
    }),
    now: () => Date.now(),
  }).inspect({
    kind: 'runtime-capability-inventory',
    ...(signal ? { signal } : {}),
  });
}

test('a readiness read that throws costs only that engine’s row: it reads could-not-verify, the rest still list', async () => {
  const outcome = await inventory(
    scriptedAcpAdapter(async () => {
      throw new Error('loadACPConfig failed');
    }),
  );
  expect(outcome.kind).toBe('inspected');
  const rows = outcome.connections.filter((row) => row.type === 'acp');
  expect(rows.map((row) => row.name).sort()).toEqual([
    'Custom engine',
    'Kiro (KAS, no CLI)',
  ]);
  const bundle = rows.find((row) => row.name === 'Kiro (KAS, no CLI)');
  expect(bundle?.status).toBe('missing_prerequisites');
  expect(bundle?.prerequisites).toContainEqual(
    expect.objectContaining({ id: 'kiro-kas-bundle-inspection' }),
  );
  expect(rows.find((row) => row.name === 'Custom engine')?.status).toBe(
    'ready',
  );
});

test('a readiness read that never settles does not hold the inventory past an abort', async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(new Error('caller cancelled')), 100);
  const outcome = await inventory(
    scriptedAcpAdapter(() => new Promise<never>(() => {})),
    controller.signal,
  );
  expect(outcome.kind).toBe('aborted');
  expect(Date.now() - started).toBeLessThan(5_000);
});

test('the readiness read passes its abort to the runtime probe', async () => {
  signedOutVault();
  installedBundle();
  const controller = new AbortController();
  controller.abort(new Error('caller cancelled'));
  await expect(
    adapterFor(BUNDLE).getPrerequisites({
      connectionId: BUNDLE.id,
      signal: controller.signal,
    }),
  ).rejects.toThrow();
});

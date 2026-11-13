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
import { managedRuntimeCommand } from '@kontourai/station-contracts/managed-engine-install';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { requiredMissingPrerequisites } from '../../runtime/frameworks/runtime-adapter-readiness.js';
import { resetEngineAuthStatus } from '../../services/acp/engine-auth-status.js';
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
  registerEngineHostAuth(
    new EngineHostAuthService({ homeDir: home, policy: () => 'allowed' }),
  );
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

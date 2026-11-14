/**
 * The ACP adapter's host-auth wiring for an engine Station signs in (the Kiro
 * bundle, `station-managed:kiro-kas`):
 *
 * - one credential scope: the connection's default profile, the same one the
 *   sign-in routes, status and the probe use; a start asking for another
 *   profile is refused before anything is launched;
 * - no credential or secret responders for a launch a managed-policy pin
 *   replaced, because the connection no longer describes that process.
 *
 * The client under test is the one the adapter builds for a live session,
 * served over a real ndjson stream pair to a real agent app.
 */
import {
  agent as agentApp,
  ndJsonStream,
} from '@agentclientprotocol/sdk/unstable';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { managedRuntimeCommand } from '@kontourai/station-contracts/managed-engine-install';
import { ENGINE_CREDENTIAL_PROFILE_UNSUPPORTED_CODE } from '@kontourai/station-contracts/provider';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { createACPClientApp } from '../../services/acp/acp-bridge-client.js';
import type { ACPClientCallbacks } from '../../services/acp/acp-bridge-types.js';
import { engineLaunchFactsFor } from '../../services/acp/acp-engine-descriptors.js';
import type {
  ACPProcess,
  ACPProcessOptions,
  ACPSpawnedLaunch,
} from '../../services/acp/acp-process.js';
import {
  EngineHostAuthService,
  registerEngineHostAuth,
} from '../../services/engine-host-auth/service.js';
import { SessionStartRefusedError } from '../adapter-shape.js';
import { AcpAdapter } from '../adapters/acp-adapter.js';
import { BuiltinACPConnectionRegistryProvider } from '../llm/defaults.js';
import {
  clearAll,
  registerACPConnectionRegistryProvider,
} from '../registries/registry.js';

const makeTempDir = trackTempDirs();
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

const KAS: ACPConnectionConfig = {
  id: 'kiro-kas-bundle',
  name: 'Kiro (KAS, no CLI)',
  command: managedRuntimeCommand('kiro-kas'),
  args: [],
  enabled: true,
};

let service: EngineHostAuthService;

beforeEach(async () => {
  registerACPConnectionRegistryProvider(
    new BuiltinACPConnectionRegistryProvider(() => false),
    'builtin-acp-connections',
    true,
  );
  service = new EngineHostAuthService({
    homeDir: makeTempDir('acp-adapter-host-auth-'),
    policy: () => 'allowed',
    launchFacts: engineLaunchFactsFor,
  });
  registerEngineHostAuth(service);
  await service.vault.write(
    'kiro.oidc-access-token',
    { connectionId: KAS.id, credentialProfileRef: 'default' },
    {
      identity: { kind: 'builder-id', region: 'us-east-1' },
      accessToken: 'default-profile-token',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshToken: 'r',
      clientId: 'c',
      clientSecret: 's',
      signedInAt: new Date().toISOString(),
    },
  );
});

afterEach(() => {
  registerEngineHostAuth(null);
  clearAll();
});

/** Calls `createClient` with the given launch, as ACPProcess.start does. */
function capturingFactory(spawned: ACPSpawnedLaunch) {
  const made: Array<{ client: ACPClientCallbacks }> = [];
  const factory = (opts: ACPProcessOptions) => {
    const process = {
      client: undefined as unknown as ACPClientCallbacks,
      initResult: { protocolVersion: 1, agentCapabilities: {} },
      async start() {
        process.client = opts.createClient(spawned);
        return process.initResult;
      },
      async newSession() {
        return {
          sessionId: 'native-kas',
          modes: { availableModes: [], currentModeId: 'default' },
          configOptions: [],
        };
      },
      async destroy() {},
    };
    made.push(process);
    return process as unknown as ACPProcess;
  };
  return { factory, made };
}

async function askForToken(client: ACPClientCallbacks) {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  createACPClientApp(client).connect(
    ndJsonStream(clientToAgent.writable, agentToClient.readable),
  );
  const agent = agentApp().connect(
    ndJsonStream(agentToClient.writable, clientToAgent.readable),
  ).client;
  try {
    return { result: await agent.request('_kiro/auth/getAccessToken', {}) };
  } catch (error) {
    return { error: error as { code?: number } };
  }
}

async function start(spawned: ACPSpawnedLaunch, credentialProfileRef?: string) {
  const { factory, made } = capturingFactory(spawned);
  const adapter = new AcpAdapter({
    getConnections: async () => [KAS],
    logger: quiet,
    processFactory: factory,
  });
  const drained = (async () => {
    for await (const _ of adapter.streamEvents());
  })();
  const started = adapter.startSession({
    provider: 'acp',
    threadId: `host-auth-${Math.random()}`,
    cwd: '/tmp/project',
    metadata: { connectionId: KAS.id },
    ...(credentialProfileRef ? { credentialProfileRef } : {}),
  });
  const outcome = await started.then(
    () => undefined,
    (error: unknown) => error,
  );
  return {
    outcome,
    made,
    stop: async () => {
      await adapter.stopAll();
      await drained;
    },
  };
}

describe('host-auth on the ACP adapter', () => {
  test('a session is answered from the default profile, the scope sign-in and status use', async () => {
    const run = await start({ launchReplacedByPolicy: false });
    expect(run.outcome).toBeUndefined();
    const answer = await askForToken(run.made[0]!.client);
    expect(answer).toMatchObject({
      result: { accessToken: 'default-profile-token' },
    });
    await run.stop();
  });

  test('a start asking for another credential profile is refused before launch', async () => {
    const run = await start({ launchReplacedByPolicy: false }, 'work');
    expect(run.outcome).toBeInstanceOf(SessionStartRefusedError);
    expect((run.outcome as SessionStartRefusedError).code).toBe(
      ENGINE_CREDENTIAL_PROFILE_UNSUPPORTED_CODE,
    );
    expect((run.outcome as Error).message).toMatch(
      /Kiro \(KAS, no CLI\) signs in through Station.*'work'/,
    );
    expect(run.made).toEqual([]);
    await run.stop();
  });

  test('a launch a managed-policy pin replaced gets no credential responder', async () => {
    const run = await start({ launchReplacedByPolicy: true });
    expect(run.outcome).toBeUndefined();
    const answer = await askForToken(run.made[0]!.client);
    expect(answer.error?.code).toBe(-32601);
    expect(JSON.stringify(answer)).not.toContain('default-profile-token');
    await run.stop();
  });
});

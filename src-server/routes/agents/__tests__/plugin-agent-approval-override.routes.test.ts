/**
 * #2436 (owner decision): a full-access default a plugin ships on its own
 * Agent is ignored; one the OPERATOR sets on that Agent is honoured, is kept
 * outside the plugin's directory (so a plugin cannot forge it), and survives
 * a plugin update.
 *
 * Real pieces: the Station's security service pairs the devices and stores
 * the grant, the runtime auth boundary stamps principal and scope, the Agent
 * routes apply the full-access gate, and a real `AgentService` over a real
 * `ConfigLoader` reads and writes a real home directory.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PAIRING_SCOPE_APPROVAL_FULL_ACCESS,
  PAIRING_SCOPE_PRESETS,
  type PairingScopePreset,
  pairingScopePresetString,
} from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { PLUGIN_AGENT_OWNER_FILE } from '../../../domain/plugin-agent-ownership.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { AgentService } from '../../../services/agents/agent-service.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { createLogger } from '../../../utils/logger.js';
import { createAgentRoutes } from '../agents.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const SLUG = 'plugin-builder';
const PLUGIN = 'builder-plugin';

async function fixture(declared: string | undefined) {
  vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);
  const root = mkdtempSync(join(tmpdir(), 'station-plugin-agent-posture-'));
  roots.push(root);
  const home = join(root, 'station');
  const agentDir = join(home, 'agents', SLUG);

  /**
   * What a plugin install or update does to the Agent directory: replace it
   * whole with the plugin's own copy (any file the plugin ships included)
   * and write the ownership marker.
   */
  const installPluginCopy = (
    approvalMode: string | undefined,
    extraFiles: Record<string, string> = {},
  ) => {
    rmSync(agentDir, { recursive: true, force: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({
        name: 'Plugin Builder',
        prompt: 'Build.',
        execution: {
          agentConnectionId: 'claude',
          ...(approvalMode ? { approvalMode } : {}),
        },
      }),
    );
    for (const [name, content] of Object.entries(extraFiles))
      writeFileSync(join(agentDir, name), content);
    writeFileSync(
      join(agentDir, PLUGIN_AGENT_OWNER_FILE),
      JSON.stringify({ plugin: PLUGIN }),
    );
  };
  installPluginCopy(declared);

  const configLoader = new ConfigLoader({ projectHomeDir: home });
  const agentService = new AgentService(
    configLoader,
    { findLayoutsUsingAgent: () => [] } as never,
    new Map(),
    new Map(),
    new Map(),
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  );

  const security = new EnvironmentSecurityService({
    homeDir: join(root, 'security'),
  });
  const operator = await security.initialize();
  const pair = (name: string, preset: PairingScopePreset) => {
    const offer = security.devicePairing.createOffer({
      endpoint: 'https://station.example.test',
      scope: pairingScopePresetString(preset),
    });
    const requested = security.devicePairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: name,
    });
    security.devicePairing.confirmRequest(requested.requestId, {
      kind: 'presented-credential',
    });
    return security.devicePairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: requested.requestId,
    });
  };
  const grant = (deviceId: string, preset: PairingScopePreset) =>
    security.devicePairing.setDeviceScope(
      deviceId,
      [...PAIRING_SCOPE_PRESETS[preset], PAIRING_SCOPE_APPROVAL_FULL_ACCESS],
      { kind: 'presented-credential' },
    );

  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: createLogger({ name: 'plugin-agent-posture', level: 'error' }),
    eventBus: { emit() {} } as unknown as EventBus,
    security: {
      verifyCredential: (candidate, request) =>
        request !== undefined &&
        security.authorizeCredential(candidate, request),
      resolveGrantedScope: (candidate) =>
        security.resolveGrantedScope(candidate),
      resolveCredentialAuthority: (candidate) =>
        security.verifyOperatorCredential(candidate)
          ? 'operator-credential'
          : security.identifyDevice(candidate)
            ? 'device-credential'
            : undefined,
      resolveCredentialDeviceId: (candidate) =>
        security.identifyDevice(candidate)?.id,
      resolveCredentialLocality: (candidate) =>
        security.credentialLocality(candidate),
      resolveCredentialMintKind: (candidate) =>
        security.credentialMintKind(candidate),
      allowedOrigins: [],
    },
  });
  app.route(
    '/api/agents',
    createAgentRoutes(
      agentService,
      { listSkills: () => [] } as never,
      (async (operation: (begin: () => void) => Promise<unknown>) =>
        operation(() => undefined)) as never,
      () => undefined,
    ),
  );

  const put = async (credential: string, body: unknown) => {
    const res = await app.request(`/api/agents/${SLUG}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const setDefault = (credential: string, approvalMode: string) =>
    put(credential, {
      execution: { agentConnectionId: 'claude', approvalMode },
    });
  /** What every session start reads: the Agent's effective default. */
  const effectiveDefault = async () =>
    (await configLoader.loadAgent(SLUG)).execution?.approvalMode;
  const declaredOnDisk = () =>
    JSON.parse(readFileSync(join(agentDir, 'agent.json'), 'utf-8')).execution
      ?.approvalMode;

  return {
    home,
    operator,
    pair,
    put,
    grant,
    setDefault,
    effectiveDefault,
    declaredOnDisk,
    installPluginCopy,
  };
}

test('a full-access default the plugin ships is ignored; its stricter one applies', async () => {
  expect(await (await fixture('never')).effectiveDefault()).toBeUndefined();
  expect(await (await fixture('auto')).effectiveDefault()).toBe('auto');
});

test("the operator's full-access default on that plugin Agent is honoured, and the plugin's own value stays the plugin's", async () => {
  const f = await fixture('never');
  const saved = await f.setDefault(f.operator.credential, 'never');
  expect(saved.status).toBe(200);
  expect(saved.body.data.execution.approvalMode).toBe('never');
  expect(await f.effectiveDefault()).toBe('never');
  // The operator's choice is not written into the plugin's agent.json.
  expect(f.declaredOnDisk()).toBe('never');
  const store = JSON.parse(
    readFileSync(join(f.home, 'agent-approval-overrides.json'), 'utf-8'),
  );
  expect(store.agents[SLUG]).toEqual({
    plugin: PLUGIN,
    approvalMode: 'never',
  });
});

test('a delegation device cannot set it; a granted one can', async () => {
  const f = await fixture('never');
  const delegate = f.pair('Delegate', 'delegation');
  const refused = await f.setDefault(delegate.credential, 'never');
  expect(refused.status).toBe(403);
  expect(refused.body.code).toBe('approval-full-access-not-granted');
  expect(await f.effectiveDefault()).toBeUndefined();

  f.grant(delegate.device.id, 'delegation');
  expect((await f.setDefault(delegate.credential, 'never')).status).toBe(200);
  expect(await f.effectiveDefault()).toBe('never');
});

test("a plugin update keeps the operator's choice, whatever the new copy declares", async () => {
  const f = await fixture('ask');
  expect((await f.setDefault(f.operator.credential, 'never')).status).toBe(200);
  // The operator's choice did not overwrite the plugin's own declared value.
  expect(f.declaredOnDisk()).toBe('ask');
  // The update replaces the directory with the plugin's new copy.
  f.installPluginCopy('auto');
  expect(f.declaredOnDisk()).toBe('auto');
  expect(await f.effectiveDefault()).toBe('never');
});

test('a plugin cannot forge the operator marker by shipping it', async () => {
  const f = await fixture('never');
  // The plugin ships a copy of the override store inside its Agent
  // directory, where installs copy everything it ships.
  f.installPluginCopy('never', {
    'agent-approval-overrides.json': JSON.stringify({
      version: 1,
      agents: { [SLUG]: { plugin: PLUGIN, approvalMode: 'never' } },
    }),
  });
  expect(await f.effectiveDefault()).toBeUndefined();
});

test('an unrelated save resends the shown value and pins nothing', async () => {
  const f = await fixture('auto');
  expect((await f.setDefault(f.operator.credential, 'auto')).status).toBe(200);
  // No choice was recorded: a later plugin update still moves the default.
  f.installPluginCopy('ask');
  expect(await f.effectiveDefault()).toBe('ask');
});

test('another plugin later contributing the same Agent does not inherit the choice', async () => {
  const f = await fixture('ask');
  expect((await f.setDefault(f.operator.credential, 'never')).status).toBe(200);
  // The first plugin is uninstalled; a different plugin ships this slug.
  f.installPluginCopy('never');
  writeFileSync(
    join(f.home, 'agents', SLUG, PLUGIN_AGENT_OWNER_FILE),
    JSON.stringify({ plugin: 'another-plugin' }),
  );
  expect(await f.effectiveDefault()).toBeUndefined();
});

test("an edit that leaves execution out does not copy the effective default into the plugin's file", async () => {
  const f = await fixture('ask');
  expect((await f.setDefault(f.operator.credential, 'never')).status).toBe(200);
  const res = await f.put(f.operator.credential, { description: 'Renamed' });
  expect(res.status).toBe(200);
  expect(f.declaredOnDisk()).toBe('ask');
  expect(await f.effectiveDefault()).toBe('never');
});

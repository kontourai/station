// @vitest-environment node

import { spawn } from 'node:child_process';
import {
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentId,
  engineConnectionId,
  ReservedStationIdentityError,
} from '@kontourai/station-contracts/agent-identity';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentRegistryConflictError,
  acquireAgentIdentityMutationLockAtHome,
  adoptNativeEngineConnection,
  agentRegistrySourceSignature,
  loadOrCreateAgentRegistry,
  reconcilePluginEngineConnections,
  registerEngineConnection,
  replacePluginEngineConnections,
  saveAgentRegistry,
  unregisterEngineConnection,
  unregisterPluginEngineConnections,
  updateAgentRegistry,
} from '../agent-registry.js';
import { ConfigLoader } from '../config-loader.js';
import {
  ensureStationHomeSchema,
  StationHomeResetRequiredError,
} from '../home-schema-gate.js';

const homes: string[] = [];
const createHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'station-agent-registry-'));
  homes.push(home);
  return home;
};

function runSchemaGateInChild(home: string): Promise<void> {
  const gateUrl = new URL('../home-schema-gate.ts', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `import { ensureStationHomeSchema } from ${JSON.stringify(gateUrl)}; await ensureStationHomeSchema(process.argv[1]);`,
      home,
    ],
    { cwd: process.cwd(), stdio: 'ignore' },
  );
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`schema-gate child exited ${code}`));
    });
  });
}

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe('agent registry', () => {
  it('adopts a detected native engine once, then settles as exists (#1575)', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });

    expect(await adoptNativeEngineConnection(loader, 'claude')).toBe('adopted');
    expect(await adoptNativeEngineConnection(loader, 'claude')).toBe('exists');

    const registry = await loadOrCreateAgentRegistry(loader);
    expect(registry.engineConnections).toContainEqual({
      id: 'claude',
      source: { kind: 'native' },
    });
    expect(registry.defaultAgents).toContainEqual({
      id: 'claude',
      kind: 'engine-connection',
      engineConnectionId: 'claude',
    });
  });

  it('records a decline when a native engine is removed, and adoption honors it (#1575)', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });

    await adoptNativeEngineConnection(loader, 'codex');
    await unregisterEngineConnection(loader, 'codex');

    const registry = await loadOrCreateAgentRegistry(loader);
    expect(registry.declinedEngineConnections).toEqual(['codex']);
    // A deliberate user deletion outranks detection, forever.
    expect(await adoptNativeEngineConnection(loader, 'codex')).toBe('declined');
    expect((await loadOrCreateAgentRegistry(loader)).engineConnections).toEqual(
      [],
    );
  });

  it('a concurrent decline cannot be overridden by automatic adoption (#1575 review HIGH)', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });

    await adoptNativeEngineConnection(loader, 'codex');
    await unregisterEngineConnection(loader, 'codex');

    // The review's probe: calling the registration CAS directly with the
    // adoption posture (as adopt does internally, AFTER any stale pre-read)
    // must refuse — the decline check lives inside the CAS snapshot now.
    expect(await adoptNativeEngineConnection(loader, 'codex')).toBe('declined');
    const registry = await loadOrCreateAgentRegistry(loader);
    expect(registry.engineConnections).toEqual([]);
    expect(registry.declinedEngineConnections).toEqual(['codex']);
  });

  it('an explicit registration clears a recorded decline in the same CAS (#1575)', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });

    await adoptNativeEngineConnection(loader, 'codex');
    await unregisterEngineConnection(loader, 'codex');
    // The user asking for the engine back (Providers-UI save path) wins and
    // erases the decline — no contradictory declined+exists state.
    await registerEngineConnection(loader, 'codex');

    const registry = await loadOrCreateAgentRegistry(loader);
    expect(registry.engineConnections.map((c) => c.id)).toEqual(['codex']);
    expect(registry.declinedEngineConnections).toEqual([]);
  });

  it('an absent-source removal records a decline (hand-edited registry, #1575)', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });
    await loadOrCreateAgentRegistry(loader);
    await updateAgentRegistry(loader, 0, (value) => ({
      ...value,
      engineConnections: [{ id: engineConnectionId('codex') }],
      defaultAgents: [
        ...value.defaultAgents,
        {
          id: agentId(engineConnectionId('codex')),
          kind: 'engine-connection',
          engineConnectionId: engineConnectionId('codex'),
        },
      ],
    }));

    await unregisterEngineConnection(loader, 'codex');
    expect(
      (await loadOrCreateAgentRegistry(loader)).declinedEngineConnections,
    ).toEqual(['codex']);
  });

  it('does not record declines for non-native engine removals (#1575)', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });

    await registerEngineConnection(loader, 'kiro', {
      kind: 'user-acp',
    });
    await unregisterEngineConnection(loader, 'kiro');

    const registry = await loadOrCreateAgentRegistry(loader);
    expect(registry.declinedEngineConnections).toBeUndefined();
  });

  it('adoption never overwrites a user-authored agent squatting the id (#1575)', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });
    // Bootstrap the schema marker first: an authored agent in a marker-less
    // home is (correctly) rejected by the home gate before adoption runs.
    await loadOrCreateAgentRegistry(loader);
    await loader.createAgent({ name: 'claude', prompt: 'mine' });

    expect(await adoptNativeEngineConnection(loader, 'claude')).toBe(
      'agent-collision',
    );
    expect((await loadOrCreateAgentRegistry(loader)).engineConnections).toEqual(
      [],
    );
  });

  it('rejects duplicate plugin identities before mutating the registry', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });
    await expect(
      reconcilePluginEngineConnections(loader, [
        { id: 'plugin-agent', plugin: 'one' },
        { id: 'plugin-agent', plugin: 'two' },
      ]),
    ).rejects.toMatchObject({ code: 'ENGINE_CONNECTION_BINDING_COLLISION' });
    expect((await loadOrCreateAgentRegistry(loader)).engineConnections).toEqual(
      [],
    );
  });
  it('rejects provenance takeover without changing the existing owner', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });
    await registerEngineConnection(loader, 'plugin-agent', {
      kind: 'plugin-acp',
      plugin: 'one',
    });

    await expect(
      registerEngineConnection(loader, 'plugin-agent', {
        kind: 'user-acp',
      }),
    ).rejects.toMatchObject({ code: 'ENGINE_CONNECTION_BINDING_COLLISION' });
    expect(
      (await loadOrCreateAgentRegistry(loader)).engineConnections,
    ).toContainEqual({
      id: 'plugin-agent',
      runtimeConnectionId: 'plugin-agent',
      source: { kind: 'plugin-acp', plugin: 'one' },
    });
  });

  it('retains plugin identities when a later startup cannot load the provider', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });
    await reconcilePluginEngineConnections(loader, [
      { id: 'plugin-agent', plugin: 'one' },
    ]);

    await reconcilePluginEngineConnections(loader, []);

    const registry = await loadOrCreateAgentRegistry(loader);
    expect(registry.engineConnections).toContainEqual(
      expect.objectContaining({
        id: 'plugin-agent',
        source: { kind: 'plugin-acp', plugin: 'one' },
      }),
    );
    expect(registry.defaultAgents).toContainEqual(
      expect.objectContaining({ id: 'plugin-agent' }),
    );
  });

  it('removes only identities owned by an explicitly uninstalled plugin', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });
    await reconcilePluginEngineConnections(loader, [
      { id: 'plugin-one', plugin: 'one' },
      { id: 'plugin-two', plugin: 'two' },
    ]);

    const registry = await unregisterPluginEngineConnections(loader, 'one');

    expect(
      registry.engineConnections.map((connection) => connection.id),
    ).toEqual(['plugin-two']);
    expect(registry.defaultAgents.map((agent) => agent.id)).toEqual([
      'station',
      'plugin-two',
    ]);
  });

  it('atomically replaces identities for an explicitly updated plugin', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });
    await replacePluginEngineConnections(loader, 'one', ['old', 'retained']);

    const registry = await replacePluginEngineConnections(loader, 'one', [
      'retained',
      'added',
    ]);

    expect(
      registry.engineConnections.map((connection) => connection.id),
    ).toEqual(['retained', 'added']);
    expect(registry.defaultAgents.map((agent) => agent.id)).toEqual([
      'station',
      'retained',
      'added',
    ]);
  });

  it('rejects the retired default identity as an engine/default pair', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });

    await expect(
      registerEngineConnection(loader, 'default', {
        kind: 'native',
      }),
    ).rejects.toMatchObject({ code: 'AGENT_ID_RESERVED' });
  });

  it('lower-level custom Agent writes fail closed when the registry is symlinked', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });
    await registerEngineConnection(loader, 'codex');
    const registryPath = join(home, 'config', 'agent-registry.json');
    const realRegistryPath = `${registryPath}.real`;
    const externalRegistry = join(
      home,
      '..',
      `${Date.now()}-external-agent-registry.json`,
    );
    homes.push(externalRegistry);
    renameSync(registryPath, realRegistryPath);
    writeFileSync(
      externalRegistry,
      JSON.stringify({
        version: 2,
        revision: 0,
        engineConnections: [],
        defaultAgents: [{ id: 'station', kind: 'station' }],
      }),
      'utf8',
    );
    symlinkSync(externalRegistry, registryPath);

    await expect(
      loader.createAgent({ name: 'Codex', prompt: 'must not be written' }),
    ).rejects.toMatchObject({ code: 'STATION_HOME_RESET_REQUIRED' });
    expect(existsSync(join(home, 'agents', 'codex', 'agent.json'))).toBe(false);
    expect(readFileSync(externalRegistry, 'utf8')).toContain('"revision":0');
  });
  it('commits an external connection and its same-ID default in one registry update', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });

    const registered = await registerEngineConnection(loader, 'claude');
    expect(registered).toMatchObject({
      revision: 1,
      engineConnections: [{ id: 'claude', source: { kind: 'native' } }],
      defaultAgents: expect.arrayContaining([
        {
          id: 'claude',
          kind: 'engine-connection',
          engineConnectionId: 'claude',
        },
      ]),
    });

    const removed = await unregisterEngineConnection(loader, 'claude');
    expect(removed.engineConnections).toEqual([]);
    expect(removed.defaultAgents).toEqual([{ id: 'station', kind: 'station' }]);
  });
  it('allows exactly one winner when a custom Agent races a same-ID engine default', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });
    await loadOrCreateAgentRegistry(loader);

    const results = await Promise.allSettled([
      loader.createAgent({ name: 'Codex', prompt: 'custom' }),
      registerEngineConnection(loader, 'codex'),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const registry = await loadOrCreateAgentRegistry(loader);
    const customExists = existsSync(
      join(home, 'agents', 'codex', 'agent.json'),
    );
    const defaultExists = registry.defaultAgents.some(
      (agent) => agent.id === 'codex',
    );
    expect(Number(customExists) + Number(defaultExists)).toBe(1);
  });
  it('initializes an empty home with a schema marker and immutable station seed', async () => {
    const home = createHome();
    const registry = await loadOrCreateAgentRegistry(
      new ConfigLoader({ projectHomeDir: home }),
    );

    expect(registry).toEqual({
      version: 2,
      revision: 0,
      engineConnections: [],
      defaultAgents: [{ id: 'station', kind: 'station' }],
    });
    expect(
      readFileSync(join(home, '.station-home-schema.json'), 'utf8'),
    ).toContain('"version": 1');
  });

  it('rejects the previous duplicate-identity registry instead of migrating it', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });
    await loadOrCreateAgentRegistry(loader);
    writeFileSync(
      join(home, 'config', 'agent-registry.json'),
      JSON.stringify({
        version: 1,
        revision: 0,
        engineConnections: [
          { id: 'claude', runtimeConnectionId: 'claude-runtime' },
        ],
        defaultAgents: [{ id: 'station', kind: 'station' }],
      }),
      'utf8',
    );

    await expect(loadOrCreateAgentRegistry(loader)).rejects.toMatchObject({
      code: 'STATION_HOME_RESET_REQUIRED',
    });
  });

  it('allows empty config scaffolding but rejects a markerless populated home without reading or changing it', async () => {
    const home = createHome();
    mkdirSync(join(home, 'config'));
    await expect(
      loadOrCreateAgentRegistry(new ConfigLoader({ projectHomeDir: home })),
    ).resolves.toBeDefined();

    const incompatible = createHome();
    mkdirSync(join(incompatible, 'config'));
    const appPath = join(incompatible, 'config', 'app.json');
    writeFileSync(appPath, '{"doNotRead":true}', 'utf8');
    const before = readFileSync(appPath, 'utf8');
    await expect(
      loadOrCreateAgentRegistry(
        new ConfigLoader({ projectHomeDir: incompatible }),
      ),
    ).rejects.toMatchObject({
      code: 'STATION_HOME_RESET_REQUIRED',
    } satisfies Partial<StationHomeResetRequiredError>);
    expect(readFileSync(appPath, 'utf8')).toBe(before);
    expect(() =>
      readFileSync(join(incompatible, '.station-home-schema.json')),
    ).toThrow();
  });

  it('refuses a future marker without mutating incompatible files', async () => {
    const home = createHome();
    const marker = join(home, '.station-home-schema.json');
    writeFileSync(marker, '{"version":999}', 'utf8');
    const before = readFileSync(marker, 'utf8');
    await expect(
      loadOrCreateAgentRegistry(new ConfigLoader({ projectHomeDir: home })),
    ).rejects.toMatchObject({
      code: 'STATION_HOME_SCHEMA_DOWNGRADE_REFUSED',
    });
    expect(readFileSync(marker, 'utf8')).toBe(before);
  });

  it('rejects marker, config, and registry symlinks without escaping the home', async () => {
    const markerHome = createHome();
    const externalMarker = join(markerHome, '..', `${Date.now()}-marker.json`);
    homes.push(externalMarker);
    writeFileSync(externalMarker, '{"version":1}', 'utf8');
    symlinkSync(externalMarker, join(markerHome, '.station-home-schema.json'));
    await expect(
      loadOrCreateAgentRegistry(
        new ConfigLoader({ projectHomeDir: markerHome }),
      ),
    ).rejects.toMatchObject({ code: 'STATION_HOME_RESET_REQUIRED' });

    const configHome = createHome();
    await ensureStationHomeSchema(configHome);
    const externalConfig = join(configHome, '..', `${Date.now()}-config`);
    homes.push(externalConfig);
    mkdirSync(externalConfig);
    symlinkSync(externalConfig, join(configHome, 'config'));
    await expect(
      loadOrCreateAgentRegistry(
        new ConfigLoader({ projectHomeDir: configHome }),
      ),
    ).rejects.toMatchObject({ code: 'STATION_HOME_RESET_REQUIRED' });

    const registryHome = createHome();
    const loader = new ConfigLoader({ projectHomeDir: registryHome });
    await loadOrCreateAgentRegistry(loader);
    const registryPath = join(registryHome, 'config', 'agent-registry.json');
    const externalRegistry = join(
      registryHome,
      '..',
      `${Date.now()}-registry.json`,
    );
    homes.push(externalRegistry);
    renameSync(registryPath, externalRegistry);
    symlinkSync(externalRegistry, registryPath);
    await expect(loadOrCreateAgentRegistry(loader)).rejects.toMatchObject({
      code: 'STATION_HOME_RESET_REQUIRED',
    });
  });

  it('fails closed when a marker is swapped to a symlink before a fallback open', async () => {
    const home = createHome();
    await ensureStationHomeSchema(home);
    const markerPath = join(home, '.station-home-schema.json');
    const movedMarker = `${markerPath}.moved`;
    const externalMarker = join(
      home,
      '..',
      `${Date.now()}-fallback-marker.json`,
    );
    homes.push(externalMarker);
    writeFileSync(externalMarker, '{"version":1}', 'utf8');

    await expect(
      ensureStationHomeSchema(home, {
        markerOpenFlags: constants.O_RDONLY,
        beforeMarkerOpen: () => {
          renameSync(markerPath, movedMarker);
          symlinkSync(externalMarker, markerPath);
        },
      }),
    ).rejects.toMatchObject({ code: 'STATION_HOME_RESET_REQUIRED' });
    expect(readFileSync(externalMarker, 'utf8')).toBe('{"version":1}');
  });

  it('refuses marker publication when application data appears after the initial check', async () => {
    const home = createHome();
    const appPath = join(home, 'config', 'app.json');
    await expect(
      ensureStationHomeSchema(home, {
        beforeMarkerRevalidate: () => {
          mkdirSync(join(home, 'config'));
          writeFileSync(appPath, '{"doNotRead":true}', 'utf8');
        },
      }),
    ).rejects.toMatchObject({ code: 'STATION_HOME_RESET_REQUIRED' });
    expect(readFileSync(appPath, 'utf8')).toBe('{"doNotRead":true}');
    expect(() =>
      readFileSync(join(home, '.station-home-schema.json'), 'utf8'),
    ).toThrow();
  });

  it('rejects a Station-home path swap before marker rename', async () => {
    const home = createHome();
    const movedHome = `${home}-moved`;
    homes.push(movedHome);
    await expect(
      ensureStationHomeSchema(home, {
        beforeMarkerRevalidate: () => {
          renameSync(home, movedHome);
          mkdirSync(home);
        },
      }),
    ).rejects.toMatchObject({ code: 'STATION_HOME_RESET_REQUIRED' });
    expect(() =>
      readFileSync(join(home, '.station-home-schema.json'), 'utf8'),
    ).toThrow();
    expect(() =>
      readFileSync(join(movedHome, '.station-home-schema.json'), 'utf8'),
    ).toThrow();
  });

  it('concurrently seeds exactly one complete registry', async () => {
    const home = createHome();
    const [first, second] = await Promise.all([
      loadOrCreateAgentRegistry(new ConfigLoader({ projectHomeDir: home })),
      loadOrCreateAgentRegistry(new ConfigLoader({ projectHomeDir: home })),
    ]);
    expect(first).toEqual(second);
    expect(
      JSON.parse(
        readFileSync(join(home, 'config', 'agent-registry.json'), 'utf8'),
      ),
    ).toEqual(first);
  });

  it('uses the sibling lock across independent processes', async () => {
    const home = createHome();
    await Promise.all([runSchemaGateInChild(home), runSchemaGateInChild(home)]);
    expect(
      readFileSync(join(home, '.station-home-schema.json'), 'utf8'),
    ).toContain('"version": 1');
  });

  it('accepts a canonicalized symlinked parent while rejecting a symlinked home root', async () => {
    const realParent = createHome();
    const linkedParent = `${realParent}-link`;
    homes.push(linkedParent);
    symlinkSync(realParent, linkedParent);
    const linkedHome = join(linkedParent, 'station-home');
    mkdirSync(join(realParent, 'station-home'));

    await ensureStationHomeSchema(linkedHome);
    expect(
      readFileSync(
        join(realParent, 'station-home', '.station-home-schema.json'),
        'utf8',
      ),
    ).toContain('"version": 1');

    const symlinkedHome = createHome();
    const symlinkTarget = createHome();
    const rootLink = `${symlinkedHome}-root-link`;
    homes.push(rootLink);
    symlinkSync(symlinkTarget, rootLink);
    await expect(ensureStationHomeSchema(rootLink)).rejects.toMatchObject({
      code: 'STATION_HOME_RESET_REQUIRED',
    });
  });

  it('rejects stale revisions and leaves the persisted registry unchanged', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });
    await loadOrCreateAgentRegistry(loader);
    const path = join(home, 'config', 'agent-registry.json');
    const before = readFileSync(path, 'utf8');
    await expect(
      updateAgentRegistry(loader, 1, (current) => ({ ...current })),
    ).rejects.toBeInstanceOf(AgentRegistryConflictError);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('rejects a stale source signature before replacing the registry', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });
    const registry = await loadOrCreateAgentRegistry(loader);
    const staleSignature = await agentRegistrySourceSignature(loader);
    const replacement = { ...registry, revision: 1 };
    await saveAgentRegistry(loader, replacement, staleSignature);
    const before = readFileSync(
      join(home, 'config', 'agent-registry.json'),
      'utf8',
    );

    await expect(
      saveAgentRegistry(
        loader,
        { ...replacement, revision: 2 },
        staleSignature,
      ),
    ).rejects.toBeInstanceOf(AgentRegistryConflictError);
    expect(
      readFileSync(join(home, 'config', 'agent-registry.json'), 'utf8'),
    ).toBe(before);
  });

  it('rejects a config-parent path swap immediately before registry rename', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });
    const registry = await loadOrCreateAgentRegistry(loader);
    const signature = await agentRegistrySourceSignature(loader);
    const configPath = join(home, 'config');
    const movedConfigPath = `${configPath}-moved`;
    await expect(
      saveAgentRegistry(loader, { ...registry, revision: 1 }, signature, {
        beforeRename: () => {
          renameSync(configPath, movedConfigPath);
          mkdirSync(configPath);
        },
      }),
    ).rejects.toMatchObject({ code: 'STATION_HOME_RESET_REQUIRED' });
    expect(
      readFileSync(join(movedConfigPath, 'agent-registry.json'), 'utf8'),
    ).toContain('"revision": 0');
    expect(() =>
      readFileSync(join(configPath, 'agent-registry.json'), 'utf8'),
    ).toThrow();
  });

  it('keeps the v1 registry shape ready for a hyphenated plugin engine default', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });
    await loadOrCreateAgentRegistry(loader);

    const updated = await updateAgentRegistry(loader, 0, (current) => ({
      ...current,
      engineConnections: [{ id: engineConnectionId('plugin-engine') }],
      defaultAgents: [
        ...current.defaultAgents,
        {
          id: agentId('plugin-engine'),
          kind: 'engine-connection' as const,
          engineConnectionId: engineConnectionId('plugin-engine'),
        },
      ],
    }));

    expect(updated).toMatchObject({
      revision: 1,
      engineConnections: [{ id: 'plugin-engine' }],
      defaultAgents: expect.arrayContaining([
        {
          id: 'plugin-engine',
          kind: 'engine-connection',
          engineConnectionId: 'plugin-engine',
        },
      ]),
    });
  });

  it('rejects an engine connection without its same-ID default Agent', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });
    await loadOrCreateAgentRegistry(loader);

    await expect(
      updateAgentRegistry(loader, 0, (current) => ({
        ...current,
        engineConnections: [{ id: engineConnectionId('plugin-engine') }],
      })),
    ).rejects.toThrow(
      'Every engine connection must own exactly one default Agent',
    );
  });

  it('rejects station as an engine connection ID', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });
    await loadOrCreateAgentRegistry(loader);

    await expect(
      updateAgentRegistry(loader, 0, (current) => ({
        ...current,
        engineConnections: [{ id: engineConnectionId('station') }],
      })),
    ).rejects.toBeInstanceOf(ReservedStationIdentityError);
  });

  it('rejects a partial registry read without rewriting it', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });
    await loadOrCreateAgentRegistry(loader);
    const path = join(home, 'config', 'agent-registry.json');
    writeFileSync(path, '{"version":1,"revision":', 'utf8');
    const before = readFileSync(path, 'utf8');
    await expect(loadOrCreateAgentRegistry(loader)).rejects.toThrow(
      SyntaxError,
    );
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('fails closed when a registry is swapped to a symlink before a fallback open', async () => {
    const home = createHome();
    const loader = new ConfigLoader({ projectHomeDir: home });
    await loadOrCreateAgentRegistry(loader);
    const path = join(home, 'config', 'agent-registry.json');
    const moved = `${path}.moved`;
    const external = join(home, '..', `${Date.now()}-fallback-registry.json`);
    homes.push(external);
    writeFileSync(
      external,
      JSON.stringify({
        version: 2,
        revision: 99,
        engineConnections: [],
        defaultAgents: [{ id: 'station', kind: 'station' }],
      }),
      'utf8',
    );

    await expect(
      loadOrCreateAgentRegistry(loader, {
        registryOpenFlags: constants.O_RDONLY,
        beforeRegistryOpen: () => {
          renameSync(path, moved);
          symlinkSync(external, path);
        },
      }),
    ).rejects.toMatchObject({ code: 'STATION_HOME_RESET_REQUIRED' });
    expect(readFileSync(external, 'utf8')).toContain('"revision":99');
  });
});

describe('agent identity mutation lock (#2646 review MEDIUM)', () => {
  it('acquires asynchronously: a contender waits without starving the event loop and takes a clean handoff', async () => {
    const home = createHome();
    // Every in-process acquirer of this lock file is async now — a sync
    // acquirer queued behind an async holder would Atomics.wait-spin the
    // event loop, which also blocks the holder's release from ever running
    // (deterministic full-timeout freeze). This pins the fixed behavior:
    // the contender's wait keeps timers firing and the handoff completes.
    const releaseHolder = await acquireAgentIdentityMutationLockAtHome(home);
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 10);
    try {
      const contention = acquireAgentIdentityMutationLockAtHome(home);
      // The handoff itself rides the event loop: if acquisition busy-waited
      // synchronously, this timer could never fire and the contender would
      // starve against a lock nobody can release.
      const handoff = setTimeout(() => {
        void releaseHolder();
      }, 200);
      const releaseContender = await contention;
      clearTimeout(handoff);
      expect(ticks).toBeGreaterThanOrEqual(4);
      await releaseContender();
    } finally {
      clearInterval(ticker);
    }
  });
});

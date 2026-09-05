import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCPLocalConnectionCustody } from '@kontourai/station-shared/mcp';
import { Client } from '@modelcontextprotocol/client';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { ConfigLoader } from '../../../domain/config-loader.js';
import {
  listProviders,
  type PluginProviderReadView,
  replacePluginProvidersForSource,
} from '../../../providers/registries/registry.js';
import { buildPlugin as buildInstalledPlugin } from '../../../routes/plugins/plugin-bundles.js';
import { registerPluginInstallRoutes } from '../../../routes/plugins/plugin-install-routes.js';
import {
  installPluginFromSource,
  uninstallInstalledPlugin,
} from '../../../routes/plugins/plugin-install-shared.js';
import { registerPluginLifecycleRoutes } from '../../../routes/plugins/plugin-lifecycle-routes.js';
import { installPluginDependency } from '../../../routes/plugins/plugin-source.js';
import { EventStore } from '../../orchestration/event-store.js';
import { AgentPluginLoader } from '../agent-plugin-loader.js';
import { MCPService } from '../mcp-service.js';
import {
  closePluginActivationSession,
  createPluginActivationSession,
} from '../plugin-activation-composition.js';
import { computePluginContentDigest } from '../plugin-content-integrity.js';
import { resolveInstalledPluginRoot } from '../plugin-incarnation.js';
import { derivePluginConsentBasis } from '../plugin-install-consent.js';
import {
  captureLocalPluginInstallation,
  createLocalPluginInstallationService,
  localPluginDataScopes,
  localPluginInstallationState,
  localPluginMaterializations,
  reconcileLocalPluginInstallations,
} from '../plugin-installation-local.js';
import type { PluginInstallationHost } from '../plugin-installation-service.js';
import { PluginInstallationService } from '../plugin-installation-service.js';
import { readPluginManifestFile } from '../plugin-manifest-loader.js';
import { grantPermissions } from '../plugin-permissions.js';

const homes: string[] = [],
  stores: EventStore[] = [],
  processes: ChildProcess[] = [],
  custodies: MCPLocalConnectionCustody[] = [];
afterEach(async () => {
  for (const custody of custodies.splice(0)) await custody.shutdown();
  for (const child of processes.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.disconnect();
      await exited;
    }
  }
  for (const store of stores.splice(0)) store.close();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'station-incarnation-'));
  homes.push(home);
  const plugins = join(home, 'plugins'),
    source = join(home, 'source');
  mkdirSync(plugins);
  mkdirSync(source);
  writeFileSync(
    join(source, 'plugin.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'fixture',
      version: '1.0.0',
    }),
  );
  mkdirSync(join(source, 'skills', 'fixture-skill'), { recursive: true });
  writeFileSync(
    join(source, 'skills', 'fixture-skill', 'SKILL.md'),
    '---\nname: fixture-skill\ndescription: Fixture skill\n---\nSource generation one.',
  );
  const store = new EventStore(join(home, 'events.sqlite'));
  stores.push(store);
  const journal = store.createPackageMcpAdmissionJournal();
  const digest = () =>
    computePluginContentDigest(dirname(source), basename(source))!;
  const service = () =>
    createLocalPluginInstallationService(plugins, journal, source);
  const deps = {
    pluginsDir: plugins,
    projectHomeDir: home,
    agentsDir: join(home, 'agents'),
    packageMcpJournal: journal,
    buildPlugin: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as any,
  };
  return { home, plugins, source, store, journal, digest, service, deps };
}
async function peer(home: string, source: string) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(
        new URL(
          './fixtures/plugin-installation-service-process.ts',
          import.meta.url,
        ),
      ),
      home,
      source,
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  processes.push(child);
  child.stdout?.resume();
  child.stderr?.resume();
  await once(child, 'message');
  let sequence = 0;
  return async (operation: string, input: unknown): Promise<any> => {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const listener = (message: any) => {
        if (message.id !== id) return;
        child.off('message', listener);
        message.error
          ? reject(new Error(message.error))
          : resolve(message.result);
      };
      child.on('message', listener);
      child.send({ id, operation, input });
    });
  };
}

test('actual installer, live child in a second runtime, and removal preserve physical code/data while fencing future calls', async () => {
  const f = fixture();
  writeFileSync(
    join(f.source, 'mcp.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: {
        fixture: {
          type: 'stdio',
          command: 'node',
          args: [
            fileURLToPath(
              new URL(
                '../../../../packages/shared/src/__tests__/fixtures/mcp-modern-server.mjs',
                import.meta.url,
              ),
            ),
          ],
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Portable MCP placeholder expands in the production loader.
          env: { STATION_MCP_TEST_RECEIPT: '${PLUGIN_DATA}/receipt.json' },
        },
      },
    }),
  );
  await installPluginFromSource(f.source, [], f.deps);
  const other = new EventStore(join(f.home, 'events.sqlite'));
  stores.push(other);
  const loader = new AgentPluginLoader({
    projectHomeDir: f.home,
    journal: () => other.createPackageMcpAdmissionJournal(),
  });
  const installed = loader.listInstalled()[0]!;
  expect(installed.root).toBe(realpathSync(join(f.plugins, 'fixture')));
  const custody = new MCPLocalConnectionCustody();
  custodies.push(custody);
  const claim = custody.acquire(installed.tools[0]!.id, 'managed');
  const connection = await claim.connect(installed.tools[0]!);
  expect(
    JSON.parse(readFileSync(join(installed.dataRoot, 'receipt.json'), 'utf8')),
  ).toMatchObject({
    root: installed.root,
    data: installed.dataRoot,
    cwd: installed.root,
  });
  const result = await uninstallInstalledPlugin('fixture', f.deps);
  expect(result).toMatchObject({
    success: true,
    lifecycle: { reclamation: 'not-proven' },
  });
  expect(loader.listInstalled()).toEqual([]);
  expect(claim.isCurrent()).toBe(false);
  expect(() =>
    connection.client.callTool({ name: 'echo', arguments: {} }),
  ).toThrow();
  expect(existsSync(installed.root)).toBe(true);
  expect(existsSync(join(installed.dataRoot, 'receipt.json'))).toBe(true);
  expect(f.journal.history('fixture')).toMatchObject({
    state: 'observed',
    generations: [
      { selected: false, possibleEffects: 1, reclamation: 'not-proven' },
    ],
  });
});

test('separate-process async service uses opaque CAS revisions, retains old data, and rejects stale update', async () => {
  const f = fixture(),
    remote = await peer(f.home, f.source);
  const installed = await f.service().install({
    installation: 'fixture',
    expected: null,
    artifact: { digest: f.digest() },
    origin: 'a'.repeat(64),
  });
  const prior = resolveInstalledPluginRoot(f.plugins, 'fixture')!;
  writeFileSync(join(prior.dataRoot!, 'state'), 'must survive');
  expect(await remote('inspect', 'fixture')).toEqual(installed.selected);
  const update = await remote('install', {
    installation: 'fixture',
    expected: installed.selected,
    artifact: { digest: f.digest() },
    origin: 'a'.repeat(64),
  });
  expect(update.data).toBe('preserved');
  expect(resolveInstalledPluginRoot(f.plugins, 'fixture')!.dataRoot).toBe(
    prior.dataRoot,
  );
  const replacement = await remote('install', {
    installation: 'fixture',
    expected: update.selected,
    artifact: { digest: f.digest() },
    origin: 'a'.repeat(64),
    data: 'retain-and-reset',
  });
  expect(replacement.selected.generation).not.toBe(
    installed.selected.generation,
  );
  expect(replacement.selected.scope).toBe(installed.selected.scope);
  expect(readFileSync(join(prior.dataRoot!, 'state'), 'utf8')).toBe(
    'must survive',
  );
  const current = resolveInstalledPluginRoot(f.plugins, 'fixture')!;
  expect(readdirSync(current.dataRoot!)).toEqual([]);
  await expect(f.service().withdraw(installed.selected)).rejects.toThrow(
    'changed',
  );
  expect(resolveInstalledPluginRoot(f.plugins, 'fixture')!.packageRoot).toBe(
    current.packageRoot,
  );
});

test('the actual install route uses transport-backed installation control and explicit local execution custody', async () => {
  const f = fixture();
  const remote = await peer(f.home, join(f.home, 'no-shared-source-path'));
  const payloads: string[] = [];
  const request = async (operation: string, input: unknown) => {
    payloads.push(JSON.stringify({ operation, input }));
    return remote(operation, input);
  };
  const host: PluginInstallationHost = {
    async service(artifact) {
      if (artifact) {
        const entries = [];
        for await (const entry of artifact.readEntries())
          entries.push(
            entry.kind === 'file'
              ? { ...entry, bytes: Buffer.from(entry.bytes).toString('base64') }
              : entry,
          );
        expect(
          await request('artifact', { digest: artifact.digest, entries }),
        ).toEqual({ digest: artifact.digest });
      }
      return {
        inspect: (id) => request('inspect', id),
        compensate: (input) => request('compensate', input),
        install: (input) => request('install', input),
        withdraw: (revision) => request('withdraw', revision),
        reconcile: (id) => request('reconcile', id),
      };
    },
    reconcile: () => request('reconcile-all', null),
  };
  const app = new Hono();
  registerPluginInstallRoutes(app, {
    ...f.deps,
    // Installation control travels through IPC; execution remains this
    // local adapter and uses its shared admission journal explicitly.
    packageMcpJournal: f.journal,
    installationHost: host,
  });
  const basis = derivePluginConsentBasis(
    f.source,
    await readPluginManifestFile(join(f.source, 'plugin.json')),
  )!;
  const response = await app.request('/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: f.source,
      consent: {
        permissions: basis.required,
        contentDigest: basis.contentDigest,
        dependencies: basis.dependencies,
      },
    }),
  });
  const result = (await response.json()) as {
    lifecycle: { selected: { artifact: { digest: string } } };
  };
  expect(result).toMatchObject({ success: true, plugin: { name: 'fixture' } });
  expect(result.lifecycle.selected.artifact.digest).toBe(f.digest());
  const installed = new AgentPluginLoader({
    projectHomeDir: f.home,
    journal: () => f.journal,
  }).listInstalled()[0]!;
  expect(readFileSync(installed.skills[0]!.manifestPath, 'utf8')).toContain(
    'Source generation one',
  );
  expect(payloads.join('\n')).not.toContain(f.home);
  expect(
    payloads.some((payload) => payload.includes('"operation":"artifact"')),
  ).toBe(true);
});

test.each(['con', 'nul', 'com1', 'con.foo'])(
  'logical name %s uses a safe local key without narrowing the package grammar',
  async (name) => {
    const f = fixture();
    writeFileSync(
      join(f.source, 'plugin.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name,
        version: '1.0.0',
      }),
    );
    await installPluginFromSource(f.source, [], f.deps);
    const installed = resolveInstalledPluginRoot(f.plugins, name)!;
    expect(installed.packageRoot).toContain(`plugin-${name}`);
    expect(installed.dataRoot).toContain(`plugin-${name}`);
    expect(
      new AgentPluginLoader({
        projectHomeDir: f.home,
        journal: () => f.journal,
      })
        .listInstalled()
        .map((plugin) => plugin.manifest.name),
    ).toEqual([name]);
    const app = new Hono();
    registerPluginInstallRoutes(app, f.deps);
    registerPluginLifecycleRoutes(app, f.deps);
    const listed = (await (await app.request('/')).json()) as {
      plugins: unknown[];
    };
    expect(listed.plugins).toMatchObject([{ name, retainedOnRemoval: true }]);
    const response = await app.request(`/${name}`, { method: 'DELETE' });
    const removed = await response.json();
    expect(removed, JSON.stringify(removed)).toMatchObject({
      success: true,
      lifecycle: { reclamation: 'not-proven' },
    });
    expect(existsSync(installed.packageRoot)).toBe(true);
  },
);

test.each([false, true])(
  'the Update route installs a new code generation from its source and keeps the exact data scope (alias absent: %s)',
  async (removeAlias) => {
    const f = fixture();
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', f.source, ...args], {
        windowsHide: true,
        stdio: 'ignore',
      });
    git('init', '-b', 'main');
    git('remote', 'add', 'origin', f.source);
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'Initial fixture',
    );
    await installPluginFromSource(f.source, [], f.deps);
    const before = resolveInstalledPluginRoot(f.plugins, 'fixture')!;
    writeFileSync(join(before.dataRoot!, 'state'), 'persistent value');
    writeFileSync(
      join(f.source, 'plugin.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'fixture',
        version: '2.0.0',
      }),
    );
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'Next fixture',
    );
    const app = new Hono();
    registerPluginLifecycleRoutes(app, f.deps);
    if (removeAlias) unlinkSync(join(f.plugins, 'fixture'));
    const response = await app.request('/fixture/update', { method: 'POST' });
    const body = await response.json();
    expect(body, JSON.stringify(body)).toMatchObject({
      success: true,
      plugin: { version: '2.0.0' },
      lifecycle: { data: 'preserved' },
    });
    const after = resolveInstalledPluginRoot(f.plugins, 'fixture')!;
    expect(after.packageRoot).not.toBe(before.packageRoot);
    expect(after.dataScope).toBe(before.dataScope);
    expect(readFileSync(join(after.dataRoot!, 'state'), 'utf8')).toBe(
      'persistent value',
    );
    expect(existsSync(join(before.packageRoot, 'plugin.json'))).toBe(true);
  },
);

test.each(['ready', 'pending'] as const)(
  'DELETE withdraws a %s installation without its compatibility alias and retains data',
  async (phase) => {
    const f = fixture();
    const session = createPluginActivationSession();
    try {
      await installPluginFromSource(
        f.source,
        [],
        f.deps,
        phase === 'pending' ? { activationSession: session } : {},
      );
    } finally {
      closePluginActivationSession(session);
    }
    const captured = captureLocalPluginInstallation(
      f.plugins,
      f.journal,
      'fixture',
    )!;
    expect(captured.isCurrent()).toBe(phase === 'ready');
    writeFileSync(join(captured.root.dataRoot!, 'retained-value'), 'keep this');
    unlinkSync(join(f.plugins, 'fixture'));
    const app = new Hono();
    registerPluginLifecycleRoutes(app, f.deps);
    const response = await app.request('/fixture', { method: 'DELETE' });
    expect(await response.json()).toMatchObject({
      success: true,
      lifecycle: { reclamation: 'not-proven' },
    });
    expect(f.journal.currentInstallation('fixture').state).toBe('not-observed');
    expect(
      readFileSync(join(captured.root.dataRoot!, 'retained-value'), 'utf8'),
    ).toBe('keep this');
    expect(existsSync(captured.root.packageRoot)).toBe(true);
  },
);

test('a captured definition cannot start a child after another runtime withdraws it', async () => {
  const f = fixture();
  writeFileSync(
    join(f.source, 'mcp.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: {
        fixture: {
          type: 'stdio',
          command: 'node',
          args: ['-e', 'throw new Error("must never execute")'],
        },
      },
    }),
  );
  await installPluginFromSource(f.source, [], f.deps);
  const other = new EventStore(join(f.home, 'events.sqlite'));
  stores.push(other);
  const loader = new AgentPluginLoader({
    projectHomeDir: f.home,
    journal: () => other.createPackageMcpAdmissionJournal(),
  });
  const definition = loader.listInstalled()[0]!.tools[0]!;
  const custody = new MCPLocalConnectionCustody();
  custodies.push(custody);
  const claim = custody.acquire(definition.id, 'probe');
  await uninstallInstalledPlugin('fixture', f.deps);
  expect(() => claim.connect(definition)).toThrow('stale');
  expect(f.journal.history('fixture')).toMatchObject({
    state: 'observed',
    generations: [{ possibleEffects: 0, reserved: 0 }],
  });
});

test('an explicit data reset remains bound to the installation revision the operator previewed', async () => {
  const f = fixture();
  await installPluginFromSource(f.source, [], f.deps);
  const preview = await f.service().inspect('fixture');
  await installPluginFromSource(f.source, [], f.deps);
  const current = resolveInstalledPluginRoot(f.plugins, 'fixture')!;
  await expect(
    installPluginFromSource(f.source, [], f.deps, {
      dataPolicy: 'retain-and-reset',
      expectedInstallation: preview,
    }),
  ).rejects.toThrow('changed');
  expect(resolveInstalledPluginRoot(f.plugins, 'fixture')!.dataScope).toBe(
    current.dataScope,
  );
  await expect(
    installPluginFromSource(f.source, [], f.deps, {
      dataPolicy: 'retain-and-reset',
    }),
  ).rejects.toThrow('Preview');
});

test('legacy dependency creation refuses a portable copy, then adopts an independently owned portable installation without rebuilding it', async () => {
  const f = fixture();
  const provider = () => ({ install: vi.fn() });
  const build = vi.fn();
  const refused = await installPluginDependency(
    { id: 'fixture', source: f.source },
    f.plugins,
    provider,
    build,
    f.deps.logger,
  );
  expect(refused).toMatchObject({
    success: false,
    error: expect.stringContaining('canonical installation owner'),
  });
  expect(existsSync(join(f.plugins, 'fixture'))).toBe(false);
  expect(build).not.toHaveBeenCalled();
  await installPluginFromSource(f.source, [], f.deps);
  expect(
    await installPluginDependency(
      { id: 'fixture', source: f.source },
      f.plugins,
      provider,
      build,
      f.deps.logger,
    ),
  ).toMatchObject({ success: true });
  expect(build).not.toHaveBeenCalled();
});

test.each(['before', 'after'] as const)(
  'fresh publication failure %s pointer write is repairable from durable selection after restart',
  async (moment) => {
    const f = fixture();
    const materializer = localPluginMaterializations(f.plugins, f.source);
    const faulty = new PluginInstallationService(
      localPluginInstallationState(f.journal),
      {
        ...materializer,
        async select(id, next, expected) {
          if (moment === 'after') await materializer.select(id, next, expected);
          throw new Error('publication interrupted');
        },
      },
      localPluginDataScopes(f.plugins),
    );
    await expect(
      faulty.install({
        installation: 'fixture',
        expected: null,
        artifact: { digest: f.digest() },
        origin: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'plugin-projection-pending' });
    const recorded = await f.service().inspect('fixture');
    expect(recorded).not.toBeNull();
    // The selected immutable artifact, not an absent/stale alias, owns reads.
    expect(
      new AgentPluginLoader({
        projectHomeDir: f.home,
        journal: () => f.journal,
      })
        .listInstalled()
        .map((item) => item.manifest.name),
    ).toEqual(['fixture']);
    stores.splice(stores.indexOf(f.store), 1);
    f.store.close();
    const restarted = new EventStore(join(f.home, 'events.sqlite'));
    stores.push(restarted);
    expect(
      await reconcileLocalPluginInstallations(
        f.plugins,
        restarted.createPackageMcpAdmissionJournal(),
      ),
    ).toEqual({ status: 'applied', pending: [] });
    const recovered = createLocalPluginInstallationService(
      f.plugins,
      restarted.createPackageMcpAdmissionJournal(),
      f.source,
    );
    expect(await recovered.inspect('fixture')).toEqual(recorded);
    expect(resolveInstalledPluginRoot(f.plugins, 'fixture')!.generation).toBe(
      recorded!.materialization,
    );
    await expect(
      recovered.install({
        installation: 'fixture',
        expected: recorded,
        artifact: { digest: f.digest() },
        origin: 'a'.repeat(64),
      }),
    ).resolves.toMatchObject({ data: 'preserved' });
  },
);

test('a delayed projection cannot replace a newer selected materialization', async () => {
  const f = fixture();
  const first = await f.service().install({
    installation: 'fixture',
    expected: null,
    artifact: { digest: f.digest() },
    origin: 'a'.repeat(64),
  });
  const staleMaterializer = localPluginMaterializations(f.plugins, f.source);
  const captured = await staleMaterializer.current('fixture');
  const replacement = await f.service().install({
    installation: 'fixture',
    expected: first.selected,
    artifact: { digest: f.digest() },
    origin: 'a'.repeat(64),
  });
  await expect(
    staleMaterializer.select('fixture', captured, captured),
  ).rejects.toThrow('changed');
  expect(resolveInstalledPluginRoot(f.plugins, 'fixture')!.generation).toBe(
    replacement.selected.materialization,
  );
});

test('more than 512 actual service probes retain audit evidence without consuming the live-claim quota', async () => {
  const f = fixture();
  writeFileSync(
    join(f.source, 'mcp.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: { fixture: { type: 'stdio', command: 'node' } },
    }),
  );
  await installPluginFromSource(f.source, [], f.deps);
  const source = new AgentPluginLoader({
    projectHomeDir: f.home,
    journal: () => f.journal,
  });
  const loader = new ConfigLoader({
    projectHomeDir: f.home,
    integrationSources: [source],
  });
  const custody = new MCPLocalConnectionCustody();
  custodies.push(custody);
  const service = new MCPService(
    loader,
    new Map(),
    new Map(),
    new Map(),
    new Map(),
    new Map(),
    f.deps.logger,
    undefined,
    43149,
    undefined,
    undefined,
    custody,
  );
  vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [] });
  vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined);
  const definition = source.listInstalled()[0]!.tools[0]!;
  try {
    for (let index = 0; index < 520; index++)
      expect((await service.probeIntegration(definition.id)).probe?.ok).toBe(
        true,
      );
    const current = f.journal.currentInstallation('fixture');
    if (current.state !== 'observed') throw new Error('missing selection');
    expect(f.journal.inspect(current.installation)).toMatchObject({
      localSettled: 520,
      possibleEffects: 520,
      reserved: 0,
      mutationAllowed: false,
    });
    expect(custody.inspect().retained).toBe(0);
    expect(existsSync(source.listInstalled()[0]!.root)).toBe(true);
  } finally {
    await loader.dispose();
  }
}, 20000);

test('more than 256 sequential updates use paged durable history while retaining the first code and data', async () => {
  const f = fixture();
  let outcome = await f.service().install({
    installation: 'fixture',
    expected: null,
    artifact: { digest: f.digest() },
    origin: 'a'.repeat(64),
  });
  const first = resolveInstalledPluginRoot(f.plugins, 'fixture')!;
  for (let index = 0; index < 260; index++)
    outcome = await f.service().install({
      installation: 'fixture',
      expected: outcome.selected,
      artifact: { digest: f.digest() },
      origin: 'a'.repeat(64),
    });
  expect(resolveInstalledPluginRoot(f.plugins, 'fixture')!.dataScope).toBe(
    first.dataScope,
  );
  expect(existsSync(first.packageRoot)).toBe(true);
  const generations = new Set<string>();
  let after: number | undefined;
  do {
    const page = f.journal.history('fixture', { after, limit: 25 });
    if (page.state !== 'observed') throw new Error('history unavailable');
    for (const entry of page.generations) {
      expect(entry.reclamation).toBe('not-proven');
      generations.add(entry.installation.incarnation);
    }
    after = page.nextCursor;
  } while (after !== undefined);
  expect(generations.size).toBe(261);
}, 20000);

test('failed state replacement restores the prior pointer without copying a mutable data snapshot', async () => {
  const f = fixture();
  const first = await f.service().install({
    installation: 'fixture',
    expected: null,
    artifact: { digest: f.digest() },
    origin: 'a'.repeat(64),
  });
  const prior = resolveInstalledPluginRoot(f.plugins, 'fixture')!;
  const state = localPluginInstallationState(f.journal);
  const faulty = new PluginInstallationService(
    {
      ...state,
      async fence(expected) {
        const held = await state.fence(expected);
        return {
          ...held,
          async replace() {
            writeFileSync(
              join(prior.dataRoot!, 'late-write'),
              'not in any backup',
            );
            throw new Error('commit failed');
          },
        };
      },
    },
    localPluginMaterializations(f.plugins, f.source),
    localPluginDataScopes(f.plugins),
  );
  await expect(
    faulty.install({
      installation: 'fixture',
      expected: first.selected,
      artifact: { digest: f.digest() },
      origin: 'a'.repeat(64),
      data: 'retain-and-reset',
    }),
  ).rejects.toThrow('commit failed');
  expect(resolveInstalledPluginRoot(f.plugins, 'fixture')!.packageRoot).toBe(
    prior.packageRoot,
  );
  expect(readFileSync(join(prior.dataRoot!, 'late-write'), 'utf8')).toBe(
    'not in any backup',
  );
  expect(
    f.journal.inspect(
      f.journal.currentInstallation('fixture').state === 'observed'
        ? (f.journal.currentInstallation('fixture') as any).installation
        : (null as never),
    ),
  ).toMatchObject({ admission: 'open' });
});

test.runIf(process.platform !== 'win32')(
  'hostile pointers and retargeted data siblings never become supported incarnations',
  async () => {
    const f = fixture();
    symlinkSync(f.source, join(f.plugins, 'fixture'), 'dir');
    expect(() => resolveInstalledPluginRoot(f.plugins, 'fixture')).toThrow(
      'unsafe',
    );
    unlinkSync(join(f.plugins, 'fixture'));
    await f.service().install({
      installation: 'fixture',
      expected: null,
      artifact: { digest: f.digest() },
      origin: 'a'.repeat(64),
    });
    const root = resolveInstalledPluginRoot(f.plugins, 'fixture')!;
    rmSync(root.dataRoot!, { recursive: true });
    symlinkSync(f.source, root.dataRoot!, 'dir');
    expect(() => resolveInstalledPluginRoot(f.plugins, 'fixture')).toThrow(
      'unsafe',
    );
  },
);

test('retained selection rollback mints fresh admission, preserves data, and refuses forged history', async () => {
  const f = fixture();
  const origin = 'a'.repeat(64);
  const first = await f.service().install({
    installation: 'fixture',
    expected: null,
    artifact: { digest: f.digest() },
    origin,
  });
  const original = resolveInstalledPluginRoot(f.plugins, 'fixture')!;
  writeFileSync(join(original.dataRoot!, 'state'), 'user state');
  const second = await f.service().install({
    installation: 'fixture',
    expected: first.selected,
    artifact: { digest: f.digest() },
    origin,
  });
  const restored = await f
    .service()
    .compensate({ expected: second.selected, retained: first.selected });
  expect(restored.generation).not.toBe(first.selected.generation);
  expect(restored.generation).not.toBe(second.selected.generation);
  expect(restored.materialization).toBe(first.selected.materialization);
  expect(restored.dataScope).toBe(first.selected.dataScope);
  expect(readFileSync(join(original.dataRoot!, 'state'), 'utf8')).toBe(
    'user state',
  );
  await expect(
    f.service().compensate({
      expected: restored,
      retained: { ...first.selected, origin: 'b'.repeat(64) },
    }),
  ).rejects.toThrow(/changed/);
  expect(await f.service().inspect('fixture')).toEqual(restored);
});

test('acquisition origin changes or omission cannot inherit a provenance-bound data scope', async () => {
  const f = fixture();
  const origin = 'a'.repeat(64);
  const first = await f.service().install({
    installation: 'fixture',
    expected: null,
    artifact: { digest: f.digest() },
    origin,
  });
  for (const replacement of ['b'.repeat(64), undefined]) {
    await expect(
      f.service().install({
        installation: 'fixture',
        expected: first.selected,
        artifact: { digest: f.digest() },
        origin: replacement as string,
      }),
    ).rejects.toThrow(/migration is required|origin is required/);
  }
  expect(await f.service().inspect('fixture')).toEqual(first.selected);
});

async function namespaceConsent(source: string) {
  const basis = derivePluginConsentBasis(
    source,
    await readPluginManifestFile(join(source, 'plugin.json')),
  )!;
  return {
    kind: 'operator-decision' as const,
    contentDigest: basis.contentDigest,
    permissions: basis.required,
    dependencies: basis.dependencies,
  };
}

test('the managed installer activates declared Station Agents and withdrawal removes host contributions while retaining data', async () => {
  const f = fixture();
  const manifest = {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'fixture',
    version: '1',
    extensions: {
      'io.kontourai.station': {
        schemaVersion: '1.0',
        title: 'Fixture Station extension',
        agents: [
          {
            slug: 'fixture-echo',
            source: './io.kontourai.station/echo/agent.json',
          },
        ],
      },
    },
  };
  writeFileSync(join(f.source, 'plugin.json'), JSON.stringify(manifest));
  mkdirSync(join(f.source, 'io.kontourai.station', 'echo'), {
    recursive: true,
  });
  writeFileSync(
    join(f.source, 'io.kontourai.station', 'echo', 'agent.json'),
    JSON.stringify({ name: 'Fixture Echo', prompt: 'Echo' }),
  );
  const result = await installPluginFromSource(f.source, [], f.deps, {
    consent: await namespaceConsent(f.source),
  });
  expect(result.plugin.agents).toEqual([{ slug: 'fixture-echo' }]);
  expect(
    JSON.parse(
      readFileSync(
        join(f.home, 'agents', 'fixture-echo', 'agent.json'),
        'utf8',
      ),
    ).name,
  ).toBe('Fixture Echo');
  const original = resolveInstalledPluginRoot(f.plugins, 'fixture')!;
  writeFileSync(join(original.dataRoot!, 'state'), 'retained');
  await uninstallInstalledPlugin('fixture', f.deps);
  expect(existsSync(join(f.home, 'agents', 'fixture-echo'))).toBe(false);
  expect(existsSync(original.packageRoot)).toBe(true);
  expect(readFileSync(join(original.dataRoot!, 'state'), 'utf8')).toBe(
    'retained',
  );
});

test('managed activation failure restores prior code and Agent ownership without touching shared data', async () => {
  const f = fixture();
  const manifest = {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'fixture',
    version: '1',
    extensions: {
      'io.kontourai.station': {
        schemaVersion: '1.0',
        agents: [
          {
            slug: 'fixture-echo',
            source: './io.kontourai.station/echo/agent.json',
          },
        ],
      },
    },
  };
  writeFileSync(join(f.source, 'plugin.json'), JSON.stringify(manifest));
  mkdirSync(join(f.source, 'io.kontourai.station', 'echo'), {
    recursive: true,
  });
  writeFileSync(
    join(f.source, 'io.kontourai.station', 'echo', 'agent.json'),
    JSON.stringify({ name: 'Before', prompt: 'Echo' }),
  );
  await installPluginFromSource(f.source, [], f.deps, {
    consent: await namespaceConsent(f.source),
  });
  const original = resolveInstalledPluginRoot(f.plugins, 'fixture')!;
  const originalRevision = await f.service().inspect('fixture');
  writeFileSync(join(original.dataRoot!, 'state'), 'retained');
  writeFileSync(
    join(f.source, 'io.kontourai.station', 'echo', 'agent.json'),
    JSON.stringify({ name: 'After', prompt: 'Echo' }),
  );
  const reconcile = vi
    .fn()
    .mockRejectedValueOnce(new Error('activation failed'))
    .mockResolvedValue(undefined);
  await expect(
    installPluginFromSource(
      f.source,
      [],
      {
        ...f.deps,
        reconcileEngineConnections: reconcile,
      },
      { consent: await namespaceConsent(f.source) },
    ),
  ).rejects.toThrow(/activation failed/);
  const restored = await f.service().inspect('fixture');
  expect(restored?.materialization).toBe(originalRevision?.materialization);
  expect(restored?.generation).not.toBe(originalRevision?.generation);
  expect(
    JSON.parse(
      readFileSync(
        join(f.home, 'agents', 'fixture-echo', 'agent.json'),
        'utf8',
      ),
    ).name,
  ).toBe('Before');
  expect(readFileSync(join(original.dataRoot!, 'state'), 'utf8')).toBe(
    'retained',
  );
});

test('the generic service refuses missing acquisition provenance on fresh and historical installations', async () => {
  const f = fixture();
  await expect(
    f.service().install({
      installation: 'fixture',
      expected: null,
      artifact: { digest: f.digest() },
      origin: undefined as unknown as string,
    }),
  ).rejects.toThrow(/origin is required/);
  const data = await localPluginDataScopes(f.plugins).prepare(
    'fixture',
    null,
    'preserve',
  );
  const materializer = localPluginMaterializations(f.plugins, f.source);
  const materialization = await materializer.prepare(
    'fixture',
    { digest: f.digest() },
    data,
  );
  const unknown = await localPluginInstallationState(f.journal).create(
    'fixture',
    materialization,
  );
  await materializer.select('fixture', materialization, null);
  await expect(
    f.service().install({
      installation: 'fixture',
      expected: unknown,
      artifact: { digest: f.digest() },
      origin: 'a'.repeat(64),
    }),
  ).rejects.toThrow(/origin is unknown/);
  expect(await f.service().inspect('fixture')).toEqual(unknown);
});

test('managed consent refuses a physically changed selected artifact before granting its declared permissions', async () => {
  const f = fixture();
  writeFileSync(
    join(f.source, 'plugin.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'fixture',
      version: '1',
      extensions: {
        'io.kontourai.station': {
          schemaVersion: '1.0',
          permissions: ['providers.register'],
        },
      },
    }),
  );
  let changed = false;
  const journal = {
    ...f.journal,
    activationInstallation(
      permit: Parameters<typeof f.journal.activationInstallation>[0],
    ) {
      const current = f.journal.activationInstallation(permit);
      if (!changed) {
        changed = true;
        const root = resolveInstalledPluginRoot(f.plugins, 'fixture')!;
        writeFileSync(
          join(root.packageRoot, 'unreviewed.txt'),
          'unreviewed package mutation',
        );
      }
      return current;
    },
  };
  await expect(
    installPluginFromSource(
      f.source,
      [],
      { ...f.deps, packageMcpJournal: journal },
      { consent: await namespaceConsent(f.source) },
    ),
  ).rejects.toThrow();
  expect(changed).toBe(true);
  expect(await f.service().inspect('fixture')).toBeNull();
});

test('managed namespace build uses the existing builder with validated fields and ignores portable root lookalikes', async () => {
  const f = fixture();
  writeFileSync(
    join(f.source, 'plugin.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'fixture',
      version: '1',
      entrypoint: './must-not-build.ts',
      build: 'must-not-run',
      extensions: {
        'io.kontourai.station': {
          schemaVersion: '1.0',
          entrypoint: './io.kontourai.station/index.js',
        },
      },
    }),
  );
  mkdirSync(join(f.source, 'io.kontourai.station'), { recursive: true });
  writeFileSync(
    join(f.source, 'io.kontourai.station', 'index.js'),
    'export const reviewedMarker = "namespace-build-witness";',
  );
  const result = await installPluginFromSource(
    f.source,
    [],
    {
      ...f.deps,
      buildPlugin: (dir, name, manifest) =>
        buildInstalledPlugin(dir, name, f.deps.logger, manifest),
    },
    { consent: await namespaceConsent(f.source) },
  );
  expect(result.plugin.hasBundle).toBe(true);
  const root = resolveInstalledPluginRoot(f.plugins, 'fixture')!;
  expect(
    readFileSync(join(root.packageRoot, 'dist', 'bundle.js'), 'utf8'),
  ).toContain('namespace-build-witness');
});

test('managed provider compensation uses an expiring private view while public providers wait for ready', async () => {
  const f = fixture();
  writeFileSync(
    join(f.source, 'plugin.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'fixture',
      version: '1.0.0',
      extensions: {
        'io.kontourai.station': {
          schemaVersion: '1.0',
          permissions: ['providers.register'],
          providers: [{ type: 'acpConnections', module: './provider.mjs' }],
        },
      },
    }),
  );
  writeFileSync(
    join(f.source, 'provider.mjs'),
    "export default Object.freeze({getConnections(){return [{id:'fixture-engine'}]}});",
  );
  expect(
    (await readPluginManifestFile(join(f.source, 'plugin.json'))).providers,
  ).toEqual([{ type: 'acpConnections', module: './provider.mjs' }]);
  // Initial install deliberately cannot grant trusted providers.register. This
  // fixture supplies that trusted decision through the existing grant owner,
  // then exercises compensation of a failed update under a new pending generation.
  const initial = await installPluginFromSource(f.source, [], f.deps, {
    consent: await namespaceConsent(f.source),
  });
  expect(initial.permissions.pendingConsent).toContainEqual({
    permission: 'providers.register',
    tier: 'trusted',
  });
  const grantedArtifact = captureLocalPluginInstallation(
    f.plugins,
    f.journal,
    'fixture',
  )!;
  await grantPermissions(f.home, 'fixture', ['providers.register'], {
    pluginId: 'fixture',
    digest: grantedArtifact.installation!.contentDigest,
    isCurrent: () =>
      grantedArtifact.isCurrent() &&
      computePluginContentDigest(
        dirname(grantedArtifact.root.packageRoot),
        basename(grantedArtifact.root.packageRoot),
      ) === grantedArtifact.installation!.contentDigest,
  });
  let privateProvider: any;
  const observations: Array<{
    publicCount: number;
    privateIds: string[];
    ready: boolean;
  }> = [];
  try {
    let reconcileCalls = 0;
    const installing = installPluginFromSource(
      f.source,
      [],
      {
        ...f.deps,
        reconcileEngineConnections: async (
          _name: string,
          view?: PluginProviderReadView,
        ) => {
          if (++reconcileCalls === 1)
            throw new Error('Injected provider reconciliation failure');
          expect(view).toBeDefined();
          const selected = f.journal.currentInstallation('fixture');
          if (selected.state !== 'observed')
            throw new Error('Installation disappeared');
          privateProvider = listProviders('acpConnections', view).find(
            (entry) => entry.source === 'fixture',
          )?.provider;
          observations.push({
            publicCount: listProviders('acpConnections').filter(
              (entry) => entry.source === 'fixture',
            ).length,
            privateIds:
              privateProvider?.getConnections().map((entry: any) => entry.id) ??
              [],
            ready: f.journal.admissionOpen(selected.installation),
          });
        },
      },
      { consent: await namespaceConsent(f.source) },
    );
    await expect(installing).rejects.toThrow(
      'Injected provider reconciliation failure',
    );
    expect(observations).toEqual([
      { publicCount: 0, privateIds: ['fixture-engine'], ready: false },
    ]);
    expect(() => privateProvider.getConnections()).toThrow();
    const publicProvider = listProviders('acpConnections').find(
      (entry) => entry.source === 'fixture',
    )!.provider as any;
    expect(publicProvider.getConnections()).toEqual([{ id: 'fixture-engine' }]);
    await uninstallInstalledPlugin('fixture', f.deps);
    expect(() => publicProvider.getConnections()).toThrow();
    expect(
      listProviders('acpConnections').filter(
        (entry) => entry.source === 'fixture',
      ),
    ).toEqual([]);
  } finally {
    await replacePluginProvidersForSource('fixture', []);
  }
});

test('the public portable author example installs its Skill and Station Agent through the managed owner', async () => {
  const f = fixture();
  const source = fileURLToPath(
    new URL('../../../../examples/portable-author-kit/', import.meta.url),
  );
  const result = await installPluginFromSource(source, [], f.deps, {
    consent: await namespaceConsent(source),
  });
  expect(result.plugin.name).toBe('portable-author-kit');
  const loader = new AgentPluginLoader({
    projectHomeDir: f.home,
    journal: () => f.journal,
  });
  const installed = loader
    .listInstalled()
    .find((plugin) => plugin.manifest.name === 'portable-author-kit');
  expect(installed?.skills.map((skill) => skill.name)).toEqual(['draft-brief']);
  const agent = await new ConfigLoader({ projectHomeDir: f.home }).loadAgent(
    'portable-author-note',
  );
  expect(agent?.prompt).toContain('Preserve stated facts');
  await uninstallInstalledPlugin('portable-author-kit', f.deps);
  expect(
    loader
      .listInstalled()
      .some((plugin) => plugin.manifest.name === 'portable-author-kit'),
  ).toBe(false);
});

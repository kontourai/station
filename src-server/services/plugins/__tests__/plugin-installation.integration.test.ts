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
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import {
  installPluginFromSource,
  uninstallInstalledPlugin,
} from '../../../routes/plugins/plugin-install-shared.js';
import { registerPluginLifecycleRoutes } from '../../../routes/plugins/plugin-lifecycle-routes.js';
import { installPluginDependency } from '../../../routes/plugins/plugin-source.js';
import { EventStore } from '../../orchestration/event-store.js';
import { AgentPluginLoader } from '../agent-plugin-loader.js';
import { computePluginContentDigest } from '../plugin-content-integrity.js';
import { resolveInstalledPluginRoot } from '../plugin-incarnation.js';
import {
  createLocalPluginInstallationService,
  localPluginDataScopes,
  localPluginInstallationState,
  localPluginMaterializations,
} from '../plugin-installation-local.js';
import { PluginInstallationService } from '../plugin-installation-service.js';

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
  });
  const prior = resolveInstalledPluginRoot(f.plugins, 'fixture')!;
  writeFileSync(join(prior.dataRoot!, 'state'), 'must survive');
  expect(await remote('inspect', 'fixture')).toEqual(installed.selected);
  const update = await remote('install', {
    installation: 'fixture',
    expected: installed.selected,
    artifact: { digest: f.digest() },
  });
  expect(update.data).toBe('preserved');
  expect(resolveInstalledPluginRoot(f.plugins, 'fixture')!.dataRoot).toBe(
    prior.dataRoot,
  );
  const replacement = await remote('install', {
    installation: 'fixture',
    expected: update.selected,
    artifact: { digest: f.digest() },
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

test('the Update route installs a new code generation from its source and keeps the exact data scope', async () => {
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
  const response = await app.request('/fixture/update', { method: 'POST' });
  const body = await response.json();
  expect(body).toMatchObject({
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
});

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
    error: expect.stringContaining('through Plugins'),
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

test('failed state replacement restores the prior pointer without copying a mutable data snapshot', async () => {
  const f = fixture();
  const first = await f.service().install({
    installation: 'fixture',
    expected: null,
    artifact: { digest: f.digest() },
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
    });
    const root = resolveInstalledPluginRoot(f.plugins, 'fixture')!;
    rmSync(root.dataRoot!, { recursive: true });
    symlinkSync(f.source, root.dataRoot!, 'dir');
    expect(() => resolveInstalledPluginRoot(f.plugins, 'fixture')).toThrow(
      'unsafe',
    );
  },
);

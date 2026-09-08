import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { registerPluginInstallRoutes } from '../../../routes/plugins/plugin-install-routes.js';
import { EventStore } from '../../orchestration/event-store.js';
import { AgentPluginLoader } from '../agent-plugin-loader.js';
import { resolveInstalledPluginRoot } from '../plugin-incarnation.js';
import { getPluginGrants, revokeGrants } from '../plugin-permissions.js';

const homes: string[] = [],
  children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
async function run(home: string, source: string, stage: string) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(
        new URL(
          './fixtures/plugin-installation-restart-process.ts',
          import.meta.url,
        ),
      ),
      home,
      source,
      stage,
    ],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, STATION_HOME: home },
    },
  );
  children.push(child);
  child.stdout?.resume();
  child.stderr?.resume();
  const [code, signal] = await once(child, 'exit');
  return { code, signal };
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'station-installer-restart-'));
  homes.push(home);
  const source = join(home, 'source');
  mkdirSync(join(source, 'agents', 'recoverable-agent'), { recursive: true });
  mkdirSync(join(home, 'plugins'));
  writeFileSync(
    join(source, 'plugin.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'recoverable',
      version: '1.0.0',
      extensions: {
        'io.kontourai.station': {
          schemaVersion: '1.0',
          permissions: ['agents.invoke'],
          agents: [
            {
              slug: 'recoverable-agent',
              source: './agents/recoverable-agent/agent.json',
            },
          ],
        },
      },
    }),
  );
  writeFileSync(
    join(source, 'agents', 'recoverable-agent', 'agent.json'),
    JSON.stringify({
      name: 'Recoverable Agent',
      prompt: 'Recoverable fixture',
    }),
  );
  return { home, source };
}

test.each(['selected', 'after-host', 'before-ready'])(
  'real installer interruption at %s stays pending; a fresh process needs fresh consent and preserves data',
  { timeout: 45_000 },
  async (stage) => {
    const { home, source } = fixture();
    expect((await run(home, source, stage)).signal).toBe('SIGKILL');
    expect(readFileSync(join(home, 'interrupted-at'), 'utf8')).toBe(stage);
    const store = new EventStore(join(home, 'events.sqlite'));
    try {
      const journal = store.createPackageMcpAdmissionJournal();
      const original = journal.currentInstallation('recoverable');
      if (original.state !== 'observed')
        throw new Error('Selected generation disappeared');
      expect(journal.activationState(original.installation)).toBe('pending');
      expect(
        new AgentPluginLoader({
          projectHomeDir: home,
          journal: () => journal,
        }).listInstalled(),
      ).toEqual([]);
      const installed = resolveInstalledPluginRoot(
        join(home, 'plugins'),
        'recoverable',
      )!;
      writeFileSync(join(installed.dataRoot!, 'state.txt'), 'keep this data');
      await revokeGrants(home, 'recoverable', ['agents.invoke']);
      expect((await run(home, source, 'stale')).code).toBe(2);
      expect(getPluginGrants(home, 'recoverable')).not.toContain(
        'agents.invoke',
      );
      expect(journal.currentInstallation('recoverable')).toEqual(original);
      expect((await run(home, source, 'fresh')).code).toBe(0);
      const recovered = journal.currentInstallation('recoverable');
      if (recovered.state !== 'observed')
        throw new Error('Recovery lost its selection');
      expect(recovered.installation.incarnation).not.toBe(
        original.installation.incarnation,
      );
      expect(journal.admissionOpen(recovered.installation)).toBe(true);
      expect(
        resolveInstalledPluginRoot(join(home, 'plugins'), 'recoverable')!
          .dataScope,
      ).toBe(installed.dataScope);
      expect(readFileSync(join(installed.dataRoot!, 'state.txt'), 'utf8')).toBe(
        'keep this data',
      );
      expect(existsSync(join(installed.packageRoot, 'plugin.json'))).toBe(true);
      expect((await run(home, source, 'fresh')).code).toBe(0);
      expect(
        readdirSync(join(home, 'agents')).filter(
          (name) => !name.startsWith('.'),
        ),
      ).toEqual(['recoverable-agent']);
      expect(readFileSync(join(installed.dataRoot!, 'state.txt'), 'utf8')).toBe(
        'keep this data',
      );
    } finally {
      store.close();
    }
  },
);

test('a fresh process recovers retained bytes with the original source absent and never rebuilds or resets data', {
  timeout: 45_000,
}, async () => {
  const { home, source } = fixture();
  expect((await run(home, source, 'after-host')).signal).toBe('SIGKILL');
  const store = new EventStore(join(home, 'events.sqlite'));
  try {
    const journal = store.createPackageMcpAdmissionJournal();
    const original = resolveInstalledPluginRoot(
      join(home, 'plugins'),
      'recoverable',
    )!;
    writeFileSync(join(original.dataRoot!, 'state.txt'), 'offline data');
    rmSync(source, { recursive: true, force: true });
    unlinkSync(join(home, 'plugins', 'recoverable'));
    expect((await run(home, source, 'offline')).code).toBe(0);
    const current = journal.currentInstallation('recoverable');
    if (current.state !== 'observed')
      throw new Error('Recovery did not retain its installation');
    expect(journal.admissionOpen(current.installation)).toBe(true);
    expect(current.installation.dataScope).toBe(original.dataScope);
    expect(readFileSync(join(original.dataRoot!, 'state.txt'), 'utf8')).toBe(
      'offline data',
    );
    expect((await run(home, source, 'offline')).code).toBe(2);
    expect(journal.currentInstallation('recoverable')).toEqual(current);
    expect(
      readdirSync(join(home, 'agents')).filter((name) => !name.startsWith('.')),
    ).toEqual(['recoverable-agent']);
  } finally {
    store.close();
  }
});

test('the public recovery preview and mutation require fresh consent and preserve an alias-free retained installation', {
  timeout: 30_000,
}, async () => {
  const { home, source } = fixture();
  expect((await run(home, source, 'after-host')).signal).toBe('SIGKILL');
  const store = new EventStore(join(home, 'events.sqlite'));
  try {
    const journal = store.createPackageMcpAdmissionJournal();
    const original = journal.currentInstallation('recoverable');
    const installed = resolveInstalledPluginRoot(
      join(home, 'plugins'),
      'recoverable',
    )!;
    writeFileSync(join(installed.dataRoot!, 'state.txt'), 'route data');
    rmSync(source, { recursive: true, force: true });
    unlinkSync(join(home, 'plugins', 'recoverable'));
    const app = new Hono();
    registerPluginInstallRoutes(app, {
      projectHomeDir: home,
      pluginsDir: join(home, 'plugins'),
      agentsDir: join(home, 'agents'),
      packageMcpJournal: journal,
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      } as any,
    });
    const preview = async () => {
      const response = await app.request('/recoverable/recovery-preview');
      expect(response.status).toBe(200);
      return response.json() as Promise<any>;
    };
    const send = (value: any) =>
      app.request('/recoverable/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recoveryRevision: value.recoveryRevision,
          consent: {
            contentDigest: value.contentDigest,
            grantRevision: value.grantRevision,
            permissions: value.permissions.required,
            dependencies: value.dependencies.map((entry: any) => entry.id),
            dependencyApprovals: value.dependencies.map((entry: any) => ({
              id: entry.id,
              ...entry.consent,
            })),
          },
        }),
      });
    const stale = await preview();
    await revokeGrants(home, 'recoverable', ['agents.invoke']);
    expect((await send(stale)).status).toBe(409);
    expect(journal.currentInstallation('recoverable')).toEqual(original);
    expect(getPluginGrants(home, 'recoverable')).not.toContain('agents.invoke');
    const fresh = await preview();
    const response = await send(fresh);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      plugin: { name: 'recoverable' },
    });
    const recovered = journal.currentInstallation('recoverable');
    if (recovered.state !== 'observed')
      throw new Error('Recovery lost its installation');
    expect(journal.admissionOpen(recovered.installation)).toBe(true);
    expect(recovered.installation.dataScope).toBe(installed.dataScope);
    expect(readFileSync(join(installed.dataRoot!, 'state.txt'), 'utf8')).toBe(
      'route data',
    );
    expect((await send(fresh)).status).toBe(409);
    expect(journal.currentInstallation('recoverable')).toEqual(recovered);
  } finally {
    store.close();
  }
});

test('interrupted dependency graphs recover from retained bytes in dependency order without resetting data', {
  timeout: 45_000,
}, async () => {
  const { home, source } = fixture();
  const manifest = JSON.parse(
    readFileSync(join(source, 'plugin.json'), 'utf8'),
  );
  manifest.extensions['io.kontourai.station'].dependencies = [
    { name: 'child', version: '*' },
  ];
  writeFileSync(join(source, 'plugin.json'), JSON.stringify(manifest));
  const sources = ['child', 'leaf'].map((name) => {
    const path = join(home, `${name}-source`);
    mkdirSync(path);
    writeFileSync(
      join(path, 'plugin.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name,
        version: '1.0.0',
        extensions: {
          'io.kontourai.station': {
            schemaVersion: '1.0',
            ...(name === 'child'
              ? { dependencies: [{ name: 'leaf', version: '*' }] }
              : {}),
          },
        },
      }),
    );
    return { id: name, source: path, displayName: name, version: '1.0.0' };
  });
  writeFileSync(
    join(home, 'registry.json'),
    JSON.stringify({ version: 1, plugins: sources }),
  );
  const interrupted = await run(home, source, 'before-ready');
  expect(
    interrupted.signal,
    existsSync(join(home, 'last-refusal'))
      ? readFileSync(join(home, 'last-refusal'), 'utf8')
      : 'checkpoint missing',
  ).toBe('SIGKILL');
  const store = new EventStore(join(home, 'events.sqlite'));
  try {
    const journal = store.createPackageMcpAdmissionJournal();
    const ids = ['recoverable', 'child', 'leaf'];
    const roots = ids.map(
      (id) => resolveInstalledPluginRoot(join(home, 'plugins'), id)!,
    );
    for (const [index, id] of ids.entries()) {
      const selected = journal.currentInstallation(id);
      expect(selected.state).toBe('observed');
      if (selected.state !== 'observed') throw new Error(`Missing ${id}`);
      expect(journal.activationState(selected.installation)).toBe('pending');
      writeFileSync(join(roots[index]!.dataRoot!, 'state.txt'), id);
      unlinkSync(join(home, 'plugins', id));
    }
    for (const path of [source, ...sources.map((entry) => entry.source)])
      rmSync(path, { recursive: true, force: true });
    rmSync(join(home, 'registry.json'));
    const before = journal.currentInstallation('recoverable');
    expect((await run(home, source, 'offline:recoverable')).code).toBe(2);
    expect(readFileSync(join(home, 'last-refusal'), 'utf8')).toContain(
      "Recover dependency 'child' before recovering 'recoverable'",
    );
    expect(journal.currentInstallation('recoverable')).toEqual(before);
    for (const id of ['leaf', 'child', 'recoverable']) {
      const result = await run(home, source, `offline:${id}`);
      expect(
        result,
        existsSync(join(home, 'last-refusal'))
          ? readFileSync(join(home, 'last-refusal'), 'utf8')
          : id,
      ).toEqual({ code: 0, signal: null });
      const selected = journal.currentInstallation(id);
      if (selected.state !== 'observed') throw new Error(`Lost ${id}`);
      expect(journal.admissionOpen(selected.installation)).toBe(true);
      const parentId =
        id === 'leaf' ? 'child' : id === 'child' ? 'recoverable' : null;
      if (parentId) {
        const parent = journal.currentInstallation(parentId);
        if (parent.state !== 'observed') throw new Error(`Lost ${parentId}`);
        expect(journal.activationState(parent.installation)).toBe('pending');
        expect(journal.activationPlan(selected.installation)?.parent).toEqual({
          installation: parentId,
          generation: parent.installation.incarnation,
        });
        expect(
          journal.activationPlan(parent.installation)?.ownedDependencies,
        ).toContainEqual({
          id,
          contentDigest: selected.installation.contentDigest,
          generation: selected.installation.incarnation,
        });
      }
      const old = roots[ids.indexOf(id)]!;
      expect(selected.installation.dataScope).toBe(old.dataScope);
      expect(readFileSync(join(old.dataRoot!, 'state.txt'), 'utf8')).toBe(id);
      expect(existsSync(join(old.packageRoot, 'plugin.json'))).toBe(true);
    }
    expect(
      readdirSync(join(home, 'agents')).filter((name) => !name.startsWith('.')),
    ).toEqual(['recoverable-agent']);
  } finally {
    store.close();
  }
});

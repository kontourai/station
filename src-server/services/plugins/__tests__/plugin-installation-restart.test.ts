import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
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

test.each(['selected', 'after-host', 'before-ready'])(
  'real installer interruption at %s stays pending; a fresh process needs fresh consent and preserves data',
  { timeout: 45_000 },
  async (stage) => {
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

// @vitest-environment node

/**
 * station#983 (scoped advance, station#settings-revamp slice 6, docs/design/
 * settings-architecture.md §6): proves the half of the pipeline that lives in
 * `ConfigLoader` itself — that an `agents/*\/agent.json`/`integrations/*\/
 * integration.json` watcher event is forwarded through `on('add'|'change'|
 * 'remove', ...)` and correctly classified by `isAgentOrIntegrationConfigPath`
 * (the exact predicate `station-runtime.ts`'s new production subscriber uses
 * to decide whether to reload). The subscriber's own reaction (`reloadAgents`
 * + `CONFIG_CHANGED`) is unit-tested directly against `StationRuntime` in
 * `station-runtime-configuration-revision.test.ts` — this file is the other
 * half: does the event genuinely reach that filter with the right shape.
 *
 * Uses `config-loader-app-watch.test.ts`'s scripted-chokidar precedent (a
 * watcher whose `ready`/`add`/`change`/`remove` delivery the test drives
 * explicitly) rather than a real filesystem watcher — real watch delivery is
 * already covered, once, in `config-loader-watch.test.ts`, and is not this
 * file's concern.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class ScriptedWatcher extends EventEmitter {
  readonly added: string[] = [];
  closeCalls = 0;

  add(paths: string | readonly string[]): this {
    this.added.push(...(typeof paths === 'string' ? [paths] : paths));
    return this;
  }

  getWatched(): Record<string, string[]> {
    return {};
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

const watchers: ScriptedWatcher[] = [];

vi.mock('chokidar', () => ({
  watch: (roots: string | string[]) => {
    const watcher = new ScriptedWatcher();
    watcher.add(typeof roots === 'string' ? [roots] : roots);
    watchers.push(watcher);
    setTimeout(() => watcher.emit('ready'), 0);
    return watcher;
  },
}));

const { ConfigLoader, isAgentOrIntegrationConfigPath } = await import(
  '../config-loader.js'
);

let tempDir: string;
let loader: InstanceType<typeof ConfigLoader> | undefined;

beforeEach(() => {
  watchers.length = 0;
  tempDir = mkdtempSync(join(tmpdir(), 'station-agent-config-watch-'));
  for (const dir of ['config', 'agents', 'integrations']) {
    mkdirSync(join(tempDir, dir), { recursive: true });
  }
});

afterEach(async () => {
  await loader?.dispose();
  await loader?.whenWatcherClosed();
  loader = undefined;
  rmSync(tempDir, { recursive: true, force: true });
});

const ready = (watcher: ScriptedWatcher): Promise<void> =>
  new Promise((resolve) => watcher.once('ready', () => resolve()));

describe('ConfigLoader agent/integration watch events (station#983 scoped advance)', () => {
  it('forwards an agent.json add event, and it passes the production subscriber filter', async () => {
    loader = new ConfigLoader({ projectHomeDir: tempDir, watchFiles: true });
    const events: Array<[string, string]> = [];
    for (const event of ['add', 'change', 'remove'] as const) {
      loader.on(event, (path) => events.push([event, path as string]));
    }
    const watcher = watchers.at(-1);
    if (!watcher) throw new Error('the loader did not create a watcher');
    await ready(watcher);

    const agentDir = join(tempDir, 'agents', 'writer');
    mkdirSync(agentDir, { recursive: true });
    const agentConfigPath = join(agentDir, 'agent.json');
    writeFileSync(agentConfigPath, JSON.stringify({ version: 1 }), 'utf8');
    watcher.emit('add', agentConfigPath);

    expect(events).toEqual([['add', agentConfigPath]]);
    expect(
      isAgentOrIntegrationConfigPath(
        loader.getProjectHomeDir(),
        agentConfigPath,
      ),
    ).toBe(true);
  });

  it('forwards an integration.json change event and classifies it the same way', async () => {
    loader = new ConfigLoader({ projectHomeDir: tempDir, watchFiles: true });
    const events: Array<[string, string]> = [];
    for (const event of ['add', 'change', 'remove'] as const) {
      loader.on(event, (path) => events.push([event, path as string]));
    }
    const watcher = watchers.at(-1);
    if (!watcher) throw new Error('the loader did not create a watcher');
    await ready(watcher);

    const integrationDir = join(tempDir, 'integrations', 'slack');
    mkdirSync(integrationDir, { recursive: true });
    const integrationConfigPath = join(integrationDir, 'integration.json');
    writeFileSync(integrationConfigPath, '{}', 'utf8');
    watcher.emit('add', integrationConfigPath);
    watcher.emit('change', integrationConfigPath);

    expect(events).toEqual([
      ['add', integrationConfigPath],
      ['change', integrationConfigPath],
    ]);
    expect(
      isAgentOrIntegrationConfigPath(
        loader.getProjectHomeDir(),
        integrationConfigPath,
      ),
    ).toBe(true);
  });

  it('suppresses matching echoes of its own agent writes, while integration saves and external edits still forward', async () => {
    loader = new ConfigLoader({ projectHomeDir: tempDir, watchFiles: true });
    const events: Array<[string, string]> = [];
    for (const event of ['add', 'change', 'remove'] as const) {
      loader.on(event, (path) => events.push([event, path as string]));
    }
    const watcher = watchers.at(-1);
    if (!watcher) throw new Error('the loader did not create a watcher');
    await ready(watcher);

    const created = await loader.createAgent({
      name: 'Writer',
      prompt: 'Write clearly.',
    });
    const agentConfigPath = join(tempDir, 'agents', created.slug, 'agent.json');
    watcher.emit('add', agentConfigPath);

    await loader.updateAgent(created.slug, { prompt: 'Write precisely.' });
    watcher.emit('change', agentConfigPath);

    await loader.saveIntegration('writer-tools', {
      id: 'writer-tools',
      kind: 'mcp',
    });
    const integrationConfigPath = join(
      tempDir,
      'integrations',
      'writer-tools',
      'integration.json',
    );
    watcher.emit('add', integrationConfigPath);

    // Agent routes synchronously apply their own reload, so their same-path,
    // same-content echoes must not schedule a second one. Integration routes
    // rely on the watcher for activation and therefore remain observable.
    expect(events).toEqual([['add', integrationConfigPath]]);

    writeFileSync(
      agentConfigPath,
      JSON.stringify({ name: 'Writer', prompt: 'Changed outside Station.' }),
      'utf8',
    );
    watcher.emit('change', agentConfigPath);

    expect(events).toEqual([
      ['add', integrationConfigPath],
      ['change', agentConfigPath],
    ]);
  });

  it('skips a byte-identical integration re-save so the runtime cannot feed its own watcher (#1588)', async () => {
    loader = new ConfigLoader({ projectHomeDir: tempDir, watchFiles: true });
    const watcher = watchers.at(-1);
    if (!watcher) throw new Error('the loader did not create a watcher');
    await ready(watcher);

    const def = { id: 'station-control', kind: 'mcp' as const };
    await loader.saveIntegration('station-control', def);
    const path = join(
      tempDir,
      'integrations',
      'station-control',
      'integration.json',
    );
    const before = statSync(path, { bigint: true }).mtimeNs;

    // The runtime re-saves this identical definition on every agents reload;
    // a rewrite here is what the watcher re-observed as an external edit,
    // scheduling the next reload forever.
    await loader.saveIntegration('station-control', def);
    expect(statSync(path, { bigint: true }).mtimeNs).toBe(before);

    // A genuine change must still write (and thus still activate via the
    // watcher, which route-driven saves rely on).
    await loader.saveIntegration('station-control', {
      ...def,
      description: 'changed',
    });
    expect(statSync(path, { bigint: true }).mtimeNs).not.toBe(before);
  });

  it('holds an early agent echo until persistence settles, then forwards one competing external edit', async () => {
    loader = new ConfigLoader({ projectHomeDir: tempDir, watchFiles: true });
    const events: Array<[string, string]> = [];
    for (const event of ['add', 'change', 'remove'] as const) {
      loader.on(event, (path) => events.push([event, path as string]));
    }
    const watcher = watchers.at(-1);
    if (!watcher) throw new Error('the loader did not create a watcher');
    await ready(watcher);

    const agentDir = join(tempDir, 'agents', 'writer');
    const agentConfigPath = join(agentDir, 'agent.json');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      agentConfigPath,
      JSON.stringify({ name: 'Writer', prompt: 'Before.' }),
      'utf8',
    );

    let settleWrite!: () => void;
    const writeSettled = new Promise<void>((resolve) => {
      settleWrite = resolve;
    });
    const write = (loader as any).withInternalAgentWrite(
      agentConfigPath,
      async () => {
        await writeSettled;
        return {
          result: undefined,
          expectedContentSignature: createHash('sha256')
            .update(
              JSON.stringify(
                { name: 'Writer', prompt: 'Written by Station.' },
                null,
                2,
              ),
              'utf8',
            )
            .digest('hex'),
        };
      },
    );

    // This is the race the old post-write marker lost: Chokidar can observe
    // Station's write before the persistence promise resolves.
    writeFileSync(
      agentConfigPath,
      JSON.stringify(
        { name: 'Writer', prompt: 'Written by Station.' },
        null,
        2,
      ),
      'utf8',
    );
    watcher.emit('change', agentConfigPath);
    settleWrite();
    await write;
    expect(events).toEqual([]);

    // A later external edit changes the signature, clears the marker, and
    // gets exactly one notification for the runtime's reload coalescer.
    writeFileSync(
      agentConfigPath,
      JSON.stringify({ name: 'Writer', prompt: 'Written externally.' }),
      'utf8',
    );
    watcher.emit('change', agentConfigPath);

    expect(events).toEqual([['change', agentConfigPath]]);

    events.length = 0;
    let settleConcurrentWrite!: () => void;
    const concurrentWriteSettled = new Promise<void>((resolve) => {
      settleConcurrentWrite = resolve;
    });
    const concurrentWrite = (loader as any).withInternalAgentWrite(
      agentConfigPath,
      async () => {
        await concurrentWriteSettled;
        return {
          result: undefined,
          expectedContentSignature: createHash('sha256')
            .update(
              JSON.stringify(
                { name: 'Writer', prompt: 'Written by Station again.' },
                null,
                2,
              ),
              'utf8',
            )
            .digest('hex'),
        };
      },
    );

    writeFileSync(
      agentConfigPath,
      JSON.stringify(
        { name: 'Writer', prompt: 'Written by Station again.' },
        null,
        2,
      ),
      'utf8',
    );
    watcher.emit('change', agentConfigPath);
    writeFileSync(
      agentConfigPath,
      JSON.stringify({ name: 'Writer', prompt: 'External writer won.' }),
      'utf8',
    );
    watcher.emit('change', agentConfigPath);
    settleConcurrentWrite();
    await concurrentWrite;

    // The external content wins before Station's persistence promise settles;
    // it must be forwarded once, never misclassified as Station's echo.
    expect(events).toEqual([['change', agentConfigPath]]);
  });

  it('forwards an app.json event too, but the production filter rejects it (it has its own dedicated path)', async () => {
    loader = new ConfigLoader({ projectHomeDir: tempDir, watchFiles: true });
    const events: Array<[string, string]> = [];
    for (const event of ['add', 'change', 'remove'] as const) {
      loader.on(event, (path) => events.push([event, path as string]));
    }
    const watcher = watchers.at(-1);
    if (!watcher) throw new Error('the loader did not create a watcher');
    await ready(watcher);

    const appConfigPath = join(tempDir, 'config', 'app.json');
    writeFileSync(appConfigPath, '{}', 'utf8');
    watcher.emit('add', appConfigPath);

    expect(events).toEqual([['add', appConfigPath]]);
    expect(
      isAgentOrIntegrationConfigPath(loader.getProjectHomeDir(), appConfigPath),
    ).toBe(false);
  });
});

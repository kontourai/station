import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import { KnowledgeFileTransactions } from '../adapters/shared/file-transactions.js';
import { serializeMarkdown } from '../adapters/shared/frontmatter.js';
import { KnowledgeStoreProvider } from '../knowledge-store-provider.js';

const fixtures: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const fixture of fixtures.splice(0))
    fs.rmSync(fixture, { recursive: true, force: true });
});

test('observes the real writer lock and prepared/committed journal without interfering with publication', async () => {
  const fixture = fs.realpathSync(
    fs.mkdtempSync(join(tmpdir(), 'station-observe-writer-')),
  );
  fixtures.push(fixture);
  const home = join(fixture, 'home');
  const root = join(fixture, 'root');
  vi.stubEnv('STATION_HOME', home);
  fs.mkdirSync(join(home, 'config'), { recursive: true });
  fs.mkdirSync(join(root, 'records'), { recursive: true });
  fs.writeFileSync(
    join(home, 'config', 'knowledge-store-roots.json'),
    JSON.stringify([
      {
        id: 'root:fixture',
        scope: { kind: 'personal' },
        adapterId: 'kit-default-store',
        storeRoot: root,
        displayName: 'Fixture',
        createdAt: '2026-09-01T00:00:00Z',
      },
    ]),
  );
  const provider = new KnowledgeStoreProvider(new FileStorageAdapter(home), {
    stationHome: home,
    authorize: () => 'allowed',
  });
  const during: Array<{ phase: string; result: unknown }> = [];
  const writer = new KnowledgeFileTransactions(root, {
    afterLockAcquired: () => {
      during.push({
        phase: 'lock',
        result: provider.observeExactRecord('root:fixture', 'record-1', null),
      });
    },
    afterJournalWrite: (journal) => {
      during.push({
        phase: journal.phase,
        result: provider.observeExactRecord('root:fixture', 'record-1', null),
      });
    },
  });
  await writer.mutate('fixture-create', () =>
    writer.writeText(
      join(root, 'records', 'record-1.md'),
      serializeMarkdown(
        {
          id: 'record-1',
          type: 'raw',
          title: 'fixture',
          category: 'feedback',
          provenance: { agent: 'fixture' },
          created_at: '2026-09-01T00:00:00Z',
          updated_at: '2026-09-01T00:00:00Z',
        },
        'body',
      ),
    ),
  );
  expect(during).toEqual(
    ['lock', 'prepared', 'committed'].map((phase) => ({
      phase,
      result: { state: 'busy' },
    })),
  );
  expect(
    provider.observeExactRecord('root:fixture', 'record-1', null).state,
  ).toBe('observed');
});

test.skipIf(process.platform === 'win32')(
  'real FIFO swapped at provider record open is nonblocking; old flags demonstrably block',
  async () => {
    const providerUrl = new URL(
      '../knowledge-store-provider.ts',
      import.meta.url,
    ).href;
    const storageUrl = new URL(
      '../../domain/file-storage-adapter.ts',
      import.meta.url,
    ).href;
    async function run(legacy: boolean) {
      const fixture = fs.realpathSync(
        fs.mkdtempSync(join(tmpdir(), 'station-observe-fifo-')),
      );
      fixtures.push(fixture);
      const home = join(fixture, 'home');
      const root = join(fixture, 'root');
      fs.mkdirSync(join(home, 'config'), { recursive: true });
      fs.mkdirSync(join(root, 'records'), { recursive: true });
      const record = join(root, 'records', 'record-1.md');
      const fifo = join(root, 'fifo');
      fs.writeFileSync(
        record,
        serializeMarkdown(
          {
            id: 'record-1',
            type: 'raw',
            title: 'fixture',
            category: 'feedback',
            provenance: { agent: 'fixture' },
            created_at: '2026-09-01T00:00:00Z',
            updated_at: '2026-09-01T00:00:00Z',
          },
          'body',
        ),
      );
      fs.writeFileSync(
        join(home, 'config', 'knowledge-store-roots.json'),
        JSON.stringify([
          {
            id: 'root:fixture',
            scope: { kind: 'personal' },
            adapterId: 'kit-default-store',
            storeRoot: root,
            displayName: 'Fixture',
            createdAt: '2026-09-01T00:00:00Z',
          },
        ]),
      );
      // Fixture process only. The observer neither creates this FIFO nor launches anything.
      execFileSync('mkfifo', [fifo], { windowsHide: true });
      const code = `
      import fs from 'node:fs';
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { KnowledgeStoreProvider } from ${JSON.stringify(providerUrl)};
      import { FileStorageAdapter } from ${JSON.stringify(storageUrl)};
      const nativeOpen = fs.openSync;
      const nativeRename = fs.renameSync;
      const record = ${JSON.stringify(record)};
      const fifo = ${JSON.stringify(fifo)};
      const owner = new KnowledgeStoreProvider(new FileStorageAdapter(${JSON.stringify(home)}), {
        stationHome: ${JSON.stringify(home)}, authorize: () => 'allowed'
      });
      for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
        childProcess[name] = () => { throw new Error('observer attempted a process'); };
      }
      fs.openSync = (path, flags, mode) => {
        if (path === record) {
          nativeRename(record, record + '.before');
          nativeRename(fifo, record);
          process.stdout.write('AT_OPEN\\n');
          if (${legacy}) flags &= ~fs.constants.O_NONBLOCK;
        }
        return nativeOpen(path, flags, mode);
      };
      syncBuiltinESMExports();
      process.stdout.write(JSON.stringify(owner.observeExactRecord('root:fixture', 'record-1', null)) + '\\n');
    `;
      return new Promise<{
        output: string;
        blocked: boolean;
        status: number | null;
      }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '--eval', code],
          {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, STATION_HOME: home },
          },
        );
        let output = '';
        let stderr = '';
        let blocked = false;
        let openTimer: ReturnType<typeof setTimeout> | undefined;
        // Startup has its own generous bound; the blocking assertion begins only
        // after the actual native-open boundary is reached, not at process launch.
        const startup = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`child did not reach open: ${stderr}`));
        }, 15000);
        child.stdout.on('data', (chunk) => {
          output += chunk.toString();
          if (output.includes('AT_OPEN') && !openTimer) {
            clearTimeout(startup);
            openTimer = setTimeout(
              () => {
                blocked = true;
                child.kill('SIGKILL');
              },
              legacy ? 250 : 5000,
            );
          }
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (status) => {
          clearTimeout(startup);
          clearTimeout(openTimer);
          if (stderr && status !== 0 && !blocked) reject(new Error(stderr));
          else resolve({ output, blocked, status });
        });
      });
    }
    const fixed = await run(false);
    expect(fixed).toMatchObject({ blocked: false, status: 0 });
    expect(fixed.output).toContain('AT_OPEN');
    expect(fixed.output).toContain('"state":"unavailable"');
    const oldFlags = await run(true);
    expect(oldFlags.blocked).toBe(true);
    expect(oldFlags.output.trim()).toBe('AT_OPEN');
  },
);

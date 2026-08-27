import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import {
  mkdtemp,
  readFile,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectLock,
  lockOwnerAlive,
} from '@kontourai/station-shared/lifecycle-events';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { resolveHomeDir } from '../../../utils/paths.js';
import {
  KnowledgeFileTransactions,
  KnowledgeStoreConflictError,
  KnowledgeStoreCorruptionError,
} from '../shared/file-transactions.js';

const roots: string[] = [];
let previousStationHome: string | undefined;
const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'knowledge-file-transaction-child.ts',
);
const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-transactions-'));
  roots.push(root);
  return root;
}

function coordinationLockPath(
  root: string,
  stationHome = resolveHomeDir(),
): string {
  const info = lstatSync(root);
  const identity = createHash('sha256')
    .update(`${realpathSync(root)}\0${info.dev}\0${info.ino}`)
    .digest('hex');
  return join(
    stationHome,
    'coordination',
    'knowledge-file-transactions',
    `${identity}.lock`,
  );
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function runChild(
  root: string,
  mode: string,
  readyPath?: string,
  releasePath?: string,
) {
  return spawn(
    process.execPath,
    [tsx, fixture, root, mode, readyPath ?? '', releasePath ?? ''],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

async function childExit(
  child: ReturnType<typeof runChild>,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
}

beforeEach(async () => {
  previousStationHome = process.env.STATION_HOME;
  const stationHome = await mkdtemp(join(tmpdir(), 'station-home-'));
  roots.push(stationHome);
  process.env.STATION_HOME = stationHome;
});

afterEach(async () => {
  if (previousStationHome === undefined) delete process.env.STATION_HOME;
  else process.env.STATION_HOME = previousStationHome;
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('KnowledgeFileTransactions', () => {
  test('every writable knowledge adapter uses the shared seam and owns no raw mutation calls', async () => {
    for (const file of [
      'src-server/knowledge-store/adapters/default-store.ts',
      'src-server/knowledge-store/adapters/obsidian-store.ts',
      'src-server/services/knowledge/knowledge-storage.ts',
      'src-server/services/knowledge/knowledge-documents.ts',
    ]) {
      const source = await readFile(join(process.cwd(), file), 'utf8');
      expect(source).toMatch(
        /new KnowledgeFileTransactions\((?:this\.root|input\.storageDir|storageDir)\)|mutateKnowledgeDocuments/,
      );
      expect(source).not.toMatch(
        /\b(?:writeFileSync|renameSync|unlinkSync|rmSync)\s*\(/,
      );
    }
  });

  test('rolls every published file back when the operation rejects', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'record.md'), 'old-record');
    await writeFile(join(root, 'index.json'), 'old-index');
    const files = new KnowledgeFileTransactions(root);

    await expect(
      files.mutate('update', () => {
        files.writeText(join(root, 'record.md'), 'new-record');
        files.writeText(join(root, 'index.json'), 'new-index');
        throw new Error('injected failure');
      }),
    ).rejects.toThrow('injected failure');

    expect(await readFile(join(root, 'record.md'), 'utf8')).toBe('old-record');
    expect(await readFile(join(root, 'index.json'), 'utf8')).toBe('old-index');
  });

  test('does not overwrite an external edit when a staged operation rejects', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'record.md');
    await writeFile(path, 'original');
    const files = new KnowledgeFileTransactions(root);

    await expect(
      files.mutate('rejected', async () => {
        files.writeText(path, 'staged');
        await writeFile(path, 'external');
        throw new Error('provider rejected');
      }),
    ).rejects.toThrow('provider rejected');
    expect(await readFile(path, 'utf8')).toBe('external');
  });

  test('recovers a prepared multi-file transaction after the writer process exits', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'record.md'), 'old-record');
    await writeFile(join(root, 'index.json'), 'old-index');

    const child = runChild(root, 'crash-after-first-publish');
    expect(await childExit(child)).toBe(23);
    expect(readFileSync(join(root, 'record.md'), 'utf8')).toBe('new-record');

    const reopened = new KnowledgeFileTransactions(root);
    await reopened.read(() => undefined);

    expect(await readFile(join(root, 'record.md'), 'utf8')).toBe('old-record');
    expect(await readFile(join(root, 'index.json'), 'utf8')).toBe('old-index');
    expect(existsSync(join(root, '.station-knowledge-transaction.json'))).toBe(
      false,
    );
  });

  test('keeps the exact after-image when the writer exits after the final publish', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'record.md'), 'old-record');
    await writeFile(join(root, 'index.json'), 'old-index');

    const child = runChild(root, 'crash-after-final-publish');
    expect(await childExit(child)).toBe(23);

    const reopened = new KnowledgeFileTransactions(root);
    await reopened.read(() => undefined);
    expect(await readFile(join(root, 'record.md'), 'utf8')).toBe('new-record');
    expect(await readFile(join(root, 'index.json'), 'utf8')).toBe('new-index');
  });

  test('serializes mutations across real processes', async () => {
    const root = await temporaryRoot();
    const ready = join(root, 'child-ready');
    const release = join(root, 'child-release');
    const child = runChild(root, 'hold-lock', ready, release);
    await waitForFile(ready);
    const held = inspectLock(coordinationLockPath(root));
    expect(held).not.toBeNull();
    expect(held?.owner.pid).not.toBe(process.pid);
    expect(lockOwnerAlive(held!.owner)).toBe(true);

    const files = new KnowledgeFileTransactions(root);
    const parent = files.mutate('parent', () => {
      files.writeText(join(root, 'parent.txt'), 'parent');
    });
    await writeFile(release, 'release');
    expect(await childExit(child)).toBe(0);
    await parent;
    expect(await readFile(join(root, 'child.txt'), 'utf8')).toBe('child');
    expect(await readFile(join(root, 'parent.txt'), 'utf8')).toBe('parent');
  });

  test('fails closed instead of overwriting an external edit observed during a mutation', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'record.md');
    await writeFile(path, 'original');
    const files = new KnowledgeFileTransactions(root);

    await expect(
      files.mutate('conflict', async () => {
        expect(files.readText(path)).toBe('original');
        await writeFile(path, 'external');
        files.writeText(path, 'station');
      }),
    ).rejects.toBeInstanceOf(KnowledgeStoreConflictError);
    expect(await readFile(path, 'utf8')).toBe('external');
  });

  test('detects a stale directory scan before rebuilding derived indexes', async () => {
    const root = await temporaryRoot();
    const records = join(root, 'records');
    mkdirSync(records);
    const files = new KnowledgeFileTransactions(root);

    await expect(
      files.mutate('reindex', async () => {
        expect(files.listFileNames(records)).toEqual([]);
        await writeFile(join(records, 'external.md'), 'external');
        files.writeText(join(root, 'graph-index.json'), '{}');
      }),
    ).rejects.toBeInstanceOf(KnowledgeStoreConflictError);
    expect(await readFile(join(records, 'external.md'), 'utf8')).toBe(
      'external',
    );
    expect(existsSync(join(root, 'graph-index.json'))).toBe(false);
  });

  test('detects a legacy source changed by another process before publication', async () => {
    const base = await temporaryRoot();
    const root = join(base, 'store');
    await mkdirSync(root, { recursive: true });
    const legacy = join(base, 'legacy.json');
    const ready = join(base, 'external-ready');
    const release = join(base, 'external-release');
    await writeFile(legacy, 'original');
    const child = runChild(base, 'write-external', ready, release);
    await waitForFile(ready);
    const files = new KnowledgeFileTransactions(root);

    await expect(
      files.mutate('legacy-race', async () => {
        expect(files.readExternalText(legacy)).toBe('original');
        files.writeText(join(root, 'metadata.json'), 'staged');
        await writeFile(release, 'release');
        expect(await childExit(child)).toBe(0);
      }),
    ).rejects.toBeInstanceOf(KnowledgeStoreConflictError);
    expect(existsSync(join(root, 'metadata.json'))).toBe(false);
  });

  test('publishes records before indexes and removals', async () => {
    const root = await temporaryRoot();
    const oldPath = join(root, 'old.md');
    await writeFile(oldPath, 'old');
    const published: string[] = [];
    const files = new KnowledgeFileTransactions(root, {
      afterFilePublish: (path) => published.push(path.slice(root.length + 1)),
    });

    await files.mutate('move-and-index', () => {
      files.writeText(join(root, 'metadata.json'), '[]');
      files.writeText(join(root, 'graph-index.json'), '{}');
      files.move(oldPath, join(root, 'records', 'new.md'));
      files.writeText(join(root, 'path-index.json'), '{}');
    });

    expect(published).toEqual([
      'records/new.md',
      'metadata.json',
      'graph-index.json',
      'path-index.json',
      'old.md',
    ]);
  });

  test('refuses a symlinked publication path', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, join(root, 'records'));
    const files = new KnowledgeFileTransactions(root);

    await expect(
      files.mutate('symlink', () =>
        files.writeText(join(root, 'records', 'escaped.md'), 'nope'),
      ),
    ).rejects.toBeInstanceOf(KnowledgeStoreCorruptionError);
    expect(existsSync(join(outside, 'escaped.md'))).toBe(false);
  });

  test('refuses a root swapped to an outside symlink after composition', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const movedRoot = `${root}-moved`;
    roots.push(movedRoot);
    const files = new KnowledgeFileTransactions(root);
    await rename(root, movedRoot);
    await symlink(outside, root);

    await expect(
      files.mutate('root-swap', () => {
        files.writeText(join(root, 'escaped.md'), 'nope');
      }),
    ).rejects.toBeInstanceOf(KnowledgeStoreCorruptionError);
    expect(existsSync(join(outside, 'escaped.md'))).toBe(false);
    expect(existsSync(join(outside, '.station-knowledge-mutation'))).toBe(
      false,
    );
  });

  test.skipIf(process.platform === 'win32')(
    'coordinates a writable root without requiring write authority over its parent',
    async () => {
      const base = await temporaryRoot();
      const root = join(base, 'vault');
      mkdirSync(root, { mode: 0o700 });
      chmodSync(base, 0o555);
      try {
        const files = new KnowledgeFileTransactions(root);
        await files.mutate('read-only-parent', () => {
          files.writeText(join(root, 'record.md'), 'inside');
        });
        expect(readFileSync(join(root, 'record.md'), 'utf8')).toBe('inside');
        expect(
          coordinationLockPath(root).startsWith(
            `${join(resolveHomeDir(), 'coordination', 'knowledge-file-transactions')}${sep}`,
          ),
        ).toBe(true);
      } finally {
        chmodSync(base, 0o700);
      }
    },
  );

  test('keeps adjacent suffix-named roots independently coordinated', async () => {
    const base = await temporaryRoot();
    const firstRoot = join(base, 'vault');
    const secondRoot = join(base, 'vault.station-knowledge-mutation');
    mkdirSync(firstRoot);
    mkdirSync(secondRoot);
    expect(coordinationLockPath(firstRoot)).not.toBe(
      coordinationLockPath(secondRoot),
    );
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      firstAcquired = resolve;
    });
    const first = new KnowledgeFileTransactions(firstRoot);
    const second = new KnowledgeFileTransactions(secondRoot);
    const firstMutation = first.mutate('first', async () => {
      firstAcquired();
      await held;
      first.writeText(join(firstRoot, 'first.md'), 'first');
    });
    await acquired;

    await second.mutate('second', () => {
      second.writeText(join(secondRoot, 'second.md'), 'second');
    });
    expect(readFileSync(join(secondRoot, 'second.md'), 'utf8')).toBe('second');
    releaseFirst();
    await firstMutation;
  });

  test('releases its stable lock when root identity changes after acquisition', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const movedRoot = `${root}-moved`;
    roots.push(movedRoot);
    const lockPath = coordinationLockPath(root);
    const files = new KnowledgeFileTransactions(root, {
      afterLockAcquired: () => {
        renameSync(root, movedRoot);
        symlinkSync(outside, root);
      },
    });

    await expect(files.read(() => undefined)).rejects.toBeInstanceOf(
      KnowledgeStoreCorruptionError,
    );
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(join(outside, '.station-knowledge-mutation'))).toBe(
      false,
    );
  });

  test('revalidates root identity immediately before target replacement', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const movedRoot = `${root}-moved`;
    roots.push(movedRoot);
    let swapped = false;
    const files = new KnowledgeFileTransactions(root, {
      beforeFileReplace: (path) => {
        if (swapped || !path.endsWith('record.md')) return;
        swapped = true;
        renameSync(root, movedRoot);
        symlinkSync(outside, root);
      },
    });

    await expect(
      files.mutate('pre-rename-root-swap', () => {
        files.writeText(join(root, 'record.md'), 'nope');
      }),
    ).rejects.toBeInstanceOf(KnowledgeStoreCorruptionError);
    expect(existsSync(join(outside, 'record.md'))).toBe(false);
  });

  test('returns applied after exact readback when the commit-marker response is lost', async () => {
    const root = await temporaryRoot();
    let throwOnce = true;
    const files = new KnowledgeFileTransactions(root, {
      afterCommitMarker: () => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('post-commit fault');
        }
      },
    });

    await expect(
      files.mutate('commit', () => {
        files.writeText(join(root, 'record.md'), 'committed');
        return 'applied';
      }),
    ).resolves.toBe('applied');

    const reopened = new KnowledgeFileTransactions(root);
    await reopened.read(() => undefined);
    expect(await readFile(join(root, 'record.md'), 'utf8')).toBe('committed');
  });

  test('rejects a malformed journal without replacing authoritative files', async () => {
    const root = await temporaryRoot();
    const record = join(root, 'record.md');
    await writeFile(record, 'authoritative');
    await writeFile(join(root, '.station-knowledge-transaction.json'), '{');

    const files = new KnowledgeFileTransactions(root);
    await expect(files.read(() => undefined)).rejects.toBeInstanceOf(
      KnowledgeStoreCorruptionError,
    );
    expect(await readFile(record, 'utf8')).toBe('authoritative');
  });

  test('rejects a non-canonical journal alias', async () => {
    const alias = `records${sep}a${sep}..${sep}x.md`;
    const root = await temporaryRoot();
    await writeFile(
      join(root, '.station-knowledge-transaction.json'),
      JSON.stringify({
        version: 1,
        transactionId: 'tampered',
        operation: 'tampered',
        phase: 'prepared',
        entries: [
          {
            path: 'records/x.md',
            before: null,
            after: Buffer.from('first').toString('base64'),
          },
          {
            path: alias,
            before: null,
            after: Buffer.from('second').toString('base64'),
          },
        ],
      }),
    );

    const files = new KnowledgeFileTransactions(root);
    await expect(files.read(() => undefined)).rejects.toBeInstanceOf(
      KnowledgeStoreCorruptionError,
    );
  });

  test.skipIf(sep === '\\')(
    'recovers a crash-retained journal for a literal POSIX backslash filename',
    async () => {
      const root = await temporaryRoot();
      const literalPath = join(root, 'foo\\bar.md');
      await writeFile(literalPath, 'before');

      const child = runChild(root, 'crash-backslash-after-publish');
      expect(await childExit(child)).toBe(23);
      expect(readFileSync(literalPath, 'utf8')).toBe('after');

      const reopened = new KnowledgeFileTransactions(root);
      await reopened.read(() => undefined);
      expect(await readFile(literalPath, 'utf8')).toBe('after');
      expect(
        existsSync(join(root, '.station-knowledge-transaction.json')),
      ).toBe(false);
    },
  );
});

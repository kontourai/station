import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KnowledgeDocumentMeta } from '@kontourai/station-contracts/knowledge';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ProjectFileTransactions } from '../../../domain/project-file-transactions.js';
import { KnowledgeStoreCorruptionError } from '../../../knowledge-store/errors.js';
import {
  defaultKnowledgeStorageDir,
  mutateKnowledgeDocuments,
  readKnowledgeDocuments,
} from '../knowledge-storage.js';

const fixture = fileURLToPath(
  new URL(
    './test-support/knowledge-document-transaction-child.ts',
    import.meta.url,
  ),
);
const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');
const JOURNAL = '.station-knowledge-transaction.json';
const SLUG = 'alpha';
const NAMESPACE = 'default';

function documentMeta(
  id: string,
  path: string,
  chunkCount = 1,
): KnowledgeDocumentMeta {
  return {
    id,
    filename: path,
    namespace: NAMESPACE,
    path,
    source: 'upload',
    chunkCount,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** The exact bytes `replaceMetadata` publishes. */
function metadataBytes(docs: KnowledgeDocumentMeta[]): string {
  return `${JSON.stringify(docs, null, 2)}\n`;
}

const makeTempDir = trackTempDirs();
let home: string;
let storageDir: string;
let previousStationHome: string | undefined;

beforeEach(async () => {
  home = makeTempDir('knowledge-document-transactions-');
  storageDir = defaultKnowledgeStorageDir(home, SLUG, NAMESPACE);
  previousStationHome = process.env.STATION_HOME;
  process.env.STATION_HOME = home;
  await mkdir(join(storageDir, 'files'), { recursive: true });
  await writeFile(join(storageDir, 'files', 'guide.md'), 'old guide');
  await writeFile(
    join(storageDir, 'metadata.json'),
    metadataBytes([documentMeta('doc-1', 'guide.md')]),
  );
});

afterEach(() => {
  if (previousStationHome === undefined) delete process.env.STATION_HOME;
  else process.env.STATION_HOME = previousStationHome;
});

function runWriter(mode: string, content: string, metadata: string) {
  return spawn(
    process.execPath,
    [tsx, fixture, home, SLUG, storageDir, mode, 'guide.md', content, metadata],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      // The legacy writer locks under the runtime home; production runs both
      // builds against one Station home, so the child shares this one.
      env: { ...process.env, STATION_HOME: home },
      windowsHide: true,
    },
  );
}

function exitCode(child: ReturnType<typeof runWriter>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function readSnapshot() {
  return readKnowledgeDocuments(
    { storageDir, dataDir: home, projectSlug: SLUG, namespace: NAMESPACE },
    (transaction) => ({
      metadata: transaction.metadata(),
      content: transaction.readDocument('guide.md'),
    }),
  );
}

const updatedMetadata = metadataBytes([documentMeta('doc-1', 'guide.md', 2)]);

describe('legacy knowledge documents on ProjectFileTransactions', () => {
  test('a document upload killed after its prepared journal reopens intact', async () => {
    const child = runWriter(
      'project-crash-after-first-publish',
      'new guide',
      updatedMetadata,
    );
    expect(await exitCode(child)).toBe(23);
    // Reachability: the writer died mid-publication, not before it.
    expect(await readFile(join(storageDir, 'files', 'guide.md'), 'utf8')).toBe(
      'new guide',
    );
    expect(existsSync(join(storageDir, JOURNAL))).toBe(true);

    expect(await readSnapshot()).toEqual({
      metadata: [documentMeta('doc-1', 'guide.md')],
      content: 'old guide',
    });
    expect(existsSync(join(storageDir, JOURNAL))).toBe(false);
  });

  test('rolls back a journal an earlier Station build left in the namespace', async () => {
    const child = runWriter(
      'legacy-crash-after-first-publish',
      'new guide',
      updatedMetadata,
    );
    expect(await exitCode(child)).toBe(23);
    expect(await readFile(join(storageDir, 'files', 'guide.md'), 'utf8')).toBe(
      'new guide',
    );
    expect(existsSync(join(storageDir, JOURNAL))).toBe(true);

    expect(await readSnapshot()).toEqual({
      metadata: [documentMeta('doc-1', 'guide.md')],
      content: 'old guide',
    });
    expect(existsSync(join(storageDir, JOURNAL))).toBe(false);
  });

  test('keeps the after-image of a legacy journal that finished publishing', async () => {
    const child = runWriter(
      'legacy-crash-after-final-publish',
      'new guide',
      updatedMetadata,
    );
    expect(await exitCode(child)).toBe(23);
    expect(existsSync(join(storageDir, JOURNAL))).toBe(true);

    expect(await readSnapshot()).toEqual({
      metadata: [documentMeta('doc-1', 'guide.md', 2)],
      content: 'new guide',
    });
    expect(existsSync(join(storageDir, JOURNAL))).toBe(false);
  });

  test('refuses a corrupt journal instead of reading past it', async () => {
    await writeFile(join(storageDir, JOURNAL), '{"version":1');
    await expect(readSnapshot()).rejects.toBeInstanceOf(
      KnowledgeStoreCorruptionError,
    );
    expect(await readFile(join(storageDir, JOURNAL), 'utf8')).toBe(
      '{"version":1',
    );
    expect(await readFile(join(storageDir, 'files', 'guide.md'), 'utf8')).toBe(
      'old guide',
    );
  });

  test('an earlier Station build holding the namespace lock excludes the new writer', async () => {
    const child = runWriter(
      'legacy-hold-lock',
      'child guide',
      metadataBytes([
        documentMeta('doc-1', 'guide.md'),
        documentMeta('child', 'child.md'),
      ]),
    );
    await waitForFile(join(home, 'child-ready'));

    let entered = false;
    const parent = mutateKnowledgeDocuments(
      {
        storageDir,
        dataDir: home,
        projectSlug: SLUG,
        namespace: NAMESPACE,
        operation: 'upload-document',
      },
      (transaction) => {
        entered = true;
        transaction.replaceMetadata([
          ...transaction.metadata(),
          documentMeta('parent', 'parent.md'),
        ]);
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(entered).toBe(false);

    await writeFile(join(home, 'child-release'), 'release');
    expect(await exitCode(child)).toBe(0);
    await parent;
    expect(
      JSON.parse(await readFile(join(storageDir, 'metadata.json'), 'utf8')).map(
        (doc: KnowledgeDocumentMeta) => doc.id,
      ),
    ).toEqual(['doc-1', 'child', 'parent']);
  });

  test('a document mutation waits for the Project lock', async () => {
    let releaseProject!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseProject = resolve;
    });
    let projectLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      projectLocked = resolve;
    });
    const projectWrite = new ProjectFileTransactions(home, {
      afterLockAcquired: async () => {
        projectLocked();
        await held;
      },
    }).createProject(SLUG, { id: 'project-alpha', slug: SLUG });
    await locked;

    let entered = false;
    const documents = readKnowledgeDocuments(
      { storageDir, dataDir: home, projectSlug: SLUG, namespace: NAMESPACE },
      () => {
        entered = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(entered).toBe(false);

    releaseProject();
    await projectWrite;
    await documents;
    expect(entered).toBe(true);
  });
});

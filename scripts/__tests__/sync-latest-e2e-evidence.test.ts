import { EventEmitter } from 'node:events';
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import {
  downloadArchive,
  extractBoundedE2EZip,
  formatSyncResult,
  parseSyncArgs,
  preflightBoundedE2EZip,
  syncLatestE2EEvidence,
} from '../sync-latest-e2e-evidence.mjs';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-e2e-zip-'));
  roots.push(root);
  return root;
}
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

function writeZip(path: string, entries: Array<[string, string]>) {
  return new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, contents] of entries)
      zip.addBuffer(Buffer.from(contents), name);
    zip.outputStream
      .pipe(createWriteStream(path))
      .on('close', resolve)
      .on('error', reject);
    zip.end();
  });
}

function replaceArchiveName(path: string, from: string, to: string) {
  expect(Buffer.byteLength(from)).toBe(Buffer.byteLength(to));
  const body = readFileSync(path);
  const source = Buffer.from(from);
  let offset = 0;
  while (true) {
    const found = body.indexOf(source, offset);
    if (found < 0) break;
    body.write(to, found);
    offset = found + source.length;
  }
  writeFileSync(path, body);
}

async function artifactArchive(
  root: string,
  { runId = 'run-77', revision = 'a'.repeat(40), ciRunId = 77 } = {},
) {
  const archive = join(root, `artifact-${runId}.zip`);
  await writeZip(archive, [
    [
      '.kontourai/e2e-latest/manifest.json',
      JSON.stringify({
        schemaVersion: 2,
        runId,
        revision,
        ciRunId,
        verdict: 'FAIL',
        payloadDirectory: `runs/${runId}`,
        buckets: [
          {
            name: 'product',
            verdict: 'FAIL',
            counts: { failed: 1 },
            details: 'visible failure',
          },
        ],
        files: [{ path: 'shot.png', bytes: 5 }],
      }),
    ],
    ['.kontourai/e2e-latest/index.html', '<!doctype html>'],
    [`.kontourai/e2e-latest/runs/${runId}/shot.png`, 'image'],
    ['test-results/unrelated.txt', 'ignored-but-validated'],
    ['.kontourai/verification-receipts/receipt.json', '{}'],
  ]);
  return readFileSync(archive);
}

function fakeGh({
  runs,
  artifacts,
  archives,
  workflowId = 11,
}: {
  runs: Array<Record<string, unknown>>;
  artifacts: Record<string, { artifacts: unknown[] }>;
  archives: Record<string, Buffer>;
  workflowId?: number;
}) {
  const invoke = (args: string[]) => {
    if (args[0] === 'api' && args[1]?.endsWith('/actions/workflows'))
      return JSON.stringify({
        workflows: [
          {
            id: workflowId,
            name: 'CI Extended',
            path: '.github/workflows/ci-extended.yml',
          },
        ],
      });
    if (args[0] === 'run' && args[1] === 'list') return JSON.stringify(runs);
    if (args[0] === 'run' && args[1] === 'view') {
      const found = runs.find((run) => String(run.databaseId) === args[2]);
      return JSON.stringify(found ?? {});
    }
    if (args[0] === 'api' && args[1]?.includes('/artifacts'))
      return JSON.stringify(artifacts[args[1]] ?? { artifacts: [] });
    throw new Error(`unexpected gh request: ${args.join(' ')}`);
  };
  const spawnImpl = (_command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { pause: () => void; resume: () => void };
      stderr: EventEmitter & { resume: () => void };
      kill: () => void;
    };
    child.stdout = Object.assign(new EventEmitter(), {
      pause() {},
      resume() {},
    });
    child.stderr = Object.assign(new EventEmitter(), { resume() {} });
    child.kill = () => undefined;
    const archive = archives[args[1]];
    queueMicrotask(() => {
      if (archive) child.stdout.emit('data', archive);
      child.emit('close', archive ? 0 : 1);
    });
    return child;
  };
  return { invoke, spawnImpl };
}

describe('bounded CI E2E artifact sync', () => {
  it('accepts exactly the nested projection root and streams it to an empty destination', async () => {
    const root = fixture();
    const archive = join(root, 'evidence.zip');
    const destination = join(root, 'out');
    await writeZip(archive, [
      ['.kontourai/e2e-latest/manifest.json', '{}'],
      ['.kontourai/e2e-latest/index.html', '<!doctype html>'],
      ['.kontourai/e2e-latest/runs/r1/shot.png', 'image'],
    ]);
    await expect(preflightBoundedE2EZip(archive)).resolves.toHaveLength(3);
    await expect(
      extractBoundedE2EZip(archive, destination),
    ).resolves.toHaveLength(3);
  });

  it('rejects traversal, mixed roots, declared overflow, and removes partial output', async () => {
    const root = fixture();
    const traversal = join(root, 'traversal.zip');
    await writeZip(traversal, [['xx/manifest.json', 'x']]);
    replaceArchiveName(traversal, 'xx/manifest.json', '../manifest.json');
    await expect(preflightBoundedE2EZip(traversal)).rejects.toThrow(
      /unsafe path|invalid relative path/,
    );

    const mixed = join(root, 'mixed.zip');
    await writeZip(mixed, [
      ['manifest.json', '{}'],
      ['.kontourai/e2e-latest/index.html', 'x'],
    ]);
    await expect(preflightBoundedE2EZip(mixed)).rejects.toThrow(
      'mixes projection roots',
    );

    const overflow = join(root, 'overflow.zip');
    await writeZip(overflow, [['manifest.json', '12345']]);
    await expect(
      preflightBoundedE2EZip(overflow, { maxBytes: 10, maxEntryBytes: 4 }),
    ).rejects.toThrow('per-entry size');
    const destination = join(root, 'partial');
    await expect(
      extractBoundedE2EZip(overflow, destination, { maxBytes: 4 }),
    ).rejects.toThrow();
    expect(existsSync(destination)).toBe(false);
  });

  it('aborts a compressed download before the injected byte fence and removes it', async () => {
    const root = fixture();
    const output = join(root, 'download.zip');
    const spawnImpl = () => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { pause: () => void; resume: () => void };
        stderr: EventEmitter;
        kill: () => void;
      };
      child.stdout = Object.assign(new EventEmitter(), {
        pause() {},
        resume() {},
      });
      child.stderr = new EventEmitter();
      child.kill = () => undefined;
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('12345')));
      return child;
    };
    await expect(
      downloadArchive('repos/example/artifact/zip', output, {
        spawnImpl: spawnImpl as never,
        maxBytes: 4,
      }),
    ).rejects.toThrow('compressed byte limit');
    expect(existsSync(output)).toBe(false);
  });

  it('selects the newest compatible run, skips an incompatible artifact, and installs only its nested projection', async () => {
    const root = fixture();
    const archive = await artifactArchive(root);
    const runs = [
      {
        databaseId: 99,
        workflowDatabaseId: 11,
        workflowName: 'CI Extended',
        status: 'completed',
        conclusion: 'success',
        headSha: 'a'.repeat(40),
      },
      {
        databaseId: 77,
        workflowDatabaseId: 11,
        workflowName: 'CI Extended',
        status: 'completed',
        conclusion: 'failure',
        headSha: 'a'.repeat(40),
      },
    ];
    const { invoke, spawnImpl } = fakeGh({
      runs,
      artifacts: {
        'repos/kontourai/station/actions/runs/99/artifacts': { artifacts: [] },
        'repos/kontourai/station/actions/runs/77/artifacts': {
          artifacts: [
            {
              id: 700,
              name: 'playwright-full-verification-77',
              size_in_bytes: archive.length,
              expired: false,
            },
          ],
        },
      },
      archives: {
        'repos/kontourai/station/actions/artifacts/700/zip': archive,
      },
    });
    const destinationDir = join(root, 'latest');
    const result = await syncLatestE2EEvidence(
      { runId: null, status: null },
      { invoke, spawnImpl: spawnImpl as never, destinationDir },
    );
    expect(result.run.databaseId).toBe(77);
    expect(
      readFileSync(join(destinationDir, 'manifest.json'), 'utf8'),
    ).toContain('github-actions:77');
    expect(existsSync(join(destinationDir, 'test-results'))).toBe(false);
    expect(formatSyncResult(result)).toBe(
      'Installed CI Extended run 77 (FAIL) at .kontourai/e2e-latest/',
    );
    await expect(
      syncLatestE2EEvidence(
        { runId: '77', status: null },
        { invoke, spawnImpl: spawnImpl as never, destinationDir },
      ),
    ).resolves.toMatchObject({ run: { databaseId: 77 } });
  });

  it('fails closed for exact workflow/artifact/revision/CI identity mismatches', async () => {
    const root = fixture();
    const archive = await artifactArchive(root, {
      revision: 'b'.repeat(40),
      ciRunId: 88,
    });
    const baseRun = {
      databaseId: 77,
      workflowDatabaseId: 11,
      workflowName: 'CI Extended',
      status: 'completed',
      conclusion: 'success',
      headSha: 'a'.repeat(40),
    };
    const base = fakeGh({
      runs: [baseRun],
      artifacts: {
        'repos/kontourai/station/actions/runs/77/artifacts': {
          artifacts: [
            {
              id: 700,
              name: 'playwright-full-verification-77',
              size_in_bytes: archive.length,
              expired: false,
            },
          ],
        },
      },
      archives: {
        'repos/kontourai/station/actions/artifacts/700/zip': archive,
      },
    });
    await expect(
      syncLatestE2EEvidence(
        { runId: '77', status: null },
        {
          invoke: base.invoke,
          spawnImpl: base.spawnImpl as never,
          destinationDir: join(root, 'bad'),
        },
      ),
    ).rejects.toThrow('revision does not match');
    const wrongWorkflow = fakeGh({
      ...{
        runs: [{ ...baseRun, workflowDatabaseId: 12 }],
        artifacts: {},
        archives: {},
      },
    });
    await expect(
      syncLatestE2EEvidence(
        { runId: '77', status: null },
        { invoke: wrongWorkflow.invoke, destinationDir: join(root, 'wrong') },
      ),
    ).rejects.toThrow('completed CI Extended');
    expect(() => parseSyncArgs(['--run-id', 'nope'])).toThrow('numeric');
    expect(() => parseSyncArgs(['--run-id'])).toThrow('requires a value');
    expect(() => parseSyncArgs(['--status'])).toThrow('requires a value');
    expect(() => parseSyncArgs(['--status', 'running'])).toThrow(
      'completed conclusion',
    );
  });
});

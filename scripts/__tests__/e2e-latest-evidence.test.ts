import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectE2EEvidenceDirectory,
  projectLatestE2EEvidence,
  validateLatestE2EEvidence,
} from '../lib/e2e-latest-evidence.mjs';

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'station-e2e-'));
  roots.push(root);
  return root;
};
const buckets = [
  {
    name: 'product',
    verdict: 'FAIL',
    counts: { failed: 1 },
    seconds: 1,
    runnerError: 'broken',
    specs: ['tests/x.spec.ts'],
    output: 'tail',
  },
];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

describe('latest E2E pointer projection', () => {
  it('keeps stable latest while atomically moving its pointer to an immutable payload', () => {
    const root = fixture();
    const source = join(root, 'evidence');
    const latest = join(root, '.kontourai', 'e2e-latest');
    mkdirSync(join(source, 'gallery'), { recursive: true });
    writeFileSync(join(source, 'gallery', 'screen.png'), 'image');
    const manifest = projectLatestE2EEvidence({
      sourceDir: source,
      destinationDir: latest,
      workspaceRoot: root,
      runId: 'run-123',
      buckets,
      createdAt: '</script><script>globalThis.pwned=true</script>',
    });
    expect(manifest.payloadDirectory).toBe('runs/run-123');
    expect(readFileSync(join(latest, 'manifest.json'), 'utf8')).toContain(
      'runnerError',
    );
    const index = readFileSync(join(latest, 'index.html'), 'utf8');
    expect(index).toContain('Content-Security-Policy');
    expect(index).toContain('gallery/screen.png');
    expect(index).toContain('loading="lazy"');
    expect(index).toContain("script-src 'none'");
    expect(index).not.toContain('<script>');
    expect(index).not.toContain('</script><script>globalThis.pwned');
    expect(Number(manifest.generated.indexBytes)).toBe(
      Buffer.byteLength(index),
    );
    expect(
      readFileSync(
        join(latest, 'runs', 'run-123', 'gallery', 'screen.png'),
        'utf8',
      ),
    ).toBe('image');
  });
  it('rejects symlinks, unsafe names, text overflow, and total-byte overflow before copying', () => {
    const root = fixture();
    const source = join(root, 'evidence');
    mkdirSync(source);
    writeFileSync(join(source, 'x.txt'), 'abcdef');
    expect(() =>
      inspectE2EEvidenceDirectory(source, { maxTextBytes: 2 }),
    ).toThrow('text file');
    expect(() => inspectE2EEvidenceDirectory(source, { maxBytes: 2 })).toThrow(
      'exceeds',
    );
    rmSync(join(source, 'x.txt'));
    writeFileSync(join(root, 'outside.png'), 'x');
    symlinkSync(join(root, 'outside.png'), join(source, 'link.png'));
    expect(() => inspectE2EEvidenceDirectory(source)).toThrow('symlink');
  });
  it('prunes only unreferenced old payloads after committing a new pointer', () => {
    const root = fixture();
    const source = join(root, 'evidence');
    const latest = join(root, 'latest');
    mkdirSync(source);
    writeFileSync(join(source, 'a.png'), 'a');
    projectLatestE2EEvidence({
      sourceDir: source,
      destinationDir: latest,
      workspaceRoot: root,
      runId: 'run-one',
      buckets,
    });
    projectLatestE2EEvidence({
      sourceDir: source,
      destinationDir: latest,
      workspaceRoot: root,
      runId: 'run-two',
      buckets,
    });
    expect(() =>
      readFileSync(join(latest, 'runs', 'run-one', 'a.png')),
    ).toThrow();
    expect(readFileSync(join(latest, 'runs', 'run-two', 'a.png'), 'utf8')).toBe(
      'a',
    );
  });

  it('keeps the prior pointer readable if interrupted after immutable payload commit', () => {
    const root = fixture();
    const source = join(root, 'evidence');
    const latest = join(root, 'latest');
    const maxBytes = 7_000;
    mkdirSync(source);
    writeFileSync(join(source, 'a.png'), 'a'.repeat(4_500));
    projectLatestE2EEvidence({
      sourceDir: source,
      destinationDir: latest,
      workspaceRoot: root,
      runId: 'old-run',
      buckets,
      maxBytes,
    });
    expect(() =>
      projectLatestE2EEvidence({
        sourceDir: source,
        destinationDir: latest,
        workspaceRoot: root,
        runId: 'interrupted-run',
        buckets,
        maxBytes,
        afterPayloadCommit: () => {
          throw new Error('simulated crash window');
        },
      }),
    ).toThrow('simulated crash window');
    expect(validateLatestE2EEvidence(latest).runId).toBe('old-run');
    expect(() => validateLatestE2EEvidence(latest, { maxBytes })).toThrow(
      'exceeds',
    );
    expect(existsSync(join(latest, 'runs', 'interrupted-run'))).toBe(true);
    expect(
      projectLatestE2EEvidence({
        sourceDir: source,
        destinationDir: latest,
        workspaceRoot: root,
        runId: 'interrupted-run',
        buckets,
        maxBytes,
      }).runId,
    ).toBe('interrupted-run');
    expect(validateLatestE2EEvidence(latest).runId).toBe('interrupted-run');
    expect(existsSync(join(latest, 'runs', 'old-run'))).toBe(false);
  });

  it('recovers an interrupted viewer swap before the manifest pointer moves', () => {
    const root = fixture();
    const source = join(root, 'evidence');
    const latest = join(root, 'latest');
    mkdirSync(source);
    writeFileSync(join(source, 'a.png'), 'a');
    projectLatestE2EEvidence({
      sourceDir: source,
      destinationDir: latest,
      workspaceRoot: root,
      runId: 'old-run',
      buckets,
    });
    expect(() =>
      projectLatestE2EEvidence({
        sourceDir: source,
        destinationDir: latest,
        workspaceRoot: root,
        runId: 'viewer-committed',
        buckets,
        afterIndexCommit: () => {
          throw new Error('interrupted after viewer commit');
        },
      }),
    ).toThrow('interrupted after viewer commit');
    expect(() => validateLatestE2EEvidence(latest)).toThrow('inconsistent');
    projectLatestE2EEvidence({
      sourceDir: source,
      destinationDir: latest,
      workspaceRoot: root,
      runId: 'old-run',
      buckets,
    });
    expect(validateLatestE2EEvidence(latest).runId).toBe('old-run');
  });

  it('finishes pruning when an exact retry follows a committed manifest', () => {
    const root = fixture();
    const source = join(root, 'evidence');
    const latest = join(root, 'latest');
    const maxBytes = 7_000;
    mkdirSync(source);
    writeFileSync(join(source, 'a.png'), 'a'.repeat(4_500));
    projectLatestE2EEvidence({
      sourceDir: source,
      destinationDir: latest,
      workspaceRoot: root,
      runId: 'old-run',
      buckets,
      maxBytes,
    });
    expect(() =>
      projectLatestE2EEvidence({
        sourceDir: source,
        destinationDir: latest,
        workspaceRoot: root,
        runId: 'committed-run',
        buckets,
        maxBytes,
        afterManifestCommit: () => {
          throw new Error('interrupted before pruning');
        },
      }),
    ).toThrow('interrupted before pruning');
    expect(validateLatestE2EEvidence(latest).runId).toBe('committed-run');
    expect(() => validateLatestE2EEvidence(latest, { maxBytes })).toThrow(
      'exceeds',
    );
    expect(existsSync(join(latest, 'runs', 'old-run'))).toBe(true);
    projectLatestE2EEvidence({
      sourceDir: source,
      destinationDir: latest,
      workspaceRoot: root,
      runId: 'committed-run',
      buckets,
      maxBytes,
    });
    expect(existsSync(join(latest, 'runs', 'old-run'))).toBe(false);
  });

  it('rejects a symlinked destination and safely treats a repeated run as idempotent', () => {
    const root = fixture();
    const source = join(root, 'evidence');
    const latest = join(root, 'latest');
    mkdirSync(source);
    writeFileSync(join(source, 'a.png'), 'a');
    projectLatestE2EEvidence({
      sourceDir: source,
      destinationDir: latest,
      workspaceRoot: root,
      runId: 'same-run',
      buckets,
    });
    expect(
      projectLatestE2EEvidence({
        sourceDir: source,
        destinationDir: latest,
        workspaceRoot: root,
        runId: 'same-run',
        buckets,
      }).runId,
    ).toBe('same-run');
    const linked = join(root, 'linked');
    symlinkSync(latest, linked);
    expect(() =>
      projectLatestE2EEvidence({
        sourceDir: source,
        destinationDir: linked,
        workspaceRoot: root,
        runId: 'nope',
        buckets,
      }),
    ).toThrow('symlinked');
  });

  it('rejects a symlinked workspace ancestor before projection writes or cleanup', () => {
    const root = fixture();
    const source = join(root, 'evidence');
    const outside = join(root, 'outside');
    mkdirSync(source);
    mkdirSync(outside);
    writeFileSync(join(source, 'a.png'), 'a');
    symlinkSync(outside, join(root, 'workspace-link'));
    expect(() =>
      projectLatestE2EEvidence({
        sourceDir: source,
        destinationDir: join(root, 'workspace-link', '.kontourai', 'latest'),
        workspaceRoot: root,
        runId: 'blocked-ancestor',
        buckets,
      }),
    ).toThrow('symlinked');
    expect(existsSync(join(outside, '.kontourai'))).toBe(false);
  });

  it('serializes every projector that shares the latest destination', () => {
    const root = fixture();
    const source = join(root, 'evidence');
    const latest = join(root, 'latest');
    mkdirSync(source);
    writeFileSync(join(source, 'a.png'), 'a');
    projectLatestE2EEvidence({
      sourceDir: source,
      destinationDir: latest,
      workspaceRoot: root,
      runId: 'lock-owner',
      buckets,
      afterPayloadCommit: () => {
        expect(() =>
          projectLatestE2EEvidence({
            sourceDir: source,
            destinationDir: latest,
            workspaceRoot: root,
            runId: 'lock-contender',
            buckets,
            projectionLockWaitMs: 0,
          }),
        ).toThrow('projection is busy');
      },
    });
    expect(validateLatestE2EEvidence(latest).runId).toBe('lock-owner');
    expect(existsSync(join(root, '.latest.projection.lock'))).toBe(false);
  });

  it('reclaims dead or PID-reused locks and only quarantines malformed locks after a bounded age', () => {
    const root = fixture();
    const source = join(root, 'evidence');
    const latest = join(root, 'latest');
    const lock = join(root, '.latest.projection.lock');
    mkdirSync(source);
    writeFileSync(join(source, 'a.png'), 'a');
    writeFileSync(
      lock,
      `${JSON.stringify({ pid: process.pid, processStart: 'different-process', nonce: 'old' })}\n`,
    );
    projectLatestE2EEvidence({
      sourceDir: source,
      destinationDir: latest,
      workspaceRoot: root,
      runId: 'reclaimed-lock',
      buckets,
    });
    writeFileSync(lock, 'not-json');
    expect(() =>
      projectLatestE2EEvidence({
        sourceDir: source,
        destinationDir: latest,
        workspaceRoot: root,
        runId: 'fresh-malformed',
        buckets,
        projectionLockWaitMs: 0,
      }),
    ).toThrow('lock is invalid');
    const stale = new Date(Date.now() - 6 * 60_000);
    utimesSync(lock, stale, stale);
    projectLatestE2EEvidence({
      sourceDir: source,
      destinationDir: latest,
      workspaceRoot: root,
      runId: 'stale-malformed',
      buckets,
    });
    expect(validateLatestE2EEvidence(latest).runId).toBe('stale-malformed');
    expect(existsSync(lock)).toBe(false);
    if (process.platform !== 'win32') {
      writeFileSync(lock, 'unreadable');
      utimesSync(lock, stale, stale);
      chmodSync(lock, 0o000);
      expect(() =>
        projectLatestE2EEvidence({
          sourceDir: source,
          destinationDir: latest,
          workspaceRoot: root,
          runId: 'stale-unreadable',
          buckets,
          projectionLockWaitMs: 0,
        }),
      ).toThrow('lock is unreadable');
    }
  });

  it('keeps a live lock when process-start identity lookup is unavailable', () => {
    const root = fixture();
    const source = join(root, 'evidence');
    const latest = join(root, 'latest');
    const lock = join(root, '.latest.projection.lock');
    mkdirSync(source);
    writeFileSync(join(source, 'a.png'), 'a');
    writeFileSync(
      lock,
      `${JSON.stringify({ pid: process.pid, processStart: null, nonce: 'live' })}\n`,
    );
    expect(() =>
      projectLatestE2EEvidence({
        sourceDir: source,
        destinationDir: latest,
        workspaceRoot: root,
        runId: 'must-wait',
        buckets,
        projectionLockWaitMs: 0,
        processStartIdentityFn: () => null,
      }),
    ).toThrow('projection is busy');
    expect(existsSync(lock)).toBe(true);
  });

  it('recovers only owned crash debris and rejects unexpected run entries before pointer commit', () => {
    const root = fixture();
    const source = join(root, 'evidence');
    const latest = join(root, 'latest');
    mkdirSync(source);
    writeFileSync(join(source, 'a.png'), 'a');
    projectLatestE2EEvidence({
      sourceDir: source,
      destinationDir: latest,
      workspaceRoot: root,
      runId: 'old-run',
      buckets,
    });
    writeFileSync(join(latest, 'runs', 'unexpected.txt'), 'unsafe');
    expect(() =>
      projectLatestE2EEvidence({
        sourceDir: source,
        destinationDir: latest,
        workspaceRoot: root,
        runId: 'blocked-run',
        buckets,
      }),
    ).toThrow('unsafe entry');
    expect(validateLatestE2EEvidence(latest).runId).toBe('old-run');
    rmSync(join(latest, 'runs', 'unexpected.txt'));

    writeFileSync(join(latest, '.manifest.json-1-1.tmp'), 'partial');
    writeFileSync(join(latest, '.index.html-1-1.tmp'), 'partial');
    mkdirSync(join(latest, 'runs', '.abandoned-run.1.stage'));
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    symlinkSync(outside, join(latest, 'runs', 'stale-link'));

    projectLatestE2EEvidence({
      sourceDir: source,
      destinationDir: latest,
      workspaceRoot: root,
      runId: 'new-run',
      buckets,
    });
    expect(existsSync(join(latest, '.manifest.json-1-1.tmp'))).toBe(false);
    expect(existsSync(join(latest, '.index.html-1-1.tmp'))).toBe(false);
    expect(existsSync(join(latest, 'runs', '.abandoned-run.1.stage'))).toBe(
      false,
    );
    expect(existsSync(join(latest, 'runs', 'stale-link'))).toBe(false);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    expect(validateLatestE2EEvidence(latest).runId).toBe('new-run');
  });
});

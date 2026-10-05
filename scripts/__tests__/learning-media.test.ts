import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { buildLearningGuide } from '../build-learning-guide.mjs';
import { execFileSyncBounded } from '../lib/bounded-capture.mjs';
import {
  freshnessRequirement,
  resolveDocumentationFreshness,
} from '../lib/documentation-freshness.mjs';
import { sanitizedGitEnvironment } from '../lib/git-environment.mjs';
import { renderLearningDocument } from '../lib/learning-markdown.mjs';
import { compileLearningMedia } from '../lib/learning-media.mjs';
import { createLearningSourceReader } from '../lib/learning-source-reader.mjs';
import { readReviewState } from '../lib/review-ledger-store.mjs';
import {
  forbidAmbientFreshnessMode,
  JOB_ENV,
} from './helpers/freshness-env.js';
import {
  writeLearningMedia,
  writeReviewLedger,
} from './helpers/review-ledger-fixture.js';

forbidAmbientFreshnessMode();

const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=',
  'base64',
);
const source = Buffer.from('source');
const capture = {
  path: 'docs/learn/media/task.png',
  kind: 'image',
  digest: createHash('sha256').update(image).digest('hex'),
  alt: 'Task workspace with sample data',
  caption: 'A sample Task.',
  scenario: 'Task inspection',
  evidence: 'Controlled browser fixture; no provider execution.',
  capturedRevision: 'a'.repeat(40),
  documents: ['guide.md'],
  sources: [
    {
      path: 'code.ts',
      digest: createHash('sha256').update(source).digest('hex'),
      revision: 'a'.repeat(40),
    },
  ],
};
const tracked = new Set([capture.path, 'guide.md', 'code.ts']);
const read = async (path: string) => (path === capture.path ? image : source);
const makeTempDir = trackTempDirs();

it.each(['legacy', 'path-only'])(
  'renders admitted %s captures inline with provenance and no external image fetch',
  async (layout) => {
    const media = await compileLearningMedia(
      {
        version: 1,
        captures: [
          layout === 'legacy'
            ? capture
            : {
                ...capture,
                historyChanges: [],
                reviewBaseline: 'b'.repeat(40),
                sources: [{ path: 'code.ts' }],
              },
        ],
      },
      tracked,
      read,
    );
    const rendered = renderLearningDocument(
      '![Task](docs/learn/media/task.png)\n\n![Remote](https://example.invalid/remote.png)',
      'guide.md',
      new Set(['guide.md']),
      'a'.repeat(40),
      tracked,
      media,
    );
    expect(rendered.html).toContain('<img');
    expect(rendered.html).toContain(`src="${media.get(capture.path).url}"`);
    expect(rendered.html).toContain(capture.evidence);
    expect(rendered.html).toContain(
      layout === 'legacy'
        ? 'sources reviewed at aaaaaaaaaaaa'
        : 'source reviews are recorded in append-only notes. Review history since bbbbbbbbbbbb',
    );
    expect(rendered.html).not.toContain('src="https://');
    expect(rendered.links.map((link) => link.target)).toContain(
      'docs/learn/media/task.png',
    );
  },
);
it('emits local video controls without autoplay and preserves explanatory text', async () => {
  const video = {
    ...capture,
    path: 'docs/learn/media/task.webm',
    kind: 'video',
    digest: createHash('sha256')
      .update(Buffer.from([26, 69, 223, 163, 0]))
      .digest('hex'),
  };
  const files = new Set([...tracked, video.path]);
  const media = await compileLearningMedia(
    { version: 1, captures: [video] },
    files,
    async (path: string) =>
      path === video.path ? Buffer.from([26, 69, 223, 163, 0]) : source,
  );
  const rendered = renderLearningDocument(
    `![Task walkthrough](${video.path})`,
    'guide.md',
    new Set(['guide.md']),
    'a'.repeat(40),
    files,
    media,
  );
  expect(rendered.html).toContain('<video');
  expect(rendered.html).toContain('controls="" preload="none"');
  expect(rendered.html).not.toContain('autoplay');
  expect(rendered.html).toContain('Task walkthrough');
});
it('warns on source drift and rejects it in the strict check without relabeling the capture revision', async () => {
  const changedRead = async (path: string) =>
    path === capture.path ? image : Buffer.from('changed');
  const media = await compileLearningMedia(
    { version: 1, captures: [capture] },
    tracked,
    changedRead,
  );
  expect(media.get(capture.path).changed).toEqual(['code.ts']);
  expect(media.get(capture.path).capturedRevision).toBe(
    capture.capturedRevision,
  );
  await expect(
    compileLearningMedia(
      { version: 1, captures: [capture] },
      tracked,
      changedRead,
      { requireFresh: true },
    ),
  ).rejects.toMatchObject({
    code: 'needs-refresh',
    path: capture.path,
    changed: ['code.ts'],
  });
  const rendered = renderLearningDocument(
    `![Task](${capture.path})`,
    'guide.md',
    new Set(['guide.md']),
    'a'.repeat(40),
    tracked,
    media,
  );
  expect(rendered.html).toContain('Visual review needed');
});
it('rejects untracked assets, invalid bytes and missing evidence instead of silently publishing them', async () => {
  await expect(
    compileLearningMedia(
      { version: 1, captures: [capture] },
      new Set(['guide.md', 'code.ts']),
      read,
    ),
  ).rejects.toThrow('Invalid learning capture');
  await expect(
    compileLearningMedia(
      { version: 1, captures: [capture] },
      tracked,
      async () => source,
    ),
  ).rejects.toThrow('Invalid or oversized');
  await expect(
    compileLearningMedia(
      { version: 1, captures: [{ ...capture, digest: '0'.repeat(64) }] },
      tracked,
      read,
    ),
  ).rejects.toThrow('bytes differ from the recorded digest');
  await expect(
    compileLearningMedia(
      { version: 1, captures: [{ ...capture, evidence: '' }] },
      tracked,
      read,
    ),
  ).rejects.toThrow('Missing capture evidence');
});
it('the real builder publishes immutable media bytes and its strict entry detects changed UI source', async () => {
  const root = makeTempDir('station-learning-media-');
  const write = (path: string, bytes: string | Buffer) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  const localCapture = {
    ...capture,
    path: 'docs/learn/media/task capture.png',
  };
  const guide = `# Guide\n\n![Task](<${localCapture.path}>)\n`;
  write('guide.md', guide);
  write('code.ts', source);
  write('owner.ts', 'export const owner = 1;\n');
  write(localCapture.path, image);
  write(
    'docs/architecture/module-map.md',
    '# Modules\n\n## Owner\nA module.\n',
  );
  write(
    'docs/learn/atlas.json',
    JSON.stringify({
      version: 1,
      groups: [
        {
          id: 'work',
          title: 'Work',
          summary: 'Sample work.',
          docs: ['guide.md'],
          modules: ['Owner'],
          questions: ['How?'],
        },
      ],
    }),
  );
  const digest = (bytes: string) =>
    createHash('sha256').update(bytes).digest('hex');
  writeReviewLedger(root, [
    {
      path: 'guide.md',
      documentDigest: digest(guide),
      kind: 'current',
      state: 'source-reviewed',
      summary: 'Checked the owner.',
      limits: 'Fixture only.',
      sources: [
        { path: 'owner.ts', digest: digest('export const owner = 1;\n') },
      ],
      checks: ['Fixture evidence.'],
    },
  ]);
  writeLearningMedia(root, [localCapture]);
  for (const asset of ['index.html', 'atlas.css', 'atlas.js'])
    write(`docs/learn/${asset}`, readFileSync(`docs/learn/${asset}`));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      env,
      windowsHide: true,
      stdio: 'pipe',
    });
  git(['init', '-q']);
  git(['add', '.']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-qm',
    'media fixture',
  ]);
  const result = await buildLearningGuide({ root });
  const url = result.captures[0].url;
  expect(
    readFileSync(
      join(root, '.kontourai/docs-learning', decodeURIComponent(url)),
    ),
  ).toEqual(image);
  expect(
    result.documents.find((doc) => doc.path === 'guide.md')?.html,
  ).toContain(url);
  git(['branch', 'fixture-base']);
  write('code.ts', 'changed UI');
  // #2923: docs:learn:check follows the shared freshness policy. Each check
  // pins its environment; the ambient mode is forbidden in this file (#2934).
  const check = (env: NodeJS.ProcessEnv) =>
    buildLearningGuide({
      root,
      check: true,
      freshness: resolveDocumentationFreshness({ root, env }),
    });
  const pr = { STATION_DOCS_FRESHNESS_BASE: 'fixture-base' };
  const queue = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'merge_group' };
  // No base resolves in this repository, so the scope is unknown: strict.
  const staleCapture = {
    code: 'needs-refresh',
    path: localCapture.path,
    changed: ['code.ts'],
  };
  await expect(check({})).rejects.toMatchObject(staleCapture);
  // The change owns its stale capture; the merge queue only reports it.
  await expect(check(pr)).rejects.toMatchObject(staleCapture);
  const queued = await check(queue);
  expect(queued.captures[0].changed).toEqual(['code.ts']);
  // The same decision governs review records in the builder.
  write('code.ts', source);
  write('owner.ts', 'export const owner = 2;\n');
  const reviewed = await check(queue);
  expect(
    reviewed.documents.find((doc) => doc.path === 'guide.md')?.reviewRecord,
  ).toMatchObject({ state: 'needs-review', changed: ['owner.ts'] });
  // A source removed by another change is a stale input in the queue,
  // not a malformed ledger.
  git(['rm', '-qf', 'owner.ts']);
  const removed = await check(queue);
  expect(
    removed.documents.find((doc) => doc.path === 'guide.md')?.reviewRecord,
  ).toMatchObject({ state: 'needs-review', changed: ['owner.ts'] });
  await expect(check(pr)).rejects.toMatchObject({
    code: 'needs-refresh',
    path: 'guide.md',
    changed: ['owner.ts'],
  });
  expect(
    readFileSync(
      join(root, '.kontourai/docs-learning', decodeURIComponent(url)),
    ),
  ).toEqual(image);
});

it('checks the actual capture manifest and recorded source bytes in the required documentation lane', async () => {
  const reader = createLearningSourceReader(process.cwd());
  const files = new Set(
    execFileSyncBounded('git', ['ls-files', '-z'], {
      encoding: 'utf8',
      env: sanitizedGitEnvironment(),
      windowsHide: true,
    })
      .split('\0')
      .filter(Boolean),
  );
  // media.json metadata joined with each capture's review (#2936).
  const { media: manifest } = readReviewState(process.cwd());
  if (!manifest) throw new Error('The repository has no capture manifest');
  // #2923: the same scoped/advisory/strict decision as the review ledger.
  const captures = await compileLearningMedia(
    manifest,
    files,
    async (path: string) => reader.read(path),
    {
      // The real manifest runs in the job's own mode: scoped on a pull
      // request, advisory in the merge queue and repo-scans job.
      requireFresh: freshnessRequirement(
        resolveDocumentationFreshness({ root: process.cwd(), env: JOB_ENV }),
        'capture',
      ),
      reportMissing: true,
    },
  );
  expect(captures.size).toBeGreaterThan(0);
  expect(captures.size).toBe(manifest.captures.length);
});

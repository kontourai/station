import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { buildLearningGuide } from '../build-learning-guide.mjs';
import { renderLearningDocument } from '../lib/learning-markdown.mjs';
import { compileLearningMedia } from '../lib/learning-media.mjs';

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
  reviewedRevision: 'a'.repeat(40),
  documents: ['guide.md'],
  sources: [
    {
      path: 'code.ts',
      digest: createHash('sha256').update(source).digest('hex'),
    },
  ],
};
const tracked = new Set([capture.path, 'guide.md', 'code.ts']);
const read = async (path: string) => (path === capture.path ? image : source);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it('renders only admitted local captures inline, with provenance and no external image fetch', async () => {
  const media = await compileLearningMedia(
    { version: 1, captures: [capture] },
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
  expect(rendered.html).not.toContain('src="https://');
  expect(rendered.links.map((link) => link.target)).toContain(
    'docs/learn/media/task.png',
  );
});
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
  ).rejects.toThrow('Learning capture needs review');
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
  const root = mkdtempSync(join(tmpdir(), 'station-learning-media-'));
  roots.push(root);
  const write = (path: string, bytes: string | Buffer) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  const localCapture = {
    ...capture,
    path: 'docs/learn/media/task capture.png',
  };
  write('guide.md', `# Guide\n\n![Task](<${localCapture.path}>)\n`);
  write('code.ts', source);
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
  write(
    'docs/learn/review-ledger.json',
    JSON.stringify({ version: 1, records: [] }),
  );
  write(
    'docs/learn/media.json',
    JSON.stringify({ version: 1, captures: [localCapture] }),
  );
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
    result.documents.find((doc) => doc.path === 'guide.md').html,
  ).toContain(url);
  write('code.ts', 'changed UI');
  await expect(buildLearningGuide({ root, check: true })).rejects.toThrow(
    'Learning capture needs review',
  );
  expect(
    readFileSync(
      join(root, '.kontourai/docs-learning', decodeURIComponent(url)),
    ),
  ).toEqual(image);
});

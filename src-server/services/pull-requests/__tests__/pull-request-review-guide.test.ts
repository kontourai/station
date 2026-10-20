import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PullRequestReviewGuideStop } from '@kontourai/station-contracts/pull-request-review-guide';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { PullRequestReviewGuideService } from '../pull-request-review-guide.js';
import {
  normalizeReviewGuide,
  readGuideChange,
} from '../pull-request-review-guide-normalize.js';
import { PullRequestReviewGuideStore } from '../pull-request-review-guide-store.js';
import { guideFixture } from './guide-fixture.js';

const makeTempDir = trackTempDirs();
const identity = {
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'team', name: 'repo' },
  ref: '17',
};
const stop = (): PullRequestReviewGuideStop => ({
  title: 'Use the new contract',
  summary: 'The caller now receives the new value.',
  attention: null,
  excerpts: [
    { path: 'a.ts', side: 'new', start: 1, end: 1, caption: 'New contract' },
  ],
  files: [],
  notes: [],
  questions: [],
});
const patch =
  'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n';

test('normalization covers every changed file and rejects hallucinated, reversed, oversized and missing-line excerpts', () => {
  const change = readGuideChange(['a.ts', 'image.png'], patch);
  expect(
    normalizeReviewGuide({ stops: [stop()] }, change).flatMap((s) => [
      ...s.excerpts.map((e) => e.path),
      ...s.files.map((f) => f.path),
    ]),
  ).toEqual(['a.ts', 'image.png']);
  for (const excerpt of [
    { path: 'missing.ts', start: 1, end: 1 },
    { path: 'a.ts', start: 2, end: 1 },
    { path: 'a.ts', start: 1, end: 26 },
    { path: 'a.ts', start: 1, end: 2 },
  ])
    expect(() =>
      normalizeReviewGuide(
        {
          stops: [
            { ...stop(), excerpts: [{ ...stop().excerpts[0], ...excerpt }] },
          ],
        },
        change,
      ),
    ).toThrow(/excerpt/);
});

test('rejects a range spanning adjacent distinct hunks', () => {
  const patch =
    'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n@@ -2 +2 @@\n-two\n+second\n';
  const s = stop();
  s.excerpts[0]!.end = 2;
  expect(() =>
    normalizeReviewGuide({ stops: [s] }, readGuideChange(['a.ts'], patch)),
  ).toThrow(/excerpt/);
});

test('deleted files and source lines resembling headers retain their actual side and file', () => {
  const deleted =
    'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n---- source\n-+++ source\n';
  const s = stop();
  s.excerpts = [{ path: 'a.ts', side: 'old', start: 1, end: 2, caption: '' }];
  expect(
    normalizeReviewGuide({ stops: [s] }, readGuideChange(['a.ts'], deleted))[0]
      ?.excerpts,
  ).toHaveLength(1);
  s.excerpts[0]!.side = 'new';
  expect(() =>
    normalizeReviewGuide({ stops: [s] }, readGuideChange(['a.ts'], deleted)),
  ).toThrow(/excerpt/);
});

test('generation reads changed-file blobs, persists coverage across restart and hides stale anchors after a push', async () => {
  const f = await guideFixture(makeTempDir);
  const generate = vi.fn(async (prompt: string) => {
    expect(prompt).toContain('extra.txt');
    expect(prompt).toContain('new\\n');
    return { stops: [stop()] };
  });
  const errors: unknown[] = [];
  const service = new PullRequestReviewGuideService(
    f.store,
    () => ({
      enabled: true,
      model: 'configured-model',
      instructions: 'Contracts first',
    }),
    generate,
    (error) => errors.push(error),
  );
  expect(
    service.start({ identity, context: f.context, snapshot: f.snapshot }).run
      ?.state,
  ).toBe('Running');
  service.start({ identity, context: f.context, snapshot: f.snapshot });
  await vi.waitFor(
    () => expect(service.read(identity, f.snapshot.headSha).run).toBeNull(),
    { timeout: 15_000 },
  );
  expect(errors).toEqual([]);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(await readFile(join(f.root, 'a.ts'), 'utf8')).toBe('new\n');
  const restarted = new PullRequestReviewGuideService(
    new PullRequestReviewGuideStore(join(f.root, 'home')),
    () => ({ enabled: true, model: 'other', instructions: '' }),
    generate,
    () => {},
  );
  const current = restarted.read(
    identity,
    f.snapshot.headSha,
    f.snapshot.diff.state === 'available' ? f.snapshot.diff.patch : '',
  );
  expect(current.guide?.modelSelection).toBe('configured-model');
  expect(
    current.guide?.stops.flatMap((s) => s.files).map((f) => f.path),
  ).toContain('extra.txt');
  expect(current.excerptContents[0]?.lines).toEqual(['new']);
  const stale = restarted.read(identity, 'b'.repeat(40), patch);
  expect(stale.guide?.headSha).toBe(f.snapshot.headSha);
  expect(stale.currentHeadSha).toBe('b'.repeat(40));
  expect(stale.guide?.stops.flatMap((s) => s.excerpts)).toEqual([]);
  expect(stale.excerptContents).toEqual([]);
}, 20_000);

test('invalid model anchors fail the run without publishing a guide', async () => {
  const f = await guideFixture(makeTempDir);
  const broken = stop();
  broken.excerpts[0]!.start = 900;
  broken.excerpts[0]!.end = 900;
  const service = new PullRequestReviewGuideService(
    f.store,
    () => ({ enabled: true, model: 'model', instructions: '' }),
    async () => ({ stops: [broken] }),
    () => {},
  );
  service.start({ identity, context: f.context, snapshot: f.snapshot });
  await vi.waitFor(
    () =>
      expect(service.read(identity, f.snapshot.headSha).run?.state).toBe(
        'Failed',
      ),
    { timeout: 15_000 },
  );
  expect(f.store.latest(identity)).toBeNull();
}, 20_000);

test('rejects notes outside the excerpts of their own stop', () => {
  const invalid = stop();
  invalid.notes = [
    { path: 'a.ts', line: 2, title: 'Outside', body: 'Wrong anchor' },
  ];
  expect(() =>
    normalizeReviewGuide(
      { stops: [invalid] },
      readGuideChange(['a.ts'], patch),
    ),
  ).toThrow('note is outside');
});

test('capacity admits two runs and refuses a third until one finishes', async () => {
  const f = await guideFixture(makeTempDir);
  let finish!: (value: unknown) => void;
  const answer = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const generate = vi.fn(() => answer);
  const service = new PullRequestReviewGuideService(
    f.store,
    () => ({ enabled: true, model: 'model', instructions: '' }),
    generate,
    () => {},
  );
  const identities = ['17', '18', '19'].map((ref) => ({ ...identity, ref }));
  try {
    for (const identity of identities.slice(0, 2))
      service.start({ identity, context: f.context, snapshot: f.snapshot });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2), {
      timeout: 15_000,
    });
    expect(() =>
      service.start({
        identity: identities[2]!,
        context: f.context,
        snapshot: f.snapshot,
      }),
    ).toThrow('Two review guides');
  } finally {
    finish({ stops: [stop()] });
    await vi.waitFor(
      () =>
        expect(
          identities.every((i) => service.status(i).run?.state !== 'Running'),
        ).toBe(true),
      { timeout: 15_000 },
    );
  }
});

test('rechecks access after model completion before saving', async () => {
  const f = await guideFixture(makeTempDir);
  let current = true;
  let finish!: (value: unknown) => void;
  const answer = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const generate = vi.fn(() => answer);
  const service = new PullRequestReviewGuideService(
    f.store,
    () => ({ enabled: true, model: 'model', instructions: '' }),
    generate,
    () => {},
  );
  service.start(
    { identity, context: f.context, snapshot: f.snapshot },
    () => current,
  );
  await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce(), {
    timeout: 15_000,
  });
  current = false;
  finish({ stops: [stop()] });
  await vi.waitFor(() =>
    expect(service.status(identity).run).toMatchObject({
      state: 'Failed',
      detail: expect.stringContaining('access changed'),
    }),
  );
  expect(f.store.read(identity, f.snapshot.headSha)).toBeNull();
});

test('refuses a newer head while an older revision is running; reuses completed guides unless forced', async () => {
  const f = await guideFixture(makeTempDir);
  let finish!: (value: unknown) => void;
  const answer = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const generate = vi.fn(() => answer);
  const service = new PullRequestReviewGuideService(
    f.store,
    () => ({ enabled: true, model: 'model', instructions: '' }),
    generate,
    () => {},
  );
  service.start({ identity, context: f.context, snapshot: f.snapshot });
  try {
    expect(() =>
      service.start({
        identity,
        context: f.context,
        snapshot: { ...f.snapshot, headSha: 'b'.repeat(40) },
      }),
    ).toThrow('older revision');
  } finally {
    finish({ stops: [stop()] });
  }
  await vi.waitFor(() => expect(service.status(identity).run).toBeNull(), {
    timeout: 15_000,
  });
  expect(
    service.start({ identity, context: f.context, snapshot: f.snapshot }).guide
      ?.headSha,
  ).toBe(f.snapshot.headSha);
  expect(service.status(identity).run).toBeNull();
  expect(generate).toHaveBeenCalledTimes(1);
  service.start(
    { identity, context: f.context, snapshot: f.snapshot },
    () => true,
    true,
  );
  await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2), {
    timeout: 15_000,
  });
  await vi.waitFor(() => expect(service.status(identity).run).toBeNull(), {
    timeout: 15_000,
  });
});

test('refuses an oversized pretty-printed document before publishing either document or latest pointer', () => {
  const store = new PullRequestReviewGuideStore(makeTempDir('guide-size-'));
  const guide = {
    headSha: 'a'.repeat(40),
    generatedAt: new Date().toISOString(),
    modelSelection: 'model',
    stops: Array.from({ length: 8 }, () => ({
      ...stop(),
      files: Array.from({ length: 500 }, () => ({ path: 'a.ts', note: '' })),
    })),
  };
  expect(Buffer.byteLength(JSON.stringify(guide))).toBeLessThan(128 * 1024);
  expect(
    Buffer.byteLength(JSON.stringify({ version: 1, guide }, null, 2)),
  ).toBeGreaterThan(256 * 1024);
  expect(() => store.write(identity, guide)).toThrow('serialized guide');
  expect(store.read(identity, guide.headSha)).toBeNull();
  expect(store.latest(identity)).toBeNull();
});

test('reads non-ASCII blobs despite global diff formatting and never runs a global checkout smudge filter', async () => {
  const f = await guideFixture(makeTempDir, 'café.ts', true);
  const marker = join(f.root, 'smudge-ran');
  const script = join(f.root, 'smudge.sh');
  const global = join(makeTempDir('guide-global-config-'), 'gitconfig');
  await writeFile(script, `echo ran > '${marker}'\ncat\n`);
  await writeFile(
    global,
    `[core]\n quotePath = true\n[diff]\n noprefix = true\n external = sh ${script}\n[color]\n ui = always\n[filter "probe"]\n smudge = sh ${script}\n`,
  );
  vi.stubEnv('GIT_CONFIG_GLOBAL', global);
  try {
    expect(await f.git('config', '--get', 'filter.probe.smudge')).toContain(
      script,
    );
    const s = stop();
    s.excerpts[0]!.path = 'café.ts';
    const service = new PullRequestReviewGuideService(
      f.store,
      () => ({ enabled: true, model: 'model', instructions: '' }),
      async (prompt) => {
        expect(prompt).toContain('+++ b/café.ts');
        return { stops: [s] };
      },
      () => {},
    );
    service.start({ identity, context: f.context, snapshot: f.snapshot });
    await vi.waitFor(() => expect(service.status(identity).run).toBeNull(), {
      timeout: 15_000,
    });
    expect(
      f.store.read(identity, f.snapshot.headSha)?.stops[0]?.excerpts[0]?.path,
    ).toBe('café.ts');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    await f.git('cat-file', '--filters', `${f.snapshot.headSha}:café.ts`);
    expect(await readFile(marker, 'utf8')).toBe('ran\n');
  } finally {
    vi.unstubAllEnvs();
  }
});

test('missing local commits and oversized diffs produce different actionable failure details', async () => {
  const f = await guideFixture(makeTempDir);
  const generate = vi.fn();
  const service = new PullRequestReviewGuideService(
    f.store,
    () => ({ enabled: true, model: 'model', instructions: '' }),
    generate,
    () => {},
  );
  service.start({
    identity,
    context: f.context,
    snapshot: { ...f.snapshot, headSha: 'b'.repeat(40) },
  });
  await vi.waitFor(() =>
    expect(service.status(identity).run).toMatchObject({
      state: 'Failed',
      detail: expect.stringContaining('missing locally'),
    }),
  );
  service.start({
    identity,
    context: f.context,
    snapshot: {
      ...f.snapshot,
      diff: { state: 'unavailable', reason: 'large' },
    },
  });
  await vi.waitFor(() =>
    expect(service.status(identity).run).toMatchObject({
      state: 'Failed',
      detail: expect.stringContaining('diff'),
    }),
  );
  expect(generate).not.toHaveBeenCalled();
});

test('a 36-line excerpt is refused with its exact fixed failure and no partial guide is published', async () => {
  const f = await guideFixture(makeTempDir);
  const overlong = stop();
  overlong.excerpts[0]!.end = 36;
  const longPatch =
    'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,36 @@\n' +
    Array.from({ length: 36 }, (_, n) => `+line ${n + 1}\n`).join('');
  expect(() =>
    normalizeReviewGuide(
      { stops: [overlong] },
      readGuideChange(['a.ts'], longPatch),
    ),
  ).toThrow('exceeding 25 lines');
  const service = new PullRequestReviewGuideService(
    f.store,
    () => ({ enabled: true, model: 'model', instructions: '' }),
    async (prompt) => {
      expect(prompt).toContain('end - start + 1 <= 25');
      return { stops: [overlong] };
    },
    () => {},
  );
  service.start({ identity, context: f.context, snapshot: f.snapshot });
  await vi.waitFor(
    () =>
      expect(service.status(identity).run).toMatchObject({
        state: 'Failed',
        detail:
          'The model returned an excerpt exceeding 25 lines. Rewrite the guide using shorter excerpts.',
      }),
    { timeout: 15000 },
  );
  expect(f.store.latest(identity)).toBeNull();
});

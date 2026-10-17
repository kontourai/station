import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { buildGalleryReviewEvidence } from '../gallery-review-evidence.mjs';
import { runBaseline } from '../screenshot-diff.mjs';

const makeTempDir = trackTempDirs();
function fixture() {
  const root = makeTempDir('gallery-review-');
  const gallery = join(root, 'gallery');
  mkdirSync(gallery);
  const png = new PNG({ width: 2, height: 2 });
  png.data.fill(255);
  const image = PNG.sync.write(png);
  writeFileSync(join(gallery, 'home.png'), image);
  const screen = {
    name: 'home',
    file: 'home.png',
    ok: true,
    controls: [{ label: 'Start', disabled: false }],
  };
  const capture = { selection: null, screens: [screen] };
  const save = () =>
    writeFileSync(join(gallery, 'capture.json'), JSON.stringify(capture));
  save();
  const baseline = join(root, 'baseline.json');
  runBaseline({ gallery, baseline }, { log: () => {} });
  png.data[0] = 0;
  writeFileSync(join(gallery, 'home.png'), PNG.sync.write(png));
  const context = {
    sourceSha: 'a'.repeat(40),
    runUrl: 'https://example.test/run/1',
    renderer: 'pinned-container@sha256:123',
    captureContract: 'c'.repeat(64),
  };
  const read = (previous?: unknown) =>
    buildGalleryReviewEvidence({ gallery, baseline, context, previous });
  return { gallery, baseline, context, capture, save, read };
}

it('links identical reviewed pixels across heads while preserving the new failing verdict', () => {
  const f = fixture();
  const prior = {
    ...f.read(),
    review: {
      owner: 'visual-owner',
      disposition: 'known change; cause unknown',
      evidenceUrl: 'https://example.test/review/1',
    },
  };
  f.context.sourceSha = 'b'.repeat(40);
  f.context.runUrl = 'https://example.test/run/2';
  const current = f.read(prior);
  expect(current.linkedReview).toEqual(prior.review);
  expect(current.comparator.exitCode).toBe(1);
  expect(current.sourceSha).toBe('b'.repeat(40));
  expect(f.read().linkedReview).toBeNull();
});

it('reopens review for changed controls, renderer, contract, baseline, and pixels', () => {
  const f = fixture();
  const prior = {
    ...f.read(),
    review: {
      owner: 'owner',
      disposition: 'reviewed',
      evidenceUrl: 'https://example.test/review',
    },
  };
  f.capture.screens[0].controls[0].label = 'Attach';
  f.save();
  expect(f.read(prior).linkedReview).toBeNull();
  f.capture.screens[0].controls[0].label = 'Start';
  f.save();
  f.context.renderer = 'different-renderer';
  expect(f.read(prior).linkedReview).toBeNull();
  f.context.renderer = 'pinned-container@sha256:123';
  f.context.captureContract = 'd'.repeat(64);
  expect(f.read(prior).linkedReview).toBeNull();
  f.context.captureContract = 'c'.repeat(64);
  const originalBaseline = readFileSync(f.baseline, 'utf8');
  const reference = JSON.parse(originalBaseline);
  reference.screens[0].width = 3;
  writeFileSync(f.baseline, JSON.stringify(reference));
  expect(f.read(prior).linkedReview).toBeNull();
  writeFileSync(f.baseline, originalBaseline);
  expect(f.read(prior).linkedReview).toEqual(prior.review);
  const png = new PNG({ width: 2, height: 2 });
  png.data.fill(100);
  writeFileSync(join(f.gallery, 'home.png'), PNG.sync.write(png));
  expect(f.read(prior).linkedReview).toBeNull();
});

it('rejects claimed digests and paths that do not match actual artifact bytes', () => {
  const f = fixture();
  Object.assign(f.capture.screens[0], {
    sha256: createHash('sha256').update('wrong').digest('hex'),
  });
  f.save();
  expect(() => f.read()).toThrow('digest mismatch');
  delete (f.capture.screens[0] as { sha256?: string }).sha256;
  writeFileSync(
    join(f.gallery, '../outside.png'),
    readFileSync(join(f.gallery, 'home.png')),
  );
  f.capture.screens[0].file = '../outside.png';
  f.save();
  expect(() => f.read()).toThrow('capture image escapes gallery');
});

it('never links a repeated failed or incomplete capture to a prior review', () => {
  const f = fixture();
  f.capture.screens[0].ok = false;
  f.save();
  const failed = {
    ...f.read(),
    review: {
      owner: 'owner',
      disposition: 'known capture failure',
      evidenceUrl: 'https://example.test/review',
    },
  };
  expect(f.read(failed).linkedReview).toBeNull();
  expect(f.read(failed).comparator.exitCode).toBe(1);
  f.capture.screens = [];
  f.save();
  const missing = { ...f.read(), review: failed.review };
  expect(f.read(missing).linkedReview).toBeNull();
  expect(f.read(missing).comparator.exitCode).toBe(1);
});

it('requires a prior owner disposition and preserves new baseline coverage as a distinct status', () => {
  const f = fixture();
  const prior = f.read();
  expect(f.read(prior).linkedReview).toBeNull();
  const png = readFileSync(join(f.gallery, 'home.png'));
  writeFileSync(join(f.gallery, 'new.png'), png);
  f.capture.screens.push({
    name: 'new',
    file: 'new.png',
    ok: true,
    controls: [],
  });
  f.save();
  const current = f.read(prior);
  expect(current.comparator.rows).toContainEqual({
    name: 'new',
    status: 'new',
  });
  expect(current.linkedReview).toBeNull();
});

it('validates auxiliary bytes and refuses existing outside auxiliary files', () => {
  const f = fixture();
  const bytes = readFileSync(join(f.gallery, 'home.png'));
  writeFileSync(join(f.gallery, 'aux.png'), bytes);
  const diagnostic = {
    file: 'aux.png',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  Object.assign(f.capture.screens[0], { rasterDiagnostic: diagnostic });
  f.save();
  const prior = {
    ...f.read(),
    review: {
      owner: 'owner',
      disposition: 'reviewed',
      evidenceUrl: 'https://example.test/review',
    },
  };
  expect(f.read(prior).linkedReview).toEqual(prior.review);
  const changed = new PNG({ width: 2, height: 2 });
  changed.data.fill(80);
  const different = PNG.sync.write(changed);
  writeFileSync(join(f.gallery, 'aux.png'), different);
  expect(() => f.read(prior)).toThrow('auxiliary PNG digest mismatch');
  diagnostic.sha256 = createHash('sha256').update(different).digest('hex');
  f.save();
  expect(f.read(prior).linkedReview).toBeNull();
  writeFileSync(join(f.gallery, '../outside.png'), different);
  diagnostic.file = '../outside.png';
  f.save();
  expect(() => f.read(prior)).toThrow('auxiliary image escapes gallery');
});

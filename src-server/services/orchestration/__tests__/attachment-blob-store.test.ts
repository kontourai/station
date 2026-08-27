import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  AttachmentBlobStore,
  isAttachmentBlobRef,
} from '../attachment-blob-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function base64Of(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function blobFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((shard) =>
      readdirSync(join(root, shard.name)).map((name) =>
        join(root, shard.name, name),
      ),
    );
}

describe('AttachmentBlobStore', () => {
  let dir: string;
  let root: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'attachment-blobs-'));
    root = join(dir, 'attachments');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('round-trips bytes through a digest-derived reference', () => {
    const store = new AttachmentBlobStore({ rootDir: root });
    const base64 = base64Of('a pasted screenshot');

    const ref = store.write(base64);

    expect(ref).toBe(
      `sha256-${createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex')}`,
    );
    expect(store.read(ref!)).toBe(base64);
  });

  test('stores identical bytes once, however many turns carry them', () => {
    const store = new AttachmentBlobStore({ rootDir: root });
    const base64 = base64Of('the same screenshot, pasted twice');

    const first = store.write(base64);
    const second = store.write(base64);

    expect(second).toBe(first);
    expect(blobFiles(root)).toHaveLength(1);
  });

  test('refuses a reference that is not a digest, without touching the filesystem', () => {
    const store = new AttachmentBlobStore({ rootDir: root });
    mkdirSync(join(root, '..'), { recursive: true });
    writeFileSync(join(dir, 'secret'), 'not an attachment');

    expect(store.read('../secret')).toBeUndefined();
    expect(store.read('sha256-../../secret')).toBeUndefined();
    expect(store.read('sha256-NOTHEX')).toBeUndefined();
    expect(isAttachmentBlobRef('sha256-../../secret')).toBe(false);
    expect(isAttachmentBlobRef(`sha256-${'a'.repeat(64)}`)).toBe(true);
  });

  test('refuses bytes whose digest does not match the reference they were fetched by', () => {
    const store = new AttachmentBlobStore({ rootDir: root });
    const ref = store.write(base64Of('original bytes'))!;
    const [path] = blobFiles(root);

    writeFileSync(path, Buffer.from('substituted bytes', 'utf8'));

    expect(store.read(ref)).toBeUndefined();
  });

  test('reports a missing blob rather than inventing bytes for it', () => {
    const store = new AttachmentBlobStore({ rootDir: root });
    const ref = store.write(base64Of('will be reclaimed'))!;

    rmSync(blobFiles(root)[0]);

    expect(store.read(ref)).toBeUndefined();
  });

  test('retention reclaims blobs older than the age ceiling and keeps the rest', () => {
    const now = Date.parse('2026-08-19T00:00:00.000Z');
    const store = new AttachmentBlobStore({
      rootDir: root,
      retention: { maxAgeDays: 30, maxBytes: 1024 * 1024 },
      now: () => now,
    });
    const oldRef = store.write(base64Of('an old attachment'))!;
    const freshRef = store.write(base64Of('a fresh attachment'))!;
    const oldPath = blobFiles(root).find((path) =>
      oldRef.endsWith(path.split('/').pop()!),
    )!;
    const aged = new Date(now - 45 * DAY_MS);
    utimesSync(oldPath, aged, aged);

    store.applyRetention({ force: true });

    expect(store.read(oldRef)).toBeUndefined();
    expect(store.read(freshRef)).toBeDefined();
  });

  test('retention reclaims oldest-first once the store exceeds its byte ceiling', () => {
    const now = Date.parse('2026-08-19T00:00:00.000Z');
    const store = new AttachmentBlobStore({
      rootDir: root,
      retention: { maxAgeDays: 3650, maxBytes: 250 },
      now: () => now,
    });
    const refs = ['oldest', 'middle', 'newest'].map(
      (label) => store.write(base64Of(label.padEnd(200, '.')))!,
    );
    for (const [index, ref] of refs.entries()) {
      const digest = ref.slice('sha256-'.length);
      const when = new Date(now - (refs.length - index) * DAY_MS);
      utimesSync(join(root, digest.slice(0, 2), digest), when, when);
    }

    store.applyRetention({ force: true });

    // Three 200-byte blobs under a 250-byte ceiling: the two oldest go and
    // the newest stays. A sweep that reclaimed everything, or nothing, would
    // also satisfy a "did it shrink" assertion, so name the survivor.
    expect(store.read(refs[0])).toBeUndefined();
    expect(store.read(refs[1])).toBeUndefined();
    expect(store.read(refs[2])).toBeDefined();
  });

  test('a dedup hit re-dates the blob, so re-attaching an old image keeps it (#3374 fix round)', () => {
    let clock = Date.parse('2026-08-19T00:00:00.000Z');
    const store = new AttachmentBlobStore({
      rootDir: root,
      retention: { maxAgeDays: 30, maxBytes: 1024 * 1024 },
      now: () => clock,
    });
    const base64 = base64Of('an image attached long ago, and again today');
    const ref = store.write(base64)!;
    const [path] = blobFiles(root);
    const longAgo = new Date(clock - 45 * DAY_MS);
    utimesSync(path, longAgo, longAgo);

    // Re-attaching the same image is a dedup hit — nothing is written, so
    // only a deliberate re-dating can save it from the 30-day sweep.
    expect(store.write(base64)).toBe(ref);
    clock += 1;
    store.applyRetention({ force: true });

    expect(store.read(ref)).toBe(base64);
  });

  test('serving a blob re-dates it, so an open transcript keeps its images', () => {
    let clock = Date.parse('2026-08-19T00:00:00.000Z');
    const store = new AttachmentBlobStore({
      rootDir: root,
      retention: { maxAgeDays: 30, maxBytes: 1024 * 1024 },
      now: () => clock,
    });
    const ref = store.write(base64Of('an image someone is looking at'))!;
    const [path] = blobFiles(root);
    const longAgo = new Date(clock - 45 * DAY_MS);
    utimesSync(path, longAgo, longAgo);

    expect(store.read(ref)).toBeDefined();
    clock += 1;
    store.applyRetention({ force: true });

    expect(store.read(ref)).toBeDefined();
  });

  test('never returns a reference its own sweep just reclaimed', () => {
    // A byte ceiling smaller than the blob: sweeping after the write would
    // reclaim it and hand back a reference to nothing.
    const store = new AttachmentBlobStore({
      rootDir: root,
      retention: { maxAgeDays: 3650, maxBytes: 1 },
      now: () => Date.parse('2026-08-19T00:00:00.000Z'),
    });

    const ref = store.write(
      base64Of('larger than the ceiling'.padEnd(200, '.')),
    )!;

    expect(ref).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(store.read(ref)).toBeDefined();
  });

  test('a write that cannot reach the disk reports failure instead of losing the bytes silently', () => {
    // A file where the shard directory must go: mkdir fails, so the store
    // must say so rather than return a reference to nothing.
    const store = new AttachmentBlobStore({ rootDir: root });
    const base64 = base64Of('unwritable');
    const digest = createHash('sha256')
      .update(Buffer.from(base64, 'base64'))
      .digest('hex');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, digest.slice(0, 2)), 'occupied');

    expect(store.write(base64)).toBeUndefined();
    expect(statSync(join(root, digest.slice(0, 2))).isFile()).toBe(true);
  });
});

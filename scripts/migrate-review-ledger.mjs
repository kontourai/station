#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
// Convert the single-file review ledger to the per-record layout (#2936).
//
//   node scripts/migrate-review-ledger.mjs
//   node scripts/migrate-review-ledger.mjs --base <ref>
//
// Reads docs/learn/review-ledger.json (and review fields left in
// docs/learn/media.json) from the working tree, writes docs/learn/review-ledger/
// and removes them.
//
// A branch that recorded reviews in the old file conflicts with the migration
// when it merges main (the old file is modified on one side and deleted on the
// other). Resolve that conflict by keeping the branch's old file
// (`git checkout --ours -- docs/learn/review-ledger.json` when merging main
// into the branch, `--theirs` when the branch is the side being merged in),
// then run this command with `--base` set to the merge base. Each record the branch changed since the base is folded into
// the per-record files: changed bindings and source edits are applied, and
// appended checks become one new notes file. Where both sides rebound one
// binding differently, the binding whose hash matches the current bytes
// wins; if neither does, the record stays stale for the freshness check.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLearningSourceReader } from './lib/learning-source-reader.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { bindingDigest, bindingFile } from './lib/review-binding.mjs';
import {
  captureReviewFile,
  LEARNING_MEDIA_MANIFEST,
  LEGACY_REVIEW_LEDGER,
  notesFileName,
  REVIEW_LEDGER_INDEX,
  readGitObjects,
  readReviewFiles,
  recordFile,
  serializeCaptureReviewFile,
  serializeLedgerIndex,
  serializeNotesFile,
  serializeRecordFile,
} from './lib/review-ledger-store.mjs';

const USAGE = 'Usage: migrate-review-ledger.mjs [--base <ref>]';
const REVIEW_FIELDS = ['sources', 'reviewedRevision', 'reviewNotes'];
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** The media.json serialization, with non-ASCII kept as \u escapes. */
function serializeLearningMedia(manifest) {
  return `${JSON.stringify(manifest, null, 2).replace(
    /[\u007f-￿]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )}\n`;
}

/** A legacy record or capture as per-record file data, bindings keyed by path. */
function recordData(legacy) {
  return {
    path: legacy.path,
    kind: legacy.kind,
    state: legacy.state,
    summary: legacy.summary,
    limits: legacy.limits,
    document: {
      digest: legacy.documentDigest,
      revision: legacy.sourceRevision,
    },
    sources: legacy.sources.map(({ path: file, digest }) => ({
      path: file,
      digest,
      revision: legacy.sourceRevision,
    })),
    checks: legacy.checks,
  };
}

function captureData(legacy) {
  return {
    path: legacy.path,
    sources: (legacy.sources ?? []).map(({ path: file, digest }) => ({
      path: file,
      digest,
      revision: legacy.reviewedRevision,
    })),
    reviewNotes: legacy.reviewNotes ?? [],
  };
}

/**
 * Fold the branch's change to one entry (base -> theirs) into ours.
 * @param {any} base per-record data at the merge base, or undefined
 * @param {any} ours current per-record data, or undefined
 * @param {any} theirs the branch's per-record data, or undefined
 * @param {(binding: { path: string, digest: string }) => boolean} current
 * @param {string[]} fields scalar fields to merge
 * @param {string} notesKey legacy notes array (checks or reviewNotes)
 */
function foldEntry(base, ours, theirs, current, fields, notesKey) {
  const report = { stale: false, notes: [] };
  // The branch left this entry alone: keep ours.
  if (same(base, theirs)) return { data: ours, ...report };
  // The branch deleted it: delete unless ours changed it since.
  if (!theirs)
    return { data: base && same(base, ours) ? undefined : ours, ...report };
  // The branch added it: take it, unless ours added a different one.
  if (!base)
    return ours && !same(ours, theirs)
      ? { data: ours, stale: true, notes: [] }
      : { data: theirs, ...report };
  // Ours deleted what the branch changed: restore the branch's version.
  if (!ours) return { data: theirs, ...report };
  const data = { ...ours };
  for (const field of fields)
    if (!same(base[field], theirs[field]) && same(base[field], ours[field]))
      data[field] = theirs[field];
  const keyed = (list) =>
    new Map((list ?? []).map((item) => [item.path, item]));
  const merge = (baseBinding, ourBinding, theirBinding) => {
    // The old layout rebound every source of a refreshed record to the new
    // revision; a revision-only change is not a new review of those bytes.
    if (theirBinding.digest === baseBinding?.digest) return ourBinding;
    if (same(baseBinding, ourBinding) || !ourBinding) return theirBinding;
    if (same(ourBinding, theirBinding)) return ourBinding;
    if (current(ourBinding)) return ourBinding;
    if (current(theirBinding)) return theirBinding;
    report.stale = true;
    return ourBinding;
  };
  if (base.document)
    data.document = merge(
      { path: base.path, ...base.document },
      { path: ours.path, ...ours.document },
      { path: theirs.path, ...theirs.document },
    );
  if (data.document) {
    const { digest, revision } = data.document;
    data.document = { digest, revision };
  }
  const [b, o, t] = [base, ours, theirs].map((entry) => keyed(entry.sources));
  const sources = [];
  for (const [file, ourBinding] of o) {
    if (b.has(file) && !t.has(file) && same(b.get(file), ourBinding)) continue;
    sources.push(
      t.has(file) ? merge(b.get(file), ourBinding, t.get(file)) : ourBinding,
    );
  }
  for (const [file, theirBinding] of t)
    if (!o.has(file) && !b.has(file)) sources.push(theirBinding);
  data.sources = sources;
  // The branch may also have edited earlier notes in place, such as a
  // redaction. Carry each edit where ours still has the base text; anything
  // else would silently drop or overwrite a note, so report it instead.
  const [baseNotes, ourNotes, theirNotes] = [base, data, theirs].map(
    (entry) => entry[notesKey] ?? [],
  );
  if (theirNotes.length < baseNotes.length) report.edited = true;
  else {
    const carried = [...ourNotes];
    baseNotes.forEach((note, index) => {
      if (theirNotes[index] === note) return;
      if (carried[index] === note) carried[index] = theirNotes[index];
      else if (carried[index] !== theirNotes[index]) report.edited = true;
    });
    data[notesKey] = carried;
  }
  report.notes = theirNotes.slice(baseNotes.length);
  return { data, ...report };
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** The index stages (1 base, 2 ours, 3 theirs) of an unmerged file. */
function unmergedStages(root, file) {
  return new Set(
    git(root, ['ls-files', '-u', '--', file])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[2]),
  );
}

/**
 * During the merge, media.json conflicts where one side removed the capture
 * review fields and the other edited them. Keep the side that still has the
 * old ledger for each conflicting hunk, and every clean hunk of the other
 * side; the review fields then move out below. Returns whether it resolved.
 */
function resolveConflictedManifest(root) {
  const media = unmergedStages(root, LEARNING_MEDIA_MANIFEST);
  if (media.size === 0) return false;
  const ledger = unmergedStages(root, LEGACY_REVIEW_LEDGER);
  const side =
    ledger.has('2') && !ledger.has('3')
      ? 'ours'
      : ledger.has('3') && !ledger.has('2')
        ? 'theirs'
        : undefined;
  if (side === undefined || !['1', '2', '3'].every((stage) => media.has(stage)))
    throw new Error(
      `${LEARNING_MEDIA_MANIFEST} conflicts outside the layout change; resolve it and rerun`,
    );
  const blobs = readGitObjects(
    root,
    ['2', '1', '3'].map((stage) => `:${stage}:${LEARNING_MEDIA_MANIFEST}`),
  );
  const dir = mkdtempSync(path.join(tmpdir(), 'review-ledger-fold-'));
  try {
    const files = blobs.map((bytes, index) => {
      const file = path.join(dir, String(index));
      writeFileSync(file, bytes);
      return file;
    });
    const merged = spawnSync(
      'git',
      ['merge-file', '-p', `--${side}`, ...files],
      { cwd: root, windowsHide: true, maxBuffer: 256 * 1024 * 1024 },
    );
    if (merged.status !== 0)
      throw new Error(
        `git merge-file could not resolve ${LEARNING_MEDIA_MANIFEST}: ${merged.stderr}`,
      );
    writeFileSync(path.join(root, LEARNING_MEDIA_MANIFEST), merged.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return true;
}

function legacyAt(root, ref) {
  const [ledger, media] = readGitObjects(root, [
    `${ref}:${LEGACY_REVIEW_LEDGER}`,
    `${ref}:${LEARNING_MEDIA_MANIFEST}`,
  ]);
  if (ledger === undefined)
    throw new Error(`${ref} has no ${LEGACY_REVIEW_LEDGER} to merge from`);
  return {
    ledger: JSON.parse(ledger.toString('utf8')),
    media: media === undefined ? undefined : JSON.parse(media.toString('utf8')),
  };
}

/**
 * @param {{ root?: string, base?: string, now?: Date }} [input]
 */
function migrateReviewLedger({
  root = process.cwd(),
  base,
  now = new Date(),
} = {}) {
  const resolvedManifest = resolveConflictedManifest(root);
  const reader = createLearningSourceReader(root);
  if (!reader.exists(LEGACY_REVIEW_LEDGER))
    throw new Error(`No ${LEGACY_REVIEW_LEDGER} to migrate`);
  const theirs = JSON.parse(reader.read(LEGACY_REVIEW_LEDGER).toString('utf8'));
  if (theirs?.version !== 1 || !Array.isArray(theirs.records))
    throw new Error(`${LEGACY_REVIEW_LEDGER} requires version 1 records`);
  const manifest = reader.exists(LEARNING_MEDIA_MANIFEST)
    ? JSON.parse(reader.read(LEARNING_MEDIA_MANIFEST).toString('utf8'))
    : undefined;
  const legacyCaptures = (manifest?.captures ?? []).filter((capture) =>
    REVIEW_FIELDS.some((field) => Object.hasOwn(capture, field)),
  );
  const hasLayout = reader.exists(REVIEW_LEDGER_INDEX);
  if (hasLayout && base === undefined)
    throw new Error(
      `${REVIEW_LEDGER_INDEX} already exists; pass --base <merge base> to fold ${LEGACY_REVIEW_LEDGER} into it`,
    );
  // The manifest this command writes: review fields move out of it, so a
  // binding to it is current only against these bytes, not the working tree's.
  const strippedManifest = legacyCaptures.length
    ? serializeLearningMedia({
        ...manifest,
        captures: manifest.captures.map((capture) =>
          Object.fromEntries(
            Object.entries(capture).filter(
              ([key]) => !REVIEW_FIELDS.includes(key),
            ),
          ),
        ),
      })
    : undefined;
  const files = new Map();
  const current = ({ path: file, digest }) => {
    const source = bindingFile(file);
    if (source === LEARNING_MEDIA_MANIFEST && strippedManifest !== undefined)
      return bindingDigest(file, Buffer.from(strippedManifest)) === digest;
    return (
      reader.exists(source) &&
      bindingDigest(file, reader.read(source)) === digest
    );
  };
  const notes = [];
  const stale = [];
  const edited = [];
  if (!hasLayout) {
    files.set(
      REVIEW_LEDGER_INDEX,
      serializeLedgerIndex({ coverageBaseline: theirs.coverageBaseline }),
    );
    for (const record of theirs.records)
      files.set(
        recordFile(record.path),
        serializeRecordFile(recordData(record)),
      );
    for (const capture of legacyCaptures)
      files.set(
        captureReviewFile(capture.path),
        serializeCaptureReviewFile(captureData(capture)),
      );
  } else {
    const { parsed } = readReviewFiles(root);
    const before = legacyAt(root, base);
    if (
      theirs.coverageBaseline !== before.ledger.coverageBaseline &&
      parsed.index.coverageBaseline === (before.ledger.coverageBaseline ?? null)
    )
      files.set(
        REVIEW_LEDGER_INDEX,
        serializeLedgerIndex({ coverageBaseline: theirs.coverageBaseline }),
      );
    const baseRecords = new Map(
      before.ledger.records.map((record) => [record.path, recordData(record)]),
    );
    const theirRecords = new Map(
      theirs.records.map((record) => [record.path, recordData(record)]),
    );
    for (const file of new Set([
      ...baseRecords.keys(),
      ...theirRecords.keys(),
    ])) {
      const folded = foldEntry(
        baseRecords.get(file),
        parsed.records.get(file)?.data,
        theirRecords.get(file),
        current,
        ['kind', 'state', 'summary', 'limits'],
        'checks',
      );
      if (folded.stale) stale.push(file);
      if (folded.edited) edited.push(file);
      for (const note of folded.notes)
        notes.push({
          path: file,
          note,
          revision: theirs.records.find((record) => record.path === file)
            ?.sourceRevision,
        });
      if (folded.data === undefined) files.set(recordFile(file), undefined);
      else if (!same(folded.data, parsed.records.get(file)?.data))
        files.set(recordFile(file), serializeRecordFile(folded.data));
    }
    const baseCaptures = new Map(
      (before.media?.captures ?? [])
        .filter((capture) => Object.hasOwn(capture, 'reviewedRevision'))
        .map((capture) => [capture.path, captureData(capture)]),
    );
    for (const capture of legacyCaptures) {
      const folded = foldEntry(
        baseCaptures.get(capture.path),
        parsed.captures.get(capture.path)?.data,
        captureData(capture),
        current,
        [],
        'reviewNotes',
      );
      if (folded.stale) stale.push(capture.path);
      if (folded.edited) edited.push(capture.path);
      for (const note of folded.notes)
        notes.push({
          path: capture.path,
          note,
          revision: capture.reviewedRevision,
        });
      if (!same(folded.data, parsed.captures.get(capture.path)?.data))
        files.set(
          captureReviewFile(capture.path),
          serializeCaptureReviewFile(folded.data),
        );
    }
    // One notes file per revision the branch recorded its notes at.
    const head = git(root, ['rev-parse', 'HEAD']).trim();
    const byRevision = new Map();
    for (const { revision, ...note } of notes) {
      const key = /^[a-f0-9]{40}$/.test(revision ?? '') ? revision : head;
      byRevision.set(key, [...(byRevision.get(key) ?? []), note]);
    }
    for (const [revision, entries] of byRevision) {
      const text = serializeNotesFile({ revision, notes: entries });
      files.set(notesFileName(text, now), text);
    }
  }
  for (const [file, text] of files) {
    const target = path.join(root, file);
    if (text === undefined) rmSync(target, { force: true });
    else {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  }
  if (strippedManifest !== undefined)
    writeFileSync(path.join(root, LEARNING_MEDIA_MANIFEST), strippedManifest);
  rmSync(path.join(root, LEGACY_REVIEW_LEDGER));
  return {
    resolvedManifest,
    written: [...files.keys()].filter((file) => files.get(file) !== undefined),
    removed: [...files.keys()].filter((file) => files.get(file) === undefined),
    notes: notes.length,
    stale,
    edited,
  };
}

export function main(argv = process.argv.slice(2)) {
  let base;
  for (let index = 0; index < argv.length; index += 1) {
    if (
      argv[index] === '--base' &&
      argv[index + 1] &&
      !argv[index + 1].startsWith('-')
    )
      base = argv[++index];
    else throw new Error(USAGE);
  }
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const result = migrateReviewLedger({ root, base });
  console.log(
    `Migrated ${LEGACY_REVIEW_LEDGER}: wrote ${result.written.length} file(s), removed ${result.removed.length}, ${result.notes} note(s) from appended checks.`,
  );
  if (result.resolvedManifest)
    console.log(
      `Resolved the ${LEARNING_MEDIA_MANIFEST} conflict: kept the old-layout side's review fields, moved them into the ledger, and kept the other side's remaining edits.`,
    );
  if (result.edited.length)
    console.log(
      `Both sides edited or removed earlier notes of these; ours were kept, so compare them with the branch's old file and apply its edits by hand: ${result.edited.join(', ')}`,
    );
  if (result.stale.length)
    console.log(
      `Both sides rebound these differently and neither matches the current bytes; review and record them: ${result.stale.join(', ')}`,
    );
}

if (invokedDirectly(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `migrate-review-ledger: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

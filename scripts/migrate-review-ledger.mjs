#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
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
// (`git checkout --theirs -- docs/learn/review-ledger.json` when merging main
// into the branch, `--ours` when the branch is checked out and main merges
// in the other direction), then run this command with `--base` set to the
// merge base. Each record the branch changed since the base is folded into
// the per-record files: changed bindings and source edits are applied, and
// appended checks become one new notes file. Where both sides rebound one
// binding differently, the binding whose hash matches the current bytes
// wins; if neither does, the record stays stale for the freshness check.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  report.notes = theirs[notesKey].slice(base[notesKey].length);
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
  const files = new Map();
  const current = ({ path: file, digest }) => {
    const source = bindingFile(file);
    return (
      reader.exists(source) &&
      bindingDigest(file, reader.read(source)) === digest
    );
  };
  const notes = [];
  const stale = [];
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
      for (const note of folded.notes) notes.push({ path: file, note });
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
      for (const note of folded.notes) notes.push({ path: capture.path, note });
      if (!same(folded.data, parsed.captures.get(capture.path)?.data))
        files.set(
          captureReviewFile(capture.path),
          serializeCaptureReviewFile(folded.data),
        );
    }
    if (notes.length) {
      const text = serializeNotesFile({
        revision: git(root, ['rev-parse', 'HEAD']).trim(),
        notes,
      });
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
  if (legacyCaptures.length)
    writeFileSync(
      path.join(root, LEARNING_MEDIA_MANIFEST),
      serializeLearningMedia({
        ...manifest,
        captures: manifest.captures.map((capture) =>
          Object.fromEntries(
            Object.entries(capture).filter(
              ([key]) => !REVIEW_FIELDS.includes(key),
            ),
          ),
        ),
      }),
    );
  rmSync(path.join(root, LEGACY_REVIEW_LEDGER));
  return {
    written: [...files.keys()].filter((file) => files.get(file) !== undefined),
    removed: [...files.keys()].filter((file) => files.get(file) === undefined),
    notes: notes.length,
    stale,
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

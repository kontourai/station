#!/usr/bin/env node
// Record a completed documentation review without hand-editing digests (#2924).
//
//   npm run docs:review:record -- <path> --note "<what you checked>" [--drop-source <path>]... [--add-source <path>]...
//   npm run docs:review:record -- --batch <file.json>
//
// <path> names an existing review-ledger record (a document) or a
// docs/learn/media.json capture. Batch input is a JSON array of
// `{ path, note, removedSources?, addedSources? }`. The command binds the review to the full
// HEAD commit, recomputes the recorded digests from current bytes, appends the
// note, and writes nothing unless every entry validates. It records a review
// that a person performed; it does not decide whether the prose is accurate.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createRepositorySnapshot,
  REVIEW_LEDGER,
} from './lib/documentation-freshness.mjs';
import { evaluateDocumentationReview } from './lib/documentation-review.mjs';
import {
  compileLearningMedia,
  LEARNING_MEDIA_MANIFEST,
} from './lib/learning-media.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const USAGE =
  'Usage: docs:review:record -- <path> --note "<review note>" [--drop-source <path>]... [--add-source <path>]... | --batch <file.json>';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** The ledger is written by JSON.stringify(…, 2); keep that exact shape. */
export function serializeReviewLedger(ledger) {
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

/** media.json additionally keeps non-ASCII characters as \u escapes. */
export function serializeLearningMedia(manifest) {
  return `${JSON.stringify(manifest, null, 2).replace(
    /[\u007f-\uffff]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )}\n`;
}

export function parseRecordArguments(argv) {
  let batch;
  let note;
  const paths = [];
  const removedSources = [];
  const addedSources = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      // An option-shaped value is a forgotten argument, not a note or path.
      if (next === undefined || next.startsWith('--'))
        throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === '--batch') batch = value();
    else if (arg === '--note') note = value();
    else if (arg === '--drop-source') removedSources.push(value());
    else if (arg === '--add-source') addedSources.push(value());
    else if (arg.startsWith('-'))
      throw new Error(`Unknown option ${arg}\n${USAGE}`);
    else paths.push(arg);
  }
  if (batch !== undefined) {
    if (
      paths.length ||
      note !== undefined ||
      removedSources.length ||
      addedSources.length
    )
      throw new Error(
        `--batch cannot be combined with a path or note\n${USAGE}`,
      );
    return { batch };
  }
  if (paths.length !== 1) throw new Error(USAGE);
  return { entries: [{ path: paths[0], note, removedSources, addedSources }] };
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || !entries.length)
    throw new Error('Review batch must be a non-empty JSON array');
  const seen = new Set();
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Each review entry must be an object');
    const { path: file, note, removedSources = [], addedSources = [] } = entry;
    if (typeof file !== 'string' || !file)
      throw new Error('Review entry requires a path');
    if (seen.has(file)) throw new Error(`Duplicate review entry: ${file}`);
    seen.add(file);
    if (typeof note !== 'string' || !note.trim())
      throw new Error(`Review note is empty: ${file}`);
    for (const [name, list] of [
      ['removedSources', removedSources],
      ['addedSources', addedSources],
    ])
      if (
        !Array.isArray(list) ||
        list.some((source) => typeof source !== 'string' || !source)
      )
        throw new Error(`${name} must be an array of paths: ${file}`);
    return { path: file, note: note.trim(), removedSources, addedSources };
  });
}

function editSources(file, sources, removed, added) {
  for (const source of removed)
    if (!sources.some((entry) => entry.path === source))
      throw new Error(`Not a recorded source of ${file}: ${source}`);
  const kept = sources.filter((entry) => !removed.includes(entry.path));
  for (const source of added) {
    if (source === file || kept.some((entry) => entry.path === source))
      throw new Error(`Already a recorded source of ${file}: ${source}`);
    kept.push({ path: source, digest: '' });
  }
  return kept;
}

function headRevision(root) {
  let revision;
  try {
    revision = git(root, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      'HEAD^{commit}',
    ]).trim();
  } catch (error) {
    throw new Error(
      `Cannot bind the review to HEAD: ${
        String(error?.stderr || error?.message)
          .trim()
          .split('\n')[0]
      }`,
    );
  }
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error(`HEAD is not a full commit SHA: ${revision}`);
  return revision;
}

/** Recompute an entry's source digests after applying its source edits. */
async function refreshSources(owner, entry, snapshot) {
  const sources = editSources(
    owner.path,
    owner.sources,
    entry.removedSources,
    entry.addedSources,
  );
  for (const source of sources) {
    if (!snapshot.tracked.has(source.path))
      throw new Error(
        `Recorded source is not tracked: ${owner.path} -> ${source.path}; git add it or pass --drop-source ${source.path}`,
      );
    source.digest = digest(await snapshot.read(source.path));
  }
  return sources;
}

async function refreshEntry(entry, { ledger, media, snapshot, revision }) {
  const record = ledger.records.find((item) => item.path === entry.path);
  if (record) {
    if (!snapshot.tracked.has(record.path))
      throw new Error(`Reviewed document is not tracked: ${record.path}`);
    record.documentDigest = digest(await snapshot.read(record.path));
    record.sourceRevision = revision;
    record.sources = await refreshSources(record, entry, snapshot);
    record.checks = [...record.checks, entry.note];
    return { kind: 'review', entry: record };
  }
  const capture = media?.captures?.find((item) => item.path === entry.path);
  if (!capture)
    throw new Error(
      `No review record or capture for ${entry.path}; add a new record by hand with its kind, summary and limits`,
    );
  if (capture.digest !== digest(await snapshot.read(capture.path)))
    throw new Error(
      `Capture bytes differ from the recorded digest: ${capture.path}; a new capture needs its digest, capturedRevision and evidence updated, not only a review`,
    );
  capture.sources = await refreshSources(capture, entry, snapshot);
  capture.reviewedRevision = revision;
  capture.reviewNotes = [...(capture.reviewNotes ?? []), entry.note];
  return { kind: 'capture', entry: capture };
}

/** Validate refreshed entries with the same compilers the gates use. */
async function assertRecordedFresh(recorded, media, snapshot) {
  const reviews = recorded.filter(({ kind }) => kind === 'review');
  const documents = new Map();
  for (const { entry } of reviews)
    documents.set(entry.path, digest(await snapshot.read(entry.path)));
  for (const { entry } of reviews)
    await evaluateDocumentationReview(
      entry,
      documents,
      snapshot.tracked,
      snapshot.read,
      { requireFresh: true },
    );
  const captures = new Set(
    recorded
      .filter(({ kind }) => kind === 'capture')
      .map(({ entry }) => entry.path),
  );
  if (media && captures.size)
    await compileLearningMedia(media, snapshot.tracked, snapshot.read, {
      requireFresh: ({ path: file }) => captures.has(file),
    });
}

/**
 * Records that remain stale on inputs this batch touched, such as a page that
 * cites a document whose bytes this review accepted, or a page that cites a
 * manifest this command just rewrote (docs/learn/media.json).
 */
async function staleDependents(recorded, ledger, snapshot, written) {
  const touched = new Set([
    ...written,
    ...recorded.flatMap(({ entry }) => [
      entry.path,
      ...entry.sources.map((source) => source.path),
    ]),
  ]);
  const documents = new Map();
  for (const record of ledger.records)
    if (snapshot.tracked.has(record.path))
      documents.set(record.path, digest(await snapshot.read(record.path)));
  const dependents = [];
  for (const record of ledger.records) {
    const review = await evaluateDocumentationReview(
      record,
      documents,
      snapshot.tracked,
      snapshot.read,
      { reportMissing: true },
    );
    if (review.changed.some((input) => touched.has(input)))
      dependents.push({ path: review.path, changed: review.changed });
  }
  return dependents;
}

/**
 * Apply review entries to the ledger and capture manifest in `root`. Nothing
 * is written unless every entry refreshes and validates.
 * @param {{ root?: string, entries: { path: string, note: string, removedSources?: string[], addedSources?: string[] }[] }} input
 */
export async function recordDocumentationReviews({
  root = process.cwd(),
  entries: input,
}) {
  const entries = validateEntries(input);
  const revision = headRevision(root);
  const snapshot = createRepositorySnapshot(root);
  const ledgerText = readFileSync(path.join(root, REVIEW_LEDGER), 'utf8');
  const ledger = JSON.parse(ledgerText);
  if (!Array.isArray(ledger?.records))
    throw new Error('Documentation review ledger requires records');
  const mediaText = snapshot.tracked.has(LEARNING_MEDIA_MANIFEST)
    ? readFileSync(path.join(root, LEARNING_MEDIA_MANIFEST), 'utf8')
    : undefined;
  const media = mediaText ? JSON.parse(mediaText) : undefined;

  // Captures first: a review may cite media.json, so its digest must be taken
  // over the manifest bytes this command is about to write.
  const isCapture = (entry) =>
    Boolean(media?.captures?.some((item) => item.path === entry.path));
  const recorded = [];
  for (const entry of entries.filter(isCapture))
    recorded.push(
      await refreshEntry(entry, { ledger, media, snapshot, revision }),
    );
  if (media && recorded.length)
    snapshot.replace(
      LEARNING_MEDIA_MANIFEST,
      Buffer.from(serializeLearningMedia(media)),
    );
  for (const entry of entries.filter((entry) => !isCapture(entry)))
    recorded.push(
      await refreshEntry(entry, { ledger, media, snapshot, revision }),
    );
  await assertRecordedFresh(recorded, media, snapshot);

  const writes = [
    [REVIEW_LEDGER, ledgerText, serializeReviewLedger(ledger)],
    ...(media
      ? [[LEARNING_MEDIA_MANIFEST, mediaText, serializeLearningMedia(media)]]
      : []),
  ];
  const written = [];
  for (const [file, before, after] of writes)
    if (before !== after) {
      writeFileSync(path.join(root, file), after);
      written.push(file);
    }
  return {
    revision,
    recorded: recorded.map(({ kind, entry }) => ({ kind, path: entry.path })),
    dependents: await staleDependents(recorded, ledger, snapshot, written),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseRecordArguments(argv);
  const entries =
    parsed.entries ?? JSON.parse(readFileSync(parsed.batch, 'utf8'));
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const result = await recordDocumentationReviews({ root, entries });
  console.log(
    `Recorded ${result.recorded.length} review(s) at ${result.revision}:`,
  );
  for (const entry of result.recorded)
    console.log(`  ${entry.kind} ${entry.path}`);
  if (result.dependents.length) {
    console.log(
      `Still stale on inputs this batch touched (${result.dependents.length}); review each before recording it:`,
    );
    for (const entry of result.dependents)
      console.log(`  ${entry.path}; changed: ${entry.changed.join(', ')}`);
  }
}

if (invokedDirectly(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(
      `docs:review:record: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

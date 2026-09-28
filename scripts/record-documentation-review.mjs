#!/usr/bin/env node
// Record a completed documentation review without hand-editing digests
// (#2924), in the merge-friendly ledger layout (#2936).
//
//   npm run docs:review:record -- <path> --note "<what you checked>" [--drop-source <path>]... [--add-source <path>]... [--rereview]
//   npm run docs:review:record -- --batch <file.json>
//   npm run docs:review:record -- --show-delta [<path>...]
//   npm run docs:review:record -- --verify-bindings [<path>...]
//
// <path> names an existing review record (a document) or a docs/learn/media
// capture. Batch input is a JSON array of
// `{ path, note, removedSources?, addedSources?, rereview? }`. Recording
// rebinds each changed document or source to the commit that contains its
// reviewed bytes, adds the notes as one new append-only notes file, and writes
// nothing unless every entry validates. It records a review that a person
// performed; it does not decide whether the prose is accurate.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRepositorySnapshot } from './lib/documentation-freshness.mjs';
import { evaluateDocumentationReview } from './lib/documentation-review.mjs';
import { compileLearningMedia } from './lib/learning-media.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import {
  compileReviewState,
  notesFileName,
  parseReviewLedgerFiles,
  REVIEW_LEDGER_INDEX,
  readGitObjects,
  readReviewFiles,
  serializeCaptureReviewFile,
  serializeLedgerIndex,
  serializeNotesFile,
  serializeRecordFile,
} from './lib/review-ledger-store.mjs';

const USAGE = [
  'Usage: docs:review:record -- <path> --note "<review note>" [--drop-source <path>]... [--add-source <path>]... [--rereview]',
  '       docs:review:record -- --batch <file.json>',
  '       docs:review:record -- --show-delta [<path>...]',
  '       docs:review:record -- --verify-bindings [<path>...]',
].join('\n');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const gitBlobId = (bytes) =>
  createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function parseRecordArguments(argv) {
  let batch;
  let note;
  let mode = 'record';
  let rereview = false;
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
    else if (arg === '--rereview') rereview = true;
    else if (arg === '--show-delta' || arg === '--verify-bindings') {
      if (mode !== 'record')
        throw new Error(
          `Choose one of --show-delta or --verify-bindings\n${USAGE}`,
        );
      mode = arg.slice(2);
    } else if (arg.startsWith('-'))
      throw new Error(`Unknown option ${arg}\n${USAGE}`);
    else paths.push(arg);
  }
  const recording =
    batch !== undefined ||
    note !== undefined ||
    rereview ||
    removedSources.length ||
    addedSources.length;
  if (mode !== 'record') {
    if (recording)
      throw new Error(
        `--${mode} reads the ledger and records nothing\n${USAGE}`,
      );
    return { mode, paths };
  }
  if (batch !== undefined) {
    if (
      paths.length ||
      note !== undefined ||
      rereview ||
      removedSources.length ||
      addedSources.length
    )
      throw new Error(
        `--batch cannot be combined with a path, note or flag\n${USAGE}`,
      );
    return { mode, batch };
  }
  if (paths.length !== 1) throw new Error(USAGE);
  return {
    mode,
    entries: [{ path: paths[0], note, removedSources, addedSources, rereview }],
  };
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || !entries.length)
    throw new Error('Review batch must be a non-empty JSON array');
  const seen = new Set();
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Each review entry must be an object');
    const {
      path: file,
      note,
      removedSources = [],
      addedSources = [],
      rereview = false,
    } = entry;
    if (typeof file !== 'string' || !file)
      throw new Error('Review entry requires a path');
    if (seen.has(file)) throw new Error(`Duplicate review entry: ${file}`);
    seen.add(file);
    if (typeof note !== 'string' || !note.trim())
      throw new Error(`Review note is empty: ${file}`);
    if (typeof rereview !== 'boolean')
      throw new Error(`rereview must be true or false: ${file}`);
    for (const [name, list] of [
      ['removedSources', removedSources],
      ['addedSources', addedSources],
    ])
      if (
        !Array.isArray(list) ||
        list.some((source) => typeof source !== 'string' || !source)
      )
        throw new Error(`${name} must be an array of paths: ${file}`);
    return {
      path: file,
      note: note.trim(),
      removedSources,
      addedSources,
      rereview,
    };
  });
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

/** path -> blob id of every file in HEAD. */
function headBlobs(root) {
  const blobs = new Map();
  for (const entry of git(root, ['ls-tree', '-r', '-z', 'HEAD']).split('\0')) {
    const match = /^\d+ blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    if (match) blobs.set(match[2], match[1]);
  }
  return blobs;
}

/**
 * The bindings whose revision does not contain the recorded bytes, such as a
 * record merged from two sides or bytes recorded before they were committed.
 * @param {string} root
 * @param {{ owner: string, kind: string, path: string, digest: string, revision: string }[]} bindings
 */
export function unverifiableBindings(root, bindings) {
  const objects = readGitObjects(
    root,
    bindings.map(({ path: file, revision }) => `${revision}:${file}`),
  );
  const commits = new Map();
  const hasCommit = (revision) => {
    if (!commits.has(revision))
      commits.set(
        revision,
        readGitObjects(root, [`${revision}^{commit}`])[0] !== undefined,
      );
    return commits.get(revision);
  };
  return bindings.flatMap((binding, index) => {
    const bytes = objects[index];
    if (bytes !== undefined && digest(bytes) === binding.digest) return [];
    const reason =
      bytes !== undefined
        ? 'the revision holds different bytes'
        : hasCommit(binding.revision)
          ? 'the path is absent at the revision'
          : 'the revision is not available locally';
    return [{ ...binding, reason }];
  });
}

const bindingsOf = (kind, entry) => [
  ...(kind === 'review'
    ? [
        {
          owner: entry.path,
          kind,
          path: entry.path,
          digest: entry.documentDigest ?? entry.document.digest,
          revision: entry.documentRevision ?? entry.document.revision,
        },
      ]
    : []),
  ...entry.sources.map((source) => ({ owner: entry.path, kind, ...source })),
];

function editSources(file, sources, removed, added) {
  for (const source of removed)
    if (!sources.some((entry) => entry.path === source))
      throw new Error(`Not a recorded source of ${file}: ${source}`);
  const kept = sources.filter((entry) => !removed.includes(entry.path));
  for (const source of added) {
    if (source === file || kept.some((entry) => entry.path === source))
      throw new Error(`Already a recorded source of ${file}: ${source}`);
    kept.push({ path: source });
  }
  return kept;
}

/**
 * Rebind one entry's document and sources. A binding changes only when its
 * bytes changed, it is new, or its revision does not contain its bytes, so an
 * unrelated source's line stays untouched and merges cleanly (#2936).
 */
async function rebind(entry, owner, context) {
  const { snapshot, blobs, head, flagged, revisionOf } = context;
  const bindings = [
    ...(owner.document ? [{ ...owner.document, path: owner.path }] : []),
    ...editSources(
      owner.path,
      owner.sources,
      entry.removedSources,
      entry.addedSources,
    ),
  ];
  let changed = entry.removedSources.length + entry.addedSources.length > 0;
  const rebound = [];
  const refreshed = [];
  for (const binding of bindings) {
    if (!snapshot.tracked.has(binding.path))
      throw new Error(
        binding.path === owner.path
          ? `Reviewed document is not tracked: ${owner.path}`
          : `Recorded source is not tracked: ${owner.path} -> ${binding.path}; git add it or pass --drop-source ${binding.path}`,
      );
    const bytes = await snapshot.read(binding.path);
    const current = digest(bytes);
    const stale = binding.digest !== current;
    if (stale) changed = true;
    const unverifiable = flagged.has(`${binding.revision}:${binding.path}`);
    if (!stale && !unverifiable) {
      refreshed.push(binding);
      continue;
    }
    // The binding names the commit that holds the reviewed bytes, so
    // `git diff <revision> HEAD` later shows exactly what changed since.
    if (blobs.get(binding.path) !== gitBlobId(bytes))
      throw new Error(
        `Reviewed bytes are not committed: ${binding.path}; commit them first, so the review binds a commit that contains them`,
      );
    if (unverifiable && !stale) rebound.push(binding.path);
    refreshed.push({
      path: binding.path,
      digest: current,
      revision: revisionOf(binding.path) ?? head,
    });
  }
  if (!changed && !entry.rereview)
    throw new Error(
      `Already fresh: ${owner.path}; its recorded bytes are unchanged. Pass --rereview to record a new review of unchanged bytes`,
    );
  const [document, ...sources] = owner.document
    ? refreshed
    : [undefined, ...refreshed];
  return { document, sources, rebound };
}

/**
 * The last commit at or before HEAD that set this path to its HEAD bytes;
 * branches that review the same bytes therefore bind the same commit.
 */
function lastTouchingCommit(root, blobs) {
  return (file) => {
    const commit = git(root, [
      'log',
      '-1',
      '--format=%H',
      'HEAD',
      '--',
      file,
    ]).trim();
    if (!/^[a-f0-9]{40}$/.test(commit)) return undefined;
    const [bytes] = readGitObjects(root, [`${commit}:${file}`]);
    return bytes !== undefined && gitBlobId(bytes) === blobs.get(file)
      ? commit
      : undefined;
  };
}

function serializeLedgerFiles(parsed) {
  const text = new Map([
    [REVIEW_LEDGER_INDEX, serializeLedgerIndex(parsed.index)],
  ]);
  for (const [, { file, data }] of parsed.records)
    text.set(file, serializeRecordFile(data));
  for (const [, { file, data }] of parsed.captures)
    text.set(file, serializeCaptureReviewFile(data));
  for (const { file, data } of parsed.notes)
    text.set(file, serializeNotesFile(data));
  return text;
}

/**
 * Records that remain stale on inputs this batch touched, such as a page that
 * cites a document whose bytes this review accepted.
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
 * Apply review entries to the ledger in `root`. Nothing is written unless
 * every entry refreshes and validates.
 * @param {{ root?: string, entries: { path: string, note: string, removedSources?: string[], addedSources?: string[], rereview?: boolean }[], now?: Date }} input
 */
export async function recordDocumentationReviews({
  root = process.cwd(),
  entries: input,
  now = new Date(),
}) {
  const entries = validateEntries(input);
  const head = headRevision(root);
  const snapshot = createRepositorySnapshot(root);
  const { parsed, manifest } = readReviewFiles(root);
  const before = serializeLedgerFiles(parsed);
  const owners = entries.map((entry) => {
    const record = parsed.records.get(entry.path);
    if (record) return { kind: 'review', entry, raw: record };
    const capture = parsed.captures.get(entry.path);
    if (capture) return { kind: 'capture', entry, raw: capture };
    throw new Error(
      `No review record or capture for ${entry.path}; add a new record by hand with its kind, summary and limits`,
    );
  });
  const flagged = new Set(
    unverifiableBindings(
      root,
      owners.flatMap(({ kind, raw }) => bindingsOf(kind, raw.data)),
    ).map(({ path: file, revision }) => `${revision}:${file}`),
  );
  const blobs = headBlobs(root);
  const context = {
    snapshot,
    blobs,
    head,
    flagged,
    revisionOf: lastTouchingCommit(root, blobs),
  };
  const recorded = [];
  for (const { kind, entry, raw } of owners) {
    if (kind === 'capture') {
      const metadata = manifest?.captures?.find(
        (item) => item.path === entry.path,
      );
      if (
        !snapshot.tracked.has(entry.path) ||
        metadata?.digest !== digest(await snapshot.read(entry.path))
      )
        throw new Error(
          `Capture bytes differ from the recorded digest: ${entry.path}; a new capture needs its digest, capturedRevision and evidence updated, not only a review`,
        );
    }
    const { document, sources, rebound } = await rebind(
      entry,
      raw.data,
      context,
    );
    raw.data = {
      ...raw.data,
      ...(document
        ? { document: { digest: document.digest, revision: document.revision } }
        : {}),
      sources,
    };
    recorded.push({ kind, path: entry.path, rebound });
  }
  const notesText = serializeNotesFile({
    revision: head,
    notes: entries.map(({ path: file, note }) => ({ path: file, note })),
  });
  const notesFile = notesFileName(notesText, now);
  const after = serializeLedgerFiles(parsed);
  after.set(notesFile, notesText);

  // Validate the result with the same compilers the gates use.
  const state = compileReviewState(parseReviewLedgerFiles(after), manifest);
  const reviews = state.ledger.records.filter((record) =>
    recorded.some(
      (item) => item.kind === 'review' && item.path === record.path,
    ),
  );
  const documents = new Map();
  for (const record of reviews)
    documents.set(record.path, digest(await snapshot.read(record.path)));
  for (const record of reviews)
    await evaluateDocumentationReview(
      record,
      documents,
      snapshot.tracked,
      snapshot.read,
      { requireFresh: true },
    );
  const captures = new Set(
    recorded.filter(({ kind }) => kind === 'capture').map(({ path: p }) => p),
  );
  if (state.media && captures.size)
    await compileLearningMedia(state.media, snapshot.tracked, snapshot.read, {
      requireFresh: ({ path: file }) => captures.has(file),
    });

  const written = [];
  for (const [file, text] of after)
    if (before.get(file) !== text) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
      written.push(file);
    }
  return {
    revision: head,
    notesFile,
    recorded,
    dependents: await staleDependents(
      recorded.map(({ path: file }) => ({
        entry: [...state.ledger.records, ...(state.media?.captures ?? [])].find(
          (item) => item.path === file,
        ),
      })),
      state.ledger,
      snapshot,
      written,
    ),
  };
}

/** Every recorded review and capture, evaluated against current bytes. */
async function evaluateAll(root, paths) {
  const snapshot = createRepositorySnapshot(root);
  const { parsed, manifest } = readReviewFiles(root);
  const state = compileReviewState(parsed, manifest);
  const documents = new Map();
  for (const record of state.ledger.records)
    if (snapshot.tracked.has(record.path))
      documents.set(record.path, digest(await snapshot.read(record.path)));
  const entries = [];
  for (const record of state.ledger.records)
    entries.push({
      kind: 'review',
      record,
      evaluated: await evaluateDocumentationReview(
        record,
        documents,
        snapshot.tracked,
        snapshot.read,
        { reportMissing: true },
      ),
    });
  if (state.media)
    for (const capture of (
      await compileLearningMedia(state.media, snapshot.tracked, snapshot.read, {
        reportMissing: true,
      })
    ).values())
      entries.push({ kind: 'capture', record: capture, evaluated: capture });
  for (const file of paths)
    if (!entries.some(({ record }) => record.path === file))
      throw new Error(`No review record or capture for ${file}`);
  return entries.filter(
    ({ record }) => !paths.length || paths.includes(record.path),
  );
}

/**
 * For each stale entry, the Git delta of its changed inputs since the commit
 * each input was reviewed at: `git diff <revision> HEAD -- <inputs>`.
 * @param {{ root?: string, paths?: string[] }} input
 */
export async function showReviewDelta({ root = process.cwd(), paths = [] }) {
  const entries = await evaluateAll(root, paths);
  const blobs = headBlobs(root);
  const snapshot = createRepositorySnapshot(root);
  const lines = [];
  for (const { kind, record, evaluated } of entries) {
    if (!evaluated.changed.length) {
      if (paths.length) lines.push(`${kind} ${record.path} is fresh.`);
      continue;
    }
    const bindings = bindingsOf(kind, record);
    const flagged = new Set(
      unverifiableBindings(root, bindings).map(({ path: file }) => file),
    );
    const groups = new Map();
    for (const input of evaluated.changed) {
      const revision = bindings.find(
        ({ path: file }) => file === input,
      )?.revision;
      groups.set(revision, [...(groups.get(revision) ?? []), input]);
    }
    for (const [revision, inputs] of groups) {
      lines.push(
        `== ${kind} ${record.path}: git diff ${revision} HEAD -- ${inputs.join(' ')}`,
      );
      for (const input of inputs) {
        if (flagged.has(input))
          lines.push(
            `   note: ${revision} does not contain the reviewed bytes of ${input}; the delta starts from that commit's bytes`,
          );
        if (
          snapshot.tracked.has(input) &&
          blobs.get(input) !== gitBlobId(await snapshot.read(input))
        )
          lines.push(
            `   note: ${input} has uncommitted changes that this delta omits`,
          );
      }
      if (readGitObjects(root, [`${revision}^{commit}`])[0] === undefined) {
        lines.push(
          `   ${revision} is not available locally; fetch it or compare the recorded hashes`,
        );
        continue;
      }
      lines.push(
        git(root, [
          'diff',
          '--no-color',
          revision,
          'HEAD',
          '--',
          ...inputs,
        ]).trimEnd(),
      );
    }
  }
  return lines;
}

/**
 * Bindings whose revision does not contain the recorded bytes.
 * @param {{ root?: string, paths?: string[] }} input
 */
export async function verifyReviewBindings({
  root = process.cwd(),
  paths = [],
}) {
  const entries = await evaluateAll(root, paths);
  return unverifiableBindings(
    root,
    entries.flatMap(({ kind, record }) => bindingsOf(kind, record)),
  );
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseRecordArguments(argv);
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  if (parsed.mode === 'show-delta') {
    const lines = await showReviewDelta({ root, paths: parsed.paths });
    console.log(
      lines.length ? lines.join('\n') : 'No stale reviews or captures.',
    );
    return;
  }
  if (parsed.mode === 'verify-bindings') {
    const flagged = await verifyReviewBindings({ root, paths: parsed.paths });
    if (!flagged.length) {
      console.log(
        'Every binding names a revision that contains its recorded bytes.',
      );
      return;
    }
    console.log(
      `Bindings whose revision does not contain the recorded bytes (${flagged.length}); re-review each owner with --rereview to rebind it:`,
    );
    for (const item of flagged)
      console.log(
        `  ${item.kind} ${item.owner} -> ${item.path} @ ${item.revision}: ${item.reason}`,
      );
    process.exitCode = 1;
    return;
  }
  const entries =
    parsed.entries ?? JSON.parse(readFileSync(parsed.batch, 'utf8'));
  const result = await recordDocumentationReviews({ root, entries });
  console.log(
    `Recorded ${result.recorded.length} review(s) at ${result.revision} in ${result.notesFile}:`,
  );
  for (const entry of result.recorded)
    console.log(
      `  ${entry.kind} ${entry.path}${
        entry.rebound.length
          ? `; rebound to a revision that contains its bytes: ${entry.rebound.join(', ')}`
          : ''
      }`,
    );
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

#!/usr/bin/env node
// Record a completed documentation review without hand-editing digests
// (#2924), in the merge-friendly ledger layout (#2936).
//
//   npm run docs:review:record -- <path> --note "<what you checked>" [--drop-source <path>]... [--add-source <path>]... [--rereview]
//   npm run docs:review:record -- --batch <file.json>
//   npm run docs:review:record -- --advance-baseline
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
import { readFileSync } from 'node:fs';
import {
  assertDocumentationFresh,
  checkDocumentationFreshness,
  createRepositorySnapshot,
  resolveDocumentationFreshness,
} from './lib/documentation-freshness.mjs';
import { evaluateDocumentationReview } from './lib/documentation-review.mjs';
import { compileLearningMedia } from './lib/learning-media.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import {
  bindingDigest,
  bindingFile,
  isBindingPath,
} from './lib/review-binding.mjs';
import {
  compileReviewState,
  notesFileName,
  parseReviewLedgerFiles,
  planNoteCompaction,
  REVIEW_LEDGER_DIR,
  REVIEW_LEDGER_INDEX,
  readGitObjects,
  readReviewFiles,
  readReviewState,
  reviewError,
  serializeCaptureReviewFile,
  serializeLedgerIndex,
  serializeNotesFile,
  serializeRecordFile,
  writeReviewFiles,
} from './lib/review-ledger-store.mjs';

const USAGE = [
  'Usage: docs:review:record -- <path> --note "<review note>" [--drop-source <path>]... [--add-source <path>]... [--rereview] [--json]',
  '       docs:review:record -- --batch <file.json>',
  '       docs:review:record -- --advance-baseline',
  '       docs:review:record -- --show-delta [<path>...]',
  '       docs:review:record -- --verify-bindings [<path>...]',
].join('\n');
const UNVERIFIABLE = {
  'different-bytes': 'the revision holds different bytes',
  'absent-at-revision': 'the path is absent at the revision',
  'revision-unavailable': 'the revision is not available locally',
};
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
        throw reviewError('usage', `${arg} requires a value`);
      return next;
    };
    if (arg === '--batch') batch = value();
    else if (arg === '--note') note = value();
    else if (arg === '--drop-source') removedSources.push(value());
    else if (arg === '--add-source') addedSources.push(value());
    else if (arg === '--rereview') rereview = true;
    else if (arg === '--json') continue;
    else if (
      arg === '--show-delta' ||
      arg === '--verify-bindings' ||
      arg === '--advance-baseline'
    ) {
      if (mode !== 'record')
        throw reviewError(
          'usage',
          `Choose one of --show-delta or --verify-bindings\n${USAGE}`,
        );
      mode = arg.slice(2);
    } else if (arg.startsWith('-'))
      throw reviewError('usage', `Unknown option ${arg}\n${USAGE}`);
    else paths.push(arg);
  }
  const recording =
    batch !== undefined ||
    note !== undefined ||
    rereview ||
    removedSources.length ||
    addedSources.length;
  if (mode !== 'record') {
    if (mode === 'advance-baseline' && paths.length)
      throw reviewError('usage', USAGE);
    if (recording)
      throw reviewError(
        'usage',
        `--${mode} cannot be combined with recording options\n${USAGE}`,
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
      throw reviewError(
        'usage',
        `--batch cannot be combined with a path, note or flag\n${USAGE}`,
      );
    return { mode, batch };
  }
  if (paths.length !== 1) throw reviewError('usage', USAGE);
  return {
    mode,
    entries: [{ path: paths[0], note, removedSources, addedSources, rereview }],
  };
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || !entries.length)
    throw reviewError(
      'invalid-batch',
      'Review batch must be a non-empty JSON array',
    );
  const seen = new Set();
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw reviewError('invalid-batch', 'Each review entry must be an object');
    const {
      path: file,
      note,
      removedSources = [],
      addedSources = [],
      rereview = false,
    } = entry;
    if (typeof file !== 'string' || !file)
      throw reviewError('invalid-batch', 'Review entry requires a path');
    if (seen.has(file))
      throw reviewError('duplicate-entry', `Duplicate review entry: ${file}`);
    seen.add(file);
    if (typeof note !== 'string' || !note.trim())
      throw reviewError('empty-note', `Review note is empty: ${file}`);
    if (typeof rereview !== 'boolean')
      throw reviewError(
        'invalid-batch',
        `rereview must be true or false: ${file}`,
      );
    for (const [name, list] of [
      ['removedSources', removedSources],
      ['addedSources', addedSources],
    ])
      if (
        !Array.isArray(list) ||
        list.some((source) => typeof source !== 'string' || !source)
      )
        throw reviewError(
          'invalid-batch',
          `${name} must be an array of paths: ${file}`,
        );
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
    throw reviewError(
      'no-head',
      `Cannot bind the review to HEAD: ${
        String(error?.stderr || error?.message)
          .trim()
          .split('\n')[0]
      }`,
    );
  }
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw reviewError('no-head', `HEAD is not a full commit SHA: ${revision}`);
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
    bindings.map(
      ({ path: file, revision }) => `${revision}:${bindingFile(file)}`,
    ),
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
    if (
      bytes !== undefined &&
      bindingDigest(binding.path, bytes) === binding.digest
    )
      return [];
    const reason =
      bytes !== undefined
        ? 'different-bytes'
        : hasCommit(binding.revision)
          ? 'absent-at-revision'
          : 'revision-unavailable';
    return [{ ...binding, reason }];
  });
}

const bindingsOf = (kind, entry) =>
  entry.historyChanges !== undefined
    ? []
    : [
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
        ...entry.sources.map((source) => ({
          owner: entry.path,
          kind,
          ...source,
        })),
      ];

function editSources(file, sources, removed, added) {
  for (const source of removed)
    if (!sources.some((entry) => entry.path === source))
      throw reviewError(
        'not-a-source',
        `Not a recorded source of ${file}: ${source}`,
      );
  const kept = sources.filter((entry) => !removed.includes(entry.path));
  for (const source of added) {
    if (!isBindingPath(source))
      throw reviewError(
        'invalid-path',
        `Not a repository path or JSON value path: ${source}`,
      );
    if (source === file || kept.some((entry) => entry.path === source))
      throw reviewError(
        'already-a-source',
        `Already a recorded source of ${file}: ${source}`,
      );
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
  const { snapshot, head, flagged, revisionOf, committedAtHead } = context;
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
    const file = bindingFile(binding.path);
    if (!snapshot.tracked.has(file))
      throw reviewError(
        'untracked',
        binding.path === owner.path
          ? `Reviewed document is not tracked: ${owner.path}`
          : `Recorded source is not tracked: ${owner.path} -> ${binding.path}; git add it or pass --drop-source ${binding.path}`,
      );
    const bytes = await snapshot.read(file);
    const current = bindingDigest(binding.path, bytes);
    if (current === undefined)
      throw reviewError(
        'missing-value',
        `No value at ${binding.path}: ${owner.path}; cite a value that exists or pass --drop-source ${binding.path}`,
      );
    const stale = binding.digest !== current;
    if (stale) changed = true;
    const unverifiable = flagged.has(`${binding.revision}:${binding.path}`);
    if (!stale && !unverifiable) {
      refreshed.push(binding);
      continue;
    }
    // The binding names the commit that holds the reviewed bytes, so
    // `git diff <revision> HEAD` later shows exactly what changed since.
    if (!committedAtHead(binding.path, current, bytes))
      throw reviewError(
        'not-committed',
        `Reviewed bytes are not committed: ${binding.path}; commit them first, so the review binds a commit that contains them`,
      );
    if (unverifiable && !stale) rebound.push(binding.path);
    refreshed.push({
      path: binding.path,
      digest: current,
      revision: revisionOf(binding.path, current) ?? head,
    });
  }
  if (!changed && !entry.rereview)
    throw reviewError(
      'already-fresh',
      `Already fresh: ${owner.path}; its recorded bytes are unchanged. Pass --rereview to record a new review of unchanged bytes`,
    );
  const [document, ...sources] = owner.document
    ? refreshed
    : [undefined, ...refreshed];
  return { document, sources, rebound };
}

/**
 * The commit that set a binding's current value, found by walking the file's
 * history back from HEAD while the value is unchanged. Branches that review
 * the same bytes, or the same JSON value, therefore bind the same commit.
 */
function valueSettingCommit(root) {
  return (path, current) => {
    const file = bindingFile(path);
    const commits = git(root, ['log', '--format=%H', 'HEAD', '--', file])
      .split('\n')
      .filter((line) => /^[a-f0-9]{40}$/.test(line));
    let setter;
    for (let start = 0; start < commits.length; start += 32) {
      const chunk = commits.slice(start, start + 32);
      const objects = readGitObjects(
        root,
        chunk.map((commit) => `${commit}:${file}`),
      );
      for (const [index, commit] of chunk.entries()) {
        if (
          objects[index] === undefined ||
          bindingDigest(path, objects[index]) !== current
        )
          return setter;
        setter = commit;
      }
    }
    return setter;
  };
}

/** Whether HEAD already holds the reviewed bytes, or the reviewed value. */
function reviewedAtHead(root) {
  const blobs = headBlobs(root);
  const values = new Map();
  return (path, current, bytes) => {
    const file = bindingFile(path);
    if (path === file) return blobs.get(file) === gitBlobId(bytes);
    if (!values.has(file))
      values.set(file, readGitObjects(root, [`HEAD:${file}`])[0]);
    const committed = values.get(file);
    return (
      committed !== undefined && bindingDigest(path, committed) === current
    );
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
  // Archived notes stay in their archive, whose bytes are never rewritten.
  for (const [file, archive] of parsed.archives) text.set(file, archive);
  for (const { file, data, archive } of parsed.notes)
    if (archive === undefined) text.set(file, serializeNotesFile(data));
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
  if (parsed.index.version === 3)
    return recordReviewNotes(
      root,
      entries,
      head,
      snapshot,
      parsed,
      manifest,
      before,
      now,
    );
  const owners = entries.map((entry) => {
    const record = parsed.records.get(entry.path);
    if (record) return { kind: 'review', entry, raw: record };
    const capture = parsed.captures.get(entry.path);
    if (capture) return { kind: 'capture', entry, raw: capture };
    throw reviewError(
      'unknown-entry',
      `No review record or capture for ${entry.path}; add a new record by hand with its kind, summary and limits`,
    );
  });
  const flagged = new Set(
    unverifiableBindings(
      root,
      owners.flatMap(({ kind, raw }) => bindingsOf(kind, raw.data)),
    ).map(({ path: file, revision }) => `${revision}:${file}`),
  );
  const context = {
    snapshot,
    head,
    flagged,
    revisionOf: valueSettingCommit(root),
    committedAtHead: reviewedAtHead(root),
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
        throw reviewError(
          'capture-changed',
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

  const written = writeReviewFiles(root, after, before);
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

/** Version 3 records decisions; a review run writes only its new notes file. */
async function recordReviewNotes(
  root,
  entries,
  head,
  snapshot,
  parsed,
  manifest,
  before,
  now,
) {
  const state = readReviewState(root);
  const committed = reviewedAtHead(root);
  const policy = resolveDocumentationFreshness({
    root,
    env: { ...process.env, STATION_DOCS_FRESHNESS: 'scoped' },
    ledger: state.ledger,
    media: state.media,
  });
  const notes = [];
  const recorded = [];
  for (const entry of entries) {
    const raw =
      parsed.records.get(entry.path) ?? parsed.captures.get(entry.path);
    if (!raw)
      throw reviewError(
        'unknown-entry',
        `No review record or capture for ${entry.path}`,
      );
    if (
      raw.data.document ||
      raw.data.sources.some((source) => typeof source !== 'string')
    )
      throw reviewError(
        'migration-required',
        'Old bindings remain; run node scripts/migrate-review-ledger.mjs --path-only first',
      );
    const kind = parsed.records.has(entry.path) ? 'review' : 'capture';
    const owner = [
      ...state.ledger.records,
      ...(state.media?.captures ?? []),
    ].find((item) => item.path === entry.path);
    const sources = editSources(
      entry.path,
      owner.sources,
      entry.removedSources,
      entry.addedSources,
    );
    const inputs = [
      ...new Set([
        entry.path,
        ...(owner.historyChanges ?? []),
        ...(policy.sourceDrops ?? [])
          .filter((problem) => problem.path === entry.path)
          .flatMap((problem) => problem.changed),
        ...entry.addedSources,
        ...entry.removedSources,
        ...(owner.historyUnavailable
          ? sources.map((source) => source.path)
          : []),
      ]),
    ];
    for (const input of [entry.path, ...sources.map((source) => source.path)]) {
      const file = bindingFile(input);
      if (!snapshot.tracked.has(file))
        throw reviewError(
          'untracked',
          `Recorded input is not tracked: ${input}; add it or drop its citation`,
        );
      const bytes = await snapshot.read(file);
      const value = bindingDigest(input, bytes);
      if (value === undefined)
        throw reviewError('missing-value', `No value at ${input}`);
      if (!committed(input, value, bytes))
        throw reviewError(
          'not-committed',
          `Reviewed bytes are not committed: ${input}; commit them first`,
        );
      if (
        kind === 'capture' &&
        input === entry.path &&
        owner.digest !== digest(bytes)
      )
        throw reviewError(
          'capture-changed',
          `Capture bytes differ from the recorded digest: ${entry.path}; update capture metadata`,
        );
    }
    raw.data.sources = sources.map((source) => source.path);
    notes.push({ path: entry.path, note: entry.note, inputs });
    recorded.push({ kind, path: entry.path, rebound: [] });
  }
  const notesText = serializeNotesFile({ revision: head, notes });
  const notesFile = notesFileName(notesText, now);
  const after = serializeLedgerFiles(parsed);
  after.set(notesFile, notesText);
  const proposed = compileReviewState(parseReviewLedgerFiles(after), manifest);
  const documents = new Map();
  for (const record of proposed.ledger.records)
    if (snapshot.tracked.has(record.path))
      documents.set(record.path, digest(await snapshot.read(record.path)));
  for (const item of recorded.filter((item) => item.kind === 'review'))
    await evaluateDocumentationReview(
      proposed.ledger.records.find((record) => record.path === item.path),
      documents,
      snapshot.tracked,
      snapshot.read,
    );
  if (proposed.media)
    await compileLearningMedia(
      proposed.media,
      snapshot.tracked,
      snapshot.read,
      { reportMissing: true },
    );
  writeReviewFiles(root, after, before);
  return {
    revision: head,
    notesFile,
    recorded,
    dependents: readReviewState(root)
      .ledger.records.filter((record) => record.historyChanges?.length)
      .map((record) => ({ path: record.path, changed: record.historyChanges })),
  };
}

/** Every recorded review and capture, evaluated against current bytes. */
async function evaluateAll(root, paths) {
  const snapshot = createRepositorySnapshot(root);
  const state = readReviewState(root);
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
      throw reviewError(
        'unknown-entry',
        `No review record or capture for ${file}`,
      );
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
  const deltas = [];
  for (const { kind, record, evaluated } of entries) {
    if (!evaluated.changed.length) {
      if (paths.length) deltas.push({ kind, path: record.path, fresh: true });
      continue;
    }
    if (record.historyChanges !== undefined) {
      const revision = record.reviewBaseline;
      const files = [...new Set(evaluated.changed.map(bindingFile))];
      deltas.push({
        kind,
        path: record.path,
        fresh: false,
        historyUnavailable: record.historyUnavailable,
        diffs: revision
          ? [
              {
                revision,
                inputs: evaluated.changed,
                files,
                lacksReviewedBytes: [],
                uncommitted: [],
                available: true,
                diff: git(root, [
                  'diff',
                  '--no-color',
                  revision,
                  '--',
                  ...files,
                ]).trimEnd(),
              },
            ]
          : [],
      });
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
    const diffs = [];
    for (const [revision, inputs] of groups) {
      // A value binding shows its whole file's diff.
      const files = [...new Set(inputs.map(bindingFile))];
      const uncommitted = [];
      for (const file of files)
        if (
          snapshot.tracked.has(file) &&
          blobs.get(file) !== gitBlobId(await snapshot.read(file))
        )
          uncommitted.push(file);
      const available =
        readGitObjects(root, [`${revision}^{commit}`])[0] !== undefined;
      diffs.push({
        revision,
        inputs,
        files,
        lacksReviewedBytes: inputs.filter((input) => flagged.has(input)),
        uncommitted,
        available,
        diff: available
          ? git(root, [
              'diff',
              '--no-color',
              revision,
              'HEAD',
              '--',
              ...files,
            ]).trimEnd()
          : undefined,
      });
    }
    deltas.push({ kind, path: record.path, fresh: false, diffs });
  }
  return deltas;
}

/** The human form of `showReviewDelta`. */
function formatReviewDelta(deltas) {
  const lines = [];
  for (const delta of deltas) {
    if (delta.fresh) {
      lines.push(`${delta.kind} ${delta.path} is fresh.`);
      continue;
    }
    for (const item of delta.diffs) {
      const values = item.inputs.filter(
        (input) => input !== bindingFile(input),
      );
      lines.push(
        `== ${delta.kind} ${delta.path}: git diff ${item.revision} HEAD -- ${item.files.join(' ')}${
          values.length ? ` (cited values: ${values.join(', ')})` : ''
        }`,
      );
      for (const input of item.lacksReviewedBytes)
        lines.push(
          `   note: ${item.revision} does not contain the reviewed bytes of ${input}; the delta starts from that commit's bytes`,
        );
      for (const file of item.uncommitted)
        lines.push(
          `   note: ${file} has uncommitted changes that this delta omits`,
        );
      lines.push(
        item.available
          ? item.diff
          : `   ${item.revision} is not available locally; fetch it or compare the recorded hashes`,
      );
    }
  }
  return lines.length ? lines.join('\n') : 'No stale reviews or captures.';
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
  const json = argv.includes('--json');
  const parsed = parseRecordArguments(argv);
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  if (parsed.mode === 'advance-baseline') {
    if (git(root, ['status', '--porcelain']).trim())
      throw reviewError(
        'dirty-tree',
        'Commit all changes before advancing the coverage baseline.',
      );
    const head = git(root, ['rev-parse', 'HEAD']).trim();
    let remoteMain;
    try {
      remoteMain = git(root, [
        'rev-parse',
        '--verify',
        'refs/remotes/origin/main^{commit}',
      ]).trim();
    } catch {
      throw reviewError(
        'missing-remote-main',
        'Cannot advance the baseline: origin/main is missing. Run git fetch origin main, then retry on main.',
      );
    }
    try {
      git(root, ['merge-base', '--is-ancestor', head, remoteMain]);
    } catch {
      throw reviewError(
        'head-not-on-main',
        'Cannot advance the baseline: HEAD is not reachable from origin/main. Run git fetch origin main, then retry at a commit already on remote main; a PR commit cannot be the coverage baseline.',
      );
    }
    const result = await checkDocumentationFreshness({
      root,
      env: { STATION_DOCS_FRESHNESS: 'strict' },
    });
    assertDocumentationFresh(result);
    const { parsed: files } = readReviewFiles(root);
    if (files.index.version !== 3)
      throw reviewError(
        'unsupported-version',
        'Advance the baseline only after path-only migration.',
      );
    // Notes the previous advance already covered move into one immutable
    // archive in the same change (#3394); scoped freshness accepts their
    // removal only because their exact bytes are in that added archive.
    const { archive, archived, after } = planNoteCompaction(root, files);
    after.set(
      REVIEW_LEDGER_INDEX,
      serializeLedgerIndex({ version: 3, coverageBaseline: head }),
    );
    const before = serializeLedgerFiles(files);
    // Validate the compacted store with the parser the gates use before
    // writing any of it.
    const proposed = new Map(before);
    for (const [file, text] of after)
      if (text === undefined) proposed.delete(file);
      else proposed.set(file, text);
    parseReviewLedgerFiles(proposed);
    writeReviewFiles(root, after, before);
    console.log(
      `Advanced coverage baseline to ${head}${
        archive
          ? `; archived ${archived.length} landed note(s) in ${archive}`
          : ''
      }; commit ${REVIEW_LEDGER_DIR}.`,
    );
    return;
  }
  if (parsed.mode === 'show-delta') {
    const deltas = await showReviewDelta({ root, paths: parsed.paths });
    console.log(json ? JSON.stringify({ deltas }) : formatReviewDelta(deltas));
    return;
  }
  if (parsed.mode === 'verify-bindings') {
    const flagged = await verifyReviewBindings({ root, paths: parsed.paths });
    if (flagged.length) process.exitCode = 1;
    if (json) {
      console.log(JSON.stringify({ flagged }));
      return;
    }
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
        `  ${item.kind} ${item.owner} -> ${item.path} @ ${item.revision}: ${UNVERIFIABLE[item.reason]}`,
      );
    return;
  }
  const entries =
    parsed.entries ?? JSON.parse(readFileSync(parsed.batch, 'utf8'));
  const result = await recordDocumentationReviews({ root, entries });
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
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
    const message = error instanceof Error ? error.message : String(error);
    // `--json` reports a refusal by its stable code (#2927).
    if (process.argv.includes('--json'))
      console.log(
        JSON.stringify({
          error: { ...error, code: error?.code ?? 'error', message },
        }),
      );
    console.error(`docs:review:record: ${message}`);
    process.exitCode = 1;
  }
}

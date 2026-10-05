// Human review decisions and append-only notes; freshness is derived from Git.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import nodePath from 'node:path';
import {
  createLearningSourceReader,
  isLearningSourcePath,
} from './learning-source-reader.mjs';
import { isBindingPath } from './review-binding.mjs';
import { readGitObjects } from './review-git.mjs';

export { readGitObjects } from './review-git.mjs';

import { deriveReviewHistory } from './review-history.mjs';

export const REVIEW_LEDGER_DIR = 'docs/learn/review-ledger';
export const REVIEW_LEDGER_INDEX = `${REVIEW_LEDGER_DIR}/ledger.json`;
/** The single-file layout before #2936; read only from history. */
export const LEGACY_REVIEW_LEDGER = 'docs/learn/review-ledger.json';
/** Capture metadata; the capture reviews live in the ledger directory. */
export const LEARNING_MEDIA_MANIFEST = 'docs/learn/media.json';
export const REVIEW_LEDGER_VERSION = 2;

/**
 * Longest repo-relative ledger file path accepted (#3036). Windows MAX_PATH is
 * 260 including the terminating NUL, so 259 usable characters; an 80-character
 * checkout root and one separator leave 178. On c1d07db19c the longest record
 * file is 137 characters and the longest capture file 87, so this is a ceiling
 * that only a pathological document path reaches, not a ratchet to maintain.
 */
export const REVIEW_LEDGER_PATH_BUDGET = 178;

const RECORDS = `${REVIEW_LEDGER_DIR}/records/`;
const CAPTURES = `${REVIEW_LEDGER_DIR}/captures/`;
const NOTES = `${REVIEW_LEDGER_DIR}/notes/`;
const NOTE_NAME = /^(\d{8}T\d{6}\.\d{3}Z)-([a-f0-9]{12})\.json$/;
/**
 * Immutable archives of landed notes (#3394), one per baseline advance and
 * named for the coverage baseline the notes were added at or before. Each one
 * maps a note's file name to that note's exact bytes, so readers see one store.
 */
const ARCHIVES = `${NOTES}archive/`;
const ARCHIVE_NAME = /^[a-f0-9]{40}\.json$/;
const RECORD_KEYS = [
  'path',
  'kind',
  'state',
  'summary',
  'limits',
  'document',
  'sources',
  'checks',
];
const CAPTURE_KEYS = ['path', 'sources', 'reviewNotes'];
const NOTES_KEYS = ['revision', 'notes'];
const INDEX_KEYS = ['version', 'coverageBaseline'];
const CAPTURE_REVIEW_FIELDS = ['sources', 'reviewedRevision', 'reviewNotes'];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * An error with a stable `code`, so callers and tests branch on the refusal
 * rather than its wording (#2927). `details` adds fields such as `path`.
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 */
export function reviewError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

export const recordFile = (path) => `${RECORDS}${path}.json`;
/** @param {string} baseline the coverage baseline the archived notes predate */
export const noteArchiveFile = (baseline) => `${ARCHIVES}${baseline}.json`;
/** Whether a repo-relative path is a note archive rather than a loose note. */
export const isNoteArchiveFile = (file) => file.startsWith(ARCHIVES);
export const captureReviewFile = (path) => `${CAPTURES}${path}.json`;

/**
 * One member per line group; array items one per line. A blank line follows
 * every line that a review can change, so no two such lines are adjacent.
 * @param {[string, unknown][]} members
 */
function serializeMembers(members) {
  const blocks = members.map(([key, value]) => {
    const name = JSON.stringify(key);
    if (!Array.isArray(value) || !value.length)
      return `  ${name}: ${JSON.stringify(value)}`;
    const items = value.map((item) => `    ${JSON.stringify(item)}`);
    return `  ${name}: [\n${items.join(',\n\n')}\n  ]`;
  });
  return `{\n${blocks.join(',\n\n')}\n}\n`;
}

const binding = (source) =>
  typeof source === 'string' ? { path: source } : source;

/** @param {{ path: string, kind: string, state: string, summary: string, limits: string, document?: { digest: string, revision: string }, sources: (string | { path: string, digest: string, revision: string })[], checks: string[] }} record */
export function serializeRecordFile(record) {
  if (!record.document)
    return serializeMembers(
      ['path', 'kind', 'state', 'summary', 'limits', 'sources', 'checks'].map(
        (key) => [
          key,
          key === 'sources'
            ? record.sources.map((source) =>
                typeof source === 'string' ? source : source.path,
              )
            : record[key],
        ],
      ),
    );
  return serializeMembers([
    ['path', record.path],
    ['kind', record.kind],
    ['state', record.state],
    ['summary', record.summary],
    ['limits', record.limits],
    [
      'document',
      { digest: record.document.digest, revision: record.document.revision },
    ],
    ['sources', record.sources.map(binding)],
    ['checks', record.checks],
  ]);
}

/** @param {{ path: string, sources: { path: string, digest: string, revision: string }[], reviewNotes: string[] }} capture */
export function serializeCaptureReviewFile(capture) {
  return serializeMembers([
    ['path', capture.path],
    [
      'sources',
      capture.sources.map((source) =>
        typeof source === 'string'
          ? source
          : source.digest
            ? source
            : source.path,
      ),
    ],
    ['reviewNotes', capture.reviewNotes],
  ]);
}

/** @param {{ revision: string, notes: { path: string, note: string }[] }} run */
export function serializeNotesFile(run) {
  return serializeMembers([
    ['revision', run.revision],
    [
      'notes',
      run.notes.map(({ path, note, inputs }) => ({
        path,
        note,
        ...(inputs === undefined ? {} : { inputs }),
      })),
    ],
  ]);
}

/**
 * A note archive: each archived note's file name with its exact bytes, one per
 * line in name order. Archives are never edited, so no blank-line separators.
 * @param {Map<string, string>} notes repo-relative loose note file -> bytes
 */
export function serializeNoteArchive(notes) {
  const entries = [...notes]
    .map(([file, text]) => [file.slice(NOTES.length), text])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([name, text]) => `    ${JSON.stringify(name)}: ${JSON.stringify(text)}`,
    );
  return `{\n  "notes": {\n${entries.join(',\n')}\n  }\n}\n`;
}

/**
 * The notes an archive holds, by the loose file each one was.
 * @param {string} file repo-relative archive path
 * @param {string} text archive bytes
 * @returns {Map<string, string>} repo-relative loose note file -> exact bytes
 */
export function parseNoteArchive(file, text) {
  if (!ARCHIVE_NAME.test(file.slice(ARCHIVES.length)))
    throw reviewError(
      'unexpected-file',
      `Unexpected review note archive name: ${file}`,
      { file },
    );
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw reviewError(
      'invalid-json',
      `Review note archive is not valid JSON: ${file} (${error.message})`,
      { file },
    );
  }
  exactKeys(value, ['notes'], file);
  const notes = value.notes;
  if (
    !notes ||
    typeof notes !== 'object' ||
    Array.isArray(notes) ||
    !Object.keys(notes).length ||
    Object.entries(notes).some(
      ([name, bytes]) => !NOTE_NAME.test(name) || typeof bytes !== 'string',
    )
  )
    throw reviewError(
      'invalid-shape',
      `Review note archive must map note file names to their text: ${file}`,
      { file },
    );
  const archived = new Map(
    Object.entries(notes).map(([name, bytes]) => [`${NOTES}${name}`, bytes]),
  );
  if (serializeNoteArchive(archived) !== text)
    throw reviewError(
      'not-canonical',
      `Review note archive is not in its canonical layout: ${file}; archives are written only by npm run docs:review:record -- --advance-baseline`,
      { file },
    );
  return archived;
}

/** @param {{ version?: number, coverageBaseline?: string | null }} index */
export function serializeLedgerIndex(index) {
  return serializeMembers([
    ['version', index.version ?? REVIEW_LEDGER_VERSION],
    ['coverageBaseline', index.coverageBaseline ?? null],
  ]);
}

/**
 * The file name for a recording run: sortable time, then the content hash, so
 * concurrent runs on different branches never pick the same name.
 * @param {string} text serialized notes file
 * @param {Date} at
 */
export function notesFileName(text, at) {
  const time = at.toISOString().replace(/[-:]/g, '');
  return `${NOTES}${time}-${sha256(text).slice(0, 12)}.json`;
}

function exactKeys(value, keys, file) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw reviewError(
      'invalid-shape',
      `Review ledger file must have exactly ${keys.join(', ')}: ${file}`,
      { file },
    );
}

function parseCanonical(file, text, keys, serialize, requireLayout = true) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw reviewError(
      'invalid-json',
      `Review ledger file is not valid JSON: ${file} (${error.message})`,
      { file },
    );
  }
  exactKeys(value, keys, file);
  for (const key of keys)
    if (
      ['sources', 'checks', 'reviewNotes', 'notes'].includes(key) &&
      !Array.isArray(value[key])
    )
      throw reviewError(
        'invalid-shape',
        `Review ledger field ${key} must be an array: ${file}`,
        { file },
      );
  // A reformatted file loses the blank-line separators that keep independent
  // edits from conflicting, so only the serializer's exact bytes are accepted.
  if (requireLayout && serialize(value) !== text)
    throw reviewError(
      'not-canonical',
      `Review ledger file is not in its canonical layout: ${file}; write it with npm run docs:review:record (docs/guides/documentation.md)`,
      { file },
    );
  return value;
}

/** Parse one record file and confirm it sits at its document's path. */
export function parseRecordFile(file, text, recordLayout = 'canonical') {
  if (!['canonical', 'advisory-dependency-history'].includes(recordLayout))
    throw reviewError('invalid-shape', 'Unknown review record layout mode', {
      file,
    });
  // parseCanonical reports malformed JSON; this read only picks the layout.
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {}
  const keys =
    parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'document')
      ? RECORD_KEYS
      : RECORD_KEYS.filter((key) => key !== 'document');
  const record = parseCanonical(
    file,
    text,
    keys,
    serializeRecordFile,
    recordLayout === 'canonical',
  );
  if (!isLearningSourcePath(record.path) || recordFile(record.path) !== file)
    throw reviewError(
      'misplaced',
      `Review record is not stored at its path: ${file}`,
      { file },
    );
  const validIdentity = (value) =>
    typeof value.digest === 'string' &&
    typeof value.revision === 'string' &&
    /^[a-f0-9]{64}$/.test(value.digest) &&
    /^[a-f0-9]{40}$/.test(value.revision);
  // A path-only record names its sources; the older layout binds the document
  // and each source to digests. One record never mixes the two.
  const pathOnly = !Object.hasOwn(record, 'document');
  if (!pathOnly) {
    exactKeys(record.document, ['digest', 'revision'], file);
    if (!validIdentity(record.document))
      throw reviewError(
        'invalid-shape',
        `Invalid review document binding: ${file}`,
        { file },
      );
  }
  const seen = new Set();
  for (const source of record.sources) {
    if (!pathOnly) exactKeys(source, ['path', 'digest', 'revision'], file);
    const path = pathOnly ? source : source.path;
    if (
      (pathOnly ? typeof source !== 'string' : !validIdentity(source)) ||
      !isBindingPath(path) ||
      seen.has(path)
    )
      throw reviewError(
        'invalid-shape',
        `Invalid review source binding: ${file}`,
        { file },
      );
    seen.add(path);
  }
  return record;
}

function parseCaptureFile(file, text) {
  const capture = parseCanonical(
    file,
    text,
    CAPTURE_KEYS,
    serializeCaptureReviewFile,
  );
  if (
    !isLearningSourcePath(capture.path) ||
    captureReviewFile(capture.path) !== file
  )
    throw reviewError(
      'misplaced',
      `Capture review is not stored at its path: ${file}`,
      { file },
    );
  return capture;
}

function parseNotesFile(file, text) {
  const name = NOTE_NAME.exec(file.slice(NOTES.length));
  if (!file.startsWith(NOTES) || !name)
    throw reviewError(
      'unexpected-file',
      `Unexpected review notes file name: ${file}`,
      { file },
    );
  if (sha256(text).slice(0, 12) !== name[2])
    throw reviewError(
      'notes-edited',
      `Review notes are append-only; ${file} no longer matches its content hash. Add a new note with npm run docs:review:record instead of editing one.`,
      { file },
    );
  const run = parseCanonical(file, text, NOTES_KEYS, serializeNotesFile);
  if (!/^[a-f0-9]{40}$/.test(run.revision))
    throw reviewError(
      'invalid-shape',
      `Invalid review notes revision: ${file}`,
      { file },
    );
  for (const entry of run.notes) {
    exactKeys(
      entry,
      Object.hasOwn(entry, 'inputs')
        ? ['path', 'note', 'inputs']
        : ['path', 'note'],
      file,
    );
    if (
      entry.inputs !== undefined &&
      (!Array.isArray(entry.inputs) ||
        entry.inputs.some(
          (input) => !isLearningSourcePath(input.split('#')[0]),
        ) ||
        new Set(entry.inputs).size !== entry.inputs.length)
    )
      throw reviewError('invalid-shape', `Invalid covered inputs in ${file}`, {
        file,
      });
    if (
      !isLearningSourcePath(entry.path) ||
      typeof entry.note !== 'string' ||
      !entry.note.trim()
    )
      throw reviewError('invalid-shape', `Invalid review note in ${file}`, {
        file,
      });
  }
  return run;
}

/**
 * Parse every file of the ledger directory.
 * @param {Map<string, string>} files ledger-directory path -> text
 */
export function parseReviewLedgerFiles(
  files,
  { recordLayout = 'canonical', enforcePathBudget = true } = {},
) {
  const indexText = files.get(REVIEW_LEDGER_INDEX);
  if (indexText === undefined)
    throw reviewError(
      'missing-index',
      `Missing review ledger index: ${REVIEW_LEDGER_INDEX}`,
    );
  const index = parseCanonical(
    REVIEW_LEDGER_INDEX,
    indexText,
    INDEX_KEYS,
    serializeLedgerIndex,
  );
  if (![2, 3].includes(index.version))
    throw reviewError(
      'unsupported-version',
      `Documentation review ledger requires version ${REVIEW_LEDGER_VERSION}.`,
    );
  /** @type {Map<string, { file: string, data: any }>} */
  const records = new Map();
  /** @type {Map<string, { file: string, data: any }>} */
  const captures = new Map();
  const notes = [];
  /** @type {Map<string, string>} archive file -> its bytes */
  const archives = new Map();
  /** @type {Map<string, string>} note file -> where it is stored */
  const stored = new Map();
  const addNote = (file, text, archive) => {
    if (stored.has(file))
      throw reviewError(
        'duplicate-note',
        `Review note ${file} is stored twice (${stored.get(file)} and ${archive ?? file}); a note lives either loose or in one archive`,
        { file },
      );
    stored.set(file, archive ?? file);
    notes.push({
      file,
      data: parseNotesFile(file, text),
      ...(archive === undefined ? {} : { archive }),
    });
  };
  for (const file of files.keys())
    if (enforcePathBudget && file.length > REVIEW_LEDGER_PATH_BUDGET)
      throw reviewError(
        'path-too-long',
        `Review ledger path is ${file.length} characters, over the ${REVIEW_LEDGER_PATH_BUDGET} budget that keeps checkouts under the Windows 260-character limit: ${file}; shorten or move the document`,
        { file },
      );
  for (const [file, text] of [...files].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (file === REVIEW_LEDGER_INDEX) continue;
    if (file.startsWith(RECORDS)) {
      const data = parseRecordFile(file, text, recordLayout);
      records.set(data.path, { file, data });
    } else if (file.startsWith(CAPTURES)) {
      const data = parseCaptureFile(file, text);
      captures.set(data.path, { file, data });
    } else if (file.startsWith(ARCHIVES)) {
      archives.set(file, text);
      for (const [note, bytes] of parseNoteArchive(file, text))
        addNote(note, bytes, file);
    } else if (file.startsWith(NOTES)) {
      addNote(file, text);
    } else
      throw reviewError(
        'unexpected-file',
        `Unexpected file in the review ledger: ${file}`,
        { file },
      );
  }
  // Archived notes predate every loose one but sort after notes/2…; keep the
  // single store in file-name (time) order whatever the storage.
  notes.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { index, records, captures, notes, archives };
}

/** Event notes by reviewed path, in file-name (time) order. */
function notesByPath(notes) {
  const byPath = new Map();
  for (const { file, data } of notes)
    for (const { path, note, inputs } of data.notes) {
      const list = byPath.get(path) ?? [];
      list.push({
        file,
        revision: data.revision,
        note,
        ...(inputs === undefined ? {} : { inputs }),
      });
      byPath.set(path, list);
    }
  return byPath;
}

/**
 * The shared compiled record: old byte bindings or derived history metadata.
 * @returns {{ path: string, kind: string, state: string, summary: string, limits: string, documentDigest?: string, documentRevision?: string, historyChanges?: string[], reviewBaseline?: string, historyUnavailable?: string, sources: { path: string, digest?: string, revision?: string }[], checks: string[], notes: { file: string, revision: string, note: string, inputs?: string[] }[] }}
 */
function compileRecord(data, notes = []) {
  return {
    path: data.path,
    kind: data.kind,
    state: data.state,
    summary: data.summary,
    limits: data.limits,
    ...(data.document
      ? {
          documentDigest: data.document.digest,
          documentRevision: data.document.revision,
        }
      : { historyChanges: [] }),
    sources: data.sources.map(binding),
    checks: [...new Set([...data.checks, ...notes.map(({ note }) => note)])],
    notes,
  };
}

function compileCaptureReview(data, notes = []) {
  return {
    ...(data.sources.every((source) => typeof source === 'string')
      ? { historyChanges: [] }
      : {}),
    sources: data.sources.map(binding),
    reviewNotes: [
      ...new Set([...data.reviewNotes, ...notes.map(({ note }) => note)]),
    ],
    notes,
  };
}

/**
 * Join capture metadata from media.json with its review. Every capture needs
 * exactly one review file and the reverse.
 * @param {any} manifest parsed media.json
 * @param {Map<string, any>} reviews path -> compiled capture review
 */
function joinLearningMedia(manifest, reviews) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.captures))
    throw reviewError(
      'unsupported-version',
      'Learning media requires version 1 captures.',
    );
  const seen = new Set();
  const captures = manifest.captures.map((capture) => {
    const field = CAPTURE_REVIEW_FIELDS.find((key) =>
      Object.hasOwn(capture ?? {}, key),
    );
    if (field)
      throw reviewError(
        'capture-review-mismatch',
        `${LEARNING_MEDIA_MANIFEST} must not carry the review field ${field}: ${capture.path}; capture reviews live in ${CAPTURES}`,
      );
    const review = reviews.get(capture?.path);
    if (!review)
      throw reviewError(
        'capture-review-mismatch',
        `Missing capture review: ${captureReviewFile(capture?.path)}`,
      );
    seen.add(capture.path);
    return { ...capture, ...review };
  });
  for (const path of reviews.keys())
    if (!seen.has(path))
      throw reviewError(
        'capture-review-mismatch',
        `Capture review without a capture in ${LEARNING_MEDIA_MANIFEST}: ${path}`,
      );
  return { version: 1, captures };
}

/**
 * Compile parsed ledger files (and optionally the capture manifest).
 * @param {ReturnType<typeof parseReviewLedgerFiles>} parsed
 * @param {any} [manifest] parsed media.json, when tracked
 * @returns {{ ledger: { version: number, coverageBaseline?: string, layoutVersion?: number, historyUnavailable?: string, records: ReturnType<typeof compileRecord>[] }, media: ReturnType<typeof joinLearningMedia> | undefined }}
 */
export function compileReviewState(parsed, manifest) {
  const byPath = notesByPath(parsed.notes);
  const records = [...parsed.records.values()]
    .map(({ data }) => compileRecord(data, byPath.get(data.path)))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const reviews = new Map(
    [...parsed.captures.values()].map(({ data }) => [
      data.path,
      compileCaptureReview(data, byPath.get(data.path)),
    ]),
  );
  if (manifest === undefined && reviews.size)
    throw reviewError(
      'capture-review-mismatch',
      `Capture reviews exist but ${LEARNING_MEDIA_MANIFEST} is not tracked`,
    );
  return {
    ledger: {
      version: REVIEW_LEDGER_VERSION,
      coverageBaseline: parsed.index.coverageBaseline ?? undefined,
      ...(parsed.index.version === 3 ? { layoutVersion: 3 } : {}),
      records,
    },
    media:
      manifest === undefined ? undefined : joinLearningMedia(manifest, reviews),
  };
}

/** The pre-#2936 single ledger file, compiled into the current shape. */
function fromLegacyReviewLedger(legacy) {
  if (legacy?.version !== 1 || !Array.isArray(legacy.records))
    throw reviewError(
      'unsupported-version',
      'Legacy review ledger requires version 1 records.',
    );
  return {
    version: REVIEW_LEDGER_VERSION,
    coverageBaseline: legacy.coverageBaseline ?? undefined,
    records: legacy.records.map((record) =>
      compileRecord({
        ...record,
        document: {
          digest: record.documentDigest,
          revision: record.sourceRevision,
        },
        sources: (record.sources ?? []).map((source) => ({
          ...source,
          revision: record.sourceRevision,
        })),
      }),
    ),
  };
}

/** A pre-#2936 media.json, whose captures carried their own review. */
function fromLegacyMedia(legacy) {
  return {
    version: legacy.version,
    captures: legacy.captures.map((capture) => {
      const {
        sources = [],
        reviewedRevision,
        reviewNotes = [],
        ...metadata
      } = capture;
      return {
        ...metadata,
        ...compileCaptureReview({
          sources: sources.map((source) => ({
            ...source,
            revision: reviewedRevision,
          })),
          reviewNotes,
        }),
      };
    }),
  };
}

const isLegacyMedia = (manifest) =>
  Array.isArray(manifest?.captures) &&
  manifest.captures.some((capture) =>
    Object.hasOwn(capture ?? {}, 'reviewedRevision'),
  );

function git(root, args, input) {
  return execFileSync('git', args, {
    cwd: root,
    input,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

const lsTree = (root, ref, dir) =>
  git(root, ['ls-tree', '-r', '-z', '--name-only', ref, '--', dir])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);

/**
 * Loose note files (repo-relative) at a commit; archives are not notes.
 * @param {string} root
 * @param {string} ref
 */
export function listReviewNoteFilesAt(root, ref) {
  return lsTree(root, ref, NOTES).filter((file) => !isNoteArchiveFile(file));
}

/**
 * Note archive files (repo-relative) at a commit.
 * @param {string} root
 * @param {string} ref
 */
export function listNoteArchiveFilesAt(root, ref) {
  return lsTree(root, ref, ARCHIVES);
}

/**
 * Every note committed at a commit, loose or archived, by its note file name.
 * @param {string} root
 * @param {string} ref
 */
function listCommittedNoteFilesAt(root, ref) {
  const archives = listNoteArchiveFilesAt(root, ref);
  const blobs = readGitObjects(
    root,
    archives.map((file) => `${ref}:${file}`),
  );
  return new Set([
    ...listReviewNoteFilesAt(root, ref),
    ...archives.flatMap((file, index) => [
      ...parseNoteArchive(file, blobs[index].toString('utf8')).keys(),
    ]),
  ]);
}

/**
 * Write a batch of ledger files, rolling every change back if one write fails
 * (#3036). Existing files get their prior bytes back and files this call
 * created are removed; anything that cannot be restored is listed. A file
 * mapped to `undefined` is removed (note compaction, #3394), and restored on
 * rollback like any other.
 * @param {string} root
 * @param {Map<string, string | undefined>} after repo-relative file -> new text, or undefined to remove it
 * @param {Map<string, string>} before repo-relative file -> prior text
 * @returns {string[]} files written or removed
 */
export function writeReviewFiles(root, after, before) {
  const touched = [];
  try {
    for (const [file, text] of after) {
      if (text !== undefined && before.get(file) === text) continue;
      const target = nodePath.join(root, file);
      const prior = existsSync(target) ? readFileSync(target) : undefined;
      if (text === undefined) {
        if (prior === undefined) continue;
        touched.push({ file, target, prior });
        rmSync(target);
        continue;
      }
      mkdirSync(nodePath.dirname(target), { recursive: true });
      touched.push({ file, target, prior });
      writeFileSync(target, text);
    }
  } catch (cause) {
    const unrestored = [];
    for (const { file, target, prior } of [...touched].reverse()) {
      try {
        if (prior === undefined) rmSync(target, { force: true });
        else writeFileSync(target, prior);
      } catch {
        unrestored.push(file);
      }
    }
    throw reviewError(
      'write-failed',
      `Writing the review ledger failed (${cause instanceof Error ? cause.message : String(cause)}); ${
        unrestored.length
          ? `could not restore: ${unrestored.join(', ')}`
          : 'every file written so far was restored'
      }`,
      { unrestored, cause },
    );
  }
  return touched.map(({ file }) => file);
}

/**
 * Plan the compaction that `--advance-baseline` writes (#3394): every loose
 * note that was already in the tree at the previous coverage baseline moves,
 * byte for byte, into one archive named for that baseline, and the loose file
 * goes. Notes added after it stay loose, so a baseline advance archives only
 * what the advance before it had already covered.
 * @param {string} root clean working tree
 * @param {ReturnType<typeof parseReviewLedgerFiles>} parsed its ledger files
 * @returns {{ archive?: string, archived: string[], after: Map<string, string | undefined> }}
 */
export function planNoteCompaction(root, parsed) {
  const baseline = parsed.index.coverageBaseline;
  const after = new Map();
  if (!baseline) return { archived: [], after };
  const landed = new Set(listReviewNoteFilesAt(root, baseline));
  const archived = parsed.notes
    .filter(({ file, archive }) => archive === undefined && landed.has(file))
    .map(({ file }) => file);
  if (!archived.length) return { archived, after };
  const archive = noteArchiveFile(baseline);
  if (parsed.archives.has(archive))
    throw reviewError(
      'archive-exists',
      `${archive} already exists and archives are never rewritten; notes still loose from that baseline need a separate review`,
      { file: archive },
    );
  const reader = createLearningSourceReader(root);
  const bytes = new Map(
    archived.map((file) => [file, reader.read(file).toString('utf8')]),
  );
  after.set(archive, serializeNoteArchive(bytes));
  for (const file of archived) after.set(file, undefined);
  return { archive, archived, after };
}

/** Working-tree ledger files, tracked or not yet added. */
export function listReviewLedgerFiles(root) {
  const reader = createLearningSourceReader(root);
  return git(root, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    REVIEW_LEDGER_DIR,
  ])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((file, index, all) => all.indexOf(file) === index)
    .filter((file) => reader.exists(file));
}

/**
 * The raw ledger files and capture manifest in a working tree, parsed.
 * @param {string} root
 */
export function readReviewFiles(root) {
  const reader = createLearningSourceReader(root);
  const text = new Map(
    listReviewLedgerFiles(root).map((file) => [
      file,
      reader.read(file).toString('utf8'),
    ]),
  );
  const mediaText = reader.exists(LEARNING_MEDIA_MANIFEST)
    ? reader.read(LEARNING_MEDIA_MANIFEST).toString('utf8')
    : undefined;
  return {
    parsed: parseReviewLedgerFiles(text),
    manifest: mediaText === undefined ? undefined : JSON.parse(mediaText),
  };
}

/**
 * The compiled ledger and capture manifest of a working tree.
 * @param {string} root
 */
export function readReviewState(root, { history = true } = {}) {
  const { parsed, manifest } = readReviewFiles(root);
  const state = compileReviewState(parsed, manifest);
  if (history && parsed.index.version === 3)
    deriveReviewHistory(root, state, () =>
      listCommittedNoteFilesAt(root, 'HEAD'),
    );
  return state;
}

function readBlobsAt(root, ref, paths) {
  const objects = readGitObjects(
    root,
    paths.map((path) => `${ref}:${path}`),
  );
  return new Map(
    paths.flatMap((path, index) =>
      objects[index] === undefined ? [] : [[path, objects[index]]],
    ),
  );
}

/**
 * The compiled ledger and capture manifest at a commit, in either layout.
 * `ledger` or `media` is undefined when that commit has none.
 * @param {string} root
 * @param {string} ref
 */
export function readReviewStateAt(root, ref, { purpose } = {}) {
  const files = git(root, [
    'ls-tree',
    '-r',
    '-z',
    '--name-only',
    ref,
    '--',
    REVIEW_LEDGER_DIR,
  ])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const blobs = readBlobsAt(root, ref, [
    ...files,
    LEGACY_REVIEW_LEDGER,
    LEARNING_MEDIA_MANIFEST,
  ]);
  const json = (path) =>
    blobs.has(path) ? JSON.parse(blobs.get(path).toString('utf8')) : undefined;
  const manifest = json(LEARNING_MEDIA_MANIFEST);
  if (files.length) {
    const compiled = compileReviewState(
      parseReviewLedgerFiles(
        new Map(files.map((file) => [file, blobs.get(file).toString('utf8')])),
        {
          // History and base reads must still parse a ledger that carries an
          // over-budget path, or no PR could delete it. The budget guards the
          // working tree (readReviewFiles) and what the record command writes.
          enforcePathBudget: false,
          recordLayout:
            purpose === 'advisory-dependency-history'
              ? 'advisory-dependency-history'
              : 'canonical',
        },
      ),
      manifest,
    );
    return compiled;
  }
  const legacy = json(LEGACY_REVIEW_LEDGER);
  return {
    ledger: legacy === undefined ? undefined : fromLegacyReviewLedger(legacy),
    media:
      manifest === undefined
        ? undefined
        : isLegacyMedia(manifest)
          ? fromLegacyMedia(manifest)
          : joinLearningMedia(manifest, new Map()),
  };
}

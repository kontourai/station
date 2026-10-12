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
// other; Git leaves the branch's version in the working tree). Run this command
// during that merge with `--base` set to the merge base. Each record the branch
// changed since the base is folded into the per-record files: changed bindings
// and source edits are applied, in-place edits to earlier checks are carried,
// and appended checks become one new notes file. Where both sides rebound one
// binding differently, the binding whose hash matches the current bytes wins;
// if neither does, the record stays stale for the freshness check. A conflicted
// media.json is merged field by field, the old-layout side keeping its review
// fields; a field both sides changed differently stops the command.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createLearningSourceReader } from './lib/learning-source-reader.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { bindingDigest, bindingFile } from './lib/review-binding.mjs';
import {
  captureReviewFile,
  isNoteArchiveFile,
  LEARNING_MEDIA_MANIFEST,
  LEGACY_REVIEW_LEDGER,
  listReviewLedgerFiles,
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
  // The old single file was merged as text, so a branch's checks are the
  // base's plus its own, not always in base order. Compare them as sets: a
  // check the base lacks is new, and a base check the branch lacks was edited
  // in place (such as a redaction) or removed.
  const [baseNotes, theirNotes] = [base, theirs].map(
    (entry) => entry[notesKey] ?? [],
  );
  const added = theirNotes.filter((note) => !baseNotes.includes(note));
  const carried = [...(data[notesKey] ?? [])];
  for (const [index, note] of baseNotes.entries()) {
    if (theirNotes.includes(note)) continue;
    // Carry a one-for-one replacement of a note ours still holds unchanged;
    // notes files are append-only, and anything else is ambiguous.
    const replacement = theirNotes[index];
    const at = carried.indexOf(note);
    if (added.includes(replacement) && at !== -1) {
      carried[at] = replacement;
      added.splice(added.indexOf(replacement), 1);
    } else report.edited = true;
  }
  data[notesKey] = carried;
  report.notes = added;
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

/** The side (`ours`/`theirs`) whose media.json blob still has review fields. */
const hasReviewFields = (manifest) =>
  (manifest?.captures ?? []).some((capture) =>
    REVIEW_FIELDS.some((field) => Object.hasOwn(capture, field)),
  );

/**
 * Three-way merge of one value: the side that changed it wins; both changing
 * it differently is a conflict (reported as `CONFLICT`).
 */
const CONFLICT = Symbol('conflict');
function mergeValue(base, branch, migrated) {
  if (same(branch, base)) return migrated;
  if (same(migrated, base) || same(branch, migrated)) return branch;
  return CONFLICT;
}

const withoutReview = (capture) =>
  capture &&
  Object.fromEntries(
    Object.entries(capture).filter(([key]) => !REVIEW_FIELDS.includes(key)),
  );

/**
 * Merge media.json field by field. The branch (the side that still has the
 * old ledger) owns the review fields; every other field merges three-way, so
 * an edit on either side survives however close it sits to the review block.
 * Throws, naming each field, where both sides changed one differently.
 */
function mergeManifests(base, branch, migrated) {
  const conflicts = [];
  const merged = {};
  for (const key of new Set([...Object.keys(migrated), ...Object.keys(branch)]))
    if (key !== 'captures') {
      const value = mergeValue(base[key], branch[key], migrated[key]);
      if (value === CONFLICT) conflicts.push(key);
      else if (value !== undefined) merged[key] = value;
    }
  const byPath = (manifest) =>
    new Map(
      (manifest.captures ?? []).map((capture) => [capture.path, capture]),
    );
  const [b, x, m] = [base, branch, migrated].map(byPath);
  const paths = [
    ...m.keys(),
    ...[...x.keys()].filter((capturePath) => !m.has(capturePath)),
  ];
  merged.captures = [];
  for (const capturePath of paths) {
    const [baseCapture, branchCapture, migratedCapture] = [b, x, m].map(
      (captures) => captures.get(capturePath),
    );
    const metadata = mergeValue(
      withoutReview(baseCapture),
      withoutReview(branchCapture),
      withoutReview(migratedCapture),
    );
    if (metadata === undefined) continue;
    if (!branchCapture || !migratedCapture) {
      // Added on one side, or deleted on one side and left alone on the other.
      if (metadata === CONFLICT)
        conflicts.push(
          `${capturePath} (deleted on one side, edited on the other)`,
        );
      else merged.captures.push({ ...metadata, ...reviewOf(branchCapture) });
      continue;
    }
    const capture = {};
    for (const key of new Set([
      ...Object.keys(migratedCapture),
      ...Object.keys(branchCapture),
    ])) {
      if (REVIEW_FIELDS.includes(key)) continue;
      const value = mergeValue(
        baseCapture?.[key],
        branchCapture[key],
        migratedCapture[key],
      );
      if (value === CONFLICT) conflicts.push(`${capturePath} ${key}`);
      else if (value !== undefined) capture[key] = value;
    }
    merged.captures.push({ ...capture, ...reviewOf(branchCapture) });
  }
  if (conflicts.length)
    throw new Error(
      `${LEARNING_MEDIA_MANIFEST}: both sides changed ${conflicts.join(', ')}; resolve those by hand, keeping the old-layout side's review fields, and rerun`,
    );
  return merged;
}

const reviewOf = (capture) =>
  Object.fromEntries(
    Object.entries(capture ?? {}).filter(([key]) =>
      REVIEW_FIELDS.includes(key),
    ),
  );

/**
 * During the merge, media.json conflicts where one side removed the capture
 * review fields and the other edited them. Git can also auto-merge away
 * those fields. Merge the parent manifests structurally in either case;
 * review fields move out below. Returns whether it folded a layout merge.
 */
function resolveConflictedManifest(root, mergeBase) {
  const stages = unmergedStages(root, LEARNING_MEDIA_MANIFEST);
  let refs;
  if (stages.size === 0) {
    if (mergeBase === undefined) return false;
    refs = [mergeBase, 'HEAD', 'MERGE_HEAD'].map(
      (ref) => `${ref}:${LEARNING_MEDIA_MANIFEST}`,
    );
  } else {
    if (mergeBase === undefined)
      throw new Error(
        `${LEARNING_MEDIA_MANIFEST} is conflicted; pass --base <merge base> to fold it`,
      );
    if (!['1', '2', '3'].every((stage) => stages.has(stage)))
      throw new Error(
        `${LEARNING_MEDIA_MANIFEST} was added or deleted on one side; resolve it and rerun`,
      );
    refs = ['1', '2', '3'].map(
      (stage) => `:${stage}:${LEARNING_MEDIA_MANIFEST}`,
    );
  }
  const blobs = readGitObjects(root, refs);
  if (stages.size === 0 && blobs.some((bytes) => bytes === undefined))
    return false;
  const [base, ours, theirs] = blobs.map((bytes) =>
    JSON.parse(bytes.toString('utf8')),
  );
  const [branch, migrated] =
    hasReviewFields(ours) && !hasReviewFields(theirs)
      ? [ours, theirs]
      : hasReviewFields(theirs) && !hasReviewFields(ours)
        ? [theirs, ours]
        : [];
  if (!branch) {
    if (stages.size === 0) return false;
    throw new Error(
      `${LEARNING_MEDIA_MANIFEST} conflicts, but not between the old and new layouts; resolve it and rerun`,
    );
  }
  const working =
    stages.size === 0
      ? JSON.parse(
          createLearningSourceReader(root)
            .read(LEARNING_MEDIA_MANIFEST)
            .toString('utf8'),
        )
      : migrated;
  const merged = mergeManifests(base, branch, working);
  if (stages.size === 0) {
    // Preserve review edits made after Git's automatic merge.
    const captures = new Map(
      working.captures.map((capture) => [capture.path, capture]),
    );
    for (const capture of merged.captures)
      Object.assign(capture, reviewOf(captures.get(capture.path)));
  }
  writeFileSync(
    path.join(root, LEARNING_MEDIA_MANIFEST),
    serializeLearningMedia(merged),
  );
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
  const resolvedManifest = resolveConflictedManifest(root, base);
  const reader = createLearningSourceReader(root);
  const hasLedger = reader.exists(LEGACY_REVIEW_LEDGER);
  // A branch that re-reviewed only captures left the old ledger alone, so the
  // merge deleted it cleanly; fold its captures against the base's records.
  if (!hasLedger && !(resolvedManifest && base !== undefined))
    throw new Error(`No ${LEGACY_REVIEW_LEDGER} to migrate`);
  const theirs = hasLedger
    ? JSON.parse(reader.read(LEGACY_REVIEW_LEDGER).toString('utf8'))
    : legacyAt(root, base).ledger;
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
  rmSync(path.join(root, LEGACY_REVIEW_LEDGER), { force: true });
  return {
    resolvedManifest,
    written: [...files.keys()].filter((file) => files.get(file) !== undefined),
    removed: [...files.keys()].filter((file) => files.get(file) === undefined),
    notes: notes.length,
    stale,
    edited,
  };
}

/** Drop derived bindings deterministically, including old-layout merge stages. */
function migratePathOnly(root) {
  const files = listReviewLedgerFiles(root);
  const index = JSON.parse(
    readFileSync(path.join(root, REVIEW_LEDGER_INDEX), 'utf8'),
  );
  const baseline =
    index.version === 3
      ? index.coverageBaseline
      : git(root, ['rev-parse', 'HEAD']).trim();
  const planned = new Map();
  const decisions = new Map();
  const normalize = (data) => {
    const { document: _document, ...human } = data;
    return {
      ...human,
      sources: data.sources.map((source) =>
        typeof source === 'string' ? source : source.path,
      ),
    };
  };
  for (const file of files.filter((file) =>
    /\/(records|captures)\//.test(file),
  )) {
    const stages = unmergedStages(root, file);
    let data;
    if (stages.size) {
      const [base, ours, theirs] = readGitObjects(
        root,
        ['1', '2', '3'].map((stage) => `:${stage}:${file}`),
      ).map((bytes) =>
        bytes === undefined
          ? undefined
          : normalize(JSON.parse(bytes.toString('utf8'))),
      );
      if (!base || !ours || !theirs)
        throw new Error(
          `${file}: record added/deleted on one side; resolve the human decision before migrating`,
        );
      data = {};
      for (const key of Object.keys(ours)) {
        if (key === 'sources') {
          data.sources = [
            ...new Set([
              ...ours.sources.filter(
                (source) =>
                  !base.sources.includes(source) ||
                  theirs.sources.includes(source),
              ),
              ...theirs.sources.filter(
                (source) => !base.sources.includes(source),
              ),
            ]),
          ];
        } else {
          const value = mergeValue(base[key], ours[key], theirs[key]);
          if (value === CONFLICT)
            throw new Error(
              `${file}: both sides changed human field ${key}; resolve it before migrating`,
            );
          data[key] = value;
        }
      }
    } else
      data = normalize(JSON.parse(readFileSync(path.join(root, file), 'utf8')));
    const text = file.includes('/records/')
      ? serializeRecordFile(data)
      : serializeCaptureReviewFile(data);
    planned.set(file, text);
    decisions.set(data.path, data);
  }
  const [mergeHead] = readGitObjects(root, ['MERGE_HEAD^{commit}']);
  if (index.version === 3 && mergeHead !== undefined) {
    const base = git(root, ['merge-base', 'HEAD', 'MERGE_HEAD']).trim();
    // Archives (#3394) hold only notes older than any merge base; they are
    // never rewritten, so only loose notes can need covered inputs.
    for (const file of files.filter(
      (file) => file.includes('/notes/') && !isNoteArchiveFile(file),
    )) {
      const run = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
      if (
        run.notes.every((note) => note.inputs !== undefined) ||
        readGitObjects(root, [`${base}:${file}`])[0] !== undefined
      )
        continue;
      const introduction = git(root, [
        'log',
        '--format=%H',
        '--diff-filter=A',
        '-1',
        'HEAD',
        '--',
        file,
      ]).trim();
      const covered = run.notes.map((note) => {
        if (note.inputs !== undefined) return note;
        const record = decisions.get(note.path);
        const owner = record?.checks
          ? recordFile(note.path)
          : captureReviewFile(note.path);
        const [before, after] = readGitObjects(root, [
          `${base}:${owner}`,
          `${introduction || 'HEAD'}:${owner}`,
        ]).map((bytes) =>
          bytes === undefined ? undefined : JSON.parse(bytes.toString('utf8')),
        );
        // Only old binding lines the branch reviewed grant coverage. When the
        // old state is unavailable, retain the note with document-only coverage.
        const bindings = (data) =>
          new Map(
            (data?.sources ?? [])
              .filter((source) => typeof source !== 'string')
              .map((source) => [source.path, source]),
          );
        const old = bindings(before);
        const reviewed = [...bindings(after)]
          .filter(
            ([input, binding]) =>
              JSON.stringify(old.get(input)) !== JSON.stringify(binding),
          )
          .map(([input]) => input);
        const document =
          before?.document &&
          after?.document &&
          JSON.stringify(before.document) !== JSON.stringify(after.document);
        return {
          ...note,
          inputs:
            !before ||
            !after ||
            !introduction ||
            (!after.document &&
              !after.sources.some((source) => typeof source !== 'string'))
              ? [note.path]
              : [...(document ? [note.path] : []), ...reviewed],
        };
      });
      const text = serializeNotesFile({
        revision: run.revision,
        notes: covered,
      });
      const time = file.split('/').at(-1).slice(0, 20);
      const date = new Date(
        `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}T${time.slice(9, 11)}:${time.slice(11, 13)}:${time.slice(13)}`,
      );
      planned.set(file, undefined);
      planned.set(notesFileName(text, date), text);
    }
  }
  planned.set(
    REVIEW_LEDGER_INDEX,
    serializeLedgerIndex({ version: 3, coverageBaseline: baseline }),
  );
  for (const [file, text] of planned) {
    const target = path.join(root, file);
    if (text === undefined) {
      rmSync(target, { force: true });
      continue;
    }
    if (
      !createLearningSourceReader(root).exists(file) ||
      readFileSync(target, 'utf8') !== text
    ) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  }
  return {
    records: files.filter((file) => file.includes('/records/')).length,
    captures: files.filter((file) => file.includes('/captures/')).length,
    baseline,
  };
}

export function main(argv = process.argv.slice(2)) {
  let base;
  let pathOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--path-only') {
      pathOnly = true;
      continue;
    }
    if (
      argv[index] === '--base' &&
      argv[index + 1] &&
      !argv[index + 1].startsWith('-')
    )
      base = argv[++index];
    else throw new Error(USAGE);
  }
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  if (
    pathOnly ||
    (!createLearningSourceReader(root).exists(LEGACY_REVIEW_LEDGER) &&
      createLearningSourceReader(root).exists(REVIEW_LEDGER_INDEX) &&
      !unmergedStages(root, LEARNING_MEDIA_MANIFEST).size)
  ) {
    const result = migratePathOnly(root);
    console.log(
      `Path-only ledger: ${result.records} records, ${result.captures} captures; coverage baseline ${result.baseline}.`,
    );
    return;
  }
  const result = migrateReviewLedger({ root, base });
  console.log(
    `Migrated ${LEGACY_REVIEW_LEDGER}: wrote ${result.written.length} file(s), removed ${result.removed.length}, ${result.notes} note(s) from appended checks.`,
  );
  if (result.resolvedManifest)
    console.log(
      `Resolved the ${LEARNING_MEDIA_MANIFEST} layout merge: kept the old-layout side's review fields, moved them into the ledger, and kept the other side's remaining edits.`,
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

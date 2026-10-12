import { execFileSync } from 'node:child_process';
import { bindingDigest, bindingFile } from './review-binding.mjs';
import { readGitObjects } from './review-git.mjs';
import {
  isNoteArchiveFile,
  REVIEW_LEDGER_DIR,
  REVIEW_NOTES_DIR,
} from './review-ledger-paths.mjs';

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

const entries = (state) => [
  ...(state.ledger?.records ?? []),
  ...(state.media?.captures ?? []),
];
const inputs = (entry) => [
  entry.path,
  ...entry.sources.map((source) => source.path),
];
const notes = (entry) => entry?.notes ?? [];
// A note archive (#3394) holds notes added at or before an earlier baseline;
// adding one moves old notes, it never records a review in this range.
const addedNote = (status, file) =>
  status === 'A' &&
  file.startsWith(REVIEW_NOTES_DIR) &&
  !isNoteArchiveFile(file);

/** Compare human decisions across layouts, ignoring old derived bindings. */
export function reviewDecisionChanged(before, after) {
  const decision = (entry) =>
    entry &&
    JSON.stringify([
      entry.path,
      entry.kind,
      entry.state,
      entry.summary,
      entry.limits,
      entry.sources.map((source) => source.path).sort(),
      entry.alt,
      entry.caption,
      entry.scenario,
      entry.evidence,
      entry.digest,
      entry.capturedRevision,
      entry.documents,
    ]);
  return decision(before) !== decision(after);
}

/** Compare cited JSON values, rather than treating every manifest edit as relevant. */
export function touchedReviewInputs(root, paths, changedPaths, before, after) {
  const candidates = paths.filter((input) =>
    changedPaths.has(bindingFile(input)),
  );
  const values = candidates.filter((input) => input !== bindingFile(input));
  const objects = readGitObjects(
    root,
    values.flatMap((input) => [
      `${before}:${bindingFile(input)}`,
      `${after}:${bindingFile(input)}`,
    ]),
  );
  const changedValues = new Set(
    values.filter((input, index) => {
      const a = objects[index * 2];
      const b = objects[index * 2 + 1];
      return (
        a === undefined ||
        b === undefined ||
        bindingDigest(input, a) !== bindingDigest(input, b)
      );
    }),
  );
  return candidates.filter(
    (input) => input === bindingFile(input) || changedValues.has(input),
  );
}

/** One stream of landing units; callers choose the range, never one log per commit. */
function landingChanges(root, range) {
  const tokens = git(root, [
    'log',
    '--first-parent',
    '--reverse',
    '--format=%x00COMMIT:%H',
    '--name-status',
    '-z',
    '--diff-merges=first-parent',
    '--no-renames',
    range,
  ]).split('\0');
  const commits = [];
  let current;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].trim();
    if (token.startsWith('COMMIT:')) {
      current = { revision: token.slice(7), changes: [] };
      commits.push(current);
    } else if (/^[AMDT]$/.test(token) && current) {
      current.changes.push({ status: token, file: tokens[++index] });
    }
  }
  return commits;
}

/**
 * Use HEAD's dependency lists throughout history. Removed citations stop tracking
 * old changes; new citations can expose old changes. Scoped checks separately
 * compare both ends of the PR and retain source-drop protection.
 * @param {string} root
 * @param {any} state compiled review state
 * @param {() => Set<string>} committedNotes every note committed at HEAD,
 * loose or archived, by note file name
 */
export function deriveReviewHistory(root, state, committedNotes) {
  const baseline = state.ledger.coverageBaseline;
  const current = entries(state).filter(
    (entry) => entry.historyChanges !== undefined,
  );
  let commits;
  try {
    if (git(root, ['rev-parse', '--is-shallow-repository']) === 'true')
      throw new Error('shallow checkout');
    if (!baseline || !/^[a-f0-9]{40}$/.test(baseline))
      throw new Error('missing or invalid coverage baseline');
    git(root, ['merge-base', '--is-ancestor', baseline, 'HEAD']);
    commits = landingChanges(root, `${baseline}..HEAD`);
  } catch (error) {
    state.ledger.historyUnavailable = `Review history unavailable: ${String(error.message).split('\n')[0]}. Fetch full history and restore a reachable coverage baseline before judging freshness.`;
    for (const entry of current)
      entry.historyUnavailable = state.ledger.historyUnavailable;
    return;
  }
  const capturePaths = new Set(
    (state.media?.captures ?? []).map((entry) => entry.path),
  );
  const recordPath = (entry) =>
    `${REVIEW_LEDGER_DIR}/${capturePaths.has(entry.path) ? 'captures' : 'records'}/${entry.path}.json`;
  const owned = new Map(current.map((entry) => [recordPath(entry), entry]));
  const pointers = [
    ...new Set(
      current.flatMap(inputs).filter((input) => input !== bindingFile(input)),
    ),
  ];
  const specs = new Set([
    'HEAD:docs/learn/media.json',
    ...current.map((entry) => `HEAD:${recordPath(entry)}`),
  ]);
  for (const commit of commits) {
    const changed = new Set(commit.changes.map(({ file }) => file));
    if (changed.has('docs/learn/media.json')) {
      specs.add(`${commit.revision}^1:docs/learn/media.json`);
      specs.add(`${commit.revision}:docs/learn/media.json`);
    }
    for (const { status, file } of commit.changes) {
      if (addedNote(status, file)) specs.add(`${commit.revision}:${file}`);
      if (owned.has(file)) {
        specs.add(`${commit.revision}^1:${file}`);
        specs.add(`${commit.revision}:${file}`);
      }
    }
    for (const input of pointers)
      if (changed.has(bindingFile(input))) {
        specs.add(`${commit.revision}^1:${bindingFile(input)}`);
        specs.add(`${commit.revision}:${bindingFile(input)}`);
      }
  }
  const requested = [...specs];
  const blobs = new Map(
    readGitObjects(root, requested).map((bytes, index) => [
      requested[index],
      bytes,
    ]),
  );
  const json = (spec) =>
    blobs.get(spec) === undefined
      ? undefined
      : JSON.parse(blobs.get(spec).toString('utf8'));
  const captureMetadata = (ref, file) =>
    json(`${ref}:docs/learn/media.json`)?.captures.find(
      (capture) => capture.path === file,
    );
  const decision = (data) =>
    data && {
      ...data,
      sources: data.sources.map((source) =>
        typeof source === 'string' ? { path: source } : source,
      ),
    };
  const pending = new Map(current.map((entry) => [entry.path, new Set()]));
  for (const commit of commits) {
    const changed = new Set(commit.changes.map(({ file }) => file));
    for (const entry of current) {
      const outstanding = pending.get(entry.path);
      for (const input of inputs(entry)) {
        const file = bindingFile(input);
        if (!changed.has(file)) continue;
        const a = blobs.get(`${commit.revision}^1:${file}`);
        const b = blobs.get(`${commit.revision}:${file}`);
        if (
          input === file ||
          a === undefined ||
          b === undefined ||
          bindingDigest(input, a) !== bindingDigest(input, b)
        )
          outstanding.add(input);
      }
      if (
        capturePaths.has(entry.path) &&
        changed.has('docs/learn/media.json')
      ) {
        const a = captureMetadata(`${commit.revision}^1`, entry.path);
        const b = captureMetadata(commit.revision, entry.path);
        if (JSON.stringify(a) !== JSON.stringify(b))
          outstanding.add(entry.path);
      }
      const file = recordPath(entry);
      if (
        changed.has(file) &&
        reviewDecisionChanged(
          decision(json(`${commit.revision}^1:${file}`)),
          decision(json(`${commit.revision}:${file}`)),
        )
      )
        outstanding.add(entry.path);
    }
    for (const { status, file } of commit.changes) {
      if (!addedNote(status, file)) continue;
      for (const note of json(`${commit.revision}:${file}`).notes)
        for (const input of note.inputs ?? [])
          pending.get(note.path)?.delete(input);
    }
  }
  // Only a note not yet committed may cover a working-tree edit; an archived
  // note is committed even though no loose file carries its name.
  const committedNoteFiles = committedNotes();
  const dirty = new Set(
    git(root, ['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--'])
      .split('\0')
      .filter(Boolean),
  );
  for (const entry of current) {
    const outstanding = pending.get(entry.path);
    const committed = decision(json(`HEAD:${recordPath(entry)}`));
    if (
      reviewDecisionChanged(
        capturePaths.has(entry.path) && committed
          ? { ...captureMetadata('HEAD', entry.path), ...committed }
          : committed,
        entry,
      )
    )
      outstanding.add(entry.path);
    for (const note of notes(entry).filter(
      (note) => !committedNoteFiles.has(note.file),
    ))
      for (const input of note.inputs ?? []) outstanding.delete(input);
    for (const input of inputs(entry))
      if (dirty.has(bindingFile(input))) outstanding.add(input);
    entry.historyChanges = [...outstanding].sort();
    entry.reviewBaseline = baseline;
  }
}

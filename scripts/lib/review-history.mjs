import { execFileSync } from 'node:child_process';
import { bindingDigest, bindingFile } from './review-binding.mjs';
import { readGitObjects } from './review-git.mjs';

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

/**
 * Replay first-parent landing units: squash commits contain both code and notes;
 * ordinary merge commits introduce the other branch's notes with its code.
 * Later explicit catch-up notes discharge named outstanding inputs. Stored
 * revisions are context for inspection, never identities of shared source bytes.
 */
export function deriveReviewHistory(root, state, readStateAt) {
  const baseline = state.ledger.coverageBaseline;
  const current = entries(state).filter(
    (entry) => entry.historyChanges !== undefined,
  );
  let commits;
  try {
    if (git(root, ['rev-parse', '--is-shallow-repository']) === 'true')
      throw new Error('shallow checkout');
    if (!baseline || !/^[a-f0-9]{40}$/.test(baseline))
      throw new Error('missing coverage baseline');
    git(root, ['merge-base', '--is-ancestor', baseline, 'HEAD']);
    commits = git(root, [
      'rev-list',
      '--first-parent',
      '--reverse',
      `${baseline}..HEAD`,
    ])
      .split('\n')
      .filter(Boolean);
  } catch (error) {
    state.ledger.historyUnavailable = `Review history unavailable: ${String(error.message).split('\n')[0]}; reporting only. Fetch full history to judge freshness.`;
    for (const entry of current)
      entry.historyUnavailable = state.ledger.historyUnavailable;
    return;
  }
  const outstanding = new Map(current.map((entry) => [entry.path, new Set()]));
  let previous = readStateAt(root, baseline);
  let parent = baseline;
  for (const commit of commits) {
    const next = readStateAt(root, commit);
    const before = new Map(
      entries(previous).map((entry) => [entry.path, entry]),
    );
    const after = new Map(entries(next).map((entry) => [entry.path, entry]));
    const changed = new Set(
      git(root, [
        'diff',
        '--no-renames',
        '--name-only',
        '-z',
        parent,
        commit,
        '--',
      ])
        .split('\0')
        .filter(Boolean),
    );
    for (const entry of current) {
      const old = before.get(entry.path);
      const now = after.get(entry.path);
      const dependencies = [
        ...new Set([...(old ? inputs(old) : []), ...(now ? inputs(now) : [])]),
      ];
      const touched = touchedReviewInputs(
        root,
        dependencies,
        changed,
        parent,
        commit,
      );
      const pending = outstanding.get(entry.path);
      if (now && reviewDecisionChanged(old, now)) pending.add(entry.path);
      for (const input of touched) pending.add(input);
      const earlier = new Set(notes(old).map((note) => note.file));
      for (const note of notes(now).filter((note) => !earlier.has(note.file)))
        for (const input of note.inputs ?? []) pending.delete(input);
    }
    previous = next;
    parent = commit;
  }
  // Uncommitted source edits cannot be accepted by a note about committed inputs.
  const dirty = new Set(
    git(root, ['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--'])
      .split('\0')
      .filter(Boolean),
  );
  const atHead = new Map(entries(previous).map((entry) => [entry.path, entry]));
  for (const entry of current) {
    const pending = outstanding.get(entry.path);
    const committed = atHead.get(entry.path);
    if (reviewDecisionChanged(committed, entry)) pending.add(entry.path);
    const earlier = new Set(notes(committed).map((note) => note.file));
    for (const note of notes(entry).filter((note) => !earlier.has(note.file)))
      for (const input of note.inputs ?? []) pending.delete(input);
    for (const input of inputs(entry))
      if (dirty.has(bindingFile(input))) pending.add(input);
    entry.historyChanges = [...pending].sort();
    entry.reviewBaseline = baseline;
  }
}

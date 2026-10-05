import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * archive#3227 A1 — the structural half of the fix, carried forward to the
 * one-vocabulary round (2026-10, C1).
 *
 * `session-state-word-consistency.test.ts` proves the ladder cannot produce
 * a contradiction. It cannot prove that a FUTURE render site goes through
 * it: a surface that turns `session.lifecycleState` or the fold's
 * `orchestrationLifecycleLabel` into a word of its own reintroduces #1069,
 * #1783 and the audit's "Review pending"/"Completed"/"Ready" second
 * vocabulary at a place no lane-walk test looks. Four surfaces did exactly
 * that, and the Activity list did it again through its own refinement
 * table.
 *
 * So the rule is enforced at the import: a rendering surface that names a
 * session's state calls the ladder (`workStatus`, or `sessionWorkStatus`
 * for a bare summary). The fold's label is an INPUT to the ladder, read by
 * the few modules that classify, and nothing else prints it.
 *
 * Deliberately a source scan and not a lint rule: it needs no new tooling,
 * and the failure message can say what to call instead.
 */

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The modules that may read the fold's label directly: the ladder and its
 * facts, the lane partitions, the item builders, the tone and glyph tables
 * keyed by it, and the few predicates (showEvidence, showDiscard, Stop
 * gating) that branch on a state without printing it.
 */
const LABEL_READERS = new Set([
  join('utils', 'session-state.ts'),
  join('views', 'home', 'work-status.ts'),
  join('views', 'home', 'work-facts.ts'),
  join('views', 'home', 'home-view-model.ts'),
  join('views', 'home', 'home-lane-model.ts'),
  join('views', 'sessions', 'sessions-lane-model.ts'),
  join('views', 'project-page', 'project-live-work-model.ts'),
  join('components', 'kontour', 'station-tones.ts'),
  join('components', 'status', 'StatusGlyph.tsx'),
  join('contexts', 'open-chats-store.ts'),
]);

/** Surfaces that print a session's state, each through the ladder. */
const GUARDED_SURFACES = [
  join('views', 'SessionsView.tsx'),
  join('views', 'project-page', 'ProjectLiveWorkSection.tsx'),
  join('components', 'session-detail', 'SessionDetailHeader.tsx'),
  join('components', 'chat-dock', 'ChatDockInboxRows.tsx'),
  join('components', 'chat-dock', 'ChatInboxHoverCard.tsx'),
];

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      sourceFiles(full, found);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    found.push(full);
  }
  return found;
}

/**
 * Comments are stripped and the whole remaining source is searched, rather
 * than matching an import line's shape: a single-specifier import fits on
 * one line and slipped past the first version's multi-line pattern.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('a session state is worded by the ladder alone', () => {
  const files = sourceFiles(SRC_ROOT);

  test('no retired word derivation exists anywhere', () => {
    const offenders = files
      .filter((file) =>
        /\b(sessionStatusWord|sessionLifecycleLabel|lifecycleLabelText|SESSION_STATE_REFINEMENTS|activityRunningDetail)\b/.test(
          withoutComments(readFileSync(file, 'utf8')),
        ),
      )
      .map((file) => file.slice(SRC_ROOT.length));
    expect(
      offenders,
      `${offenders.join(', ')} names a retired status-word derivation. The status ladder (workStatus / sessionWorkStatus) is the only source of status words.`,
    ).toEqual([]);
  });

  test('every guarded surface prints its state through the ladder', () => {
    for (const guarded of GUARDED_SURFACES) {
      const source = withoutComments(
        readFileSync(join(SRC_ROOT, guarded), 'utf8'),
      );
      expect(source, `${guarded} no longer reads the status ladder`).toMatch(
        /\b(workStatus|sessionWorkStatus)\(/,
      );
    }
  });

  test('outside the classifiers, nothing turns the fold label into text', () => {
    // The fold label is a classification input; printing it (or switching
    // on it to pick a word) is a second vocabulary. A guarded surface may
    // still branch on it for a predicate, so this checks the one shape a
    // word table takes: a label used as a template or JSX text.
    const offenders: string[] = [];
    for (const file of files) {
      const name = file.slice(SRC_ROOT.length);
      if (LABEL_READERS.has(name)) continue;
      const source = withoutComments(readFileSync(file, 'utf8'));
      if (/\{orchestrationLifecycleLabel\(/.test(source)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  test('the scan actually reaches the rendering surfaces it is guarding', () => {
    const scanned = files.map((file) => file.slice(SRC_ROOT.length));
    for (const guarded of GUARDED_SURFACES) expect(scanned).toContain(guarded);
    expect(scanned.length).toBeGreaterThan(300);
  });
});

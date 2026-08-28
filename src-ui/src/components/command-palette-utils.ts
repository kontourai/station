/**
 * command-palette-utils — pure logic for the ⌘K command palette.
 *
 * Kept dependency-free and side-effect-free so it can be unit tested in
 * isolation. The fuzzy scorer is a lightweight subsequence matcher (no cmdk /
 * fuse dependency) over a command's label + keywords.
 */

import {
  type CommandFrecencyEntry,
  commandFrecencyBoost,
} from './command-frecency';

export interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  keywords?: string[];
  run: () => void;
  /** Optional decorative icon (rendered by the component, ignored by scoring). */
  icon?: unknown;
  /** Secondary bounded context shown without changing ranking behavior. */
  detail?: string;
  /** Unavailable options reveal their state/action instead of closing the palette. */
  closeOnRun?: boolean;
  /** Rendered as unavailable while retaining its explanatory command row. */
  disabled?: boolean;
  /**
   * A live execution guard for commands whose availability can change after
   * the palette index was built. Unavailable rows that explain themselves do
   * not use this; this is for registry actions that must never run raw.
   */
  canExecute?: () => boolean;
}

export interface ScoredCommand extends PaletteCommand {
  score: number;
}

type TextualTier = 0 | 1 | 2;

/**
 * Subsequence fuzzy score of `query` against `text`.
 *
 * Returns a non-negative score when every character of the (lower-cased) query
 * appears in order within `text`, or -1 when there is no subsequence match.
 *
 * Scoring rewards:
 *  - matches at the very start of the text (prefix)
 *  - matches at word boundaries (after a space / `-` / `_` / `/`)
 *  - consecutive (contiguous) matched characters
 * so that "ag" ranks "Agents" above "Manage" and an exact prefix wins.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  if (q.length === 0) return 0;
  if (q.length > t.length) return -1;

  // Strong exact / prefix bonuses up front.
  if (t === q) return 1000;
  if (t.startsWith(q)) return 600 - (t.length - q.length);

  let score = 0;
  let qi = 0;
  let prevMatchIdx = -2;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;

    let charScore = 1;
    const prevChar = ti > 0 ? t[ti - 1] : '';
    const atWordBoundary =
      ti === 0 ||
      prevChar === ' ' ||
      prevChar === '-' ||
      prevChar === '_' ||
      prevChar === '/';
    if (atWordBoundary) charScore += 8;
    if (ti === prevMatchIdx + 1) charScore += 4; // contiguous run

    score += charScore;
    prevMatchIdx = ti;
    qi++;
  }

  if (qi < q.length) return -1; // not all query chars consumed → no match

  // Prefer shorter targets so a tight match outranks a long one.
  return score + Math.max(0, 20 - t.length);
}

/**
 * Score floor a label match has to clear to be treated as exact-or-prefix.
 * `fuzzyScore` returns 1000 for an exact match and `600 - (extra chars)` for a
 * prefix, so any prefix match on a label up to 100 characters lands above this
 * and every non-prefix (subsequence) match lands far below it.
 */
const LABEL_PREFIX_FLOOR = 500;

/**
 * Best score across a command's label and keywords, with the label winning
 * whenever it is what the user actually typed.
 *
 * 6-: typing `monitor` returned `["Activity", "Monitoring"]` in that
 * order and Enter navigated to Activity. Activity's `keywords` include
 * "monitor", which scored an exact 1000, while Monitoring's LABEL only scored
 * a prefix match — so a keyword synonym outranked the literal name on screen.
 * Keyword matches are now capped below the exact/prefix band, which is the
 * band a typed label lands in; their ranking relative to each other, and to
 * weaker label matches, is unchanged.
 */
export function scoreCommand(query: string, command: PaletteCommand): number {
  const labelScore = fuzzyScore(query, command.label);
  if (labelScore >= LABEL_PREFIX_FLOOR) return labelScore;
  let best = labelScore;
  for (const kw of command.keywords ?? []) {
    const s = Math.min(fuzzyScore(query, kw), LABEL_PREFIX_FLOOR - 1);
    if (s > best) best = s;
  }
  return best;
}

function textualTier(query: string, command: PaletteCommand): TextualTier {
  const label = command.label.toLowerCase();
  const normalized = query.toLowerCase();
  if (label === normalized) return 2;
  if (label.startsWith(normalized)) return 1;
  return 0;
}

/** Only rows that can execute may receive or retain a ranking boost. */
export function isFrecencyEligible(command: PaletteCommand): boolean {
  return (
    !command.disabled &&
    command.closeOnRun !== false &&
    !command.id.startsWith('message:') &&
    command.id !== 'action:reset-command-history'
  );
}

/**
 * Rank commands for a query.
 *
 * Empty query → return commands in their natural (registry) order so the
 * palette shows a sensible default list. Non-empty → keep only matches,
 * sorted by descending score (stable on ties via original index).
 */
export function rankCommands(
  query: string,
  commands: PaletteCommand[],
  frecency: readonly CommandFrecencyEntry[] = [],
  now = Date.now(),
): ScoredCommand[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return commands.map((c) => ({ ...c, score: 0 }));
  }

  const byId = new Map(frecency.map((entry) => [entry.commandId, entry]));
  const scored: Array<
    ScoredCommand & { _idx: number; _tier: TextualTier; _boost: number }
  > = [];
  commands.forEach((command, idx) => {
    const score = scoreCommand(trimmed, command);
    if (score < 0) return;
    const tier = textualTier(trimmed, command);
    // History never crosses textual tiers and never changes a fuzzy/keyword
    // result. It only resolves literal exact/prefix matches more helpfully.
    const boost =
      tier > 0 && isFrecencyEligible(command)
        ? commandFrecencyBoost(byId.get(command.id), now)
        : 0;
    scored.push({ ...command, score, _idx: idx, _tier: tier, _boost: boost });
  });

  scored.sort(
    (a, b) =>
      b._tier - a._tier ||
      b.score + b._boost - (a.score + a._boost) ||
      a._idx - b._idx,
  );
  return scored.map(({ _idx, _tier, _boost, ...rest }) => rest);
}

export interface PaletteGroup {
  label: string;
  commands: ScoredCommand[];
}

/** Group an already-ranked list, preserving first-seen group order. */
export function groupRanked(ranked: ScoredCommand[]): PaletteGroup[] {
  const order: string[] = [];
  const byGroup = new Map<string, ScoredCommand[]>();
  for (const cmd of ranked) {
    if (!byGroup.has(cmd.group)) {
      byGroup.set(cmd.group, []);
      order.push(cmd.group);
    }
    byGroup.get(cmd.group)?.push(cmd);
  }
  return order.map((label) => ({ label, commands: byGroup.get(label) ?? [] }));
}

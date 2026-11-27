import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * "The scheduled run never happened" for `main-health.yml` (owner decision:
 * a scheduled workflow's failure must reach a person, and not running at all
 * is a failure).
 *
 * The expected interval comes from each workflow's own cron, read from the
 * default branch's workflow file on every check, so there is no second table
 * to drift when a schedule changes.
 *
 * ## The tolerance
 *
 * GitHub fires this repository's schedules late and sparsely. Measured over
 * 2026-10-17..11-16 (largest gap between consecutive scheduled runs):
 *
 * | cron interval | example | largest gap |
 * | --- | --- | --- |
 * | 1 h | starved-pr-report, nightly, qualification-health | 10.8 h |
 * | 6 h | dependency-advisory, main-qualification | 15.8 h |
 * | 24 h | backlog policy, docs sweep, fresh-home, gallery | 28.6 h |
 * | 7 d | dated TODO sweep | 170.3 h |
 *
 * A pure multiple cannot fit both ends: hourly crons need ~11x, weekly ones
 * barely 1.01x. So a workflow is overdue when its newest scheduled run is
 * older than max(OVERDUE_MULTIPLE x interval, OVERDUE_FLOOR_MS) = max(2x, 20 h):
 * hourly and six-hourly crons get 20 h (largest gaps 10.8 h and 15.8 h), daily
 * ones 48 h (28.6 h), weekly ones 14 days (7.1 days). Normal thinning never
 * pages; a schedule that stops firing pages within a day for anything that
 * runs at least daily.
 */
const OVERDUE_MULTIPLE = 2;
export const OVERDUE_FLOOR_MS = 20 * 60 * 60 * 1000;

/** Marks a tracker body written by the overdue check, so only it is cleared by a run. */
const OVERDUE_MARKER = '<!-- main-health-overdue -->';

const MINUTE = 60 * 1000;
const FIELD_BOUNDS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

/**
 * One cron field as the set of values it allows. Supports `*`, `n`, `a-b`,
 * `x/step` and comma lists — everything GitHub's schedule accepts except
 * names, which this repository does not use. Anything else is refused.
 *
 * @param {string} field
 * @param {number} min
 * @param {number} max
 */
function parseCronField(field, min, max) {
  const values = new Set();
  for (const part of field.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`unsupported cron field: ${field}`);
    const [, range, stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    let low = min;
    let high = max;
    if (range !== '*') {
      const [a, b] = range.split('-').map(Number);
      low = a;
      high = b === undefined ? (stepText === undefined ? a : max) : b;
    }
    if (step < 1 || low < min || high > max || low > high)
      throw new Error(`cron field out of range: ${field}`);
    for (let value = low; value <= high; value += step)
      values.add(max === 6 && value === 7 ? 0 : value);
  }
  return values;
}

/**
 * Every firing of the given crons (UTC, as GitHub evaluates them) in
 * [fromMs, toMs).
 *
 * @param {string[]} crons
 * @param {number} fromMs
 * @param {number} toMs
 */
function cronFirings(crons, fromMs, toMs) {
  const parsed = crons.map((expression) => {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5)
      throw new Error(`cron needs five fields: ${expression}`);
    const sets = fields.map((field, index) =>
      parseCronField(field, ...FIELD_BOUNDS[index]),
    );
    return { sets, domStar: fields[2] === '*', dowStar: fields[4] === '*' };
  });
  const firings = [];
  const start = Math.ceil(fromMs / MINUTE) * MINUTE;
  for (let t = start; t < toMs; t += MINUTE) {
    const d = new Date(t);
    const minute = d.getUTCMinutes();
    const hour = d.getUTCHours();
    const dom = d.getUTCDate();
    const month = d.getUTCMonth() + 1;
    const dow = d.getUTCDay();
    for (const { sets, domStar, dowStar } of parsed) {
      if (!sets[0].has(minute) || !sets[1].has(hour) || !sets[3].has(month))
        continue;
      // Standard cron: when both day fields are restricted, either matches.
      const dayMatches =
        domStar || dowStar
          ? sets[2].has(dom) && sets[4].has(dow)
          : sets[2].has(dom) || sets[4].has(dow);
      if (dayMatches) {
        firings.push(t);
        break;
      }
    }
  }
  return firings;
}

/**
 * The longest gap between consecutive firings, measured over four weeks so a
 * weekly cron is seen several times.
 *
 * @param {string[]} crons
 * @param {number} [anchorMs] any instant; the result does not depend on it for these crons
 */
export function cronIntervalMs(crons, anchorMs = Date.UTC(2026, 0, 5)) {
  const span = 28 * 24 * 60 * MINUTE;
  const firings = cronFirings(crons, anchorMs, anchorMs + span);
  if (firings.length < 2)
    throw new Error(`cron fires fewer than twice in four weeks: ${crons}`);
  let longest = 0;
  for (let i = 1; i < firings.length; i++)
    longest = Math.max(longest, firings[i] - firings[i - 1]);
  return longest;
}

/** @param {number} intervalMs */
export function overdueLimitMs(intervalMs) {
  return Math.max(OVERDUE_MULTIPLE * intervalMs, OVERDUE_FLOOR_MS);
}

/**
 * When the current schedule took effect: the oldest commit, walking back
 * from the newest, whose cron lines still equal the current ones. A commit
 * that changed anything else in the file does not count, so an unrelated
 * edit cannot postpone detection; a history that never differs within the
 * commits read yields the oldest one read, which can only report sooner.
 *
 * @param {string[]} crons the current cron lines
 * @param {{date: string | null, crons: string[]}[]} history newest first
 * @returns {string | null}
 */
export function scheduleEffectiveSince(crons, history = []) {
  const current = crons.join('\n');
  let since = null;
  for (const entry of history ?? []) {
    if (entry.crons.join('\n') !== current) break;
    since = entry.date;
  }
  return since;
}

/**
 * Overdue is measured from the later of the newest scheduled run and the
 * moment the current cron took effect (scheduleEffectiveSince), so a
 * workflow that just gained a cron, or whose cron just changed, gets one
 * full tolerance before it can page. Replayed against origin/main's history
 * (2026-08-20..11-16), the worst detection delay is the tolerance itself
 * for Dated TODO sweep (336 h), Gallery and Fresh-home (48 h), and 40 h for
 * Nightly, whose cron really changed after a hypothetical stop; measuring
 * from any edit instead gave 874 h, 238 h, 125 h and 79 h.
 *
 * @param {{
 *   intervalMs: number,
 *   lastRunAt: string | null,
 *   scheduleChangedAt?: string | null,
 *   now: number,
 * }} input
 */
export function decideOverdue({
  intervalMs,
  lastRunAt,
  scheduleChangedAt = null,
  now,
}) {
  const limitMs = overdueLimitMs(intervalMs);
  const candidates = [lastRunAt, scheduleChangedAt]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter(Number.isFinite);
  const sinceMs = candidates.length ? Math.max(...candidates) : Number.NaN;
  const overdue = !Number.isFinite(sinceMs) || now - sinceMs > limitMs;
  return {
    overdue,
    limitMs,
    since: Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : null,
    neverRan: lastRunAt == null,
  };
}

function hours(ms) {
  return `${Math.round((ms / 3_600_000) * 10) / 10} h`;
}

/**
 * @param {{
 *   workflowName: string,
 *   file: string,
 *   crons: string[],
 *   intervalMs: number,
 *   limitMs: number,
 *   lastRunAt: string | null,
 *   lastRunUrl?: string | null,
 *   since?: string | null,
 * }} input
 */
export function renderOverdueBody({
  workflowName,
  file,
  crons,
  intervalMs,
  limitMs,
  lastRunAt,
  lastRunUrl = null,
  since = null,
}) {
  return [
    OVERDUE_MARKER,
    lastRunAt
      ? `${workflowName} has not run on its schedule since ${lastRunAt}.`
      : `${workflowName} has never run on its schedule (schedule in effect since ${since ?? 'unknown'}).`,
    '',
    `Workflow: ${file}`,
    `Schedule: ${crons.map((cron) => `\`${cron}\``).join(', ')} (UTC; longest gap between firings ${hours(intervalMs)})`,
    `Overdue after: ${hours(limitMs)} without a scheduled run`,
    ...(lastRunUrl ? [`Last scheduled run: ${lastRunUrl}`] : []),
    '',
    "GitHub delivers this repository's schedules late and sparsely; this fires only past that tolerance. Check whether the workflow is disabled, its file fails to parse, or schedules have stopped. The next scheduled run closes this issue.",
  ].join('\n');
}

/** @param {unknown} body */
export function isOverdueBody(body) {
  return String(body ?? '').startsWith(OVERDUE_MARKER);
}

function workspaceRoot(workspace) {
  return String(workspace).startsWith('file:')
    ? fileURLToPath(workspace)
    : workspace;
}

/**
 * The workflow names `main-health.yml` watches, read from its own trigger.
 * Read as text because the reporter's checkout has no installed YAML parser;
 * the test checks this against the parsed file.
 *
 * @param {string} mainHealthText
 */
export function watchedWorkflowNames(mainHealthText) {
  const block = /\n {4}workflows:\n([\s\S]*?)\n {4}types:/.exec(mainHealthText);
  if (!block)
    throw new Error('main-health.yml has no workflow_run workflows list');
  const names = [];
  for (const line of block[1].split('\n')) {
    const match = /^ {6}- "([^"]+)"\s*$/.exec(line);
    if (match) names.push(match[1]);
    else if (line.trim() && !line.trim().startsWith('#'))
      throw new Error(`unreadable watched-workflow line: ${line}`);
  }
  return names;
}

/**
 * A workflow file's `name:` and `cron:` entries, as text.
 *
 * @param {string} text
 */
export function workflowSchedule(text) {
  const name = /^name:\s*(?:"([^"]*)"|'([^']*)'|(.+?))\s*$/m.exec(text);
  const crons = [
    ...text.matchAll(/^\s*-\s*cron:\s*(?:'([^']+)'|"([^"]+)")\s*(?:#.*)?$/gm),
  ].map((match) => match[1] ?? match[2]);
  return {
    name: name ? (name[1] ?? name[2] ?? name[3]) : null,
    crons,
  };
}

/**
 * Every scheduled workflow main-health watches, with its crons, from the
 * checkout at `workspace` (a path or a file URL).
 *
 * @param {string} workspace
 */
export function readWatchedSchedules(workspace) {
  const root = workspaceRoot(workspace);
  const dir = join(root, '.github', 'workflows');
  const watched = new Set(
    watchedWorkflowNames(readFileSync(join(dir, 'main-health.yml'), 'utf8')),
  );
  const schedules = [];
  for (const file of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(file)) continue;
    const { name, crons } = workflowSchedule(
      readFileSync(join(dir, file), 'utf8'),
    );
    if (name && crons.length > 0 && watched.has(name))
      schedules.push({ file, name, crons });
  }
  return schedules;
}

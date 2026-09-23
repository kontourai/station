/**
 * Checks that need a signed-in account (an engine CLI login, a paid review
 * credential) cannot pass on hosted or fleet CI runners, which hold neither.
 * Until #2318 lets CI borrow the owner's Station, CI disables them VISIBLY:
 * they are skipped before they start, listed under one heading in the step
 * summary and the run's report, never counted as PASS, and never allowed to
 * turn the job red on their own. Outside CI they run exactly as before.
 *
 * Each check declares the requirement where its own metadata lives (an E2E
 * manifest entry's `requiresAccount`, a core-loop journey's option, the image
 * reviewer); this module is the single decision and rendering point.
 */
import { appendFileSync } from 'node:fs';

export const ACCOUNT_DISABLED_STATUS = 'DISABLED';
export const ACCOUNT_DISABLED_REASON =
  'requires a signed-in account; disabled in CI until #2318';
export const ACCOUNT_DISABLED_HEADING = 'Disabled in CI (requires account)';

/**
 * `STATION_CI_ACCOUNTS=absent|present` is the explicit switch; without it,
 * a CI environment (`CI=true` or `GITHUB_ACTIONS=true`) means absent. Any
 * other value is refused rather than guessed, so a typo cannot silently
 * re-enable or disable coverage.
 */
export function accountsAbsent(env = process.env) {
  const declared = env.STATION_CI_ACCOUNTS;
  if (declared === 'absent') return true;
  if (declared === 'present') return false;
  if (declared !== undefined && declared !== '')
    throw new Error(
      `STATION_CI_ACCOUNTS must be 'absent' or 'present', not '${declared}'`,
    );
  return env.CI === 'true' || env.GITHUB_ACTIONS === 'true';
}

/**
 * Split E2E spec paths into those to run and those disabled for want of an
 * account. Only a manifest entry that declares `requiresAccount` can land in
 * `disabled`; every other spec runs.
 */
export function partitionAccountDependentSpecs(
  specs,
  manifest,
  env = process.env,
) {
  const requirements = new Map(
    manifest
      .filter((entry) => typeof entry.requiresAccount === 'string')
      .map((entry) => [entry.path, entry.requiresAccount]),
  );
  if (!accountsAbsent(env)) return { runnable: [...specs], disabled: [] };
  const runnable = [];
  const disabled = [];
  for (const path of specs) {
    const requires = requirements.get(path);
    if (requires === undefined) runnable.push(path);
    else disabled.push({ path, requires, reason: ACCOUNT_DISABLED_REASON });
  }
  return { runnable, disabled };
}

/** Markdown section naming every disabled check; empty when none were. */
export function renderAccountDisabledMarkdown(entries) {
  if (!entries.length) return '';
  const clean = (value) =>
    String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  return [
    `### ${ACCOUNT_DISABLED_HEADING}`,
    '',
    `Not run and not counted as passing: ${ACCOUNT_DISABLED_REASON}. They still run on a host with the account.`,
    '',
    '| Check | Requires |',
    '| --- | --- |',
    ...entries.map(
      (entry) => `| ${clean(entry.name)} | ${clean(entry.requires)} |`,
    ),
    '',
  ].join('\n');
}

/** Append to the GitHub step summary when the job provides one. */
export function appendStepSummary(markdown, env = process.env) {
  if (!markdown || !env.GITHUB_STEP_SUMMARY) return false;
  appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  return true;
}

/**
 * One line per disabled E2E spec, printed by the suite runner and folded by
 * the coverage coordinator into its summary and the latest-evidence manifest.
 */
const E2E_DISABLED_LINE_PREFIX = '[e2e-disabled] ';

export function formatE2EDisabledLine(suite, entry) {
  return `${E2E_DISABLED_LINE_PREFIX}${JSON.stringify({
    suite,
    path: entry.path,
    requires: entry.requires,
  })}`;
}

export function parseE2EDisabledLines(output) {
  const entries = [];
  for (const line of String(output ?? '').split(/\r?\n/)) {
    if (!line.startsWith(E2E_DISABLED_LINE_PREFIX)) continue;
    try {
      const value = JSON.parse(line.slice(E2E_DISABLED_LINE_PREFIX.length));
      if (
        typeof value?.path === 'string' &&
        typeof value?.requires === 'string'
      )
        entries.push({ path: value.path, requires: value.requires });
    } catch {
      // A malformed line is not a disabled check; it is simply not reported.
    }
  }
  return entries;
}

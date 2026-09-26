import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { invokedDirectly } from './lib/module-entry.mjs';
import {
  runFallowAnalysis,
  summarizeFallowReports,
} from './run-fallow-audit.mjs';

/** Fallow 3.22 health_finding_key excludes line numbers. Summary counts rows,
 * but AuditDomainLedger attribution counts distinct path/name/metric keys.
 * Validate both populations; a matching aggregate alone cannot prove every
 * finding was attributed. See fallow-rs/fallow crates/api/src/audit_keys.rs. */
function complexityKeyCounts(report, totalRows) {
  if (report.complexity == null && totalRows === 0)
    return { introduced: 0, inherited: 0 };
  const findings = report.complexity?.findings;
  if (!Array.isArray(findings) || findings.length !== totalRows)
    throw new Error('Code-health report has incomplete complexity rows');
  const keys = new Map();
  for (const finding of findings) {
    if (
      !finding ||
      typeof finding.introduced !== 'boolean' ||
      ['path', 'name', 'exceeded'].some(
        (field) => typeof finding[field] !== 'string' || !finding[field].trim(),
      )
    )
      throw new Error(
        'Code-health report has incomplete complexity finding attribution',
      );
    const key = JSON.stringify([finding.path, finding.name, finding.exceeded]);
    if (keys.has(key) && keys.get(key) !== finding.introduced)
      throw new Error(
        'Code-health report has conflicting complexity key attribution',
      );
    keys.set(key, finding.introduced);
  }
  const introduced = [...keys.values()].filter(Boolean).length;
  return { introduced, inherited: keys.size - introduced };
}

/**
 * An EMPTY comparison: the analyzer was asked for everything changed since a
 * commit and found no changed file at all, so it emits no `dead_code` section
 * rather than an empty one. That is not a malformed report — there was nothing
 * to attribute — and refusing it with `Missing unused_exports findings` named a
 * symptom two steps from its cause (#2094). It is reached by dispatching CI on
 * `main`: a dispatch has no pull request, so `STATION_CI_FAST_BASE` is empty,
 * the base falls back to `origin/main`, and on `main` that IS the head.
 *
 * Derived from the report's own `changed_files_count` rather than from
 * comparing the two SHAs, because the question is what the analyzer compared,
 * not what it was asked to compare: an empty commit reaches the same state
 * with two different SHAs. The summary totals must agree — a report claiming
 * findings while reporting no changed file is malformed and must still be
 * refused, and an absent count is not a zero.
 *
 * This infers no base. The note in `runCodeHealthGate` still holds: the base
 * is whatever the caller supplied, and nothing here derives one from a branch.
 */
function comparedNothing(report, summary) {
  return (
    report.changed_files_count === 0 &&
    summary.dead_code_issues === 0 &&
    summary.complexity_findings === 0 &&
    summary.duplication_clone_groups === 0
  );
}

/** Scores and estimated coverage require judgment; new unused API needs a caller. */
export function evaluateCodeHealthAudit(report, base, head) {
  const summary = summarizeFallowReports('changed', [report]);
  if (
    report.kind !== 'audit' ||
    report.base_ref !== base ||
    typeof report.head_sha !== 'string' ||
    report.head_sha.length < 7 ||
    !head.startsWith(report.head_sha) ||
    report.attribution?.gate !== 'new-only'
  )
    throw new Error(
      'Code-health report lacks the requested base/head attribution',
    );
  const introduced = {};
  for (const [kind, total] of [
    ['dead_code', summary.dead_code_issues],
    ['complexity', summary.complexity_findings],
    ['duplication', summary.duplication_clone_groups],
  ]) {
    const added = report.attribution[`${kind}_introduced`];
    const inherited = report.attribution[`${kind}_inherited`];
    const complexity =
      kind === 'complexity' ? complexityKeyCounts(report, total) : null;
    if (
      !Number.isSafeInteger(added) ||
      added < 0 ||
      !Number.isSafeInteger(inherited) ||
      inherited < 0 ||
      (complexity
        ? added !== complexity.introduced || inherited !== complexity.inherited
        : added + inherited !== total)
    )
      throw new Error(`Code-health report has incomplete ${kind} attribution`);
    introduced[kind] = added;
  }
  const emptyComparison = comparedNothing(report, summary);
  const blockers = [];
  for (const kind of ['unused_exports', 'unused_types']) {
    const findings = report.dead_code?.[kind];
    if (!Array.isArray(findings)) {
      // The two cases the old message could not tell apart: the analyzer
      // returned no attribution for a comparison that HAD changed files
      // (a real fault, still refused), versus a comparison that had nothing
      // to attribute.
      if (emptyComparison) continue;
      throw new Error(
        `Code-health report has no ${kind} attribution for ${report.changed_files_count} changed file(s)`,
      );
    }
    for (const finding of findings) {
      if (typeof finding.introduced !== 'boolean')
        throw new Error(`Missing ${kind} finding attribution`);
      if (finding.introduced) blockers.push({ kind, ...finding });
    }
  }
  return {
    passed: blockers.length === 0,
    emptyComparison,
    introduced,
    blockers,
    summary,
  };
}

async function runCodeHealthGate(root, baseRef) {
  const git = (args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }).trim();
  // Never infer the base from this branch's upstream: after a push that may be
  // the candidate itself, which would turn every new finding into inherited debt.
  const base = git(['rev-parse', '--verify', `${baseRef}^{commit}`]);
  const head = git(['rev-parse', 'HEAD']);
  const parent = join(root, '.kontourai/code-health');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'review-'));
  const args = ['--changed-since', base, '--gate', 'new-only'];
  // Candidate baseline edits cannot hide its new findings. Always read the
  // three allowances from the same immutable upstream revision being compared.
  for (const [file, option] of [
    ['dead-code.json', '--dead-code-baseline'],
    ['health.json', '--health-baseline'],
    ['dupes.json', '--dupes-baseline'],
  ]) {
    const path = join(directory, file);
    writeFileSync(
      path,
      `${git(['show', `${base}:fallow-baselines/${file}`])}\n`,
    );
    args.push(option, path);
  }
  const reportPath = join(directory, 'audit.json');
  const report = await runFallowAnalysis(root, 'audit', reportPath, args);
  if (git(['rev-parse', 'HEAD']) !== head)
    throw new Error('Source revision changed during code-health analysis');
  const result = {
    base,
    head,
    report: relative(root, reportPath),
    ...evaluateCodeHealthAudit(report, base, head),
  };
  writeFileSync(
    join(directory, 'gate.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}

if (invokedDirectly(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length && !args[0].startsWith('--base=')))
      throw new Error(
        'Usage: node scripts/code-health-gate.mjs [--base=<ref>]',
      );
    const base =
      args[0]?.slice('--base='.length) ||
      process.env.STATION_CI_FAST_BASE ||
      'origin/main';
    if (!base || base.startsWith('-'))
      throw new Error('Invalid code-health base');
    const result = await runCodeHealthGate(process.cwd(), base);
    console.log(JSON.stringify(result, null, 2));
    // An empty comparison must say what it is rather than borrow the verdict
    // of a real one: this run evaluated nothing, which is not the same claim
    // as "nothing was wrong" (#2094).
    console.log(
      result.emptyComparison
        ? `Compared ${result.base} against ${result.head}: no changed file, so nothing was analyzed and no unused export or type was evaluated. This is not a statement about the tree's code health. A CI dispatch on main reaches this — a dispatch has no pull request, so the base falls back to origin/main, which on main IS the head. Pass --base=<ref> or set STATION_CI_FAST_BASE to compare against something.`
        : 'New unused exports/types require a real caller or an explicit entrypoint/public-API contract. Review other introduced findings in the raw report; complexity and estimated coverage are advisory.',
    );
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        result.emptyComparison
          ? `\n### Code-health change review\n\nNo changed file between base ${result.base} and source ${result.head}, so nothing was analyzed. The zeroes below are the absence of a comparison, not the absence of findings.\n`
          : `\n### Code-health change review\n\nNew candidates: ${result.introduced.dead_code} dead/dependency, ${result.introduced.complexity} complexity, ${result.introduced.duplication} clone groups. Unused export/type blockers: ${result.blockers.length}.\n\nSource: ${result.head}; base: ${result.base}. Full report: ${result.report} in the fast-feedback artifact. Counts describe candidates, not confirmed defects.\n`,
      );
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

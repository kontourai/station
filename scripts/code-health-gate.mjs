import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runFallowAnalysis,
  summarizeFallowReports,
} from './run-fallow-audit.mjs';

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
  const attributionCorrections = [];
  for (const [kind, total] of [
    ['dead_code', summary.dead_code_issues],
    ['complexity', summary.complexity_findings],
    ['duplication', summary.duplication_clone_groups],
  ]) {
    const added = report.attribution[`${kind}_introduced`];
    const inherited = report.attribution[`${kind}_inherited`];
    if (
      !Number.isSafeInteger(added) ||
      added < 0 ||
      !Number.isSafeInteger(inherited) ||
      inherited < 0
    )
      throw new Error(`Code-health report has incomplete ${kind} attribution`);
    if (added + inherited !== total) {
      // Fallow 3.22 can undercount inherited complexity in its aggregate while
      // emitting every attributed finding. Reconcile only that proven shape;
      // missing rows, ambiguous identities, or understated NEW debt still fail.
      const findings =
        kind === 'complexity' ? report.complexity?.findings : undefined;
      if (!Array.isArray(findings) || findings.length !== total)
        throw new Error(
          `Code-health report has incomplete ${kind} attribution`,
        );
      const identities = new Set();
      let actualAdded = 0;
      for (const finding of findings) {
        if (
          typeof finding?.introduced !== 'boolean' ||
          typeof finding.path !== 'string' ||
          !finding.path ||
          typeof finding.name !== 'string' ||
          !finding.name ||
          !Number.isSafeInteger(finding.line) ||
          finding.line < 1
        )
          throw new Error('Complexity finding lacks exact attribution');
        const identity = JSON.stringify([
          finding.path,
          finding.line,
          finding.name,
        ]);
        if (identities.has(identity))
          throw new Error('Duplicate complexity finding');
        identities.add(identity);
        if (finding.introduced) actualAdded++;
      }
      const actualInherited = total - actualAdded;
      if (actualAdded !== added || inherited >= actualInherited)
        throw new Error(
          'Complexity aggregate disagrees with introduced findings',
        );
      attributionCorrections.push({
        kind,
        reportedInherited: inherited,
        observedInherited: actualInherited,
      });
    }
    introduced[kind] = added;
  }
  const blockers = [];
  for (const kind of ['unused_exports', 'unused_types']) {
    const findings = report.dead_code?.[kind];
    if (!Array.isArray(findings)) throw new Error(`Missing ${kind} findings`);
    for (const finding of findings) {
      if (typeof finding.introduced !== 'boolean')
        throw new Error(`Missing ${kind} finding attribution`);
      if (finding.introduced) blockers.push({ kind, ...finding });
    }
  }
  return {
    passed: blockers.length === 0,
    introduced,
    blockers,
    summary,
    attributionCorrections,
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

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
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
    console.log(
      'New unused exports/types require a real caller or an explicit entrypoint/public-API contract. Review other introduced findings in the raw report; complexity and estimated coverage are advisory.',
    );
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\n### Code-health change review\n\nNew candidates: ${result.introduced.dead_code} dead/dependency, ${result.introduced.complexity} complexity, ${result.introduced.duplication} clone groups. Unused export/type blockers: ${result.blockers.length}.\n\nSource: ${result.head}; base: ${result.base}. Full report: ${result.report} in the fast-feedback artifact. Counts describe candidates, not confirmed defects.\n`,
      );
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

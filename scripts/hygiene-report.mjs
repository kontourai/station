#!/usr/bin/env node
// Code hygiene checks (docs/guides/code-hygiene.md). Advisory: each check
// derives its answer from the tracked tree, the syntax tree or GitHub issue
// state and reports; it never blocks unless run with --strict.
//
//   node scripts/hygiene-report.mjs                      every check, text summary
//   node scripts/hygiene-report.mjs --check markers      one check
//   node scripts/hygiene-report.mjs --json               machine-readable results
//   node scripts/hygiene-report.mjs --report <path>      also write the tracking-issue body
//   node scripts/hygiene-report.mjs --upsert --report <path> --repo <owner/name>
//
// Options: --root <dir> (default: cwd), --repo <owner/name> (issues are
// resolved there; default kontourai/station), --today YYYY-MM-DD (default:
// the UTC date), --strict (exit 1 when there are findings; for promotion).
//
// Exit status: 0 the checks ran (findings are advisory); 1 --strict and at
// least one finding; 2 a check could not reach its data (NOT_VERIFIED) or
// could not run at all. A NOT_VERIFIED check is never reported as clean.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assertRoot, CHECKS } from './lib/hygiene/checks.mjs';
import { createGithub, DEFAULT_REPOSITORY } from './lib/hygiene/github.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { upsertTrackingIssue } from './lib/tracking-issue.mjs';

export const HYGIENE_ISSUE_TITLE = 'Code hygiene sweep';
export const HYGIENE_ISSUE_LABELS = Object.freeze(['P2']);
const MARKER = 'code-hygiene-sweep';
/** GitHub refuses issue bodies over 65,536 characters. */
export const HYGIENE_BODY_LIMIT = 60_000;

const VALUE_FLAGS = new Set([
  '--check',
  '--root',
  '--repo',
  '--today',
  '--report',
]);
const BOOLEAN_FLAGS = new Set(['--json', '--strict', '--upsert']);

export function parseArgs(argv) {
  const options = { json: false, strict: false, upsert: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (BOOLEAN_FLAGS.has(arg)) {
      options[arg.slice(2)] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) throw new Error(`unknown argument ${arg}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`${arg} requires a value`);
    options[arg.slice(2)] = value;
    index += 1;
  }
  if (options.check && !Object.hasOwn(CHECKS, options.check))
    throw new Error(
      `--check must be one of ${Object.keys(CHECKS).join(', ')}; got ${options.check}`,
    );
  if (options.today && !/^\d{4}-\d{2}-\d{2}$/.test(options.today))
    throw new Error('--today must be YYYY-MM-DD');
  if (options.upsert && !options.report)
    throw new Error('--upsert requires --report <path>');
  return options;
}

export function runChecks({ root, repo, today, check }) {
  assertRoot(root);
  const context = {
    root,
    today,
    github: createGithub({ repository: repo }),
  };
  const ids = check ? [check] : Object.keys(CHECKS);
  return ids.map((id) => CHECKS[id](context));
}

function countsByKind(findings) {
  const counts = new Map();
  for (const finding of findings)
    counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => `${kind} ${count}`).join(', ');
}

function location(finding) {
  return finding.line ? `${finding.path}:${finding.line}` : finding.path;
}

export function renderText(results) {
  const lines = [];
  for (const check of results) {
    const head = `[hygiene:${check.id}]`;
    const counts = check.findings.length
      ? ` (${countsByKind(check.findings)})`
      : '';
    lines.push(
      `${head} ${check.findings.length} finding${check.findings.length === 1 ? '' : 's'}${counts}; ${check.summary}`,
    );
    if (check.notVerified)
      lines.push(`${head} NOT_VERIFIED: ${check.notVerified}`);
    for (const finding of check.findings)
      lines.push(`  ${finding.kind}  ${location(finding)}  ${finding.detail}`);
  }
  return `${lines.join('\n')}\n`;
}

export function buildIssueBody(results, { revision, generatedAt }) {
  const findings = results.reduce(
    (sum, check) => sum + check.findings.length,
    0,
  );
  const notVerified = results.filter((check) => check.notVerified);
  const head = [
    `<!-- ${MARKER} findings=${findings} not_verified=${notVerified.length} revision=${revision} -->`,
    `# ${HYGIENE_ISSUE_TITLE}`,
    '',
    `Swept \`main\` at ${revision} (${generatedAt}) with \`npm run hygiene:report\`. These checks are advisory. Resolve each item as [Code hygiene](../blob/main/docs/guides/code-hygiene.md) describes; the next sweep updates this issue and closes it when nothing remains.`,
    '',
    ...results.map(
      (check) =>
        `- ${check.title}: ${check.notVerified ? `**NOT_VERIFIED** (${check.notVerified}); ` : ''}${check.findings.length} finding${check.findings.length === 1 ? '' : 's'}; ${check.summary}`,
    ),
    '',
  ];
  const lines = [];
  for (const check of results) {
    if (!check.findings.length) continue;
    lines.push(`## ${check.title} (${check.findings.length})`, '');
    for (const finding of check.findings)
      lines.push(
        `- [ ] ${finding.kind} \`${location(finding)}\`: ${finding.detail}`,
      );
    lines.push('');
  }
  if (!findings) lines.push('_Nothing outstanding._');
  const body = [...head];
  let length = body.join('\n').length;
  for (const [index, line] of lines.entries()) {
    const omitted = `\n_${lines.length - index} more lines omitted from this issue; the sweep job log lists every finding._`;
    if (length + line.length + 1 + omitted.length > HYGIENE_BODY_LIMIT) {
      body.push(omitted.trim());
      break;
    }
    body.push(line);
    length += line.length + 1;
  }
  return `${body.join('\n')}\n`;
}

/** Outstanding items recorded in a report body: findings plus NOT_VERIFIED checks. */
export function reportOutstanding(report) {
  const match = new RegExp(
    `^<!-- ${MARKER} findings=(\\d+) not_verified=(\\d+) revision=([a-f0-9]{40}) -->$`,
    'm',
  ).exec(report);
  if (!match) throw new Error(`report is missing the ${MARKER} marker`);
  return Number(match[1]) + Number(match[2]);
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.upsert) {
    const outcome = upsertTrackingIssue({
      repo: options.repo,
      reportPath: options.report,
      title: HYGIENE_ISSUE_TITLE,
      labels: HYGIENE_ISSUE_LABELS,
      outstanding: reportOutstanding(readFileSync(options.report, 'utf8')),
    });
    console.log(
      `[hygiene] ${outcome.action}${outcome.number ? ` #${outcome.number}` : ''}`,
    );
    return 0;
  }
  const root = resolve(options.root ?? process.cwd());
  const results = runChecks({
    root,
    repo: options.repo ?? DEFAULT_REPOSITORY,
    today: options.today ?? new Date().toISOString().slice(0, 10),
    check: options.check,
  });
  if (options.json)
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  else process.stdout.write(renderText(results));
  if (options.report) {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    mkdirSync(dirname(options.report), { recursive: true });
    writeFileSync(
      options.report,
      buildIssueBody(results, {
        revision,
        generatedAt: new Date().toISOString(),
      }),
    );
  }
  if (results.some((check) => check.notVerified)) return 2;
  if (options.strict && results.some((check) => check.findings.length))
    return 1;
  return 0;
}

if (invokedDirectly(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(
      `hygiene: cannot run: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }
}

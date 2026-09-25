#!/usr/bin/env node
// Dated TODO sweep: scan tracked sources for dated TODOs and keep ONE GitHub
// tracking issue current. Convention: `TODO(YYYY-MM-DD):` — the date is the
// day the comment promised a revisit.
//
//   node scripts/dated-todo-sweep.mjs --report .artifacts/dated-todo-report.md
//   node scripts/dated-todo-sweep.mjs --upsert --report <path> --date YYYY-MM-DD
//
// The scan is deterministic; no agent is involved. Validation is importable so
// a privileged writer can check the report before publishing it.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';

const ISSUE_TITLE = 'Dated TODO sweep';
const REPORT_MARKER = 'dated-todo-sweep';
const SCAN_ROOTS = [
  'src-shared',
  'src-server',
  'src-ui',
  'src-desktop',
  'packages',
  'scripts',
  'examples',
  'docs',
  'tests',
];
const SKIP_DIR_NAMES = new Set([
  '__tests__',
  '__test-utils__',
  'node_modules',
  'dist',
  'gen',
]);
const TEXT_EXTENSIONS =
  /\.(ts|tsx|mts|mjs|js|jsx|rs|md|yml|yaml|toml|json|swift|kt)$/;
const TODO_PATTERN = /\bTODO\((\d{4}-\d{2}-\d{2})\)/;

export function collectFiles(root) {
  const files = [];
  for (const scanRoot of SCAN_ROOTS) {
    const absoluteRoot = join(root, scanRoot);
    if (!existsSync(absoluteRoot)) continue;
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (SKIP_DIR_NAMES.has(entry.name)) continue;
          walk(join(dir, entry.name));
        } else if (
          entry.isFile() &&
          TEXT_EXTENSIONS.test(entry.name) &&
          !entry.name.endsWith('.d.ts')
        ) {
          files.push(join(dir, entry.name));
        }
      }
    };
    walk(absoluteRoot);
  }
  return files.sort();
}

export function collectDatedTodos({ root, today }) {
  const entries = [];
  for (const file of collectFiles(root)) {
    const relativePath = relative(root, file).split(sep).join('/');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const match = TODO_PATTERN.exec(line);
      if (!match) continue;
      entries.push({
        file: relativePath,
        line: index + 1,
        date: match[1],
        due: match[1] <= today,
        text: line.trim(),
      });
    }
  }
  return entries;
}

export function buildSweepReport(entries, { today, generatedAt }) {
  const due = entries.filter((entry) => entry.due);
  const upcoming = entries.filter((entry) => !entry.due);
  const render = (list) =>
    list.length === 0
      ? ['_None._']
      : list.map(
          (entry) =>
            `- \`${entry.file}:${entry.line}\` — ${entry.date} — ${entry.text}`,
        );
  return [
    `<!-- ${REPORT_MARKER} ${today} -->`,
    `# Dated TODO sweep`,
    '',
    `Sweep date: ${today}. Generated ${generatedAt}. Convention: \`TODO(YYYY-MM-DD):\`; a due date at or before the sweep date is listed as due.`,
    '',
    `## Due (${due.length})`,
    '',
    ...render(due),
    '',
    `## Upcoming (${upcoming.length})`,
    '',
    ...render(upcoming),
    '',
  ].join('\n');
}

export function validateDatedTodoReport(report, { expectedDate }) {
  const marker = new RegExp(
    `^<!-- ${REPORT_MARKER} (\\d{4}-\\d{2}-\\d{2}) -->$`,
    'm',
  );
  const match = marker.exec(report);
  if (!match)
    throw new Error(`report is missing the ${REPORT_MARKER} date marker`);
  if (expectedDate && match[1] !== expectedDate) {
    throw new Error(
      `report marker date ${match[1]} does not match expected ${expectedDate}`,
    );
  }
  if (!report.includes('## Due ('))
    throw new Error('report is missing the Due section');
  return match[1];
}

function runGh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function upsertIssue({ reportPath, expectedDate }) {
  const report = readFileSync(reportPath, 'utf8');
  validateDatedTodoReport(report, { expectedDate });
  const listing = runGh([
    'issue',
    'list',
    '--state',
    'all',
    '--search',
    `"${ISSUE_TITLE}" in:title`,
    '--json',
    'number,title',
    '--limit',
    '50',
  ]);
  const existing = JSON.parse(listing || '[]').find(
    (issue) => issue.title === ISSUE_TITLE,
  );
  if (existing) {
    runGh([
      'issue',
      'edit',
      String(existing.number),
      '--body-file',
      reportPath,
      '--repo',
      process.env.GITHUB_REPOSITORY,
    ]);
    runGh(['issue', 'reopen', String(existing.number)]);
    console.log(`[dated-todo] updated issue #${existing.number}`);
    return;
  }
  const created = runGh([
    'issue',
    'create',
    '--title',
    ISSUE_TITLE,
    '--body-file',
    reportPath,
    '--label',
    'P2',
    '--repo',
    process.env.GITHUB_REPOSITORY,
  ]);
  console.log(`[dated-todo] created ${created}`);
}

function main(argv) {
  const args = argv;
  const readFlag = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  if (args.includes('--upsert')) {
    upsertIssue({
      reportPath: readFlag('--report'),
      expectedDate: readFlag('--date'),
    });
    return;
  }
  const today = readFlag('--date') ?? new Date().toISOString().slice(0, 10);
  const entries = collectDatedTodos({ root: process.cwd(), today });
  const report = buildSweepReport(entries, {
    today,
    generatedAt: new Date().toISOString(),
  });
  const outputPath = readFlag('--report');
  if (outputPath) {
    mkdirSync(join(outputPath, '..'), { recursive: true });
    writeFileSync(outputPath, report);
    console.log(`[dated-todo] report written to ${outputPath}`);
  }
  console.log(report);
  console.log(
    `[dated-todo] entries=${entries.length} due=${entries.filter((entry) => entry.due).length}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}

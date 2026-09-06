#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryCodeHealthFiles } from './code-health-inventory.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './lib/owned-process.mjs';

function count(value, field) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`Fallow report is missing a valid ${field}`);
  return value;
}

/** Analysis metrics are observations, not measured test coverage or reviewed defects. */
export function summarizeFallowReports(scope, reports) {
  if (scope === 'whole-tree') {
    const [dead, health, dupes] = reports;
    return {
      dead_code_issues: count(dead?.summary?.total_issues, 'dead-code total'),
      complexity_findings: count(
        health?.summary?.functions_above_threshold,
        'complexity findings',
      ),
      duplication_clone_groups: count(
        dupes?.stats?.clone_groups,
        'clone groups',
      ),
      files_analyzed: count(health?.summary?.files_analyzed, 'analyzed files'),
      functions_analyzed: count(
        health?.summary?.functions_analyzed,
        'analyzed functions',
      ),
      coverage_model: health.summary.coverage_model,
    };
  }
  if (scope !== 'changed') throw new Error(`Unknown Fallow scope: ${scope}`);
  const [audit] = reports;
  if (!['pass', 'warn', 'fail'].includes(audit?.verdict))
    throw new Error('Fallow report is missing its verdict');
  return {
    dead_code_issues: count(
      audit.summary?.dead_code_issues,
      'dead-code issues',
    ),
    duplication_clone_groups: count(
      audit.summary?.duplication_clone_groups,
      'clone groups',
    ),
    complexity_findings: count(
      audit.summary?.complexity_findings,
      'complexity findings',
    ),
    changed_files_count: count(audit.changed_files_count, 'changed file count'),
    source_verdict: audit.verdict,
  };
}

export function fallowCommands(scope) {
  if (scope === 'whole-tree') return ['dead-code', 'health', 'dupes'];
  if (scope === 'changed') return ['audit'];
  throw new Error(`Unknown Fallow scope: ${scope}`);
}

async function runAnalysis(root, command, outputFile) {
  const execution = executeOwnedCommand(
    'fallow',
    [
      command,
      '--threads',
      '2',
      '--format',
      'json',
      '--quiet',
      '--output-file',
      outputFile,
    ],
    undefined,
    `fallow ${command}`,
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  const stop = () =>
    terminateSuiteExecution(execution, {
      processLabel: `fallow ${command}`,
      terminationGraceMs: 2000,
      terminationForceMs: 2000,
      waitForSuiteSettlement,
    });
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    void stop();
  };
  const capture = captureOwnedProcessOutput(execution, {
    maxBytes: 128 * 1024,
    onOverflow: stop,
  });
  const timeout = setTimeout(onSignal, 120_000);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const result = await execution.completion;
    if (execution.isAlive()) await stop();
    const output = capture.finish();
    // Exit 1 can be a finding verdict. It is usable only with a complete,
    // separately written JSON report; a truncated stdout is never parsed.
    if (
      interrupted ||
      result.error ||
      result.signal ||
      ![0, 1].includes(result.status) ||
      output.truncated
    )
      throw new Error(
        `Fallow ${command} did not complete: ${output.stderr.text}`,
      );
    if (statSync(outputFile).size > 32 * 1024 * 1024)
      throw new Error('Fallow report exceeds the 32 MiB read budget');
    return JSON.parse(readFileSync(outputFile, 'utf8'));
  } finally {
    clearTimeout(timeout);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (execution.isAlive()) await stop();
  }
}

export async function runFallowAudit(root, scope = 'changed') {
  const commands = fallowCommands(scope);
  const directory = join(root, '.kontourai/veritas/external');
  mkdirSync(directory, { recursive: true });
  const artifactPath = join(directory, 'fallow-audit.json');
  // A failed invocation must not leave a previous successful summary looking current.
  writeFileSync(
    artifactPath,
    JSON.stringify({
      schema_version: 'work-agent-fallow-advisory-v1',
      tool: 'fallow',
      scope,
      completed: false,
      verdict: 'error',
    }) + '\n',
  );
  const rawDirectory = mkdtempSync(join(directory, 'fallow-'));
  const inventoryPath =
    scope === 'whole-tree' ? join(rawDirectory, 'inventory.json') : undefined;
  if (inventoryPath) {
    const paths = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
    )
      .split('\0')
      .filter(Boolean);
    writeFileSync(
      inventoryPath,
      `${JSON.stringify(inventoryCodeHealthFiles(root, paths), null, 2)}\n`,
    );
  }
  const reports = [];
  for (const command of commands)
    reports.push(
      await runAnalysis(root, command, join(rawDirectory, `${command}.json`)),
    );
  const summary = summarizeFallowReports(scope, reports);
  const findings =
    scope === 'changed' ? reports[0].complexity?.findings : reports[1].findings;
  const artifact = {
    schema_version: 'work-agent-fallow-advisory-v1',
    tool: 'fallow',
    scope,
    completed: true,
    inventory: inventoryPath ? relative(root, inventoryPath) : undefined,
    source_revision: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim(),
    working_tree_clean:
      execFileSync('git', ['status', '--porcelain'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      }).trim() === '',
    command: commands
      .map((command) => `fallow ${command} --format json`)
      .join(' + '),
    verdict:
      summary.dead_code_issues ||
      summary.complexity_findings ||
      summary.duplication_clone_groups ||
      (scope === 'changed' && summary.source_verdict !== 'pass')
        ? 'warn'
        : 'pass',
    summary,
    raw_reports: commands.map((command) =>
      relative(root, join(rawDirectory, `${command}.json`)),
    ),
    limitations: [
      'Static candidates require caller review.',
      'Complexity coverage may be estimated, not executed.',
      'Configured language, entrypoint, public-API, and ignore rules still apply.',
    ],
    actions: (findings ?? []).slice(0, 20).map((finding) => ({
      type: 'refactor-complexity',
      description: `Review ${finding.name ?? 'function'} at ${finding.path}:${finding.line}`,
      auto_fixable: false,
      paths: [finding.path],
    })),
  };
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + '\n');
  return { artifactPath: relative(root, artifactPath), ...artifact };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--whole-tree')) {
    console.error('usage: run-fallow-audit.mjs [--whole-tree]');
    process.exitCode = 1;
  } else
    try {
      console.log(
        JSON.stringify(
          await runFallowAudit(
            process.cwd(),
            args.includes('--whole-tree') ? 'whole-tree' : 'changed',
          ),
        ),
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
}

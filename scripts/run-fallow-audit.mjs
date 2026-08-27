#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rootDir = process.cwd();
const artifactPath = resolve(
  rootDir,
  '.kontourai/veritas/external/fallow-audit.json',
);
const artifactReference = '.kontourai/veritas/external/fallow-audit.json';

function runFallowAudit() {
  try {
    return execFileSync('fallow', ['audit', '--format', 'json', '--quiet'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    if (error.stdout) return error.stdout;
    throw error;
  }
}

const payload = JSON.parse(runFallowAudit());
const summary = {
  dead_code_issues: payload?.summary?.dead_code_issues ?? 0,
  duplication_clone_groups: payload?.summary?.duplication_clone_groups ?? 0,
  complexity_findings: payload?.summary?.complexity_findings ?? 0,
  changed_files_count: payload?.changed_files_count ?? 0,
  baseline:
    payload?.dead_code?.summary?.total_issues === 0 &&
    payload?.duplication?.stats?.clone_groups === 0,
};
const actions = (payload?.complexity?.findings ?? [])
  .slice(0, 20)
  .map((finding) => ({
    type: 'refactor-complexity',
    description:
      finding.message ?? `Review complexity finding in ${finding.path}`,
    auto_fixable: false,
    paths: finding.path ? [finding.path] : [],
  }));
const artifact = {
  schema_version: 'work-agent-fallow-advisory-v1',
  tool: 'fallow',
  command: 'fallow audit --format json --quiet',
  verdict: payload.verdict === 'pass' ? 'pass' : 'warn',
  summary,
  actions,
};

mkdirSync(resolve(rootDir, '.kontourai/veritas/external'), {
  recursive: true,
});
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

process.stdout.write(
  `${JSON.stringify({ artifactPath: artifactReference, ...artifact })}\n`,
);

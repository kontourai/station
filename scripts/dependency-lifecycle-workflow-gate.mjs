#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readPnpmWorkspace } from './lib/pnpm-lockfile.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const NPM_OPERATIONS = new Map([
  ['ci', 'ci'],
  ['clean-install', 'ci'],
  ['ic', 'ci'],
  ['install', 'install'],
  ['i', 'install'],
  ['in', 'install'],
  ['add', 'install'],
  ['isntall', 'install'],
  ['install-clean', 'install'],
  ['rebuild', 'rebuild'],
  ['rb', 'rebuild'],
]);
const PNPM_OPERATIONS = new Map([
  ['install', 'install'],
  ['i', 'install'],
  ['add', 'install'],
  ['update', 'update'],
  ['up', 'update'],
  ['upgrade', 'update'],
  ['rebuild', 'rebuild'],
  ['rb', 'rebuild'],
  ['approve-builds', 'rebuild'],
]);
const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '--prefix',
  '--location',
  '--loglevel',
  '--userconfig',
  '--cache',
  '--registry',
  '--workspace',
  '-w',
  '--dir',
  '-c',
  '--filter',
  '--filter-prod',
  '-f',
]);
export const REPOSITORY_LIFECYCLE_SOURCES = Object.freeze([
  'Dockerfile',
  'install.sh',
  'package.json',
  'station',
  'pnpm-workspace.yaml',
]);

// Workflows are declarative scalars, not a shell parser. This deliberately
// handles ordinary quoted words and known npm global options, then fails closed
// on lifecycle-enabling flags/env assignments. Shell expansion and generated
// commands are not accepted as a safe wrapper around dependency installation.
function tokens(line) {
  return line.match(/&&|\|\||[;|()]|(?:[^\s'";&|()]+|'[^']*'|"[^"]*")+/g) ?? [];
}

function unwrapScalar(line) {
  const yaml = line.match(/^\s*(?:-\s+)?run\s*:\s*(.+?)\s*$/i)?.[1];
  const json = line.match(/^\s*"[^"]+"\s*:\s*(.+?)\s*,?\s*$/)?.[1];
  const scalar = yaml ?? json ?? line;
  if (scalar.startsWith('"')) {
    try {
      return JSON.parse(scalar.replace(/,\s*$/, ''));
    } catch {
      return scalar;
    }
  }
  if (scalar.startsWith("'") && scalar.endsWith("'"))
    return scalar.slice(1, -1).replaceAll("''", "'");
  return scalar;
}

export function npmInvocation(line) {
  return (
    packageManagerInvocations(line).find((entry) => entry.manager === 'npm') ??
    null
  );
}

export function packageManagerInvocations(line) {
  const values = tokens(unwrapScalar(line));
  const invocations = [];
  for (let start = 0; start < values.length; start += 1) {
    const manager = /^(p?npm)(?:\.cmd)?$/i
      .exec(values[start].replace(/^(['"])(.*)\1$/, '$2'))?.[1]
      ?.toLowerCase();
    if (!manager) continue;
    let index = start + 1;
    while (index < values.length && values[index].startsWith('-')) {
      const option = values[index].toLowerCase();
      index += 1;
      if (
        !option.includes('=') &&
        GLOBAL_OPTIONS_WITH_VALUE.has(option) &&
        !(manager === 'pnpm' && option === '-w') &&
        !(manager === 'npm' && ['-f', '-c'].includes(option))
      )
        index += 1;
    }
    const operation = (
      manager === 'pnpm' ? PNPM_OPERATIONS : NPM_OPERATIONS
    ).get(values[index]?.replace(/^(['"])(.*)\1$/, '$2').toLowerCase());
    const end = values.findIndex(
      (token, tokenIndex) =>
        tokenIndex > start && /^(?:&&|\|\||[;|()])$/.test(token),
    );
    if (operation)
      invocations.push({
        manager,
        operation,
        tokens: values.slice(start, end === -1 ? undefined : end),
      });
  }
  return invocations;
}

function hasEnabledLifecycleFlag(line) {
  const scalar = unwrapScalar(line);
  return (
    /\bp?npm(?:\.cmd)?\b/i.test(scalar) &&
    /(?:--(?:config\.)?ignore-?scripts(?:\s*=\s*|\s+)["']?(?:false|0)["']?|--no-ignore-scripts|config\s+set\s+ignore-?scripts\s+["']?(?:false|0)|--(?:config\.)?verify-?deps-?before-?run(?:\s*=\s*|\s+)["']?(?:install|prompt)|config\s+set\s+verify-?deps-?before-?run\s+["']?(?:install|prompt))\b/i.test(
      scalar,
    )
  );
}

function hasEnabledLifecycleEnv(line) {
  return /\b(?:p?npm_config_ignore_scripts|ignoreScripts)\s*(?::|=)\s*["']?(?:false|0)["']?\b|\b(?:pnpm_config_verify_deps_before_run|verifyDepsBeforeRun)\s*(?::|=)\s*["']?(?:install|prompt)["']?\b/i.test(
    line,
  );
}

export function collectRawNpmLifecycleBypasses(text, file = '<workflow>') {
  const findings = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    const executable = unwrapScalar(line.replace(/#.*/, ''));
    for (const invocation of packageManagerInvocations(executable)) {
      if (invocation?.operation === 'ci')
        findings.push(
          `${file}:${index + 1} must use npm run dependencies:ci instead of raw npm ci`,
        );
      if (
        ['install', 'update'].includes(invocation.operation) &&
        !(
          invocation.manager === 'npm' &&
          /\bnpm\s+install\s+-g\s+npm@/i.test(executable)
        ) &&
        !(
          invocation.tokens.includes(
            invocation.manager === 'pnpm'
              ? '--lockfile-only'
              : '--package-lock-only',
          ) &&
          invocation.tokens.includes('--ignore-scripts') &&
          (invocation.manager === 'pnpm' ||
            invocation.tokens.includes('--force'))
        )
      )
        findings.push(
          `${file}:${index + 1} must use the dependency lifecycle runner instead of raw ${invocation.manager} ${invocation.operation}`,
        );
      if (invocation?.operation === 'rebuild')
        findings.push(
          `${file}:${index + 1} must use the dependency lifecycle runner instead of raw ${invocation.manager} rebuild`,
        );
    }
    if (hasEnabledLifecycleFlag(executable))
      findings.push(
        `${file}:${index + 1} must not re-enable lifecycle scripts or automatic installs through package-manager flags`,
      );
    if (hasEnabledLifecycleEnv(executable))
      findings.push(
        `${file}:${index + 1} must not re-enable lifecycle scripts or automatic installs through configuration`,
      );
    const setupInstall = /^\s*run_install\s*:\s*(.+?)\s*$/.exec(
      executable,
    )?.[1];
    if (setupInstall && !/^["']?false["']?$/i.test(setupInstall))
      findings.push(
        `${file}:${index + 1} package-manager setup must not install dependencies`,
      );
    const nativeSetup = /^(\s*)(-\s+)?uses\s*:\s*["']?pnpm\/setup@/.exec(line);
    if (nativeSetup) {
      const indentation = nativeSetup[1].length + (nativeSetup[2] ? 2 : 0);
      const settings = [];
      for (const following of lines.slice(index + 1)) {
        if (
          following.trim() &&
          (following.match(/^\s*/)?.[0].length ?? 0) < indentation
        )
          break;
        settings.push(following.replace(/#.*/, ''));
      }
      if (
        !/\binstall\s*:\s*["']?false["']?(?:\s|}|$)/.test(settings.join('\n'))
      )
        findings.push(
          `${file}:${index + 1} pnpm/setup must explicitly set install: false; the lifecycle runner owns installation`,
        );
    }
  }
  return findings;
}

export function checkWorkflowDirectory(directory = WORKFLOWS) {
  const workflowFindings = readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .flatMap((name) =>
      collectRawNpmLifecycleBypasses(
        readFileSync(join(directory, name), 'utf8'),
        `.github/workflows/${name}`,
      ),
    );
  const repositoryFindings = REPOSITORY_LIFECYCLE_SOURCES.flatMap((path) =>
    collectRawNpmLifecycleBypasses(
      readFileSync(join(ROOT, path), 'utf8'),
      path,
    ),
  );
  const settings = readPnpmWorkspace(ROOT);
  if (settings.verifyDepsBeforeRun !== false || settings.ignoreScripts !== true)
    repositoryFindings.push(
      'pnpm-workspace.yaml must set verifyDepsBeforeRun: false and ignoreScripts: true',
    );
  return [...workflowFindings, ...repositoryFindings];
}

if (process.argv[1]?.endsWith('dependency-lifecycle-workflow-gate.mjs')) {
  const findings = checkWorkflowDirectory();
  if (findings.length) {
    console.error(findings.join('\n'));
    process.exitCode = 1;
  }
}

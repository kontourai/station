#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '--prefix',
  '--location',
  '--loglevel',
  '--userconfig',
  '--cache',
  '--registry',
  '--workspace',
  '-w',
]);
export const REPOSITORY_LIFECYCLE_SOURCES = Object.freeze([
  'Dockerfile',
  'install.sh',
  'package.json',
  'station',
]);

// Workflows are declarative scalars, not a shell parser. This deliberately
// handles ordinary quoted words and known npm global options, then fails closed
// on lifecycle-enabling flags/env assignments. Shell expansion and generated
// commands are not accepted as a safe wrapper around dependency installation.
function tokens(line) {
  return line.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? [];
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
  const values = tokens(unwrapScalar(line));
  const npm = values.findIndex((value) => /^npm(?:\.cmd)?$/i.test(value));
  if (npm === -1) return null;
  let index = npm + 1;
  while (index < values.length && values[index].startsWith('-')) {
    const option = values[index].toLowerCase();
    index += 1;
    if (!option.includes('=') && GLOBAL_OPTIONS_WITH_VALUE.has(option))
      index += 1;
  }
  const operation = NPM_OPERATIONS.get(values[index]?.toLowerCase());
  return operation ? { operation, tokens: values.slice(npm) } : null;
}

function hasEnabledLifecycleFlag(line) {
  const scalar = unwrapScalar(line);
  return (
    /\bnpm(?:\.cmd)?\b/i.test(scalar) &&
    /(?:--ignore-scripts\s*=\s*["']?(?:false|0)["']?|--no-ignore-scripts)\b/i.test(
      scalar,
    )
  );
}

function hasEnabledLifecycleEnv(line) {
  return /\bnpm_config_ignore_scripts\s*(?::|=)\s*["']?(?:false|0)["']?\b/i.test(
    line,
  );
}

export function collectRawNpmLifecycleBypasses(text, file = '<workflow>') {
  const findings = [];
  for (const [index, line] of text.split('\n').entries()) {
    const executable = unwrapScalar(line.replace(/#.*/, ''));
    const invocation = npmInvocation(executable);
    if (invocation?.operation === 'ci')
      findings.push(
        `${file}:${index + 1} must use npm run dependencies:ci instead of raw npm ci`,
      );
    if (
      invocation?.operation === 'install' &&
      !/\bnpm\s+install\s+-g\s+npm@/i.test(executable) &&
      !(
        invocation.tokens.includes('--package-lock-only') &&
        invocation.tokens.includes('--ignore-scripts') &&
        invocation.tokens.includes('--force')
      )
    )
      findings.push(
        `${file}:${index + 1} must use the dependency lifecycle runner instead of raw npm install`,
      );
    if (invocation?.operation === 'rebuild')
      findings.push(
        `${file}:${index + 1} must use the dependency lifecycle runner instead of raw npm rebuild`,
      );
    if (hasEnabledLifecycleFlag(executable))
      findings.push(
        `${file}:${index + 1} must not re-enable lifecycle scripts through npm flags`,
      );
    if (hasEnabledLifecycleEnv(executable))
      findings.push(
        `${file}:${index + 1} must not re-enable lifecycle scripts through npm_config_ignore_scripts`,
      );
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
  return [...workflowFindings, ...repositoryFindings];
}

if (process.argv[1]?.endsWith('dependency-lifecycle-workflow-gate.mjs')) {
  const findings = checkWorkflowDirectory();
  if (findings.length) {
    console.error(findings.join('\n'));
    process.exitCode = 1;
  }
}

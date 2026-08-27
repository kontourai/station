import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAll } from 'js-yaml';

const DEFAULT_REPO_ROOT = resolve(import.meta.dirname, '..');
const LANE_ROOTS = Object.freeze([
  'full:regression:raw',
  'verify:static:raw',
  'ci:fast',
  'test:prepush',
  'verify',
]);
const CLASSIFICATIONS = new Set(['enforced', 'candidate', 'advisory']);
const NPM_RUN_PATTERN = /\bnpm\s+run\s+([A-Za-z0-9][A-Za-z0-9:._-]*)/g;
const EXACT_NPM_RUN_PATTERN = /^npm\s+run\s+([A-Za-z0-9][A-Za-z0-9:._-]*)$/;

function parseArguments(argv) {
  if (argv.length === 0) return DEFAULT_REPO_ROOT;
  if (argv.length === 2 && argv[0] === '--repo-root') {
    return resolve(argv[1]);
  }
  throw new Error(
    'usage: evidence-check-execution-gate.mjs [--repo-root <path>]',
  );
}

function readJson(path, label, errors) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(`${label} must be readable valid JSON: ${error.message}`);
    return undefined;
  }
}

function extractNpmScripts(command) {
  const scripts = [];
  for (const match of command.matchAll(NPM_RUN_PATTERN)) scripts.push(match[1]);
  return scripts;
}

function expandLaneRoots(scripts, errors) {
  const roots = new Set();
  for (const root of LANE_ROOTS) {
    roots.add(root);
    if (!root.endsWith(':raw') && Object.hasOwn(scripts, `${root}:raw`)) {
      roots.add(`${root}:raw`);
    }
  }

  const reachable = new Set();
  const pending = [...roots];
  while (pending.length > 0) {
    const scriptName = pending.pop();
    if (reachable.has(scriptName)) continue;
    if (!Object.hasOwn(scripts, scriptName)) {
      errors.push(
        `lane-root script "${scriptName}" is missing from package.json`,
      );
      continue;
    }
    reachable.add(scriptName);
    for (const child of extractNpmScripts(scripts[scriptName])) {
      if (!reachable.has(child)) pending.push(child);
    }
  }
  return reachable;
}

function collectRunBlocks(value, runBlocks) {
  if (Array.isArray(value)) {
    for (const entry of value) collectRunBlocks(entry, runBlocks);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'run' && typeof entry === 'string') runBlocks.push(entry);
    else collectRunBlocks(entry, runBlocks);
  }
}

function workflowReachability(repoRoot, errors) {
  const workflowDir = resolve(repoRoot, '.github/workflows');
  let workflowFiles;
  try {
    workflowFiles = readdirSync(workflowDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:yaml|yml)$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    errors.push(`workflow directory must be readable: ${error.message}`);
    return new Set();
  }

  const reachable = new Set();
  for (const file of workflowFiles) {
    const path = resolve(workflowDir, file);
    try {
      const documents = [];
      loadAll(readFileSync(path, 'utf8'), (document) =>
        documents.push(document),
      );
      const runBlocks = [];
      for (const document of documents) collectRunBlocks(document, runBlocks);
      for (const runBlock of runBlocks) {
        for (const scriptName of extractNpmScripts(runBlock)) {
          reachable.add(scriptName);
        }
      }
    } catch (error) {
      errors.push(
        `workflow ${file} must be readable valid YAML: ${error.message}`,
      );
    }
  }
  return reachable;
}

function executeCandidate(repoRoot, scriptName) {
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawnSync(executable, ['--silent', 'run', scriptName], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
}

function evidenceScriptName(check, errors) {
  const match =
    typeof check.command === 'string'
      ? check.command.match(EXACT_NPM_RUN_PATTERN)
      : undefined;
  if (!match) {
    errors.push(
      `evidence check "${check.id}" command must have the exact form "npm run <name>"`,
    );
    return undefined;
  }
  return match[1];
}

function validate(repoRoot) {
  const errors = [];
  const repoMap = readJson(
    resolve(repoRoot, '.veritas/repo-map.json'),
    '.veritas/repo-map.json',
    errors,
  );
  const mapping = readJson(
    resolve(repoRoot, 'scripts/evidence-check-execution.json'),
    'scripts/evidence-check-execution.json',
    errors,
  );
  const packageJson = readJson(
    resolve(repoRoot, 'package.json'),
    'package.json',
    errors,
  );
  if (!repoMap || !mapping || !packageJson) return errors;

  const checks = repoMap.evidence?.evidenceChecks;
  if (!Array.isArray(checks)) {
    errors.push('.veritas/repo-map.json must define evidence.evidenceChecks');
    return errors;
  }
  if (!mapping || Array.isArray(mapping) || typeof mapping !== 'object') {
    errors.push('scripts/evidence-check-execution.json must contain an object');
    return errors;
  }
  const scripts = packageJson.scripts;
  if (!scripts || Array.isArray(scripts) || typeof scripts !== 'object') {
    errors.push('package.json must define a scripts object');
    return errors;
  }

  const checksById = new Map();
  for (const check of checks) {
    if (!check || typeof check.id !== 'string' || check.id.length === 0) {
      errors.push(
        'every repo-map evidence check must have a non-empty string id',
      );
      continue;
    }
    if (checksById.has(check.id)) {
      errors.push(`repo-map evidence-check id "${check.id}" is duplicated`);
      continue;
    }
    checksById.set(check.id, check);
  }

  if (typeof mapping._note !== 'string' || mapping._note.length === 0) {
    errors.push('execution mapping _note must be a non-empty string');
  }
  const mappingEntries = Object.entries(mapping).filter(
    ([id]) => id !== '_note',
  );
  const mappingIds = new Set(mappingEntries.map(([id]) => id));
  for (const id of checksById.keys()) {
    if (!mappingIds.has(id)) {
      errors.push(
        `execution mapping is missing repo-map evidence-check id "${id}"`,
      );
    }
  }
  for (const [id] of mappingEntries) {
    if (!checksById.has(id)) {
      errors.push(`execution mapping has unknown evidence-check id "${id}"`);
    }
  }
  if (errors.length > 0) return errors;

  const laneReachable = expandLaneRoots(scripts, errors);
  const workflowReachable = workflowReachability(repoRoot, errors);
  const reachable = new Set([...laneReachable, ...workflowReachable]);

  for (const [id, classification] of mappingEntries) {
    if (!CLASSIFICATIONS.has(classification)) {
      errors.push(
        `evidence check "${id}" has invalid execution classification ${JSON.stringify(classification)}; expected enforced, candidate, or advisory`,
      );
      continue;
    }
    const scriptName = evidenceScriptName(checksById.get(id), errors);
    if (!scriptName) continue;
    const isReachable = reachable.has(scriptName);

    if (classification === 'enforced' && !isReachable) {
      errors.push(
        `evidence check "${id}" is enforced but "npm run ${scriptName}" is unreachable from every lane root and workflow run block`,
      );
    }
    if (classification === 'candidate') {
      if (isReachable) {
        errors.push(
          `evidence check "${id}" is candidate but "npm run ${scriptName}" is reachable; expected it to be unreachable from every lane root and workflow run block`,
        );
      }
      const result = executeCandidate(repoRoot, scriptName);
      if (result.error) {
        errors.push(
          `evidence check "${id}" is candidate but "npm run ${scriptName}" did not produce an exit status: ${result.error.message}`,
        );
      } else if (result.status === 0) {
        errors.push(
          `evidence check "${id}" is candidate but "npm run ${scriptName}" exited 0; expected a non-zero exit`,
        );
      } else if (result.status === null) {
        errors.push(
          `evidence check "${id}" is candidate but "npm run ${scriptName}" did not produce an exit status${result.signal ? ` (signal ${result.signal})` : ''}`,
        );
      }
    }
    if (classification === 'advisory' && isReachable) {
      errors.push(
        `evidence check "${id}" is advisory but "npm run ${scriptName}" is reachable; expected it to be unreachable from every lane root and workflow run block`,
      );
    }
  }
  return errors;
}

let errors;
try {
  errors = validate(parseArguments(process.argv.slice(2)));
} catch (error) {
  errors = [error.message];
}

if (errors.length > 0) {
  console.error('Evidence-check execution gate failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log('Evidence-check execution gate passed.');
}

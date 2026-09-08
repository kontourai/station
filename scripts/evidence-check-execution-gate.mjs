import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
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
// The npm-run graph and the workflow run blocks are not the only things that
// execute a check. A Vitest file that spawns scripts/<name>.mjs and asserts
// its exit status runs it inside the corpus -- for PROCESS_HEAVY files, under
// full:regression, the nightly and release gate. That execution was invisible
// here, so `advisory` could carry the note "no Station lane consumes its exit
// status" for a check the nightly corpus does consume (#1746).
const TEST_CORPUS_ROOTS = Object.freeze([
  'scripts/__tests__',
  'src-server',
  'src-ui',
  'src-desktop',
  'packages',
  'tests',
]);
const CORPUS_SKIPPED_DIRECTORIES = new Set([
  '.git',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);
const CORPUS_TEST_FILE_PATTERN = /\.test\.[cm]?[jt]sx?$/;
// A path mentioned in prose is not an execution. Requiring a spawn form in
// the same file is what separates "this test runs the script" from "this test
// names the script"; both shapes exist in the real corpus today.
//
// The signal is deliberately file-level co-occurrence, not an argv match. A
// stricter rule would miss the case this gate exists for:
// proof-repo-guardrails-fail-closed.test.ts reads the real script's source,
// writes a copy (unmutated for its positive control) into a temporary
// directory, and spawns THAT -- so no spawn argument ever holds the
// repository path. File-level co-occurrence is therefore evidence the corpus
// reaches the check, not proof of a direct invocation, and the messages below
// say exactly what was observed.
const SPAWN_FORM_PATTERN =
  /\bspawnSync\b|\bexecFileSync\b|\bexecFile\(|\bspawn\(/;
const SCRIPT_FILE_PATTERN = /scripts\/[A-Za-z0-9][A-Za-z0-9._-]*\.mjs/g;
const CORPUS_EXECUTION_KEY = '_corpusExecution';
const CORPUS_EXECUTION_ACKNOWLEDGED = 'acknowledged';
const MAPPING_METADATA_KEYS = new Set(['_note', CORPUS_EXECUTION_KEY]);

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

function repoRelativePath(repoRoot, path) {
  return relative(repoRoot, path).split(sep).join('/');
}

function collectCorpusTestFiles(repoRoot) {
  const files = [];
  // A symlinked directory reports isDirectory() false through withFileTypes,
  // so the walk cannot follow one out of the repository or into a cycle.
  const pending = TEST_CORPUS_ROOTS.map((root) => resolve(repoRoot, root));
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      // A root a repository does not have is not a corpus, and not an error:
      // the gate runs against fixture roots that carry only what they test.
      continue;
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!CORPUS_SKIPPED_DIRECTORIES.has(entry.name)) pending.push(path);
      } else if (entry.isFile() && CORPUS_TEST_FILE_PATTERN.test(entry.name)) {
        files.push(path);
      }
    }
  }
  return files.sort();
}

/**
 * Map every `scripts/<name>.mjs` path a corpus test spawns to the test files
 * that spawn it. Read failures are recorded, never swallowed: a corpus this
 * gate could not read is not a corpus that runs nothing.
 */
function corpusExecutionIndex(repoRoot, errors) {
  const index = new Map();
  for (const file of collectCorpusTestFiles(repoRoot)) {
    let contents;
    try {
      contents = readFileSync(file, 'utf8');
    } catch (error) {
      errors.push(
        `test corpus file "${repoRelativePath(repoRoot, file)}" must be readable: ${error.message}`,
      );
      continue;
    }
    if (!SPAWN_FORM_PATTERN.test(contents)) continue;
    for (const match of contents.matchAll(SCRIPT_FILE_PATTERN)) {
      const existing = index.get(match[0]);
      const testPath = repoRelativePath(repoRoot, file);
      if (existing) existing.add(testPath);
      else index.set(match[0], new Set([testPath]));
    }
  }
  return index;
}

/** Every `scripts/<name>.mjs` file an npm script reaches, npm run children included. */
function resolveScriptFiles(scripts, scriptName) {
  const files = new Set();
  const seen = new Set();
  const pending = [scriptName];
  while (pending.length > 0) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const command = scripts[name];
    if (typeof command !== 'string') continue;
    for (const match of command.matchAll(SCRIPT_FILE_PATTERN))
      files.add(match[0]);
    for (const child of extractNpmScripts(command)) pending.push(child);
  }
  return [...files].sort();
}

function corpusExecutors(scripts, scriptName, corpusIndex) {
  const executors = [];
  for (const file of resolveScriptFiles(scripts, scriptName)) {
    for (const test of [...(corpusIndex.get(file) ?? [])].sort())
      executors.push({ file, test });
  }
  return executors;
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
    ([id]) => !MAPPING_METADATA_KEYS.has(id),
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
  const acknowledgements = mapping[CORPUS_EXECUTION_KEY];
  const acknowledgedIds = new Set();
  if (acknowledgements !== undefined) {
    if (
      !acknowledgements ||
      typeof acknowledgements !== 'object' ||
      Array.isArray(acknowledgements)
    ) {
      errors.push(
        `execution mapping ${CORPUS_EXECUTION_KEY} must be an object of evidence-check id to ${JSON.stringify(CORPUS_EXECUTION_ACKNOWLEDGED)}`,
      );
    } else {
      for (const [id, value] of Object.entries(acknowledgements)) {
        if (!checksById.has(id)) {
          errors.push(
            `execution mapping ${CORPUS_EXECUTION_KEY} has unknown evidence-check id "${id}"`,
          );
          continue;
        }
        if (value !== CORPUS_EXECUTION_ACKNOWLEDGED) {
          errors.push(
            `execution mapping ${CORPUS_EXECUTION_KEY}."${id}" must be ${JSON.stringify(CORPUS_EXECUTION_ACKNOWLEDGED)}, not ${JSON.stringify(value)}`,
          );
          continue;
        }
        acknowledgedIds.add(id);
      }
    }
  }
  if (errors.length > 0) return errors;

  const laneReachable = expandLaneRoots(scripts, errors);
  const workflowReachable = workflowReachability(repoRoot, errors);
  const reachable = new Set([...laneReachable, ...workflowReachable]);
  const corpusIndex = corpusExecutionIndex(repoRoot, errors);

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
    // An advisory check the Vitest corpus spawns is executed, whatever the
    // npm-run graph says. Either the mapping acknowledges that execution, or
    // the classification is a claim the repository contradicts.
    const executors = corpusExecutors(scripts, scriptName, corpusIndex);
    const acknowledged = acknowledgedIds.has(id);
    if (
      classification === 'advisory' &&
      executors.length > 0 &&
      !acknowledged
    ) {
      errors.push(
        `evidence check "${id}" is advisory but the Vitest corpus reaches it: ${executors
          .map(
            ({ file, test }) =>
              `${test} names ${file} and spawns a child process`,
          )
          .join(
            '; ',
          )}; reclassify it, or record "${id}": "${CORPUS_EXECUTION_ACKNOWLEDGED}" under ${CORPUS_EXECUTION_KEY} and say so in _note`,
      );
    }
    if (acknowledged && classification !== 'advisory') {
      errors.push(
        `evidence check "${id}" is ${classification} but ${CORPUS_EXECUTION_KEY} acknowledges it; the acknowledgement only qualifies an advisory classification`,
      );
    }
    if (acknowledged && executors.length === 0) {
      errors.push(
        `evidence check "${id}" is acknowledged as corpus-executed but no test file names a script "npm run ${scriptName}" runs while spawning a child process; remove the ${CORPUS_EXECUTION_KEY} entry`,
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

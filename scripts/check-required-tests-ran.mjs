#!/usr/bin/env node
/**
 * Did the named tests actually run? (#4772)
 *
 *     node scripts/check-required-tests-ran.mjs --profile <name> --report <vitest-json>
 *
 * A green Vitest run proves nothing about a test it skipped or never
 * collected. This reads the JSON report a real Vitest run wrote
 * (`--reporter=json --outputFile.json=<path>`, the format the focused runner
 * and hosted shards already use) and a pinned profile from
 * `scripts/required-test-profiles.json`, and exits 0 only when:
 *
 * - every `mustPass` id is present exactly once and passed, and
 * - every `mayRuntimeSkip` id is present exactly once and passed or skipped.
 *
 * An id is the test file relative to `--root` (default: the working
 * directory) plus the exact title path (describe titles, then the test
 * title). Matching is exact; a renamed test is absent, not "close enough".
 * `notRequired` entries are documentation of a deliberate exclusion and are
 * never checked against the report.
 *
 * Exit status: 0 every required id ran; 1 at least one did not (each is named
 * on stderr); 2 the report or profile is missing, empty or malformed, or the
 * arguments are wrong. Nothing here reads a missing input as success.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokedDirectly } from './lib/module-entry.mjs';

const DEFAULT_PROFILES_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'required-test-profiles.json',
);

const PROFILE_KEYS = ['description', 'files'];
const FILE_KEYS = ['mustPass', 'mayRuntimeSkip', 'notRequired'];

class InputError extends Error {}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...keys].sort());
}

function titlePath(value, where) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((title) => typeof title === 'string' && title.length > 0)
  )
    throw new InputError(
      `${where}: a test id must be a nonempty array of nonempty title strings`,
    );
  return value;
}

/** `file` + title path as one exact key. JSON keeps the parts unambiguous. */
function testIdKey(file, titles) {
  return JSON.stringify([file, ...titles]);
}

function describeTestId(file, titles) {
  return `${file} > ${titles.join(' > ')}`;
}

/**
 * The named profile, validated. Unknown keys, empty `mustPass` lists and an
 * id listed twice are refused so the profile cannot silently shrink.
 */
function loadProfile(profilesPath, name) {
  if (!existsSync(profilesPath))
    throw new InputError(`profile file not found: ${profilesPath}`);
  let profiles;
  try {
    profiles = JSON.parse(readFileSync(profilesPath, 'utf8'));
  } catch (error) {
    throw new InputError(
      `profile file is not valid JSON: ${profilesPath}: ${error.message}`,
    );
  }
  if (!isPlainObject(profiles) || !Object.hasOwn(profiles, name))
    throw new InputError(`no profile named "${name}" in ${profilesPath}`);
  const profile = profiles[name];
  if (
    !isPlainObject(profile) ||
    !hasExactKeys(profile, PROFILE_KEYS) ||
    typeof profile.description !== 'string' ||
    !isPlainObject(profile.files) ||
    Object.keys(profile.files).length === 0
  )
    throw new InputError(
      `profile "${name}" must have exactly a description string and a nonempty files map`,
    );
  const required = [];
  const seen = new Set();
  for (const [file, entry] of Object.entries(profile.files)) {
    const where = `profile "${name}" file ${file}`;
    if (
      !isPlainObject(entry) ||
      !hasExactKeys(entry, FILE_KEYS) ||
      !Array.isArray(entry.mustPass) ||
      entry.mustPass.length === 0 ||
      !Array.isArray(entry.mayRuntimeSkip) ||
      !Array.isArray(entry.notRequired)
    )
      throw new InputError(
        `${where}: needs exactly mustPass (nonempty), mayRuntimeSkip and notRequired arrays`,
      );
    const classify = (titles, mayRuntimeSkip) => {
      const key = testIdKey(file, titles);
      if (seen.has(key))
        throw new InputError(
          `${where}: listed twice: ${describeTestId(file, titles)}`,
        );
      seen.add(key);
      return { file, titles, mayRuntimeSkip };
    };
    for (const titles of entry.mustPass)
      required.push(classify(titlePath(titles, where), false));
    for (const item of entry.mayRuntimeSkip) {
      if (!isPlainObject(item) || !hasExactKeys(item, ['test', 'reason']))
        throw new InputError(`${where}: mayRuntimeSkip needs {test, reason}`);
      required.push(classify(titlePath(item.test, where), true));
    }
    for (const item of entry.notRequired) {
      if (!isPlainObject(item) || !hasExactKeys(item, ['test', 'reason']))
        throw new InputError(`${where}: notRequired needs {test, reason}`);
      classify(titlePath(item.test, where), false);
    }
  }
  return { name, required, notRequired: seen.size - required.length };
}

/**
 * Statuses by id from a Vitest JSON report. Every result must have the shape
 * the reporter writes; one that does not makes the whole report unusable.
 */
function readReport(reportPath, root) {
  if (!existsSync(reportPath))
    throw new InputError(`report not found: ${reportPath}`);
  const text = readFileSync(reportPath, 'utf8');
  if (text.trim() === '')
    throw new InputError(`report is empty: ${reportPath}`);
  let report;
  try {
    report = JSON.parse(text);
  } catch (error) {
    throw new InputError(
      `report is not valid JSON: ${reportPath}: ${error.message}`,
    );
  }
  if (!isPlainObject(report) || !Array.isArray(report.testResults))
    throw new InputError(
      `report has no testResults array; is it a Vitest JSON report? ${reportPath}`,
    );
  const statuses = new Map();
  for (const [index, fileResult] of report.testResults.entries()) {
    if (
      !isPlainObject(fileResult) ||
      typeof fileResult.name !== 'string' ||
      !Array.isArray(fileResult.assertionResults)
    )
      throw new InputError(
        `report testResults[${index}] lacks a file name or assertionResults`,
      );
    const file = path
      .relative(root, path.resolve(root, fileResult.name))
      .split(path.sep)
      .join('/');
    for (const [position, result] of fileResult.assertionResults.entries()) {
      if (
        !isPlainObject(result) ||
        !Array.isArray(result.ancestorTitles) ||
        !result.ancestorTitles.every((title) => typeof title === 'string') ||
        typeof result.title !== 'string' ||
        typeof result.status !== 'string'
      )
        throw new InputError(
          `report testResults[${index}].assertionResults[${position}] is not a Vitest assertion result`,
        );
      const key = testIdKey(file, [...result.ancestorTitles, result.title]);
      statuses.set(key, [...(statuses.get(key) ?? []), result.status]);
    }
  }
  return statuses;
}

/** Each required id that did not run as the profile demands, with why. */
function evaluateRequiredTests(required, statuses) {
  const failures = [];
  const skipped = [];
  for (const id of required) {
    const found = statuses.get(testIdKey(id.file, id.titles)) ?? [];
    const label = describeTestId(id.file, id.titles);
    if (found.length === 0) failures.push(`absent: ${label}`);
    else if (found.length > 1)
      failures.push(
        `ambiguous (${found.length} results: ${found.join(', ')}): ${label}`,
      );
    else if (found[0] === 'passed') continue;
    else if (found[0] === 'skipped' && id.mayRuntimeSkip) skipped.push(label);
    else if (found[0] === 'skipped')
      failures.push(`skipped, and must not skip: ${label}`);
    else failures.push(`${found[0]}: ${label}`);
  }
  return { failures, skipped };
}

function parseArguments(argv) {
  const options = {
    profiles: DEFAULT_PROFILES_PATH,
    root: process.cwd(),
  };
  const names = new Map([
    ['--profile', 'profile'],
    ['--report', 'report'],
    ['--profiles', 'profiles'],
    ['--root', 'root'],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index]);
    const value = argv[index + 1];
    if (!key || value === undefined || value === '')
      throw new InputError(
        'usage: check-required-tests-ran.mjs --profile <name> --report <vitest-json> [--root <dir>] [--profiles <json>]',
      );
    options[key] = value;
  }
  if (!options.profile || !options.report)
    throw new InputError('--profile and --report are both required');
  return options;
}

function main(argv = process.argv.slice(2)) {
  let profile;
  let statuses;
  try {
    const options = parseArguments(argv);
    const root = path.resolve(options.root);
    profile = loadProfile(path.resolve(options.profiles), options.profile);
    statuses = readReport(path.resolve(options.report), root);
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    process.stderr.write(`[required-tests] FAIL: ${error.message}\n`);
    return 2;
  }
  const { failures, skipped } = evaluateRequiredTests(
    profile.required,
    statuses,
  );
  for (const label of skipped)
    process.stdout.write(
      `[required-tests] skipped at runtime (allowed by the profile): ${label}\n`,
    );
  if (failures.length > 0) {
    process.stderr.write(
      `[required-tests] FAIL: ${failures.length} of ${profile.required.length} required test(s) in profile "${profile.name}" did not run as required:\n`,
    );
    for (const failure of failures)
      process.stderr.write(`[required-tests]   ${failure}\n`);
    return 1;
  }
  process.stdout.write(
    `[required-tests] OK: profile "${profile.name}": ${profile.required.length - skipped.length} passed, ${skipped.length} allowed runtime skip(s), ${profile.notRequired} not required\n`,
  );
  return 0;
}

if (invokedDirectly(import.meta.url)) process.exitCode = main();

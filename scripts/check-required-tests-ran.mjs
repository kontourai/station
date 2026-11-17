#!/usr/bin/env node
/**
 * Did the named tests actually run? (#4772)
 *
 *     node scripts/check-required-tests-ran.mjs --profile-name <name> --report <vitest-json>
 *
 * A green Vitest run proves nothing about a test it skipped or never
 * collected. This reads the JSON report a real Vitest run wrote
 * (`--reporter=json --outputFile.json=<path>`, the format the focused runner
 * and hosted shards already use) and a pinned profile from
 * `scripts/required-test-profiles.json`, and exits 0 only when:
 *
 * - every `mustPass` id is present exactly once and passed, and
 * - every `mayRuntimeSkip` id is present exactly once and either passed or
 *   skipped after the test started (`ctx.skip()` in its body or in a
 *   `beforeEach` hook).
 *
 * An id is the test file relative to `--root` (default: the working
 * directory) plus the exact title path (describe titles, then the test
 * title). Matching is exact; a renamed test is absent, not "close enough".
 * `notRequired` entries are documentation of a deliberate exclusion and are
 * never checked against the report.
 *
 * It reads only the pinned ids, not the run's overall result: a run can have
 * other failing tests while every pinned id passed. It complements the test
 * step's own exit status and does not replace it.
 *
 * Exit status: 0 every required id ran; 1 at least one did not (each is named
 * on stderr); 2 an input is unusable (the report or profile file is missing,
 * unreadable, a directory or another non-regular file such as a FIFO, empty
 * or malformed, a profile entry is invalid, or the arguments are wrong,
 * including a flag given more than once), with one line on stderr. Nothing
 * here reads a missing input as success.
 */
import { readFileSync, statSync } from 'node:fs';
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

/** What a path is when it is neither a regular file nor a directory. */
function specialFileKind(stats) {
  if (stats.isFIFO()) return 'a FIFO';
  if (stats.isSocket()) return 'a socket';
  if (stats.isCharacterDevice() || stats.isBlockDevice()) return 'a device';
  return 'another special file';
}

/**
 * A file's text, or an InputError naming why it cannot be read (missing, a
 * directory, permission denied, ...), so an unusable input exits 2, never 1.
 * A FIFO, socket or device is refused before reading: a FIFO with no writer
 * would block the read forever. A directory is left to the read, which
 * refuses it with EISDIR.
 */
function readInput(kind, filePath) {
  try {
    // statSync follows symlinks, so a dangling one is ENOENT: not found.
    const stats = statSync(filePath);
    if (!stats.isFile() && !stats.isDirectory())
      throw new InputError(
        `${kind} is not a regular file (${specialFileKind(stats)}): ${filePath}`,
      );
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error instanceof InputError) throw error;
    if (error?.code === 'ENOENT')
      throw new InputError(`${kind} not found: ${filePath}`);
    throw new InputError(
      `${kind} is unreadable (${error?.code ?? error?.message}): ${filePath}`,
    );
  }
}

/** A `{test, reason}` entry; the reason must say something. */
function reasonedEntry(item, list, where) {
  if (
    !isPlainObject(item) ||
    !hasExactKeys(item, ['test', 'reason']) ||
    typeof item.reason !== 'string' ||
    item.reason.trim() === ''
  )
    throw new InputError(
      `${where}: ${list} needs {test, reason} with a nonempty reason string`,
    );
  return titlePath(item.test, where);
}

/**
 * The named profile, validated. Unknown keys, empty `mustPass` lists and an
 * id listed twice are refused so the profile cannot silently shrink.
 */
function loadProfile(profilesPath, name) {
  const text = readInput('profile file', profilesPath);
  let profiles;
  try {
    profiles = JSON.parse(text);
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
    for (const item of entry.mayRuntimeSkip)
      required.push(
        classify(reasonedEntry(item, 'mayRuntimeSkip', where), true),
      );
    for (const item of entry.notRequired)
      classify(reasonedEntry(item, 'notRequired', where), false);
  }
  return { name, required, notRequired: seen.size - required.length };
}

/**
 * Statuses by id from a Vitest JSON report. Every result must have the shape
 * the reporter writes; one that does not makes the whole report unusable.
 */
function readReport(reportPath, root) {
  const text = readInput('report', reportPath);
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
      // The reporter gives a duration only to a test that started (its
      // `beforeEach` hooks or body ran). A skipped result without one was
      // skipped before it started: a skipped suite, `test.skipIf`, or a name
      // filter that left it out. The agreement test re-checks this premise
      // against the installed Vitest.
      const status =
        result.status === 'skipped' && typeof result.duration === 'number'
          ? 'skipped at runtime'
          : result.status;
      statuses.set(key, [...(statuses.get(key) ?? []), status]);
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
    else if (found[0] === 'skipped at runtime' && id.mayRuntimeSkip)
      skipped.push(label);
    else if (found[0] === 'skipped' && id.mayRuntimeSkip)
      failures.push(`skipped before it started, not at runtime: ${label}`);
    else if (found[0] === 'skipped' || found[0] === 'skipped at runtime')
      failures.push(`${found[0]}, and must not skip: ${label}`);
    else failures.push(`${found[0]}: ${label}`);
  }
  return { failures, skipped };
}

function parseArguments(argv) {
  const options = {
    profilesFile: DEFAULT_PROFILES_PATH,
    root: process.cwd(),
  };
  const names = new Map([
    ['--profile-name', 'profileName'],
    ['--report', 'report'],
    ['--profiles-file', 'profilesFile'],
    ['--root', 'root'],
  ]);
  const given = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const key = names.get(flag);
    const value = argv[index + 1];
    if (!key || value === undefined || value === '')
      throw new InputError(
        'usage: check-required-tests-ran.mjs --profile-name <name> --report <vitest-json> [--root <dir>] [--profiles-file <json>]',
      );
    // Last-one-wins would let `--report missing.json --report good.json`
    // check a different file than the caller meant to name.
    if (given.has(flag)) throw new InputError(`${flag} given more than once`);
    given.add(flag);
    options[key] = value;
  }
  if (!options.profileName || !options.report)
    throw new InputError('--profile-name and --report are both required');
  return options;
}

function main(argv = process.argv.slice(2)) {
  let profile;
  let statuses;
  try {
    const options = parseArguments(argv);
    const root = path.resolve(options.root);
    profile = loadProfile(
      path.resolve(options.profilesFile),
      options.profileName,
    );
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

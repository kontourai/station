#!/usr/bin/env node
/**
 * Runs the agent-activity plugin's Kotlin unit tests (model, registration pin,
 * AES-GCM known-answer vectors) without a Rust build (#2516).
 *
 * In a real Android build the plugin reaches Gradle through
 * `src-desktop/gen/android/tauri.settings.gradle`, which only exists after
 * `tauri android build` has compiled the app for an Android target. The unit
 * tests need none of that: they need the plugin's Gradle project and the
 * `:tauri-android` library it depends on. So this script builds a throwaway
 * Gradle root holding exactly those two projects, reusing the checked-in
 * gen/android root build script, gradle.properties and Gradle wrapper, so the
 * AGP, Kotlin and Gradle versions stay the ones the APK is built with.
 *
 * `:tauri-android` is the `mobile/android` directory of the `tauri` crate that
 * Cargo.lock resolves: the same directory tauri-plugin's build script copies to
 * the plugin's `.tauri/tauri-api` (DEP_TAURI_ANDROID_LIBRARY_PATH).
 *
 * Fails closed: a Gradle run that executes no tests, or skips a test class
 * under src/test, is a failure, not a pass.
 *
 * Usage: node scripts/run-agent-activity-android-unit-tests.mjs [gradle args...]
 * Needs cargo, a JDK 17+ (JAVA_HOME), and an Android SDK (ANDROID_HOME).
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = 'tauri-plugin-station-agent-activity';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const genAndroid = join(repoRoot, 'src-desktop', 'gen', 'android');
const pluginAndroid = join(
  repoRoot,
  'src-desktop',
  'plugins',
  'agent-activity',
  'android',
);
const testSources = join(pluginAndroid, 'src', 'test', 'java');
const testResults = join(
  pluginAndroid,
  'build',
  'test-results',
  'testDebugUnitTest',
);

function fail(message) {
  console.error(`agent-activity Kotlin unit tests: ${message}`);
  process.exit(1);
}

function tauriAndroidLibrary() {
  const result = spawnSync(
    'cargo',
    [
      'metadata',
      '--format-version',
      '1',
      '--locked',
      '--manifest-path',
      join(repoRoot, 'src-desktop', 'Cargo.toml'),
    ],
    {
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    },
  );
  if (result.error) fail(`cargo metadata did not run: ${result.error.message}`);
  if (result.status !== 0)
    fail(`cargo metadata exited ${result.status ?? result.signal}`);
  const tauri = JSON.parse(result.stdout).packages.filter(
    (pkg) => pkg.name === 'tauri',
  );
  if (tauri.length !== 1)
    fail(`expected one resolved tauri crate, found ${tauri.length}`);
  const library = join(dirname(tauri[0].manifest_path), 'mobile', 'android');
  if (!existsSync(join(library, 'build.gradle.kts')))
    fail(`no Android library at ${library}`);
  return library;
}

/** Test classes expected from the sources, as JUnit report names. */
function expectedTestClasses() {
  const classes = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/Test\.kt$/.test(entry.name))
        classes.push(
          relative(testSources, path).replace(/\.kt$/, '').split(sep).join('.'),
        );
    }
  };
  walk(testSources);
  if (classes.length === 0) fail(`no *Test.kt sources under ${testSources}`);
  return classes.sort();
}

function groovyString(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

const expected = expectedTestClasses();
const tauriAndroid = tauriAndroidLibrary();
const root = mkdtempSync(join(tmpdir(), 'agent-activity-unit-tests-'));
let status = 1;
try {
  copyFileSync(
    join(genAndroid, 'build.gradle.kts'),
    join(root, 'build.gradle.kts'),
  );
  copyFileSync(
    join(genAndroid, 'gradle.properties'),
    join(root, 'gradle.properties'),
  );
  writeFileSync(
    join(root, 'settings.gradle'),
    [
      "rootProject.name = 'agent-activity-unit-tests'",
      "include ':tauri-android'",
      `project(':tauri-android').projectDir = new File(${groovyString(tauriAndroid)})`,
      `include ':${PROJECT}'`,
      `project(':${PROJECT}').projectDir = new File(${groovyString(pluginAndroid)})`,
      '',
    ].join('\n'),
  );
  // Stale reports from an earlier run must not satisfy the check below.
  rmSync(testResults, { recursive: true, force: true });

  const gradlew = join(
    genAndroid,
    process.platform === 'win32' ? 'gradlew.bat' : 'gradlew',
  );
  const gradle = spawnSync(
    gradlew,
    [
      '-p',
      root,
      '--console=plain',
      `:${PROJECT}:testDebugUnitTest`,
      ...process.argv.slice(2),
    ],
    {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      windowsHide: true,
    },
  );
  status = gradle.error
    ? `did not run: ${gradle.error.message}`
    : (gradle.status ?? `died on ${gradle.signal}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
if (status !== 0)
  fail(`Gradle ${typeof status === 'number' ? `exited ${status}` : status}`);

const missing = [];
let total = 0;
for (const name of expected) {
  const report = join(testResults, `TEST-${name}.xml`);
  if (!existsSync(report)) {
    missing.push(name);
    continue;
  }
  const suite = /<testsuite\b[^>]*>/.exec(readFileSync(report, 'utf8'))?.[0];
  const count = (attr) =>
    Number(new RegExp(`\\b${attr}="(\\d+)"`).exec(suite ?? '')?.[1] ?? NaN);
  const tests = count('tests');
  if (!(tests > 0) || count('failures') !== 0 || count('errors') !== 0)
    fail(`${name} report is not a clean run: ${suite ?? 'no <testsuite>'}`);
  total += tests - (count('skipped') || 0);
}
if (missing.length > 0) fail(`no JUnit report for ${missing.join(', ')}`);
console.log(
  `agent-activity Kotlin unit tests: ${total} tests passed across ${expected.length} classes`,
);

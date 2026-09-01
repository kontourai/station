#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const DEFAULT_RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
const DEFAULT_DEVICE = 'iPhone 17 Pro';
const DEFAULT_BUNDLE_ID = 'io.kontourai.station';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    stdio: options.inherit ? 'inherit' : 'pipe',
    windowsHide: true,
  });
  if (result.error && !options.allowFailure) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${String(result.status)}):\n${String(result.stderr ?? result.stdout ?? '').slice(-6_000)}`,
    );
  }
  return result;
}

export function selectIosSimulator(catalog, options) {
  const runtimeIdentifier = options.runtimeIdentifier;
  const deviceName = options.deviceName;
  const devices = catalog?.devices?.[runtimeIdentifier];
  if (!Array.isArray(devices)) {
    throw new Error(
      `No available iOS simulator matches ${runtimeIdentifier} / ${deviceName}.`,
    );
  }
  const device = devices.find(
    (candidate) =>
      candidate &&
      candidate.name === deviceName &&
      candidate.isAvailable === true &&
      typeof candidate.udid === 'string',
  );
  if (!device) {
    throw new Error(
      `No available iOS simulator matches ${runtimeIdentifier} / ${deviceName}.`,
    );
  }
  return { ...device, runtimeIdentifier };
}

function valueAfter(argv, name) {
  const prefix = `${name}=`;
  const inline = argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

export function parseIosSmokeOptions(argv) {
  if (argv.includes('--help')) {
    return { help: true };
  }
  const app = valueAfter(argv, '--app');
  if (!app || !isAbsolute(app) || !app.endsWith('.app')) {
    throw new Error(
      '--app must be an absolute path to a simulator .app bundle.',
    );
  }
  const artifacts =
    valueAfter(argv, '--artifacts') ??
    join(root, '.kontourai', 'ios-simulator-runtime-smoke');
  if (!isAbsolute(artifacts)) {
    throw new Error('--artifacts must be an absolute path.');
  }
  const allowedArtifacts = join(root, '.kontourai');
  const artifactRelative = relative(allowedArtifacts, artifacts);
  if (artifactRelative.startsWith('..') || isAbsolute(artifactRelative)) {
    throw new Error(
      "--artifacts must stay beneath this checkout's .kontourai directory.",
    );
  }
  const bundleId = valueAfter(argv, '--bundle-id') ?? DEFAULT_BUNDLE_ID;
  if (bundleId !== DEFAULT_BUNDLE_ID) {
    throw new Error(`--bundle-id must be ${DEFAULT_BUNDLE_ID}.`);
  }
  return {
    help: false,
    app,
    artifacts,
    bundleId,
    deviceName: valueAfter(argv, '--device') ?? DEFAULT_DEVICE,
    runtimeIdentifier: valueAfter(argv, '--runtime') ?? DEFAULT_RUNTIME,
    sourceSha: valueAfter(argv, '--source-sha'),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Classify one xcodebuild attempt's log. Only the exact XCUITest
// infrastructure timeout that fires before the test body runs (the hosted
// simulator taking longer than XCTest's fixed launch deadline to bring the
// app up) is retryable, and only when it is the sole recorded failure. Any
// other recorded test failure — an assertion, a later launch of the manager,
// a loading/zoom regression — keeps the attempt terminal, as does an attempt
// that recorded no test failure at all (a build or simulator error).
export function classifyXcuiTestFailure(log, options = {}) {
  const bundleId = options.bundleId ?? DEFAULT_BUNDLE_ID;
  const recorded = [...String(log).matchAll(/^.*\.swift:\d+: error: .*$/gm)].map(
    (match) => match[0],
  );
  if (recorded.length === 0) {
    return { signature: 'no-recorded-test-failure', retryable: false };
  }
  const launchTimeout = new RegExp(
    `: Failed to launch ${escapeRegExp(bundleId)}: Timed out attempting to launch app\\.`,
  );
  if (recorded.every((line) => launchTimeout.test(line))) {
    return { signature: 'app-launch-timeout', retryable: true };
  }
  return { signature: 'test-failure', retryable: false };
}

// Runs attempts until one passes, retrying at most once and only when the
// classifier says the previous attempt never reached the test body. Every
// attempt is retained in the returned list so the receipt shows the retry
// rather than hiding it.
export async function runAttemptsWithLaunchRetry({
  attempt,
  classify = classifyXcuiTestFailure,
  maxAttempts = 2,
}) {
  const attempts = [];
  for (let index = 1; index <= maxAttempts; index += 1) {
    const { status, log, ...rest } = await attempt(index);
    const classification =
      status === 0 ? { signature: 'passed', retryable: false } : classify(log);
    attempts.push({ index, status, ...rest, ...classification });
    if (status === 0) return { passed: true, attempts };
    if (!classification.retryable) return { passed: false, attempts };
  }
  return { passed: false, attempts };
}

function printHelp() {
  console.log(`usage: node scripts/ios-simulator-runtime-smoke.mjs \\
  --app /absolute/path/Station.app \\
  [--artifacts /absolute/path] [--bundle-id ${DEFAULT_BUNDLE_ID}] \\
  [--runtime ${DEFAULT_RUNTIME}] [--device "${DEFAULT_DEVICE}"]`);
}

function writeArtifact(path, value) {
  writeFileSync(
    path,
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
}

function captureDiagnostics({ artifacts, bundleId, udid }) {
  run(
    'xcrun',
    [
      'simctl',
      'io',
      udid,
      'screenshot',
      '--type=png',
      join(artifacts, 'simulator-after-test.png'),
    ],
    {
      allowFailure: true,
    },
  );
  const logs = run(
    'xcrun',
    [
      'simctl',
      'spawn',
      udid,
      'log',
      'show',
      '--style',
      'compact',
      '--last',
      '5m',
      '--predicate',
      'process == "Station" OR eventMessage CONTAINS[c] "io.kontourai.station"',
    ],
    { allowFailure: true },
  );
  writeArtifact(
    join(artifacts, 'station-ios.log'),
    `${logs.stdout ?? ''}${logs.stderr ?? ''}`,
  );
  const processes = run('xcrun', ['simctl', 'spawn', udid, 'ps', '-ax'], {
    allowFailure: true,
  });
  writeArtifact(
    join(artifacts, 'simulator-processes.txt'),
    `${processes.stdout ?? ''}${processes.stderr ?? ''}`,
  );
  run('xcrun', ['simctl', 'terminate', udid, bundleId], { allowFailure: true });
}

async function main(argv = process.argv.slice(2)) {
  const options = parseIosSmokeOptions(argv);
  if (options.help) {
    printHelp();
    return;
  }
  if (process.platform !== 'darwin') {
    throw new Error('The iOS simulator runtime smoke requires macOS.');
  }
  if (!existsSync(options.app)) {
    throw new Error(`Simulator app does not exist: ${options.app}`);
  }
  const app = realpathSync(options.app);
  const packagedBundleId = run('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleIdentifier',
    join(app, 'Info.plist'),
  ]).stdout.trim();
  if (packagedBundleId !== options.bundleId) {
    throw new Error(
      `Simulator app bundle id is ${packagedBundleId || 'missing'}, expected ${options.bundleId}.`,
    );
  }
  const runId = `run-${Date.now()}-${process.pid}`;
  const artifacts = join(options.artifacts, runId);
  mkdirSync(artifacts, { recursive: true, mode: 0o700 });

  const catalogResult = run('xcrun', [
    'simctl',
    'list',
    'devices',
    'available',
    '--json',
  ]);
  const device = selectIosSimulator(JSON.parse(catalogResult.stdout), options);
  const wasBooted = device.state === 'Booted';
  const context = {
    schemaVersion: 1,
    sourceSha: options.sourceSha ?? null,
    app,
    bundleId: options.bundleId,
    runtimeIdentifier: options.runtimeIdentifier,
    deviceName: options.deviceName,
    udid: device.udid,
    startedAt: new Date().toISOString(),
  };
  writeArtifact(join(artifacts, 'context.json'), context);

  let passed = false;
  let failure;
  let attempts = [];
  const startedAt = Date.now();
  const bootAndInstall = () => {
    run('xcrun', ['simctl', 'bootstatus', device.udid, '-b']);
    run('xcrun', ['simctl', 'uninstall', device.udid, options.bundleId], {
      allowFailure: true,
    });
    run('xcrun', ['simctl', 'install', device.udid, app]);
  };
  try {
    if (!wasBooted) run('xcrun', ['simctl', 'boot', device.udid]);
    bootAndInstall();

    const xcodeDirectory = join(artifacts, 'xcode');
    mkdirSync(xcodeDirectory, { recursive: true, mode: 0o700 });
    run(
      'xcodegen',
      [
        'generate',
        '--spec',
        join(root, 'tests', 'ios-runtime-smoke', 'project.yml'),
        '--project-root',
        root,
        '--project',
        xcodeDirectory,
      ],
      {
        env: { ...process.env, STATION_IOS_SMOKE_ROOT: root },
      },
    );
    const outcome = await runAttemptsWithLaunchRetry({
      attempt: (index) => {
        const attemptDirectory = join(artifacts, `attempt-${String(index)}`);
        mkdirSync(attemptDirectory, { recursive: true, mode: 0o700 });
        if (index > 1) {
          // A launch timeout leaves the simulator in whatever state the slow
          // launch reached. Retry from a fresh boot of the same exact device
          // and a fresh install of the same exact app, never a substitute.
          run('xcrun', ['simctl', 'shutdown', device.udid], {
            allowFailure: true,
          });
          run('xcrun', ['simctl', 'boot', device.udid]);
          bootAndInstall();
        }
        const attemptStartedAt = new Date().toISOString();
        const resultBundle = join(attemptDirectory, 'StationRuntimeSmoke.xcresult');
        const test = run(
          'xcodebuild',
          [
            'test',
            '-project',
            join(xcodeDirectory, 'StationRuntimeSmoke.xcodeproj'),
            '-scheme',
            'StationRuntimeSmoke',
            '-destination',
            `platform=iOS Simulator,id=${device.udid}`,
            '-resultBundlePath',
            resultBundle,
          ],
          { allowFailure: true },
        );
        const log = `${test.stdout ?? ''}${test.stderr ?? ''}`;
        writeArtifact(join(attemptDirectory, 'xcodebuild.log'), log);
        if (existsSync(resultBundle)) {
          const summary = run(
            'xcrun',
            [
              'xcresulttool',
              'get',
              'test-results',
              'summary',
              '--path',
              resultBundle,
            ],
            { allowFailure: true },
          );
          writeArtifact(
            join(attemptDirectory, 'xcresult-summary.json'),
            summary.stdout || summary.stderr || '{}\n',
          );
          const attachmentDirectory = join(
            attemptDirectory,
            'xcresult-attachments',
          );
          mkdirSync(attachmentDirectory, { recursive: true, mode: 0o700 });
          run(
            'xcrun',
            [
              'xcresulttool',
              'export',
              'attachments',
              '--path',
              resultBundle,
              '--output-path',
              attachmentDirectory,
            ],
            { allowFailure: true },
          );
        }
        if (test.status !== 0) {
          // Capture this attempt's simulator evidence before any retry resets
          // the device; the run-level capture below only sees the last state.
          captureDiagnostics({
            artifacts: attemptDirectory,
            bundleId: options.bundleId,
            udid: device.udid,
          });
        }
        return {
          status: test.status,
          log,
          artifacts: attemptDirectory,
          startedAt: attemptStartedAt,
          finishedAt: new Date().toISOString(),
        };
      },
    });
    attempts = outcome.attempts;
    if (!outcome.passed) {
      const last = attempts[attempts.length - 1];
      const lastLog = readFileSync(join(last.artifacts, 'xcodebuild.log'), 'utf8');
      throw new Error(
        `iOS runtime XCUITest failed (${String(last.status)}, ${last.signature}, attempt ${String(last.index)} of ${String(attempts.length)}):\n${lastLog.slice(-8_000)}`,
      );
    }
    passed = true;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    captureDiagnostics({
      artifacts,
      bundleId: options.bundleId,
      udid: device.udid,
    });
    if (!wasBooted) {
      run('xcrun', ['simctl', 'shutdown', device.udid], { allowFailure: true });
    }
  }

  const receipt = {
    ...context,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    passed,
    failure: failure ?? null,
    artifacts,
    attempts,
    retried: attempts.length > 1,
  };
  writeArtifact(join(artifacts, 'receipt.json'), receipt);
  mkdirSync(options.artifacts, { recursive: true, mode: 0o700 });
  writeArtifact(join(options.artifacts, 'latest-receipt.json'), receipt);
  if (!passed) throw new Error(failure ?? 'iOS runtime smoke failed.');
  console.log(JSON.stringify(receipt, null, 2));
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(
      `ios-simulator-runtime-smoke: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}

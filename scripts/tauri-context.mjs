#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, platform as hostPlatform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUIDES_URL = 'https://v2.tauri.app/_llms-txt/guides.txt';
const REFERENCE_URL = 'https://v2.tauri.app/_llms-txt/reference.txt';
const DOC_TOPICS = {
  capabilities: { source: GUIDES_URL, heading: 'Capabilities' },
  configuration: { source: GUIDES_URL, heading: 'Configuration Files' },
  debug: { source: GUIDES_URL, heading: 'Debug' },
  develop: { source: GUIDES_URL, heading: 'Develop' },
  devtools: { source: GUIDES_URL, heading: 'CrabNebula DevTools' },
  distribute: { source: GUIDES_URL, heading: 'Distribute' },
  ipc: { source: GUIDES_URL, heading: 'Calling Rust from the Frontend' },
  security: { source: GUIDES_URL, heading: 'Security' },
  tests: { source: GUIDES_URL, heading: 'Tests' },
  webdriver: { source: GUIDES_URL, heading: 'WebDriver' },
  cli: { source: REFERENCE_URL, heading: 'Command Line Interface' },
  permissions: { source: REFERENCE_URL, heading: 'Core Permissions' },
  'config-reference': { source: REFERENCE_URL, heading: 'Configuration' },
};

const PLATFORM_CONFIGS = {
  macos: ['tauri.macos.conf.json'],
  windows: ['tauri.windows.conf.json'],
  linux: ['tauri.linux.conf.json'],
  android: ['tauri.android.conf.json'],
  ios: ['tauri.ios.conf.json'],
};

const PLATFORM_CAPABILITY_NAMES = {
  macos: 'macOS',
  windows: 'windows',
  linux: 'linux',
  android: 'android',
  ios: 'iOS',
};

const REQUIRED_ANDROID_TARGETS = [
  'aarch64-linux-android',
  'armv7-linux-androideabi',
  'i686-linux-android',
  'x86_64-linux-android',
];
const REQUIRED_IOS_TARGETS = ['aarch64-apple-ios', 'aarch64-apple-ios-sim'];

export const TAURI_CONTEXT_USAGE = `Usage: node scripts/tauri-context.mjs [options]

Context report:
  --platform <all|macos|windows|linux|android|ios>
  --json | --format <human|json>
  --root <path>
  --strict

Official Tauri documentation:
  --list-topics
  --topic <name> [--max-chars <count>]

General:
  --help
`;

export function mergeJsonPatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return structuredClone(patch);
  }
  const output =
    target && typeof target === 'object' && !Array.isArray(target)
      ? structuredClone(target)
      : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete output[key];
    else output[key] = mergeJsonPatch(output[key], value);
  }
  return output;
}

export function cargoDependencyVersion(cargoToml, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const row = cargoToml.match(
    new RegExp(`^${escaped}\\s*=\\s*(.+)$`, 'm'),
  )?.[1];
  if (!row) return undefined;
  return (
    row.match(/version\s*=\s*["']([^"']+)["']/)?.[1] ??
    row.match(/^["']([^"']+)["']/)?.[1]
  );
}

export function exactSemver(value) {
  return value?.match(/^(?:=)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/)?.[1];
}

export function extractDocumentationSection(
  content,
  heading,
  maxChars = 60_000,
) {
  const marker = `# ${heading}`;
  const start = content.indexOf(marker);
  if (start < 0) throw new Error(`Documentation heading not found: ${heading}`);
  const next = content.indexOf('\n# ', start + marker.length);
  const section = content.slice(start, next < 0 ? content.length : next).trim();
  if (section.length <= maxChars) return { content: section, truncated: false };
  return {
    content: `${section.slice(0, maxChars).trimEnd()}\n\n[TRUNCATED at ${maxChars} characters]`,
    truncated: true,
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function checkCommand(id, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeout ?? 10_000,
    windowsHide: true,
  });
  if (result.error?.code === 'ENOENT') {
    return { id, status: 'skipped', reason: 'command-not-found', command };
  }
  if (result.error) {
    return { id, status: 'failed', reason: result.error.message, command };
  }
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (result.status !== 0 && !options.acceptNonzero) {
    return {
      id,
      status: 'failed',
      reason: combined.slice(0, 1_000) || `exit-${result.status}`,
      command,
    };
  }
  return {
    id,
    status: 'checked',
    command,
    value: options.parse
      ? options.parse(combined, result)
      : combined.split('\n')[0],
  };
}

function firstExisting(paths) {
  return paths.find((path) => path && existsSync(path));
}

function parseAdbDevices(output) {
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...details] = line.split(/\s+/);
      return { serial, state, details: details.join(' ') };
    });
}

function parseAppleDevices(output) {
  const rows = JSON.parse(output);
  return rows.map((device) => ({
    name: device.name,
    platform: device.platform,
    simulator: Boolean(device.simulator),
    available: Boolean(device.available),
    operatingSystemVersion: device.operatingSystemVersion,
  }));
}

function platformConfigs(desktopRoot, selected) {
  const basePath = join(desktopRoot, 'tauri.conf.json');
  const base = readJson(basePath);
  const names = selected === 'all' ? Object.keys(PLATFORM_CONFIGS) : [selected];
  return Object.fromEntries(
    names.map((name) => {
      const overlays = PLATFORM_CONFIGS[name].map((file) => ({
        file,
        value: readJson(join(desktopRoot, file)),
      }));
      const resolvedConfig = overlays.reduce(
        (current, overlay) => mergeJsonPatch(current, overlay.value),
        base,
      );
      return [
        name,
        {
          files: [basename(basePath), ...overlays.map(({ file }) => file)],
          productName: resolvedConfig.productName,
          version: resolvedConfig.version,
          identifier: resolvedConfig.identifier,
          bundle: resolvedConfig.bundle,
          plugins: resolvedConfig.plugins,
        },
      ];
    }),
  );
}

function capabilityReport(desktopRoot, selected) {
  const directory = join(desktopRoot, 'capabilities');
  const selectedName =
    selected === 'all' ? undefined : PLATFORM_CAPABILITY_NAMES[selected];
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const value = readJson(join(directory, file));
      const platforms = value.platforms ?? ['all'];
      return {
        file,
        identifier: value.identifier,
        platforms,
        applies:
          !selectedName ||
          platforms.includes('all') ||
          platforms.includes(selectedName),
        windows: value.windows ?? [],
        webviews: value.webviews ?? [],
        remote: value.remote ?? null,
        permissions: value.permissions ?? [],
      };
    });
}

function gitGeneratedState(root, relativePath) {
  const check = checkCommand(
    `git-${relativePath}`,
    'git',
    ['status', '--short', '--', relativePath],
    { cwd: root, parse: (output) => output },
  );
  return {
    path: relativePath,
    exists: existsSync(join(root, relativePath)),
    status: check.status,
    dirtyPaths:
      check.status === 'checked' && check.value
        ? String(check.value)
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
        : [],
    reason: check.reason,
  };
}

function collectChecks(root) {
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const tauriBin = join(
    root,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tauri.cmd' : 'tauri',
  );
  const androidRoot = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME;
  const adb = firstExisting([
    androidRoot &&
      join(
        androidRoot,
        'platform-tools',
        process.platform === 'win32' ? 'adb.exe' : 'adb',
      ),
    join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
    process.platform === 'win32' &&
      join(
        homedir(),
        'AppData',
        'Local',
        'Android',
        'Sdk',
        'platform-tools',
        'adb.exe',
      ),
    'adb',
  ]);
  const checks = {
    node: checkCommand('node', process.execPath, ['--version']),
    npm: checkCommand('npm', npmBin, ['--version']),
    rustc: checkCommand('rustc', 'rustc', ['--version']),
    cargo: checkCommand('cargo', 'cargo', ['--version']),
    rustTargets: checkCommand(
      'rust-targets',
      'rustup',
      ['target', 'list', '--installed'],
      {
        parse: (output) => output.split('\n').filter(Boolean).sort(),
      },
    ),
    tauriCli: checkCommand('tauri-cli', tauriBin, ['--version']),
    java: checkCommand('java', 'java', ['-version']),
    adb: checkCommand('adb', adb ?? 'adb', ['devices', '-l'], {
      parse: parseAdbDevices,
    }),
  };
  if (hostPlatform() === 'darwin') {
    checks.xcode = checkCommand('xcode', 'xcodebuild', ['-version'], {
      parse: (output) => output.split('\n').filter(Boolean),
    });
    checks.appleDevices = checkCommand(
      'apple-devices',
      'xcrun',
      ['xcdevice', 'list', '--timeout', '2'],
      { timeout: 15_000, parse: parseAppleDevices },
    );
  } else {
    checks.xcode = {
      id: 'xcode',
      status: 'skipped',
      reason: 'host-is-not-macos',
    };
    checks.appleDevices = {
      id: 'apple-devices',
      status: 'skipped',
      reason: 'host-is-not-macos',
    };
  }
  return checks;
}

function normalizedVersion(value) {
  return String(value ?? '').match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
}

function releaseLine(value) {
  return normalizedVersion(value)?.split('.').slice(0, 2).join('.');
}

export function collectFindings({ versions, checks, generated }) {
  const findings = [];
  const rustTauri = exactSemver(versions.rust.tauri);
  const cliTauri = normalizedVersion(checks.tauriCli.value);
  if (
    rustTauri &&
    cliTauri &&
    releaseLine(rustTauri) !== releaseLine(cliTauri)
  ) {
    findings.push({
      severity: 'warning',
      code: 'tauri-cli-core-release-line-skew',
      message: `Installed Tauri CLI ${cliTauri} and Rust Tauri ${rustTauri} are on different major/minor release lines.`,
    });
  }
  const installedTargets =
    checks.rustTargets.status === 'checked' ? checks.rustTargets.value : [];
  for (const [platform, required] of [
    ['android', REQUIRED_ANDROID_TARGETS],
    ['ios', REQUIRED_IOS_TARGETS],
  ]) {
    const missing = required.filter(
      (target) => !installedTargets.includes(target),
    );
    if (missing.length > 0) {
      findings.push({
        severity: 'warning',
        code: `${platform}-rust-targets-missing`,
        message: `Missing ${platform} Rust targets: ${missing.join(', ')}.`,
      });
    }
  }
  const androidDevices =
    checks.adb.status === 'checked' ? checks.adb.value : [];
  if (androidDevices.some((device) => device.state !== 'device')) {
    findings.push({
      severity: 'warning',
      code: 'android-device-not-ready',
      message: 'At least one discovered Android transport is not ready.',
    });
  }
  for (const state of Object.values(generated)) {
    if (state.dirtyPaths.length > 0) {
      findings.push({
        severity: 'warning',
        code: 'generated-native-tree-dirty',
        message: `${state.path} has uncommitted generated changes.`,
      });
    }
  }
  for (const check of Object.values(checks)) {
    if (check.status === 'failed') {
      findings.push({
        severity: 'error',
        code: `check-failed-${check.id}`,
        message: `${check.id} failed: ${check.reason}`,
      });
    }
  }
  return findings;
}

export function buildContextReport(root, selectedPlatform = 'all') {
  const cargoPath = join(root, 'src-desktop', 'Cargo.toml');
  const desktopRoot = dirname(cargoPath);
  const cargoToml = readFileSync(cargoPath, 'utf8');
  const packageJson = readJson(join(root, 'package.json'));
  const packageLock = readJson(join(root, 'package-lock.json'));
  const npmPackages = packageLock.packages ?? {};
  const rustNames = [
    'tauri',
    'tauri-build',
    ...[...cargoToml.matchAll(/^(tauri-plugin-[a-z0-9-]+)\s*=/gm)].map(
      (match) => match[1],
    ),
  ];
  const rustVersions = Object.fromEntries(
    [...new Set(rustNames)].map((name) => [
      name,
      cargoDependencyVersion(cargoToml, name),
    ]),
  );
  const npmNames = [
    '@tauri-apps/cli',
    '@tauri-apps/api',
    ...Object.keys({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    }).filter((name) => name.startsWith('@tauri-apps/plugin-')),
  ];
  const npmVersions = Object.fromEntries(
    npmNames.sort().map((name) => [
      name,
      {
        requested:
          packageJson.dependencies?.[name] ??
          packageJson.devDependencies?.[name],
        installed: npmPackages[`node_modules/${name}`]?.version,
      },
    ]),
  );
  const checks = collectChecks(root);
  const generated = {
    android: {
      ...gitGeneratedState(root, 'src-desktop/gen/android'),
      owners: [
        'src-desktop/tauri.android.conf.json',
        'scripts/apply-android-native-bootstrap.mjs',
        'scripts/apply-android-channel-icons.mjs',
      ].filter((path) => existsSync(join(root, path))),
    },
    ios: {
      ...gitGeneratedState(root, 'src-desktop/gen/apple'),
      owners: [
        'src-desktop/tauri.ios.conf.json',
        'src-desktop/gen/apple/project.yml',
        'scripts/ios-store-signing-config.mjs',
        'scripts/generate-app-icons.mjs',
      ].filter((path) => existsSync(join(root, path))),
    },
  };
  const versions = { rust: rustVersions, npm: npmVersions };
  const findings = collectFindings({ versions, checks, generated });
  const appleDevices =
    checks.appleDevices.status === 'checked' ? checks.appleDevices.value : [];
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root,
    host: { platform: hostPlatform(), architecture: process.arch },
    selectedPlatform,
    versions,
    configurations: platformConfigs(desktopRoot, selectedPlatform),
    capabilities: capabilityReport(desktopRoot, selectedPlatform),
    generated,
    checks,
    devices: {
      android:
        checks.adb.status === 'checked'
          ? checks.adb.value
          : { status: checks.adb.status, reason: checks.adb.reason },
      apple: {
        physical: appleDevices.filter(
          (device) =>
            !device.simulator &&
            device.platform !== 'com.apple.platform.macosx',
        ),
        simulators: appleDevices.filter(
          (device) => device.simulator && device.available,
        ),
      },
    },
    evidenceClasses: [
      'unit-or-mock',
      'browser-viewport',
      'desktop-tauri-shell',
      'simulator-or-emulator',
      'physical-device',
      'signed-installed-artifact',
      'store-provider-receipt',
    ],
    findings,
    summary: {
      checked: Object.values(checks).filter(
        (check) => check.status === 'checked',
      ).length,
      skipped: Object.values(checks).filter(
        (check) => check.status === 'skipped',
      ).length,
      failed: Object.values(checks).filter((check) => check.status === 'failed')
        .length,
      warnings: findings.filter((finding) => finding.severity === 'warning')
        .length,
      errors: findings.filter((finding) => finding.severity === 'error').length,
    },
  };
}

function humanReport(report) {
  const lines = [
    `Tauri context: ${report.root}`,
    `host=${report.host.platform}/${report.host.architecture} platform=${report.selectedPlatform}`,
    `checks: ${report.summary.checked} checked, ${report.summary.skipped} skipped, ${report.summary.failed} failed`,
    `findings: ${report.summary.warnings} warning(s), ${report.summary.errors} error(s)`,
    '',
    `Rust Tauri: ${report.versions.rust.tauri ?? 'unknown'}`,
    `Tauri CLI: ${report.checks.tauriCli.value ?? report.checks.tauriCli.reason}`,
    `Rust targets: ${Array.isArray(report.checks.rustTargets.value) ? report.checks.rustTargets.value.join(', ') : report.checks.rustTargets.reason}`,
    `Android devices: ${Array.isArray(report.devices.android) ? report.devices.android.map((device) => `${device.serial}:${device.state}`).join(', ') || 'none' : report.devices.android.reason}`,
    `Apple physical devices: ${report.devices.apple.physical.map((device) => device.name).join(', ') || 'none'}`,
    `Apple simulators: ${report.devices.apple.simulators.length}`,
  ];
  if (report.findings.length > 0) {
    lines.push(
      '',
      ...report.findings.map(
        (finding) =>
          `${finding.severity.toUpperCase()} ${finding.code}: ${finding.message}`,
      ),
    );
  }
  lines.push(
    '',
    'Evidence classes are separate; a lower class never implies a higher one ran.',
  );
  return lines.join('\n');
}

export function parseArgs(argv) {
  const options = {
    format: 'human',
    maxChars: 60_000,
    platform: 'all',
    root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    strict: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--format') options.format = argv[++index];
    else if (value === '--json') options.format = 'json';
    else if (value === '--platform')
      options.platform = argv[++index]?.toLowerCase();
    else if (value === '--root') options.root = resolve(argv[++index]);
    else if (value === '--topic') options.topic = argv[++index];
    else if (value === '--max-chars') options.maxChars = Number(argv[++index]);
    else if (value === '--strict') options.strict = true;
    else if (value === '--list-topics') options.listTopics = true;
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!['all', ...Object.keys(PLATFORM_CONFIGS)].includes(options.platform)) {
    throw new Error(`Unsupported platform: ${options.platform}`);
  }
  return options;
}

async function printDocumentation(topicName, maxChars) {
  const topic = DOC_TOPICS[topicName];
  if (!topic) throw new Error(`Unknown documentation topic: ${topicName}`);
  const response = await fetch(topic.source, {
    headers: { 'user-agent': 'Station-Tauri-Context/1' },
  });
  if (!response.ok) {
    throw new Error(`Documentation fetch failed: HTTP ${response.status}`);
  }
  const source = await response.text();
  const section = extractDocumentationSection(source, topic.heading, maxChars);
  const digest = createHash('sha256').update(source).digest('hex');
  process.stdout.write(
    `${section.content}\n\nSource: ${topic.source}\nSource-SHA256: ${digest}\n${section.truncated ? 'Result: truncated\n' : ''}`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(TAURI_CONTEXT_USAGE);
    return;
  }
  if (options.listTopics) {
    process.stdout.write(`${Object.keys(DOC_TOPICS).sort().join('\n')}\n`);
    return;
  }
  if (options.topic) {
    await printDocumentation(options.topic, options.maxChars);
    return;
  }
  const report = buildContextReport(options.root, options.platform);
  process.stdout.write(
    options.format === 'json'
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${humanReport(report)}\n`,
  );
  if (options.strict && report.summary.errors > 0) process.exitCode = 2;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(
      `tauri-context: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}

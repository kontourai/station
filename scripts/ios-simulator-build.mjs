import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const ENTITLEMENTS = 'station_iOS/StationSimulator.entitlements';
const FLAGS = [
  '-Xlinker',
  '-sectcreate',
  '-Xlinker',
  '__TEXT',
  '-Xlinker',
  '__entitlements',
  '-Xlinker',
  `"$(PROJECT_DIR)/${ENTITLEMENTS}"`,
];
const runCommand = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    ...options,
  });
const readConfig = (root) =>
  JSON.parse(
    readFileSync(join(root, 'src-desktop/tauri.ios.dev.conf.json'), 'utf8'),
  );

export function simulatorEntitlements(identifier) {
  if (
    typeof identifier !== 'string' ||
    !/^io\.kontourai\.station\.dev\.[a-z0-9.-]+$/.test(identifier)
  )
    throw new Error(
      'Simulator preparation requires an explicit Station development identity.',
    );
  return {
    'application-identifier': identifier,
    'keychain-access-groups': [identifier],
  };
}

export function prepareIosSimulator({ root = ROOT, run = runCommand } = {}) {
  const config = readConfig(root);
  const entitlements = simulatorEntitlements(config.identifier);
  const apple = join(root, 'src-desktop/gen/apple');
  const path = join(apple, 'project.yml');
  const project = YAML.parse(readFileSync(path, 'utf8'));
  const target = project.targets?.station_iOS;
  if (
    target?.type !== 'application' ||
    target.platform !== 'iOS' ||
    !target.settings?.base
  )
    throw new Error('Expected the generated Station iOS application target.');
  const key = 'OTHER_LDFLAGS[sdk=iphonesimulator*]';
  const flags = target.settings.base[key] ?? ['$(inherited)'];
  if (
    !Array.isArray(flags) ||
    !flags.every((value) => typeof value === 'string')
  )
    throw new Error(
      'Unsupported simulator linker settings; preserve and review the existing flags.',
    );
  const prepared =
    JSON.stringify(flags.slice(-FLAGS.length)) === JSON.stringify(FLAGS);
  if (!prepared && flags.includes('__entitlements'))
    throw new Error(
      'An unrelated simulator entitlement section is already configured.',
    );
  target.settings.base[key] = prepared ? flags : [...flags, ...FLAGS];
  // iOS rights belong in this simulator-only Mach-O section. Putting them in
  // the macOS code signature can prevent the simulator process from launching.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>application-identifier</key><string>${entitlements['application-identifier']}</string><key>keychain-access-groups</key><array><string>${config.identifier}</string></array></dict></plist>\n`;
  writeFileSync(join(apple, ENTITLEMENTS), xml, { mode: 0o600 });
  writeFileSync(path, YAML.stringify(project));
  run('xcodegen', ['generate', '--spec', path, '--project', apple]);
}

export function readSimulatorEntitlementSection(executable, loadCommands) {
  const sections = [
    ...loadCommands.matchAll(
      /sectname __entitlements\s+segname __TEXT\s+addr 0x[0-9a-f]+\s+size 0x([0-9a-f]+)\s+offset (\d+)/gi,
    ),
  ];
  if (sections.length !== 1)
    throw new Error('Expected exactly one simulator entitlement section.');
  const size = Number.parseInt(sections[0][1], 16);
  const offset = Number(sections[0][2]);
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 65536 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new Error('Invalid simulator entitlement section bounds.');
  const fd = openSync(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || offset + size > stat.size)
      throw new Error(
        'Simulator entitlement section is outside the executable.',
      );
    const bytes = Buffer.alloc(size);
    if (readSync(fd, bytes, 0, size, offset) !== size)
      throw new Error('Incomplete simulator entitlement section.');
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function verifyIosSimulator(
  archive,
  { root = ROOT, run = runCommand } = {},
) {
  const config = readConfig(root);
  const expected = simulatorEntitlements(config.identifier);
  // Archive metadata contains a Date, so extract the JSON-compatible record.
  const archived = JSON.parse(
    run('plutil', [
      '-extract',
      'ApplicationProperties',
      'json',
      '-o',
      '-',
      join(archive, 'Info.plist'),
    ]),
  );
  const relativeApp = archived.ApplicationPath;
  if (
    typeof relativeApp !== 'string' ||
    !/^Applications\/[^/\\]+\.app$/.test(relativeApp)
  )
    throw new Error('Invalid simulator archive application path.');
  const app = join(archive, 'Products', relativeApp);
  const info = JSON.parse(
    run('plutil', ['-convert', 'json', '-o', '-', join(app, 'Info.plist')]),
  );
  if (
    info.CFBundleIdentifier !== config.identifier ||
    archived.CFBundleIdentifier !== config.identifier
  )
    throw new Error(
      'Simulator archive does not match its development identity.',
    );
  const executableName = info.CFBundleExecutable;
  if (
    typeof executableName !== 'string' ||
    !executableName ||
    basename(executableName) !== executableName ||
    executableName.includes('\\')
  )
    throw new Error('Invalid simulator executable.');
  const executable = join(app, executableName);
  const platforms = [
    ...run('xcrun', ['vtool', '-show-build', executable]).matchAll(
      /\bplatform\s+(\w+)/g,
    ),
  ].map((match) => match[1]);
  if (
    JSON.stringify(info.CFBundleSupportedPlatforms) !== '["iPhoneSimulator"]' ||
    !platforms.length ||
    platforms.some((platform) => platform !== 'IOSSIMULATOR')
  )
    throw new Error('Refusing to prepare a non-simulator application.');
  if (
    JSON.stringify(
      info.CFBundleURLTypes?.flatMap((item) => item.CFBundleURLSchemes),
    ) !==
    JSON.stringify(
      config.plugins['deep-link'].mobile.flatMap((item) => item.scheme),
    )
  )
    throw new Error(
      'Simulator pairing association does not match its development identity.',
    );
  const bytes = readSimulatorEntitlementSection(
    executable,
    run('xcrun', ['otool', '-l', executable]),
  );
  const temporary = mkdtempSync(
    join(tmpdir(), 'station-simulator-verification-'),
  );
  try {
    const path = join(temporary, 'entitlements.plist');
    writeFileSync(path, bytes, { mode: 0o600 });
    const actual = JSON.parse(
      run('plutil', ['-convert', 'json', '-o', '-', path]),
    );
    if (
      Object.keys(actual).length !== 2 ||
      actual['application-identifier'] !== expected['application-identifier'] ||
      JSON.stringify(actual['keychain-access-groups']) !==
        JSON.stringify(expected['keychain-access-groups'])
    )
      throw new Error(
        'The built simulator app is missing its private keychain identity.',
      );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  // Seal resources with an ordinary local signature, without iOS rights in
  // that macOS signature. The simulator reads those rights from __TEXT above.
  run('codesign', [
    '--force',
    '--sign',
    '-',
    '--identifier',
    config.identifier,
    app,
  ]);
  run('codesign', ['--verify', '--strict', app]);
  return app;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.platform !== 'darwin')
    throw new Error('iOS simulator builds require macOS and Xcode.');
  if (process.argv[2] === 'prepare') prepareIosSimulator();
  else if (process.argv[2] === 'verify')
    console.log(
      `Verified simulator app: ${verifyIosSimulator(join(ROOT, 'src-desktop/gen/apple/build/station_iOS.xcarchive'))}`,
    );
  else
    throw new Error(
      'Usage: node scripts/ios-simulator-build.mjs prepare|verify',
    );
}

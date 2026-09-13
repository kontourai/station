import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');

export function simulatorSigningEntitlements(info, nativeBuild) {
  const id = info?.CFBundleIdentifier;
  const platforms = [...nativeBuild.matchAll(/\bplatform\s+(\w+)/g)].map(
    (match) => match[1],
  );
  if (
    typeof id !== 'string' ||
    !/^io\.kontourai\.station\.dev\.[a-z0-9.-]+$/.test(id)
  )
    throw new Error(
      'Simulator signing requires an explicit Station development identity.',
    );
  if (
    JSON.stringify(info.CFBundleSupportedPlatforms) !== '["iPhoneSimulator"]' ||
    !platforms.length ||
    platforms.some((platform) => platform !== 'IOSSIMULATOR')
  )
    throw new Error('Refusing to ad-hoc sign a non-simulator application.');
  return {
    'application-identifier': id,
    'keychain-access-groups': [id],
    'get-task-allow': true,
  };
}

export function signIosSimulator(
  archive,
  run = (command, args) =>
    execFileSync(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }),
) {
  const readPlist = (path) =>
    JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', path]));
  const archived = readPlist(join(archive, 'Info.plist'));
  const relativeApp = archived.ApplicationProperties?.ApplicationPath;
  if (
    typeof relativeApp !== 'string' ||
    !/^Applications\/[^/\\]+\.app$/.test(relativeApp)
  )
    throw new Error('Invalid simulator archive application path.');
  const app = join(archive, 'Products', relativeApp);
  const info = readPlist(join(app, 'Info.plist'));
  const executable = info.CFBundleExecutable;
  if (
    typeof executable !== 'string' ||
    !executable ||
    basename(executable) !== executable ||
    executable.includes('\\')
  )
    throw new Error('Invalid simulator executable.');
  const entitlements = simulatorSigningEntitlements(
    info,
    run('xcrun', ['vtool', '-show-build', join(app, executable)]),
  );
  const config = JSON.parse(
    readFileSync(join(root, 'src-desktop/tauri.ios.dev.conf.json'), 'utf8'),
  );
  if (
    info.CFBundleIdentifier !== config.identifier ||
    archived.ApplicationProperties.CFBundleIdentifier !== config.identifier
  )
    throw new Error(
      'Simulator archive does not match the development configuration.',
    );
  const expectedSchemes = config.plugins['deep-link'].mobile.flatMap(
    (item) => item.scheme,
  );
  const schemes = info.CFBundleURLTypes?.flatMap(
    (item) => item.CFBundleURLSchemes,
  );
  if (JSON.stringify(schemes) !== JSON.stringify(expectedSchemes))
    throw new Error(
      'Simulator pairing association does not match its development identity.',
    );
  const temporary = mkdtempSync(join(tmpdir(), 'station-simulator-signing-'));
  try {
    const path = join(temporary, 'entitlements.plist');
    writeFileSync(path, JSON.stringify(entitlements), { mode: 0o600 });
    run('plutil', ['-convert', 'xml1', path]);
    run('codesign', [
      '--force',
      '--sign',
      '-',
      '--identifier',
      info.CFBundleIdentifier,
      '--entitlements',
      path,
      app,
    ]);
    run('codesign', ['--verify', '--strict', app]);
    return app;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.platform !== 'darwin')
    throw new Error('iOS simulator builds require macOS and Xcode.');
  const archive = resolve(
    root,
    'src-desktop/gen/apple/build/station_iOS.xcarchive',
  );
  console.log(`Simulator-only development app: ${signIosSimulator(archive)}`);
}

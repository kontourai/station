import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

const project = resolve(import.meta.dirname, '../..');
const identity = 'io.kontourai.station.dev.store.rehearsal';
const appName = 'Station Store Rehearsal.app';

function run(program, args) {
  return execFileSync(program, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 120_000,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function plistValue(plist, key) {
  return run('/usr/bin/plutil', ['-extract', key, 'raw', plist]);
}

function sign(path, entitlements) {
  run('/usr/bin/codesign', [
    '--force',
    '--sign',
    '-',
    '--entitlements',
    join(project, 'src-desktop', entitlements),
    path,
  ]);
}

if (process.platform !== 'darwin' || process.argv.length !== 4)
  throw new Error(
    'Usage on macOS: node ops/release/macos-store-stage.mjs <rehearsal.app> <new-output-directory>',
  );

const input = realpathSync(process.argv[2]);
const plist = join(input, 'Contents/Info.plist');
if (plistValue(plist, 'CFBundleIdentifier') !== identity)
  throw new Error('Build the Mac Store rehearsal variant before staging.');
const associations = JSON.parse(
  run('/usr/bin/plutil', [
    '-extract',
    'CFBundleURLTypes',
    'json',
    '-o',
    '-',
    plist,
  ]),
);
const schemes = associations.flatMap((entry) => entry.CFBundleURLSchemes);
if (schemes.length !== 1 || schemes[0] !== 'station-dev-store-rehearsal')
  throw new Error('Rehearsal pairing URL does not have the expected scheme.');
const binaryName = plistValue(plist, 'CFBundleExecutable');
if (
  !/^[a-zA-Z0-9._-]+$/.test(binaryName) ||
  binaryName === '.' ||
  binaryName === '..'
)
  throw new Error('Invalid rehearsal bundle executable.');

const inputBinary = join(input, 'Contents/MacOS', binaryName);
const minimumVersion = plistValue(plist, 'LSMinimumSystemVersion');
if (!/^\d+\.\d+(\.\d+)?$/.test(minimumVersion))
  throw new Error('Invalid minimum macOS version.');
const architectures = run('/usr/bin/lipo', ['-archs', inputBinary]).split(
  /\s+/,
);
if (
  architectures.some(
    (architecture) => !['arm64', 'x86_64'].includes(architecture),
  )
)
  throw new Error('Unexpected macOS rehearsal architecture.');

const output = resolve(process.argv[3]);
mkdirSync(output);
const app = join(output, appName);
run('/usr/bin/ditto', [input, app]);
const node = join(app, 'Contents/MacOS/station-node');
const helper = join(app, 'Contents/MacOS/station-process-birth');
run('/usr/bin/xcrun', [
  'clang',
  '-O2',
  '-Wall',
  '-Wextra',
  '-Werror',
  `-mmacosx-version-min=${minimumVersion}`,
  ...architectures.flatMap((architecture) => ['-arch', architecture]),
  join(project, 'src-desktop/tools/macos-store-process-birth.c'),
  '-o',
  helper,
]);
sign(node, 'MacStoreHelper.entitlements.plist');
sign(helper, 'MacStoreHelper.entitlements.plist');
sign(app, 'MacStore.entitlements.plist');
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
console.log(app);

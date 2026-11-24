import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { taggedStoreIdentity } from '../../scripts/lib/native-release-config.mjs';
import { embeddedMacosMachOPaths } from '../nightly/macos-embedded-signing.mjs';

const project = resolve(import.meta.dirname, '../..');
const rehearsalId = 'io.kontourai.station.dev.store.rehearsal';
const stableId = 'io.kontourai.station';
const appEntitlements = join(
  project,
  'src-desktop/MacStore.entitlements.plist',
);
const helperEntitlements = join(
  project,
  'src-desktop/MacStoreHelper.entitlements.plist',
);

function run(program, args) {
  return execFileSync(program, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 600_000,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function plistValue(plist, key) {
  return run('/usr/bin/plutil', ['-extract', key, 'raw', plist]);
}

function assertBundle(input, id, scheme) {
  const plist = join(input, 'Contents/Info.plist');
  if (plistValue(plist, 'CFBundleIdentifier') !== id)
    throw new Error('The app bundle has the wrong product identity.');
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
  if (schemes.length !== 1 || schemes[0] !== scheme)
    throw new Error('The app bundle has the wrong pairing scheme.');
  return plist;
}

function stageApp(input, plist, output, appName) {
  const binaryName = plistValue(plist, 'CFBundleExecutable');
  if (
    !/^[a-zA-Z0-9._-]+$/.test(binaryName) ||
    binaryName === '.' ||
    binaryName === '..'
  )
    throw new Error('Invalid app bundle executable.');
  const minimumVersion = plistValue(plist, 'LSMinimumSystemVersion');
  if (!/^\d+\.\d+(\.\d+)?$/.test(minimumVersion))
    throw new Error('Invalid minimum macOS version.');
  const architectures = run('/usr/bin/lipo', [
    '-archs',
    join(input, 'Contents/MacOS', binaryName),
  ]).split(/\s+/);
  if (architectures.some((arch) => !['arm64', 'x86_64'].includes(arch)))
    throw new Error('Unexpected macOS architecture.');

  mkdirSync(output);
  const app = join(realpathSync(output), appName);
  run('/usr/bin/ditto', [input, app]);
  run('/usr/bin/xcrun', [
    'clang',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    `-mmacosx-version-min=${minimumVersion}`,
    ...architectures.flatMap((arch) => ['-arch', arch]),
    join(project, 'src-desktop/tools/macos-store-process-birth.c'),
    '-o',
    join(app, 'Contents/MacOS/station-process-birth'),
  ]);
  return app;
}

function sign(path, { identity, entitlements, keychain }) {
  run('/usr/bin/codesign', [
    '--force',
    '--sign',
    identity,
    '--timestamp=none',
    ...(keychain ? ['--keychain', keychain] : []),
    ...(entitlements ? ['--entitlements', entitlements] : []),
    path,
  ]);
  run('/usr/bin/codesign', ['--verify', '--strict', path]);
}

function sealApp(app, identity, entitlements, keychain) {
  for (const filename of ['station-node', 'station-process-birth']) {
    sign(join(app, 'Contents/MacOS', filename), {
      identity,
      entitlements: helperEntitlements,
      keychain,
    });
  }
  sign(app, { identity, entitlements, keychain });
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
}

function stageStore(
  input,
  output,
  tag,
  profile,
  appIdentity,
  installerIdentity,
  keychain,
) {
  const { marketingVersion, bundleVersion } = taggedStoreIdentity(tag);
  const plist = assertBundle(input, stableId, 'station-stable');
  const minimum = Number.parseInt(
    plistValue(plist, 'LSMinimumSystemVersion'),
    10,
  );
  if (!(minimum >= 12))
    throw new Error('The Mac Store package requires macOS 12 or later.');
  if (
    plistValue(plist, 'CFBundleShortVersionString') !== marketingVersion ||
    plistValue(plist, 'CFBundleVersion') !== bundleVersion
  )
    throw new Error(
      'The Mac Store bundle version differs from the release tag.',
    );
  if (
    ![appIdentity, installerIdentity].every((value) =>
      /^[A-F0-9]{40}$/.test(value),
    )
  )
    throw new Error(
      'Mac Store signing requires both exact certificate fingerprints.',
    );

  const app = stageApp(input, plist, output, 'Station.app');
  const root = realpathSync(output);
  const decoded = join(root, 'decoded-profile.plist');
  writeFileSync(
    decoded,
    run('/usr/bin/security', ['cms', '-D', '-i', profile]),
    {
      mode: 0o600,
    },
  );
  const team = plistValue(
    decoded,
    'Entitlements.com\\.apple\\.developer\\.team-identifier',
  );
  const appIdentifier = plistValue(
    decoded,
    'Entitlements.com\\.apple\\.application-identifier',
  );
  const expires = Date.parse(plistValue(decoded, 'ExpirationDate'));
  const certificate = plistValue(decoded, 'DeveloperCertificates.0');
  const fingerprint = createHash('sha1')
    .update(Buffer.from(certificate, 'base64'))
    .digest('hex')
    .toUpperCase();
  if (
    !/^[A-Z0-9]{10}$/.test(team) ||
    appIdentifier !== `${team}.${stableId}` ||
    !(expires > Date.now()) ||
    fingerprint !== appIdentity ||
    plistValue(decoded, 'Entitlements.keychain-access-groups.0') !== `${team}.*`
  )
    throw new Error(
      'The provisioning profile does not authorize the Stable Mac Store signer.',
    );

  const embeddedProfile = join(app, 'Contents/embedded.provisionprofile');
  copyFileSync(profile, embeddedProfile);
  chmodSync(embeddedProfile, 0o644);
  const entitlements = join(root, 'app-entitlements.plist');
  copyFileSync(appEntitlements, entitlements);
  run('/usr/libexec/PlistBuddy', [
    '-c',
    `Add :com.apple.application-identifier string ${appIdentifier}`,
    '-c',
    `Add :com.apple.developer.team-identifier string ${team}`,
    '-c',
    'Add :keychain-access-groups array',
    '-c',
    `Add :keychain-access-groups:0 string ${appIdentifier}`,
    entitlements,
  ]);
  for (const file of embeddedMacosMachOPaths(app)) {
    const description = run('/usr/bin/file', ['-b', file]);
    sign(file, {
      identity: appIdentity,
      entitlements: description.includes(' executable')
        ? helperEntitlements
        : undefined,
      keychain,
    });
  }
  sealApp(app, appIdentity, entitlements, keychain);

  const installer = join(root, `station-${tag}-macos-store.pkg`);
  run('/usr/bin/productbuild', [
    '--component',
    app,
    '/Applications',
    '--sign',
    installerIdentity,
    '--keychain',
    keychain,
    installer,
  ]);
  console.error(run('/usr/sbin/pkgutil', ['--check-signature', installer]));
  return installer;
}

const args = process.argv.slice(2);
if (process.platform !== 'darwin')
  throw new Error('Mac Store packaging requires macOS.');
if (args[0] === '--store' && args.length === 8) {
  const [
    ,
    input,
    output,
    tag,
    profile,
    appIdentity,
    installerIdentity,
    keychain,
  ] = args;
  console.log(
    stageStore(
      realpathSync(input),
      resolve(output),
      tag,
      profile,
      appIdentity,
      installerIdentity,
      keychain,
    ),
  );
} else if (args.length === 2) {
  const input = realpathSync(args[0]);
  const plist = assertBundle(input, rehearsalId, 'station-dev-store-rehearsal');
  const app = stageApp(
    input,
    plist,
    resolve(args[1]),
    'Station Store Rehearsal.app',
  );
  sealApp(app, '-', appEntitlements);
  console.log(app);
} else {
  throw new Error(
    'Usage: macos-store-stage.mjs <rehearsal.app> <new-output-dir> or --store <Station.app> <new-output-dir> <tag> <profile> <app-certificate-sha1> <installer-certificate-sha1> <keychain>',
  );
}

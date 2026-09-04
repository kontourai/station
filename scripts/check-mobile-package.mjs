import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const CHECKED_IOS_ALLOWLIST = JSON.parse(
  readFileSync(
    new URL('../config/mobile-ios-capability-allowlist.json', import.meta.url),
    'utf8',
  ),
);

const REVIEWED_IOS_ENTITLEMENTS = new Set([
  'application-identifier',
  'com.apple.developer.team-identifier',
  'keychain-access-groups',
  'aps-environment',
  'get-task-allow',
  'beta-reports-active',
]);
const SYSTEM_DEPENDENCY_PREFIXES = ['/System/Library/', '/usr/lib/'];
const BUILD_MANIFEST_FILE = 'station-build.json';

export function parseIosClientBuildProvenance(contents) {
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error('Packaged iOS app has invalid station-build.json');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof parsed.sha !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(parsed.sha) ||
    typeof parsed.branch !== 'string' ||
    parsed.branch.trim().length === 0 ||
    typeof parsed.builtAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
      parsed.builtAt,
    ) ||
    !Number.isFinite(Date.parse(parsed.builtAt))
  ) {
    throw new Error('Packaged iOS app has invalid station-build.json');
  }
  const canonical = parsed.builtAt.includes('.')
    ? parsed.builtAt
    : parsed.builtAt.replace(/Z$/, '.000Z');
  if (new Date(parsed.builtAt).toISOString() !== canonical)
    throw new Error('Packaged iOS app has invalid station-build.json');
  return {
    sha: parsed.sha.toLowerCase(),
    branch: parsed.branch,
    builtAt: new Date(parsed.builtAt).toISOString(),
  };
}

function plistKeys(plist) {
  return [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
}
function hasTruePlistValue(plist, key) {
  return new RegExp(`<key>${key}</key>\\s*<true\\s*/>`).test(plist);
}
function linkedPaths(output) {
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(' ')[0])
    .filter(Boolean);
}

/**
 * Resolves the checked-in allowlist against one packaged app. Every path in
 * the allowlist is relative to the application bundle, so the same review
 * covers Stable, Beta, and Nightly, whose bundle directories differ only by
 * product name; the main executable is named by the bundle's own
 * CFBundleExecutable through the `{executable}` token rather than by a
 * product name written into the allowlist.
 */
function resolveAllowlist(allowlist, executable) {
  const resolve = (entries) =>
    entries.map((entry) => {
      if (!entry.includes('{executable}')) return entry;
      if (typeof executable !== 'string' || !executable.length)
        throw new Error(
          'Packaged iOS Info.plist names no CFBundleExecutable to resolve the allowlist against',
        );
      return entry.replaceAll('{executable}', executable);
    });
  return {
    ...allowlist,
    signedBundlePaths: resolve(allowlist.signedBundlePaths),
    machOPaths: resolve(allowlist.machOPaths),
    privacyManifestPaths: resolve(allowlist.privacyManifestPaths),
  };
}

export function auditIosInventory(
  {
    info,
    executable,
    privacyManifests,
    signedBundles,
    dependencies,
    staticArchives = /** @type {string[]} */ ([]),
  },
  checkedInAllowlist = CHECKED_IOS_ALLOWLIST,
) {
  const allowlist = resolveAllowlist(checkedInAllowlist, executable);
  if (staticArchives.length)
    throw new Error(
      `Packaged iOS app contains static build artifact(s): ${staticArchives.join(', ')}`,
    );
  for (const key of [
    'NSCameraUsageDescription',
    'NSLocalNetworkUsageDescription',
    'NSMicrophoneUsageDescription',
  ]) {
    if (!info.includes(`<key>${key}</key>`))
      throw new Error(`Packaged iOS Info.plist is missing ${key}`);
  }
  if (privacyManifests.length === 0)
    throw new Error('Packaged iOS app has no privacy manifest');
  for (const { path, contents } of privacyManifests) {
    if (!allowlist.privacyManifestPaths.includes(path)) {
      throw new Error(
        `Privacy manifest ${path} is not in the bundle-relative allowlist`,
      );
    }
    const unexpectedPrivacyKeys = plistKeys(contents).filter(
      (key) => !allowlist.privacyKeys.includes(key),
    );
    if (unexpectedPrivacyKeys.length)
      throw new Error(
        `Privacy manifest ${path} contains unreviewed declarations: ${unexpectedPrivacyKeys.join(', ')}`,
      );
    if (
      !contents.includes('<key>NSPrivacyTracking</key>') ||
      /<key>NSPrivacyTracking<\/key>\s*<true\s*\/>/.test(contents)
    ) {
      throw new Error(
        `Privacy manifest ${path} must explicitly disable tracking`,
      );
    }
  }
  for (const { path, entitlements } of signedBundles) {
    if (!allowlist.signedBundlePaths.includes(path)) {
      throw new Error(
        `Signed bundle ${path} is not in the checked-in allowlist`,
      );
    }
    const unexpected = plistKeys(entitlements).filter(
      (key) => !REVIEWED_IOS_ENTITLEMENTS.has(key),
    );
    if (unexpected.length)
      throw new Error(
        `Signed bundle ${path} contains unreviewed entitlements: ${unexpected.join(', ')}`,
      );
    if (
      plistKeys(entitlements).includes('beta-reports-active') &&
      !hasTruePlistValue(entitlements, 'beta-reports-active')
    ) {
      throw new Error(
        `Signed bundle ${path} beta-reports-active must be true for an App Store/TestFlight export`,
      );
    }
  }
  const embedded = new Set(allowlist.embeddedRpathTargets);
  for (const { binary, output } of dependencies) {
    if (!allowlist.machOPaths.includes(binary)) {
      throw new Error(
        `Mach-O ${binary} is not in the checked-in bundle-relative allowlist`,
      );
    }
    const unexpected = linkedPaths(output).filter((path) => {
      if (SYSTEM_DEPENDENCY_PREFIXES.some((prefix) => path.startsWith(prefix)))
        return false;
      if (!path.startsWith('@rpath/')) return true;
      const target = path
        .slice('@rpath/'.length)
        .split('/')[0]
        .replace(/\.framework$/, '');
      return !embedded.has(target);
    });
    if (unexpected.length)
      throw new Error(
        `Mach-O ${binary} contains unreviewed dependency paths: ${unexpected.join(', ')}`,
      );
  }
  return {
    privacyCount: privacyManifests.length,
    signedBundleCount: signedBundles.length,
    binaryCount: dependencies.length,
  };
}

export function auditIosPackage({ info, entitlements, dependencies }) {
  return auditIosInventory({
    info,
    executable: 'Station',
    privacyManifests: [
      {
        path: 'PrivacyInfo.xcprivacy',
        contents: '<key>NSPrivacyTracking</key><false/>',
      },
    ],
    signedBundles: [{ path: '.', entitlements }],
    dependencies: [{ binary: 'Station', output: dependencies }],
  });
}

function command(program, args) {
  return execFileSync(program, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function lines(program, args) {
  return command(program, args).split('\n').filter(Boolean);
}

/** A path inside the application bundle, with the bundle itself as `.`. */
function bundleRelative(app, path) {
  return relative(app, path) || '.';
}

export function inspectIosPackageRoot(root) {
  const app = lines('find', [
    root,
    '-maxdepth',
    '1',
    '-type',
    'd',
    '-name',
    '*.app',
  ])[0];
  if (!app) throw new Error('IPA contains no application bundle');
  const privacyManifests = lines('find', [
    app,
    '-name',
    'PrivacyInfo.xcprivacy',
    '-type',
    'f',
  ]).map((path) => ({
    path: bundleRelative(app, path),
    contents: command('plutil', ['-convert', 'xml1', '-o', '-', path]),
  }));
  const signedPaths = [
    app,
    ...lines('find', [
      app,
      '-type',
      'd',
      '(',
      '-name',
      '*.app',
      '-o',
      '-name',
      '*.appex',
      '-o',
      '-name',
      '*.framework',
      '-o',
      '-name',
      '*.xpc',
      '-o',
      '-name',
      '*.bundle',
      ')',
    ]),
  ];
  const uniqueSignedPaths = [...new Set(signedPaths)];
  const signedBundles = uniqueSignedPaths.map((path) => ({
    path: bundleRelative(app, path),
    entitlements: command('codesign', ['-d', '--entitlements', ':-', path]),
  }));
  const binaries = lines('find', [app, '-type', 'f']).filter((path) =>
    command('file', ['-b', path]).includes('Mach-O'),
  );
  const staticArchives = lines('find', [app, '-type', 'f', '-name', '*.a']).map(
    (path) => bundleRelative(app, path),
  );
  const buildManifests = lines('find', [
    app,
    '-type',
    'f',
    '-name',
    BUILD_MANIFEST_FILE,
  ]);
  if (buildManifests.length !== 1)
    throw new Error(
      `Packaged iOS app must contain exactly one ${BUILD_MANIFEST_FILE}`,
    );
  const clientBuild = parseIosClientBuildProvenance(
    readFileSync(buildManifests[0], 'utf8'),
  );
  if (binaries.length === 0) throw new Error('IPA contains no Mach-O binaries');
  const dependencies = binaries.map((binary) => ({
    binary: bundleRelative(app, binary),
    output: command('otool', ['-L', binary]),
  }));
  const executable = command('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleExecutable',
    join(app, 'Info.plist'),
  ]).trim();
  return {
    ...auditIosInventory({
      info: command('plutil', [
        '-convert',
        'xml1',
        '-o',
        '-',
        join(app, 'Info.plist'),
      ]),
      executable,
      privacyManifests,
      signedBundles,
      dependencies,
      staticArchives,
    }),
    clientBuild,
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const rootIndex = process.argv.indexOf('--root');
  if (
    process.argv[2] !== 'ios' ||
    rootIndex < 0 ||
    !process.argv[rootIndex + 1]
  )
    throw new Error('Expected ios --root <unpacked IPA>');
  console.log(
    JSON.stringify(inspectIosPackageRoot(process.argv[rootIndex + 1])),
  );
}

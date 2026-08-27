import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  decodeProvisioningProfile,
  inspectAppStoreDistributionProfile,
} from './check-ios-store-profile.mjs';
import {
  assertRepositoryVersion,
  nativeIdentifierForChannel,
  nativeReleaseChannel,
  taggedStoreIdentity,
} from './lib/native-release-config.mjs';

function option(name, args) {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
}
function requireOption(name, args) {
  const value = option(name, args);
  if (!value || value.startsWith('--'))
    throw new Error(`Expected --${name} <value>`);
  return value;
}
function run(program, args) {
  return execFileSync(program, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}
function identityRecords(output) {
  return output.split('\n').flatMap((line) => {
    const match = /^\s*\d+\)\s+([A-F0-9]{40})\s+"(.+)"$/.exec(line);
    return match ? [{ fingerprint: match[1], label: match[2] }] : [];
  });
}
/** Local, read-only readiness check. It neither logs into Apple services nor
 * imports certificates; `security find-identity` reports public metadata only. */
export function localIosReleasePreflight({
  tag,
  profilePath,
  team,
  identity,
  now,
  runCommand = run,
}) {
  const channel = nativeReleaseChannel(tag);
  const identityFromTag = taggedStoreIdentity(tag);
  const expectedBundleIdentifier = nativeIdentifierForChannel(channel);
  const blockers = [];
  try {
    assertRepositoryVersion({
      tag,
      packageVersion: JSON.parse(readFileSync('package.json', 'utf8')).version,
    });
    const taggedCommit = runCommand('git', [
      'rev-parse',
      '--verify',
      `refs/tags/${tag}^{commit}`,
    ]).trim();
    const head = runCommand('git', ['rev-parse', 'HEAD']).trim();
    if (taggedCommit !== head)
      blockers.push(
        `Release tag ${tag} resolves to ${taggedCommit}, not inspected HEAD ${head}.`,
      );
    if (runCommand('git', ['status', '--porcelain']).trim())
      blockers.push(
        'Release inputs are dirty; commit or discard local changes before preparing an archive.',
      );
  } catch (error) {
    blockers.push(`Release tag/source validation failed: ${error.message}`);
  }
  if (channel !== 'stable') {
    blockers.push(
      `iOS ${channel} is not release-enabled: it needs its own Apple App ID, provisioning profile, signing identity, and App Store Connect/TestFlight setup.`,
    );
  }
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor !== 24)
    blockers.push(`Node 24 is required; found ${process.version}.`);
  for (const [program, args] of [
    ['xcodebuild', ['-version']],
    ['xcodegen', ['--version']],
    ['pod', ['--version']],
    ['rustup', ['target', 'list', '--installed']],
  ]) {
    try {
      const output = runCommand(program, args);
      if (
        program === 'rustup' &&
        !output.split(/\r?\n/).includes('aarch64-apple-ios')
      )
        blockers.push('Rust target aarch64-apple-ios is not installed.');
    } catch {
      blockers.push(
        `Missing or unusable local tool: ${program} ${args.join(' ')}`,
      );
    }
  }
  let profile;
  try {
    profile = inspectAppStoreDistributionProfile(
      decodeProvisioningProfile(profilePath, runCommand),
      {
        label: profilePath,
        expectedTeam: team,
        expectedBundleIdentifier,
        ...(now ? { now } : {}),
      },
    );
  } catch (error) {
    blockers.push(error.message);
  }
  try {
    const records = identityRecords(
      runCommand('security', ['find-identity', '-v', '-p', 'codesigning']),
    );
    const selected = records.filter((record) => record.label === identity);
    if (selected.length !== 1)
      blockers.push(
        `Signing identity ${JSON.stringify(identity)} is not an unambiguous valid codesigning identity.`,
      );
    else if (
      !profile?.certificateFingerprints.includes(selected[0].fingerprint)
    )
      blockers.push(
        `Signing identity ${JSON.stringify(identity)} does not match a public certificate embedded in the provisioning profile.`,
      );
  } catch {
    blockers.push(
      'Unable to inspect signing identity metadata with security find-identity -v -p codesigning.',
    );
  }
  return {
    ready: blockers.length === 0,
    channel,
    tag,
    marketingVersion: identityFromTag.marketingVersion,
    buildNumber: identityFromTag.bundleVersion,
    expectedBundleIdentifier,
    profile,
    blockers,
    handoff: {
      simulator: `npx tauri ios build --target aarch64-sim --no-sign --ci --config <release-overlay>`,
      archive: `npx tauri ios build --export-method app-store-connect --ci --config <release-overlay>`,
      export:
        'Verify the resulting IPA with scripts/check-ios-store-profile.mjs and scripts/check-mobile-package.mjs before any operator-controlled upload.',
    },
  };
}

function isMainModule() {
  try {
    return (
      process.argv[1] &&
      realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  let result;
  try {
    result = localIosReleasePreflight({
      tag: requireOption('tag', args),
      profilePath: requireOption('profile', args),
      team: requireOption('team', args),
      identity: requireOption('identity', args),
    });
  } catch (error) {
    result = { ready: false, blockers: [error.message] };
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
}

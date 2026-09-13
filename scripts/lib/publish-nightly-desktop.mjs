import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { desktopPublishedAssetName } from './windows-nightly.mjs';

const repository = 'kontourai/station';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function github(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 600_000,
  });
}

/** The only feed writer: immutable downloads are verified before latest.json changes. */
export function publishNightlyDesktop({
  root,
  output,
  plan,
  receipts,
  run = github,
}) {
  if (
    plan.versionIdentities.desktop.releaseTag !== 'nightly-desktop' ||
    !/^[a-f0-9]{40}$/.test(plan.sourceSha) ||
    receipts.length !== 2 ||
    receipts
      .map((r) => r.platform)
      .sort()
      .join(',') !== 'macos,windows'
  ) {
    throw new Error('Expected one exact-source desktop cohort');
  }
  mkdirSync(output, { recursive: false });
  const assets = [];
  let manifest;
  for (const receipt of receipts) {
    if (
      receipt.sourceSha !== plan.sourceSha ||
      receipt.cohortId !== plan.cohortId ||
      receipt.planContentDigest !== plan.planContentDigest
    ) {
      throw new Error('Desktop receipt differs from admitted plan');
    }
    for (const record of receipt.artifacts) {
      const path = join(root, `cohort-${receipt.platform}`, record.name);
      const bytes = readFileSync(path);
      if (bytes.length !== record.size || hash(bytes) !== record.sha256)
        throw new Error('Desktop bytes changed after admission');
      if (record.name === 'windows-build-receipt.json') continue;
      const name = desktopPublishedAssetName(
        record.name,
        plan.versionIdentities.desktop.version,
      );
      const destination = join(output, name);
      copyFileSync(path, destination);
      const asset = { ...record, name, path: destination };
      if (record.name === 'latest.json') manifest = asset;
      else assets.push(asset);
    }
  }
  if (!manifest || assets.length !== 5)
    throw new Error('Incomplete desktop publication inventory');
  const query = () =>
    JSON.parse(
      run(['api', `repos/${repository}/releases/tags/nightly-desktop`]),
    );
  const checkRelease = (release) => {
    if (
      release.tag_name !== 'nightly-desktop' ||
      release.draft !== false ||
      release.prerelease !== true ||
      !Array.isArray(release.assets)
    ) {
      throw new Error('Unexpected desktop release state');
    }
    return release;
  };
  const matches = (release, asset) => {
    const found = release.assets.filter((entry) => entry.name === asset.name);
    return (
      found.length === 1 &&
      found[0].state === 'uploaded' &&
      found[0].size === asset.size &&
      found[0].digest === `sha256:${asset.sha256}`
    );
  };
  const before = checkRelease(query());
  const previous = before.assets.filter(
    (asset) => asset.name === 'latest.json',
  );
  if (
    previous.length > 1 ||
    (previous.length === 0 && before.assets.length > 0)
  ) {
    throw new Error('Existing desktop feed is missing or duplicated');
  }
  if (previous.length === 1) {
    const asset = previous[0];
    if (!Number.isSafeInteger(asset.id) || asset.id < 1)
      throw new Error('Invalid current manifest asset ID');
    const currentBytes = run([
      'api',
      `repos/${repository}/releases/assets/${asset.id}`,
      '-H',
      'Accept: application/octet-stream',
    ]);
    if (`sha256:${hash(Buffer.from(currentBytes))}` !== asset.digest)
      throw new Error('Current manifest changed during publication preflight');
    const parts = (version) => {
      const match =
        /^(\d+)\.(\d+)\.(\d+)-nightly\.(\d+)(?:\.([1-9]\d*))?$/.exec(
          version ?? '',
        );
      if (!match) throw new Error('Invalid Nightly updater version');
      const values = match.slice(1).map((value) => Number(value ?? 0));
      if (!values.every(Number.isSafeInteger) || values[4] > 99)
        throw new Error('Invalid Nightly updater version');
      return values;
    };
    const current = parts(JSON.parse(currentBytes).version);
    const candidate = parts(plan.versionIdentities.desktop.version);
    const difference = candidate.findIndex(
      (value, index) => value !== current[index],
    );
    if (difference !== -1 && candidate[difference] < current[difference])
      throw new Error(
        'Desktop publication would regress the current Nightly version',
      );
  }
  for (const asset of assets) {
    if (before.assets.some((entry) => entry.name === asset.name)) {
      if (!matches(before, asset))
        throw new Error(
          'An immutable desktop asset already exists with different bytes',
        );
    } else {
      run([
        'release',
        'upload',
        'nightly-desktop',
        '--repo',
        repository,
        asset.path,
      ]);
    }
  }
  const uploaded = checkRelease(query());
  if (!assets.every((asset) => matches(uploaded, asset)))
    throw new Error(
      'Desktop uploads are not available with the staged digests; feed unchanged',
    );
  run([
    'release',
    'upload',
    'nightly-desktop',
    '--repo',
    repository,
    '--clobber',
    manifest.path,
  ]);
  const published = checkRelease(query());
  if (![...assets, manifest].every((asset) => matches(published, asset)))
    throw new Error('Desktop publication readback differs from staged bytes');
  return published;
}

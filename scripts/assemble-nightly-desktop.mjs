import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyTauriUpdaterSignature } from './lib/release-artifacts.mjs';
import {
  assembleNightlyDesktopManifest,
  assertWindowsNightlyReceipt,
  desktopPublishedAssetName,
} from './lib/windows-nightly.mjs';

const [root, publicKeyPath] = process.argv.slice(2);
const readJson = (path) =>
  JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const plan = readJson(join(root, 'cohort-plan.json'));
const receipt = readJson(
  join(root, 'cohort-windows/windows-build-receipt.json'),
);
assertWindowsNightlyReceipt(
  receipt,
  { ...plan.versionIdentities.desktop, sourceSha: plan.sourceSha },
  readFileSync(
    join(
      root,
      'cohort-windows/station-nightly-desktop-windows-x86_64-setup.exe',
    ),
  ),
);
const updaterPublicKey = readFileSync(publicKeyPath, 'utf8').trim();
const builds = [
  [
    'darwin-aarch64',
    'cohort-macos',
    'station-nightly-desktop-macos-aarch64.app.tar.gz',
  ],
  [
    'windows-x86_64',
    'cohort-windows',
    'station-nightly-desktop-windows-x86_64-setup.exe',
  ],
].map(([platform, directory, name]) => {
  const updater = join(root, directory, name);
  const signature = `${updater}.sig`;
  verifyTauriUpdaterSignature({ updater, signature, updaterPublicKey });
  const bytes = readFileSync(updater);
  return {
    platform,
    sourceSha: plan.sourceSha,
    version: plan.versionIdentities.desktop.version,
    // Native signatures are checked by the platform build jobs; the admission
    // and protected verifier additionally require their exact workflow attestations.
    platformSigningState: 'VERIFIED',
    updaterSigningState: 'VERIFIED',
    assetName: desktopPublishedAssetName(
      name,
      plan.versionIdentities.desktop.version,
    ),
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    signature: readFileSync(signature, 'utf8').trim(),
  };
});
const manifest = assembleNightlyDesktopManifest({
  version: plan.versionIdentities.desktop.version,
  sourceSha: plan.sourceSha,
  pubDate: new Date().toISOString(),
  builds,
});
writeFileSync(
  join(root, 'cohort-macos/latest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

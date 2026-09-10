import { readFileSync, writeFileSync } from 'node:fs';
import { createWindowsNightlyConfig } from './lib/windows-nightly.mjs';

const config = createWindowsNightlyConfig({
  packageVersion: JSON.parse(readFileSync('package.json', 'utf8')).version,
  bundleVersion: process.env.STATION_WINDOWS_BUNDLE_VERSION,
  updaterPublicKey: process.env.TAURI_SIGNING_PUBLIC_KEY,
});
if (process.env.STATION_WINDOWS_THUMBPRINT) {
  Object.assign(config.bundle.windows, {
    certificateThumbprint: process.env.STATION_WINDOWS_THUMBPRINT,
    digestAlgorithm: 'sha256',
    timestampUrl: 'http://timestamp.digicert.com',
  });
}
writeFileSync(
  process.env.STATION_WINDOWS_CONFIG,
  `${JSON.stringify(config, null, 2)}\n`,
);

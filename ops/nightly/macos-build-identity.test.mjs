import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

test('macOS Nightly generates a temporary version overlay and gives it to Tauri', () => {
  const installer = readFileSync(
    resolve(import.meta.dirname, 'install-macos.zsh'),
    'utf8',
  );
  expect(installer).toContain('scripts/lib/nightly-build-identity.mjs');
  expect(installer).toContain('--config src-desktop/tauri.nightly.conf.json');
  expect(installer).toContain('--config "$nightly_config"');
  expect(installer).toContain('STATION_BUILD_VERSION="$nightly_version"');
  expect(installer).toContain('Print :CFBundleShortVersionString');
  expect(installer).toContain('Print :CFBundleVersion');
  expect(installer).toContain('bundle.macOS.bundleVersion');
});

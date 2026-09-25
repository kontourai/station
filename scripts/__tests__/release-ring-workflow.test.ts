import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');

describe('portable release-ring workflow', () => {
  it('attests every portable asset before the single draft assembler uploads it', () => {
    const workflow = readFileSync(
      resolve(repoRoot, '.github/workflows/release.yml'),
      'utf8',
    );

    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('attestations: write');
    const attestationAction =
      'actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8';
    const portableStart = workflow.indexOf('\n  portable:');
    const androidStart = workflow.indexOf('\n  android:', portableStart);
    const portable = workflow.slice(portableStart, androidStart);
    expect(portable.match(new RegExp(attestationAction, 'g'))).toHaveLength(1);
    expect(portable).toContain('subject-path: release-assets/*');
    const packager = readFileSync(
      resolve(repoRoot, 'scripts/package-portable-release.sh'),
      'utf8',
    );
    expect(packager).toContain('station-release-ring-');
    expect(workflow).not.toContain('workflow_dispatch:');

    const packageIndex = portable.indexOf(
      'scripts/package-portable-release.sh',
    );
    const attestationIndex = portable.indexOf(attestationAction);
    const uploadIndex = workflow.indexOf('gh release upload');
    expect(packageIndex).toBeGreaterThan(-1);
    expect(attestationIndex).toBeGreaterThan(packageIndex);
    expect(uploadIndex).toBeGreaterThan(attestationIndex);
    expect(workflow).not.toContain('gh release edit');

    const smoke = readFileSync(
      resolve(repoRoot, '.github/workflows/install-smoke.yml'),
      'utf8',
    );
    expect(smoke).toContain('channel: [stable, preview, nightly]');
    expect(smoke).toContain(
      'RUNTIME_CHANNEL: $' + '{{ matrix.runtime_channel }}',
    );
    // Each ring's runtime, launcher, and signing key id. Nightly signs only
    // under the pinned nightly key id (#2675).
    for (const [channel, tag, runtime, launcher, keyId] of [
      [
        'stable',
        'v0.0.0',
        'stable',
        'station',
        'station-portable-release-2026-09',
      ],
      [
        'preview',
        'v0.0.0-preview.1',
        'beta',
        'station-beta',
        'station-portable-release-2026-09',
      ],
      [
        'nightly',
        'v0.0.0-nightly.1',
        'nightly',
        'station-nightly',
        'station-portable-nightly-2026-09',
      ],
    ])
      expect(smoke).toContain(
        [
          `          - channel: ${channel}`,
          `            release_tag: ${tag}`,
          `            runtime_channel: ${runtime}`,
          `            launcher_name: ${launcher}`,
          `            key_id: ${keyId}`,
        ].join('\n'),
      );
    expect(smoke).toContain('--key-id "$MANIFEST_KEY_ID"');
    expect(smoke).toContain('schemaVersion: channel === "nightly" ? 2 : 1');
    expect(smoke).toContain('launcher_name="$LAUNCHER_NAME"');
    expect(smoke).toContain('"$launcher" upgrade');
    expect(smoke).toContain('installs/$runtime_channel');
    expect(smoke).toContain('instances/$runtime_channel');
    expect(smoke).toContain('Expected failed candidate start');
    expect(smoke).toContain('previous_current');
    expect(smoke).toContain('STATION_INSTALL_PUBLIC_MANIFEST_URL=');
    expect(smoke).toContain('STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL=');
    expect(smoke).toContain('STATION_INSTALL_ALLOW_INSECURE_TEST_URLS=1');
    expect(smoke).toContain('scripts/ecosystem-manifest.mjs');
    // The smoke installs through the unauthenticated public-manifest path, so
    // its fixture must not fake gh either.
    expect(smoke).toContain('gh must not run in the public installer path');
    // The bad-release leg must swap the served fixture the packaged upgrade
    // verifies against, not just a local directory the installer never reads.
    expect(smoke).toContain(
      'cp "$bad_release/station-portable.tar.gz" "$serve_dir/station-portable.tar.gz"',
    );
    const initialInstallIndex = smoke.indexOf(
      'STATION_INSTALL_PUBLIC_MANIFEST_URL=http://127.0.0.1:8766/',
    );
    const captureCurrentIndex = smoke.indexOf('previous_current=$(readlink');
    const packagedUpgradeIndex = smoke.indexOf('"$launcher" upgrade');
    expect(initialInstallIndex).toBeGreaterThan(-1);
    expect(captureCurrentIndex).toBeGreaterThan(initialInstallIndex);
    expect(packagedUpgradeIndex).toBeGreaterThan(captureCurrentIndex);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
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
    const document = load(smoke) as {
      jobs: Record<
        string,
        {
          strategy?: { matrix: { os: string[] } };
          steps: Array<{ run?: string; env?: Record<string, string> }>;
        }
      >;
    };
    const sourceJob = document.jobs['install-without-clone'];
    expect(sourceJob.strategy?.matrix.os).toEqual([
      'ubuntu-latest',
      'macos-latest',
    ]);
    const installs = sourceJob.steps.filter(
      (step) => step.run === 'bash scripts/smoke-install-source.sh',
    );
    expect(
      installs.map((step) => [
        step.env?.RELEASE_CHANNEL,
        step.env?.RUNTIME_CHANNEL,
      ]),
    ).toEqual([
      ['stable', 'stable'],
      ['preview', 'beta'],
    ]);
    for (const key of ['SMOKE_HOME', 'RELEASE_DIR', 'SERVER_PORT', 'UI_PORT']) {
      expect(new Set(installs.map((step) => step.env?.[key])).size).toBe(2);
    }
    const sourceSmoke = readFileSync(
      resolve(repoRoot, 'scripts/smoke-install-source.sh'),
      'utf8',
    );
    expect(sourceSmoke).toContain('launcher_name=station');
    expect(sourceSmoke).toContain('"$launcher" upgrade');
    expect(sourceSmoke).toContain('installs/$runtime_channel');
    expect(sourceSmoke).toContain('instances/$runtime_channel');
    expect(sourceSmoke).toContain('Expected failed candidate start');
    expect(sourceSmoke).toContain('previous_current');
    expect(sourceSmoke).toContain('STATION_INSTALL_PUBLIC_MANIFEST_URL=');
    expect(sourceSmoke).toContain('STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL=');
    expect(sourceSmoke).toContain('STATION_INSTALL_ALLOW_INSECURE_TEST_URLS=1');
    expect(sourceSmoke).toContain('scripts/ecosystem-manifest.mjs');
    // The smoke installs through the unauthenticated public-manifest path, so
    // its fixture must not fake gh either.
    expect(sourceSmoke).toContain(
      'gh must not run in the public installer path',
    );
    // The bad-release leg must swap the served fixture the packaged upgrade
    // verifies against, not just a local directory the installer never reads.
    expect(sourceSmoke).toContain(
      'cp "$bad_release/station-portable.tar.gz" "$serve_dir/station-portable.tar.gz"',
    );
    const initialInstallIndex = sourceSmoke.indexOf(
      'STATION_INSTALL_PUBLIC_MANIFEST_URL=http://127.0.0.1:${MANIFEST_PORT}/',
    );
    const captureCurrentIndex = sourceSmoke.indexOf(
      'previous_current=$(readlink',
    );
    const packagedUpgradeIndex = sourceSmoke.indexOf('"$launcher" upgrade');
    expect(initialInstallIndex).toBeGreaterThan(-1);
    expect(captureCurrentIndex).toBeGreaterThan(initialInstallIndex);
    expect(packagedUpgradeIndex).toBeGreaterThan(captureCurrentIndex);
  });
  it('keeps all native proofs on one runner without turning a failed proof into success', () => {
    const native = load(
      readFileSync(
        resolve(repoRoot, '.github/workflows/desktop-rust.yml'),
        'utf8',
      ),
    ) as {
      jobs: Record<
        string,
        {
          steps: Array<{
            name?: string;
            run?: string;
            if?: string;
            'continue-on-error'?: boolean;
          }>;
        }
      >;
    };
    expect(Object.keys(native.jobs)).toHaveLength(1);
    const steps = Object.values(native.jobs)[0].steps;
    for (const command of [
      'cargo fmt --check --manifest-path src-desktop/Cargo.toml',
      'cargo check --target aarch64-linux-android --lib',
      'node scripts/run-agent-activity-android-unit-tests.mjs --no-daemon',
      'npm run verify:desktop-rust',
    ]) {
      const proof = steps.find((step) => step.run?.includes(command));
      expect(proof, command).toBeDefined();
      expect(proof?.if).toContain('!cancelled()');
      expect(proof?.if).toContain("steps.prerequisites.outcome == 'success'");
      expect(proof?.['continue-on-error']).not.toBe(true);
    }
  });
});

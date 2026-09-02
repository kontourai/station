import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  createNativeReleaseConfig,
  NATIVE_UPDATER_ARTIFACT_MODE,
} from '../lib/native-release-config.mjs';
import { ANCHORE_SBOM_ACTION } from '../release-container-sbom-source.mjs';
import { cyclonedxComponents } from '../release-sbom-fragments.mjs';
import {
  FIXTURE_TEST_TIMEOUT_MS,
  runBoundedFixture,
} from './helpers/bounded-fixture-process.mjs';

const root = resolve(import.meta.dirname, '../..');
const release = readFileSync(
  resolve(root, '.github/workflows/release.yml'),
  'utf8',
);
const macosArtifacts = readFileSync(
  resolve(root, 'ops/release/macos-notarized-artifacts.mjs'),
  'utf8',
);
const publish = readFileSync(
  resolve(root, '.github/workflows/publish-release.yml'),
  'utf8',
);
const mobileFeedTransaction = readFileSync(
  resolve(root, 'scripts/publish-mobile-feed-transaction.sh'),
  'utf8',
);
const android = readFileSync(
  resolve(root, '.github/workflows/build-android.yml'),
  'utf8',
);
const nativeCohort = readFileSync(
  resolve(root, '.github/workflows/nightly-native-cohort.yml'),
  'utf8',
);
const testFlightDelivery = readFileSync(
  resolve(root, '.github/workflows/testflight-delivery.yml'),
  'utf8',
);
const mobileReleaseGuide = readFileSync(
  resolve(root, 'docs/guides/mobile-release.md'),
  'utf8',
);

describe('mobile release hardening contract', () => {
  it('permits a provider retry only after the immutable source authority verifies', () => {
    expect(testFlightDelivery).toContain('verify-ios-testflight-authority.mjs');
    expect(testFlightDelivery).toContain('--authority-ref "$AUTHORITY_REF"');
    expect(testFlightDelivery).not.toContain(
      'Existing provider build has no durable source/IPA binding',
    );
  });
  it('binds emitted native and web versions to the tag authority', () => {
    expect(release).toContain('node scripts/product-version.mjs --check');
    expect(release).toContain('android_version_code=');
    expect(release).toContain('ios_bundle_version=');
    expect(release).toContain('macos_bundle_version=');
    expect(release).toContain(
      `STATION_BUILD_VERSION: \${{ needs.preflight.outputs.version }}`,
    );
    expect(release).toContain("versionCode='$ANDROID_VERSION_CODE'");
    expect(release).toContain('Print :CFBundleVersion');
    expect(release).toContain(
      `MACOS_BUNDLE_VERSION: ${githubExpression('needs.preflight.outputs.macos_bundle_version')}`,
    );
    expect(release).toContain(')" = "$MACOS_BUNDLE_VERSION"');
    expect(testFlightDelivery).toContain("inputs.channel == 'stable'");
    expect(release).toContain('ios_marketing_version=');
  });

  it('fails closed on update configuration and audits packaged capabilities', () => {
    // The feed contract is optional-but-fail-closed, the same shape as the
    // store credentials: when configured it is enforced byte for byte; when
    // absent the job continues to the store upload rather than exiting eleven
    // steps before reaching it (#2211). Both halves are asserted, because an
    // "optional" gate that stopped enforcing when configured would be the
    // regression, and one that still exits 1 when absent re-blocks the store
    // track it was unblocked for.
    expect(release.match(/Resolve native update feed contract/g)).toHaveLength(
      1,
    );
    // Count, do not merely find: there are two mobile jobs, so a `toContain`
    // stays green after one of them stops validating.
    expect(
      release.match(/native-update-feed\.mjs validate-config/g),
    ).toHaveLength(1);
    expect(release.match(/configured=false/g)).toHaveLength(1);
    expect(testFlightDelivery).toContain(
      'native-update-feed.mjs write-authority-receipt',
    );
    expect(testFlightDelivery).toContain(
      'TestFlight/App Store owns delivered iOS updates',
    );
    expect(testFlightDelivery).toContain(
      'Missing required protected channel value',
    );
    expect(release).toContain('vars.NATIVE_APP_UPDATE_FEED_URL');
    expect(release).toContain('VITE_NATIVE_APP_VERSION');
    expect(release).toContain('Audit packaged Android capabilities');
    expect(release).toContain('station-aab-manifest.xml');
    expect(testFlightDelivery).toContain('check-mobile-package.mjs ios --root');
    expect(publish).toContain(
      'Publish release and compensate to draft until feed verifies',
    );
    expect(publish).toContain('NATIVE_APP_UPDATE_PUBLISH_TOKEN');
    expect(mobileFeedTransaction).toContain('native-update-feed.mjs deploy');
    expect(publish).toContain('scripts/publish-mobile-feed-transaction.sh');
    const publishStep = namedStep(
      workflowJob(publish, 'publish'),
      'Publish release and compensate to draft until feed verifies',
    );
    expect(publishStep.run).toContain('feed_args=()');
    expect(publishStep.run).not.toContain(
      'Missing native update provider credential',
    );
    expect(mobileFeedTransaction.indexOf('validate-config')).toBeLessThan(
      mobileFeedTransaction.indexOf('gh release edit'),
    );
    expect(mobileFeedTransaction).toContain('if [[ "$custom_feed" != true ]]');
    expect(mobileReleaseGuide).toContain(
      'station-<channel>-ios-testflight-<bundle-version>',
    );
  });
});

describe('frozen stable client-build provenance', () => {
  it('makes every desktop and Android producer reuse and byte-verify the one preflight manifest', () => {
    const preflight = workflowJob(release, 'preflight');
    const create = namedStep(
      preflight,
      'Create one immutable native client provenance artifact',
    );
    expect(create.run).toContain('release-client-build-provenance.mjs create');
    expect(create.run).toContain('--source-ref "refs/tags/$RELEASE_TAG"');

    for (const jobName of ['desktop-windows', 'desktop-linux', 'android']) {
      const job = workflowJob(release, jobName);
      const downloaded = job.steps?.filter(
        (step) =>
          step.uses?.startsWith('actions/download-artifact@') &&
          step.with?.name ===
            'station-release-client-build-provenance-$' + '{{ github.run_id }}',
      );
      expect(
        downloaded,
        `${jobName} must fetch the preflight artifact`,
      ).toHaveLength(1);
      expect(downloaded?.[0]?.with?.path).toBe(
        'release-client-build-provenance',
      );

      const staged = namedStep(
        job,
        'Stage the preflight-bound native client provenance bytes',
      );
      expect(staged.run).toContain('release-client-build-provenance.mjs stage');
      expect(staged.run).toContain('--source-sha "$RELEASE_SHA"');
      expect(stepIndex(job, staged.name as string)).toBeLessThan(
        stepIndex(
          job,
          jobName === 'android'
            ? 'Build signed universal APK and AAB'
            : 'Fail closed and create tag-bound updater configuration',
        ),
      );
    }

    const windows = workflowJob(release, 'desktop-windows');
    const windowsBuild = windows.steps?.find((step) =>
      step.uses?.startsWith('tauri-apps/tauri-action@'),
    );
    expect(windowsBuild?.env).toMatchObject({
      STATION_CLIENT_BUILD_REUSE: '1',
    });
    expect(
      namedStep(
        windows,
        'Verify Windows Authenticode signature and versioned build output',
      ).run,
    ).toContain(
      'MSI build provenance does not byte-equal the preflight manifest',
    );

    const linux = workflowJob(release, 'desktop-linux');
    const linuxBuilds = linux.steps?.filter((step) =>
      step.uses?.startsWith('tauri-apps/tauri-action@'),
    );
    expect(linuxBuilds).toHaveLength(2);
    for (const build of linuxBuilds ?? []) {
      expect(build.env).toMatchObject({ STATION_CLIENT_BUILD_REUSE: '1' });
    }
    const linuxVerify = namedStep(
      linux,
      'Verify every Linux package carries the exact preflight provenance bytes',
    );
    expect(linuxVerify.run).toContain('dpkg-deb --fsys-tarfile');
    expect(linuxVerify.run).toContain('rpm2cpio');
    expect(linuxVerify.run).toContain('--appimage-extract');
    expect(
      linuxVerify.run.match(/release-client-build-provenance\.mjs verify/g),
    ).toHaveLength(3);
    const linuxDependencies = linux.steps?.find(
      (step) =>
        typeof step.run === 'string' &&
        step.run.includes('sudo apt-get install -y'),
    );
    expect(linuxDependencies?.run).toContain('rpm2cpio cpio');

    const androidJob = workflowJob(release, 'android');
    const nativeBuild = namedStep(
      androidJob,
      'Build signed universal APK and AAB',
    );
    expect(nativeBuild.env).toMatchObject({ STATION_CLIENT_BUILD_REUSE: '1' });
    const androidVerify = namedStep(
      androidJob,
      'Verify Play-bound Android archives carry the exact preflight provenance bytes',
    );
    expect(
      androidVerify.run.match(
        /--expected src-desktop\/station-client-build\.json/g,
      ),
    ).toHaveLength(2);
    expect(stepIndex(androidJob, androidVerify.name as string)).toBeLessThan(
      stepIndex(androidJob, 'Upload to Play internal testing track'),
    );
  });

  it('binds TestFlight provenance to the ref authority checked before signing', () => {
    const delivery = workflowJob(testFlightDelivery, 'deliver');
    const source = namedStep(delivery, 'Reconfirm exact frozen source');
    const stage = namedStep(
      delivery,
      'Stage immutable iOS client provenance resource',
    );
    expect(source.run).toContain(
      'echo "AUTHORITY_REF=$source_ref" >> "$GITHUB_ENV"',
    );
    expect(stage.run).toBe(
      'STATION_BUILD_BRANCH="$AUTHORITY_REF" node scripts/write-ios-build-manifest.mjs',
    );
  });

  it('records the stable desktop timestamp as a verified common manifest, not an architecture-specific proxy', () => {
    const publishJob = workflowJob(publish, 'publish');
    const common = namedStep(
      publishJob,
      'Derive the common frozen desktop provenance only after all package gates',
    );
    expect(common.run).toContain(
      'cmp "$RUNNER_TEMP/station-client-build-aarch64.json" "$RUNNER_TEMP/station-client-build-x86_64.json"',
    );
    expect(common.run).toContain('station-desktop-common-client-build.json');
    const record = namedStep(
      publishJob,
      'Record the stable release in the deploy ledger',
    );
    expect(record.run).toContain(
      '--artifact-manifest "$RUNNER_TEMP/station-desktop-common-client-build.json"',
    );
    expect(record.run).not.toContain('station-client-build-aarch64.json');
  });
});

describe('nightly native product-version propagation', () => {
  it('passes the content-bound cohort version to each staged Tauri build', () => {
    const androidJob = workflowJob(nativeCohort, 'stage-android');
    const macosJob = workflowJob(nativeCohort, 'stage-macos');
    const tauriBuildSteps = [
      ...(androidJob.steps ?? []),
      ...(macosJob.steps ?? []),
    ].filter(
      (step) => !!step.run && /npx tauri(?: android)? build\b/.test(step.run),
    );
    expect(tauriBuildSteps).toHaveLength(2);
    expect(tauriBuildSteps[0].run).toContain('cohort-plan.json');
    expect(tauriBuildSteps[0].run).toContain('tauri android build --aab --apk');
    expect(tauriBuildSteps[1].run).toContain('cohort-plan.json');
    expect(tauriBuildSteps[1].run).toContain('tauri build --no-sign');
    expect(nativeCohort).toContain(
      'attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8',
    );
  });

  it('reserves one macOS deadline before setup and carries the cohort bundle version through notarization', () => {
    const macosJob = workflowJob(nativeCohort, 'stage-macos');
    const deadline = namedStep(
      macosJob,
      'Reserve one fixed macOS cleanup deadline',
    );
    expect(deadline.id).toBe('macos_cohort_deadline');
    expect(deadline.run).toContain('(120 * 60) - cleanup_reserve_seconds');
    const setup = stepIndex(
      macosJob,
      'Fail closed and build/sign/notarize macOS staging artifacts',
    );
    expect(
      stepIndex(macosJob, 'Reserve one fixed macOS cleanup deadline'),
    ).toBeLessThan(setup);
    const staging = namedStep(
      macosJob,
      'Fail closed and build/sign/notarize macOS staging artifacts',
    );
    const deadlineExpression =
      '$' + '{{ steps.macos_cohort_deadline.outputs.epoch }}';
    expect(
      staging.run.match(
        new RegExp(deadlineExpression.replace(/[${}]/g, '\\$&'), 'g'),
      ),
    ).toHaveLength(3);
    expect(staging.run).toContain('--build "$build"');
    expect(staging.run).toContain('Print :CFBundleVersion');
    expect(staging.run).toContain(')" = "$bundle_version"');
  });
});

type WorkflowStep = {
  uses?: string;
  name?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  'continue-on-error'?: boolean | string;
  env?: Record<string, unknown>;
};
type WorkflowJob = {
  steps?: WorkflowStep[];
  if?: string;
  needs?: string | string[];
  environment?: string;
  permissions?: Record<string, string>;
  env?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
};
type Workflow = {
  on?: unknown;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  permissions?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
};

function workflow(file: string): Workflow {
  return load(file) as Workflow;
}

function workflowJob(file: string, name: string): WorkflowJob {
  const job = workflow(file).jobs?.[name];
  if (!job) throw new Error(`Missing ${name} workflow job.`);
  return job;
}

function namedStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing ${name} workflow step.`);
  return step;
}

function stepIndex(job: WorkflowJob, name: string): number {
  const index = job.steps?.findIndex((candidate) => candidate.name === name);
  if (index === undefined || index < 0)
    throw new Error(`Missing ${name} workflow step.`);
  return index;
}

function expectStepOrder(job: WorkflowJob, names: string[]) {
  const indices = names.map((name) => stepIndex(job, name));
  expect(indices).toEqual([...indices].sort((left, right) => left - right));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeTauriConfigs(
  ...configs: ReadonlyArray<Record<string, unknown>>
): Record<string, unknown> {
  return configs.reduce<Record<string, unknown>>((merged, config) => {
    for (const [key, value] of Object.entries(config)) {
      const existing = merged[key];
      merged[key] =
        isPlainObject(existing) && isPlainObject(value)
          ? mergeTauriConfigs(existing, value)
          : value;
    }
    return merged;
  }, {});
}

function tauriConfig(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(root, 'src-desktop', name), 'utf8'));
}

function githubExpression(expression: string): string {
  return `\${{ ${expression} }}`;
}

describe('native release workflow topology', () => {
  it('requires an updater endpoint beside every updater public key in every workflow invocation', () => {
    const workflowDirectory = resolve(root, '.github/workflows');
    let publicKeyInvocations = 0;
    for (const filename of readdirSync(workflowDirectory).filter((name) =>
      /\.ya?ml$/.test(name),
    )) {
      const lines = readFileSync(
        resolve(workflowDirectory, filename),
        'utf8',
      ).split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes('scripts/lib/native-release-config.mjs'))
          continue;
        let invocation = lines[index].trim();
        while (invocation.endsWith('\\')) {
          index += 1;
          invocation += ` ${lines[index]?.trim() ?? ''}`;
        }
        if (!invocation.includes('--updater-public-key-file')) continue;
        publicKeyInvocations += 1;
        expect(invocation, filename).toContain('--updater-endpoint');
      }
    }
    expect(publicKeyInvocations).toBeGreaterThan(0);
  });

  it('binds every desktop build to the preflight-selected rolling updater channel', () => {
    const preflight = workflowJob(release, 'preflight');
    const source = namedStep(
      preflight,
      'Bind tag, package version, and source commit',
    );
    const sharedMapping =
      'node scripts/lib/native-release-config.mjs --tag "$RELEASE_TAG" --print-desktop-updater-tag';
    expect(source.run).toContain(`desktop_updater_tag=$(${sharedMapping})`);
    expect(source.run).toContain(
      'desktop_updater_endpoint=https://github.com/$' +
        '{GITHUB_REPOSITORY}/releases/download/$' +
        '{desktop_updater_tag}/latest.json',
    );

    for (const jobName of [
      'desktop-macos',
      'desktop-windows',
      'desktop-linux',
    ]) {
      const config = namedStep(
        workflowJob(release, jobName),
        'Fail closed and create tag-bound updater configuration',
      );
      expect(config.run).toContain('--updater-public-key-file');
      expect(config.run).toContain(
        `--updater-endpoint "${githubExpression('needs.preflight.outputs.desktop_updater_endpoint')}"`,
      );
    }

    const publishResolve = namedStep(
      workflowJob(publish, 'resolve'),
      'Resolve tag to one immutable commit',
    );
    expect(publishResolve.run).toContain(
      'desktop_updater_tag=$(node release-policy/scripts/lib/native-release-config.mjs --tag "$RELEASE_TAG" --print-desktop-updater-tag)',
    );
  });

  it('publishes only produced updater artifacts before the rolling manifest and verifies the remote result', () => {
    const promotion = workflowJob(publish, 'publish');
    const assembly = namedStep(
      promotion,
      'Assemble and validate the rolling desktop updater channel',
    );
    const publishStep = namedStep(
      promotion,
      'Publish and verify the rolling desktop updater channel',
    );
    expect(promotion.env?.DESKTOP_UPDATER_TAG).toBe(
      githubExpression('needs.resolve.outputs.desktop_updater_tag'),
    );
    expectStepOrder(promotion, [
      'Assemble and validate the rolling desktop updater channel',
      'Publish release and compensate to draft until feed verifies',
      'Publish and verify the rolling desktop updater channel',
      'Record the stable release in the deploy ledger',
    ]);

    for (const platform of [
      'darwin-aarch64',
      'darwin-x86_64',
      'windows-x86_64',
      'linux-x86_64',
    ])
      expect(assembly.run).toContain(`--platform ${platform}`);
    expect(assembly.run).not.toMatch(
      /--platform (?:windows|linux)-(?:aarch64|arm64)/,
    );
    expect(assembly.run).toContain('.app.tar.gz.sig');
    expect(assembly.run).toContain('.msi.zip.sig');
    expect(assembly.run).toContain('.AppImage.tar.gz.sig');
    expect(assembly.run).toContain('--asset-file');
    expect(assembly.run).toContain('--assert-not-regressing');
    expect(assembly.run).toMatch(
      /if \[\[ "\$ALLOW_UPDATER_POINTER_REGRESSION" == true \]\]; then\s+pointer_guard\+=\(--allow-regression\)\s+fi/,
    );
    expect(assembly.run.match(/--allow-regression/g)).toHaveLength(1);
    expect(assembly.run).toContain('mkdir -p updater-channel-assets');
    expect(assembly.run).toContain(
      'policy_script=release-policy/scripts/lib/tauri-updater-manifest.mjs',
    );
    expect(assembly.run).not.toContain(
      'node scripts/lib/tauri-updater-manifest.mjs',
    );
    expect(assembly.run).toContain('--verify');
    expect(publishStep.run).toContain('--verify');
    expect(publishStep.run).not.toContain(
      'node scripts/lib/tauri-updater-manifest.mjs',
    );
    expect(publishStep.run).toContain('cmp updater-channel-assets/latest.json');
    expect(publishStep.run).toContain('compensate_pointer');
    expect(publishStep.run).toContain('updater-channel-current/latest.json');
    expect(publishStep.run).toContain('gh release delete-asset');
    // The compensation window is the highest-risk sequence in the release
    // path, so pin it as an ordered CHAIN of line numbers rather than a pair
    // of `indexOf` offsets. `indexOf` returns -1 when a needle is absent and
    // -1 is less than any real offset, so a two-term `toBeLessThan` passes
    // when `trap - ERR` is DELETED — the exact bug it was written to catch —
    // and also when it is hoisted above `--verify`, which is strictly worse
    // (the pointer advances to an unverified manifest with no compensation).
    // Requiring every step to be found makes an absent line fail closed.
    const publishLines = publishStep.run.split('\n');
    const lineIndex = (needle: string) => {
      const index = publishLines.findIndex((line) => line.includes(needle));
      expect(index, `missing from the publish step: ${needle}`).toBeGreaterThan(
        -1,
      );
      return index;
    };
    const armed = lineIndex('trap compensate_pointer ERR');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell-array expansion asserted in the workflow source.
    const archives = lineIndex('"${updater_args[@]}"');
    const flagged = lineIndex('pointer_mutation_started=true');
    const pointerWrite = lineIndex('updater-channel-assets/latest.json');
    const verified = lineIndex('--verify');
    const disarmed = lineIndex('trap - ERR');
    const notes = lineIndex('gh release edit');
    // Arm before any upload; set the flag before the clobbering pointer write
    // so a death mid-`--clobber` is still compensable; verify before
    // disarming; and leave only the cosmetic notes edit outside the window.
    expect(armed).toBeLessThan(archives);
    expect(archives).toBeLessThan(flagged);
    expect(flagged).toBeLessThan(pointerWrite);
    expect(pointerWrite).toBeLessThan(verified);
    expect(verified).toBeLessThan(disarmed);
    expect(disarmed).toBeLessThan(notes);

    const uploadLines = publishStep.run
      .split('\n')
      .filter(
        (line) =>
          line.includes('gh release upload') &&
          !line.includes('updater-channel-current'),
      );
    expect(uploadLines).toHaveLength(2);
    expect(uploadLines[0]).toContain('"$' + '{updater_args[@]}"');
    expect(uploadLines[0]).not.toContain('latest.json');
    expect(uploadLines[1]).toContain('updater-channel-assets/latest.json');
  });

  it('probes the rolling release before public mutation and serializes all channel writers', () => {
    const parsed = workflow(publish);
    const resolve = workflowJob(publish, 'resolve');
    const promotion = workflowJob(publish, 'publish');
    const source = namedStep(resolve, 'Resolve tag to one immutable commit');
    expect(parsed.permissions).toEqual({ contents: 'read' });
    expect(source.run).toContain('gh release view "$desktop_updater_tag"');
    expect(source.run).not.toContain('2>/dev/null || true');
    expect(source.env?.ALLOW_PUBLISHED_POINTER_REPAIR).toBe(
      githubExpression('inputs.allow_published_pointer_repair'),
    );
    expect(source.run).toMatch(
      /tag_release_state" == false && "\$ALLOW_PUBLISHED_POINTER_REPAIR" == true/,
    );
    expect(source.run).toContain('ALLOW_EMPTY_UPDATER_CHANNEL_BOOTSTRAP');
    expect(source.run).toContain('has assets but no latest.json');
    expect(source.run).toContain('pointer_repair_only=true');
    expect(resolve.outputs?.pointer_repair_only).toBe(
      githubExpression('steps.source.outputs.pointer_repair_only'),
    );
    const pointerRepairGuard = githubExpression(
      "needs.resolve.outputs.pointer_repair_only != 'true'",
    );
    for (const stepName of [
      'Authenticate to GHCR with the ephemeral workflow token',
      'Promote only the recorded immutable GHCR digest',
      'Publish release and compensate to draft until feed verifies',
      'Mint the ledger push token',
      'Record the stable release in the deploy ledger',
    ])
      expect(namedStep(promotion, stepName).if).toBe(pointerRepairGuard);
    expect(
      namedStep(
        promotion,
        'Publish and verify the rolling desktop updater channel',
      ).if,
    ).toBeUndefined();
    expect(promotion.needs).toBe('resolve');
    expect(parsed.concurrency).toEqual({
      group: 'station-release-publish',
      'cancel-in-progress': false,
    });
    for (const jobName of ['resolve', 'publish']) {
      const checkout = namedStep(
        workflowJob(publish, jobName),
        'Check out default-branch release policy',
      );
      expect(checkout.with).toMatchObject({
        ref: githubExpression('github.event.repository.default_branch'),
        path: 'release-policy',
      });
    }
    expectStepOrder(promotion, [
      'Assemble and validate the rolling desktop updater channel',
      'Promote only the recorded immutable GHCR digest',
      'Publish release and compensate to draft until feed verifies',
    ]);
  });

  it('does not expose write or provider credentials to setup and install steps', () => {
    for (const [file, jobs] of [
      [release, ['assemble-draft']],
      [publish, ['resolve', 'publish', 'release-availability']],
    ] as const) {
      for (const name of jobs) {
        const job = workflowJob(file, name);
        expect(Object.keys(job.env ?? {}).join(',')).not.toMatch(
          /GH_TOKEN|GITHUB_TOKEN|NATIVE_APP_UPDATE_PUBLISH_TOKEN|TAURI_SIGNING_PUBLIC_KEY/,
        );
        for (const step of job.steps ?? []) {
          if (
            step.run === 'npm run dependencies:ci' ||
            step.uses?.includes('setup-node')
          )
            expect(Object.keys(step.env ?? {}).join(',')).not.toMatch(
              /GH_TOKEN|GITHUB_TOKEN|NATIVE_APP_UPDATE_PUBLISH_TOKEN|TAURI_SIGNING_PUBLIC_KEY/,
            );
        }
      }
    }
  });

  it('runs the pinned lockfile-only production npm producer after a clean install', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'station-npm-sbom-probe-'));
    try {
      const output = resolve(directory, 'npm.cdx.json');
      execFileSync(
        resolve(root, 'node_modules/.bin/cyclonedx-npm'),
        [
          '--package-lock-only',
          '--omit',
          'dev',
          '--ignore-npm-errors',
          '--output-file',
          output,
        ],
        { cwd: root, stdio: 'pipe', timeout: 30_000 },
      );
      const inventory = JSON.parse(readFileSync(output, 'utf8'));
      expect(inventory.specVersion).toBe('1.6');
      expect(inventory.components.length).toBeGreaterThan(0);
      expect(
        inventory.components.some(
          (entry: any) => entry.name === '@cyclonedx/cyclonedx-npm',
        ),
      ).toBe(false);
      expect(
        inventory.components.some(
          (entry: any) => entry.purl === 'pkg:npm/%40kontourai/conduit@0.6.0',
        ),
      ).toBe(true);
      // Read from the workspace manifest rather than restated: release-please
      // bumps this version on its own schedule, and a hardcoded copy makes
      // every release break a test that is really asserting "the SBOM lists
      // our workspace package", not "it is at 0.5.0".
      const sharedVersion = JSON.parse(
        readFileSync('packages/shared/package.json', 'utf8'),
      ).version as string;
      const sharedPurl = `pkg:npm/%40kontourai/station-shared@${sharedVersion}`;
      expect(inventory.components).toContainEqual(
        expect.objectContaining({
          group: '@kontourai',
          name: 'station-shared',
          purl: sharedPurl,
        }),
      );
      expect(cyclonedxComponents(inventory, 'npm')).toContainEqual(
        expect.objectContaining({
          name: '@kontourai/station-shared',
          purl: sharedPurl,
        }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('makes the tag workflow the sole draft owner and the manual workflow the sole publisher', () => {
    expect(workflow(release).on).toEqual({ push: { tags: ['v*'] } });
    // Persistent runners only execute reviewed manual dispatches or protected
    // main pushes. The Android verification lane must never gain tag/release
    // triggers — pin the full topology exactly.
    expect(workflow(android).on).toEqual({
      workflow_dispatch: null,
      push: {
        branches: ['main'],
        paths: [
          '.github/workflows/build-android.yml',
          'src-desktop/**',
          'scripts/check-android-16kb-alignment.mjs',
          'scripts/read-android-build-provenance.mjs',
          'scripts/reclaim-android-runner-disk.sh',
          'scripts/resolve-android-build-run.mjs',
          'scripts/write-android-build-manifest.mjs',
          'scripts/lib/android-build-manifest.mjs',
          'scripts/lib/desktop-build-manifest.mjs',
          'package.json',
          'package-lock.json',
        ],
      },
    });
    expect(release).toContain('assemble-draft:');
    expect(release).toContain('gh release create');
    expect(release).not.toContain('gh release edit');
    expect(release).not.toContain('softprops/action-gh-release');
    expect(publish).toContain('workflow_dispatch:');
    expect(publish).toContain('environment: native-release-publish');
    expect(mobileFeedTransaction).toContain('gh release edit');
    expect(publish).toContain('validate --assets-dir release-assets');
  });

  it('admits draft and promotion effects only after pinned SBOM generation and predicate validation', () => {
    const container = workflowJob(release, 'container');
    const assemble = workflowJob(release, 'assemble-draft');
    const promotion = workflowJob(publish, 'publish');
    expect(container.needs).toEqual(['preflight', 'full-regression']);
    expect(container.permissions).toMatchObject({
      attestations: 'write',
      'id-token': 'write',
      packages: 'write',
    });
    expect(
      namedStep(
        container,
        'Scan immutable linux/amd64 image digest with pinned Syft',
      ),
    ).toMatchObject({
      uses: ANCHORE_SBOM_ACTION,
      with: {
        format: 'cyclonedx-json',
        image:
          'ghcr.io/$' +
          '{{ github.repository }}@$' +
          '{{ steps.platforms.outputs.amd64 }}',
        'syft-version': 'v1.51.0',
        'upload-artifact': false,
        'upload-release-assets': false,
      },
    });
    expect(
      namedStep(
        container,
        'Scan immutable linux/arm64 image digest with pinned Syft',
      ),
    ).toMatchObject({
      uses: ANCHORE_SBOM_ACTION,
      with: {
        image:
          'ghcr.io/$' +
          '{{ github.repository }}@$' +
          '{{ steps.platforms.outputs.arm64 }}',
      },
    });
    for (const name of [
      'Scan immutable linux/amd64 image digest with pinned Syft',
      'Scan immutable linux/arm64 image digest with pinned Syft',
    ])
      expect(Object.keys(namedStep(container, name).with ?? {}).sort()).toEqual(
        [
          'format',
          'image',
          'output-file',
          'syft-version',
          'upload-artifact',
          'upload-release-assets',
        ],
      );
    expect(release).toContain('syft-version: v1.51.0');
    expect(release).not.toContain('syft-version: 1.51.0');
    expectStepOrder(container, [
      'Create immutable container release descriptor',
      'Resolve exact immutable platform digests from the manifest list',
      'Scan immutable linux/amd64 image digest with pinned Syft',
      'Scan immutable linux/arm64 image digest with pinned Syft',
      'Bind the scanner inventory to the immutable release descriptor',
      'Transfer scanner inventory through scratch only',
    ]);
    expect(
      namedStep(
        container,
        'Bind the scanner inventory to the immutable release descriptor',
      ).run,
    ).toContain('release-container-sbom-source.mjs');
    expect(assemble.needs).toContain('container');
    expect(assemble.environment).toBe('native-release');
    expectStepOrder(assemble, [
      'Download producing release assets into scratch',
      'Admit only producer release assets, never scanner scratch',
      'Download the descriptor-bound scanner inventory into scratch',
      'Generate canonical SBOM fragments and assets',
      'Assemble and validate one deterministic inventory',
      'Attest the inventory and checksum protocol roots',
      'Create exactly one draft and upload validated assets',
    ]);
    expect(
      namedStep(assemble, 'Generate canonical SBOM fragments and assets').run,
    ).toContain('release-sbom-fragments.mjs');
    expect(
      namedStep(assemble, 'Generate canonical SBOM fragments and assets').run,
    ).toContain(
      '--container-source "$RUNNER_TEMP/station-container-sbom-source/station-container-source.json"',
    );
    expect(
      namedStep(assemble, 'Assemble and validate one deterministic inventory')
        .run,
    ).toContain('release-sbom-predicates.mjs --assets-dir release-assets');
    expect(
      namedStep(assemble, 'Assemble and validate one deterministic inventory')
        .run,
    ).toContain(
      '--sbom-context "$RUNNER_TEMP/station-release-sbom-fragments/context.json"',
    );
    expect(
      namedStep(
        assemble,
        'Create exactly one draft and upload validated assets',
      ).run,
    ).toContain('gh release create');
    expect(promotion.environment).toBe('native-release-publish');
    expectStepOrder(promotion, [
      'Download and revalidate every staged release asset',
      'Verify GitHub provenance for every downloaded asset',
      'Assemble and validate the rolling desktop updater channel',
      'Promote only the recorded immutable GHCR digest',
    ]);
    const installIndex = promotion.steps?.findIndex(
      (step) => step.run === 'npm run dependencies:ci',
    );
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(installIndex).toBeLessThan(
      stepIndex(
        promotion,
        'Download and revalidate every staged release asset',
      ),
    );
    expect(
      namedStep(promotion, 'Download and revalidate every staged release asset')
        .run,
    ).toContain('release-sbom-predicates.mjs --assets-dir release-assets');
    expect(
      namedStep(
        promotion,
        'Verify GitHub provenance for every downloaded asset',
      ).run,
    ).toContain('gh attestation verify');
  });

  it('builds every desktop target through pinned tauri-action v1 without release mutation', () => {
    expect(release).toContain(
      'tauri-apps/tauri-action@1deb371b0cd8bd54025b384f1cd735e725c4060f',
    );
    expect(release).toContain('macos-15');
    expect(release).toContain('macos-15-intel');
    expect(release).toContain('windows-latest');
    expect(release).toContain('ubuntu-22.04');
    expect(release).toContain('desktop-macos:');
    expect(release).toContain('desktop-windows:');
    expect(release).toContain('desktop-linux:');
    expect(release).not.toContain('release-credentials:');
    expect(release).not.toContain('releaseDraft:');
    expect(release).not.toContain('releaseName:');
  });

  it('seals embedded macOS code before API-key notarization and derives every release asset afterwards', () => {
    const macos = workflowJob(release, 'desktop-macos');
    expectStepOrder(macos, [
      'Reserve macOS release cleanup window',
      'Build an unsigned macOS staging candidate',
      'Seal, notarize, and derive canonical macOS artifacts',
    ]);
    expect(macos['timeout-minutes']).toBe(120);
    expect(
      namedStep(macos, 'Reserve macOS release cleanup window').run,
    ).toContain('105 * 60');
    const gate = namedStep(
      macos,
      'Fail closed and create tag-bound updater configuration',
    );
    expect(gate.run).toContain(
      'APPLE_API_KEY_ID APPLE_API_ISSUER_ID APPLE_API_PRIVATE_KEY',
    );
    expect(gate.run).not.toContain('APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID');
    const seal = namedStep(
      macos,
      'Seal, notarize, and derive canonical macOS artifacts',
    );
    expect(seal.run).toContain('macos-notarized-artifacts.mjs');
    expect(seal.run).toContain('macos-signing-readiness.mjs unlock');
    expect(seal.run).toContain('macos-signing-readiness.mjs probe');
    expect(seal.run.indexOf('macos-signing-readiness.mjs unlock')).toBeLessThan(
      seal.run.indexOf('macos-notarized-artifacts.mjs'),
    );
    expect(seal.run).toContain('station-notary-api-key.p8');
    expect(seal.run).toContain('app_candidates=()');
    expect(seal.run).toContain(
      'done < <(find "src-desktop/target/$' +
        "{{ matrix.target }}/release/bundle/macos\" -maxdepth 1 -type d -name '*.app' -print0)",
    );
    expect(seal.run).toContain("while IFS= read -r -d '' app_candidate; do");
    expect(seal.run).toContain('app_candidates+=("$app_candidate")');
    expect(seal.run).toContain('test "$' + '{#app_candidates[@]}" -eq 1');
    expect(seal.run).toContain('app="$' + '{app_candidates[0]}"');
    expect(seal.run).not.toContain('-print -quit');
    expect(seal.run).toContain('macos-notarized-artifacts.mjs --app "$app"');
    expect(seal.run).toContain(
      `--deadline-epoch "\${{ steps.macos_release_deadline.outputs.epoch }}"`,
    );
    expect(seal.env).toMatchObject({
      APPLE_API_KEY_ID: `\${{ secrets.APPLE_API_KEY_ID }}`,
      APPLE_API_ISSUER_ID: `\${{ secrets.APPLE_API_ISSUER_ID }}`,
      APPLE_API_PRIVATE_KEY: `\${{ secrets.APPLE_API_PRIVATE_KEY }}`,
    });
    expect(
      namedStep(macos, 'Build an unsigned macOS staging candidate').run,
    ).toContain('--no-sign');
    expect(
      namedStep(macos, 'Build an unsigned macOS staging candidate').env,
    ).toMatchObject({ STATION_CLIENT_BUILD_REUSE: '1' });
    const stagedProvenance = namedStep(
      macos,
      'Stage the preflight-bound native client provenance bytes',
    );
    expect(stagedProvenance.run).toContain(
      'release-client-build-provenance.mjs stage',
    );
    expect(seal.run).toContain('release-client-build-provenance.mjs verify');
    expect(seal.run).toContain(
      '--expected src-desktop/station-client-build.json',
    );
    const embeddedSealing = macosArtifacts.indexOf(
      'await sealEmbeddedMacosMachOBounded(app, identity, {',
    );
    expect(embeddedSealing).toBeGreaterThan(-1);
    expect(embeddedSealing).toBeLessThan(
      macosArtifacts.indexOf('const outerSigningArgs = ['),
    );
    expect(embeddedSealing).toBeLessThan(
      macosArtifacts.indexOf(
        'await submit(command, zip, key, keyId, issuer, logger);',
      ),
    );
    expect(macosArtifacts).toContain("receipt.status !== 'Accepted'");
    expect(macosArtifacts).toContain(
      'fs.rmSync(root, { recursive: true, force: true })',
    );
    expect(macosArtifacts).toContain("'DMG staple validation'");
    expect(macosArtifacts).toContain("'updater archive derivation'");
    expect(macosArtifacts).toContain('runBoundedCommand');
    expect(release).toContain('Cleanup macOS Developer ID keychain');
  });

  it('admits exactly one relative macOS app discovered by the release workflow', () => {
    const directory = mkdtempSync(
      resolve(tmpdir(), 'station-macos-discovery-'),
    );
    const bundleRoot = resolve(
      directory,
      'src-desktop/target/aarch64-apple-darwin/release/bundle/macos',
    );
    const macos = workflowJob(release, 'desktop-macos');
    const seal = namedStep(
      macos,
      'Seal, notarize, and derive canonical macOS artifacts',
    );
    const discovery = seal.run
      .slice(seal.run.indexOf('app_candidates=()'))
      .split('printf \'%s\' "$APPLE_API_PRIVATE_KEY"')[0]
      .replace('$' + '{{ matrix.target }}', 'aarch64-apple-darwin');
    const runDiscovery = () =>
      execFileSync(
        '/bin/bash',
        ['-e', '-c', `${discovery}\nprintf '%s' "$app"`],
        { cwd: directory, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
      );
    try {
      mkdirSync(resolve(bundleRoot, 'Station.app'), { recursive: true });
      expect(runDiscovery()).toBe(
        'src-desktop/target/aarch64-apple-darwin/release/bundle/macos/Station.app',
      );
      mkdirSync(resolve(bundleRoot, 'Unexpected.app'));
      expect(runDiscovery).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('builds deb and rpm before the signed AppImage overlay without post-sign mutation', () => {
    const betaConfig = githubExpression(
      "needs.preflight.outputs.beta_desktop_config && format('--config {0}', needs.preflight.outputs.beta_desktop_config)",
    );
    const debAndRpm =
      'args: --target x86_64-unknown-linux-gnu --bundles deb,rpm ' +
      betaConfig +
      ` --config ${githubExpression('runner.temp')}/tauri.version.conf.json`;
    const appImage =
      'args: --target x86_64-unknown-linux-gnu --bundles appimage ' +
      betaConfig +
      ` --config src-desktop/tauri.linux-appimage.conf.json --config ${githubExpression('runner.temp')}/tauri.release.conf.json`;
    expect(release).toContain(
      'node scripts/lib/native-release-config.mjs --tag "$RELEASE_TAG" --channel-identity --output "$RUNNER_TEMP/tauri.version.conf.json"',
    );
    expect(release.indexOf(debAndRpm)).toBeGreaterThanOrEqual(0);
    expect(release.indexOf(appImage)).toBeGreaterThan(
      release.indexOf(debAndRpm),
    );
    expect(release).not.toContain('STATION_APPIMAGE_RUNTIME_STAGING');
    expect(
      release.indexOf('Stage canonical signed Linux artifacts'),
    ).toBeGreaterThan(release.indexOf(appImage));
    expect(release).not.toContain('appimage-tool');
    expect(release).not.toContain('appimagetool');
  });

  it('keeps updater mode aligned with the archive assets staged for every desktop', () => {
    const effectiveReleaseConfig = createNativeReleaseConfig({
      tag: 'v0.1.0',
      updaterPublicKey: 'test-public-key',
      updaterEndpoint:
        'https://github.com/kontourai/station/releases/download/stable-desktop/latest.json',
    });
    expect(effectiveReleaseConfig.bundle?.createUpdaterArtifacts).toBe(
      NATIVE_UPDATER_ARTIFACT_MODE,
    );
    expect(NATIVE_UPDATER_ARTIFACT_MODE).toBe('v1Compatible');
    expect(effectiveReleaseConfig.plugins?.updater?.endpoints).toEqual([
      'https://github.com/kontourai/station/releases/download/stable-desktop/latest.json',
    ]);
    expect(macosArtifacts).toContain(
      'Tauri updater signer did not produce a signature',
    );
    expect(release).toContain('*.msi.zip.sig');
    expect(release).toContain('*.AppImage.tar.gz.sig');
    expect(release).not.toContain('*.AppImage.sig');
  });

  it('keeps unsigned builds as verification-only and gates every distributable signing path', () => {
    expect(android).not.toContain('refs/tags/');
    expect(android).not.toContain('gh release');
    expect(android).not.toContain('sed -i');
    expect(android).toContain('station-android-unsigned-verification');
    expect(release).toContain('TAURI_SIGNING_PUBLIC_KEY');
    expect(release).toContain('native-release-config.mjs');
    expect(release).toContain('environment: native-release');
    expect(release).toContain('ios-simulator:');
    expect(release).toContain('--no-sign');
    expect(release).toContain('ios-device:');
    expect(testFlightDelivery).toContain('APPLE_PROVISIONING_PROFILE_BASE64');
    expect(testFlightDelivery).toContain(
      'npx tauri ios build --export-method app-store-connect',
    );
    expect(release).not.toContain('--export-method release-testing');
    expect(testFlightDelivery).toContain(
      'node scripts/check-ios-store-profile.mjs --station "$profile" --label APPLE_PROVISIONING_PROFILE_BASE64',
    );
    expect(testFlightDelivery).toContain(
      'MobileDevice/Provisioning Profiles/$profile_uuid.mobileprovision',
    );
    expect(testFlightDelivery).not.toContain(
      'MobileDevice/Provisioning Profiles/station.mobileprovision',
    );
    expect(testFlightDelivery).toContain(
      'node scripts/check-ios-store-profile.mjs --station "$app/embedded.mobileprovision" --label \'exported IPA embedded.mobileprovision\'',
    );
    expect(release).toContain('APPLE_DEVELOPER_ID_CERTIFICATE_BASE64');
    expect(release).toContain('Get-AuthenticodeSignature');
    expect(release).toContain(
      '--config $' + '{{ runner.temp }}/tauri.windows.release.conf.json',
    );
    expect(macosArtifacts).toContain(
      "['--verify', '--deep', '--strict', '--verbose=2', app]",
    );
    expect(release).toContain(
      'codesign -d --verbose=4 "$app" 2>&1 | grep -F \'flags=0x10000(runtime)\'',
    );
    const stableMacos = tauriConfig('tauri.conf.json').bundle as Record<
      string,
      Record<string, unknown>
    >;
    expect(stableMacos.macOS.hardenedRuntime).toBe(true);
    expect(testFlightDelivery).toContain('embedded.mobileprovision');
    expect(macosArtifacts).toContain("'DMG staple validation'");
    expect(release).toContain('apksigner verify');
    expect(release).toContain('station-ios-simulator-verification');
  });

  it('uses checked-in mobile configs and removes the legacy post-publish manifest mutation', () => {
    expect(
      readFileSync(
        resolve(root, 'src-desktop/tauri.android.conf.json'),
        'utf8',
      ),
    ).toContain('minSdkVersion');
    expect(
      readFileSync(resolve(root, 'src-desktop/tauri.ios.conf.json'), 'utf8'),
    ).toContain('minimumSystemVersion');
    expect(() =>
      readFileSync(resolve(root, '.github/workflows/update-manifest.yml')),
    ).toThrow();
    expect(release).toContain('npm run build:native-client');
    expect(release).not.toContain(
      'npm run build:sdk && npm run build:connect && npm run build:desktop:resources',
    );
  });

  it('preserves immutable container provenance and refuses release asset replacement', () => {
    expect(release).toContain('docker/setup-qemu-action@');
    expect(release).toContain(
      'labels: $' + '{{ steps.metadata.outputs.labels }}',
    );
    expect(release).toContain('STATION_RELEASE_SHA=');
    expect(release).toContain('subject-digest:');
    expect(release).not.toContain('--clobber');
    expect(publish).toContain('gh release download "$RELEASE_TAG"');
    expect(publish).toContain("--pattern '*'");
    expect(release).toContain('station-container-release.json');
    expect(publish).toContain('test "$resolved" = "$digest"');
    expect(publish).toContain('"$image@$digest"');
    expect(publish).toContain('group: station-release-publish');
  });

  it('binds every native build to the authoritative package version', () => {
    expect(release).toContain('--check-package-json package.json');
    expect(release).toContain('--tag "$RELEASE_TAG"');
    expect(release).toContain('Print :CFBundleShortVersionString');
    expect(release).toContain("versionName='$RELEASE_VERSION'");
    expect(release).toContain('MSI filename does not carry release version');
  });

  it('routes preview tags to the beta desktop and Android package while iOS stays stable', () => {
    expect(release).toContain(
      'beta_desktop_config=src-desktop/tauri.beta.conf.json',
    );
    expect(release).toContain('beta_desktop_config=');
    expect(release).toContain('android_package=io.kontourai.station.beta');
    expect(release).toContain("android_product_name='Station Beta'");
    expect(release).toContain('android_product_name=Station');
    expect(release).toContain('--channel-identity');
    expect(release).toContain("package: name='$ANDROID_PACKAGE_NAME'");
    expect(release).toContain("application-label:'$ANDROID_PRODUCT_NAME'");
    expect(release).toContain(
      `packageName: ${githubExpression('needs.preflight.outputs.android_package')}`,
    );
    expect(release).toContain("needs.preflight.outputs.channel == 'stable'");
    expect(release).not.toContain(
      'ios build --export-method app-store-connect --channel-identity',
    );
    expect(release).toContain('icon_channel=stable');
    expect(release).toContain('icon_channel=beta');
    expect(release).toContain(
      'node scripts/apply-android-channel-icons.mjs "$icon_channel"',
    );
  });

  it('authenticates Play uploads with short-lived GitHub OIDC credentials', () => {
    const android = release.slice(
      release.indexOf('\n  android:'),
      release.indexOf('\n  ios-simulator:'),
    );
    expect(android).toContain('id-token: write');
    expect(android).toContain(
      'google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093',
    );
    expect(android).toContain(
      'google-github-actions/get-secretmanager-secrets@bc9c54b29fdffb8a47776820a7d26e77b379d262',
    );
    expect(android).toContain(
      'serviceAccountJson: $' +
        '{{ steps.google_auth.outputs.credentials_file_path }}',
    );
    expect(android).not.toContain('PLAY_SERVICE_ACCOUNT_JSON');
    expect(android).not.toContain('serviceAccountJsonPlainText');
    expect(android).not.toContain('secrets.ANDROID_KEYSTORE');
  });

  it('keeps the base implicit and merges channel and tag overlays in dependency order', () => {
    const betaConfig = githubExpression(
      "needs.preflight.outputs.beta_desktop_config && format('--config {0}', needs.preflight.outputs.beta_desktop_config)",
    );
    const tagConfig = `${githubExpression('runner.temp')}/tauri.release.conf.json`;
    const versionConfig = `${githubExpression('runner.temp')}/tauri.version.conf.json`;
    const betaConfigArray = '$' + '{beta_config[@]}';

    expect(release).not.toContain('--config src-desktop/tauri.conf.json');
    expect(release).toContain(
      `npx tauri build --no-sign --target ${githubExpression('matrix.target')} ${betaConfig} --config ${tagConfig}`,
    );
    expect(release).toContain(
      `args: --target x86_64-pc-windows-msvc ${betaConfig} --config ${githubExpression('runner.temp')}/tauri.windows.release.conf.json --config ${tagConfig}`,
    );
    expect(release).toContain(
      `args: --target x86_64-unknown-linux-gnu --bundles deb,rpm ${betaConfig} --config ${versionConfig}`,
    );
    expect(release).toContain(
      `args: --target x86_64-unknown-linux-gnu --bundles appimage ${betaConfig} --config src-desktop/tauri.linux-appimage.conf.json --config ${tagConfig}`,
    );
    expect(release).toContain(
      `npx tauri android init --ci --skip-targets-install "${betaConfigArray}" --config "$RUNNER_TEMP/tauri.release.conf.json"`,
    );
    expect(release).toContain(
      `npx tauri android build --apk --aab "${betaConfigArray}" --config "$RUNNER_TEMP/tauri.release.conf.json"`,
    );

    const base = tauriConfig('tauri.conf.json');
    const beta = tauriConfig('tauri.beta.conf.json');
    const appImage = tauriConfig('tauri.linux-appimage.conf.json');
    const stableTag = createNativeReleaseConfig({
      tag: 'v2.3.4',
      channelIdentity: true,
    });
    const betaTag = createNativeReleaseConfig({
      tag: 'v2.3.4-preview.5',
      channelIdentity: true,
    });
    const stable = mergeTauriConfigs(base, stableTag);
    const previewAppImage = mergeTauriConfigs(base, beta, appImage, betaTag);

    expect(stable.version).toBe('2.3.4');
    expect(stable.identifier).toBe('io.kontourai.station');
    expect(stable.productName).toBe('Station');
    expect((stable.build as Record<string, unknown>).beforeBuildCommand).toBe(
      'npm run build:native-client',
    );
    expect(previewAppImage.version).toBe('2.3.4-preview.5');
    expect(previewAppImage.identifier).toBe('io.kontourai.station.beta');
    expect(previewAppImage.productName).toBe('Station Beta');
    expect(
      (previewAppImage.build as Record<string, unknown>).beforeBuildCommand,
    ).toBe('npm run build:desktop:resources');
  });

  it('attests each producing lane and verifies all draft assets before publish', () => {
    expect(
      (
        (release + testFlightDelivery).match(
          /subject-path: release-assets\/\*/g,
        ) ?? []
      ).length,
    ).toBeGreaterThanOrEqual(7);
    expect(release).toContain(
      'Attest the inventory and checksum protocol roots',
    );
    expect(publish).toContain('for asset in release-assets/*');
    expect(publish).toContain('gh attestation verify "$asset"');
    expect(publish).toContain('--deny-self-hosted-runners');
  });

  it('executes checksum verification relative to the asset directory', () => {
    const directory = mkdtempSync(
      resolve(tmpdir(), 'station-release-checksums-'),
    );
    const archive = Buffer.from('portable');
    const payload = Buffer.from('payload');
    writeFileSync(resolve(directory, 'station-portable.tar.gz'), archive);
    writeFileSync(resolve(directory, 'payload.bin'), payload);
    const archiveDigest = createHash('sha256').update(archive).digest('hex');
    const payloadDigest = createHash('sha256').update(payload).digest('hex');
    writeFileSync(
      resolve(directory, 'station-portable.tar.gz.sha256'),
      `${archiveDigest}  station-portable.tar.gz\n`,
    );
    writeFileSync(
      resolve(directory, 'station-release-checksums.txt'),
      `${payloadDigest}  payload.bin\n`,
    );
    const verifier = resolve(root, 'scripts/verify-release-checksums.sh');
    chmodSync(verifier, 0o755);
    expect(() => execFileSync(verifier, [directory])).not.toThrow();
    writeFileSync(resolve(directory, 'payload.bin'), 'tampered');
    expect(() =>
      execFileSync(verifier, [directory], { stdio: 'pipe' }),
    ).toThrow();
  });
});

const reclaimScript = resolve(root, 'scripts/reclaim-android-runner-disk.sh');

// A reclaim step is identified by its run line invoking the script, not by
// fragile whole-file indexOf over raw YAML text.
const isReclaimStep = (s: WorkflowStep) =>
  !!s.run && s.run.includes('reclaim-android-runner-disk.sh');
const usesAction = (substr: string) => (s: WorkflowStep) =>
  !!s.uses && s.uses.includes(substr);

describe('android runner disk reclaim', () => {
  it('is wired into exactly the two Android build jobs, after all setup and immediately before the pre-build report', () => {
    // #1363: the four-target Android Rust build exhausted hosted-runner disk.
    // The reclaim step must run as late as safely possible — after every
    // setup/preparation step (Rust/Java toolchain, setup-android SDK/NDK
    // install, sdkmanager, npm build, and in the release lane the native
    // config + tauri android init) — and immediately before the pre-build
    // disk report / Android build. This makes the script's post-reclaim
    // 10 GiB threshold the actual pre-build gate instead of a check that can
    // pass early and drift below the floor by cargo time. Proven by walking
    // the parsed YAML step arrays, not raw-text indexOf.
    const androidParsed = workflow(android);
    const releaseParsed = workflow(release);

    // build-android.yml: the single job must carry exactly one reclaim step.
    const androidJob = androidParsed.jobs?.['build-android-verification'];
    expect(
      androidJob?.steps,
      'build-android-verification job has no steps',
    ).toBeDefined();
    for (const [jobName, job] of Object.entries(androidParsed.jobs ?? {})) {
      const reclaimCount = (job.steps ?? []).filter(isReclaimStep).length;
      const expected = jobName === 'build-android-verification' ? 1 : 0;
      expect(
        reclaimCount,
        `build-android.yml: expected exactly ${expected} reclaim step(s) in '${jobName}', found ${reclaimCount}`,
      ).toBe(expected);
    }

    // release.yml: reclaim must live in exactly one step of the `android` job
    // and nowhere else.
    for (const [jobName, job] of Object.entries(releaseParsed.jobs ?? {})) {
      const reclaimCount = (job.steps ?? []).filter(isReclaimStep).length;
      const expected = jobName === 'android' ? 1 : 0;
      expect(
        reclaimCount,
        `release.yml: expected exactly ${expected} reclaim step(s) in '${jobName}', found ${reclaimCount}`,
      ).toBe(expected);
    }

    // Ordering within each reclaim-bearing job: after every setup/preparation
    // step, immediately before the pre-build disk report and the Android build.
    const isPreBuildReport = (s: WorkflowStep) =>
      !!s.name && /disk headroom before/i.test(s.name);
    const isAndroidBuild = (s: WorkflowStep) =>
      !!s.run && s.run.includes('tauri android build');
    // The Android project must be initialized before reclaim: `tauri android
    // init` generates src-desktop/gen/android, and reclaim only frees unused
    // hosted toolchains — running init after reclaim needlessly risks ENOSPC
    // mid-init and hides the real pre-build headroom. Both Android jobs must
    // carry a dedicated init step (not an init folded into the build run).
    const isAndroidInit = (s: WorkflowStep) =>
      !!s.run && s.run.includes('tauri android init');
    const isSdkmanager = (s: WorkflowStep) =>
      !!s.run && s.run.includes('sdkmanager');
    const isNpmBuild = (s: WorkflowStep) =>
      !!s.run && /npm run dependencies:ci/.test(s.run);
    const preparationFinders: Array<[string, (s: WorkflowStep) => boolean]> = [
      ['rust-toolchain', usesAction('dtolnay/rust-toolchain@')],
      ['setup-java', usesAction('actions/setup-java@')],
      ['setup-android', usesAction('android-actions/setup-android@')],
      ['sdkmanager', isSdkmanager],
      ['npm build', isNpmBuild],
      ['tauri android init', isAndroidInit],
    ];
    for (const steps of [
      androidJob?.steps ?? [],
      releaseParsed.jobs?.android?.steps ?? [],
    ]) {
      const reclaimIdx = steps.findIndex(isReclaimStep);
      expect(
        reclaimIdx,
        'reclaim step missing from job',
      ).toBeGreaterThanOrEqual(0);

      // Reclaim must follow every setup/preparation step in the job.
      for (const [label, finder] of preparationFinders) {
        const idx = steps.findIndex(finder);
        expect(idx, `${label} step missing`).toBeGreaterThanOrEqual(0);
        expect(reclaimIdx, `reclaim must run after ${label}`).toBeGreaterThan(
          idx,
        );
      }

      // Reclaim is the step immediately before the pre-build disk report, so
      // its post-reclaim threshold is the actual pre-build gate.
      const preBuildReportIdx = steps.findIndex(isPreBuildReport);
      const buildIdx = steps.findIndex(isAndroidBuild);
      expect(
        preBuildReportIdx,
        'pre-build disk report missing',
      ).toBeGreaterThanOrEqual(0);
      expect(buildIdx, 'Android build step missing').toBeGreaterThanOrEqual(0);
      expect(
        reclaimIdx,
        'reclaim must be the step immediately before the pre-build report',
      ).toBe(preBuildReportIdx - 1);
      expect(
        preBuildReportIdx,
        'pre-build report must be the step immediately before the Android build',
      ).toBe(buildIdx - 1);
    }
  });

  it('reports disk headroom before and after the Android build in both jobs', () => {
    // #1363 telemetry: the authoritative hosted run must reveal after-reclaim
    // (printed by the reclaim script), pre-build, and post-build/failure
    // headroom. The pre/post-build reports bracket the build step in both the
    // verification (build-android.yml) and release (release.yml) Android jobs.
    const androidParsed = workflow(android);
    const releaseParsed = workflow(release);
    const isAndroidBuild = (s: WorkflowStep) =>
      !!s.run && s.run.includes('tauri android build');
    const isPreBuildReport = (s: WorkflowStep) =>
      !!s.name && /disk headroom before/i.test(s.name);
    const isPostBuildReport = (s: WorkflowStep) =>
      !!s.name && /disk headroom after/i.test(s.name);

    const cases: Array<[string, WorkflowStep[]]> = [
      [
        'build-android.yml',
        androidParsed.jobs?.['build-android-verification']?.steps ?? [],
      ],
      ['release.yml', releaseParsed.jobs?.android?.steps ?? []],
    ];

    for (const [wfName, steps] of cases) {
      const preReports = steps.filter(isPreBuildReport);
      const postReports = steps.filter(isPostBuildReport);
      expect(
        preReports,
        `${wfName}: expected exactly one pre-build disk report`,
      ).toHaveLength(1);
      expect(
        postReports,
        `${wfName}: expected exactly one post-build disk report`,
      ).toHaveLength(1);

      const preReportIdx = steps.findIndex(isPreBuildReport);
      const buildIdx = steps.findIndex(isAndroidBuild);
      const postReportIdx = steps.findIndex(isPostBuildReport);
      expect(
        buildIdx,
        `${wfName}: Android build step missing`,
      ).toBeGreaterThanOrEqual(0);
      // Ordering: pre-build report strictly before the build, post-build
      // report strictly after — so the hosted log brackets the build.
      expect(
        preReportIdx,
        `${wfName}: pre-build report must precede the build`,
      ).toBeLessThan(buildIdx);
      expect(
        postReportIdx,
        `${wfName}: post-build report must follow the build`,
      ).toBeGreaterThan(buildIdx);

      // The post-build report must run even when the build failed, without
      // weakening failure propagation (it is a pure df observation).
      expect(
        steps[postReportIdx]?.if,
        `${wfName}: post-build report must use if: always()`,
      ).toMatch(/always\(\)/);
      // It must be fully observational: continue-on-error keeps a df failure
      // from coloring the job red on the always() path, and the command is
      // exactly `df -h /` — anything richer could mutate runner state or mask
      // a real failure when it runs unconditionally.
      expect(
        String(steps[postReportIdx]?.['continue-on-error']),
        `${wfName}: post-build report must set continue-on-error: true`,
      ).toBe('true');
      expect(
        steps[postReportIdx]?.run,
        `${wfName}: post-build report must run exactly 'df -h /'`,
      ).toBe('df -h /');
      // The pre-build report must not carry if: always() — it should only run
      // when prior steps succeeded, so it cannot mask a setup failure.
      expect(
        steps[preReportIdx]?.if ?? '',
        `${wfName}: pre-build report must not be if: always()`,
      ).not.toMatch(/always\(\)/);
    }
  });

  it('has exactly one rm -rf whose only operands are the pinned unused_toolchains array', () => {
    const script = readFileSync(reclaimScript, 'utf8');
    // The four Android Rust targets must coexist: nothing under the Rust,
    // Android SDK/NDK, Java, or Node roots may ever be a removal target.
    const allowlist = [
      '/opt/ghc',
      '/opt/hostedtoolcache/CodeQL',
      '/usr/local/.ghcup',
      '/usr/local/share/boost',
      '/usr/share/dotnet',
    ];
    const block = script.match(/unused_toolchains=\(\s*([\s\S]*?)\)/);
    expect(
      block,
      'unused_toolchains array not found in reclaim script',
    ).not.toBeNull();
    const targets = [...block![1].matchAll(/(\/\S+)/g)].map((m) => m[1]);
    expect(targets).toEqual(allowlist);

    // Exactly one rm -rf call (counting command lines only, not comments),
    // and it must expand only the pinned array — no hardcoded paths can sneak
    // onto the removal line.
    const rmLines = script
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#') && /rm -rf/.test(l));
    expect(
      rmLines,
      'expected exactly one rm -rf call in the reclaim script',
    ).toHaveLength(1);
    // Pin the destructive command by exact equality: the only permitted form
    // is `sudo rm -rf -- "${unused_toolchains[@]}"` — any appended variable or
    // hardcoded path fails this assertion.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash array-expansion literal, not a JS template placeholder
    expect(rmLines[0].trim()).toBe('sudo rm -rf -- "${unused_toolchains[@]}"');

    // Belt-and-suspenders: the allowlist itself never touches a build root.
    for (const target of targets) {
      expect(target).not.toMatch(/\/usr\/local\/lib\/android/);
      expect(target).not.toMatch(/rustup|\.cargo/);
      expect(target).not.toMatch(/\/usr\/lib\/jvm|node/);
    }
  });

  it('pins a non-overridable minimum-free-space constant', () => {
    const script = readFileSync(reclaimScript, 'utf8');
    // No env override may exist: STATION_ANDROID_MIN_FREE_KIB must not appear
    // anywhere, so no value (including 0) can weaken the fail-closed floor.
    expect(
      script,
      'STATION_ANDROID_MIN_FREE_KIB env override must not exist',
    ).not.toMatch(/STATION_ANDROID_MIN_FREE_KIB/);
    const match = script.match(/min_free_kib=(\d+)/);
    expect(match, 'pinned min_free_kib constant not found').not.toBeNull();
    // Exactly 10 GiB (10485760 KiB) — provisional until the authoritative
    // hosted run reports the real post-reclaim figure.
    expect(Number(match![1])).toBe(10_485_760);
  });

  it('skips reclaim cleanly (exit 0, no report) without invoking sudo outside a GitHub-hosted Linux runner', async () => {
    // The guard must refuse foreign environments without failing the build:
    // reclamation is an optimization, not a correctness gate. Hermetic by
    // construction: fake sudo/df live first on a controlled PATH (real sudo is
    // shadowed, so a guard regression can never run `sudo rm`), and the fake
    // sudo records any invocation to a marker. df is faked too so a regression
    // flows all the way to the sudo marker (and is detected) instead of dying
    // early at a missing binary before reaching deletion. No skip case may
    // inherit the real PATH such that privileged deletion could run.
    const dir = mkdtempSync(resolve(tmpdir(), 'reclaim-guard-skip-'));
    const marker = resolve(dir, 'sudo.marker');
    try {
      writeFakeDf(dir, String(MIN_FREE_KIB + 5_000_000));
      writeFakeSudo(dir, marker, false);
      const hermeticPath = `${dir}:/usr/bin:/bin`;
      const cases: Array<{
        name: string;
        env: NodeJS.ProcessEnv;
        reason: string;
      }> = [
        {
          name: 'macOS',
          env: {
            PATH: hermeticPath,
            RUNNER_OS: 'macOS',
            RUNNER_ENVIRONMENT: 'github-hosted',
          },
          reason: 'RUNNER_OS=macOS',
        },
        {
          name: 'self-hosted Linux',
          env: {
            PATH: hermeticPath,
            RUNNER_OS: 'Linux',
            RUNNER_ENVIRONMENT: 'self-hosted',
          },
          reason: 'RUNNER_ENVIRONMENT=self-hosted',
        },
        {
          name: 'unset runner vars',
          env: { PATH: hermeticPath },
          reason: 'RUNNER_OS=<unset>',
        },
      ];
      for (const { name, env, reason } of cases) {
        const result = await runBoundedFixture(reclaimScript, [], { env });
        expect(
          result.status,
          `${name}: expected graceful skip, got exit ${result.status}`,
        ).toBe(0);
        expect(result.stderr, `${name}: expected skip message`).toContain(
          'Skipping disk reclaim',
        );
        expect(result.stderr).toContain(reason);
        expect(
          result.stdout,
          `${name}: skip path must not emit a reclaim report`,
        ).toBe('');
        expect(
          existsSync(marker),
          `${name}: skip path invoked sudo (guard regression would run privileged deletion)`,
        ).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Non-destructive hosted-path harness: inject fake df/sudo via a temp
  // directory on PATH so the GitHub-hosted Linux branch is exercised without
  // ever invoking real `sudo rm`. The threshold is the script's pinned,
  // non-overridable constant; fake-df values are computed relative to it so
  // the pass/fail cases stay deterministic. The fake sudo appends to a marker
  // file on every invocation, so a guard regression that reaches privileged
  // deletion is observed (the marker appears) instead of running silently.
  const MIN_FREE_KIB = 10_485_760; // matches the script's pinned 10 GiB floor

  function writeFakeDf(dir: string, availKib: string) {
    const path = resolve(dir, 'df');
    writeFileSync(
      path,
      `#!/usr/bin/env bash\nprintf 'Avail\\n${availKib}\\n'\n`,
    );
    chmodSync(path, 0o755);
  }

  function writeFakeSudo(dir: string, marker: string, fail: boolean) {
    const path = resolve(dir, 'sudo');
    writeFileSync(
      path,
      `#!/usr/bin/env bash\necho "sudo $*" >> "${marker}"\nexit ${fail ? 1 : 0}\n`,
    );
    chmodSync(path, 0o755);
  }

  function hostedEnv(fakeDir: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PATH: `${fakeDir}:${process.env.PATH}`,
      RUNNER_OS: 'Linux',
      RUNNER_ENVIRONMENT: 'github-hosted',
    };
  }

  it(
    'succeeds on hosted Linux when post-reclaim free space clears the minimum',
    async () => {
      const dir = mkdtempSync(resolve(tmpdir(), 'reclaim-hosted-ok-'));
      const marker = resolve(dir, 'sudo.marker');
      try {
        writeFakeDf(dir, String(MIN_FREE_KIB + 5_000_000)); // clears the pinned floor
        writeFakeSudo(dir, marker, false);
        const result = await runBoundedFixture(reclaimScript, [], {
          env: hostedEnv(dir),
        });
        expect(
          result.status,
          `expected exit 0\nSTDOUT:${result.stdout}\nSTDERR:${result.stderr}`,
        ).toBe(0);
        expect(result.stdout).toContain('Reclaimed');
        expect(result.stdout).toContain('minimum');
        expect(
          existsSync(marker),
          'hosted success path must invoke the hermetic sudo',
        ).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );

  it('fails closed on hosted Linux when post-reclaim free space is below the minimum', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'reclaim-hosted-low-'));
    const marker = resolve(dir, 'sudo.marker');
    try {
      writeFakeDf(dir, String(MIN_FREE_KIB - 5_000_000)); // under the pinned floor
      writeFakeSudo(dir, marker, false);
      const result = await runBoundedFixture(reclaimScript, [], {
        env: hostedEnv(dir),
      });
      expect(
        result.status,
        `expected non-zero exit\nSTDOUT:${result.stdout}\nSTDERR:${result.stderr}`,
      ).not.toBe(0);
      expect(result.stderr).toContain('Insufficient disk');
      // sudo runs before the threshold check, so the marker proves the hosted
      // path reached deletion before fail-closing on free space.
      expect(
        existsSync(marker),
        'hosted low-space path must invoke the hermetic sudo before fail-closing',
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on hosted Linux when the deletion itself errors', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'reclaim-hosted-rmfail-'));
    const marker = resolve(dir, 'sudo.marker');
    try {
      writeFakeDf(dir, String(MIN_FREE_KIB + 5_000_000));
      writeFakeSudo(dir, marker, true); // fake sudo exits 1 → set -e kills the script
      const result = await runBoundedFixture(reclaimScript, [], {
        env: hostedEnv(dir),
      });
      expect(
        result.status,
        `expected non-zero exit\nSTDOUT:${result.stdout}\nSTDERR:${result.stderr}`,
      ).not.toBe(0);
      expect(
        existsSync(marker),
        'hosted rm-fail path must invoke the hermetic sudo before failing',
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

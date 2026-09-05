import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

type Step = {
  env?: Record<string, unknown>;
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};
type Job = {
  needs?: string | string[];
  outputs?: Record<string, unknown>;
  steps?: Step[];
  if?: string;
  environment?: string;
  permissions?: Record<string, string>;
};
type Workflow = {
  on?: Record<string, any>;
  jobs?: Record<string, Job>;
};

function workflow(name: string): Workflow {
  return load(
    readFileSync(resolve(root, '.github/workflows', name), 'utf8'),
  ) as Workflow;
}

function namedStep(job: Job, name: string): Step {
  const step = job.steps?.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`missing workflow step: ${name}`);
  return step;
}

describe('one-revision native promotion contract', () => {
  test('binds the caller and complete native cohort to one validated main SHA', () => {
    const nightly = workflow('nightly.yml');
    const stage = workflow('nightly-native-stage.yml');
    const cohort = workflow('nightly-native-cohort.yml');
    expect(nightly.on?.workflow_dispatch?.inputs?.source_sha).toMatchObject({
      required: false,
    });
    const gate = nightly.jobs?.['test-gate'];
    const stageCaller = nightly.jobs?.['native-stage'];
    const caller = nightly.jobs?.['native-cohort'];
    const iosStageCaller = stage.jobs?.['stage-ios'];
    const iosCaller = cohort.jobs?.['deliver-ios'];
    const fleetCaller = nightly.jobs?.['fleet-staging'];
    expect(gate?.outputs?.source_sha).toBe(
      '$' + '{{ steps.source.outputs.sha }}',
    );
    const source = namedStep(
      gate ?? {},
      'Bind every Nightly leg to one main revision',
    );
    expect(source.run).toContain('current Nightly workflow event SHA');
    expect(source.run).toContain('older revisions are rejected');
    expect(source.run).toContain('test "$source_sha" = "$GITHUB_SHA"');
    expect(gate?.steps?.[0]?.with?.ref).toBe('$' + '{{ github.sha }}');
    // Staging builds and attests but publishes nothing, so it needs only the
    // source gate (#1453); the publishing cohort needs the regression receipt
    // and the staged identity from the same run.
    expect(stageCaller?.needs).toEqual(['test-gate']);
    expect(stageCaller?.if).not.toContain('full-regression');
    expect(stageCaller?.permissions).toEqual({
      contents: 'write',
      'id-token': 'write',
      attestations: 'write',
    });
    expect((stageCaller as any)?.uses).toBe(
      './.github/workflows/nightly-native-stage.yml',
    );
    expect((stageCaller as any)?.with).toEqual({
      source_sha: '$' + '{{ needs.test-gate.outputs.source_sha }}',
      rebuild_index: '$' + '{{ inputs.rebuild_index }}',
    });
    expect((stageCaller as any)?.secrets).toBe('inherit');
    expect(caller?.needs).toEqual([
      'test-gate',
      'full-regression',
      'native-stage',
    ]);
    expect(caller?.if).toContain(
      "needs['full-regression'].result == 'success'",
    );
    expect(caller?.if).toContain("needs['native-stage'].result == 'success'");
    expect(caller?.permissions).toEqual({
      contents: 'write',
      'id-token': 'write',
      attestations: 'write',
    });
    expect((caller as any)?.with).toEqual({
      source_sha: '$' + '{{ needs.test-gate.outputs.source_sha }}',
      build: '$' + '{{ needs.native-stage.outputs.build }}',
      marketing_version:
        '$' + '{{ needs.native-stage.outputs.marketing_version }}',
      bundle_version: '$' + '{{ needs.native-stage.outputs.bundle_version }}',
      reservation_tag: '$' + '{{ needs.native-stage.outputs.reservation_tag }}',
    });
    expect((caller as any)?.secrets).toBe('inherit');
    for (const input of ['source_sha', 'build']) {
      expect(cohort.on?.workflow_call?.inputs?.[input]?.required).toBe(true);
    }
    // Empty on a no-op night, so declared but optional; every cohort job
    // gates on `build` before reading them.
    for (const input of [
      'marketing_version',
      'bundle_version',
      'reservation_tag',
    ]) {
      expect(cohort.on?.workflow_call?.inputs?.[input]).toMatchObject({
        required: false,
        type: 'string',
      });
    }
    expect(stage.on?.workflow_call?.outputs).toMatchObject({
      build: { value: '$' + '{{ jobs.plan-cohort.outputs.build }}' },
      source_sha: {
        value: '$' + '{{ jobs.plan-cohort.outputs.source_sha }}',
      },
      marketing_version: {
        value: '$' + '{{ jobs.plan-cohort.outputs.marketing_version }}',
      },
      bundle_version: {
        value: '$' + '{{ jobs.plan-cohort.outputs.bundle_version }}',
      },
      reservation_tag: {
        value: '$' + '{{ jobs.plan-cohort.outputs.reservation_tag }}',
      },
    });
    expect(stage.jobs?.['plan-cohort']?.outputs).toMatchObject({
      marketing_version:
        '$' + '{{ steps.ios_identity.outputs.marketing_version }}',
      bundle_version: '$' + '{{ steps.allocate.outputs.version_code }}',
      reservation_tag: '$' + '{{ steps.allocate.outputs.reservation_tag }}',
    });
    // iOS is built and audited during staging and only uploaded by the
    // publishing cohort from the same run's staged bytes (#1454).
    expect(iosStageCaller?.needs).toBe('plan-cohort');
    expect((iosStageCaller as any)?.uses).toBe(
      './.github/workflows/testflight-delivery.yml',
    );
    expect((iosStageCaller as any)?.with).toMatchObject({
      delivery: 'build',
      channel: 'nightly',
      source_sha: '$' + '{{ needs.plan-cohort.outputs.source_sha }}',
      source_ref:
        'refs/tags/$' + '{{ needs.plan-cohort.outputs.reservation_tag }}',
      marketing_version:
        '$' + '{{ needs.plan-cohort.outputs.marketing_version }}',
      bundle_version: '$' + '{{ needs.plan-cohort.outputs.bundle_version }}',
    });
    expect((iosStageCaller as any)?.secrets).toBe('inherit');
    expect((iosCaller as any)?.uses).toBe(
      './.github/workflows/testflight-delivery.yml',
    );
    expect((iosCaller as any)?.with).toMatchObject({
      delivery: 'upload',
      channel: 'nightly',
      source_sha: '$' + '{{ inputs.source_sha }}',
      source_ref: 'refs/tags/$' + '{{ inputs.reservation_tag }}',
      marketing_version: '$' + '{{ inputs.marketing_version }}',
      bundle_version: '$' + '{{ inputs.bundle_version }}',
    });
    expect(fleetCaller?.needs).toEqual(['test-gate', 'full-regression']);
    expect((fleetCaller as any)?.uses).toBe(
      './.github/workflows/nightly-fleet-staging.yml',
    );
    expect((fleetCaller as any)?.permissions).toEqual({
      contents: 'read',
      attestations: 'write',
      'id-token': 'write',
    });
    expect((fleetCaller as any)?.with?.source_sha).toBe(
      '$' + '{{ needs.test-gate.outputs.source_sha }}',
    );
    expect(fleetCaller).not.toHaveProperty('secrets');
    expect(Object.keys(stage.jobs ?? {})).toEqual([
      'plan-cohort',
      'stage-android',
      'stage-macos',
      'stage-ios',
    ]);
    expect(Object.keys(cohort.jobs ?? {})).toEqual([
      'admit-cohort',
      'create-promotion-fence',
      'promote-android',
      'promote-macos',
      'deliver-ios',
      'protected-finalize',
      'record-native-completion',
      'recover-native-cohort',
    ]);
    expect(cohort.jobs?.['admit-cohort']?.if).toContain(
      "inputs.build == 'true'",
    );
    expect(cohort.jobs?.['promote-macos']?.needs).toEqual(['promote-android']);
    expect(cohort.jobs?.['deliver-ios']?.needs).toEqual(['promote-macos']);
    expect(cohort.jobs?.['protected-finalize']?.needs).toEqual([
      'promote-macos',
      'deliver-ios',
    ]);
    expect(cohort.jobs?.['record-native-completion']?.needs).toEqual([
      'protected-finalize',
    ]);
    expect(cohort.jobs?.['recover-native-cohort']?.needs).toEqual([
      'create-promotion-fence',
      'promote-android',
      'promote-macos',
      'deliver-ios',
      'protected-finalize',
      'record-native-completion',
    ]);
    expect(cohort.jobs?.['recover-native-cohort']?.if).toContain(
      "needs.deliver-ios.result != 'success'",
    );
    expect(cohort.jobs?.['recover-native-cohort']?.if).toContain(
      "needs.record-native-completion.result != 'success'",
    );
    const recoveryReceipt = namedStep(
      cohort.jobs?.['recover-native-cohort'] ?? {},
      'Construct content-bound durable recovery receipt',
    );
    expect((recoveryReceipt as any).env?.JOB_RESULTS).toContain(
      '"deliver-ios":"$' + '{{ needs.deliver-ios.result }}"',
    );
  });

  test('moves the Android completion marker and durable ledgers only after final verification', () => {
    const source = readFileSync(
      resolve(root, '.github/workflows/nightly-native-cohort.yml'),
      'utf8',
    );
    const finalize = source.indexOf('\n  protected-finalize:');
    const record = source.indexOf('\n  record-native-completion:');
    expect(finalize).toBeGreaterThanOrEqual(0);
    expect(record).toBeGreaterThan(finalize);
    const recordJob = source.slice(record);
    expect(recordJob).toContain(
      'assert-final cohort/final-cohort-receipt.json',
    );
    expect(recordJob).toContain('deploy-ledger-commit.mjs');
    expect(recordJob).toContain('refs/tags/nightly');
    expect(source.slice(0, record)).not.toContain('refs/tags/nightly"');
  });

  test('fails planning closed on a durable recovery lock and records every recovery boundary', () => {
    const cohort = workflow('nightly-native-cohort.yml');
    const plan =
      workflow('nightly-native-stage.yml').jobs?.['plan-cohort'] ?? {};
    const lock = namedStep(
      plan,
      'Fail closed when durable native recovery is pending',
    );
    expect(lock.run).toContain('refs/tags/nightly-recovery-lock');
    expect(lock.run).toContain('before another cohort can allocate');
    const recovery = cohort.jobs?.['recover-native-cohort'] ?? {};
    expect(recovery.permissions).toEqual({ contents: 'write' });
    expect(
      namedStep(recovery, 'Construct content-bound durable recovery receipt')
        .run,
    ).toContain('recovery-receipt native-cohort-recovery.json');
    const durableLock = namedStep(
      recovery,
      'Create and read back durable recovery lock',
    );
    expect(durableLock.run).toContain('--request POST');
    expect(durableLock.run).toContain('git/ref/tags/nightly-recovery-lock');
    expect(durableLock.run).not.toContain('--request DELETE');
    expect((cohort.jobs?.['record-native-completion'] as any)?.outputs).toEqual(
      expect.objectContaining({
        final_attestation: '$' + '{{ steps.final_attestation.outcome }}',
        app_token: '$' + '{{ steps.ledger_token.outcome }}',
        ledger: '$' + '{{ steps.durable_ledger.outcome }}',
        tag: '$' + '{{ steps.nightly_marker.outcome }}',
      }),
    );
  });

  test('uses a content-bound promotion fence from admission through final durable completion', () => {
    const cohort = workflow('nightly-native-cohort.yml');
    const plan =
      workflow('nightly-native-stage.yml').jobs?.['plan-cohort'] ?? {};
    const pendingFence = namedStep(
      plan,
      'Fail closed when a prior promotion fence is pending',
    );
    expect(pendingFence.run).toContain('refs/tags/nightly-promotion-fence');
    expect(pendingFence.run).toContain('assert-promotion-fence-tag-object');
    const fence = cohort.jobs?.['create-promotion-fence'] ?? {};
    expect(fence.needs).toEqual(['admit-cohort']);
    expect(fence.permissions).toEqual({ contents: 'write' });
    const create = namedStep(
      fence,
      'Construct, create, and exactly read back the promotion fence',
    );
    expect(create.run).toContain('promotion-fence promotion-fence.json');
    expect(create.run).toContain('assert-promotion-fence-tag-object');
    expect(create.run).toContain('git/tags');
    expect(create.run).toContain('git/refs');
    const android = cohort.jobs?.['promote-android'] ?? {};
    expect(android.needs).toEqual(['admit-cohort', 'create-promotion-fence']);
    const check = namedStep(
      android,
      'Re-verify the live promotion fence immediately before Play',
    );
    expect(check.run).toContain('assert-promotion-fence-tag-object');
    const macosCheck = namedStep(
      cohort.jobs?.['promote-macos'] ?? {},
      'Re-verify the live promotion fence immediately before macOS publication',
    );
    expect(macosCheck.run).toContain('refs/tags/nightly-promotion-fence');
    expect(macosCheck.run).toContain('assert-promotion-fence-tag-object');
    const macosSteps = cohort.jobs?.['promote-macos']?.steps ?? [];
    expect(macosSteps.indexOf(macosCheck)).toBeLessThan(
      macosSteps.indexOf(
        namedStep(
          cohort.jobs?.['promote-macos'] ?? {},
          'Promote all four admitted macOS assets and bind the rolling tag',
        ),
      ),
    );
    const record = cohort.jobs?.['record-native-completion'] ?? {};
    const clear = namedStep(
      record,
      'Remove the exact promotion fence only after all durable completion',
    );
    expect(clear.run).toContain('--request DELETE');
    expect(clear.run).toContain('test "$status" = 204');
    expect(clear.run).toContain('test "$status" = 404');
    expect((record.outputs as any)?.promotion_fence).toBe(
      '$' + '{{ steps.clear_promotion_fence.outcome }}',
    );
  });

  test('uses only exact marker fallback responses', () => {
    const record = workflow('nightly-native-cohort.yml').jobs?.[
      'record-native-completion'
    ] ?? { steps: [] };
    const marker = namedStep(
      record,
      'Advance final Android marker with exact REST readback',
    );
    expect(marker.run).toContain('"Not Found"');
    expect(marker.run).toContain('"Reference does not exist"');
    expect(marker.run).toContain('elif [ "$status" = 422 ]');
    expect(marker.run).toContain('elif [ "$status" != 200 ]');
  });

  test('preflights the rolling prerelease and handles a missing final Android marker without git push', () => {
    const cohort = workflow('nightly-native-cohort.yml');
    const macos = namedStep(
      cohort.jobs?.['promote-macos'] ?? {},
      'Promote all four admitted macOS assets and bind the rolling tag',
    );
    expect(macos.run).toContain('--json isDraft,isPrerelease');
    expect(macos.run).toContain(
      'value.isDraft!==false||value.isPrerelease!==true',
    );
    const marker = namedStep(
      cohort.jobs?.['record-native-completion'] ?? {},
      'Advance final Android marker with exact REST readback',
    );
    expect(marker.run).toContain('--request PATCH');
    expect(marker.run).toContain('if [ "$status" = 404 ]');
    expect(marker.run).toContain('--request POST');
    expect(marker.run).toContain('readback=$(mktemp)');
    expect(marker.run).not.toContain('git push');
  });

  test('makes stable TestFlight publication and provider receipt fail closed', () => {
    const release = workflow('release.yml');
    const caller = release.jobs?.['ios-device'] ?? {};
    const nightlyCohort = workflow('nightly-native-cohort.yml');
    const nightlyCaller = nightlyCohort.jobs?.['deliver-ios'] ?? {};
    const delivery = workflow('testflight-delivery.yml');
    const ios = delivery.jobs?.deliver ?? {};
    const iosUpload = delivery.jobs?.upload ?? {};
    // build-and-upload (default) chains the two jobs in one call; build stops
    // after the audited IPA is staged; upload never runs the build job and
    // never proceeds past a failed one (#1454).
    expect(delivery.on?.workflow_call?.inputs?.delivery).toMatchObject({
      required: false,
      default: 'build-and-upload',
    });
    expect(ios.if).toBe('$' + "{{ inputs.delivery != 'upload' }}");
    expect(iosUpload.needs).toBe('deliver');
    expect(iosUpload.if).toContain("inputs.delivery != 'build'");
    expect(iosUpload.if).toContain("needs.deliver.result == 'success'");
    expect(iosUpload.if).toContain(
      "(inputs.delivery == 'upload' && needs.deliver.result == 'skipped')",
    );
    expect(iosUpload.environment).toBe(ios.environment);
    expect(
      iosUpload.steps?.some((step) =>
        step.run?.includes('npx tauri ios build'),
      ),
    ).toBe(false);
    expect(
      namedStep(ios, 'Import protected signing material bound to this channel'),
    ).toBeDefined();
    const signingImport = namedStep(
      ios,
      'Import protected signing material bound to this channel',
    );
    expect(signingImport.run).toContain(
      'security set-keychain-settings -lut 21600 "$keychain"',
    );
    const codesignCanary = namedStep(
      ios,
      'Prove headless codesign access before the expensive build',
    );
    expect((codesignCanary as any)['timeout-minutes']).toBe(2);
    expect(codesignCanary.run).toContain(
      '/usr/bin/codesign --force --sign "$APPLE_SIGNING_IDENTITY"',
    );
    expect(ios.steps?.indexOf(codesignCanary)).toBeLessThan(
      ios.steps?.indexOf(
        namedStep(ios, 'Build signed and channel-audited iOS package'),
      ) ?? -1,
    );
    const signedBuild = namedStep(
      ios,
      'Build signed and channel-audited iOS package',
    );
    expect(signedBuild.run).toContain(
      'security unlock-keychain -p "$APPLE_IOS_DISTRIBUTION_CERTIFICATE_PASSWORD" "$RUNNER_TEMP/station-ios.keychain-db"',
    );
    expect(signedBuild.run?.indexOf('security unlock-keychain')).toBeLessThan(
      signedBuild.run?.indexOf('npx tauri ios build') ?? -1,
    );
    for (const required of [
      'APPLE_API_KEY_ID',
      'APPLE_API_ISSUER_ID',
      'APPLE_API_PRIVATE_KEY',
    ]) {
      expect(
        readFileSync(
          resolve(root, '.github/workflows/testflight-delivery.yml'),
          'utf8',
        ),
      ).toContain(required);
    }
    const upload = namedStep(
      iosUpload,
      'Upload a previously unobserved IPA to TestFlight',
    );
    const packageVerification = namedStep(
      ios,
      'Verify IPA identity, profile and package contents',
    );
    const staged = namedStep(
      ios,
      'Retain the audited IPA and receipts as the staged run artifact',
    );
    expect(staged.with?.name).toBe(
      'station-$' +
        '{{ inputs.channel }}-ios-staged-$' +
        '{{ inputs.bundle_version }}',
    );
    expect(staged.with?.['if-no-files-found']).toBe('error');
    expect(ios.steps?.indexOf(staged)).toBeGreaterThan(
      ios.steps?.indexOf(packageVerification) ?? -1,
    );
    const download = iosUpload.steps?.find((step) =>
      step.uses?.startsWith('actions/download-artifact@'),
    );
    expect(download?.with?.name).toBe(staged.with?.name);
    expect(upload.with?.['app-path']).toBe(
      '$' + '{{ steps.staged.outputs.ipa }}',
    );
    expect(packageVerification.run).toContain(
      'scripts/ios-exported-entitlements.mjs',
    );
    expect(packageVerification.run).not.toContain(
      'plutil -extract keychain-access-groups',
    );
    const failedPackage = namedStep(
      ios,
      'Retain the built IPA when package verification fails',
    );
    expect((failedPackage as any).if).toBe('failure()');
    expect(failedPackage.with?.path).toBe(
      'src-desktop/gen/apple/build/arm64/*.ipa',
    );
    // The action's own wait outlives the single token it mints (#1499); the
    // workflow's wait-for-valid-build step, which mints per request, is the
    // one processing wait, and it must directly follow the upload.
    expect(upload.with?.['wait-for-processing']).toBe('false');
    const processingWait = namedStep(
      iosUpload,
      'Reconcile exactly one VALID provider build',
    );
    expect(processingWait.run).toContain('wait-for-valid-build');
    expect(processingWait.run).toContain('--deadline-seconds 1800');
    expect(iosUpload.steps?.indexOf(processingWait)).toBe(
      (iosUpload.steps?.indexOf(upload) ?? -1) + 1,
    );
    expect((upload as any).if).toContain(
      "steps.reconcile.outputs.upload == 'true'",
    );
    expect(
      [...(ios.steps ?? []), ...(iosUpload.steps ?? [])].some(
        (step) => step.name === 'Note skipped TestFlight upload',
      ),
    ).toBe(false);

    const preflight = namedStep(
      ios,
      'Verify App Store Connect app authority before signing',
    );
    const uploadPreflight = namedStep(
      iosUpload,
      'Verify App Store Connect app authority before upload',
    );
    const receipt = namedStep(
      iosUpload,
      'Record processed provider receipt and attach the channel group',
    );
    const retain = iosUpload.steps?.find((step) =>
      step.uses?.includes('upload-artifact'),
    );
    expect(preflight.run).toContain('app-preflight');
    expect(uploadPreflight.run).toContain('app-preflight');
    expect(uploadPreflight.run).toContain('Print :CFBundleVersion');
    expect(receipt.run).toContain('build-receipt');
    expect(receipt.run).toContain('inputs.source_sha');
    expect(receipt.run).toContain(
      '--artifact-manifest staged/src-desktop/station-client-build.json',
    );
    expect(retain?.with?.name).toContain(
      'station-$' + '{{ inputs.channel }}-ios-testflight',
    );
    expect((caller as any).uses).toBe(
      './.github/workflows/testflight-delivery.yml',
    );
    expect((nightlyCaller as any).uses).toBe(
      './.github/workflows/testflight-delivery.yml',
    );
    for (const input of [
      'update_feed_url',
      'update_provider_origin',
      'update_action_url',
      'update_action_kind',
      'update_action_origins',
    ]) {
      expect(delivery.on?.workflow_call?.inputs?.[input]?.required).toBe(false);
      expect((caller as any).with?.[input]).toBeDefined();
      expect((nightlyCaller as any).with?.[input]).toBeDefined();
    }
  });

  test('keeps TestFlight authoritative when no custom feed is configured', () => {
    const release = workflow('release.yml');
    const delivery = workflow('testflight-delivery.yml');
    const ios = delivery.jobs?.deliver ?? {};
    const required = namedStep(
      ios,
      'Fail closed on channel-owned secrets and exact iOS identity',
    );
    const authority = namedStep(ios, 'Resolve optional custom iOS update feed');
    expect(required.run).not.toContain('VITE_NATIVE_APP_UPDATE_FEED_URL');
    expect(required.run).not.toContain('NATIVE_APP_UPDATE_ACTION_URL');
    expect(authority.run).toContain('write-authority-receipt');
    expect(authority.run).toContain('testflight-update-authority.json');
    expect(authority.run).toContain('--platform ios');
    expect(authority.run).toContain('--ios-app-id');
    expect(authority.run).toContain('steps.app_store.outputs.app_id');

    const iosDependencies = ios.steps?.findIndex(
      (step) => step.run === 'npm run dependencies:ci',
    );
    const iosAuthority = ios.steps?.findIndex(
      (step) => step.name === 'Resolve optional custom iOS update feed',
    );
    expect(iosDependencies).toBeGreaterThanOrEqual(0);
    expect(iosAuthority).toBeGreaterThan(iosDependencies ?? -1);
    const iosAppPreflight = ios.steps?.findIndex(
      (step) =>
        step.name === 'Verify App Store Connect app authority before signing',
    );
    expect(iosAuthority).toBeGreaterThan(iosAppPreflight ?? -1);

    const android = release.jobs?.android ?? {};
    const androidDependencies = android.steps?.findIndex(
      (step) =>
        step.name ===
        'Install dependencies before resolving the native update feed',
    );
    const androidAuthority = android.steps?.findIndex(
      (step) => step.name === 'Resolve native update feed contract',
    );
    expect(androidDependencies).toBeGreaterThanOrEqual(0);
    expect(androidAuthority).toBeGreaterThan(androidDependencies ?? -1);
  });

  test('keeps portable fleet staging independent, fixed-plan, and provenance-verified', () => {
    const fleet = workflow('nightly-fleet-staging.yml');
    expect(Object.keys(fleet.jobs ?? {})).toEqual([
      'fleet-plan',
      'portable',
      'admit-fleet',
    ]);
    const source = readFileSync(
      resolve(root, '.github/workflows/nightly-fleet-staging.yml'),
      'utf8',
    );
    const fleetPlan = fleet.jobs?.['fleet-plan'] ?? {};
    const dependencyStep = fleetPlan.steps?.findIndex(
      (step) => step.run === 'npm run dependencies:ci',
    );
    const planStep = fleetPlan.steps?.findIndex(
      (step) => step.name === 'Read the reviewed static portable plan',
    );
    expect(dependencyStep).toBeGreaterThanOrEqual(0);
    expect(planStep).toBeGreaterThan(dependencyStep ?? -1);
    for (const action of [
      'anchore/sbom-action@3ad7283483fc7af8ff2b4ea19663c2d5ca935e26',
      'actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8',
    ])
      expect(source).toContain(action);
    expect(source).toContain('stage-receipt');
    expect(source).toContain('staged-fleet-inventory.mjs admit-fixed');
    expect(source).toContain('config/nightly-fleet-staging-plan.json');
    expect(source).toContain('manifest.prerelease!==true');
    expect(source).toContain('Object.hasOwn(manifest,"releaseChannel")');
    expect(source).not.toContain('manifest.releaseChannel!=="nightly-staging"');
    expect(source).toContain('syft-version: v1.51.0');
    expect(source).not.toContain('syft-version: 1.51.0');
    expect(source).toContain('gh attestation verify "staged/$name"');
    const admission = fleet.jobs?.['admit-fleet'] ?? {};
    const verification = admission.steps?.find(
      (step) =>
        step.name ===
        'Verify every attested subject with exact workflow identity',
    );
    expect(verification?.env?.GH_TOKEN).toBe(`${'${{'} github.token }}`);
    expect(verification?.run).toContain(
      "jq -c '.attestation.subjects[]' staged/stage-receipt-portable.json",
    );
    expect(verification?.run).not.toContain('staged/subjects.json');
    expect(source).toContain('--source-ref refs/heads/main');
    expect(source).toContain('--deny-self-hosted-runners');
    expect(source).toContain('test "$sha" = "$GITHUB_SHA"');
    for (const forbidden of [
      'gh release create',
      'gh release upload',
      'fastlane pilot upload',
      'npm publish',
      ':latest',
      'container:',
      'windows:',
      'linux:',
      'ios-simulator:',
    ])
      expect(source).not.toContain(forbidden);
  });

  test('treats only npm E404 as an absent nightly CLI version', () => {
    const nightly =
      namedStep(
        workflow('nightly.yml').jobs?.['nightly-cli'] ?? {},
        'Refuse a conflicting CLI version and skip an exact rerun',
      ).run ?? '';
    expect(nightly).toContain('npm_view_status=$?');
    expect(nightly).toContain(
      'grep -q \'"code"[[:space:]]*:[[:space:]]*"E404"\'',
    );
    expect(nightly).toContain('exit "$npm_view_status"');
    expect(nightly).not.toContain('gitHead --json 2>/dev/null || true');
  });

  test('canonicalizes a non-UTC commit timestamp before portable packaging', () => {
    const source = readFileSync(
      resolve(root, '.github/workflows/nightly-fleet-staging.yml'),
      'utf8',
    );
    expect(source).toContain('git show -s --format=%ct');
    expect(source).not.toContain('--format=%cI');
    expect(source).toContain('new Date(epoch*1000).toISOString()');
    const createdAt = execFileSync(
      'node',
      [
        '-e',
        'process.stdout.write(new Date(Number(process.argv[1])*1000).toISOString())',
        '1788084245',
      ],
      { encoding: 'utf8' },
    );
    expect(createdAt).toBe('2026-08-30T10:04:05.000Z');
  });
});

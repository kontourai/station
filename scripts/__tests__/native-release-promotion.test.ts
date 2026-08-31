import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

type Step = {
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
    const cohort = workflow('nightly-native-cohort.yml');
    expect(nightly.on?.workflow_dispatch?.inputs?.source_sha).toMatchObject({
      required: false,
    });
    const gate = nightly.jobs?.['test-gate'];
    const caller = nightly.jobs?.['native-cohort'];
    const iosCaller = cohort.jobs?.['deliver-ios'];
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
    expect(caller?.needs).toEqual(['test-gate', 'full-regression']);
    expect((caller as any)?.with?.source_sha).toBe(
      '$' + '{{ needs.test-gate.outputs.source_sha }}',
    );
    expect((caller as any)?.secrets).toBe('inherit');
    expect(cohort.on?.workflow_call?.outputs).toMatchObject({
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
    expect(cohort.jobs?.['plan-cohort']?.outputs).toMatchObject({
      marketing_version:
        '$' + '{{ steps.ios_identity.outputs.marketing_version }}',
      bundle_version: '$' + '{{ steps.allocate.outputs.version_code }}',
      reservation_tag: '$' + '{{ steps.allocate.outputs.reservation_tag }}',
    });
    expect((iosCaller as any)?.uses).toBe(
      './.github/workflows/testflight-delivery.yml',
    );
    expect((iosCaller as any)?.with).toMatchObject({
      channel: 'nightly',
      source_sha: '$' + '{{ needs.plan-cohort.outputs.source_sha }}',
      source_ref:
        'refs/tags/$' + '{{ needs.plan-cohort.outputs.reservation_tag }}',
      marketing_version:
        '$' + '{{ needs.plan-cohort.outputs.marketing_version }}',
      bundle_version: '$' + '{{ needs.plan-cohort.outputs.bundle_version }}',
    });
    expect(Object.keys(cohort.jobs ?? {})).toEqual([
      'plan-cohort',
      'stage-android',
      'stage-macos',
      'admit-cohort',
      'create-promotion-fence',
      'promote-android',
      'promote-macos',
      'deliver-ios',
      'protected-finalize',
      'record-native-completion',
      'recover-native-cohort',
    ]);
    expect(cohort.jobs?.['promote-macos']?.needs).toEqual([
      'plan-cohort',
      'promote-android',
    ]);
    expect(cohort.jobs?.['deliver-ios']?.needs).toEqual([
      'plan-cohort',
      'promote-macos',
    ]);
    expect(cohort.jobs?.['protected-finalize']?.needs).toEqual([
      'plan-cohort',
      'promote-macos',
      'deliver-ios',
    ]);
    expect(cohort.jobs?.['record-native-completion']?.needs).toEqual([
      'plan-cohort',
      'protected-finalize',
    ]);
    expect(cohort.jobs?.['recover-native-cohort']?.needs).toEqual([
      'plan-cohort',
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
    const plan = cohort.jobs?.['plan-cohort'] ?? {};
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
    const plan = cohort.jobs?.['plan-cohort'] ?? {};
    const pendingFence = namedStep(
      plan,
      'Fail closed when a prior promotion fence is pending',
    );
    expect(pendingFence.run).toContain('refs/tags/nightly-promotion-fence');
    expect(pendingFence.run).toContain('assert-promotion-fence-tag-object');
    const fence = cohort.jobs?.['create-promotion-fence'] ?? {};
    expect(fence.needs).toEqual(['plan-cohort', 'admit-cohort']);
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
    expect(android.needs).toEqual([
      'plan-cohort',
      'admit-cohort',
      'create-promotion-fence',
    ]);
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
    expect(
      namedStep(ios, 'Import protected signing material bound to this channel'),
    ).toBeDefined();
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
      ios,
      'Upload a previously unobserved IPA to TestFlight',
    );
    expect(upload.with?.['wait-for-processing']).toBe('true');
    expect((upload as any).if).toContain(
      "steps.reconcile.outputs.upload == 'true'",
    );
    expect(
      ios.steps?.some((step) => step.name === 'Note skipped TestFlight upload'),
    ).toBe(false);

    const preflight = namedStep(
      ios,
      'Verify App Store Connect app authority before signing',
    );
    const receipt = namedStep(
      ios,
      'Record processed provider receipt and attach the channel group',
    );
    const retain = ios.steps?.find((step) =>
      step.uses?.includes('upload-artifact'),
    );
    expect(preflight.run).toContain('app-preflight');
    expect(receipt.run).toContain('build-receipt');
    expect(receipt.run).toContain('inputs.source_sha');
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
});

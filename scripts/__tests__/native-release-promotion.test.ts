import { execFileSync } from 'node:child_process';
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
    expect(caller?.needs).toEqual(['test-gate', 'full-regression']);
    expect((caller as any)?.with?.source_sha).toBe(
      '$' + '{{ needs.test-gate.outputs.source_sha }}',
    );
    expect((caller as any)?.secrets).toBe('inherit');
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
    expect(Object.keys(cohort.jobs ?? {})).toEqual([
      'plan-cohort',
      'stage-android',
      'stage-macos',
      'admit-cohort',
      'create-promotion-fence',
      'promote-android',
      'promote-macos',
      'protected-finalize',
      'record-native-completion',
      'recover-native-cohort',
    ]);
    expect(cohort.jobs?.['promote-macos']?.needs).toEqual([
      'plan-cohort',
      'promote-android',
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
      'protected-finalize',
      'record-native-completion',
    ]);
    expect(cohort.jobs?.['recover-native-cohort']?.if).toContain(
      "needs.record-native-completion.result != 'success'",
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
    const ios = release.jobs?.['ios-device'] ?? {};
    const importMaterial = namedStep(
      ios,
      'Import protected Apple signing and store material',
    );
    for (const required of [
      'APPLE_API_KEY_ID',
      'APPLE_API_ISSUER_ID',
      'APPLE_API_PRIVATE_KEY',
    ]) {
      expect(importMaterial.run).toContain(required);
    }
    const upload = namedStep(ios, 'Upload to TestFlight');
    expect(upload.id).toBe('testflight_upload');
    expect(upload.with?.['wait-for-processing']).toBe('true');
    expect((upload as any).if).toBeUndefined();
    expect(
      ios.steps?.some((step) => step.name === 'Note skipped TestFlight upload'),
    ).toBe(false);

    const preflight = namedStep(ios, 'Verify App Store Connect app authority');
    const receipt = namedStep(
      ios,
      'Record the processed TestFlight build receipt',
    );
    const retain = namedStep(ios, 'Retain TestFlight provider receipts');
    expect(preflight.run).toContain('app-preflight');
    expect(receipt.run).toContain('build-receipt');
    expect(receipt.run).toContain('needs.preflight.outputs.sha');
    expect(retain.with?.name).toBe('station-ios-testflight-receipts');
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
    for (const action of [
      'anchore/sbom-action@e22c389904149dbc22b58101806040fa8d37a610',
      'actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8',
    ])
      expect(source).toContain(action);
    expect(source).toContain('stage-receipt');
    expect(source).toContain('staged-fleet-inventory.mjs admit-fixed');
    expect(source).toContain('config/nightly-fleet-staging-plan.json');
    expect(source).toContain('gh attestation verify "staged/$name"');
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

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  test.skipIf(process.platform === 'win32')(
    'exports expanded verifier paths and writes the key where the verifier will read it',
    () => {
      const job = workflow('nightly-native-cohort.yml').jobs?.[
        'protected-finalize'
      ];
      if (!job) throw new Error('missing protected finalizer');
      const setup = namedStep(job, 'Resolve protected verifier paths');
      const authenticate = namedStep(
        job,
        'Fail closed and authenticate the protected verifier',
      );
      const directory = mkdtempSync(join(tmpdir(), 'station verifier paths '));
      const githubEnv = join(directory, 'github-env');
      writeFileSync(githubEnv, '');
      const env = {
        ...process.env,
        ANDROID_HOME: join(directory, 'Android SDK'),
        RUNNER_TEMP: directory,
        GITHUB_ENV: githubEnv,
      };
      try {
        execFileSync('/bin/bash', ['-e', '-c', setup.run ?? 'exit 1'], {
          env,
          windowsHide: true,
        });
        const exported = Object.fromEntries(
          readFileSync(githubEnv, 'utf8')
            .trim()
            .split('\n')
            .map((line) => {
              const equal = line.indexOf('=');
              return [line.slice(0, equal), line.slice(equal + 1)];
            }),
        );
        expect(exported.STATION_BUNDLETOOL_PATH).toBe(
          join(directory, 'bundletool.jar'),
        );
        const keyFile = join(directory, 'station-updater.pub');
        expect(exported.STATION_UPDATER_PUBLIC_KEY_FILE).toBe(keyFile);
        execFileSync('/bin/bash', ['-e', '-c', authenticate.run ?? 'exit 1'], {
          windowsHide: true,
          env: {
            ...env,
            ...exported,
            GCP_PLAY_WORKLOAD_IDENTITY_PROVIDER: 'fixture-provider',
            GCP_PLAY_SERVICE_ACCOUNT: 'fixture-account',
            TAURI_SIGNING_PUBLIC_KEY: 'fixture-public-key',
          },
        });
        expect(readFileSync(keyFile, 'utf8')).toBe('fixture-public-key');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

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
      'clear-promotion-fence',
      'record-native-recovery',
    ]);
    expect(cohort.jobs?.['admit-cohort']?.if).toContain(
      "inputs.build == 'true'",
    );
    // Android and macOS publish independently from the admission and the
    // fence (#1774): neither needs the other, and neither `if` names the
    // other's result, so one platform's provider failure cannot skip the
    // other's publication.
    const platformGuard =
      '$' +
      "{{ github.ref == 'refs/heads/main' && inputs.source_sha == github.sha && needs.admit-cohort.result == 'success' && needs.create-promotion-fence.result == 'success' }}";
    for (const id of ['promote-android', 'promote-macos']) {
      const job = cohort.jobs?.[id] ?? {};
      expect(job.needs, id).toEqual(['admit-cohort', 'create-promotion-fence']);
      expect(job.if, id).toBe(platformGuard);
    }
    // iOS is cut out of the atomic chain (#1774): it uploads the admitted IPA
    // from the same admission and fence, in parallel with Android/macOS, and
    // its outcome gates neither finality nor recovery.
    const deliverIos = cohort.jobs?.['deliver-ios'] ?? {};
    expect(deliverIos.needs).toEqual([
      'admit-cohort',
      'create-promotion-fence',
    ]);
    expect(deliverIos.needs).not.toContain('promote-android');
    expect(deliverIos.needs).not.toContain('promote-macos');
    expect(deliverIos.if).toBe(
      '$' +
        "{{ github.ref == 'refs/heads/main' && inputs.source_sha == github.sha && needs.admit-cohort.result == 'success' && needs.create-promotion-fence.result == 'success' }}",
    );
    // Finalize runs for whichever subset published: it needs both platform
    // jobs only to read their results, stays reachable through the status
    // functions when one failed, and requires at least one success. Neither
    // platform's success is a conjunct of its own — that conjunct is exactly
    // what would let one provider failure withhold the other's finality.
    const finalize = cohort.jobs?.['protected-finalize'] ?? {};
    expect(finalize.needs).toEqual([
      'create-promotion-fence',
      'promote-android',
      'promote-macos',
    ]);
    expect(finalize.if).toBe(
      '$' +
        "{{ always() && !cancelled() && github.ref == 'refs/heads/main' && inputs.source_sha == github.sha && needs.create-promotion-fence.result == 'success' && (needs.promote-android.result == 'success' || needs.promote-macos.result == 'success') }}",
    );
    expect(finalize.if).not.toContain('deliver-ios');
    const finalizeStep = namedStep(
      finalize,
      'Join per-platform claims, verify the published subset, and finalize',
    );
    // A platform whose job left no state is joined from its job result: a
    // skipped job attempted no effect (not_attempted), a job that ran and
    // died may already have had its effect (unknown). The join reads both
    // platforms' own state files.
    expect(finalizeStep.env).toMatchObject({
      PROMOTE_ANDROID_RESULT: '$' + '{{ needs.promote-android.result }}',
      PROMOTE_MACOS_RESULT: '$' + '{{ needs.promote-macos.result }}',
    });
    const joinLines = (finalizeStep.run ?? '')
      .split('\n')
      .map((line) => line.trim());
    const skippedGuard = joinLines.indexOf(
      `if [ "\${!result_variable}" = skipped ]; then`,
    );
    expect(skippedGuard).toBeGreaterThan(0);
    expect(joinLines.slice(skippedGuard, skippedGuard + 5)).toEqual([
      `if [ "\${!result_variable}" = skipped ]; then`,
      'claim=not-attempted-claim',
      'else',
      'claim=unknown-claim',
      'fi',
    ]);
    expect(finalizeStep.run).toContain(
      `"$claim" "$platform-absent-claim.json" cohort/cohort-plan.json "$platform" "run:$GITHUB_RUN_ID:$platform-state-absent:\${!result_variable}"`,
    );
    expect(finalizeStep.run).toContain(
      'finalize cohort/promotion-android-state.json cohort/promotion-macos-state.json > verification-candidate.json',
    );
    expect(finalizeStep.run).toContain(
      'verify-finalize verification-candidate.json final-artifacts.json',
    );
    // Each platform job records its own state from the admission; macOS no
    // longer consumes Android's state, and both retain an unknown claim when
    // their provider step did not succeed.
    for (const [id, platform] of [
      ['promote-android', 'android'],
      ['promote-macos', 'macos'],
    ] as const) {
      const job = cohort.jobs?.[id] ?? {};
      const record = namedStep(
        job,
        `Record only a reported-success ${platform === 'android' ? 'Android' : 'macOS'} provider state`,
      );
      expect(record.id).toBe(`${platform}_provider_state`);
      expect(record.run).toContain(
        'begin-promotion cohort/cohort-admission.json > promotion-state.json',
      );
      expect(record.run).toContain(
        `promotion-receipt promotion-state.json ${platform}-claim.json > promotion-${platform}-state.json`,
      );
      expect(record.run).not.toContain('promotion-android-state.json macos');
      expect(record.run).not.toContain('release-cohort.mjs finalize');
      const unknown = namedStep(
        job,
        `Record unknown ${platform === 'android' ? 'Android' : 'macOS'} provider state for disclosure`,
      );
      expect((unknown as any).if).toBe(
        '$' +
          `{{ always() && steps.${platform}_provider_state.outcome != 'success' }}`,
      );
      expect(unknown.run).toContain(
        `unknown-claim ${platform}-unknown-claim.json`,
      );
      const retain = job.steps?.find((step) =>
        step.uses?.startsWith('actions/upload-artifact@'),
      );
      expect((retain as any)?.if).toBe('always()');
      expect(retain?.with?.name).toBe(
        `nightly-cohort-${platform}-state-\${{ github.run_id }}`,
      );
      expect(String(retain?.with?.path)).toContain(
        `promotion-${platform}-state.json`,
      );
    }
    expect(
      (cohort.jobs?.['promote-macos']?.steps ?? []).some(
        (step) => step.name === 'Retain macOS partial-promotion recovery state',
      ),
    ).toBe(false);
    // Recording depends on iOS only to disclose its result; the status
    // functions keep the job reachable after an iOS failure while finality
    // is still granted by protected-finalize alone.
    const record = cohort.jobs?.['record-native-completion'] ?? {};
    expect(record.needs).toEqual(['protected-finalize', 'deliver-ios']);
    expect(record.if).toBe(
      '$' +
        "{{ always() && !cancelled() && github.ref == 'refs/heads/main' && inputs.source_sha == github.sha && needs.protected-finalize.result == 'success' }}",
    );
    const recover = cohort.jobs?.['record-native-recovery'] ?? {};
    expect(recover.needs).toEqual([
      'create-promotion-fence',
      'promote-android',
      'promote-macos',
      'deliver-ios',
      'protected-finalize',
      'record-native-completion',
      'clear-promotion-fence',
    ]);
    // An iOS-only failure never produces the incomplete-cohort receipt, but
    // the receipt still discloses the iOS result whenever it is written. A
    // failed fence clear does produce it: the receipt's fence block is the
    // disclosure of a fence left standing.
    expect(recover.if).not.toContain('deliver-ios');
    expect(recover.if).toContain(
      "needs.clear-promotion-fence.result != 'success'",
    );
    expect(recover.if).toContain("needs.promote-android.result != 'success'");
    expect(recover.if).toContain("needs.promote-macos.result != 'success'");
    expect(recover.if).toContain(
      "needs.protected-finalize.result != 'success'",
    );
    expect(recover.if).toContain(
      "needs.record-native-completion.result != 'success'",
    );
    const recoveryReceipt = namedStep(
      recover,
      'Construct content-bound incomplete-cohort receipt',
    );
    expect((recoveryReceipt as any).env?.JOB_RESULTS).toContain(
      '"deliver-ios":"$' + '{{ needs.deliver-ios.result }}"',
    );
    expect((recoveryReceipt as any).env?.JOB_RESULTS).toContain(
      '"promotion-fence-clear":"$' +
        '{{ needs.clear-promotion-fence.result }}"',
    );
    // Both platforms' own state files feed the receipt's per-platform
    // disclosure.
    expect(recoveryReceipt.run).toContain(
      'cohort/promotion-android-state.json cohort/promotion-macos-state.json',
    );
  });

  test('discloses the independent iOS delivery outcome on both cohort ledger rows (#1774)', () => {
    const cohort = workflow('nightly-native-cohort.yml');
    const ledger = namedStep(
      cohort.jobs?.['record-native-completion'] ?? {},
      'Record durable completion only after the verified final receipt',
    );
    expect(ledger.env?.IOS_DELIVERY_RESULT).toBe(
      '$' + '{{ needs.deliver-ios.result }}',
    );
    const ledgerCalls = (ledger.run ?? '')
      .split('\n')
      .filter((line) => line.includes('node scripts/deploy-ledger.mjs'));
    expect(ledgerCalls).toHaveLength(2);
    expect(
      ledgerCalls.map((line) => /--channel (\S+)/.exec(line)?.[1]),
    ).toEqual(['nightly-android', 'nightly-desktop']);
    for (const call of ledgerCalls) {
      expect(call).toContain(
        '--note "ios: TestFlight delivery $IOS_DELIVERY_RESULT (run $GITHUB_RUN_ID)"',
      );
    }
    // The note must be the job result, never a hand-written success.
    expect(ledger.run).toContain('test -n "$IOS_DELIVERY_RESULT"');
    expect(ledger.run).not.toMatch(/TestFlight delivery success/);
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

  test('keeps the recovery lock an owner-placed halt: planning fails closed on it and automation only records a receipt (#1774)', () => {
    const cohort = workflow('nightly-native-cohort.yml');
    const cohortSource = readFileSync(
      resolve(root, '.github/workflows/nightly-native-cohort.yml'),
      'utf8',
    );
    const plan =
      workflow('nightly-native-stage.yml').jobs?.['plan-cohort'] ?? {};
    const lock = namedStep(
      plan,
      'Fail closed when durable native recovery is pending',
    );
    expect(lock.run).toContain('refs/tags/nightly-recovery-lock');
    expect(lock.run).toContain('assert-recovery-tag-object');
    expect(lock.run).toContain('before another cohort can allocate');
    const recovery = cohort.jobs?.['record-native-recovery'] ?? {};
    expect(recovery.permissions).toEqual({ contents: 'read' });
    expect(recovery.if).toContain("needs.promote-android.result != 'success'");
    expect(recovery.if).toContain("needs.promote-macos.result != 'success'");
    expect(recovery.if).toContain(
      "needs.protected-finalize.result != 'success'",
    );
    expect(recovery.if).toContain(
      "needs.record-native-completion.result != 'success'",
    );
    expect(
      namedStep(recovery, 'Construct content-bound incomplete-cohort receipt')
        .run,
    ).toContain('recovery-receipt native-cohort-recovery.json');
    // No step in the recovery job writes any ref or tag object; the receipt
    // artifact is its only output.
    for (const step of recovery.steps ?? []) {
      expect(step.run ?? '', step.name).not.toContain('--request POST');
      expect(step.run ?? '', step.name).not.toContain('--request PATCH');
      expect(step.run ?? '', step.name).not.toContain('--request DELETE');
      expect(step.run ?? '', step.name).not.toContain('/git/tags"');
      expect(step.run ?? '', step.name).not.toContain('/git/refs"');
    }
    expect(
      (recovery.steps ?? []).filter((step) =>
        step.uses?.startsWith('actions/upload-artifact@'),
      ),
    ).toHaveLength(1);
    // The only occurrences of the lock ref in the publishing workflow are
    // prose saying automation never writes it.
    const lockLines = cohortSource
      .split('\n')
      .filter((line) => line.includes('nightly-recovery-lock'));
    expect(lockLines.length).toBeGreaterThan(0);
    for (const line of lockLines) expect(line.trim()).toMatch(/^#/);
    expect((cohort.jobs?.['record-native-completion'] as any)?.outputs).toEqual(
      {
        final_attestation: '$' + '{{ steps.final_attestation.outcome }}',
        app_token: '$' + '{{ steps.ledger_token.outcome }}',
        ledger: '$' + '{{ steps.durable_ledger.outcome }}',
        tag: '$' + '{{ steps.nightly_marker.outcome }}',
      },
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
    // The fence is cleared by its own terminal job at the end of every run
    // whose fence job ran, whatever that job's or the platforms' outcomes
    // (#1774): the fence job can create the ref and then fail its own
    // readback, so the gate is "not skipped", never "success". A disclosed
    // partial night never blocks the next plan; a cancelled run leaves it
    // for the plan-time check. It still re-asserts the exact fence object
    // before deleting, confirms the 404, and treats a 404 on the first read
    // (no fence was created) as nothing to clear.
    const clearJob = cohort.jobs?.['clear-promotion-fence'] ?? {};
    expect(clearJob.needs).toEqual([
      'create-promotion-fence',
      'promote-android',
      'promote-macos',
      'deliver-ios',
      'protected-finalize',
      'record-native-completion',
    ]);
    expect(clearJob.if).toBe(
      '$' +
        "{{ always() && !cancelled() && github.ref == 'refs/heads/main' && inputs.source_sha == github.sha && needs.create-promotion-fence.result != 'skipped' }}",
    );
    expect(clearJob.if).not.toContain(
      "needs.create-promotion-fence.result == 'success'",
    );
    for (const id of [
      'promote-android',
      'promote-macos',
      'protected-finalize',
      'record-native-completion',
      'deliver-ios',
    ]) {
      expect(clearJob.if, id).not.toContain(`needs.${id}.result`);
    }
    expect(clearJob.permissions).toEqual({ contents: 'write' });
    const clear = namedStep(
      clearJob,
      'Remove the exact promotion fence at the end of the run that created it',
    );
    expect(clear.id).toBe('clear_promotion_fence');
    expect(clear.env?.GITHUB_TOKEN).toBe('$' + '{{ secrets.GITHUB_TOKEN }}');
    expect(clear.run).toContain('assert-promotion-fence-tag-object');
    const firstRead =
      clear.run?.indexOf('git/ref/tags/nightly-promotion-fence') ?? -1;
    const tolerate404 =
      clear.run?.indexOf('if [ "$status" = 404 ]; then') ?? -1;
    const require200 = clear.run?.indexOf('test "$status" = 200') ?? -1;
    expect(firstRead).toBeGreaterThanOrEqual(0);
    expect(tolerate404).toBeGreaterThan(firstRead);
    expect(require200).toBeGreaterThan(tolerate404);
    expect(clear.run?.slice(tolerate404, require200)).toContain('exit 0');
    expect(clear.run?.indexOf('--request DELETE')).toBeGreaterThan(require200);
    expect(clear.run).toContain('--request DELETE');
    expect(clear.run).toContain('test "$status" = 204');
    expect(clear.run).toContain('test "$status" = 404');
    // Exactly one job deletes the fence, and it is not the record job.
    const deleters = Object.entries(cohort.jobs ?? {}).filter(([, job]) =>
      (job.steps ?? []).some((step) => step.run?.includes('--request DELETE')),
    );
    expect(deleters.map(([id]) => id)).toEqual(['clear-promotion-fence']);
    const record = cohort.jobs?.['record-native-completion'] ?? {};
    expect(record.outputs).not.toHaveProperty('promotion_fence');
  });

  test('records one ledger row per platform the final receipt verified and moves the Android marker only when Android shipped (#1774)', () => {
    const cohort = workflow('nightly-native-cohort.yml');
    const record = cohort.jobs?.['record-native-completion'] ?? {};
    const ledger = namedStep(
      record,
      'Record durable completion only after the verified final receipt',
    );
    const run = ledger.run ?? '';
    // The receipt is asserted, then its state and per-platform states are
    // read from the same file; nothing hand-writes `complete`.
    expect(run).toContain(
      'assert-final cohort/final-cohort-receipt.json "$' +
        '{{ inputs.source_sha }}"',
    );
    expect(run).toContain(
      `final_state=$(node -e 'console.log(require("./cohort/final-cohort-receipt.json").state)')`,
    );
    expect(run).toContain(
      `android_state=$(node -e 'console.log(require("./cohort/final-cohort-receipt.json").platforms.android.state)')`,
    );
    expect(run).toContain(
      `macos_state=$(node -e 'console.log(require("./cohort/final-cohort-receipt.json").platforms.macos.state)')`,
    );
    expect(run).not.toContain(
      "--gate-result 'native cohort final receipt complete'",
    );
    expect(run).toContain(
      'final-platform-notes cohort/final-cohort-receipt.json "$' +
        '{{ inputs.source_sha }}"',
    );
    const lines = run.split('\n');
    const androidCall = lines.findIndex((line) =>
      line.includes('--channel nightly-android'),
    );
    const desktopCall = lines.findIndex((line) =>
      line.includes('--channel nightly-desktop'),
    );
    expect(androidCall).toBeGreaterThan(0);
    expect(desktopCall).toBeGreaterThan(0);
    // Each row is written inside its own platform's `complete` guard and
    // carries the receipt state plus every NOT_PUBLISHED note.
    const guardAbove = (index: number) =>
      lines
        .slice(0, index)
        .reverse()
        .find((line) => /^\s*if \[/.test(line))
        ?.trim();
    expect(guardAbove(androidCall)).toBe(
      'if [ "$android_state" = complete ]; then',
    );
    expect(guardAbove(desktopCall)).toBe(
      'if [ "$macos_state" = complete ]; then',
    );
    for (const index of [androidCall, desktopCall]) {
      expect(lines[index]).toContain(
        '--gate-result "native cohort final receipt $final_state"',
      );
      expect(lines[index]).toContain(`"\${cohort_notes[@]}"`);
      expect(lines[index]).toContain(
        '--note "ios: TestFlight delivery $IOS_DELIVERY_RESULT (run $GITHUB_RUN_ID)"',
      );
    }
    expect(run).toContain("printf 'state=%s\\nandroid=%s\\nmacos=%s\\n'");
    const marker = namedStep(
      record,
      'Advance final Android marker with exact REST readback',
    );
    expect((marker as any).if).toBe(
      '$' + "{{ steps.durable_ledger.outputs.android == 'complete' }}",
    );
    expect(marker.run).toContain('refs/tags/nightly');
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

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  admitCohort,
  beginPromotion,
  CohortValidationError,
  canonicalJson,
  createCohortPlan,
  createStageReceipt,
  finalizeCohort,
  recordProviderPromotion,
  unshippedState,
} from '../release-cohort.mjs';

const sourceSha = 'a'.repeat(40);
const attestation = (records: any[]) => ({
  authority: 'github-artifact-attestation',
  repository: 'kontourai/station',
  workflowRef: `.github/workflows/nightly-native-stage.yml@${sourceSha}`,
  runId: '112061',
  subjectDigest: `sha256:${createHash('sha256').update(canonicalJson(records)).digest('hex')}`,
  verificationReference: 'github:attestation:immutable:1',
});
const evidence = (
  platform: 'android' | 'macos',
  cohortId = createCohortPlan(input()).cohortId,
) => ({
  provider: platform === 'android' ? 'google-play' : 'github-releases',
  immutableReference: `${platform}:receipt:1`,
  queryReceiptDigest: `sha256:${'b'.repeat(64)}`,
  cohortId,
  sourceSha,
});
const success = (platform: 'android' | 'macos', cohortId?: string) => ({
  platform,
  outcome: 'reported_success',
  providerEvidenceClaim: evidence(platform, cohortId),
});
const unresolved = (
  platform: 'android' | 'macos',
  outcome: 'unknown' | 'reported_absent' | 'not_attempted' = 'unknown',
) => ({
  platform,
  outcome,
  providerEvidenceClaim: evidence(platform),
  recoveryAction: `inspect ${platform} provider`,
});
const input = (overrides: any = {}) => ({
  channel: 'nightly',
  sourceSha,
  workflowRunId: '112061',
  versionIdentities: {
    android: {
      packageName: 'io.kontourai.station.nightly',
      versionCode: 242801,
      versionName: '1.0.0-nightly.1',
    },
    desktop: {
      bundleVersion: '242801',
      releaseTag: 'nightly-desktop',
      version: '1.0.0-nightly.1',
    },
  },
  availabilityPolicy: {
    releaseMode: 'per-platform',
    requiredReceipt: 'provider-backed',
    externalEvidenceAuthority: 'github-artifact-attestation',
  },
  requiredPlatforms: ['macos', 'android'],
  ...overrides,
});
function fixture(overrides: any = {}) {
  const plan = createCohortPlan(input(overrides));
  const files = {
    android: { apk: Buffer.from('apk') },
    macos: { app: Buffer.from('app') },
  };
  const android = createStageReceipt(plan, {
    platform: 'android',
    artifacts: [{ name: 'apk', bytes: files.android.apk }],
    artifactAttestationClaim: attestation([
      createHash('sha256').update(files.android.apk).digest
        ? {
            name: 'apk',
            sha256: createHash('sha256')
              .update(files.android.apk)
              .digest('hex'),
            size: 3,
          }
        : {},
    ]),
  });
  const macos = createStageReceipt(plan, {
    platform: 'macos',
    artifacts: [{ name: 'app', bytes: files.macos.app }],
    artifactAttestationClaim: attestation([
      {
        name: 'app',
        sha256: createHash('sha256').update(files.macos.app).digest('hex'),
        size: 3,
      },
    ]),
  });
  const admission = admitCohort(plan, [macos, android], files);
  return { plan, android, macos, files, admission };
}

describe('release cohort content-bound state machine', () => {
  test('structural claims cannot declare an authoritative final release', () => {
    const source = readFileSync(
      join(process.cwd(), 'scripts/release-cohort.mjs'),
      'utf8',
    );
    expect(source).not.toContain('station.release-cohort-final/v1');
    expect(source).not.toMatch(/\bcomplete\b/);
    expect(source).toContain('ready_for_verification');
  });
  test('binds all plan facts, the per-platform policy, platforms, and identities', () => {
    const p = createCohortPlan(input());
    expect(p.requiredPlatforms).toEqual(['android', 'macos']);
    expect(p.availabilityPolicy).toEqual({
      releaseMode: 'per-platform',
      requiredReceipt: 'provider-backed',
      externalEvidenceAuthority: 'github-artifact-attestation',
    });
    // Platforms publish independently (#1774): the plan carries no
    // promotion order for anything to serialize on.
    expect(p).not.toHaveProperty('promotionOrder');
    Reflect.set(p.availabilityPolicy, 'releaseMode', 'mutable');
    expect(createCohortPlan(input())).toMatchObject({
      availabilityPolicy: { releaseMode: 'per-platform' },
    });
    for (const releaseMode of ['atomic', 'mutable', 'per-platform ']) {
      expect(() =>
        createCohortPlan(
          input({
            availabilityPolicy: { ...input().availabilityPolicy, releaseMode },
          }),
        ),
      ).toThrow('per-platform provider-backed policy');
    }
    expect(() => createCohortPlan(input({ channel: 'development' }))).toThrow(
      CohortValidationError,
    );
    expect(() => createCohortPlan(input({ workflowRunId: '12x' }))).toThrow(
      CohortValidationError,
    );
    expect(() => createCohortPlan(input({ availabilityPolicy: {} }))).toThrow(
      CohortValidationError,
    );
    expect(() =>
      createCohortPlan(input({ versionIdentities: { android: '1' } })),
    ).toThrow(CohortValidationError);
    expect(() =>
      createCohortPlan(
        input({
          versionIdentities: {
            ...input().versionIdentities,
            android: {
              ...input().versionIdentities.android,
              versionCode: '242801',
            },
          },
        }),
      ),
    ).toThrow('versionIdentities.android is invalid');
    expect(() =>
      createCohortPlan(
        input({
          versionIdentities: {
            ...input().versionIdentities,
            desktop: {
              ...input().versionIdentities.desktop,
              releaseTag: 'not/a-tag',
            },
          },
        }),
      ),
    ).toThrow('versionIdentities.desktop is invalid');
    expect(() =>
      createStageReceipt(
        { ...p, requiredPlatforms: ['macos', 'android'] },
        {
          platform: 'android',
          artifacts: [{ name: 'a', bytes: Buffer.from('a') }],
        },
      ),
    ).toThrow(CohortValidationError);
  });

  test('admission verifies downloaded bytes and rejects receipt digest mutation', () => {
    const { plan, android, macos, files, admission } = fixture();
    expect(admission.admissionContentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      admitCohort(
        plan,
        [
          { ...android, artifacts: [{ ...android.artifacts[0], size: 9 }] },
          macos,
        ],
        files,
      ),
    ).toThrow(CohortValidationError);
    expect(() =>
      admitCohort(plan, [android, macos], {
        ...files,
        android: { apk: Buffer.from('wrong') },
      }),
    ).toThrow('does not match');
  });

  test('rejects every malformed or misbound external evidence field', () => {
    const { plan, files, android, admission } = fixture();
    const stageInput = {
      platform: 'android',
      artifacts: [{ name: 'apk', bytes: files.android.apk }],
      artifactAttestationClaim: structuredClone(
        android.artifactAttestationClaim,
      ),
    };
    for (const mutate of [
      (v: any) => (v.authority = 'other'),
      (v: any) => (v.repository = 'other/repo'),
      (v: any) => (v.runId = '99'),
      (v: any) =>
        (v.workflowRef = `.github/workflows/nightly-native-stage.yml@${'b'.repeat(40)}`),
      // The right source at the wrong (publishing) workflow: staged bytes are
      // attested by the staging phase only.
      (v: any) =>
        (v.workflowRef = `.github/workflows/nightly-native-cohort.yml@${sourceSha}`),
      (v: any) => (v.subjectDigest = `sha256:${'0'.repeat(64)}`),
      (v: any) => (v.verificationReference = ''),
    ]) {
      const input = structuredClone(stageInput);
      mutate(input.artifactAttestationClaim);
      expect(() => createStageReceipt(plan, input)).toThrow(
        CohortValidationError,
      );
    }
    const started = beginPromotion(admission);
    for (const mutate of [
      (v: any) => (v.provider = 'github-releases'),
      (v: any) => (v.cohortId = 'cohort-wrong'),
      (v: any) => (v.sourceSha = 'b'.repeat(40)),
      (v: any) => (v.queryReceiptDigest = 'sha256:not-a-digest'),
      (v: any) => (v.immutableReference = ''),
    ]) {
      const providerEvidence = structuredClone(evidence('android'));
      mutate(providerEvidence);
      expect(() =>
        recordProviderPromotion(started, {
          platform: 'android',
          outcome: 'reported_success',
          providerEvidenceClaim: providerEvidence,
        }),
      ).toThrow(CohortValidationError);
    }
    for (const outcome of ['reported_absent', 'unknown']) {
      const providerEvidence = { ...evidence('android'), sourceSha: 'bad' };
      expect(() =>
        recordProviderPromotion(started, {
          platform: 'android',
          outcome,
          providerEvidenceClaim: providerEvidence,
          recoveryAction: 'investigate',
        }),
      ).toThrow(CohortValidationError);
    }
    // Either platform may claim first: nothing serializes them (#1774).
    expect(recordProviderPromotion(started, success('macos'))).toMatchObject({
      promotionReceipts: [{ platform: 'macos', outcome: 'reported_success' }],
    });
    expect(() =>
      recordProviderPromotion(started, {
        ...success('macos'),
        platform: 'ios',
      }),
    ).toThrow('promotion platform is invalid');
  });

  test('joins independent per-platform claims into one candidate and rejects forged or stale state content', () => {
    const { admission } = fixture();
    const android = recordProviderPromotion(
      beginPromotion(admission),
      success('android'),
    );
    const macos = recordProviderPromotion(
      beginPromotion(admission),
      success('macos'),
    );
    // A state carries exactly its own platform's claim: a second claim is
    // refused whichever platform it names, so no state ever encodes one
    // platform's outcome as a precondition of another's.
    expect(() => recordProviderPromotion(android, success('macos'))).toThrow(
      'already carries its provider claim',
    );
    expect(() => recordProviderPromotion(android, success('android'))).toThrow(
      'already carries its provider claim',
    );
    const candidate = finalizeCohort([android, macos]);
    expect(candidate).toMatchObject({
      kind: 'station.release-cohort-verification-candidate/v1',
      state: 'ready_for_verification',
    });
    expect(
      candidate.providerClaims.map((claim: any) => [
        claim.platform,
        claim.outcome,
      ]),
    ).toEqual([
      ['android', 'reported_success'],
      ['macos', 'reported_success'],
    ]);
    // The join is order-independent: the candidate digest binds the claims,
    // not which platform's job happened to finish first.
    expect(finalizeCohort([macos, android])).toEqual(candidate);
    expect(() => finalizeCohort(candidate)).toThrow(
      'does not accept state ready_for_verification',
    );
    expect(() => finalizeCohort([android])).toThrow(
      'exactly one provider claim per required platform',
    );
    expect(() => finalizeCohort([android, android])).toThrow('more than once');
    expect(() => finalizeCohort([beginPromotion(admission), macos])).toThrow(
      'every promotion state must carry exactly one provider claim',
    );
    const other = fixture({
      versionIdentities: {
        ...input().versionIdentities,
        android: { ...input().versionIdentities.android, versionCode: 242802 },
        desktop: {
          ...input().versionIdentities.desktop,
          bundleVersion: '242802',
        },
      },
    });
    const otherMacos = recordProviderPromotion(
      beginPromotion(other.admission),
      success('macos', other.plan.cohortId),
    );
    expect(() => finalizeCohort([android, otherMacos])).toThrow(
      'do not bind one admission',
    );
    expect(() =>
      recordProviderPromotion(
        { ...android, promotionReceipts: [] },
        success('android'),
      ),
    ).toThrow('canonical');
  });

  test('discloses an unknown or absent platform beside a published one and never authorizes a retry', () => {
    const { admission } = fixture();
    const unknown = recordProviderPromotion(
      beginPromotion(admission),
      unresolved('android'),
    );
    const absent = recordProviderPromotion(
      beginPromotion(admission),
      unresolved('android', 'reported_absent'),
    );
    const macos = recordProviderPromotion(
      beginPromotion(admission),
      success('macos'),
    );
    // One platform's failure does not withhold the other's candidate; the
    // failed platform's own claim, reason included, rides along for the
    // verifier to disclose (#1774).
    const partial = finalizeCohort([unknown, macos]);
    expect(partial.state).toBe('ready_for_verification');
    expect(partial.providerClaims).toMatchObject([
      {
        platform: 'android',
        outcome: 'unknown',
        recoveryAction: 'inspect android provider',
      },
      { platform: 'macos', outcome: 'reported_success' },
    ]);
    expect(finalizeCohort([absent, macos]).providerClaims[0]).toMatchObject({
      platform: 'android',
      outcome: 'reported_absent',
    });
    // A job that never ran records `not_attempted`, a distinct claim from
    // `unknown` because only it means no provider effect was attempted.
    const notAttempted = recordProviderPromotion(
      beginPromotion(admission),
      unresolved('android', 'not_attempted'),
    );
    expect(
      finalizeCohort([notAttempted, macos]).providerClaims[0],
    ).toMatchObject({ platform: 'android', outcome: 'not_attempted' });
    expect(() =>
      recordProviderPromotion(beginPromotion(admission), {
        ...unresolved('android'),
        outcome: 'pending',
      }),
    ).toThrow('promotion outcome is invalid');
    // The disclosure is derived from the claim: an unresolved outcome after
    // the job ran is NOT_VERIFIED (the effect precedes the claim step);
    // only a job that never ran is NOT_PUBLISHED.
    expect(unshippedState('unknown')).toBe('NOT_VERIFIED');
    expect(unshippedState('unknown', 'skipped')).toBe('NOT_VERIFIED');
    expect(unshippedState('reported_absent')).toBe('NOT_VERIFIED');
    expect(unshippedState('absent', 'failure')).toBe('NOT_VERIFIED');
    expect(unshippedState('absent', 'cancelled')).toBe('NOT_VERIFIED');
    expect(unshippedState('absent', 'skipped')).toBe('NOT_PUBLISHED');
    expect(unshippedState('not_attempted', 'skipped')).toBe('NOT_PUBLISHED');
    // Nothing published: there is no provider effect to verify, so there is
    // no candidate (the workflow's finalize guard prevents the job anyway).
    const macosUnknown = recordProviderPromotion(
      beginPromotion(admission),
      unresolved('macos'),
    );
    expect(() => finalizeCohort([unknown, macosUnknown])).toThrow(
      'at least one reported-success provider claim',
    );
    for (const value of [partial, unknown, macos]) {
      expect(() => beginPromotion(value)).toThrow(
        'only a fresh staged admission',
      );
    }
    // An unknown claim is final for its state; a later success cannot
    // overwrite it.
    expect(() => recordProviderPromotion(unknown, success('android'))).toThrow(
      'already carries its provider claim',
    );
  });
});

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
test('CLI runs the plan-to-finalize path and rejects invalid invocation', () => {
  const root = mkdtempSync(join(tmpdir(), 'station-cohort-'));
  roots.push(root);
  const put = (name: string, value: any) => {
    const path = join(root, name);
    writeFileSync(
      path,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
    return path;
  };
  const run = (...args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), 'scripts/release-cohort.mjs'), ...args],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  const plan = run('plan', put('input.json', input()));
  const apk = put('apk', 'apk');
  const app = put('app', 'app');
  const android = run(
    'stage-receipt',
    put('plan.json', plan),
    put('android-input.json', {
      platform: 'android',
      artifacts: [{ name: 'apk', path: apk }],
      artifactAttestationClaim: attestation([
        {
          name: 'apk',
          sha256: createHash('sha256').update('apk').digest('hex'),
          size: 3,
        },
      ]),
    }),
  );
  const macos = run(
    'stage-receipt',
    put('plan.json', plan),
    put('macos-input.json', {
      platform: 'macos',
      artifacts: [{ name: 'app', path: app }],
      artifactAttestationClaim: attestation([
        {
          name: 'app',
          sha256: createHash('sha256').update('app').digest('hex'),
          size: 3,
        },
      ]),
    }),
  );
  const admission = run(
    'admit',
    put('plan2.json', plan),
    put('downloads.json', {
      android: { apk: { path: apk } },
      macos: { app: { path: app } },
    }),
    put('android.json', android),
    put('macos.json', macos),
  );
  // Each platform begins its own state from the admission and records only
  // its own claim; finalize joins one state per platform (#1774).
  const started = put(
    'started.json',
    run('begin-promotion', put('admission.json', admission)),
  );
  const a = run(
    'promotion-receipt',
    started,
    put('a.json', success('android')),
  );
  const m = run('promotion-receipt', started, put('m.json', success('macos')));
  const aState = put('a-state.json', a);
  const mState = put('m-state.json', m);
  expect(run('finalize', aState, mState).state).toBe('ready_for_verification');
  const partial = spawnSync(
    process.execPath,
    [join(process.cwd(), 'scripts/release-cohort.mjs'), 'finalize', aState],
    { encoding: 'utf8', windowsHide: true },
  );
  expect(partial.status).toBe(1);
  expect(partial.stderr).toContain(
    'exactly one provider claim per required platform',
  );
  const invalid = spawnSync(
    process.execPath,
    [join(process.cwd(), 'scripts/release-cohort.mjs'), 'plan'],
    { encoding: 'utf8', windowsHide: true },
  );
  expect(invalid.status).toBe(1);
  expect(invalid.stderr).toContain('usage:');
});

test('artifact input records downloaded paths in the admission reader shape', () => {
  const root = mkdtempSync(join(tmpdir(), 'station-cohort-artifacts-'));
  roots.push(root);
  const destination = join(root, 'artifacts.json');
  const android = join(root, 'station.aab');
  const macos = join(root, 'station.dmg');
  writeFileSync(android, 'android');
  writeFileSync(macos, 'macos');

  const result = spawnSync(
    process.execPath,
    [
      join(process.cwd(), 'scripts/release-cohort-workflow.mjs'),
      'artifact-input',
      destination,
      `android=station.aab=${android}`,
      `macos=station.dmg=${macos}`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );

  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(destination, 'utf8'))).toEqual({
    android: { 'station.aab': { path: android } },
    macos: { 'station.dmg': { path: macos } },
  });

  const plan = createCohortPlan(input());
  const record = (name: string, path: string) => ({
    name,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    size: readFileSync(path).length,
  });
  const androidReceipt = createStageReceipt(plan, {
    platform: 'android',
    artifacts: [{ name: 'station.aab', bytes: readFileSync(android) }],
    artifactAttestationClaim: attestation([record('station.aab', android)]),
  });
  const macosReceipt = createStageReceipt(plan, {
    platform: 'macos',
    artifacts: [{ name: 'station.dmg', bytes: readFileSync(macos) }],
    artifactAttestationClaim: attestation([record('station.dmg', macos)]),
  });
  const planPath = join(root, 'plan.json');
  const androidReceiptPath = join(root, 'android-receipt.json');
  const macosReceiptPath = join(root, 'macos-receipt.json');
  writeFileSync(planPath, JSON.stringify(plan));
  writeFileSync(androidReceiptPath, JSON.stringify(androidReceipt));
  writeFileSync(macosReceiptPath, JSON.stringify(macosReceipt));

  const admission = spawnSync(
    process.execPath,
    [
      join(process.cwd(), 'scripts/release-cohort.mjs'),
      'admit',
      planPath,
      destination,
      androidReceiptPath,
      macosReceiptPath,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  expect(admission.status, admission.stderr).toBe(0);
  expect(JSON.parse(admission.stdout)).toMatchObject({
    kind: 'station.release-cohort-admission/v1',
    state: 'staged',
  });
});

test("recovery receipt is content-bound, discloses each platform's own claim, and validates an owner-placed halt tag", () => {
  const root = mkdtempSync(join(tmpdir(), 'station-cohort-recovery-'));
  roots.push(root);
  const { plan, admission } = fixture();
  const planPath = join(root, 'plan.json');
  const resultsPath = join(root, 'results.json');
  const receiptPath = join(root, 'recovery.json');
  writeFileSync(planPath, JSON.stringify(plan));
  const results = (overrides: Record<string, string>) => {
    writeFileSync(
      resultsPath,
      JSON.stringify({
        'promotion-fence': 'success',
        'promote-android': 'success',
        'promote-macos': 'success',
        'protected-finalize': 'success',
        'record-native-completion': 'failure',
        'final-attestation': 'success',
        'app-token': 'success',
        ledger: 'failure',
        tag: 'skipped',
        'promotion-fence-clear': 'success',
        ...overrides,
      }),
    );
    return resultsPath;
  };
  const absent = join(root, 'absent.json');
  const androidState = join(root, 'promotion-android-state.json');
  const androidStateBytes = JSON.stringify(
    recordProviderPromotion(beginPromotion(admission), success('android')),
  );
  writeFileSync(androidState, androidStateBytes);
  const recovery = (resultsFile: string, android = absent, macos = absent) =>
    spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'scripts/release-cohort-workflow.mjs'),
        'recovery-receipt',
        receiptPath,
        sourceSha,
        '112061',
        planPath,
        resultsFile,
        absent,
        absent,
        absent,
        absent,
        android,
        macos,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
  const result = recovery(results({}), androidState);
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  expect(receipt).toMatchObject({
    state: 'incomplete',
    cohortId: plan.cohortId,
    sourceSha,
    platforms: {
      android: {
        jobResult: 'success',
        claim: 'reported_success',
        state: 'REPORTED',
        claimDigest: `sha256:${createHash('sha256').update(androidStateBytes).digest('hex')}`,
      },
      // The job ran (success) and left no state: its effect may be live.
      macos: {
        jobResult: 'success',
        claim: 'absent',
        state: 'NOT_VERIFIED',
        claimDigest: null,
      },
    },
    completion: {
      providerFinality: 'confirmed',
      // Ledger failed and the marker was skipped: no durable write landed.
      durableCompletion: 'not-recorded',
      finalAttestation: 'success',
      appToken: 'success',
      ledger: 'failure',
      tag: 'skipped',
      promotionFence: 'success',
    },
    fence: { outcome: 'success' },
  });
  // The receipt tells the truth about what follows it (#1774): no lock was
  // written, the next Nightly plans normally, and the lock is an owner's
  // choice.
  expect(receipt.recoveryAction).toContain('No lock was written');
  expect(receipt.recoveryAction).toContain('next Nightly plans normally');
  expect(receipt.recoveryAction).toContain('an owner may place');
  expect(receipt.recoveryAction).not.toMatch(/must .*remove/);
  expect(receipt.recoveryAction).not.toContain('re-plans');
  // Durable completion is derived from the record job's durable writes
  // (ledger, marker), not from its overall result.
  const completionOf = (overrides: Record<string, string>) => {
    const run = recovery(results(overrides));
    expect(run.status, run.stderr).toBe(0);
    return JSON.parse(readFileSync(receiptPath, 'utf8')).completion
      .durableCompletion;
  };
  expect(completionOf({ 'record-native-completion': 'skipped' })).toBe(
    'not-recorded',
  );
  expect(
    completionOf({ 'final-attestation': 'failure', 'app-token': 'skipped' }),
  ).toBe('not-recorded');
  expect(completionOf({ ledger: 'success', tag: 'failure' })).toBe('partial');
  expect(completionOf({ ledger: 'failure', tag: 'success' })).toBe('partial');
  expect(
    completionOf({
      'promote-android': 'failure',
      'record-native-completion': 'success',
      ledger: 'success',
      tag: 'skipped',
    }),
  ).toBe('recorded');
  expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toMatchObject({
    platforms: {
      android: { jobResult: 'failure', claim: 'absent', state: 'NOT_VERIFIED' },
    },
    completion: { tag: 'skipped' },
  });
  // Only a platform whose job never ran is NOT_PUBLISHED.
  expect(
    recovery(results({ 'promote-android': 'skipped' }), absent).status,
  ).toBe(0);
  expect(JSON.parse(readFileSync(receiptPath, 'utf8')).platforms).toMatchObject(
    {
      android: {
        jobResult: 'skipped',
        claim: 'absent',
        state: 'NOT_PUBLISHED',
      },
    },
  );
  const notAttemptedState = join(root, 'promotion-android-not-attempted.json');
  writeFileSync(
    notAttemptedState,
    JSON.stringify(
      recordProviderPromotion(
        beginPromotion(admission),
        unresolved('android', 'not_attempted'),
      ),
    ),
  );
  expect(recovery(results({}), notAttemptedState).status).toBe(0);
  expect(JSON.parse(readFileSync(receiptPath, 'utf8')).platforms).toMatchObject(
    {
      android: { claim: 'not_attempted', state: 'NOT_PUBLISHED' },
    },
  );
  const unknownState = join(root, 'promotion-android-unknown.json');
  writeFileSync(
    unknownState,
    JSON.stringify(
      recordProviderPromotion(beginPromotion(admission), unresolved('android')),
    ),
  );
  expect(recovery(results({}), unknownState).status).toBe(0);
  expect(JSON.parse(readFileSync(receiptPath, 'utf8')).platforms).toMatchObject(
    {
      android: { claim: 'unknown', state: 'NOT_VERIFIED' },
    },
  );
  // A night on which every chain job succeeded has nothing to disclose; a
  // failed fence clear alone is something to disclose.
  const allGreen = {
    'record-native-completion': 'success',
    ledger: 'success',
    tag: 'success',
  };
  const green = recovery(results(allGreen));
  expect(green.status).toBe(1);
  expect(green.stderr).toContain('nothing to disclose');
  expect(
    recovery(results({ ...allGreen, 'promotion-fence-clear': 'failure' }))
      .status,
  ).toBe(0);
  expect(JSON.parse(readFileSync(receiptPath, 'utf8')).fence).toEqual({
    ref: 'refs/tags/nightly-promotion-fence',
    outcome: 'failure',
  });
  // A state file that is not that platform's own claim is refused.
  expect(recovery(results({}), absent, androidState).status).toBe(1);
  expect(recovery(results({}), androidState).status, 'restore').toBe(0);
  const message = spawnSync(
    process.execPath,
    [
      join(process.cwd(), 'scripts/release-cohort-workflow.mjs'),
      'canonical-recovery-message',
      receiptPath,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  expect(message.status, message.stderr).toBe(0);
  const tagPath = join(root, 'tag.json');
  writeFileSync(
    tagPath,
    JSON.stringify({
      tag: 'nightly-recovery-lock',
      type: 'commit',
      object: { type: 'commit', sha: sourceSha },
      message: message.stdout,
    }),
  );
  // The plan-time validator still accepts a lock an owner placed from this
  // receipt's canonical message, and refuses a tampered one.
  const tag = spawnSync(
    process.execPath,
    [
      join(process.cwd(), 'scripts/release-cohort-workflow.mjs'),
      'assert-recovery-tag-object',
      tagPath,
      sourceSha,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  expect(tag.status, tag.stderr).toBe(0);
  receipt.completion.ledger = 'success';
  writeFileSync(
    tagPath,
    JSON.stringify({
      ...JSON.parse(readFileSync(tagPath, 'utf8')),
      message: JSON.stringify(receipt),
    }),
  );
  const malformed = spawnSync(
    process.execPath,
    [
      join(process.cwd(), 'scripts/release-cohort-workflow.mjs'),
      'assert-recovery-tag-object',
      tagPath,
      sourceSha,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  expect(malformed.status).toBe(1);
});

test('promotion fence is canonical, content-bound, and validates its annotated tag object', () => {
  const root = mkdtempSync(join(tmpdir(), 'station-cohort-fence-'));
  roots.push(root);
  const { plan, admission } = fixture();
  const planPath = join(root, 'plan.json');
  const admissionPath = join(root, 'admission.json');
  const fencePath = join(root, 'fence.json');
  writeFileSync(planPath, JSON.stringify(plan));
  writeFileSync(admissionPath, JSON.stringify(admission));
  const command = join(process.cwd(), 'scripts/release-cohort-workflow.mjs');
  const fence = spawnSync(
    process.execPath,
    [command, 'promotion-fence', fencePath, planPath, admissionPath],
    { encoding: 'utf8', windowsHide: true },
  );
  expect(fence.status, fence.stderr).toBe(0);
  const message = spawnSync(
    process.execPath,
    [command, 'canonical-promotion-fence-message', fencePath],
    { encoding: 'utf8', windowsHide: true },
  );
  expect(message.status, message.stderr).toBe(0);
  const tagPath = join(root, 'tag.json');
  writeFileSync(
    tagPath,
    JSON.stringify({
      tag: 'nightly-promotion-fence',
      object: { type: 'commit', sha: sourceSha },
      message: message.stdout,
    }),
  );
  const valid = spawnSync(
    process.execPath,
    [
      command,
      'assert-promotion-fence-tag-object',
      tagPath,
      planPath,
      admissionPath,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  expect(valid.status, valid.stderr).toBe(0);
  const staleAdmission = {
    ...admission,
    admissionContentDigest: '0'.repeat(64),
  };
  writeFileSync(admissionPath, JSON.stringify(staleAdmission));
  const mismatched = spawnSync(
    process.execPath,
    [
      command,
      'assert-promotion-fence-tag-object',
      tagPath,
      planPath,
      admissionPath,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  expect(mismatched.status).toBe(1);
});

describe('final receipt disclosure (#1774)', () => {
  const command = join(process.cwd(), 'scripts/release-cohort-workflow.mjs');
  const digestOf = (base: any) =>
    `sha256:${createHash('sha256').update(canonicalJson(base)).digest('hex')}`;
  const complete = (provider: string) => ({
    state: 'complete',
    provider,
    claimDigest: `sha256:${'c'.repeat(64)}`,
  });
  // Derived: an `unknown` claim (job ran) is NOT_VERIFIED; only a
  // `not_attempted` claim (job never ran) is NOT_PUBLISHED.
  const unpublished = (
    platform: string,
    reason = `${platform} provider outcome unknown: unresolved:run:1:${platform}`,
    outcome: 'unknown' | 'not_attempted' = 'unknown',
  ) => ({
    state: outcome === 'unknown' ? 'NOT_VERIFIED' : 'NOT_PUBLISHED',
    outcome,
    reason,
    claimDigest: `sha256:${'d'.repeat(64)}`,
  });
  const receipt = (
    state: string,
    platforms: any,
    providers: any[],
    tamper: (value: any) => void = () => {},
  ) => {
    const base: any = {
      kind: 'station.release-cohort-final/v1',
      state,
      candidateContentDigest: 'e'.repeat(64),
      cohortId: 'cohort-fixture',
      sourceSha,
      authenticatedWorkflowRunId: '112061',
      versionIdentities: input().versionIdentities,
      platforms,
      artifacts: [],
      providers,
      verifier: { workflowIdentity: 'fixture' },
    };
    const value = { ...base, finalContentDigest: digestOf(base) };
    tamper(value);
    return value;
  };
  const run = (verb: string, value: any) => {
    const root = mkdtempSync(join(tmpdir(), 'station-cohort-final-'));
    roots.push(root);
    const path = join(root, 'final.json');
    writeFileSync(path, JSON.stringify(value));
    return spawnSync(process.execPath, [command, verb, path, sourceSha], {
      encoding: 'utf8',
      windowsHide: true,
    });
  };
  const partial = receipt(
    'partial',
    { android: complete('google-play'), macos: unpublished('macos') },
    [{ provider: 'google-play' }],
  );
  const full = receipt(
    'complete',
    { android: complete('google-play'), macos: complete('github-releases') },
    [{ provider: 'google-play' }, { provider: 'github-releases' }],
  );

  test('assert-final accepts complete and partial receipts and prints one note per unpublished platform', () => {
    for (const value of [partial, full]) {
      const result = run('assert-final', value);
      expect(result.status, result.stderr).toBe(0);
    }
    const notes = run('final-platform-notes', partial);
    expect(notes.status, notes.stderr).toBe(0);
    expect(notes.stdout).toBe(
      'macos: NOT_VERIFIED (macos provider outcome unknown: unresolved:run:1:macos)\n',
    );
    const neverRan = receipt(
      'partial',
      {
        android: complete('google-play'),
        macos: unpublished('macos', 'macos job skipped', 'not_attempted'),
      },
      [{ provider: 'google-play' }],
    );
    expect(run('assert-final', neverRan).status).toBe(0);
    expect(run('final-platform-notes', neverRan).stdout).toBe(
      'macos: NOT_PUBLISHED (macos job skipped)\n',
    );
    const none = run('final-platform-notes', full);
    expect(none.status, none.stderr).toBe(0);
    expect(none.stdout).toBe('');
    const macosOnly = receipt(
      'partial',
      { android: unpublished('android'), macos: complete('github-releases') },
      [{ provider: 'github-releases' }],
    );
    expect(run('assert-final', macosOnly).status).toBe(0);
    expect(run('final-platform-notes', macosOnly).stdout).toMatch(
      /^android: NOT_VERIFIED \(/,
    );
  });

  test('assert-final refuses a receipt that claims what the verifier did not verify', () => {
    const cases: Array<[string, any, string]> = [
      [
        'zero published platforms',
        receipt(
          'partial',
          { android: unpublished('android'), macos: unpublished('macos') },
          [],
        ),
        'at least one published platform',
      ],
      [
        'an unpublished platform without a reason',
        receipt(
          'partial',
          {
            android: complete('google-play'),
            macos: unpublished('macos', ' '),
          },
          [{ provider: 'google-play' }],
        ),
        'NOT_VERIFIED without a reason',
      ],
      [
        'NOT_PUBLISHED asserted over an unknown claim (the job ran)',
        receipt(
          'partial',
          {
            android: complete('google-play'),
            macos: { ...unpublished('macos'), state: 'NOT_PUBLISHED' },
          },
          [{ provider: 'google-play' }],
        ),
        'macos NOT_PUBLISHED is not derived from its claim outcome unknown',
      ],
      [
        'NOT_VERIFIED asserted over a not_attempted claim',
        receipt(
          'partial',
          {
            android: complete('google-play'),
            macos: {
              ...unpublished('macos', 'skipped', 'not_attempted'),
              state: 'NOT_VERIFIED',
            },
          },
          [{ provider: 'google-play' }],
        ),
        'macos NOT_VERIFIED is not derived from its claim outcome not_attempted',
      ],
      [
        'a platform marked complete with no provider observation',
        receipt(
          'complete',
          {
            android: complete('google-play'),
            macos: complete('github-releases'),
          },
          [{ provider: 'google-play' }],
        ),
        'marks macos complete without exactly one github-releases observation',
      ],
      [
        'a provider observation for an unpublished platform',
        receipt(
          'partial',
          { android: complete('google-play'), macos: unpublished('macos') },
          [{ provider: 'google-play' }, { provider: 'github-releases' }],
        ),
        'carries a github-releases observation for unverified macos',
      ],
      [
        'state complete while a platform is unpublished',
        receipt(
          'complete',
          { android: complete('google-play'), macos: unpublished('macos') },
          [{ provider: 'google-play' }],
        ),
        'state complete is not its derived partial',
      ],
      [
        'state partial while every platform is complete',
        receipt(
          'partial',
          {
            android: complete('google-play'),
            macos: complete('github-releases'),
          },
          [{ provider: 'google-play' }, { provider: 'github-releases' }],
        ),
        'state partial is not its derived complete',
      ],
      [
        'a missing platform',
        receipt('partial', { android: complete('google-play') }, [
          { provider: 'google-play' },
        ]),
        'does not disclose every required platform',
      ],
      [
        'an unrecognized platform state',
        receipt(
          'partial',
          { android: complete('google-play'), macos: { state: 'pending' } },
          [{ provider: 'google-play' }],
        ),
        'no disclosed state for macos',
      ],
      [
        'a tampered digest',
        receipt(
          'partial',
          { android: complete('google-play'), macos: unpublished('macos') },
          [{ provider: 'google-play' }],
          (value) => {
            value.platforms.macos.state = 'complete';
          },
        ),
        'not an exact-source cohort receipt',
      ],
      [
        'a different source',
        receipt(
          'partial',
          { android: complete('google-play'), macos: unpublished('macos') },
          [{ provider: 'google-play' }],
          (value) => {
            value.sourceSha = 'b'.repeat(40);
            value.finalContentDigest = digestOf(
              (({ finalContentDigest, ...base }) => base)(value),
            );
          },
        ),
        'not an exact-source cohort receipt',
      ],
    ];
    for (const [label, value, message] of cases) {
      const result = run('assert-final', value);
      expect(result.status, label).toBe(1);
      expect(result.stderr, label).toContain(message);
      expect(run('final-platform-notes', value).status, label).toBe(1);
    }
  });
});

test('the documented owner lock recipe produces a tag object the plan-time validator accepts (#1774)', () => {
  // docs/guides/native-releases.md tells an owner to create the lock with
  // `git tag -a --cleanup=verbatim -F <file>`; `-m` would append a newline
  // and the validator requires the canonical message byte for byte. This
  // builds the tag exactly as documented, in a scratch repository, and
  // validates the stored object the way planning validates the REST one.
  const root = mkdtempSync(join(tmpdir(), 'station-cohort-lock-recipe-'));
  roots.push(root);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'owner',
        GIT_AUTHOR_EMAIL: 'owner@example.test',
        GIT_COMMITTER_NAME: 'owner',
        GIT_COMMITTER_EMAIL: 'owner@example.test',
      },
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'source');
  const lockedSource = git('rev-parse', 'HEAD').trim();
  const command = join(process.cwd(), 'scripts/release-cohort-workflow.mjs');
  const planPath = join(root, 'plan.json');
  writeFileSync(
    planPath,
    JSON.stringify(createCohortPlan(input({ sourceSha: lockedSource }))),
  );
  const resultsPath = join(root, 'results.json');
  writeFileSync(
    resultsPath,
    JSON.stringify({
      'promote-android': 'failure',
      'promote-macos': 'success',
    }),
  );
  const receiptPath = join(root, 'native-cohort-recovery.json');
  const absent = join(root, 'absent.json');
  const built = spawnSync(
    process.execPath,
    [
      command,
      'recovery-receipt',
      receiptPath,
      lockedSource,
      '112061',
      planPath,
      resultsPath,
      ...Array(6).fill(absent),
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  expect(built.status, built.stderr).toBe(0);
  const message = spawnSync(
    process.execPath,
    [command, 'canonical-recovery-message', receiptPath],
    { encoding: 'utf8', windowsHide: true },
  );
  expect(message.status, message.stderr).toBe(0);
  const messagePath = join(root, 'lock-message.json');
  writeFileSync(messagePath, message.stdout);
  git(
    'tag',
    '-a',
    '--cleanup=verbatim',
    '-F',
    messagePath,
    'nightly-recovery-lock',
    lockedSource,
  );
  // Read the stored object back as git holds it: headers, blank line, then
  // the message verbatim — the same fields the REST tag object carries.
  const object = git('cat-file', '-p', 'refs/tags/nightly-recovery-lock');
  const divider = object.indexOf('\n\n');
  const headers = Object.fromEntries(
    object
      .slice(0, divider)
      .split('\n')
      .map((line) => [
        line.slice(0, line.indexOf(' ')),
        line.slice(line.indexOf(' ') + 1),
      ]),
  );
  const storedMessage = object.slice(divider + 2);
  expect(storedMessage).toBe(message.stdout);
  const tagPath = join(root, 'tag.json');
  writeFileSync(
    tagPath,
    JSON.stringify({
      tag: headers.tag,
      object: { type: headers.type, sha: headers.object },
      message: storedMessage,
    }),
  );
  const accepted = spawnSync(
    process.execPath,
    [command, 'assert-recovery-tag-object', tagPath, lockedSource],
    { encoding: 'utf8', windowsHide: true },
  );
  expect(accepted.status, accepted.stderr).toBe(0);
  // The plain `-m` form the recipe warns against stores a trailing newline
  // and is refused, which is why the recipe says `--cleanup=verbatim -F`.
  git('tag', '-a', '-m', message.stdout, 'lock-with-m', lockedSource);
  const withNewline = git('cat-file', '-p', 'refs/tags/lock-with-m');
  writeFileSync(
    tagPath,
    JSON.stringify({
      tag: 'nightly-recovery-lock',
      object: { type: 'commit', sha: lockedSource },
      message: withNewline.slice(withNewline.indexOf('\n\n') + 2),
    }),
  );
  const refused = spawnSync(
    process.execPath,
    [command, 'assert-recovery-tag-object', tagPath, lockedSource],
    { encoding: 'utf8', windowsHide: true },
  );
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain('not canonical recovery JSON');
});

describe('Windows joins desktop publication', () => {
  test('a three-platform plan refuses omission and admits every exact artifact', () => {
    const plan = createCohortPlan(
      input({ requiredPlatforms: ['android', 'macos', 'windows'] }),
    );
    const files = Object.fromEntries(
      plan.requiredPlatforms.map((platform: string) => [
        platform,
        { artifact: Buffer.from(platform) },
      ]),
    );
    const receipts = plan.requiredPlatforms.map((platform: string) => {
      const bytes = files[platform].artifact;
      return createStageReceipt(plan, {
        platform,
        artifacts: [{ name: 'artifact', bytes }],
        artifactAttestationClaim: attestation([
          {
            name: 'artifact',
            size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ]),
      });
    });
    expect(() => admitCohort(plan, receipts.slice(0, 2), files)).toThrow();
    const admission = admitCohort(plan, receipts, files);
    expect(admission.plan.requiredPlatforms).toEqual([
      'android',
      'macos',
      'windows',
    ]);
    const states = plan.requiredPlatforms.map((platform: string) =>
      recordProviderPromotion(beginPromotion(admission), {
        platform,
        outcome: 'reported_success',
        providerEvidenceClaim: {
          provider: platform === 'android' ? 'google-play' : 'github-releases',
          immutableReference: `${platform}:1`,
          queryReceiptDigest: `sha256:${'b'.repeat(64)}`,
          cohortId: plan.cohortId,
          sourceSha,
        },
      }),
    );
    expect(() => finalizeCohort(states.slice(0, 2))).toThrow();
    expect(
      finalizeCohort(states).providerClaims.map(
        (claim: { platform: string }) => claim.platform,
      ),
    ).toEqual(['android', 'macos', 'windows']);
  });
});

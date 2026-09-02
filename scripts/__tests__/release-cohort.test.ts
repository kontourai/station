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
} from '../release-cohort.mjs';

const sourceSha = 'a'.repeat(40);
const attestation = (records: any[]) => ({
  authority: 'github-artifact-attestation',
  repository: 'kontourai/station',
  workflowRef: `.github/workflows/nightly-native-cohort.yml@${sourceSha}`,
  runId: '112061',
  subjectDigest: `sha256:${createHash('sha256').update(canonicalJson(records)).digest('hex')}`,
  verificationReference: 'github:attestation:immutable:1',
});
const evidence = (platform: 'android' | 'macos') => ({
  provider: platform === 'android' ? 'google-play' : 'github-releases',
  immutableReference: `${platform}:receipt:1`,
  queryReceiptDigest: `sha256:${'b'.repeat(64)}`,
  cohortId: createCohortPlan(input()).cohortId,
  sourceSha,
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
    releaseMode: 'atomic',
    requiredReceipt: 'provider-backed',
    externalEvidenceAuthority: 'github-artifact-attestation',
  },
  requiredPlatforms: ['macos', 'android'],
  ...overrides,
});
function fixture() {
  const plan = createCohortPlan(input());
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
  test('binds all plan facts, policy, platforms, order, and identities', () => {
    const p = createCohortPlan(input());
    expect(p.requiredPlatforms).toEqual(['android', 'macos']);
    expect(p.promotionOrder).toEqual(['android', 'macos']);
    p.promotionOrder.reverse();
    Reflect.set(p.availabilityPolicy, 'releaseMode', 'mutable');
    expect(createCohortPlan(input())).toMatchObject({
      promotionOrder: ['android', 'macos'],
      availabilityPolicy: { releaseMode: 'atomic' },
    });
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
        { ...p, promotionOrder: ['macos', 'android'] },
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
        (v.workflowRef = `.github/workflows/nightly-native-cohort.yml@${'b'.repeat(40)}`),
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
    expect(() =>
      recordProviderPromotion(started, {
        platform: 'macos',
        outcome: 'reported_success',
        providerEvidenceClaim: evidence('macos'),
      }),
    ).toThrow('expected android');
  });

  test('serializes promotion and rejects forged terminal or stale state content', () => {
    const started = beginPromotion(fixture().admission);
    expect(() =>
      recordProviderPromotion(started, {
        platform: 'macos',
        outcome: 'reported_success',
        providerEvidenceClaim: evidence('macos'),
      }),
    ).toThrow('expected android');
    const android = recordProviderPromotion(started, {
      platform: 'android',
      outcome: 'reported_success',
      providerEvidenceClaim: evidence('android'),
    });
    const candidate = finalizeCohort(
      recordProviderPromotion(android, {
        platform: 'macos',
        outcome: 'reported_success',
        providerEvidenceClaim: evidence('macos'),
      }),
    );
    expect(candidate).toMatchObject({
      kind: 'station.release-cohort-verification-candidate/v1',
      state: 'ready_for_verification',
    });
    expect(() => finalizeCohort(candidate)).toThrow(
      'does not accept state ready_for_verification',
    );
    expect(() =>
      recordProviderPromotion(
        { ...android, promotionReceipts: [] },
        {
          platform: 'android',
          outcome: 'reported_success',
          providerEvidenceClaim: evidence('android'),
        },
      ),
    ).toThrow('canonical');
  });

  test('reported absence and unknown require recovery and cannot authorize retry', () => {
    const started = beginPromotion(fixture().admission);
    const absent = recordProviderPromotion(started, {
      platform: 'android',
      outcome: 'reported_absent',
      providerEvidenceClaim: evidence('android'),
      recoveryAction: 'retry upload',
    });
    const absentRecovery = finalizeCohort(absent);
    expect(absentRecovery).toMatchObject({
      state: 'partial_recovery_required',
      reason: 'android was reported absent and remains unverified.',
    });
    expect(() => beginPromotion(absentRecovery)).toThrow(
      'only a fresh staged admission',
    );
    const unknown = recordProviderPromotion(started, {
      platform: 'android',
      outcome: 'unknown',
      providerEvidenceClaim: evidence('android'),
      recoveryAction: 'investigate provider',
    });
    const unknownRecovery = finalizeCohort(unknown);
    expect(unknownRecovery.state).toBe('partial_recovery_required');
    expect(() => beginPromotion(unknownRecovery)).toThrow(
      'only a fresh staged admission',
    );
    expect(() =>
      recordProviderPromotion(unknown, {
        platform: 'macos',
        outcome: 'reported_success',
        providerEvidenceClaim: evidence('macos'),
      }),
    ).toThrow('cannot continue');
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
  const started = run('begin-promotion', put('admission.json', admission));
  const a = run(
    'promotion-receipt',
    put('started.json', started),
    put('a.json', {
      platform: 'android',
      outcome: 'reported_success',
      providerEvidenceClaim: evidence('android'),
    }),
  );
  const m = run(
    'promotion-receipt',
    put('a-state.json', a),
    put('m.json', {
      platform: 'macos',
      outcome: 'reported_success',
      providerEvidenceClaim: evidence('macos'),
    }),
  );
  expect(run('finalize', put('m-state.json', m)).state).toBe(
    'ready_for_verification',
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

test('recovery receipt is content-bound and makes confirmed provider finality distinct from partial durability', () => {
  const root = mkdtempSync(join(tmpdir(), 'station-cohort-recovery-'));
  roots.push(root);
  const plan = createCohortPlan(input());
  const planPath = join(root, 'plan.json');
  const resultsPath = join(root, 'results.json');
  const receiptPath = join(root, 'recovery.json');
  writeFileSync(planPath, JSON.stringify(plan));
  writeFileSync(
    resultsPath,
    JSON.stringify({
      'plan-cohort': 'success',
      'promote-android': 'success',
      'promote-macos': 'success',
      'protected-finalize': 'success',
      'record-native-completion': 'failure',
      'final-attestation': 'success',
      'app-token': 'success',
      ledger: 'failure',
      tag: 'skipped',
    }),
  );
  const absent = join(root, 'absent.json');
  const result = spawnSync(
    process.execPath,
    [
      join(process.cwd(), 'scripts/release-cohort-workflow.mjs'),
      'recovery-receipt',
      receiptPath,
      sourceSha,
      '112061',
      planPath,
      resultsPath,
      absent,
      absent,
      absent,
      absent,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  expect(result.status, result.stderr).toBe(0);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  expect(receipt).toMatchObject({
    cohortId: plan.cohortId,
    sourceSha,
    completion: {
      providerFinality: 'confirmed',
      durableCompletion: 'partial',
      finalAttestation: 'success',
      appToken: 'success',
      ledger: 'failure',
      tag: 'skipped',
    },
  });
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

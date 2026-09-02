#!/usr/bin/env node
/**
 * Deliberately small, file-based glue for the native cohort workflow.  Keeping
 * JSON construction here prevents shell interpolation from changing a
 * content-bound cohort claim.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  nightlyDayNumber,
  nightlyVersion,
} from './lib/nightly-build-identity.mjs';
import { canonicalJson } from './release-cohort.mjs';

const fail = (message) => {
  throw new Error(`release cohort workflow: ${message}`);
};
const json = (path) => JSON.parse(readFileSync(resolve(path), 'utf8'));
const write = (path, value) =>
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const required = (value, label) => {
  if (!value) fail(`${label} is required`);
  return value;
};

function identities(dateText, buildText) {
  const date = new Date(required(dateText, 'date'));
  if (Number.isNaN(date.getTime())) fail('date is invalid');
  const build = Number(required(buildText, 'build'));
  if (!Number.isSafeInteger(build) || build < 0 || build > 99)
    fail('build is invalid');
  const packageJson = json('package.json');
  const tauri = json('src-desktop/tauri.conf.json');
  const day = nightlyDayNumber(date);
  const version = nightlyVersion(packageJson.version, date, build);
  return {
    android: {
      packageName: `${tauri.identifier}.nightly`,
      versionCode: day * 100 + build,
      versionName: version,
    },
    desktop: {
      bundleVersion: String(day * 100 + build),
      releaseTag: 'nightly-desktop',
      version,
    },
  };
}

function planInput([destination, sourceSha, workflowRunId, date, build]) {
  write(destination, {
    channel: 'nightly',
    sourceSha: required(sourceSha, 'source sha'),
    workflowRunId: required(workflowRunId, 'workflow run id'),
    versionIdentities: identities(date, build),
    availabilityPolicy: {
      releaseMode: 'atomic',
      requiredReceipt: 'provider-backed',
      externalEvidenceAuthority: 'github-artifact-attestation',
    },
    requiredPlatforms: ['android', 'macos'],
  });
}

function stageInput([destination, planPath, platform, ...entries]) {
  const plan = json(planPath);
  if (!['android', 'macos'].includes(platform)) fail('platform is invalid');
  const artifacts = entries.map((entry) => {
    const divider = entry.indexOf('=');
    if (divider < 1) fail(`artifact entry is invalid: ${entry}`);
    const name = entry.slice(0, divider);
    const path = resolve(entry.slice(divider + 1));
    const bytes = readFileSync(path);
    if (!bytes.length) fail(`artifact is empty: ${name}`);
    return { name, path, sha256: sha256(bytes), size: bytes.length };
  });
  if (!artifacts.length) fail('stage receipt needs artifacts');
  const records = artifacts.map(({ name, sha256, size }) => ({
    name,
    sha256,
    size,
  }));
  write(destination, {
    platform,
    artifacts: artifacts.map(({ name, path }) => ({ name, path })),
    artifactAttestationClaim: {
      authority: 'github-artifact-attestation',
      repository: 'kontourai/station',
      workflowRef: `.github/workflows/nightly-native-cohort.yml@${plan.sourceSha}`,
      runId: plan.workflowRunId,
      subjectDigest: `sha256:${sha256(Buffer.from(canonicalJson(records)))}`,
      verificationReference: `github:attestation:${platform}:${plan.workflowRunId}`,
    },
  });
}

function artifactInput([destination, ...entries]) {
  const artifacts = {};
  for (const entry of entries) {
    const [platform, name, path] = entry.split('=', 3);
    if (!platform || !name || !path)
      fail(`artifact entry is invalid: ${entry}`);
    let platformArtifacts = artifacts[platform];
    if (!platformArtifacts) {
      platformArtifacts = {};
      artifacts[platform] = platformArtifacts;
    }
    platformArtifacts[name] = { path: resolve(path) };
  }
  write(destination, { artifacts });
}

function promotionFenceValue(value, expected = undefined) {
  const { fenceContentDigest, ...base } = value ?? {};
  if (
    value?.kind !== 'station.release-cohort-promotion-fence/v1' ||
    !/^[0-9a-f]{40}$/.test(value.sourceSha ?? '') ||
    !/^[1-9][0-9]{0,18}$/.test(value.workflowRunId ?? '') ||
    typeof value.cohortId !== 'string' ||
    !value.cohortId ||
    !/^[a-f0-9]{64}$/.test(value.planContentDigest ?? '') ||
    !/^[a-f0-9]{64}$/.test(value.admissionContentDigest ?? '') ||
    typeof fenceContentDigest !== 'string' ||
    fenceContentDigest !== `sha256:${sha256(Buffer.from(canonicalJson(base)))}`
  ) {
    fail('promotion fence is not content-bound');
  }
  if (
    expected &&
    canonicalJson({
      sourceSha: value.sourceSha,
      workflowRunId: value.workflowRunId,
      cohortId: value.cohortId,
      planContentDigest: value.planContentDigest,
      admissionContentDigest: value.admissionContentDigest,
    }) !== canonicalJson(expected)
  ) {
    fail('promotion fence does not bind the exact plan and admission');
  }
  return value;
}

function promotionFence([destination, planPath, admissionPath]) {
  const plan = json(planPath);
  const admission = json(admissionPath);
  if (
    plan?.kind !== 'station.release-cohort-plan/v1' ||
    admission?.kind !== 'station.release-cohort-admission/v1' ||
    canonicalJson(admission.plan) !== canonicalJson(plan) ||
    typeof plan.planContentDigest !== 'string' ||
    typeof admission.admissionContentDigest !== 'string'
  ) {
    fail('promotion fence requires an exact cohort plan and admission');
  }
  const base = {
    kind: 'station.release-cohort-promotion-fence/v1',
    sourceSha: plan.sourceSha,
    workflowRunId: plan.workflowRunId,
    cohortId: plan.cohortId,
    planContentDigest: plan.planContentDigest,
    admissionContentDigest: admission.admissionContentDigest,
  };
  write(destination, {
    ...base,
    fenceContentDigest: `sha256:${sha256(Buffer.from(canonicalJson(base)))}`,
  });
}

function canonicalPromotionFenceMessage([fencePath]) {
  const fence = json(fencePath);
  promotionFenceValue(fence);
  process.stdout.write(canonicalJson(fence));
}

function assertPromotionFenceTagObject([tagPath, planPath, admissionPath]) {
  const tag = json(tagPath);
  if (
    tag?.tag !== 'nightly-promotion-fence' ||
    tag.object?.type !== 'commit' ||
    !/^[0-9a-f]{40}$/.test(tag.object?.sha ?? '') ||
    typeof tag.message !== 'string'
  ) {
    fail('promotion fence tag object is invalid');
  }
  let fence;
  try {
    fence = JSON.parse(tag.message);
  } catch {
    fail('promotion fence tag object does not contain fence JSON');
  }
  const expected =
    planPath && admissionPath
      ? (() => {
          const plan = json(planPath);
          const admission = json(admissionPath);
          if (canonicalJson(admission?.plan) !== canonicalJson(plan))
            fail('promotion fence expected plan and admission do not match');
          return {
            sourceSha: plan.sourceSha,
            workflowRunId: plan.workflowRunId,
            cohortId: plan.cohortId,
            planContentDigest: plan.planContentDigest,
            admissionContentDigest: admission.admissionContentDigest,
          };
        })()
      : undefined;
  promotionFenceValue(fence, expected);
  if (tag.object.sha !== fence.sourceSha)
    fail('promotion fence tag object does not bind its source');
  if (tag.message !== canonicalJson(fence))
    fail('promotion fence tag message is not canonical fence JSON');
}

function providerClaim([destination, planPath, platform, observationPath]) {
  const plan = json(planPath);
  let observation = json(observationPath);
  const provider = platform === 'android' ? 'google-play' : 'github-releases';
  // GitHub's release API is the structural readback itself. Normalize only
  // the authenticated facts needed by the state machine; finalization does a
  // second exact inventory/tag observation in the protected verifier.
  if (platform === 'macos' && observation.provider === undefined) {
    if (
      observation.tag_name !== plan.versionIdentities.desktop.releaseTag ||
      observation.draft !== false ||
      observation.prerelease !== true ||
      !Number.isSafeInteger(observation.id) ||
      observation.id < 1 ||
      !Array.isArray(observation.assets) ||
      observation.assets.length !== 4
    ) {
      fail(
        'GitHub release readback is not the expected public rolling release',
      );
    }
    observation = {
      provider,
      immutableReference: `github-release:${observation.id}`,
      rawResponseDigest: `sha256:${sha256(Buffer.from(canonicalJson(observation)))}`,
    };
  }
  if (observation.provider !== provider)
    fail('provider observation is invalid');
  write(destination, {
    platform,
    outcome: 'reported_success',
    providerEvidenceClaim: {
      provider,
      immutableReference: required(
        observation.immutableReference,
        'provider immutable reference',
      ),
      queryReceiptDigest: required(
        observation.rawResponseDigest,
        'provider query receipt digest',
      ),
      cohortId: plan.cohortId,
      sourceSha: plan.sourceSha,
    },
  });
}

function unknownClaim([destination, planPath, platform, reference]) {
  const plan = json(planPath);
  const provider = platform === 'android' ? 'google-play' : 'github-releases';
  const claim = {
    platform,
    outcome: 'unknown',
    providerEvidenceClaim: {
      provider,
      immutableReference: `unresolved:${required(reference, 'observation reference')}`,
      queryReceiptDigest: `sha256:${sha256(Buffer.from(reference))}`,
      cohortId: plan.cohortId,
      sourceSha: plan.sourceSha,
    },
    recoveryAction: `Do not rerun promotion; inspect ${reference} and reconcile the provider before retrying.`,
  };
  write(destination, claim);
}

function readOptional(path) {
  try {
    return readFileSync(resolve(path));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function recoveryReceipt([
  destination,
  sourceSha,
  workflowRunId,
  planPath,
  jobResultsPath,
  admissionPath,
  candidatePath,
  playObservationPath,
  githubReleaseObservationPath,
]) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? ''))
    fail('recovery source sha is invalid');
  if (!/^[1-9][0-9]{0,18}$/.test(workflowRunId ?? ''))
    fail('recovery workflow run id is invalid');
  const jobResults = json(jobResultsPath);
  if (
    !jobResults ||
    typeof jobResults !== 'object' ||
    Array.isArray(jobResults) ||
    Object.values(jobResults).some((value) => typeof value !== 'string')
  ) {
    fail('recovery job results are invalid');
  }
  const planBytes = readOptional(planPath);
  let plan;
  if (planBytes) {
    try {
      plan = JSON.parse(planBytes);
    } catch {
      fail('recovery plan is not valid JSON');
    }
    if (
      plan?.kind !== 'station.release-cohort-plan/v1' ||
      plan.sourceSha !== sourceSha ||
      typeof plan.cohortId !== 'string' ||
      !plan.cohortId ||
      typeof plan.planContentDigest !== 'string'
    ) {
      fail('recovery plan is not an exact-source cohort plan');
    }
  }
  const digestFile = (path) => {
    const bytes = readOptional(path);
    return bytes ? `sha256:${sha256(bytes)}` : null;
  };
  const evidence = {
    admissionDigest: digestFile(admissionPath),
    verificationCandidateDigest: digestFile(candidatePath),
    providerReferences: {
      googlePlayObservationDigest: digestFile(playObservationPath),
      githubReleaseObservationDigest: digestFile(githubReleaseObservationPath),
    },
  };
  const finalityConfirmed = jobResults['protected-finalize'] === 'success';
  const durableCompletionPartial =
    jobResults['record-native-completion'] !== 'success';
  const base = {
    kind: 'station.release-cohort-recovery/v1',
    state: 'partial_recovery_required',
    sourceSha,
    workflowRunId,
    cohortId: plan?.cohortId ?? null,
    planContentDigest: plan?.planContentDigest ?? null,
    jobResults,
    evidence,
    completion: {
      providerFinality: finalityConfirmed ? 'confirmed' : 'unconfirmed',
      durableCompletion: durableCompletionPartial ? 'partial' : 'not-recorded',
      finalAttestation: jobResults['final-attestation'] ?? 'not-run',
      appToken: jobResults['app-token'] ?? 'not-run',
      ledger: jobResults.ledger ?? 'not-run',
      tag: jobResults.tag ?? 'not-run',
      promotionFence: jobResults['promotion-fence-clear'] ?? 'not-run',
    },
    fence: {
      ref: 'refs/tags/nightly-promotion-fence',
      outcome: jobResults['promotion-fence-clear'] ?? 'not-run',
    },
    recoveryAction:
      'Do not rerun automatically. An owner must reconcile provider, final-attestation, app-token, ledger, and tag state, then explicitly remove refs/tags/nightly-recovery-lock.',
  };
  write(destination, {
    ...base,
    recoveryContentDigest: `sha256:${sha256(Buffer.from(canonicalJson(base)))}`,
  });
}

function recoveryValue(value, sourceSha) {
  const { recoveryContentDigest, ...base } = value ?? {};
  if (
    value?.kind !== 'station.release-cohort-recovery/v1' ||
    value.state !== 'partial_recovery_required' ||
    value.sourceSha !== sourceSha ||
    typeof value.workflowRunId !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(value.workflowRunId) ||
    typeof recoveryContentDigest !== 'string' ||
    recoveryContentDigest !==
      `sha256:${sha256(Buffer.from(canonicalJson(base)))}`
  ) {
    fail('recovery receipt is not content-bound to the exact source');
  }
  return value;
}

function canonicalRecoveryMessage([receiptPath]) {
  const receipt = json(receiptPath);
  if (receipt?.kind !== 'station.release-cohort-recovery/v1')
    fail('recovery receipt kind is invalid');
  recoveryValue(receipt, receipt.sourceSha);
  process.stdout.write(canonicalJson(receipt));
}

function assertRecoveryTagObject([tagPath, sourceSha]) {
  const tag = json(tagPath);
  if (
    tag?.tag !== 'nightly-recovery-lock' ||
    tag.object?.type !== 'commit' ||
    tag.object?.sha !== sourceSha ||
    typeof tag.message !== 'string'
  ) {
    fail('recovery tag object does not bind the exact source');
  }
  let receipt;
  try {
    receipt = JSON.parse(tag.message);
  } catch {
    fail('recovery tag object does not contain recovery JSON');
  }
  recoveryValue(receipt, sourceSha);
  if (tag.message !== canonicalJson(receipt))
    fail('recovery tag message is not canonical recovery JSON');
}

function assertFinal([receiptPath, sourceSha]) {
  const receipt = json(receiptPath);
  const { finalContentDigest, ...base } = receipt;
  if (
    receipt.kind !== 'station.release-cohort-final/v1' ||
    receipt.state !== 'complete' ||
    receipt.sourceSha !== sourceSha ||
    typeof finalContentDigest !== 'string' ||
    finalContentDigest !== `sha256:${sha256(Buffer.from(canonicalJson(base)))}`
  ) {
    fail('final receipt is not a complete exact-source cohort receipt');
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'plan-input' && args.length === 5) planInput(args);
  else if (command === 'stage-input' && args.length >= 4) stageInput(args);
  else if (command === 'artifact-input' && args.length >= 2)
    artifactInput(args);
  else if (command === 'promotion-fence' && args.length === 3)
    promotionFence(args);
  else if (command === 'canonical-promotion-fence-message' && args.length === 1)
    canonicalPromotionFenceMessage(args);
  else if (
    command === 'assert-promotion-fence-tag-object' &&
    (args.length === 1 || args.length === 3)
  )
    assertPromotionFenceTagObject(args);
  else if (command === 'provider-claim' && args.length === 4)
    providerClaim(args);
  else if (command === 'unknown-claim' && args.length === 4) unknownClaim(args);
  else if (command === 'recovery-receipt' && args.length === 9)
    recoveryReceipt(args);
  else if (command === 'canonical-recovery-message' && args.length === 1)
    canonicalRecoveryMessage(args);
  else if (command === 'assert-recovery-tag-object' && args.length === 2)
    assertRecoveryTagObject(args);
  else if (command === 'assert-final' && args.length === 2) assertFinal(args);
  else fail('usage is invalid');
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

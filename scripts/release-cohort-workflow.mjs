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
      releaseMode: 'per-platform',
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
      // Staged artifacts are attested by the staging phase (#1453).
      workflowRef: `.github/workflows/nightly-native-stage.yml@${plan.sourceSha}`,
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
  // release-cohort.mjs consumes the downloaded platform map directly. Keep
  // this file in that exact reader shape so the workflow cannot accidentally
  // add a transport-only wrapper that the admission schema does not know.
  write(destination, artifacts);
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
    // Rerunning this job would re-upload the same reserved version code;
    // the next Nightly re-plans the platform with a new one (#1774).
    recoveryAction: `Do not rerun this promotion job; inspect ${reference}. The next Nightly re-plans ${platform} with a new version code.`,
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

const COHORT_PLATFORMS = Object.freeze(['android', 'macos']);
/** The jobs whose non-success makes a night incomplete (#1774). */
const COHORT_CHAIN_JOBS = Object.freeze([
  'promote-android',
  'promote-macos',
  'protected-finalize',
  'record-native-completion',
]);
const RECOVERY_STATE = 'incomplete';

/**
 * What one platform's publishing job left behind: its own job result and,
 * when its per-platform state artifact exists, the provider claim it
 * recorded. An absent state is disclosed as such rather than inferred.
 */
function platformDisclosure(platform, jobResults, statePath) {
  const bytes = readOptional(statePath);
  let claim = 'absent';
  if (bytes) {
    let state;
    try {
      state = JSON.parse(bytes);
    } catch {
      fail(`recovery ${platform} promotion state is not valid JSON`);
    }
    const receipt = state?.promotionReceipts?.[0];
    if (
      state?.kind !== 'station.release-cohort-state/v1' ||
      !Array.isArray(state.promotionReceipts) ||
      state.promotionReceipts.length !== 1 ||
      receipt?.platform !== platform ||
      typeof receipt.outcome !== 'string'
    ) {
      fail(`recovery ${platform} promotion state is not that platform's claim`);
    }
    claim = receipt.outcome;
  }
  return {
    jobResult: jobResults[`promote-${platform}`] ?? 'not-run',
    claim,
    claimDigest: bytes ? `sha256:${sha256(bytes)}` : null,
  };
}

/**
 * Discloses an incomplete native cohort run: which chain jobs did not
 * succeed, what each platform's own job recorded, and the digests of every
 * evidence file the run left behind. It is a receipt, not a lock (#1774):
 * automation never writes `refs/tags/nightly-recovery-lock`; an owner who
 * wants to halt the next Nightly places that tag with this receipt's
 * canonical message (`canonical-recovery-message`).
 */
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
  androidStatePath,
  macosStatePath,
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
  if (COHORT_CHAIN_JOBS.every((job) => jobResults[job] === 'success'))
    fail('every cohort chain job succeeded; there is nothing to disclose');
  const platforms = Object.fromEntries(
    COHORT_PLATFORMS.map((platform) => [
      platform,
      platformDisclosure(
        platform,
        jobResults,
        platform === 'android' ? androidStatePath : macosStatePath,
      ),
    ]),
  );
  const finalityConfirmed = jobResults['protected-finalize'] === 'success';
  const recordResult = jobResults['record-native-completion'] ?? 'not-run';
  const durableCompletion =
    recordResult === 'success'
      ? 'recorded'
      : ['skipped', 'not-run'].includes(recordResult)
        ? 'not-recorded'
        : 'partial';
  const base = {
    kind: 'station.release-cohort-recovery/v1',
    state: RECOVERY_STATE,
    sourceSha,
    workflowRunId,
    cohortId: plan?.cohortId ?? null,
    planContentDigest: plan?.planContentDigest ?? null,
    jobResults,
    platforms,
    evidence,
    completion: {
      providerFinality: finalityConfirmed ? 'confirmed' : 'unconfirmed',
      durableCompletion,
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
      'No lock was written and the next Nightly plans normally, rebuilding every platform whose marker did not advance. Inspect jobResults, platforms, evidence, and the ledger rows this run wrote. To halt future Nightlies, an owner may place refs/tags/nightly-recovery-lock with this receipt as its canonical tag message.',
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
    value.state !== RECOVERY_STATE ||
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

const PLATFORM_PROVIDER = Object.freeze({
  android: 'google-play',
  macos: 'github-releases',
});

/**
 * Reads a final receipt the protected verifier emitted and re-derives its
 * disclosed shape: `complete` means every required platform was verified as
 * published; `partial` means at least one was and every other carries a
 * NOT_PUBLISHED reason. A platform may only be `complete` when the receipt
 * carries that platform's provider observation, and vice versa (#1774).
 */
function finalReceipt(receiptPath, sourceSha) {
  const receipt = json(receiptPath);
  const { finalContentDigest, ...base } = receipt;
  if (
    receipt.kind !== 'station.release-cohort-final/v1' ||
    !['complete', 'partial'].includes(receipt.state) ||
    receipt.sourceSha !== sourceSha ||
    typeof finalContentDigest !== 'string' ||
    finalContentDigest !== `sha256:${sha256(Buffer.from(canonicalJson(base)))}`
  ) {
    fail('final receipt is not an exact-source cohort receipt');
  }
  const platforms = receipt.platforms;
  if (
    !platforms ||
    typeof platforms !== 'object' ||
    Array.isArray(platforms) ||
    canonicalJson(Object.keys(platforms).sort()) !==
      canonicalJson(COHORT_PLATFORMS) ||
    !Array.isArray(receipt.providers)
  ) {
    fail('final receipt does not disclose every required platform');
  }
  const observed = receipt.providers.map((provider) => provider?.provider);
  const shipped = [];
  for (const platform of COHORT_PLATFORMS) {
    const entry = platforms[platform];
    const provider = PLATFORM_PROVIDER[platform];
    if (entry?.state === 'complete') {
      if (
        entry.provider !== provider ||
        observed.filter((name) => name === provider).length !== 1
      )
        fail(
          `final receipt marks ${platform} complete without exactly one ${provider} observation`,
        );
      shipped.push(platform);
    } else if (entry?.state === 'NOT_PUBLISHED') {
      if (typeof entry.reason !== 'string' || !entry.reason.trim())
        fail(
          `final receipt discloses ${platform} NOT_PUBLISHED without a reason`,
        );
      if (observed.includes(provider))
        fail(
          `final receipt carries a ${provider} observation for unpublished ${platform}`,
        );
    } else {
      fail(`final receipt has no disclosed state for ${platform}`);
    }
  }
  if (!shipped.length)
    fail('final receipt must verify at least one published platform');
  const derived =
    shipped.length === COHORT_PLATFORMS.length ? 'complete' : 'partial';
  if (receipt.state !== derived)
    fail(`final receipt state ${receipt.state} is not its derived ${derived}`);
  return { receipt, shipped };
}

function assertFinal([receiptPath, sourceSha]) {
  finalReceipt(receiptPath, sourceSha);
}

/**
 * One ledger note per platform the final receipt discloses as NOT_PUBLISHED,
 * so a partial night is readable from every ledger row it did write.
 */
function finalPlatformNotes([receiptPath, sourceSha]) {
  const { receipt } = finalReceipt(receiptPath, sourceSha);
  for (const platform of COHORT_PLATFORMS) {
    const entry = receipt.platforms[platform];
    if (entry.state === 'NOT_PUBLISHED')
      process.stdout.write(
        `${platform}: NOT_PUBLISHED (${entry.reason.replace(/\s+/g, ' ').trim()})\n`,
      );
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
  else if (command === 'recovery-receipt' && args.length === 11)
    recoveryReceipt(args);
  else if (command === 'canonical-recovery-message' && args.length === 1)
    canonicalRecoveryMessage(args);
  else if (command === 'assert-recovery-tag-object' && args.length === 2)
    assertRecoveryTagObject(args);
  else if (command === 'assert-final' && args.length === 2) assertFinal(args);
  else if (command === 'final-platform-notes' && args.length === 2)
    finalPlatformNotes(args);
  else fail('usage is invalid');
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

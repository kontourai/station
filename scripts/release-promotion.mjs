#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { invokedDirectly } from './lib/module-entry.mjs';
import { taggedStoreIdentity } from './lib/native-release-config.mjs';
import {
  assertOnlyExpectedAssets,
  readInventory,
  releaseDraftNotes,
  validateReleaseInventory,
} from './lib/release-artifacts.mjs';
import { canonicalJson } from './lib/release-sboms.mjs';
import { parseReleaseTag } from './lib/release-tag.mjs';
import { validateStoreAuthority } from './promote-store-release.mjs';

export const STORE_AUTHORITY_ASSET = 'station-release-store-authority.json';
export const PROMOTION_RECEIPT_ASSET = 'station-release-promotion.json';
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9._-]{1,200}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const fail = (message) => {
  throw new Error(`Release promotion: ${message}`);
};
const digest = (value) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

export function publicationIdentity(mode, producerTag) {
  const parsed = parseReleaseTag(producerTag);
  if (!['stable', 'rc', 'promote'].includes(mode))
    fail('mode must be stable, rc or promote');
  if ((mode === 'stable') !== (parsed.kind === 'final'))
    fail(
      `${mode} mode requires ${mode === 'stable' ? 'a final tag' : 'a release-candidate tag'}`,
    );
  return {
    mode,
    producerTag,
    publicationTag: mode === 'promote' ? `v${parsed.baseVersion}` : producerTag,
    version: parsed.baseVersion,
  };
}

async function fileDigest(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink())
    fail(`not a regular asset: ${basename(file)}`);
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return { sha256: hash.digest('hex'), size: info.size };
}
function readJson(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
    fail('metadata file is not bounded regular JSON');
  return JSON.parse(readFileSync(file, 'utf8'));
}
function persist(file, value) {
  const pending = `${file}.pending`;
  const descriptor = openSync(pending, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${canonicalJson(value)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(pending, file);
  const directory = openSync(dirname(file), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/** Stage receipts are lineage inputs; the release.yml attestation authenticates the aggregate. */
export async function assembleStoreAuthority({
  producerTag,
  sourceSha,
  androidReceipt,
  iosReceipt,
  assetsDir,
}) {
  const identity = publicationIdentity('rc', producerTag);
  const android = validateStoreAuthority(readJson(androidReceipt), 'android');
  const ios = readJson(iosReceipt);
  const native = taggedStoreIdentity(producerTag);
  if (
    android.producerTag !== producerTag ||
    android.sourceSha !== sourceSha ||
    android.version !== identity.version
  )
    fail('Android observation belongs to another candidate');
  const aab = await fileDigest(
    join(assetsDir, `station-${producerTag}-android-universal.aab`),
  );
  const ipa = await fileDigest(
    join(assetsDir, `station-${producerTag}-ios-device.ipa`),
  );
  if (
    android.android.aabSha256 !== aab.sha256 ||
    android.android.providerBundleSha256 !== aab.sha256
  )
    fail('Play observation does not bind the staged AAB');
  if (
    ios.kind !== 'testflight-build-receipt' ||
    ios.provider !== 'app-store-connect' ||
    ios.processingState !== 'VALID' ||
    ios.deliveryMode !== 'uploaded' ||
    ios.sourceSha !== sourceSha ||
    ios.providerSourceSha !== sourceSha ||
    ios.bundleId !== 'io.kontourai.station' ||
    ios.bundleVersion !== native.bundleVersion ||
    ios.ipaSha256 !== ipa.sha256
  )
    fail(
      'Apple authority requires definitive uploaded lineage for the staged IPA; reconciled or unknown builds are inadmissible',
    );
  return validateStoreAuthority({
    kind: 'station.release-store-authority/v1',
    producerTag,
    sourceSha,
    version: identity.version,
    android: android.android,
    ios: {
      bundleId: ios.bundleId,
      appId: ios.appId,
      buildId: ios.buildId,
      buildNumber: ios.bundleVersion,
      ipaSha256: ipa.sha256,
      upload: {
        deliveryMode: 'uploaded',
        sourceSha,
        ipaSha256: ipa.sha256,
        buildId: ios.buildId,
        acknowledged: true,
      },
    },
  });
}

/** Every original byte, including protocol roots, remains named for its producer. */
export async function createPromotionPlan({
  producerTag,
  sourceSha,
  policySha,
  workflowSha,
  assetsDir,
}) {
  const identity = publicationIdentity('promote', producerTag);
  if (
    !SHA.test(sourceSha ?? '') ||
    !SHA.test(policySha ?? '') ||
    !SHA.test(workflowSha ?? '')
  )
    fail('source, workflow and policy SHA must be full lowercase Git SHAs');
  const inventory = readInventory(
    join(assetsDir, 'station-release-inventory.json'),
  );
  validateReleaseInventory(inventory, {
    assetsDir,
    updaterPublicKey: join(assetsDir, 'station-updater-public-key.txt'),
  });
  assertOnlyExpectedAssets(assetsDir, producerTag, {
    allowSignedHostManifest: true,
  });
  if (
    inventory.tag !== producerTag ||
    inventory.sourceSha !== sourceSha ||
    inventory.version !== identity.version
  )
    fail('inventory is not the requested candidate');
  const authority = validateStoreAuthority(
    readJson(join(assetsDir, STORE_AUTHORITY_ASSET)),
  );
  if (
    !authority.android ||
    !authority.ios ||
    authority.producerTag !== producerTag ||
    authority.sourceSha !== sourceSha ||
    authority.version !== identity.version
  )
    fail('complete store authority belongs to another candidate');
  const names = [
    ...inventory.assets.map((asset) => asset.name),
    'station-release-inventory.json',
    'station-release-checksums.txt',
  ];
  // This envelope is signed by publication rather than the producer, and is independently verified by the caller.
  // Signed host envelopes are publication metadata, independently key-verified rather than producer-transferred.
  const assets = [];
  for (const name of [...new Set(names)].sort()) {
    if (!NAME.test(name)) fail('invalid inventory asset name');
    assets.push({ name, ...(await fileDigest(join(assetsDir, name))) });
  }
  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  if (
    byName.get(`station-${producerTag}-android-universal.aab`)?.sha256 !==
      authority.android.aabSha256 ||
    byName.get(`station-${producerTag}-ios-device.ipa`)?.sha256 !==
      authority.ios.ipaSha256
  )
    fail('store authority does not bind candidate artifact bytes');
  const transfer = {
    producerTag,
    publicationTag: identity.publicationTag,
    sourceSha,
    version: identity.version,
    assets,
  };
  return {
    kind: 'station.release-promotion-plan/v1',
    ...transfer,
    policySha,
    workflowSha,
    transferDigest: digest(transfer),
    container: inventory.container,
    storeAuthoritySha256: byName.get(STORE_AUTHORITY_ASSET).sha256,
  };
}

export function assertPromotionPlan(plan) {
  if (!plan || plan.kind !== 'station.release-promotion-plan/v1')
    fail('invalid promotion plan');
  const identity = publicationIdentity('promote', plan.producerTag);
  if (
    plan.publicationTag !== identity.publicationTag ||
    plan.version !== identity.version ||
    !SHA.test(plan.sourceSha ?? '') ||
    !SHA.test(plan.policySha ?? '') ||
    !SHA.test(plan.workflowSha ?? '') ||
    !DIGEST.test(plan.storeAuthoritySha256 ?? '') ||
    !Array.isArray(plan.assets) ||
    plan.assets.length < 1 ||
    plan.assets.length > 128
  )
    fail('malformed promotion authority');
  const names = new Set();
  for (const asset of plan.assets) {
    if (
      !NAME.test(asset.name ?? '') ||
      !DIGEST.test(asset.sha256 ?? '') ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 1 ||
      names.has(asset.name)
    )
      fail('malformed or duplicate plan asset');
    names.add(asset.name);
  }
  if (
    plan.assets.find((asset) => asset.name === STORE_AUTHORITY_ASSET)
      ?.sha256 !== plan.storeAuthoritySha256
  )
    fail('store authority digest differs from transferred bytes');
  const transfer = {
    producerTag: plan.producerTag,
    publicationTag: plan.publicationTag,
    sourceSha: plan.sourceSha,
    version: plan.version,
    assets: plan.assets,
  };
  if (digest(transfer) !== plan.transferDigest)
    fail('promotion plan digest differs');
  return plan;
}

export async function verifyPromotionReceipt(
  receipt,
  { publicationTag, sourceSha, assetsDir },
) {
  if (
    !receipt ||
    receipt.kind !== 'station.release-promotion/v1' ||
    receipt.state !== 'assets-verified' ||
    receipt.publicationTag !== publicationTag ||
    receipt.sourceSha !== sourceSha
  )
    fail('promotion receipt is not this publication');
  assertPromotionPlan({
    ...receipt,
    kind: 'station.release-promotion-plan/v1',
  });
  const inventory = readInventory(
    join(assetsDir, 'station-release-inventory.json'),
  );
  if (
    inventory.tag !== receipt.producerTag ||
    inventory.sourceSha !== sourceSha ||
    inventory.version !== receipt.version
  )
    fail('promoted inventory differs from producer authority');
  const expected = new Set(receipt.assets.map((asset) => asset.name));
  for (const asset of receipt.assets) {
    const local = await fileDigest(join(assetsDir, asset.name));
    if (local.sha256 !== asset.sha256 || local.size !== asset.size)
      fail('promoted bytes differ from receipt');
  }
  for (const name of [
    ...inventory.assets.map((asset) => asset.name),
    'station-release-inventory.json',
    'station-release-checksums.txt',
  ])
    if (!expected.has(name)) fail('promotion receipt omits a producer asset');
  return receipt;
}

function assertRemoteAssets(remote, assets) {
  if (!Array.isArray(remote) || remote.length !== assets.length)
    fail('remote asset inventory differs');
  const names = new Set();
  for (const asset of remote) {
    const expected = assets.find((value) => value.name === asset.name);
    if (
      !expected ||
      names.has(asset.name) ||
      asset.digest !== `sha256:${expected.sha256}` ||
      asset.size !== expected.size
    )
      fail(`remote asset bytes differ: ${String(asset.name)}`);
    names.add(asset.name);
  }
}

/** Fixed GitHub origins; credentials never follow a metadata-supplied URL. */
export class PromotionGithubClient {
  constructor({ repository, token, request = globalThis.fetch }) {
    if (!REPOSITORY.test(repository ?? '') || !token)
      fail('GitHub repository and ephemeral token are required');
    this.repository = repository;
    this.token = token;
    this.request = request;
  }
  async api(
    path,
    { method = 'GET', body, optional = false, upload = false, size } = {},
  ) {
    const origin = upload
      ? 'https://uploads.github.com'
      : 'https://api.github.com';
    const response = await this.request(
      `${origin}/repos/${this.repository}/${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined
            ? {}
            : {
                'Content-Type': upload
                  ? 'application/octet-stream'
                  : 'application/json',
              }),
          ...(upload ? { 'Content-Length': String(size) } : {}),
        },
        ...(body === undefined
          ? {}
          : { body: upload ? body : JSON.stringify(body) }),
        ...(upload ? { duplex: 'half' } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (optional && response.status === 404) return null;
    if (!response.ok)
      fail(`GitHub ${method} failed with status ${response.status}`);
    const chunks = [];
    let length = 0;
    if (response.body)
      for await (const chunk of response.body) {
        length += chunk.byteLength;
        if (length > 8 * 1024 * 1024)
          fail('GitHub metadata response exceeded its bound');
        chunks.push(chunk);
      }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : null;
  }
  async source(tag) {
    const ref = await this.api(`git/ref/tags/${encodeURIComponent(tag)}`, {
      optional: true,
    });
    if (!ref) return null;
    if (ref.object?.type === 'commit' && SHA.test(ref.object.sha ?? ''))
      return ref.object.sha;
    if (ref.object?.type === 'tag') {
      const peeled = await this.api(`git/tags/${ref.object.sha}`);
      if (peeled.object?.type === 'commit' && SHA.test(peeled.object.sha ?? ''))
        return peeled.object.sha;
    }
    fail('tag does not resolve directly to an immutable commit');
  }
  release(tag) {
    return this.api(`releases/tags/${encodeURIComponent(tag)}`, {
      optional: true,
    });
  }
  createRef(tag, sha) {
    return this.api('git/refs', {
      method: 'POST',
      body: { ref: `refs/tags/${tag}`, sha },
    });
  }
  createDraft(tag, sha, notes) {
    return this.api('releases', {
      method: 'POST',
      body: {
        tag_name: tag,
        target_commitish: sha,
        name: `Station ${tag}`,
        body: notes,
        draft: true,
        prerelease: false,
        make_latest: 'false',
      },
    });
  }
  upload(releaseId, asset, assetsDir) {
    if (!Number.isSafeInteger(releaseId) || releaseId < 1)
      fail('invalid release id');
    return this.api(
      `releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`,
      {
        method: 'POST',
        upload: true,
        body: createReadStream(join(assetsDir, asset.name)),
        size: asset.size,
      },
    );
  }
}

/**
 * A failed write remains UNKNOWN. Automatic retries never overwrite refs, releases or assets.
 * @param {{
 *   plan: Awaited<ReturnType<typeof createPromotionPlan>>, assetsDir: string,
 *   github: Pick<PromotionGithubClient, "source" | "release" | "createRef" | "createDraft" | "upload">,
 *   journalPath: string, receiptPath: string, repairReceipt?: string
 * }} options
 */
export async function copyCandidateToFinal({
  plan,
  assetsDir,
  github,
  journalPath,
  receiptPath,
  repairReceipt,
}) {
  assertPromotionPlan(plan);
  if (existsSync(journalPath))
    fail(
      'journal already exists; inspect the prior attempted effects before recovery',
    );
  const current = await createPromotionPlan({ ...plan, assetsDir });
  if (current.transferDigest !== plan.transferDigest)
    fail('local bytes changed after planning');
  if ((await github.source(plan.producerTag)) !== plan.sourceSha)
    fail('producer tag moved or is missing');
  const producer = await github.release(plan.producerTag);
  if (
    !producer ||
    producer.draft !== false ||
    producer.prerelease !== true ||
    producer.tag_name !== plan.producerTag
  )
    fail('promotion source must be the published candidate prerelease');
  assertRemoteAssets(
    producer.assets.filter(
      (asset) => asset.name !== 'station-portable-stable-manifest.json',
    ),
    plan.assets,
  );
  const disclosure = releaseDraftNotes(
    readInventory(join(assetsDir, 'station-release-inventory.json')),
  ).trim();
  const priorNotes = typeof producer.body === 'string' ? producer.body : '';
  const notes = priorNotes.includes(disclosure)
    ? priorNotes
    : `${priorNotes}\n\n${disclosure}\n`;
  if (Buffer.byteLength(notes) > 60_000)
    fail('candidate notes exceed the publication budget');
  const finalRef = await github.source(plan.publicationTag);
  const finalRelease = await github.release(plan.publicationTag);
  if (repairReceipt && !finalRef && !finalRelease)
    fail(
      'repair destination is missing; a receipt cannot authorize a new publication',
    );
  if (finalRef || finalRelease) {
    // The protected workflow verifies this receipt's publish-release.yml attestation before supplying it.
    if (
      !repairReceipt ||
      finalRef !== plan.sourceSha ||
      finalRelease?.draft !== false ||
      finalRelease.prerelease !== false
    )
      fail('destination exists; a same-SHA ref is not recovery authority');
    const receipt = readJson(repairReceipt);
    const entry = finalRelease.assets.find(
      (asset) => asset.name === PROMOTION_RECEIPT_ASSET,
    );
    const bytes = await fileDigest(repairReceipt);
    if (
      receipt.kind !== 'station.release-promotion/v1' ||
      receipt.state !== 'assets-verified' ||
      receipt.transferDigest !== plan.transferDigest ||
      receipt.producerTag !== plan.producerTag ||
      receipt.publicationTag !== plan.publicationTag ||
      receipt.sourceSha !== plan.sourceSha ||
      !SHA.test(receipt.policySha ?? '') ||
      !SHA.test(receipt.workflowSha ?? '') ||
      entry?.digest !== `sha256:${bytes.sha256}` ||
      entry.size !== bytes.size
    )
      fail('destination promotion lineage differs');
    assertRemoteAssets(
      finalRelease.assets.filter(
        (asset) =>
          asset.name !== PROMOTION_RECEIPT_ASSET &&
          asset.name !== 'station-portable-stable-manifest.json',
      ),
      plan.assets,
    );
    persist(journalPath, {
      kind: 'station.release-promotion-journal/v1',
      state: 'repair-verified',
      transferDigest: plan.transferDigest,
    });
    return { publicationTag: plan.publicationTag, repairOnly: true };
  }
  const journal = {
    kind: 'station.release-promotion-journal/v1',
    transferDigest: plan.transferDigest,
    producerTag: plan.producerTag,
    publicationTag: plan.publicationTag,
    sourceSha: plan.sourceSha,
    state: 'planned',
    effects: [],
  };
  persist(journalPath, journal);
  const effect = async (name, operation) => {
    const entry = { name, state: 'attempted' };
    journal.effects.push(entry);
    journal.state = 'attempted';
    persist(journalPath, journal);
    try {
      const result = await operation();
      entry.state = 'acknowledged';
      journal.state = 'progress';
      persist(journalPath, journal);
      return result;
    } catch {
      entry.state = 'unknown';
      journal.state = 'unknown';
      persist(journalPath, journal);
      fail(
        `${name} outcome is UNKNOWN; inspect the journal and remote state before any recovery`,
      );
    }
  };
  try {
    // GITHUB_TOKEN ref creation in the protected workflow does not trigger another Actions push workflow.
    await effect('create-final-ref', () =>
      github.createRef(plan.publicationTag, plan.sourceSha),
    );
    if ((await github.source(plan.publicationTag)) !== plan.sourceSha)
      fail('final ref readback differs');
    const release = await effect('create-final-draft', () =>
      github.createDraft(plan.publicationTag, plan.sourceSha, notes),
    );
    if (
      !Number.isSafeInteger(release?.id) ||
      release.draft !== true ||
      release.tag_name !== plan.publicationTag
    )
      fail('draft creation acknowledgement differs');
    for (const asset of plan.assets) {
      const local = await fileDigest(join(assetsDir, asset.name));
      if (local.sha256 !== asset.sha256 || local.size !== asset.size)
        fail('asset changed during promotion');
      const uploaded = await effect(`upload:${asset.name}`, () =>
        github.upload(release.id, asset, assetsDir),
      );
      if (
        uploaded?.digest !== `sha256:${asset.sha256}` ||
        uploaded.name !== asset.name ||
        uploaded.size !== asset.size
      )
        fail('upload acknowledgement does not bind the planned bytes');
    }
    const copied = await github.release(plan.publicationTag);
    if (
      copied?.draft !== true ||
      copied.prerelease !== false ||
      copied.tag_name !== plan.publicationTag
    )
      fail('destination publication state changed');
    assertRemoteAssets(copied.assets, plan.assets);
    if (
      (await github.source(plan.producerTag)) !== plan.sourceSha ||
      (await github.source(plan.publicationTag)) !== plan.sourceSha
    )
      fail('producer or publication tag changed during transfer');
    const receipt = {
      kind: 'station.release-promotion/v1',
      state: 'assets-verified',
      producerTag: plan.producerTag,
      publicationTag: plan.publicationTag,
      sourceSha: plan.sourceSha,
      version: plan.version,
      policySha: plan.policySha,
      workflowSha: plan.workflowSha,
      transferDigest: plan.transferDigest,
      assets: plan.assets,
      storeAuthoritySha256: plan.storeAuthoritySha256,
    };
    persist(receiptPath, receipt);
    journal.state = 'assets-verified';
    persist(journalPath, journal);
    return { publicationTag: plan.publicationTag, repairOnly: false };
  } catch (error) {
    journal.state = 'unknown';
    persist(journalPath, journal);
    throw error;
  }
}

if (invokedDirectly(import.meta.url)) {
  try {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      options: Object.fromEntries(
        [
          'mode',
          'tag',
          'producer-tag',
          'source-sha',
          'policy-sha',
          'workflow-sha',
          'assets-dir',
          'output',
          'plan',
          'journal',
          'receipt-output',
          'repair-receipt',
          'android-receipt',
          'ios-receipt',
        ].map((name) => [name, { type: 'string' }]),
      ),
    });
    const required = (name) => {
      const value = values[name];
      if (!value) fail(`--${name} is required`);
      return value;
    };
    const command = positionals[0];
    if (command === 'identity')
      console.log(
        JSON.stringify(publicationIdentity(required('mode'), required('tag'))),
      );
    else if (command === 'store-authority') {
      const authority = await assembleStoreAuthority({
        producerTag: required('producer-tag'),
        sourceSha: required('source-sha'),
        assetsDir: required('assets-dir'),
        androidReceipt: required('android-receipt'),
        iosReceipt: required('ios-receipt'),
      });
      persist(required('output'), authority);
    } else if (command === 'plan') {
      persist(
        required('output'),
        await createPromotionPlan({
          producerTag: required('producer-tag'),
          sourceSha: required('source-sha'),
          policySha: required('policy-sha'),
          workflowSha: required('workflow-sha'),
          assetsDir: required('assets-dir'),
        }),
      );
    } else if (command === 'apply') {
      const plan = assertPromotionPlan(readJson(required('plan')));
      const result = await copyCandidateToFinal({
        plan,
        assetsDir: required('assets-dir'),
        github: new PromotionGithubClient({
          repository: process.env.GITHUB_REPOSITORY,
          token: process.env.GH_TOKEN,
        }),
        journalPath: required('journal'),
        receiptPath: required('receipt-output'),
        repairReceipt: values['repair-receipt'],
      });
      console.log(JSON.stringify(result));
    } else fail('command must be identity, store-authority, plan or apply');
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Release promotion failed',
    );
    process.exitCode = 1;
  }
}

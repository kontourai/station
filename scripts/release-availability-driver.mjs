import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  commitsInRange,
  mergedIssueFacts,
} from './lib/github-merged-issue-facts.mjs';
import {
  assertOnlyExpectedAssets,
  readInventory,
  validateReleaseInventory,
} from './lib/release-artifacts.mjs';
import { projectReleaseAvailability } from './release-availability.mjs';
import { validateReleaseSbomPredicates } from './release-sbom-predicates.mjs';

export const REPOSITORY = 'kontourai/station';
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TAG =
  /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-preview\.([1-9][0-9]*))?$/;
const MAX_RELEASES = 100;
const MAX_PULLS = 256;
const MAX_CLOSING_ISSUES = 100;
const MAX_ASSET_BYTES = 512 * 1024 * 1024;
const RELEASE_ASSET_HOSTS = new Set([
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);

const channelForTag = (tag) =>
  TAG.test(tag ?? '')
    ? tag.includes('-preview.')
      ? 'preview'
      : 'stable'
    : null;
const labels = (values = []) =>
  new Set(
    values.map((value) => (typeof value === 'string' ? value : value?.name)),
  );
const safeAssetName = (name) =>
  typeof name === 'string' &&
  name === basename(name) &&
  /^station-[A-Za-z0-9._-]{1,240}$/.test(name);
const exactPublished = (release) =>
  release &&
  release.draft === false &&
  typeof release.published_at === 'string' &&
  !Number.isNaN(Date.parse(release.published_at)) &&
  TAG.test(release.tag_name ?? '');

/** The writer changes only the delivery-stage axis and proves its exact readback. */
export function createReleaseLabelAdapter(api) {
  return {
    async project(number, evidence) {
      let issue;
      try {
        issue = await api.getIssue(number);
      } catch {
        return { kind: 'unavailable' };
      }
      const patch = projectReleaseAvailability(issue?.labels, evidence);
      if (patch.kind === 'ignored' || patch.kind === 'conflict') return patch;
      if (patch.kind === 'unchanged') return patch;
      const target = patch.add[0];
      const stagesFor = (value) =>
        ['stage:source', 'stage:preview', 'stage:stable'].filter((stage) =>
          labels(value?.labels).has(stage),
        );
      // GitHub can apply a mutation and lose its response.  On *every* such
      // exception, read the authority again and reconcile only this one axis.
      // This deliberately never rewrites reporter/maintainer labels.
      let current = issue;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const stages = stagesFor(current);
        if (stages.length === 1 && stages[0] === target) return patch;
        try {
          if (!stages.includes(target)) await api.addLabel(number, target);
          for (const stage of stages)
            if (stage !== target) await api.removeLabel(number, stage);
        } catch {
          try {
            current = await api.getIssue(number);
            continue;
          } catch {
            return { kind: 'unavailable' };
          }
        }
        try {
          current = await api.getIssue(number);
        } catch {
          return { kind: 'unavailable' };
        }
      }
      const stages = stagesFor(current);
      return stages.length === 1 && stages[0] === target
        ? patch
        : { kind: 'unavailable' };
    },
  };
}

async function previousPublicRelease(api, current, channel) {
  let releases;
  try {
    releases = await api.listReleases();
  } catch {
    return null;
  }
  if (
    !Array.isArray(releases) ||
    releases.length === 0 ||
    releases.length > MAX_RELEASES
  )
    return null;
  const candidates = releases.filter(
    (release) =>
      release?.tag_name !== current.tag_name &&
      exactPublished(release) &&
      channelForTag(release.tag_name) === channel &&
      Date.parse(release.published_at) < Date.parse(current.published_at),
  );
  if (candidates.length === 0) return null;
  candidates.sort(
    (left, right) =>
      Date.parse(right.published_at) - Date.parse(left.published_at),
  );
  if (
    candidates.length > 1 &&
    candidates[0].published_at === candidates[1].published_at
  )
    return null;
  const previous = candidates[0];
  let tagSha;
  try {
    tagSha = await api.tagSha(previous.tag_name);
  } catch {
    return null;
  }
  return SHA.test(tagSha ?? '') ? { ...previous, sourceSha: tagSha } : null;
}

async function releaseIssues(api, previousSha, sourceSha, exec) {
  // rev-list alone answers a set question.  Require the actual ancestry edge
  // first so a divergent same-channel release cannot project foreign history.
  try {
    exec('git', ['merge-base', '--is-ancestor', previousSha, sourceSha], {
      timeout: 5_000,
    });
  } catch {
    return null;
  }
  const commits = commitsInRange(previousSha, sourceSha, exec);
  if (!commits) return null;
  const pulls = [];
  for (const sha of commits) {
    let page;
    try {
      page = await api.pullsForCommit(sha);
    } catch {
      return null;
    }
    if (
      !Array.isArray(page) ||
      page.length > 100 ||
      pulls.length + page.length > MAX_PULLS
    )
      return null;
    pulls.push(...page);
  }
  for (const pr of new Map(
    pulls.map((pull) => [pull?.number, pull]),
  ).values()) {
    if (!Number.isSafeInteger(pr?.number) || pr.number < 1) return null;
    let closingIssues;
    try {
      closingIssues = await api.closingIssuesForPull(pr.number);
    } catch {
      return null;
    }
    if (
      !Array.isArray(closingIssues) ||
      closingIssues.length > MAX_CLOSING_ISSUES
    )
      return null;
    // A single foreign/malformed closing fact makes the whole range ambiguous;
    // filtering it out would silently turn an attacker-controlled mixed page
    // into release authority.
    if (
      closingIssues.some(
        (issue) =>
          issue?.repository?.full_name !== REPOSITORY ||
          !Number.isSafeInteger(issue?.number) ||
          issue.number < 1,
      )
    )
      return null;
    pr.closingIssues = closingIssues;
  }
  return mergedIssueFacts({
    pulls,
    commits,
    owner: 'kontourai',
    repo: 'station',
    main: 'main',
  });
}

async function downloadAssets(api, release, directory) {
  if (
    !Array.isArray(release.assets) ||
    release.assets.length === 0 ||
    release.assets.length > 128
  )
    throw new Error('release assets are missing or exceed the bound');
  const seen = new Set();
  for (const asset of release.assets) {
    if (
      !safeAssetName(asset?.name) ||
      !Number.isSafeInteger(asset?.id) ||
      seen.has(asset.name)
    )
      throw new Error('release asset identity is ambiguous');
    seen.add(asset.name);
    const bytes = await api.downloadAsset(asset.id);
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length === 0 ||
      bytes.length > 512 * 1024 * 1024
    )
      throw new Error(`release asset ${asset.name} has invalid bytes`);
    writeFileSync(join(directory, asset.name), bytes, { flag: 'wx' });
  }
}

/**
 * Discover only an already-public release, validate all provider receipts, then
 * project its bounded same-channel merged-issue facts. Any uncertainty fails
 * before the first label write.
 */
export async function runReleaseAvailability(
  event,
  {
    api,
    exec = execFileSync,
    updaterPublicKey,
    readInventoryFile = readInventory,
    assertAssets = assertOnlyExpectedAssets,
    validateInventory = validateReleaseInventory,
    validatePredicates = validateReleaseSbomPredicates,
  } = {},
) {
  if (
    event?.repository?.full_name !== REPOSITORY ||
    event?.workflow !== 'publish-release' ||
    event?.success !== true ||
    event?.dryRun === true ||
    !TAG.test(event?.tag ?? '') ||
    !SHA.test(event?.sourceSha ?? '') ||
    channelForTag(event.tag) !== event.channel
  )
    return { kind: 'ignored' };
  let repository, release, tagSha;
  try {
    [repository, release, tagSha] = await Promise.all([
      api.repository(),
      api.releaseForTag(event.tag),
      api.tagSha(event.tag),
    ]);
  } catch {
    return { kind: 'unavailable' };
  }
  if (
    repository?.private !== false ||
    !exactPublished(release) ||
    release.tag_name !== event.tag ||
    release.prerelease !== (event.channel === 'preview') ||
    tagSha !== event.sourceSha
  )
    return { kind: 'unavailable' };
  const directory = mkdtempSync(
    join(tmpdir(), 'station-release-availability-'),
  );
  let inventory, inventorySha;
  try {
    await downloadAssets(api, release, directory);
    const inventoryPath = join(directory, 'station-release-inventory.json');
    inventory = readInventoryFile(inventoryPath);
    inventorySha = createHash('sha256')
      .update(readFileSync(inventoryPath))
      .digest('hex');
    if (!SHA256.test(inventorySha) || inventorySha === '0'.repeat(64))
      throw new Error('inventory digest is invalid');
    validateInventory(inventory, {
      assetsDir: directory,
      updaterPublicKey,
      containerDescriptor: join(directory, 'station-container-release.json'),
    });
    assertAssets(directory, event.tag);
    validatePredicates(directory);
    for (const asset of release.assets)
      await api.verifyAttestation(join(directory, asset.name), {
        tag: event.tag,
        sourceSha: event.sourceSha,
        workflow: '.github/workflows/release.yml',
      });
  } catch {
    rmSync(directory, { recursive: true, force: true });
    return { kind: 'unavailable' };
  }
  rmSync(directory, { recursive: true, force: true });
  if (
    inventory.schemaVersion !== 2 ||
    inventory.tag !== event.tag ||
    inventory.sourceSha !== event.sourceSha ||
    inventory.channel !== event.channel ||
    inventory.container?.tag !== event.tag ||
    inventory.container?.sha !== event.sourceSha
  )
    return { kind: 'unavailable' };
  const previous = await previousPublicRelease(api, release, event.channel);
  if (!previous) return { kind: 'unavailable' };
  const issues = await releaseIssues(
    api,
    previous.sourceSha,
    event.sourceSha,
    exec,
  );
  if (issues === null) return { kind: 'unavailable' };
  const evidence = {
    channel: event.channel,
    success: true,
    sourceSha: event.sourceSha,
    tag: event.tag,
    version: event.tag.slice(1),
    inventory,
    inventorySha,
    attestation: { sourceSha: event.sourceSha, inventorySha },
    release: {
      effect: 'published',
      draft: false,
      public: true,
      tag: event.tag,
      sourceSha: event.sourceSha,
    },
    sbomPredicates: {
      portable: 'npm/runtime',
      desktop: 'npm/runtime,rust/native',
      mobile: 'npm/runtime,rust/native',
      container: 'container/image',
    },
  };
  if (event.project === false) return { kind: 'validated', issues };
  const writer = createReleaseLabelAdapter(api);
  const outcomes = [];
  for (const number of issues)
    outcomes.push([number, await writer.project(number, evidence)]);
  return outcomes.some(([, outcome]) =>
    ['conflict', 'unavailable', 'ignored'].includes(outcome.kind),
  )
    ? { kind: 'unavailable', outcomes }
    : { kind: 'projected', outcomes };
}

async function boundedBinary(response) {
  const declared = response.headers.get('content-length');
  if (
    !declared ||
    !/^[0-9]+$/.test(declared) ||
    Number(declared) > MAX_ASSET_BYTES
  )
    throw new Error(
      'release asset content length is missing or exceeds the bound',
    );
  const reader = response.body?.getReader();
  if (!reader) throw new Error('release asset body is unavailable');
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ASSET_BYTES) {
      await reader.cancel();
      throw new Error('release asset stream exceeds the bound');
    }
    chunks.push(value);
  }
  if (total !== Number(declared))
    throw new Error('release asset content length disagrees with its stream');
  return Buffer.concat(chunks);
}

export async function request(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      ...options.headers,
    },
  });
  if (options.binary && response.status === 302) {
    const location = response.headers.get('location');
    let target;
    try {
      target = new URL(location ?? '');
    } catch {
      throw new Error('release asset redirect is invalid');
    }
    if (
      target.protocol !== 'https:' ||
      !RELEASE_ASSET_HOSTS.has(target.hostname)
    )
      throw new Error('release asset redirect host is not allowed');
    // Deliberately omit all API headers, especially Authorization, cross-origin.
    const redirected = await fetch(target, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/octet-stream' },
    });
    if (!redirected.ok)
      throw new Error(`GitHub release asset ${redirected.status}`);
    return boundedBinary(redirected);
  }
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  if (response.status >= 300 && response.status < 400)
    throw new Error('unexpected GitHub API redirect');
  if (response.headers.get('link')?.includes('rel="next"'))
    throw new Error('GitHub API pagination exceeded the bound');
  if (options.binary) return boundedBinary(response);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 1_000_000)
    throw new Error('GitHub API response exceeded the byte bound');
  return JSON.parse(bytes.toString('utf8'));
}

async function tagSha(tag) {
  const ref = await request(
    `/repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(tag)}`,
  );
  if (ref?.object?.type === 'commit') return ref.object.sha;
  if (ref?.object?.type !== 'tag' || !SHA.test(ref.object.sha ?? ''))
    throw new Error('tag ref is ambiguous');
  const tagObject = await request(
    `/repos/${REPOSITORY}/git/tags/${ref.object.sha}`,
  );
  if (tagObject?.object?.type !== 'commit')
    throw new Error('annotated tag is ambiguous');
  return tagObject.object.sha;
}

if (process.argv[1]?.endsWith('release-availability-driver.mjs')) {
  const api = {
    repository: () => request(`/repos/${REPOSITORY}`),
    releaseForTag: (tag) =>
      request(`/repos/${REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`),
    listReleases: () =>
      request(`/repos/${REPOSITORY}/releases?per_page=${MAX_RELEASES}`),
    tagSha,
    downloadAsset: (id) =>
      request(`/repos/${REPOSITORY}/releases/assets/${id}`, {
        binary: true,
        headers: { Accept: 'application/octet-stream' },
      }),
    pullsForCommit: (sha) =>
      request(`/repos/${REPOSITORY}/commits/${sha}/pulls?per_page=100`),
    getIssue: (number) => request(`/repos/${REPOSITORY}/issues/${number}`),
    addLabel: (number, name) =>
      request(`/repos/${REPOSITORY}/issues/${number}/labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels: [name] }),
      }),
    removeLabel: (number, name) =>
      request(
        `/repos/${REPOSITORY}/issues/${number}/labels/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      ),
    closingIssuesForPull: async (number) => {
      const data = await request('/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query:
            'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){closingIssuesReferences(first:100){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage}}}}}',
          variables: { owner: 'kontourai', repo: 'station', number },
        }),
      });
      const connection =
        data?.data?.repository?.pullRequest?.closingIssuesReferences;
      if (
        data?.errors?.length ||
        !connection ||
        connection.pageInfo?.hasNextPage ||
        !Array.isArray(connection.nodes)
      )
        throw new Error('closing issue facts are ambiguous');
      return connection.nodes.map((issue) => ({
        number: issue.number,
        repository: { full_name: issue.repository?.nameWithOwner },
      }));
    },
    verifyAttestation: (asset, { tag, sourceSha, workflow }) =>
      execFileSync(
        'gh',
        [
          'attestation',
          'verify',
          asset,
          '--repo',
          REPOSITORY,
          '--signer-workflow',
          `${REPOSITORY}/${workflow}`,
          '--source-ref',
          `refs/tags/${tag}`,
          '--source-digest',
          sourceSha,
          '--cert-identity-regex',
          `^https://github.com/${REPOSITORY}/.github/workflows/release\\.yml@refs/tags/${tag}$`,
          '--cert-oidc-issuer',
          'https://token.actions.githubusercontent.com',
          '--deny-self-hosted-runners',
        ],
        { stdio: 'inherit', timeout: 30_000 },
      ),
  };
  const result = await runReleaseAvailability(
    {
      repository: { full_name: process.env.GITHUB_REPOSITORY },
      workflow: 'publish-release',
      success: process.env.RELEASE_PUBLISH_SUCCEEDED === 'true',
      tag: process.env.RELEASE_TAG,
      sourceSha: process.env.RELEASE_SHA,
      channel: process.env.RELEASE_CHANNEL,
      project: process.argv.includes('--project'),
    },
    {
      api,
      updaterPublicKey: process.env.STATION_UPDATER_PUBLIC_KEY_FILE
        ? readFileSync(process.env.STATION_UPDATER_PUBLIC_KEY_FILE, 'utf8')
        : undefined,
    },
  );
  if (result.kind === 'unavailable') process.exitCode = 1;
}

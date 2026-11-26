import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, test, vi } from 'vitest';
import { canonicalJson } from '../lib/release-sboms.mjs';
import {
  createReleaseLabelAdapter,
  request,
  runReleaseAvailability,
} from '../release-availability-driver.mjs';
import { PROMOTION_RECEIPT_ASSET } from '../release-promotion.mjs';

const previousSha = 'a'.repeat(40);
const sourceSha = 'b'.repeat(40);
const tag = 'v1.2.3';
const event = {
  repository: { full_name: 'kontourai/station' },
  workflow: 'publish-release',
  success: true,
  tag,
  sourceSha,
  channel: 'stable',
};
const release = (name: string, published_at: string) => ({
  tag_name: name,
  draft: false,
  prerelease: name.includes('-preview.'),
  published_at,
  assets: [
    { id: 1, name: 'station-release-inventory.json' },
    { id: 2, name: 'station-container-release.json' },
  ],
});
const inventory = () => ({
  schemaVersion: 2,
  tag,
  version: tag.slice(1),
  sourceSha,
  channel: 'stable',
  container: { tag, sha: sourceSha },
});

function fixture(overrides: Record<string, unknown> = {}) {
  const getIssue = vi
    .fn()
    .mockResolvedValueOnce({ labels: ['stage:source'] })
    .mockResolvedValueOnce({ labels: ['stage:stable'] });
  return {
    repository: vi.fn().mockResolvedValue({ private: false }),
    releaseForTag: vi
      .fn()
      .mockResolvedValue(release(tag, '2026-08-24T12:00:00.000Z')),
    listReleases: vi
      .fn()
      .mockResolvedValue([
        release(tag, '2026-08-24T12:00:00.000Z'),
        release('v1.2.2', '2026-08-23T12:00:00.000Z'),
      ]),
    tagSha: vi
      .fn()
      .mockImplementation((value) =>
        Promise.resolve(value === tag ? sourceSha : previousSha),
      ),
    downloadAsset: vi.fn().mockResolvedValue(Buffer.from('{}')),
    verifyAttestation: vi.fn().mockResolvedValue(undefined),
    pullsForCommit: vi.fn().mockResolvedValue([
      {
        number: 7,
        merged_at: 'x',
        merge_commit_sha: sourceSha,
        base: { ref: 'main', repo: { full_name: 'kontourai/station' } },
      },
    ]),
    closingIssuesForPull: vi
      .fn()
      .mockResolvedValue([
        { number: 9, repository: { full_name: 'kontourai/station' } },
      ]),
    getIssue,
    addLabel: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const options = (api: any, overrides: Record<string, unknown> = {}) => ({
  api,
  exec: vi.fn().mockReturnValue(sourceSha),
  updaterPublicKey: 'irrelevant-to-the-stub',
  readInventoryFile: vi.fn().mockReturnValue(inventory()),
  validateInventory: vi.fn(),
  assertAssets: vi.fn(),
  validatePredicates: vi.fn(),
  ...overrides,
});

/** The same release published as a final Stable tag. */
const stableTag = 'v1.2.3';
const stableEvent = { ...event, tag: stableTag, channel: 'stable' };
const stableInventory = () => ({
  ...inventory(),
  tag: stableTag,
  version: '1.2.3',
  channel: 'stable',
  container: { tag: stableTag, sha: sourceSha },
});
function stableFixture(overrides: Record<string, unknown> = {}) {
  return fixture({
    releaseForTag: vi
      .fn()
      .mockResolvedValue(release(stableTag, '2026-08-24T12:00:00.000Z')),
    listReleases: vi
      .fn()
      .mockResolvedValue([
        release(stableTag, '2026-08-24T12:00:00.000Z'),
        release('v1.2.2', '2026-08-23T12:00:00.000Z'),
      ]),
    tagSha: vi
      .fn()
      .mockImplementation((value) =>
        Promise.resolve(value === stableTag ? sourceSha : previousSha),
      ),
    getIssue: vi
      .fn()
      .mockResolvedValueOnce({ labels: ['stage:source'] })
      .mockResolvedValueOnce({ labels: ['stage:stable'] }),
    ...overrides,
  });
}

describe('release availability driver', () => {
  test('follows exactly one GitHub release-asset 302 without forwarding authorization', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location: 'https://release-assets.githubusercontent.com/object',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from('ok'), {
          status: 200,
          headers: { 'content-length': '2' },
        }),
      );
    vi.stubGlobal('fetch', fetch);
    await expect(request('/asset', { binary: true })).resolves.toEqual(
      Buffer.from('ok'),
    );
    expect(fetch.mock.calls[1][1].headers).not.toHaveProperty('Authorization');
    vi.unstubAllGlobals();
  });

  test('verifies the signed host manifest through the inventory, not a release.yml attestation (#2959)', async () => {
    const withManifest = (name: string) => ({
      ...release(stableTag, '2026-08-24T12:00:00.000Z'),
      assets: [
        ...release(stableTag, '2026-08-24T12:00:00.000Z').assets,
        { id: 3, name },
      ],
    });
    const stableOptions = (api: any, overrides: Record<string, unknown> = {}) =>
      options(api, {
        readInventoryFile: vi.fn().mockReturnValue(stableInventory()),
        ...overrides,
      });
    const api = stableFixture({
      releaseForTag: vi
        .fn()
        .mockResolvedValue(
          withManifest('station-portable-stable-manifest.json'),
        ),
    });
    const validateInventory = vi.fn();
    const assertAssets = vi.fn();
    await expect(
      runReleaseAvailability(
        stableEvent,
        stableOptions(api, { validateInventory, assertAssets }),
      ),
    ).resolves.toMatchObject({ kind: 'projected' });
    expect(validateInventory).toHaveBeenCalledTimes(1);
    expect(assertAssets).toHaveBeenCalledWith(expect.any(String), stableTag, {
      allowSignedHostManifest: true,
    });
    expect(
      api.verifyAttestation.mock.calls.map(([path]: unknown[]) =>
        String(path).split(/[\\/]/).at(-1),
      ),
    ).toEqual([
      'station-release-inventory.json',
      'station-container-release.json',
    ]);
    // Another ring's manifest name is not exempt: it must carry a
    // release.yml attestation like any other asset (and then fails here).
    const other = stableFixture({
      releaseForTag: vi
        .fn()
        .mockResolvedValue(
          withManifest('station-portable-nightly-manifest.json'),
        ),
      verifyAttestation: vi
        .fn()
        .mockImplementation((path: string) =>
          path.endsWith('station-portable-nightly-manifest.json')
            ? Promise.reject(new Error('no attestation'))
            : Promise.resolve(undefined),
        ),
    });
    await expect(
      runReleaseAvailability(stableEvent, stableOptions(other)),
    ).resolves.toEqual({ kind: 'unavailable' });
  });

  test.each([
    'valid',
    'changed-bytes',
    'wrong-base',
    'wrong-source',
    'untrusted-policy',
    'untrusted-receipt',
  ])(
    'projects unchanged RC inventory only through authenticated promotion lineage: %s',
    async (mode) => {
      const producerTag = 'v1.2.3-rc.2';
      const original = {
        ...inventory(),
        tag: producerTag,
        assets: [],
        container: { tag: producerTag, sha: sourceSha },
      };
      const files = new Map<string, Buffer>([
        [
          'station-release-inventory.json',
          Buffer.from(canonicalJson(original)),
        ],
        ['station-release-checksums.txt', Buffer.from('checksums\n')],
        ['station-release-store-authority.json', Buffer.from('{}')],
      ]);
      const assets = [...files].map(([name, bytes]) => ({
        name,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      }));
      const transfer = {
        producerTag,
        publicationTag: tag,
        sourceSha,
        version: '1.2.3',
        assets,
      };
      const receipt = {
        ...transfer,
        kind: 'station.release-promotion/v1',
        state: 'assets-verified',
        policySha: 'c'.repeat(40),
        workflowSha: 'd'.repeat(40),
        transferDigest: createHash('sha256')
          .update(canonicalJson(transfer))
          .digest('hex'),
        storeAuthoritySha256: assets.find(
          (asset) => asset.name === 'station-release-store-authority.json',
        )?.sha256,
      };
      if (mode === 'wrong-base') receipt.version = '1.2.4';
      if (mode === 'wrong-source') receipt.sourceSha = previousSha;
      files.set(PROMOTION_RECEIPT_ASSET, Buffer.from(JSON.stringify(receipt)));
      if (mode === 'changed-bytes')
        files.set('station-release-checksums.txt', Buffer.from('changed\n'));
      const entries = [...files];
      const current = {
        ...release(tag, '2026-08-24T12:00:00.000Z'),
        assets: entries.map(([name], index) => ({ id: index + 1, name })),
      };
      const api = fixture({
        repository: vi
          .fn()
          .mockResolvedValue({ private: false, default_branch: 'main' }),
        releaseForTag: vi.fn().mockResolvedValue(current),
        downloadAsset: vi.fn().mockImplementation((id) => entries[id - 1][1]),
        tagSha: vi
          .fn()
          .mockImplementation((value) =>
            Promise.resolve(
              [tag, producerTag].includes(value) ? sourceSha : previousSha,
            ),
          ),
        verifyPolicyCommit: vi
          .fn()
          .mockResolvedValue(mode !== 'untrusted-policy'),
        verifyAttestation: vi.fn().mockImplementation((path) => {
          if (
            mode === 'untrusted-receipt' &&
            path.endsWith(PROMOTION_RECEIPT_ASSET)
          )
            throw new Error('untrusted receipt');
        }),
      });
      const opts = options(api);
      delete (opts as Record<string, unknown>).readInventoryFile;
      const result = await runReleaseAvailability(event, opts);
      expect(result).toMatchObject({
        kind: mode === 'valid' ? 'projected' : 'unavailable',
      });
      if (mode === 'valid') {
        expect(api.addLabel).toHaveBeenCalledWith(9, 'stage:stable');
        expect(result).toMatchObject({ outcomes: [[9, { kind: 'stable' }]] });
        expect(api.verifyAttestation).toHaveBeenCalledWith(
          expect.stringContaining(PROMOTION_RECEIPT_ASSET),
          {
            sourceRef: 'refs/heads/main',
            sourceSha: receipt.workflowSha,
            workflow: '.github/workflows/publish-release.yml',
          },
        );
      } else expect(api.addLabel).not.toHaveBeenCalled();
    },
  );

  test('projects no availability for a retired preview release (#4929)', async () => {
    const api = fixture();
    await expect(
      runReleaseAvailability(
        { ...event, tag: 'v1.2.3-preview.2', channel: 'preview' },
        options(api),
      ),
    ).resolves.toEqual({ kind: 'ignored' });
    expect(api.addLabel).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
  });

  test('permits an explicit first-Stable baseline bootstrap without writing issue labels', async () => {
    const api = fixture({
      listReleases: vi
        .fn()
        .mockResolvedValue([release(tag, '2026-08-24T12:00:00.000Z')]),
    });
    await expect(
      runReleaseAvailability(
        { ...event, allowEmptyBaseline: true },
        options(api),
      ),
    ).resolves.toMatchObject({
      kind: 'bootstrap-without-labels',
      projected: 0,
    });
    expect(api.getIssue).not.toHaveBeenCalled();
    expect(api.addLabel).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
  });

  test.each(['unavailable', 'empty', 'full-page', 'other-stable', 'malformed'])(
    'never treats %s history as first-Stable bootstrap authority',
    async (mode) => {
      const listReleases =
        mode === 'unavailable'
          ? vi.fn().mockRejectedValue(new Error('unknown history'))
          : vi
              .fn()
              .mockResolvedValue(
                mode === 'empty'
                  ? []
                  : mode === 'full-page'
                    ? Array.from({ length: 100 }, () =>
                        release(tag, '2026-08-24T12:00:00.000Z'),
                      )
                    : [
                        release(tag, '2026-08-24T12:00:00.000Z'),
                        mode === 'malformed'
                          ? {}
                          : release('v1.2.4', '2026-08-25T12:00:00.000Z'),
                      ],
              );
      const api = fixture({ listReleases });
      await expect(
        runReleaseAvailability(
          { ...event, allowEmptyBaseline: true },
          options(api),
        ),
      ).resolves.toMatchObject({ kind: 'unavailable' });
      expect(api.addLabel).not.toHaveBeenCalled();
      expect(api.removeLabel).not.toHaveBeenCalled();
    },
  );

  test('supports stable releases and derives the stable stage from the matching channel', async () => {
    const stableTag = 'v1.2.3';
    const api = fixture({
      releaseForTag: vi
        .fn()
        .mockResolvedValue(release(stableTag, '2026-08-24T12:00:00.000Z')),
      listReleases: vi
        .fn()
        .mockResolvedValue([
          release(stableTag, '2026-08-24T12:00:00.000Z'),
          release('v1.2.2', '2026-08-23T12:00:00.000Z'),
        ]),
      tagSha: vi
        .fn()
        .mockImplementation((value) =>
          Promise.resolve(value === stableTag ? sourceSha : previousSha),
        ),
      getIssue: vi
        .fn()
        .mockResolvedValueOnce({ labels: ['stage:preview'] })
        .mockResolvedValueOnce({ labels: ['stage:stable'] }),
    });
    const stableInventory = {
      ...inventory(),
      tag: stableTag,
      version: '1.2.3',
      channel: 'stable',
      container: { tag: stableTag, sha: sourceSha },
    };
    await expect(
      runReleaseAvailability(
        { ...event, tag: stableTag, channel: 'stable' },
        options(api, {
          readInventoryFile: vi.fn().mockReturnValue(stableInventory),
        }),
      ),
    ).resolves.toMatchObject({ kind: 'projected' });
    expect(api.addLabel).toHaveBeenCalledWith(9, 'stage:stable');
    expect(api.removeLabel).toHaveBeenCalledWith(9, 'stage:preview');
  });

  test.each([
    ['branch', { workflow: 'branch' }],
    ['failed publish', { success: false }],
    ['dry run', { dryRun: true }],
    ['tag/channel mismatch', { channel: 'nightly' }],
    ['wrong repository', { repository: { full_name: 'evil/repo' } }],
  ])('makes zero label calls for %s', async (_name, patch) => {
    const api = fixture();
    await expect(
      runReleaseAvailability({ ...event, ...patch }, options(api)),
    ).resolves.toMatchObject({ kind: 'ignored' });
    expect(api.addLabel).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
  });

  test.each([
    [
      'missing provider release',
      { releaseForTag: vi.fn().mockResolvedValue(undefined) },
    ],
    [
      'private release repository',
      { repository: vi.fn().mockResolvedValue({ private: true }) },
    ],
    [
      'draft release',
      {
        releaseForTag: vi.fn().mockResolvedValue({
          ...release(tag, '2026-08-24T12:00:00.000Z'),
          draft: true,
        }),
      },
    ],
    ['wrong tag SHA', { tagSha: vi.fn().mockResolvedValue(previousSha) }],
    [
      'pagination',
      { listReleases: vi.fn().mockRejectedValue(new Error('next page')) },
    ],
    [
      'missing asset bytes',
      { downloadAsset: vi.fn().mockResolvedValue(Buffer.alloc(0)) },
    ],
    [
      'failed attestation',
      {
        verifyAttestation: vi
          .fn()
          .mockRejectedValue(new Error('bad workflow/ref/predicate')),
      },
    ],
    [
      'first release',
      {
        listReleases: vi
          .fn()
          .mockResolvedValue([release(tag, '2026-08-24T12:00:00.000Z')]),
      },
    ],
  ])('fails closed without labels for %s', async (_name, patch) => {
    const api = fixture(patch as any);
    await expect(
      runReleaseAvailability(event, options(api)),
    ).resolves.toMatchObject({ kind: 'unavailable' });
    expect(api.addLabel).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
  });

  test('rejects altered inventory facts, ambiguous prior boundaries, oversized ranges, and foreign issues', async () => {
    const wrongInventory = fixture();
    await expect(
      runReleaseAvailability(
        event,
        options(wrongInventory, {
          readInventoryFile: vi
            .fn()
            .mockReturnValue({ ...inventory(), sourceSha: previousSha }),
        }),
      ),
    ).resolves.toMatchObject({ kind: 'unavailable' });

    const ambiguous = fixture({
      listReleases: vi
        .fn()
        .mockResolvedValue([
          release(tag, '2026-08-24T12:00:00.000Z'),
          release('v1.2.2', '2026-08-23T12:00:00.000Z'),
          release('v1.2.1', '2026-08-23T12:00:00.000Z'),
        ]),
    });
    await expect(
      runReleaseAvailability(event, options(ambiguous)),
    ).resolves.toMatchObject({ kind: 'unavailable' });

    const oversized = fixture();
    const overRange = Array.from({ length: 257 }, (_, index) =>
      index === 256 ? sourceSha : index.toString(16).padStart(40, '0'),
    ).join('\n');
    await expect(
      runReleaseAvailability(
        event,
        options(oversized, { exec: vi.fn().mockReturnValue(overRange) }),
      ),
    ).resolves.toMatchObject({ kind: 'unavailable' });

    const foreign = fixture({
      closingIssuesForPull: vi
        .fn()
        .mockResolvedValue([
          { number: 9, repository: { full_name: 'evil/repo' } },
        ]),
    });
    await expect(
      runReleaseAvailability(event, options(foreign)),
    ).resolves.toMatchObject({ kind: 'unavailable' });
    expect(foreign.addLabel).not.toHaveBeenCalled();
  });

  test('fails label conflicts and all mutation/readback races without compensating unrelated labels', async () => {
    const api = {
      getIssue: vi
        .fn()
        .mockResolvedValueOnce({ labels: ['stage:source'] })
        .mockResolvedValueOnce({ labels: ['stage:preview', 'stage:stable'] }),
      addLabel: vi.fn(),
      removeLabel: vi.fn(),
    };
    const evidence: any = {
      channel: 'stable',
      success: true,
      sourceSha,
      tag,
      version: tag.slice(1),
      inventory: inventory(),
      inventorySha: 'c'.repeat(64),
      attestation: { sourceSha, inventorySha: 'c'.repeat(64) },
      release: {
        effect: 'published',
        draft: false,
        public: true,
        tag,
        sourceSha,
      },
      sbomPredicates: {
        portable: 'npm/runtime',
        desktop: 'npm/runtime,rust/native',
        mobile: 'npm/runtime,rust/native',
        container: 'container/image',
      },
    };
    await expect(
      createReleaseLabelAdapter(api).project(9, evidence),
    ).resolves.toMatchObject({ kind: 'unavailable' });
    expect(api.addLabel).toHaveBeenCalledWith(9, 'stage:stable');
    expect(api.removeLabel).toHaveBeenCalledWith(9, 'stage:source');
  });

  test.each([
    [
      'add applied then response lost',
      'addLabel',
      ['stage:source'],
      ['stage:stable'],
    ],
    [
      'remove applied then response lost',
      'removeLabel',
      ['stage:source'],
      ['stage:stable'],
    ],
  ])(
    'repairs only the stage axis when %s',
    async (_name, lost, initial, final) => {
      let labels = [...initial, 'needs:reporter'];
      const api: any = {
        getIssue: vi.fn().mockImplementation(() => ({ labels })),
        addLabel: vi.fn().mockImplementation((_number, name) => {
          if (!labels.includes(name)) labels.push(name);
          if (lost === 'addLabel') throw new Error('response lost');
        }),
        removeLabel: vi.fn().mockImplementation((_number, name) => {
          labels = labels.filter((label) => label !== name);
          if (lost === 'removeLabel') throw new Error('response lost');
        }),
      };
      const result = await createReleaseLabelAdapter(api).project(9, {
        channel: 'stable',
        success: true,
        sourceSha,
        tag,
        version: tag.slice(1),
        inventory: inventory(),
        inventorySha: 'c'.repeat(64),
        attestation: { sourceSha, inventorySha: 'c'.repeat(64) },
        release: {
          effect: 'published',
          draft: false,
          public: true,
          tag,
          sourceSha,
        },
        sbomPredicates: {
          portable: 'npm/runtime',
          desktop: 'npm/runtime,rust/native',
          mobile: 'npm/runtime,rust/native',
          container: 'container/image',
        },
      });
      expect(result.kind).toBe('stable');
      expect(labels.filter((label) => label.startsWith('stage:'))).toEqual(
        final,
      );
      expect(labels).toContain('needs:reporter');
    },
  );

  test('parses the real terminal workflow topology and ordered least-privilege seam', () => {
    const workflow: any = load(
      readFileSync('.github/workflows/publish-release.yml', 'utf8'),
    );
    const job = workflow.jobs['release-availability'];
    expect(job.needs).toEqual(['resolve', 'publish']);
    expect(job.permissions).toEqual({
      contents: 'read',
      issues: 'write',
      'pull-requests': 'read',
      attestations: 'read',
    });
    expect(job.if).toContain("needs.publish.result == 'success'");
    const checkout = job.steps[0];
    expect(checkout.with).toMatchObject({
      ref: `\${{ needs.resolve.outputs.sha }}`,
      'persist-credentials': false,
      'fetch-depth': 257,
    });
    // Exact and ordered on purpose: this is the seam where a step inserted
    // between the hardened checkout and the projection could read or write
    // with the job's own permissions. `Setup pinned pnpm` was added by the
    // pnpm migration and belongs here -- it runs before `dependencies:ci`,
    // which needs pnpm on PATH -- but it has to be acknowledged rather than
    // absorbed, which is why this list is enumerated and not counted.
    // The driver runs from the policy commit resolve pinned (#2676); it
    // carries no credential, and git history questions still read the tag
    // checkout, which stays the cwd.
    expect(job.steps[1].with).toEqual({
      ref: `\${{ needs.resolve.outputs.policy_sha }}`,
      path: 'release-policy',
      'persist-credentials': false,
    });
    expect(job.steps.map((step: any) => step.name ?? step.run)).toEqual([
      undefined,
      'Check out default-branch release policy',
      'Setup pinned pnpm',
      undefined,
      'npm run dependencies:ci',
      'Validate public release inventory and GitHub attestations',
      'Project verified release availability',
    ]);
  });
});

import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, test, vi } from 'vitest';
import {
  createReleaseLabelAdapter,
  request,
  runReleaseAvailability,
} from '../release-availability-driver.mjs';

const previousSha = 'a'.repeat(40);
const sourceSha = 'b'.repeat(40);
const tag = 'v1.2.3-preview.2';
const event = {
  repository: { full_name: 'kontourai/station' },
  workflow: 'publish-release',
  success: true,
  tag,
  sourceSha,
  channel: 'preview',
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
  channel: 'preview',
  container: { tag, sha: sourceSha },
});

function fixture(overrides: Record<string, unknown> = {}) {
  const getIssue = vi
    .fn()
    .mockResolvedValueOnce({ labels: ['stage:source'] })
    .mockResolvedValueOnce({ labels: ['stage:preview'] });
  return {
    repository: vi.fn().mockResolvedValue({ private: false }),
    releaseForTag: vi
      .fn()
      .mockResolvedValue(release(tag, '2026-08-24T12:00:00.000Z')),
    listReleases: vi
      .fn()
      .mockResolvedValue([
        release(tag, '2026-08-24T12:00:00.000Z'),
        release('v1.2.3-preview.1', '2026-08-23T12:00:00.000Z'),
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

  test('advances a public preview release only after every provider receipt, and is idempotent', async () => {
    const api = fixture();
    await expect(
      runReleaseAvailability(event, options(api)),
    ).resolves.toMatchObject({
      kind: 'projected',
      outcomes: [[9, { kind: 'preview' }]],
    });
    expect(api.verifyAttestation).toHaveBeenCalledTimes(2);
    expect(api.addLabel).toHaveBeenCalledWith(9, 'stage:preview');
    expect(api.removeLabel).toHaveBeenCalledWith(9, 'stage:source');

    const idempotent = fixture({
      getIssue: vi.fn().mockResolvedValue({ labels: ['stage:preview'] }),
    });
    await expect(
      runReleaseAvailability(event, options(idempotent)),
    ).resolves.toMatchObject({ kind: 'projected' });
    expect(idempotent.addLabel).not.toHaveBeenCalled();
    expect(idempotent.removeLabel).not.toHaveBeenCalled();
  });

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
    ['tag/channel mismatch', { channel: 'stable' }],
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
          release('v1.2.3-preview.1', '2026-08-23T12:00:00.000Z'),
          release('v1.2.2-preview.1', '2026-08-23T12:00:00.000Z'),
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
      channel: 'preview',
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
    expect(api.addLabel).toHaveBeenCalledWith(9, 'stage:preview');
    expect(api.removeLabel).toHaveBeenCalledWith(9, 'stage:source');
  });

  test.each([
    [
      'add applied then response lost',
      'addLabel',
      ['stage:source'],
      ['stage:preview'],
    ],
    [
      'remove applied then response lost',
      'removeLabel',
      ['stage:source'],
      ['stage:preview'],
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
        channel: 'preview',
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
      expect(result.kind).toBe('preview');
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
    expect(job.steps.map((step: any) => step.name ?? step.run)).toEqual([
      undefined,
      'Setup pinned pnpm',
      undefined,
      'npm run dependencies:ci',
      'Validate public release inventory and GitHub attestations',
      'Project verified release availability',
    ]);
  });
});

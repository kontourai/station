import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  publishRepair,
  type RepairPublicationCheckpoint,
  type RepairPublicationLease,
  type RepairPublicationPlan,
  type RepairPublisherDependencies,
} from '../repair-publisher.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const now = Date.parse('2026-10-31T12:00:00.000Z');
const plan: RepairPublicationPlan = {
  runId: '12345678-1234-4123-8123-123456789abc',
  bindingDigest: 'b'.repeat(64),
  resultDigest: 'c'.repeat(64),
  taskIncarnation: '2026-10-31T10:00:00.000Z',
  repository: 'owner/repo',
  repositoryId: 19,
  failedRun: 41,
  failedSha: 'f'.repeat(40),
  episode: 42,
  attempt: '99-1',
  baseSha: 'a'.repeat(40),
  baseTreeSha: 'b'.repeat(40),
  expectedTreeSha: 'c'.repeat(40),
  files: [
    {
      path: 'src-server/fix.ts',
      mode: '100644',
      contentBase64: Buffer.from('repaired\n').toString('base64'),
    },
    { path: 'src-server/obsolete.ts', mode: '100755', contentBase64: null },
  ],
  completedAt: '2026-10-31T11:00:00.000Z',
  appId: 7,
  installationId: 8,
  reviewId: 'review-independent',
  grantId: 'grant-1',
};
const branch =
  'repair/qualification-42-station-12345678-1234-4123-8123-123456789abc';
const message = `fix: repair qualification episode 42\n\nStation repair run: ${plan.runId}`;
const identity = {
  name: 'Station qualification repair',
  email: 'qualification-repair@users.noreply.github.com',
  date: plan.completedAt,
};
const authorLine = `Station qualification repair <qualification-repair@users.noreply.github.com> ${Date.parse(plan.completedAt) / 1000} +0000`;
const rawCommit = `tree ${plan.expectedTreeSha}\nparent ${plan.baseSha}\nauthor ${authorLine}\ncommitter ${authorLine}\n\n${message}`;
const commitSha = createHash('sha1')
  .update(`commit ${Buffer.byteLength(rawCommit)}\0${rawCommit}`)
  .digest('hex');
const blobSha = createHash('sha1').update('blob 9\0repaired\n').digest('hex');
const commit = {
  sha: commitSha,
  tree: { sha: plan.expectedTreeSha },
  parents: [{ sha: plan.baseSha }],
  author: identity,
  committer: identity,
  message,
};

type Call = {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  authorization: string;
};
function harness(
  options: {
    response?: (call: Call) => Response | undefined;
    existingRef?: boolean;
    existingPr?: Record<string, unknown>;
  } = {},
) {
  const calls: Call[] = [];
  const events: string[] = [];
  const checkpoints: RepairPublicationCheckpoint[] = [];
  let active = true;
  let consumed = false;
  let credentialActive = true;
  let epoch = now;
  const lease: RepairPublicationLease = {
    assertCurrent: vi.fn(async () => {
      if (!active) throw new Error('revoked grant');
    }),
    begin: vi.fn(async () => {
      if (consumed) return false;
      consumed = true;
      events.push('begin');
      return true;
    }),
    checkpoint: vi.fn(async (value) => {
      checkpoints.push(value);
      events.push(value.phase);
    }),
    finish: vi.fn(async () => {
      events.push('finish');
    }),
    indeterminate: vi.fn(async () => {
      events.push('indeterminate');
    }),
  };
  const pullRequest = (body: Record<string, unknown>) => ({
    number: 23,
    html_url: 'https://github.com/owner/repo/pull/23',
    state: 'open',
    draft: true,
    title: body.title,
    body: body.body,
    head: { ref: branch, sha: commitSha, repo: { id: 19 } },
    base: { ref: 'main', sha: plan.baseSha, repo: { id: 19 } },
  });
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status });
  const resolveAppPrivateKey: RepairPublisherDependencies['resolveAppPrivateKey'] =
    vi.fn(async () => {
      events.push('key');
      return {
        privateKey,
        assertCurrent: vi.fn(async () => {
          if (!credentialActive) throw new Error('revoked key');
        }),
      };
    });
  const controlledFetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(url.startsWith('https://api.github.com/')).toBe(true);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const call: Call = {
      method: init.method ?? 'GET',
      path: url.slice('https://api.github.com'.length),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      authorization: new Headers(init.headers).get('authorization') ?? '',
    };
    calls.push(call);
    events.push(`${call.method} ${call.path}`);
    const overridden = options.response?.(call);
    if (overridden) return overridden;
    if (call.path === '/app') return json({ id: 7 });
    if (call.path === '/app/installations/8')
      return json({ id: 8, app_id: 7, account: { login: 'owner' } });
    if (call.path === '/app/installations/8/access_tokens')
      return json({
        token: 'installation-secret',
        expires_at: '2026-10-31T13:00:00.000Z',
        permissions: {
          contents: 'write',
          pull_requests: 'write',
          metadata: 'read',
        },
        repositories: [{ id: 19, full_name: 'owner/repo' }],
      });
    if (call.path === '/installation/repositories?per_page=2')
      return json({
        total_count: 1,
        repositories: [{ id: 19, full_name: 'owner/repo' }],
      });
    if (call.path === '/repos/owner/repo')
      return json({ id: 19, full_name: 'owner/repo', default_branch: 'main' });
    if (call.path.endsWith('/git/ref/heads/main'))
      return json({ object: { type: 'commit', sha: plan.baseSha } });
    if (call.path.endsWith(`/git/commits/${plan.baseSha}`))
      return json({ sha: plan.baseSha, tree: { sha: plan.baseTreeSha } });
    if (call.path.endsWith(`/git/ref/heads/${branch}`))
      return options.existingRef
        ? json({ object: { type: 'commit', sha: commitSha } })
        : json({}, 404);
    if (call.path.endsWith('/git/blobs')) return json({ sha: blobSha }, 201);
    if (call.path.endsWith('/git/trees'))
      return json({ sha: plan.expectedTreeSha }, 201);
    if (
      call.path.endsWith('/git/commits') ||
      call.path.endsWith(`/git/commits/${commitSha}`)
    )
      return json(commit, 201);
    if (call.path.endsWith('/git/refs'))
      return json(
        {
          ref: `refs/heads/${branch}`,
          object: { type: 'commit', sha: commitSha },
        },
        201,
      );
    if (call.path.includes('/pulls?'))
      return json(options.existingPr ? [options.existingPr] : []);
    if (call.path.endsWith('/pulls') && call.body)
      return json(pullRequest(call.body), 201);
    throw new Error(`Unexpected HTTP request ${call.method} ${call.path}`);
  });
  return {
    calls,
    events,
    checkpoints,
    lease,
    resolveAppPrivateKey,
    controlledFetch,
    pullRequest,
    dependencies: {
      resolveAppPrivateKey,
      fetch: controlledFetch,
      now: () => epoch,
    },
    revokeGrant: () => {
      active = false;
    },
    revokeCredential: () => {
      credentialActive = false;
    },
    advance: (ms: number) => {
      epoch += ms;
    },
  };
}

describe('trusted repair publication HTTP boundary', () => {
  it('uses a narrowed App token to create exact Git objects, a new branch and a human-reviewed draft', async () => {
    const h = harness();
    const result = await publishRepair(plan, h.lease, h.dependencies);
    expect(result).toEqual({
      outcome: 'published',
      runId: plan.runId,
      bindingDigest: plan.bindingDigest,
      resultDigest: plan.resultDigest,
      branch,
      treeSha: plan.expectedTreeSha,
      commitSha,
      pullRequestNumber: 23,
      pullRequestUrl: 'https://github.com/owner/repo/pull/23',
    });
    expect(h.events.slice(0, 2)).toEqual(['begin', 'key']);
    const jwt = h.calls[0].authorization.slice('Bearer '.length).split('.');
    expect(JSON.parse(Buffer.from(jwt[0], 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(jwt[1], 'base64url').toString())).toEqual({
      iat: now / 1000 - 30,
      exp: now / 1000 + 120,
      iss: '7',
    });
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(jwt.slice(0, 2).join('.')),
        publicKey,
        Buffer.from(jwt[2], 'base64url'),
      ),
    ).toBe(true);
    const posts = h.calls.filter((call) => call.method === 'POST');
    expect(posts.map((call) => call.path)).toEqual([
      '/app/installations/8/access_tokens',
      '/repos/owner/repo/git/blobs',
      '/repos/owner/repo/git/trees',
      '/repos/owner/repo/git/commits',
      '/repos/owner/repo/git/refs',
      '/repos/owner/repo/pulls',
    ]);
    expect(posts[0].body).toEqual({
      repository_ids: [19],
      permissions: { contents: 'write', pull_requests: 'write' },
    });
    expect(posts[1].body).toEqual({
      content: 'cmVwYWlyZWQK',
      encoding: 'base64',
    });
    expect(posts[2].body).toEqual({
      base_tree: plan.baseTreeSha,
      tree: [
        {
          path: 'src-server/fix.ts',
          mode: '100644',
          type: 'blob',
          sha: blobSha,
        },
        {
          path: 'src-server/obsolete.ts',
          mode: '100755',
          type: 'blob',
          sha: null,
        },
      ],
    });
    expect(posts[3].body).toEqual({
      message,
      tree: plan.expectedTreeSha,
      parents: [plan.baseSha],
      author: identity,
      committer: identity,
    });
    expect(posts[4].body).toEqual({
      ref: `refs/heads/${branch}`,
      sha: commitSha,
    });
    expect(posts[5].body).toMatchObject({
      head: branch,
      base: 'main',
      draft: true,
      maintainer_can_modify: false,
    });
    expect(posts[5].body?.body).toContain(
      'https://github.com/owner/repo/actions/runs/41',
    );
    expect(posts[5].body?.body).toContain(
      'Independent review: `review-independent`',
    );
    expect(JSON.stringify(result)).not.toContain('installation-secret');
    expect(JSON.stringify(h.checkpoints)).not.toContain('installation-secret');
    for (const [phase, path] of [
      ['blob-intent', '/git/blobs'],
      ['tree-intent', '/git/trees'],
      ['commit-intent', '/git/commits'],
      ['ref-intent', '/git/refs'],
      ['pull-request-intent', '/pulls'],
    ])
      expect(h.events.indexOf(phase)).toBeLessThan(
        h.events.indexOf(`POST /repos/owner/repo${path}`),
      );
    expect(h.lease.finish).toHaveBeenCalledWith(result);
  });

  it('denies corrupt plans and protected paths before consuming authority or reading a secret', async () => {
    const invalid: RepairPublicationPlan[] = [
      { ...plan, repository: 'owner/repo/../../elsewhere' },
      { ...plan, taskIncarnation: 'not-a-date' },
      { ...plan, bindingDigest: 'broken' },
      ...[
        '.github/workflows/x.yml',
        'src-server/services/automation/repair-publisher.ts',
        'packages/contracts/src/qualification-repair-policy.mjs',
        'src-server/security/authority.ts',
        'src-server/services/foo/grant-store.ts',
        './src-server/fix.ts',
        'src-server/.git/config',
      ].map((path) => ({ ...plan, files: [{ ...plan.files[0], path }] })),
      {
        ...plan,
        files: [{ ...plan.files[0], contentBase64: 'cmVwYWlyZWQK\n' }],
      },
      { ...plan, files: [{ ...plan.files[0], mode: '120000' as '100644' }] },
      {
        ...plan,
        files: [plan.files[0], { ...plan.files[0], path: 'SRC-SERVER/fix.ts' }],
      },
    ];
    for (const proposal of invalid) {
      const h = harness();
      await expect(
        publishRepair(proposal, h.lease, h.dependencies),
      ).rejects.toThrow();
      expect(h.lease.begin).not.toHaveBeenCalled();
      expect(h.resolveAppPrivateKey).not.toHaveBeenCalled();
      expect(h.calls).toHaveLength(0);
    }
    const h = harness();
    h.revokeGrant();
    await expect(
      publishRepair(plan, h.lease, h.dependencies),
    ).rejects.toThrow();
    expect(h.resolveAppPrivateKey).not.toHaveBeenCalled();
    expect(h.lease.begin).not.toHaveBeenCalled();
  });

  it.each([
    ['/app', { id: 999 }, 'app-identity-mismatch'],
    [
      '/app/installations/8',
      { id: 8, app_id: 999, account: { login: 'owner' } },
      'installation-identity-mismatch',
    ],
    [
      '/installation/repositories?per_page=2',
      { total_count: 2, repositories: [{ id: 19 }] },
      'installation-scope-mismatch',
    ],
    [
      '/repos/owner/repo',
      { id: 999, full_name: 'owner/repo', default_branch: 'main' },
      'repository-identity-mismatch',
    ],
    [
      '/repos/owner/repo/git/ref/heads/main',
      { object: { sha: 'd'.repeat(40), type: 'commit' } },
      'base-ref-mismatch',
    ],
    [
      `/repos/owner/repo/git/commits/${plan.baseSha}`,
      { sha: plan.baseSha, tree: { sha: 'd'.repeat(40) } },
      'base-tree-mismatch',
    ],
    [
      `/repos/owner/repo/git/ref/heads/${branch}`,
      { object: { sha: 'd'.repeat(40), type: 'commit' } },
      'existing-ref-mismatch',
    ],
    [
      '/repos/owner/repo/git/blobs',
      { sha: 'd'.repeat(40) },
      'blob-sha-mismatch',
    ],
    [
      '/repos/owner/repo/git/trees',
      { sha: 'd'.repeat(40) },
      'result-tree-mismatch',
    ],
    [
      '/repos/owner/repo/git/commits',
      { ...commit, parents: [{ sha: 'd'.repeat(40) }] },
      'commit-mismatch',
    ],
  ])(
    'stops on mismatched remote identity at %s',
    async (path, response, reasonCode) => {
      const h = harness({
        response: (call) =>
          call.path === path ? Response.json(response) : undefined,
      });
      const result = await publishRepair(plan, h.lease, h.dependencies);
      expect(result).toEqual({
        outcome: 'indeterminate',
        runId: plan.runId,
        reasonCode,
      });
      expect(h.calls.at(-1)?.path).toBe(path);
      expect(h.lease.indeterminate).toHaveBeenCalledWith(reasonCode);
      expect(h.lease.finish).not.toHaveBeenCalled();
      expect(
        h.calls.some(
          (call) =>
            call.path.endsWith('/git/refs') || call.path.endsWith('/pulls'),
        ),
      ).toBe(false);
    },
  );

  it('rejects broader token permissions or repository scope before any repository write', async () => {
    for (const change of [
      {
        permissions: {
          contents: 'write',
          pull_requests: 'write',
          workflows: 'write',
        },
      },
      {
        repositories: [
          { id: 19, full_name: 'owner/repo' },
          { id: 20, full_name: 'owner/other' },
        ],
      },
    ]) {
      const h = harness({
        response: (call) =>
          call.path.endsWith('/access_tokens')
            ? Response.json({
                token: 'installation-secret',
                expires_at: '2026-10-31T13:00:00Z',
                permissions: { contents: 'write', pull_requests: 'write' },
                repositories: [{ id: 19, full_name: 'owner/repo' }],
                ...change,
              })
            : undefined,
      });
      expect((await publishRepair(plan, h.lease, h.dependencies)).outcome).toBe(
        'indeterminate',
      );
      expect(h.calls.at(-1)?.path).toBe('/app/installations/8/access_tokens');
    }
  });

  it('observes an exact existing branch and draft without rewriting Git objects or opening another PR', async () => {
    const first = harness();
    await publishRepair(plan, first.lease, first.dependencies);
    const proposal = first.calls.find((call) =>
      call.path.endsWith('/pulls'),
    )?.body;
    if (!proposal) throw new Error('Missing PR request');
    const h = harness({
      existingRef: true,
      existingPr: first.pullRequest(proposal),
    });
    expect((await publishRepair(plan, h.lease, h.dependencies)).outcome).toBe(
      'published',
    );
    expect(
      h.calls.filter((call) => call.method === 'POST').map((call) => call.path),
    ).toEqual(['/app/installations/8/access_tokens']);
  });

  it('rechecks grant and credential currentness immediately before subsequent requests', async () => {
    for (const revoke of ['grant', 'credential']) {
      const h = harness({
        response: (call) => {
          if (call.path.endsWith('/git/blobs')) {
            if (revoke === 'grant') h.revokeGrant();
            else h.revokeCredential();
          }
          return undefined;
        },
      });
      expect((await publishRepair(plan, h.lease, h.dependencies)).outcome).toBe(
        'indeterminate',
      );
      expect(h.calls.at(-1)?.path).toBe('/repos/owner/repo/git/blobs');
    }
  });

  it('does not retry an unknown ref effect or reconsume the attempt', async () => {
    const h = harness({
      response: (call) => {
        if (call.path.endsWith('/git/refs'))
          throw new Error(
            'socket closed after remote write; installation-secret',
          );
        return undefined;
      },
    });
    const result = await publishRepair(plan, h.lease, h.dependencies);
    expect(result).toEqual({
      outcome: 'indeterminate',
      runId: plan.runId,
      reasonCode: 'publication-outcome-unknown',
    });
    expect(
      h.calls.filter((call) => call.path.endsWith('/git/refs')),
    ).toHaveLength(1);
    expect(h.checkpoints.at(-1)?.phase).toBe('ref-intent');
    expect(h.lease.finish).not.toHaveBeenCalled();
    const count = h.calls.length;
    await expect(publishRepair(plan, h.lease, h.dependencies)).rejects.toThrow(
      'publication-already-consumed',
    );
    expect(h.calls).toHaveLength(count);
    expect(h.resolveAppPrivateKey).toHaveBeenCalledTimes(1);
  });

  it('fences unknown durable attempt consumption before reading a secret', async () => {
    const h = harness();
    h.lease.begin = vi.fn(async () => {
      throw new Error('ledger connection lost after consume');
    });
    expect(await publishRepair(plan, h.lease, h.dependencies)).toEqual({
      outcome: 'indeterminate',
      runId: plan.runId,
      reasonCode: 'publication-consumption-unknown',
    });
    expect(h.resolveAppPrivateKey).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0);
    expect(h.lease.indeterminate).toHaveBeenCalledWith(
      'publication-consumption-unknown',
    );
  });

  it('keeps a crash after a remote effect indeterminate when durable observation fails', async () => {
    const h = harness();
    h.lease.checkpoint = vi.fn(async (checkpoint) => {
      if (checkpoint.phase === 'ref-observed')
        throw new Error('ledger unavailable');
    });
    expect((await publishRepair(plan, h.lease, h.dependencies)).outcome).toBe(
      'indeterminate',
    );
    expect(h.calls.at(-1)?.path).toBe('/repos/owner/repo/git/refs');
    expect(h.lease.indeterminate).toHaveBeenCalledWith(
      'publication-outcome-unknown',
    );
  });

  it('refuses oversized responses and the publication deadline before another request', async () => {
    const oversized = harness({
      response: (call) =>
        call.path === '/app'
          ? new Response('{}', { headers: { 'content-length': '2097153' } })
          : undefined,
    });
    expect(
      await publishRepair(plan, oversized.lease, oversized.dependencies),
    ).toMatchObject({
      outcome: 'indeterminate',
      reasonCode: 'response-too-large',
    });
    expect(oversized.calls).toHaveLength(1);
    const deadline = harness({
      response: (call) => {
        if (call.path === '/app') deadline.advance(120_001);
        return undefined;
      },
    });
    expect(
      await publishRepair(plan, deadline.lease, deadline.dependencies),
    ).toMatchObject({
      outcome: 'indeterminate',
      reasonCode: 'publication-deadline',
    });
    expect(deadline.calls).toHaveLength(1);
  });
});

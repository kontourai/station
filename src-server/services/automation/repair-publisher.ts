import {
  createHash,
  createPrivateKey,
  type KeyObject,
  sign,
} from 'node:crypto';
import { validateRepairPaths } from '@kontourai/station-contracts/qualification-repair-policy';

export interface RepairPublicationPlan {
  runId: string;
  bindingDigest: string;
  resultDigest: string;
  taskIncarnation: string;
  repository: string;
  repositoryId: number;
  failedRun: number;
  failedSha: string;
  episode: number;
  attempt: string;
  issue?: number;
  baseSha: string;
  baseTreeSha: string;
  expectedTreeSha: string;
  files: readonly {
    path: string;
    mode: '100644' | '100755';
    contentBase64: string | null;
  }[];
  completedAt: string;
  appId: number;
  installationId: number;
  reviewId: string;
  grantId: string;
}

export interface RepairPublicationCheckpoint {
  phase:
    | 'credential-intent'
    | 'credential-observed'
    | 'blob-intent'
    | 'blob-observed'
    | 'tree-intent'
    | 'tree-observed'
    | 'commit-intent'
    | 'commit-observed'
    | 'ref-intent'
    | 'ref-observed'
    | 'pull-request-intent'
    | 'pull-request-observed';
  path?: string;
  blobSha?: string;
  treeSha?: string;
  commitSha?: string;
  branch?: string;
  pullRequestNumber?: number;
}

export type RepairPublicationReceipt =
  | {
      outcome: 'published';
      runId: string;
      bindingDigest: string;
      resultDigest: string;
      branch: string;
      treeSha: string;
      commitSha: string;
      pullRequestNumber: number;
      pullRequestUrl: string;
    }
  | {
      outcome: 'indeterminate';
      runId: string;
      reasonCode: string;
    };

/** Internal ledger capability: never deserialize or accept this from a client. */
export interface RepairPublicationLease {
  /** Revalidates binding, Task incarnation, current review/grant and stopped workers. */
  assertCurrent(): Promise<void>;
  /** Durably consumes this publication attempt using compare-and-set. */
  begin(): Promise<boolean>;
  checkpoint(checkpoint: RepairPublicationCheckpoint): Promise<void>;
  finish(
    receipt: Extract<RepairPublicationReceipt, { outcome: 'published' }>,
  ): Promise<void>;
  indeterminate(reasonCode: string): Promise<void>;
}

export interface RepairPublisherDependencies {
  resolveAppPrivateKey(identity: {
    appId: number;
    installationId: number;
  }): Promise<{
    privateKey: string | Buffer | KeyObject;
    /** Revalidates credential binding/revocation without exposing key material. */
    assertCurrent(): Promise<void>;
  }>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
}

class PublicationError extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}
const requireThat = (condition: unknown, code: string): void => {
  if (!condition) throw new PublicationError(code);
};
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const positiveId = (value: unknown): boolean =>
  Number.isSafeInteger(value) && Number(value) > 0;
const isoDate = (value: unknown): boolean =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const safeId = (value: unknown): boolean =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const gitHash = (type: string, value: Buffer): string =>
  createHash('sha1')
    .update(`${type} ${value.length}\0`)
    .update(value)
    .digest('hex');
const identity = {
  name: 'Station qualification repair',
  email: 'qualification-repair@users.noreply.github.com',
};

function snapshotPlan(input: RepairPublicationPlan): RepairPublicationPlan {
  requireThat(input && typeof input === 'object', 'invalid-plan');
  requireThat(
    typeof input.repository === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(
        input.repository,
      ) &&
      !input.repository.endsWith('.git'),
    'invalid-repository',
  );
  requireThat(
    typeof input.runId === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        input.runId,
      ),
    'invalid-run-id',
  );
  requireThat(
    digestPattern.test(input.bindingDigest) &&
      digestPattern.test(input.resultDigest),
    'invalid-digest',
  );
  requireThat(
    isoDate(input.taskIncarnation) && isoDate(input.completedAt),
    'invalid-time',
  );
  requireThat(
    [
      input.repositoryId,
      input.failedRun,
      input.episode,
      input.appId,
      input.installationId,
    ].every(positiveId) &&
      (input.issue === undefined || positiveId(input.issue)),
    'invalid-identity',
  );
  requireThat(
    typeof input.attempt === 'string' &&
      /^[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$/.test(input.attempt) &&
      safeId(input.reviewId) &&
      safeId(input.grantId),
    'invalid-authority-identity',
  );
  requireThat(
    [
      input.failedSha,
      input.baseSha,
      input.baseTreeSha,
      input.expectedTreeSha,
    ].every((sha) => typeof sha === 'string' && shaPattern.test(sha)),
    'invalid-sha',
  );
  requireThat(
    Array.isArray(input.files) &&
      input.files.length > 0 &&
      input.files.length <= 40,
    'invalid-files',
  );
  try {
    validateRepairPaths(input.files.map((file) => file?.path));
  } catch {
    throw new PublicationError('protected-or-invalid-path');
  }
  let total = 0;
  const files = input.files
    .map((file) => {
      requireThat(
        file && ['100644', '100755'].includes(file.mode),
        'invalid-file-mode',
      );
      if (file.contentBase64 !== null) {
        requireThat(
          typeof file.contentBase64 === 'string' &&
            file.contentBase64.length <= 174_764,
          'invalid-file-content',
        );
        const bytes = Buffer.from(file.contentBase64, 'base64');
        requireThat(
          bytes.length <= 128 * 1024 &&
            bytes.toString('base64') === file.contentBase64,
          'noncanonical-base64',
        );
        total += bytes.length;
      }
      requireThat(total <= 1024 * 1024, 'patch-too-large');
      return {
        path: file.path,
        mode: file.mode,
        contentBase64: file.contentBase64,
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    runId: input.runId,
    bindingDigest: input.bindingDigest,
    resultDigest: input.resultDigest,
    taskIncarnation: input.taskIncarnation,
    repository: input.repository,
    repositoryId: input.repositoryId,
    failedRun: input.failedRun,
    failedSha: input.failedSha,
    episode: input.episode,
    attempt: input.attempt,
    issue: input.issue,
    baseSha: input.baseSha,
    baseTreeSha: input.baseTreeSha,
    expectedTreeSha: input.expectedTreeSha,
    files,
    completedAt: input.completedAt,
    appId: input.appId,
    installationId: input.installationId,
    reviewId: input.reviewId,
    grantId: input.grantId,
  };
}

type Json = Record<string, unknown>;
function object(value: unknown): Json {
  requireThat(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid-github-response',
  );
  return value as Json;
}
function permissions(value: unknown): void {
  const found = object(value);
  requireThat(
    found.contents === 'write' &&
      found.pull_requests === 'write' &&
      Object.entries(found).every(([key, access]) =>
        key === 'contents' || key === 'pull_requests'
          ? access === 'write'
          : key === 'metadata' && access === 'read',
      ),
    'token-permission-mismatch',
  );
}

/** No checkout, hooks, project code, patch application or subprocess enters this path. */
export async function publishRepair(
  input: RepairPublicationPlan,
  lease: RepairPublicationLease,
  dependencies: RepairPublisherDependencies,
): Promise<RepairPublicationReceipt> {
  const plan = snapshotPlan(input);
  const now = dependencies.now ?? Date.now;
  const started = now();
  const wallStarted = Date.now();
  const remaining = (): number =>
    Math.min(120_000 - (now() - started), 120_000 - (Date.now() - wallStarted));
  const bounded = async <T>(
    operation: () => Promise<T>,
    limit = 10_000,
  ): Promise<T> => {
    const timeout = Math.min(limit, remaining());
    requireThat(timeout > 0, 'publication-deadline');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new PublicationError('publication-timeout')),
            timeout,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  await bounded(() => lease.assertCurrent());
  let began: boolean;
  try {
    began = await bounded(() => lease.begin());
  } catch {
    await bounded(() =>
      lease.indeterminate('publication-consumption-unknown'),
    ).catch(() => {});
    return {
      outcome: 'indeterminate',
      runId: plan.runId,
      reasonCode: 'publication-consumption-unknown',
    };
  }
  requireThat(began, 'publication-already-consumed');
  try {
    await bounded(() => lease.assertCurrent());
    const credential = await bounded(() =>
      dependencies.resolveAppPrivateKey({
        appId: plan.appId,
        installationId: plan.installationId,
      }),
    );
    await bounded(() => credential.assertCurrent());
    const privateKey =
      typeof credential.privateKey === 'object' &&
      !Buffer.isBuffer(credential.privateKey)
        ? credential.privateKey
        : createPrivateKey(credential.privateKey);
    requireThat(
      privateKey.type === 'private' &&
        privateKey.asymmetricKeyType === 'rsa' &&
        (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048,
      'invalid-app-key',
    );
    const seconds = Math.floor(now() / 1000);
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iat: seconds - 30, exp: seconds + 120, iss: String(plan.appId) })).toString('base64url')}`;
    const jwt = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
    const root = `/repos/${plan.repository}`;
    const branch = `repair/qualification-${plan.episode}-station-${plan.runId}`;
    const message = `fix: repair qualification episode ${plan.episode}\n\nStation repair run: ${plan.runId}`;
    const timestamp = Math.floor(Date.parse(plan.completedAt) / 1000);
    const author = `${identity.name} <${identity.email}> ${timestamp} +0000`;
    const commitSha = gitHash(
      'commit',
      Buffer.from(
        `tree ${plan.expectedTreeSha}\nparent ${plan.baseSha}\nauthor ${author}\ncommitter ${author}\n\n${message}`,
      ),
    );
    const title = 'fix: repair scheduled main qualification';
    const body =
      `Bounded Station repair of https://github.com/${plan.repository}/actions/runs/${plan.failedRun}.\n\n` +
      `Episode: ${plan.episode}; attempt: ${plan.attempt}; run: ${plan.runId}.\n` +
      `Failed source: \`${plan.failedSha}\`; repair base: \`${plan.baseSha}\`; result tree: \`${plan.expectedTreeSha}\`.\n` +
      `Recorded binding: \`${plan.bindingDigest}\`; result: \`${plan.resultDigest}\`.\n` +
      `Independent review: \`${plan.reviewId}\`; publication grant: \`${plan.grantId}\`.\n` +
      (plan.issue ? `Verified repair issue: #${plan.issue}.\n` : '') +
      '\nThis draft requires human review and a human merge decision. Required checks and fresh qualification remain separate evidence.';
    const allowed = new Set([
      'GET /app',
      `GET /app/installations/${plan.installationId}`,
      `POST /app/installations/${plan.installationId}/access_tokens`,
      'GET /installation/repositories?per_page=2',
      `GET ${root}`,
      `GET ${root}/git/ref/heads/main`,
      `GET ${root}/git/commits/${plan.baseSha}`,
      `GET ${root}/git/ref/heads/${branch}`,
      `GET ${root}/git/commits/${commitSha}`,
      `GET ${root}/pulls?state=all&head=${plan.repository.split('/')[0]}:${branch}&base=main&per_page=2`,
      ...['blobs', 'trees', 'commits', 'refs'].map(
        (name) => `POST ${root}/git/${name}`,
      ),
      `POST ${root}/pulls`,
    ]);
    let requests = 0;
    let tokenExpiry = Infinity;
    const request = async (
      method: 'GET' | 'POST',
      path: string,
      token: string,
      payload?: unknown,
      missing = false,
    ): Promise<unknown> => {
      requireThat(
        allowed.has(`${method} ${path}`) && ++requests <= 96,
        'request-not-allowed',
      );
      const encoded =
        payload === undefined ? undefined : JSON.stringify(payload);
      requireThat(
        encoded === undefined || Buffer.byteLength(encoded) <= 2 * 1024 * 1024,
        'request-too-large',
      );
      await bounded(() => lease.assertCurrent());
      await bounded(() => credential.assertCurrent());
      requireThat(now() + 10_000 < tokenExpiry, 'credential-expired');
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.min(10_000, remaining()),
      );
      try {
        return await bounded(async () => {
          const response = await (dependencies.fetch ?? fetch)(
            `https://api.github.com${path}`,
            {
              method,
              redirect: 'error',
              signal: controller.signal,
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': 'application/json',
                'User-Agent': 'Station-qualification-repair',
              },
              body: encoded,
            },
          );
          requireThat(
            !response.redirected &&
              (!response.url ||
                response.url === `https://api.github.com${path}`),
            'github-origin-mismatch',
          );
          if (missing && response.status === 404) {
            await response.body?.cancel();
            return null;
          }
          requireThat(response.ok, `github-http-${response.status}`);
          const declared = response.headers.get('content-length');
          requireThat(
            !declared ||
              (/^\d+$/.test(declared) && Number(declared) <= 2 * 1024 * 1024),
            'response-too-large',
          );
          const reader = response.body?.getReader();
          requireThat(reader, 'empty-github-response');
          if (!reader) throw new PublicationError('empty-github-response');
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              requireThat(bytes <= 2 * 1024 * 1024, 'response-too-large');
              chunks.push(chunk.value);
            }
            return JSON.parse(
              Buffer.concat(chunks).toString('utf8'),
            ) as unknown;
          } finally {
            await reader.cancel().catch(() => {});
          }
        });
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    };
    const app = object(await request('GET', '/app', jwt));
    requireThat(app.id === plan.appId, 'app-identity-mismatch');
    const installation = object(
      await request('GET', `/app/installations/${plan.installationId}`, jwt),
    );
    requireThat(
      installation.id === plan.installationId &&
        installation.app_id === plan.appId &&
        object(installation.account).login === plan.repository.split('/')[0] &&
        !installation.suspended_at,
      'installation-identity-mismatch',
    );
    await bounded(() => lease.checkpoint({ phase: 'credential-intent' }));
    const minted = object(
      await request(
        'POST',
        `/app/installations/${plan.installationId}/access_tokens`,
        jwt,
        {
          repository_ids: [plan.repositoryId],
          permissions: { contents: 'write', pull_requests: 'write' },
        },
      ),
    );
    requireThat(
      typeof minted.token === 'string' &&
        minted.token.length > 0 &&
        minted.token.length <= 4096,
      'invalid-installation-token',
    );
    permissions(minted.permissions);
    requireThat(
      Array.isArray(minted.repositories) &&
        minted.repositories.length === 1 &&
        object(minted.repositories[0]).id === plan.repositoryId &&
        object(minted.repositories[0]).full_name === plan.repository,
      'token-repository-mismatch',
    );
    requireThat(
      typeof minted.expires_at === 'string' &&
        Number.isFinite(Date.parse(minted.expires_at)),
      'invalid-token-expiry',
    );
    tokenExpiry = Date.parse(String(minted.expires_at));
    const token = String(minted.token);
    await bounded(() => lease.checkpoint({ phase: 'credential-observed' }));
    const scope = object(
      await request('GET', '/installation/repositories?per_page=2', token),
    );
    requireThat(
      scope.total_count === 1 &&
        Array.isArray(scope.repositories) &&
        scope.repositories.length === 1 &&
        object(scope.repositories[0]).id === plan.repositoryId &&
        object(scope.repositories[0]).full_name === plan.repository,
      'installation-scope-mismatch',
    );
    const repository = object(await request('GET', root, token));
    requireThat(
      repository.id === plan.repositoryId &&
        repository.full_name === plan.repository &&
        repository.default_branch === 'main' &&
        !repository.archived &&
        !repository.disabled,
      'repository-identity-mismatch',
    );
    const baseRef = object(
      await request('GET', `${root}/git/ref/heads/main`, token),
    );
    requireThat(
      object(baseRef.object).sha === plan.baseSha &&
        object(baseRef.object).type === 'commit',
      'base-ref-mismatch',
    );
    const baseCommit = object(
      await request('GET', `${root}/git/commits/${plan.baseSha}`, token),
    );
    requireThat(
      baseCommit.sha === plan.baseSha &&
        object(baseCommit.tree).sha === plan.baseTreeSha,
      'base-tree-mismatch',
    );
    const validateCommit = (value: unknown): void => {
      const commit = object(value);
      const foundAuthor = object(commit.author);
      const foundCommitter = object(commit.committer);
      requireThat(
        commit.sha === commitSha &&
          object(commit.tree).sha === plan.expectedTreeSha &&
          Array.isArray(commit.parents) &&
          commit.parents.length === 1 &&
          object(commit.parents[0]).sha === plan.baseSha &&
          commit.message === message &&
          [foundAuthor, foundCommitter].every(
            (entry) =>
              entry.name === identity.name &&
              entry.email === identity.email &&
              Date.parse(String(entry.date)) === timestamp * 1000,
          ),
        'commit-mismatch',
      );
    };
    const existing = await request(
      'GET',
      `${root}/git/ref/heads/${branch}`,
      token,
      undefined,
      true,
    );
    if (existing !== null) {
      requireThat(
        object(object(existing).object).sha === commitSha &&
          object(object(existing).object).type === 'commit',
        'existing-ref-mismatch',
      );
      validateCommit(
        await request('GET', `${root}/git/commits/${commitSha}`, token),
      );
    } else {
      const tree = [];
      for (const file of plan.files) {
        let sha: string | null = null;
        if (file.contentBase64 !== null) {
          sha = gitHash('blob', Buffer.from(file.contentBase64, 'base64'));
          await bounded(() =>
            lease.checkpoint({
              phase: 'blob-intent',
              path: file.path,
              blobSha: sha ?? undefined,
            }),
          );
          const blob = object(
            await request('POST', `${root}/git/blobs`, token, {
              content: file.contentBase64,
              encoding: 'base64',
            }),
          );
          requireThat(blob.sha === sha, 'blob-sha-mismatch');
          await bounded(() =>
            lease.checkpoint({
              phase: 'blob-observed',
              path: file.path,
              blobSha: sha ?? undefined,
            }),
          );
        }
        tree.push({ path: file.path, mode: file.mode, type: 'blob', sha });
      }
      await bounded(() =>
        lease.checkpoint({
          phase: 'tree-intent',
          treeSha: plan.expectedTreeSha,
        }),
      );
      const createdTree = object(
        await request('POST', `${root}/git/trees`, token, {
          base_tree: plan.baseTreeSha,
          tree,
        }),
      );
      requireThat(
        createdTree.sha === plan.expectedTreeSha,
        'result-tree-mismatch',
      );
      await bounded(() =>
        lease.checkpoint({
          phase: 'tree-observed',
          treeSha: plan.expectedTreeSha,
        }),
      );
      await bounded(() =>
        lease.checkpoint({ phase: 'commit-intent', commitSha }),
      );
      validateCommit(
        await request('POST', `${root}/git/commits`, token, {
          message,
          tree: plan.expectedTreeSha,
          parents: [plan.baseSha],
          author: {
            ...identity,
            date: new Date(timestamp * 1000).toISOString(),
          },
          committer: {
            ...identity,
            date: new Date(timestamp * 1000).toISOString(),
          },
        }),
      );
      await bounded(() =>
        lease.checkpoint({ phase: 'commit-observed', commitSha }),
      );
      await bounded(() =>
        lease.checkpoint({ phase: 'ref-intent', branch, commitSha }),
      );
      const ref = object(
        await request('POST', `${root}/git/refs`, token, {
          ref: `refs/heads/${branch}`,
          sha: commitSha,
        }),
      );
      requireThat(
        ref.ref === `refs/heads/${branch}` &&
          object(ref.object).sha === commitSha &&
          object(ref.object).type === 'commit',
        'created-ref-mismatch',
      );
    }
    await bounded(() =>
      lease.checkpoint({ phase: 'ref-observed', branch, commitSha }),
    );
    const listed = await request(
      'GET',
      `${root}/pulls?state=all&head=${plan.repository.split('/')[0]}:${branch}&base=main&per_page=2`,
      token,
    );
    requireThat(
      Array.isArray(listed) && listed.length <= 1,
      'ambiguous-repair-pr',
    );
    let pr: Json;
    if (Array.isArray(listed) && listed.length === 1) pr = object(listed[0]);
    else {
      await bounded(() =>
        lease.checkpoint({ phase: 'pull-request-intent', branch, commitSha }),
      );
      pr = object(
        await request('POST', `${root}/pulls`, token, {
          title,
          body,
          head: branch,
          base: 'main',
          draft: true,
          maintainer_can_modify: false,
        }),
      );
    }
    requireThat(
      positiveId(pr.number) &&
        pr.state === 'open' &&
        pr.draft === true &&
        !pr.merged_at &&
        pr.title === title &&
        pr.body === body &&
        object(pr.head).ref === branch &&
        object(pr.head).sha === commitSha &&
        object(object(pr.head).repo).id === plan.repositoryId &&
        object(pr.base).ref === 'main' &&
        object(pr.base).sha === plan.baseSha &&
        object(object(pr.base).repo).id === plan.repositoryId &&
        pr.html_url ===
          `https://github.com/${plan.repository}/pull/${pr.number}`,
      'pull-request-mismatch',
    );
    const receipt: Extract<RepairPublicationReceipt, { outcome: 'published' }> =
      {
        outcome: 'published',
        runId: plan.runId,
        bindingDigest: plan.bindingDigest,
        resultDigest: plan.resultDigest,
        branch,
        treeSha: plan.expectedTreeSha,
        commitSha,
        pullRequestNumber: Number(pr.number),
        pullRequestUrl: String(pr.html_url),
      };
    await bounded(() =>
      lease.checkpoint({
        phase: 'pull-request-observed',
        branch,
        commitSha,
        pullRequestNumber: receipt.pullRequestNumber,
      }),
    );
    await bounded(() => lease.assertCurrent());
    await bounded(() => lease.finish(receipt));
    return receipt;
  } catch (error) {
    const reasonCode =
      error instanceof PublicationError
        ? error.reasonCode
        : 'publication-outcome-unknown';
    // A failed checkpoint or unknown HTTP outcome never permits automatic reconsumption.
    await bounded(() => lease.indeterminate(reasonCode)).catch(() => {});
    return { outcome: 'indeterminate', runId: plan.runId, reasonCode };
  }
}

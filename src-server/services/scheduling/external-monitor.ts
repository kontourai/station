import { createHash } from 'node:crypto';
import type {
  ExternalMonitorConfig,
  ExternalMonitorDecision,
  ExternalMonitorObservation,
  ExternalMonitorState,
} from '@kontourai/station-contracts/external-monitor';
import type { IntegrationSecretResolver } from '../secrets/secret-binding-administration.js';

const API = 'https://api.github.com';
export const GITHUB_PROBE_DEADLINE_MS = 10_000;
export const GITHUB_PROBE_MAX_BYTES = 128 * 1024;
export const GITHUB_PROBE_MAX_PAGES = 4;
/** Refusal diagnostics are not source capture; inspect one bounded fragment. */
export const GITHUB_403_DIAGNOSTIC_MAX_BYTES = 4 * 1024;
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/;
export type MonitorFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;
export type GitHubPullRequestTarget = Readonly<{
  owner: string;
  repository: string;
  number: number;
}>;

export function parseGitHubPullRequestTarget(
  target: string,
): GitHubPullRequestTarget {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error('Monitor target must be an HTTPS GitHub pull request URL');
  }
  const p = url.pathname.split('/').filter(Boolean);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    p.length !== 4 ||
    p[2] !== 'pull' ||
    !NAME.test(p[0]) ||
    !NAME.test(p[1]) ||
    !/^[1-9][0-9]{0,8}$/.test(p[3])
  )
    throw new Error(
      'Monitor target must be exactly https://github.com/<owner>/<repo>/pull/<number>',
    );
  return { owner: p[0], repository: p[1], number: Number(p[3]) };
}
const obs = (
  outcome: ExternalMonitorObservation['outcome'],
  detail: string,
  extra: Partial<ExternalMonitorObservation> = {},
): ExternalMonitorObservation => ({
  outcome,
  observedAt: new Date().toISOString(),
  detail,
  ...extra,
});
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
async function json(
  fetcher: MonitorFetch,
  url: string,
  init: RequestInit,
): Promise<
  | { value: unknown; sourceTime?: string; link?: string }
  | { outcome: 'terminal' | 'unauthorized' | 'unavailable'; detail: string }
> {
  const r = await abortable(fetcher(url, init), init.signal);
  if (r.redirected || r.type === 'opaqueredirect')
    return {
      outcome: 'unavailable',
      detail: 'GitHub probe refused a redirect.',
    };
  if (r.status === 401)
    return {
      outcome: 'unauthorized',
      detail: 'GitHub did not authorize this monitor credential.',
    };
  if (r.status === 403)
    return (await githubRateLimited(r))
      ? {
          outcome: 'unavailable',
          detail: 'GitHub rate limit prevented this probe.',
        }
      : {
          outcome: 'unauthorized',
          detail: 'GitHub did not authorize this monitor credential.',
        };
  if (r.status === 404 || r.status === 410)
    return { outcome: 'terminal', detail: 'The pull request is unavailable.' };
  if (!r.ok)
    return {
      outcome: 'unavailable',
      detail: `GitHub probe returned HTTP ${r.status}.`,
    };
  const length = Number(r.headers.get('content-length') ?? '0');
  if (!Number.isFinite(length) || length > GITHUB_PROBE_MAX_BYTES)
    return {
      outcome: 'unavailable',
      detail: 'GitHub response exceeded the monitor byte limit.',
    };
  const reader = r.body?.getReader();
  if (!reader)
    return { outcome: 'unavailable', detail: 'GitHub response had no body.' };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const n = await reader.read();
    if (n.done) break;
    size += n.value.byteLength;
    if (size > GITHUB_PROBE_MAX_BYTES) {
      await reader.cancel();
      return {
        outcome: 'unavailable',
        detail: 'GitHub response exceeded the monitor byte limit.',
      };
    }
    chunks.push(n.value);
  }
  try {
    return {
      value: JSON.parse(
        new TextDecoder().decode(
          Buffer.concat(chunks.map((x) => Buffer.from(x))),
        ),
      ),
      sourceTime: r.headers.get('date') ?? undefined,
      link: r.headers.get('link') ?? undefined,
    };
  } catch {
    return {
      outcome: 'unavailable',
      detail: 'GitHub returned malformed monitor data.',
    };
  }
}

async function githubRateLimited(response: Response): Promise<boolean> {
  if (
    response.headers.get('x-ratelimit-remaining') === '0' ||
    response.headers.has('retry-after')
  )
    return true;
  // GitHub's secondary/abuse response is a 403 whose only reliable marker is
  // its JSON message. A counted reader prevents an attacker from hiding that
  // marker beyond an arbitrary oversized first chunk.
  const reader = response.body?.getReader();
  if (!reader) return false;
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (bytes <= GITHUB_403_DIAGNOSTIC_MAX_BYTES) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = GITHUB_403_DIAGNOSTIC_MAX_BYTES + 1 - bytes;
      chunks.push(next.value.slice(0, remaining));
      bytes += next.value.byteLength;
      if (bytes > GITHUB_403_DIAGNOSTIC_MAX_BYTES) break;
    }
    return /secondary rate limit|abuse detection/i.test(
      new TextDecoder().decode(
        Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).subarray(
          0,
          GITHUB_403_DIAGNOSTIC_MAX_BYTES,
        ),
      ),
    );
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | null | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function nextPage(
  link: string | undefined,
  expectedPath: string,
): string | undefined | null {
  if (!link) return undefined;
  const match = link
    .split(',')
    .map((part) => part.trim())
    .find((part) => /rel="?next"?/i.test(part));
  if (!match) return undefined;
  const address = /^<([^>]+)>/.exec(match)?.[1];
  if (!address) return null;
  try {
    const url = new URL(address);
    return url.origin === API && url.pathname === expectedPath
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

async function pages(
  fetcher: MonitorFetch,
  first: string,
  expectedPath: string,
  init: RequestInit,
  extract: (value: unknown) => readonly unknown[] | undefined,
  total: (value: unknown) => number | undefined,
): Promise<
  | readonly unknown[]
  | { outcome: 'terminal' | 'unauthorized' | 'unavailable'; detail: string }
> {
  const values: unknown[] = [];
  let url: string | undefined = first;
  let declaredTotal: number | undefined;
  for (let page = 0; url && page < GITHUB_PROBE_MAX_PAGES; page += 1) {
    const response = await json(fetcher, url, init);
    if ('outcome' in response) return response;
    const rows = extract(response.value);
    if (!rows)
      return {
        outcome: 'unavailable',
        detail: 'GitHub monitor pagination response was incomplete.',
      };
    const count = total(response.value);
    if (
      count !== undefined &&
      (!Number.isInteger(count) || count < rows.length)
    )
      return {
        outcome: 'unavailable',
        detail: 'GitHub monitor pagination response was incomplete.',
      };
    if (declaredTotal === undefined) declaredTotal = count;
    else if (count !== undefined && count !== declaredTotal)
      return {
        outcome: 'unavailable',
        detail: 'GitHub monitor pagination changed while being read.',
      };
    values.push(...rows);
    const next = nextPage(response.link, expectedPath);
    if (next === null)
      return {
        outcome: 'unavailable',
        detail: 'GitHub monitor pagination response was incomplete.',
      };
    url = next;
  }
  if (url || (declaredTotal !== undefined && values.length !== declaredTotal))
    return {
      outcome: 'unavailable',
      detail: 'GitHub monitor pagination response was incomplete.',
    };
  return values;
}
export function decideExternalMonitor(input: {
  state?: ExternalMonitorState;
  observation: ExternalMonitorObservation;
  actionable: boolean;
  budget?: ExternalMonitorConfig['budget'];
}): ExternalMonitorDecision {
  const s = input.state ?? {};
  // A source/task terminal is sticky. Cadence may keep observing, but only an
  // explicit restart can make a new revision eligible to spend a model turn.
  if (s.lastOutcome === 'terminal')
    return {
      outcome: 'terminal',
      shouldDispatch: false,
      nextAction: 'Restart this monitor explicitly before dispatching again.',
    };
  // Budget exhaustion is policy, not a transient probe failure. Do not let a
  // later healthy source observation revive it; explicit restart owns that.
  if (s.lastOutcome === 'budget-exhausted')
    return {
      outcome: 'budget-exhausted',
      shouldDispatch: false,
      nextAction: 'Restart this monitor explicitly after reviewing its budget.',
    };
  const exhausted =
    s.usageKnown === false ||
    (input.budget?.maxTurns !== undefined &&
      (s.completedTurns ?? 0) >= input.budget.maxTurns) ||
    (input.budget?.maxTokens !== undefined &&
      (s.consumedTokens ?? 0) >= input.budget.maxTokens) ||
    (input.budget?.maxRuntimeMs !== undefined &&
      (s.consumedRuntimeMs ?? 0) >= input.budget.maxRuntimeMs);
  if (exhausted)
    return {
      outcome: 'budget-exhausted',
      shouldDispatch: false,
      nextAction: 'Review monitor budget and completed-turn accounting.',
    };
  if (input.observation.outcome !== 'pending')
    return {
      outcome: input.observation.outcome,
      fingerprint: input.observation.fingerprint,
      shouldDispatch: false,
      nextAction:
        input.observation.detail ?? 'Observe the next scheduled check.',
    };
  if (!input.actionable)
    return {
      outcome: 'pending',
      fingerprint: input.observation.fingerprint,
      shouldDispatch: false,
      nextAction: 'Review-ready observation succeeded without a task.',
    };
  if (!input.observation.fingerprint)
    return {
      outcome: 'unavailable',
      shouldDispatch: false,
      nextAction: 'Probe did not provide a canonical fingerprint.',
    };
  if (!s.lastSuccessfulFingerprint)
    return {
      outcome: 'baseline',
      fingerprint: input.observation.fingerprint,
      shouldDispatch: false,
      nextAction: 'Baseline recorded; a later revision may trigger a task.',
    };
  if (
    s.lastSuccessfulFingerprint === input.observation.fingerprint ||
    s.lastTriggeredFingerprint === input.observation.fingerprint
  )
    return {
      outcome: 'unchanged',
      fingerprint: input.observation.fingerprint,
      shouldDispatch: false,
      nextAction: 'No revision change detected.',
    };
  return {
    outcome: 'actionable',
    fingerprint: input.observation.fingerprint,
    shouldDispatch: true,
    nextAction: 'Dispatch exactly one task for this revision.',
  };
}
export async function probeGitHubPullRequest(
  config: ExternalMonitorConfig,
  fetcher: MonitorFetch = fetch,
  resolver?: IntegrationSecretResolver,
): Promise<{ observation: ExternalMonitorObservation; actionable: boolean }> {
  if (
    config.kind !== 'github-pull-request' ||
    config.objective !== 'review-ready'
  )
    throw new Error('Unsupported external monitor');
  const t = parseGitHubPullRequestTarget(config.target),
    c = new AbortController(),
    timer = setTimeout(() => c.abort(), GITHUB_PROBE_DEADLINE_MS);
  let secret:
    | Awaited<ReturnType<IntegrationSecretResolver['resolveForIntegration']>>
    | undefined;
  let settled = false;
  try {
    if (config.credentialSecretBinding) {
      if (!resolver)
        return {
          observation: obs(
            'unauthorized',
            'GitHub credential binding is unavailable.',
          ),
          actionable: false,
        };
      const resolution = resolver.resolveForIntegration({
        integrationId: 'external-monitor:github-pull-request',
        secretEnvRefs: { GITHUB_TOKEN: config.credentialSecretBinding },
      });
      // Aborting a wait does not abort a resolver (the binding may be backed
      // by a keychain or external runner). Keep observing it: if it grants
      // after the probe deadline, immediately release that grant as failed
      // rather than retaining secret material with no child to consume it.
      void resolution.then(
        (late) => {
          if (c.signal.aborted)
            late.settlement.settle({
              outcome: 'failure',
              reason: 'child_establishment_failed',
            });
        },
        () => undefined,
      );
      secret = await abortable(resolution, c.signal);
    }
    if (c.signal.aborted)
      return {
        observation: obs('unavailable', 'GitHub probe timed out.'),
        actionable: false,
      };
    const base = `${API}/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repository)}`,
      init = {
        method: 'GET',
        redirect: 'error' as const,
        signal: c.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Station-external-monitor',
          ...(secret?.environment.GITHUB_TOKEN
            ? { Authorization: `Bearer ${secret.environment.GITHUB_TOKEN}` }
            : {}),
        },
      };
    const pr = await json(fetcher, `${base}/pulls/${t.number}`, init);
    if ('outcome' in pr)
      return { observation: obs(pr.outcome, pr.detail), actionable: false };
    const p = rec(pr.value),
      head = p && rec(p.head);
    if (
      !p ||
      !head ||
      typeof head.sha !== 'string' ||
      typeof p.state !== 'string' ||
      typeof p.draft !== 'boolean'
    )
      return {
        observation: obs(
          'unavailable',
          'GitHub pull request response was incomplete.',
        ),
        actionable: false,
      };
    if (p.state === 'closed' || p.merged_at)
      return {
        observation: obs('terminal', 'The pull request is closed or merged.', {
          sourceTime:
            typeof p.updated_at === 'string' ? p.updated_at : undefined,
        }),
        actionable: false,
      };
    const checkPath = `/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repository)}/commits/${encodeURIComponent(head.sha)}/check-runs`;
    const reviewPath = `/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repository)}/pulls/${t.number}/reviews`;
    const checks = await pages(
      fetcher,
      `${API}${checkPath}?per_page=100`,
      checkPath,
      init,
      (value) => {
        const record = rec(value);
        return Array.isArray(record?.check_runs)
          ? record.check_runs
          : undefined;
      },
      (value) =>
        typeof rec(value)?.total_count === 'number'
          ? (rec(value)?.total_count as number)
          : undefined,
    );
    if (!Array.isArray(checks)) {
      const failed = checks as {
        outcome: 'terminal' | 'unauthorized' | 'unavailable';
        detail: string;
      };
      return {
        observation: obs(failed.outcome, failed.detail),
        actionable: false,
      };
    }
    const reviews = await pages(
      fetcher,
      `${API}${reviewPath}?per_page=100`,
      reviewPath,
      init,
      (value) => (Array.isArray(value) ? value : undefined),
      () => undefined,
    );
    if (!Array.isArray(reviews)) {
      const failed = reviews as {
        outcome: 'terminal' | 'unauthorized' | 'unavailable';
        detail: string;
      };
      return {
        observation: obs(failed.outcome, failed.detail),
        actionable: false,
      };
    }
    const runs = checks;
    const stableRuns = runs
      .map(rec)
      .filter((x): x is Record<string, unknown> => Boolean(x))
      .map((x) => ({
        name: x.name,
        status: x.status,
        conclusion: x.conclusion ?? '',
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const latestReviews = new Map<string, { state: string; at: number }>();
    for (const value of reviews) {
      const review = rec(value),
        user = review && rec(review.user);
      const reviewer =
        user &&
        (typeof user.login === 'string'
          ? user.login
          : typeof user.id === 'number'
            ? String(user.id)
            : undefined);
      const state = review?.state;
      if (!reviewer || typeof state !== 'string')
        return {
          observation: obs(
            'unavailable',
            'GitHub monitor response was partial.',
          ),
          actionable: false,
        };
      const submitted =
        typeof review.submitted_at === 'string'
          ? Date.parse(review.submitted_at)
          : Number.NaN;
      const at = Number.isFinite(submitted)
        ? submitted
        : Number(review.id ?? 0);
      const current = latestReviews.get(reviewer);
      if (!current || at >= current.at)
        latestReviews.set(reviewer, { state: state.toUpperCase(), at });
    }
    const stableReviews = [...latestReviews.entries()]
      .map(([reviewer, review]) => ({ reviewer, state: review.state }))
      .sort((a, b) => a.reviewer.localeCompare(b.reviewer));
    if (
      stableRuns.length !== runs.length ||
      stableRuns.some(
        (x) => typeof x.name !== 'string' || typeof x.status !== 'string',
      )
    )
      return {
        observation: obs('unavailable', 'GitHub monitor response was partial.'),
        actionable: false,
      };
    const failing = stableRuns.some((x) =>
        ['failure', 'timed_out', 'cancelled', 'action_required'].includes(
          String(x.conclusion),
        ),
      ),
      pending = stableRuns.some((x) => x.status !== 'completed'),
      changes = stableReviews.some(
        (review) => review.state === 'CHANGES_REQUESTED',
      ),
      conflict = p.mergeable === false || p.mergeable_state === 'dirty',
      actionable = !p.draft && !pending && (failing || changes || conflict),
      fp = createHash('sha256')
        .update(
          JSON.stringify({
            head: head.sha,
            draft: p.draft,
            state: p.state,
            mergeable:
              p.mergeable === false
                ? 'conflict'
                : p.mergeable === true
                  ? 'clean'
                  : 'pending',
            checks: stableRuns,
            reviews: stableReviews,
          }),
        )
        .digest('hex');
    secret?.settlement.settle({ outcome: 'success' });
    settled = true;
    return {
      observation: obs(
        // A completed, clean non-draft PR has satisfied this monitor's only
        // objective. It is not a quiet "pending" sample: terminalizing it
        // lets the scheduler make one durable completion announcement.
        !p.draft && !pending && !actionable ? 'terminal' : 'pending',
        p.draft || pending
          ? 'Pull request is draft or checks are pending.'
          : actionable
            ? 'Checks, review, or mergeability require action.'
            : 'Pull request is review-ready.',
        {
          fingerprint: fp,
          sourceTime:
            typeof p.updated_at === 'string' ? p.updated_at : undefined,
        },
      ),
      actionable,
    };
  } catch (e) {
    return {
      observation: obs(
        'unavailable',
        e instanceof Error && e.name === 'AbortError'
          ? 'GitHub probe timed out.'
          : 'GitHub probe failed.',
      ),
      actionable: false,
    };
  } finally {
    clearTimeout(timer);
    if (secret && !settled)
      secret.settlement.settle({
        outcome: 'failure',
        reason: 'child_establishment_failed',
      });
  }
}

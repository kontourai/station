import type {
  TaskAssignmentClaimActor,
  TaskRecord,
  TaskStatus,
} from './task-graph.js';

/**
 * Work-item provider seam (roadmap #583, part of epic #580, S3).
 *
 * Station's Tasks board renders work items from one or more provider
 * backends behind a single, provider-neutral shape. Today there are two
 * backends:
 *
 * - `local` — an adapter over `TaskGraphService.listTasks` (no storage
 *   change; today's `task-graph.json` tasks, unchanged).
 * - `flow-agents-github` — a read-only backend that resolves the shared
 *   `@kontourai/flow-agents` backlog provider settings for a project
 *   workspace (workspace -> project -> defaults, exactly as the pinned
 *   package's `effective-backlog-settings` CLI resolves them) and, when a
 *   GitHub-backed config is present, lists ready work items via the pinned
 *   package's `pull-work-provider` CLI. No Station-specific provider config
 *   is invented — Station reads the same files any flow-agents-aware host
 *   would.
 *
 * `ProviderWorkItem.status` reuses `TaskStatus` (`@kontourai/station-contracts
 * /task-graph`'s `TASK_STATUSES`). Its Flow-compatible values align with the
 * package's public `workItemStatuses`; Station's explicit local `triage` and
 * `canceled` values remain valid only in this projection.
 *
 * Flow Agents 6.5.1 exports mutation adapters, but its live read CLI returns
 * a filtered ready queue, not the exact-item observation needed for safe
 * write-back. This presentation seam remains read-only pending that upstream
 * contract (kontourai/flow-agents#1508; Decision 4 in
 * docs/design/work-plane-composition.md). Gaps are recorded in
 * docs/plans/task-tracker-sync-upstream-gaps.md.
 * `WorkItemProviderCapabilities` below is how a backend declares that today;
 * both shipped backends declare `supportsStatusWrite: false`.
 */

/** Stable backend identity kinds. Extend when a new backend ships. */
export const WORK_ITEM_PROVIDER_KINDS = [
  'local',
  'flow-agents-github',
] as const;

export type WorkItemEngineId = (typeof WORK_ITEM_PROVIDER_KINDS)[number];

export interface WorkItemProviderIdentity {
  kind: WorkItemEngineId;
  /** Stable id for this concrete provider instance (e.g. `local`, or
   * `flow-agents-github:owner/repo` once a GitHub-backed repo is resolved). */
  id: string;
  /** Human-readable label for the source provider chip. */
  label: string;
}

export interface WorkItemProviderCapabilities {
  /** True when this backend has no write path at all (read-only backend). */
  readOnly: boolean;
  /** True once dispatch-as-claim (S4, AssignmentProvider) is wired. */
  supportsDispatch: boolean;
  /** True once status/field write-back (FA2, post-bump) is wired. */
  supportsStatusWrite: boolean;
}

/** A single provider-neutral work item, as rendered on the Tasks board. */
export interface ProviderWorkItem {
  /** Provider-neutral id (e.g. a TaskRecord id, or `github:owner/repo#123`). */
  id: string;
  title: string;
  status: TaskStatus;
  /** Concrete identity of the item's source (may be more specific than the
   * backend's own `identity`, e.g. carrying the resolved owner/repo). */
  provider: WorkItemProviderIdentity;
  /**
   * Provider-neutral reference future dispatch can join against
   * `TaskRecord.workItemRef` (roadmap #580 Decision 3/4). Set for every
   * provider-backed item; absent only for local items with no upstream
   * work-item link.
   *
   * CONTRACT INVARIANT: this value MUST be globally namespaced across every
   * backend (e.g. `github:owner/repo#123`, never a bare `123`) — Station's
   * Tasks board de-dupes/joins a provider item against a local task by
   * comparing this string directly (see `externalProviderItems` in
   * `ProjectTasksSection.tsx`, the #583 review finding on false-hiding). A
   * bare, unnamespaced id from a future backend could otherwise collide with
   * an unrelated local task's `workItemRef` and be silently hidden as
   * "already joined" — the join deliberately refuses to treat an
   * unnamespaced ref (no `:` separator) as a safe cross-provider key, but
   * every backend should still emit namespaced refs so its items are
   * actually joinable at all.
   */
  workItemRef?: string;
  url?: string;
  labels?: string[];
  priority?: string;
  updatedAt?: string;
}

/** What a single backend returned for one project, before capability/identity
 * enrichment by the aggregator. */
export interface WorkItemProviderListResult {
  /** False when the backend has nothing to report for this project (no
   * settings, no CLI, malformed output, or a genuine runtime failure) — the
   * board falls back to local-only behavior. Never throws. */
  available: boolean;
  items: ProviderWorkItem[];
  /** Advisory-only messages (e.g. a `zero_ready_items` dead-source warning
   * passed through from the flow-agents CLI). Never a substitute for
   * `available`/`reason`. */
  warnings?: string[];
  /** Present when `available` is false — the reason the board should show
   * (or silently ignore) rather than inventing one client-side. */
  reason?: string;
}

/** One backend's result, enriched with its identity/capabilities — the
 * per-provider entry in the aggregated Tasks board response. */
export interface WorkItemProviderResult extends WorkItemProviderListResult {
  identity: WorkItemProviderIdentity;
  capabilities: WorkItemProviderCapabilities;
}

/** Aggregated response across every registered backend for one project. */
export interface WorkItemsListResponse {
  providers: WorkItemProviderResult[];
}

/**
 * `GET /api/projects/:slug/work-items/claim?subjectId=<ref>` response shape
 * (roadmap #584, part of epic #580, S4). Generic AssignmentProvider claim
 * read for any namespaced `workItemRef` — a local task's `workItemRef` or a
 * raw `ProviderWorkItem.workItemRef` from any backend, since the claim
 * itself is keyed by subject id, not by which backend rendered the row. The
 * caller (Tasks board UI) derives "claimed by me" by comparing
 * `actor.sessionId` against a specific task's own `sessionId` when one
 * exists; this endpoint has no task context of its own.
 */
export type WorkItemClaimState = 'free' | 'claimed' | 'unavailable';

export interface WorkItemClaimStatus {
  subjectId: string;
  state: WorkItemClaimState;
  actor?: TaskAssignmentClaimActor;
  reason?: string;
}

/**
 * Exact-item observation of one tracker work item (epic #4003,
 * docs/design/tracker-backed-tasks.md "Reading the tracker"). Unlike
 * `ProviderWorkItem`, which is a row from a backend's filtered ready queue,
 * an observation is one item read by its exact identity, at a known time.
 *
 * Station re-reads the item when a person opens the Task, when a Session is
 * dispatched, and when a Session asks for its brief; nothing polls. GitHub issues only in this slice: a pull
 * request is `unsupported`, and so is any host other than github.com.
 */
export interface WorkItemObservedComment {
  /** Tracker login of the comment's author. */
  author: string;
  createdAt: string;
  /** The comment body, cut to {@link WORK_ITEM_OBSERVATION_LIMITS}
   * `.commentExcerptChars`; a cut excerpt ends with `…`. */
  excerpt: string;
}

export interface WorkItemObservation {
  workItemRef: string;
  url: string;
  title: string;
  state: 'open' | 'closed';
  /** The tracker's own reason, e.g. GitHub's `completed` or `not_planned`. */
  stateReason?: string;
  labels: string[];
  updatedAt: string;
  /** When Station read the item. */
  observedAt: string;
  /** Cut to {@link WORK_ITEM_OBSERVATION_LIMITS}`.bodyChars`; a cut body ends
   * with a visible `[truncated]` marker. Absent when the item has none. */
  body?: string;
  /** Newest last, at most {@link WORK_ITEM_OBSERVATION_LIMITS}`.comments`.
   * With `commentsSince`, only comments created after it; a full list means
   * there may be more ("at least N"). */
  comments?: WorkItemObservedComment[];
}

export type WorkItemObservationResult =
  | { status: 'observed'; observation: WorkItemObservation }
  | {
      status: 'not-found' | 'unauthenticated' | 'unavailable' | 'unsupported';
      reason: string;
    };

/**
 * `GET /api/tasks/:taskId/work-item`: the Task's linked item re-read now.
 * `commentsSince` is the Task's last recorded observation
 * (`TaskRecord.workItemObservedAt`); the observation's comments are the ones
 * created after it.
 */
export type TaskWorkItemObservationResponse = WorkItemObservationResult & {
  commentsSince?: string;
};

/** `POST /api/tasks/from-work-item` result. `existing` means the item already
 * had an open Task, which is returned unchanged. `briefSaved` is false when
 * the new Task's document could not be seeded from the item. When that open
 * Task is in another Project, only its id and Project are returned
 * (`elsewhere: true`). */
export type StartTaskFromWorkItemResult =
  | {
      task: TaskRecord;
      existing: boolean;
      briefSaved: boolean;
    }
  | {
      task: Pick<TaskRecord, 'id' | 'projectId'>;
      existing: true;
      elsewhere: true;
      briefSaved: false;
    };

/** Bounds an observation's free text, so a long issue cannot become an
 * unbounded Task brief. */
export const WORK_ITEM_OBSERVATION_LIMITS = {
  bodyChars: 6000,
  commentExcerptChars: 1000,
  comments: 30,
} as const;

/** A parsed `github:owner/repo#N` work-item reference. */
export interface GitHubWorkItemIdentity {
  owner: string;
  repo: string;
  number: number;
}

// GitHub's own rules: an owner is 1-39 alphanumerics or single inner
// hyphens; a repository name is 1-100 of `[A-Za-z0-9._-]` and never `.` or
// `..`; an issue number is a positive integer without a leading zero.
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_ISSUE_NUMBER = /^[1-9][0-9]{0,14}$/;
const GITHUB_WORK_ITEM_REF = /^github:([^/#\s]+)\/([^/#\s]+)#([^#\s]+)$/;

function gitHubIdentity(
  owner: string,
  repo: string,
  number: string,
): GitHubWorkItemIdentity | null {
  if (
    !GITHUB_OWNER.test(owner) ||
    !GITHUB_REPO.test(repo) ||
    repo === '.' ||
    repo === '..' ||
    !GITHUB_ISSUE_NUMBER.test(number)
  )
    return null;
  const parsed = Number(number);
  // GitHub compares owner and repository names case-insensitively, so the
  // canonical identity is lowercase (review F5): `Org/Repo#1` and
  // `org/repo#1` are one item.
  return Number.isSafeInteger(parsed)
    ? { owner: owner.toLowerCase(), repo: repo.toLowerCase(), number: parsed }
    : null;
}

/**
 * Parses exactly `github:owner/repo#N`. Anything else, including GitHub
 * Enterprise hosts, surrounding whitespace and a bare `#N`, is `null`, which
 * a caller reports as `unsupported`. Owner and repository come back
 * lowercase, GitHub's case-insensitive identity; see
 * {@link canonicalGitHubWorkItemRef}.
 */
export function parseGitHubWorkItemRef(
  ref: string,
): GitHubWorkItemIdentity | null {
  const match = GITHUB_WORK_ITEM_REF.exec(ref);
  return match ? gitHubIdentity(match[1], match[2], match[3]) : null;
}

/** The canonical (lowercase) spelling of a GitHub ref, or `null` when
 * {@link parseGitHubWorkItemRef} refuses it. */
export function canonicalGitHubWorkItemRef(ref: string): string | null {
  const identity = parseGitHubWorkItemRef(ref);
  return identity ? formatGitHubWorkItemRef(identity) : null;
}

/**
 * The key two work-item refs are compared by: a GitHub ref's canonical
 * spelling, and any other ref exactly as written.
 */
export function workItemRefKey(ref: string): string {
  return canonicalGitHubWorkItemRef(ref) ?? ref;
}

/** A ref in the `github:` namespace, whether or not it parses. */
export function isGitHubNamespacedWorkItemRef(ref: string): boolean {
  return /^\s*github:/i.test(ref);
}

export function formatGitHubWorkItemRef(
  identity: GitHubWorkItemIdentity,
): string {
  return `github:${identity.owner}/${identity.repo}#${identity.number}`;
}

/** `github:owner/repo#N` -> `https://github.com/owner/repo/issues/N`, or
 * `null` for any ref {@link parseGitHubWorkItemRef} refuses. */
export function gitHubIssueUrlFromWorkItemRef(ref: string): string | null {
  const identity = parseGitHubWorkItemRef(ref);
  return identity
    ? `https://github.com/${identity.owner}/${identity.repo}/issues/${identity.number}`
    : null;
}

/**
 * `https://github.com/owner/repo/issues/N` -> `github:owner/repo#N`. Only
 * that exact shape on github.com: no credentials, port, query, fragment,
 * trailing slash or other path (a `/pull/N` URL is refused), and no other
 * host, including `www.github.com` and GitHub Enterprise.
 */
export function workItemRefFromGitHubIssueUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    // `new URL` normalizes `/a/../b`; require the input to be the canonical
    // spelling so a path the parser rewrote is not silently accepted.
    url !== parsed.href
  )
    return null;
  const segments = parsed.pathname.split('/');
  if (segments.length !== 5 || segments[0] !== '' || segments[3] !== 'issues')
    return null;
  const identity = gitHubIdentity(segments[1], segments[2], segments[4]);
  return identity ? formatGitHubWorkItemRef(identity) : null;
}

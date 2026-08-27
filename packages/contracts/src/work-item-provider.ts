import type { TaskAssignmentClaimActor, TaskStatus } from './task-graph.js';

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
 * Write-back (status/field mutations) is out of scope this slice — it is an
 * upstream Flow Agents engine contract extension (epic #580 Decision 4,
 * flow-agents FA2, kontourai/flow-agents#776). Flow Agents 5.7 exports its
 * work-item interfaces, but Station deliberately keeps this presentation
 * seam read-only until it has an authorized provider mutation contract.
 * `WorkItemProviderCapabilities` below is how a backend declares that today;
 * both shipped backends declare `supportsStatusWrite: false`.
 */

/** Stable backend identity kinds. Extend when a new backend ships. */
export const WORK_ITEM_PROVIDER_KINDS = [
  'local',
  'flow-agents-github',
] as const;

export type WorkItemProviderKind = (typeof WORK_ITEM_PROVIDER_KINDS)[number];

export interface WorkItemProviderIdentity {
  kind: WorkItemProviderKind;
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

/**
 * CRITIQUE-DETECTION MIRROR (only) of `@kontourai/flow-agents`' review-
 * critique reading helpers — issue archive#778 originally, extended for roadmap
 * archive#753 (S6 follow-up) to close the `hasUnresolvedCritique` gap this file's
 * header used to document as a scope reduction; part of the work-plane-
 * composition epic (`kontourai/station-archive#580`, slice S6, roadmap archive#586).
 *
 * RETIREMENT (roadmap archive#753 / flow-agents#933, archive#933-follow-up): this
 * file used to ALSO hand-mirror flow-agents' workflow-status -> Console
 * process-status mapping table (`WORKFLOW_STATUS_TO_CONSOLE_PROCESS_STATUS`,
 * `mapWorkflowStatusToConsoleProcessStatus`, `deriveConsoleProcessBlockedReason`)
 * because no importable subpath existed for it. flow-agents#933 shipped that
 * exact contract as `@kontourai/flow-agents/console-contract` (published in
 * `5.3.0`, the pin this repo now carries) — station bumped past that release
 * and deleted the mirrored table/mappers here; every former importer now
 * imports the real functions/types from `@kontourai/flow-agents/console-contract`
 * directly (see `operating-state-service.ts`). Do not re-add that table to
 * this file — see `intent-binding-mirror.ts`'s prior deletion in this same
 * slice for precedent.
 *
 * WHY WHAT REMAINS HERE STILL EXISTS (same anti-drift precedent as
 * `intent-binding-mirror.ts`'s history in `station-intent-bindings.ts`'s
 * header, and `packages/contracts/src/__tests__/flow-agents-vocabulary-drift.test.ts`):
 * `@kontourai/flow-agents@5.3.0`'s `./console-contract` subpath (verified
 * against the pinned tarball's `build/src/console-contract.js`) exports ONLY
 * `WORKFLOW_STATUS_TO_CONSOLE_PROCESS_STATUS`, `mapWorkflowStatusToConsoleProcessStatus`,
 * `deriveConsoleProcessBlockedReason`, and the projection/status types — it
 * deliberately does NOT export the critique-detection helpers
 * (`hasUnresolvedLiveCritique`, `filterCritiquesForSlug`) or the bundle-
 * reading step (`critiquesFromBundle`, `src/cli/workflow-sidecar.ts`) that
 * feed `hasUnresolvedCritique` into the mapper — those remain internal to
 * flow-agents' own CLI. Station cannot `import` them (Node's `exports` field
 * blocks any deep import outside the declared subpaths — the same boundary
 * constitution non-negotiable #1 requires respecting), so `hasUnresolvedLiveCritique`
 * and `filterCritiquesForSlug` below stay byte-for-byte BEHAVIORAL mirrors of
 * flow-agents' pure functions of the same names (`src/lib/workflow-process-
 * projection.ts`, verified against the pinned `5.3.0` tag) — NOT a
 * re-derivation or reinterpretation of them.
 *
 * `__tests__/workflow-process-projection-mirror.console-contract-tripwire.test.ts`
 * is the trip-wire for this narrowed scope: it imports
 * `@kontourai/flow-agents/console-contract` and FAILS with a clear
 * retire-me message the moment that subpath starts exporting
 * `hasUnresolvedLiveCritique`/`filterCritiquesForSlug` — the signal that
 * this file's remaining mirror can finally be deleted the same way the
 * status-table mirror was. `workflow-process-projection-mirror.test.ts`
 * additionally pins `hasUnresolvedLiveCritique`/`filterCritiquesForSlug`
 * against representative fixtures so a future manual re-sync (a version bump
 * that changes flow-agents' upstream critique semantics) surfaces as a
 * failing pin instead of drifting silently — there is no accessible "real
 * export" these two functions can trip-wire against directly, so a semantic
 * change upstream needs a MANUAL re-sync, tracked the same way as before.
 *
 * Critique detection (roadmap archive#753, closing the prior scope reduction): the
 * upstream `mapWorkflowStatusToConsoleProcessStatus` also derives a
 * `review_pending` refinement from `trust.bundle`'s live critique claims, via
 * flow-agents' own `critiquesFromBundle` (`src/cli/workflow-sidecar.ts`) plus
 * its pure join-key helpers `hasUnresolvedLiveCritique`/
 * `filterCritiquesForSlug` (`src/lib/workflow-process-projection.ts`) — none
 * of which are exported under any public subpath. `hasUnresolvedLiveCritique`
 * and `filterCritiquesForSlug` below are byte-for-byte BEHAVIORAL mirrors of
 * those two pure functions (verified against the pinned 5.3.0 tag). The
 * per-session trust.bundle READ itself is not mirrored from
 * `critiquesFromBundle` verbatim — that function's `die()`-on-malformed-claim
 * posture is a deliberate CLI fail-loud contract this service does not want
 * (a bad trust.bundle must degrade one session, never crash the whole board,
 * matching this service's `WorkflowSidecarService.listTasks`-established
 * per-task degrade rule) — `critiquesFromTrustBundle` below instead does a
 * best-effort, purely defensive extraction of the three fields the two pure
 * helpers need (`verdict`/`superseded_by`/`workflow_subject_ref`) from
 * claims stamped `metadata.origin === "critique"`, silently skipping any
 * claim shape it does not recognize rather than throwing. `operating-
 * state-service.ts`'s `WorkflowSidecarService.readTrustBundle` supplies the
 * raw parsed JSON (or `null` when absent/unreadable, warned and skipped —
 * see that service's own per-task try/catch). This defensive deviation from
 * upstream's fail-loud posture is deliberate and stays even after the
 * status-table mirror above it was retired.
 */

import type { WorkflowHandoff } from '@kontourai/station-contracts/workflow';

/** Extracts non-empty handoff blockers, or undefined when there are none. */
export function handoffBlockers(
  handoff: WorkflowHandoff | null,
): string[] | undefined {
  const blockers = handoff?.blockers?.filter(
    (entry) => entry.trim().length > 0,
  );
  return blockers && blockers.length > 0 ? blockers : undefined;
}

/**
 * A critique claim as read back from `trust.bundle` — only the fields
 * `hasUnresolvedLiveCritique`/`filterCritiquesForSlug` need. Mirrors
 * flow-agents' own `BundleCritique` type
 * (`src/lib/workflow-process-projection.ts`, pinned 5.3.0).
 */
export interface BundleCritique {
  verdict?: unknown;
  superseded_by?: unknown;
  workflow_subject_ref?: unknown;
}

/**
 * Minimal, defensive shape of one `trust.bundle` claim — only the fields
 * `critiquesFromTrustBundle` reads. `trust.bundle` ships no JSON Schema
 * (verified against the pinned package, see `workflow-sidecar-service.ts`'s
 * `readTrustBundle`), so every field here is read as `unknown` and narrowed
 * before use — no field is ever trusted to be present or well-typed.
 */
interface RawTrustBundleClaim {
  id?: unknown;
  value?: unknown;
  metadata?: {
    origin?: unknown;
    superseded_by?: unknown;
    workflow_subject_ref?: unknown;
  };
}

/**
 * Best-effort, purely defensive extraction of critique claims from a parsed
 * `trust.bundle` (see this file's header, "Critique detection", for why this
 * is NOT a mirror of `critiquesFromBundle`'s fail-loud posture). Any shape
 * this function does not recognize is silently skipped rather than thrown —
 * the caller (`operating-state-service.ts`) treats "no critiques recognized"
 * the same as "no critiques exist" (never a crash) — EXCEPT for a claim
 * that is a genuinely SUSPICIOUS partial shape (an object claim that
 * carries a `metadata` key at all, but that key is not a usable stamp):
 * those are reported via the `warnings` out-param, mirroring
 * `filterCritiquesForSlug`'s own warnings pattern, rather than silently
 * dropped like an ordinary non-critique claim (a valid `check`/`acceptance`
 * claim, or a claim with no `metadata` key at all — "pure absence", never
 * suspicious, never warned).
 *
 * A claim is SUSPICIOUS (warned, then skipped) when it has a `metadata` key
 * present and either:
 *   - `metadata` itself is not an object, or
 *   - `metadata.origin` is present but not a non-empty string.
 * A claim with no `metadata` key, or a `metadata` object with no `origin`
 * key at all, is pure absence — nothing to warn about, silently skipped
 * (same "genuinely absent, not comparable" posture `filterCritiquesForSlug`
 * uses for an absent `workflow_subject_ref`).
 *
 * Field mapping for a recognized critique claim (`metadata.origin ===
 * "critique"`) mirrors the upstream `critiquesFromBundle`: `value` ->
 * `verdict` (defaulting to `"not_verified"` when nullish, same
 * nullish-coalescing rule upstream uses), `metadata.superseded_by`/
 * `metadata.workflow_subject_ref` passed through unchanged for
 * `hasUnresolvedLiveCritique`/`filterCritiquesForSlug` to interpret.
 */
export function critiquesFromTrustBundle(bundle: unknown): {
  critiques: BundleCritique[];
  warnings: string[];
} {
  const warnings: string[] = [];
  if (!bundle || typeof bundle !== 'object') return { critiques: [], warnings };
  const claims = (bundle as { claims?: unknown }).claims;
  if (!Array.isArray(claims)) return { critiques: [], warnings };

  const critiques: BundleCritique[] = [];
  claims.forEach((claim, index) => {
    if (!claim || typeof claim !== 'object') return;
    const { id, value, metadata } = claim as RawTrustBundleClaim;
    if (!('metadata' in claim)) return; // pure absence — not suspicious, silently skipped

    const label =
      typeof id === 'string' && id.length > 0 ? id : `claims[${index}]`;

    if (!metadata || typeof metadata !== 'object') {
      warnings.push(
        `trust.bundle claim '${label}' has a present-but-non-object metadata -- skipping this claim's contribution to review_pending`,
      );
      return;
    }
    if (!('origin' in metadata)) return; // pure absence of the origin key — not suspicious

    const origin = metadata.origin;
    if (typeof origin !== 'string' || origin.length === 0) {
      warnings.push(
        `trust.bundle claim '${label}' has a present-but-malformed metadata.origin -- skipping this claim's contribution to review_pending`,
      );
      return;
    }
    if (origin !== 'critique') return;

    critiques.push({
      verdict: value ?? 'not_verified',
      superseded_by: metadata.superseded_by,
      workflow_subject_ref: metadata.workflow_subject_ref,
    });
  });
  return { critiques, warnings };
}

/**
 * Pure review_pending signal — byte-for-byte BEHAVIORAL mirror of
 * flow-agents' `hasUnresolvedLiveCritique` (`src/lib/workflow-process-
 * projection.ts`, pinned 5.3.0): true when at least one LIVE (non-superseded)
 * critique claim is not a passing verdict.
 */
export function hasUnresolvedLiveCritique(
  critiques: BundleCritique[],
): boolean {
  return critiques.some((critique) => {
    const supersededBy = critique.superseded_by;
    const isSuperseded =
      typeof supersededBy === 'string' && supersededBy.length > 0;
    if (isSuperseded) return false;
    return critique.verdict !== 'pass';
  });
}

const SESSION_SUBJECT_REF_PREFIX = 'flow-agents://session/';

/**
 * Join-key identity check for bundle-derived critiques — byte-for-byte
 * BEHAVIORAL mirror of flow-agents' `filterCritiquesForSlug`
 * (`src/lib/workflow-process-projection.ts`, pinned 5.3.0). A critique whose
 * `workflow_subject_ref` names a different session, or a foreign work-item
 * ref not among this session's own `state.json.work_item_refs`, is a
 * confident mismatch and is excluded (with a warning), never trusted into
 * forcing `review_pending`. A genuinely absent `workflow_subject_ref` is
 * unattributable and passed through unchanged.
 */
export function filterCritiquesForSlug<T extends BundleCritique>(
  critiques: T[],
  slug: string,
  workItemRefs: string[] = [],
): { critiques: T[]; warnings: string[] } {
  const warnings: string[] = [];
  const workItemRefSet = new Set(workItemRefs);
  const kept = critiques.filter((critique) => {
    const ref = critique.workflow_subject_ref;
    if (ref === undefined || typeof ref !== 'string') return true;
    if (ref.length === 0) {
      warnings.push(
        `${slug}: trust.bundle critique has a present-but-empty workflow_subject_ref -- skipping this critique's contribution to review_pending`,
      );
      return false;
    }
    if (ref.startsWith(SESSION_SUBJECT_REF_PREFIX)) {
      const refSlug = ref.slice(SESSION_SUBJECT_REF_PREFIX.length);
      if (refSlug === slug) return true;
      warnings.push(
        `${slug}: trust.bundle critique workflow_subject_ref names a different session ('${refSlug}') -- skipping this critique's contribution to review_pending`,
      );
      return false;
    }
    if (workItemRefSet.has(ref)) return true;
    warnings.push(
      `${slug}: trust.bundle critique workflow_subject_ref ('${ref}') is not among this session's own state.json.work_item_refs -- skipping this critique's contribution to review_pending`,
    );
    return false;
  });
  return { critiques: kept, warnings };
}

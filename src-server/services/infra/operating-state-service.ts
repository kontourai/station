/**
 * In-process `OperatingState` derivation for a Station project (roadmap
 * #586, part of epic #580, S6 — "reuse console-bridge mapping"; extended
 * for roadmap #753 to wire the `hasUnresolvedCritique` signal the S6 review
 * flagged as always-undefined).
 *
 * Pipeline, entirely in-process, no hub, no HTTP:
 *
 *   1. `WorkflowSidecarService.listTasks(cwd)` — Station's own, already-
 *      safe (per-task try/catch, S2-established) reader of every
 *      `.kontourai/flow-agents/<task-slug>/state.json` sidecar in a
 *      project. A single malformed sidecar is skipped (logged), never
 *      aborts the whole scan — see that service's `tryReadState`.
 *   2. Each `WorkflowTaskSummary` is mapped into a
 *      `WorkflowProcessProjectionEntry` (console-server's own envelope
 *      shape) via the REAL `mapWorkflowStatusToConsoleProcessStatus`/
 *      `deriveConsoleProcessBlockedReason` published by flow-agents' own
 *      `@kontourai/flow-agents/console-contract` subpath (flow-agents#933,
 *      station bumped to the `5.3.0` release that ships it —
 *      `workflow-process-projection-mirror.ts` used to hand-mirror this
 *      table before that subpath existed; see that file's header,
 *      "RETIREMENT"). As part of that mapping, this service also reads the
 *      task's `trust.bundle` (roadmap #753, same sidecar directory as
 *      `state.json`) via `WorkflowSidecarService.readTrustBundle` — read
 *      defensively per task (a missing or malformed bundle degrades to "no
 *      critique signal", warned and skipped, never a crash, matching every
 *      other per-task read in this pipeline) — and passes the resulting
 *      `hasUnresolvedCritique` boolean into the mapper so a session with an
 *      unresolved live critique renders as `review_pending` with a
 *      `blockedReason`, instead of silently rendering under its base status
 *      (the S6 review's MEDIUM finding, station#753).
 *   3. The assembled `WorkflowProcessProjectionEnvelope` is folded through
 *      `@kontourai/console-server`'s REAL, published
 *      `translateWorkflowProcessProjectionEnvelope` (the actual
 *      "console-bridge mapping" being reused — this step is NOT mirrored;
 *      it is the genuine dependency function) into `ConsoleEventRecord[]`.
 *   4. Those events are folded into an `OperatingState` via
 *      `buildCurrentOperatingState` (also real, published — see
 *      `console-server-operating-state.ts` for why it needs a small local
 *      ambient-type shim).
 *
 * Deliberately NOT calling flow-agents' `flow-agents-console-process-projection`
 * CLI bin: that CLI's own `readWorkflowProcessSources` throws on the FIRST
 * malformed `state.json` it finds, aborting the ENTIRE batch (verified
 * against the pinned 5.2.0 tarball's `build/src/lib/workflow-process-
 * projection.js` — no per-source try/catch around its shape validation) —
 * that would take the whole board down for one corrupt sidecar, failing
 * this slice's own "malformed-workflow skip" acceptance bar. Station's own
 * `WorkflowSidecarService.listTasks` already has the required per-task
 * degrade, so this service builds the envelope from ITS output instead of
 * shelling to the CLI (also satisfying the design doc's "no bins at render
 * time" framing for this specific step — id generation and the status/
 * blockedReason mapping are the two pieces of CLI-owned logic this module
 * reproduces or replaces, both deliberately, both documented).
 */

import type { OperatingState } from '@kontourai/console-core';
import type {
  ConsoleEventRecord,
  WorkflowProcessProjectionEntry,
  WorkflowProcessProjectionEnvelope,
} from '@kontourai/console-server';
import { translateWorkflowProcessProjectionEnvelope } from '@kontourai/console-server';
import {
  deriveConsoleProcessBlockedReason,
  mapWorkflowStatusToConsoleProcessStatus,
} from '@kontourai/flow-agents/console-contract';
import type { WorkflowTaskSummary } from '@kontourai/station-contracts/workflow';
import { loadBuildCurrentOperatingState } from '../../capabilities/console-server-operating-state.js';
import {
  critiquesFromTrustBundle,
  filterCritiquesForSlug,
  handoffBlockers,
  hasUnresolvedLiveCritique,
} from '../../capabilities/workflow-process-projection-mirror.js';
import type { WorkflowSidecarService } from '../evidence/workflow-sidecar-service.js';

export const STATION_OPERATING_STATE_PRODUCER_ID = 'station-workflow';
export const STATION_OPERATING_STATE_PRODUCT = 'station';
export const STATION_OPERATING_STATE_SCOPE_KIND = 'repo';

interface OperatingStateLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface OperatingStateServiceOptions {
  logger?: OperatingStateLogger;
  /** Injectable clock for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
}

export interface OperatingStateServiceDeps {
  workflowSidecarService: Pick<
    WorkflowSidecarService,
    'listTasks' | 'readHandoff' | 'readTrustBundle'
  >;
}

/**
 * `ConsoleProcess.id` console-server's bridge derives for one task-slug
 * entry in this scope — `[producer.product, scope.kind, scope.id,
 * entry.id].join(':')` (console-server's `qualifiedSubjectId`, mirrored
 * here as a TRIVIAL 4-field join, not "mapping logic": this service
 * controls every one of those four fields itself, including using the bare
 * task slug as `entry.id`, so re-deriving the join is safe and exact, not a
 * drift risk). Used to recover the task slug a board card selection names.
 */
export function qualifiedWorkflowProcessId(
  scopeId: string,
  taskSlug: string,
): string {
  return [
    STATION_OPERATING_STATE_PRODUCT,
    STATION_OPERATING_STATE_SCOPE_KIND,
    scopeId,
    taskSlug,
  ].join(':');
}

/**
 * Reverses `qualifiedWorkflowProcessId` for a given scope. Returns
 * `undefined` when `processId` does not carry this scope's exact prefix
 * (e.g. a stale id from a different project, or a non-workflow process) —
 * fails closed rather than guessing at a truncated slug.
 */
export function taskSlugFromQualifiedProcessId(
  processId: string,
  scopeId: string,
): string | undefined {
  const prefix = `${STATION_OPERATING_STATE_PRODUCT}:${STATION_OPERATING_STATE_SCOPE_KIND}:${scopeId}:`;
  if (!processId.startsWith(prefix)) return undefined;
  const slug = processId.slice(prefix.length);
  return slug.length > 0 ? slug : undefined;
}

export class OperatingStateService {
  private readonly deps: OperatingStateServiceDeps;
  private readonly logger?: OperatingStateLogger;
  private readonly now: () => number;

  constructor(
    deps: OperatingStateServiceDeps,
    options: OperatingStateServiceOptions = {},
  ) {
    this.deps = deps;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  /** The one Builder-run predicate consumed by every Board entry point. */
  hasBuilderRun(cwd: string): boolean {
    return this.deps.workflowSidecarService.listTasks(cwd).length > 0;
  }

  /**
   * Derive the current `OperatingState` for one project workspace. Never
   * throws for a per-task malformed sidecar (skipped upstream by
   * `listTasks`) or a per-entry shape defect (skipped by console-server's
   * own `translateWorkflowProcessProjectionEnvelope`, warnings logged) —
   * only a genuinely broken `cwd` (not a directory, unreadable) propagates.
   */
  deriveOperatingState(cwd: string, scopeId: string): OperatingState {
    const tasks = this.deps.workflowSidecarService.listTasks(cwd);
    const generatedAt = new Date(this.now()).toISOString();

    const entries = tasks.map((task) => this.projectionEntryForTask(cwd, task));

    const envelope: WorkflowProcessProjectionEnvelope = {
      schema: 'kontour.console.projection',
      version: '0.1',
      generatedAt,
      scope: { kind: STATION_OPERATING_STATE_SCOPE_KIND, id: scopeId },
      producer: {
        id: STATION_OPERATING_STATE_PRODUCER_ID,
        product: STATION_OPERATING_STATE_PRODUCT,
      },
      derivedFrom: {
        mode: 'direct_snapshot',
        eventHistory: 'unavailable',
        directSnapshot: {
          id: `${STATION_OPERATING_STATE_PRODUCER_ID}:${STATION_OPERATING_STATE_SCOPE_KIND}:${scopeId}`,
          emittedAt: generatedAt,
          producer: {
            id: STATION_OPERATING_STATE_PRODUCER_ID,
            product: STATION_OPERATING_STATE_PRODUCT,
          },
          reason:
            'workflow-process projection is derived in-process from local workflow state/handoff sidecars (.kontourai/flow-agents); Console event history is unavailable',
          sourceRef: {
            product: 'flow-agents',
            kind: 'workflow-process',
            id: '.kontourai/flow-agents/*/state.json',
            label: 'Local workflow state sidecars',
          },
        },
      },
      processes: entries,
    };

    const { events, warnings } = translateWorkflowProcessProjectionEnvelope(
      envelope,
      { scopeLabel: `${STATION_OPERATING_STATE_SCOPE_KIND} ${scopeId}` },
    );
    for (const warning of warnings) {
      this.logger?.warn('Skipping invalid workflow process projection entry', {
        scopeId,
        warning,
      });
    }

    const buildCurrentOperatingState = loadBuildCurrentOperatingState();
    return buildCurrentOperatingState(events as ConsoleEventRecord[], {
      now: this.now(),
    });
  }

  private projectionEntryForTask(
    cwd: string,
    task: WorkflowTaskSummary,
  ): WorkflowProcessProjectionEntry {
    const hasUnresolvedCritique = this.unresolvedCritiqueSignal(cwd, task);
    const status = mapWorkflowStatusToConsoleProcessStatus(
      task.status,
      task.nextAction?.status,
      hasUnresolvedCritique,
    );
    const handoff = task.hasHandoff
      ? this.tryReadHandoff(cwd, task.taskSlug)
      : null;
    const blockedReason = deriveConsoleProcessBlockedReason(status, {
      nextActionStatus: task.nextAction?.status,
      nextActionSummary: task.nextAction?.summary,
      workflowStatus: task.status,
      handoffBlockers: handoffBlockers(handoff),
    });

    return {
      id: task.taskSlug,
      family: 'workflow',
      nonAuthority: true,
      subjectRef: {
        product: STATION_OPERATING_STATE_PRODUCT,
        kind: 'task',
        id: task.taskSlug,
        label: task.taskSlug,
      },
      sourceRef: {
        product: 'flow-agents',
        kind: 'workflow-state',
        id: task.taskSlug,
        label: `${task.path}/state.json`,
      },
      summary: task.nextAction?.summary ?? task.taskSlug,
      status,
      ...(blockedReason ? { blockedReason } : {}),
      extensions: {
        'flow-agents': {
          task_slug: task.taskSlug,
          workflow_status: task.status,
          phase: task.phase,
          next_action_status: task.nextAction?.status ?? 'continue',
          ...(task.updatedAt ? { updated_at: task.updatedAt } : {}),
          source_path: task.path,
          ...(hasUnresolvedCritique !== undefined
            ? { has_unresolved_critique: hasUnresolvedCritique }
            : {}),
        },
      },
    };
  }

  private tryReadHandoff(cwd: string, taskSlug: string) {
    try {
      return this.deps.workflowSidecarService.readHandoff(cwd, taskSlug);
    } catch (error) {
      this.logger?.warn('Skipping unreadable workflow handoff sidecar', {
        taskSlug,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * `hasUnresolvedCritique` for one task (roadmap #753): reads `trust.bundle`
   * (defensively — see `tryReadTrustBundle`), extracts its critique claims,
   * excludes any claim whose join key does not attribute it to THIS task
   * (`filterCritiquesForSlug`'s slug/work-item-ref check), and reduces the
   * survivors via `hasUnresolvedLiveCritique`. Returns `undefined` — the
   * mapper's own "no bundle-derived signal available" meaning, never a
   * fabricated `false` — when no bundle could be read at all (absent or
   * unreadable); returns a concrete boolean once a bundle was actually read,
   * even when it contains zero critiques.
   */
  private unresolvedCritiqueSignal(
    cwd: string,
    task: WorkflowTaskSummary,
  ): boolean | undefined {
    const bundle = this.tryReadTrustBundle(cwd, task.taskSlug);
    if (bundle === null) return undefined;

    const extraction = critiquesFromTrustBundle(bundle);
    for (const warning of extraction.warnings) {
      this.logger?.warn(
        'Skipping a suspicious trust.bundle claim shape while deriving the review_pending signal',
        { taskSlug: task.taskSlug, warning },
      );
    }

    const filtered = filterCritiquesForSlug(
      extraction.critiques,
      task.taskSlug,
      task.workItemRefs ?? [],
    );
    for (const warning of filtered.warnings) {
      this.logger?.warn(
        'Excluding trust.bundle critique from review_pending signal',
        { taskSlug: task.taskSlug, warning },
      );
    }
    return hasUnresolvedLiveCritique(filtered.critiques);
  }

  private tryReadTrustBundle(cwd: string, taskSlug: string): unknown | null {
    try {
      return this.deps.workflowSidecarService.readTrustBundle(cwd, taskSlug);
    } catch (error) {
      this.logger?.warn('Skipping unreadable workflow trust.bundle', {
        taskSlug,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

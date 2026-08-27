import { resolve } from 'node:path';
import {
  type GateEvaluationReadProjection,
  type GateEvaluationRef,
  parseGateEvaluationReadResult,
} from '@kontourai/flow/gate-evaluation-contract';
import {
  MAX_TASK_REFERENCES_PER_TASK,
  parseTaskGateEvaluationReference,
  parseTaskToolResultReference,
  type TaskWorkspaceBinding,
} from '@kontourai/station-contracts';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { BasisContributionRef } from '@kontourai/surface/basis';
import type { SafeToolResultProjection } from '@kontourai/thread';
import { expandTilde } from '../../utils/paths.js';
import type {
  SessionQueryModule,
  SessionToolResultQueryOutcome,
} from '../orchestration/session-query-module.js';

type ReferenceLink = { id: unknown; targetId: unknown };
type TaskScope = { projectId: string };
type ResultRef = Extract<
  BasisContributionRef,
  { authority: '@kontourai/thread'; kind: 'result' }
>;

export interface TaskToolResultReferenceRead {
  read(input: { taskId: string; authority: SessionReadAuthority }): Promise<
    | {
        status: 'found';
        references: readonly {
          referenceId: string;
          ref: ResultRef;
          result: SafeToolResultProjection;
        }[];
        gaps?: readonly { state: 'restricted' | 'corrupt' | 'unavailable' }[];
      }
    | { status: 'not-found' }
    | { status: 'unavailable' }
  >;
}

type GateLink = { id: unknown; targetId: unknown };
type FlowTask = { id: string; projectId: string; workspaceBinding?: unknown };

/**
 * The Task -> Flow owner adapter for retained immutable gate receipts.  It
 * deliberately receives an owner reader, never a Flow path or ledger.
 */
export interface TaskGateEvaluationReferenceRead {
  read(input: { taskId: string; request: Request }): Promise<
    | {
        status: 'found';
        references: readonly {
          referenceId: string;
          evaluation: GateEvaluationReadProjection;
        }[];
        gaps?: readonly { state: 'restricted' | 'unavailable' }[];
      }
    | { status: 'not-found' }
    | { status: 'unavailable' }
  >;
}

export function createTaskGateEvaluationReferenceReadAdapter(input: {
  taskGraph: {
    readTask(taskId: string): FlowTask | null;
    readTaskGateEvaluationReferenceLinks(
      taskId: string,
    ): readonly GateLink[] | null;
  };
  resolveProjectWorkspace(projectId: string): string | undefined;
  isRequestPrincipalCurrent(request: Request): boolean;
  readFlowGateEvaluation(options: {
    taskId: string;
    projectId: string;
    ref: GateEvaluationRef;
    request: Request;
    authorize(): boolean;
  }): Promise<unknown>;
}): TaskGateEvaluationReferenceRead {
  return {
    async read({ taskId, request }) {
      if (!isId(taskId) || !input.isRequestPrincipalCurrent(request))
        return { status: 'not-found' };
      let task: FlowTask | null;
      let links: readonly GateLink[] | null;
      let workspace: string | undefined;
      try {
        task = input.taskGraph.readTask(taskId);
        links = input.taskGraph.readTaskGateEvaluationReferenceLinks(taskId);
        workspace = task
          ? input.resolveProjectWorkspace(task.projectId)
          : undefined;
      } catch {
        return { status: 'unavailable' };
      }
      if (
        !task ||
        !links ||
        links.length > MAX_TASK_REFERENCES_PER_TASK ||
        !task.workspaceBinding ||
        !workspace ||
        !bindingMatchesProjectWorkspace(task.workspaceBinding, workspace)
      )
        return { status: 'not-found' };
      const snapshotTask = structuredClone(task);
      const snapshotLinks = [...links];
      const snapshotWorkspace = workspace;
      const readOnce = new Map<string, Promise<unknown>>();
      const references: {
        referenceId: string;
        evaluation: GateEvaluationReadProjection;
      }[] = [];
      const gaps = new Set<'restricted' | 'unavailable'>();
      for (const link of snapshotLinks) {
        if (!isId(link.id) || typeof link.targetId !== 'string') {
          gaps.add('restricted');
          continue;
        }
        const ref = parseTaskGateEvaluationReference(link.targetId);
        if (!ref) {
          gaps.add('restricted');
          continue;
        }
        const key = JSON.stringify([ref.runId, ref.gateId, ref.evaluationId]);
        let pending = readOnce.get(key);
        if (!pending) {
          pending = Promise.resolve(
            input.readFlowGateEvaluation({
              taskId,
              projectId: snapshotTask.projectId,
              ref,
              request,
              authorize: () => current(),
            }),
          );
          readOnce.set(key, pending);
        }
        let outcome: unknown;
        try {
          outcome = await pending;
        } catch {
          gaps.add('unavailable');
          continue;
        }
        const parsed = parseGateEvaluationReadResult(outcome);
        if (
          parsed?.status === 'unavailable' ||
          parsed?.status === 'unsupported'
        ) {
          gaps.add('unavailable');
          continue;
        }
        if (
          parsed?.status !== 'found' ||
          !sameRef(parsed.evaluation.ref, ref)
        ) {
          gaps.add('restricted');
          continue;
        }
        references.push({
          referenceId: link.id,
          evaluation: parsed.evaluation,
        });
      }
      if (!current()) return { status: 'unavailable' };
      return {
        status: 'found',
        references,
        ...(gaps.size
          ? { gaps: [...gaps].sort().map((state) => ({ state })) }
          : {}),
      };

      function current() {
        try {
          const later = input.taskGraph.readTask(taskId);
          const laterLinks =
            input.taskGraph.readTaskGateEvaluationReferenceLinks(taskId);
          return (
            input.isRequestPrincipalCurrent(request) &&
            !!later &&
            later.projectId === snapshotTask.projectId &&
            sameWorkspaceBinding(
              later.workspaceBinding,
              snapshotTask.workspaceBinding,
            ) &&
            input.resolveProjectWorkspace(later.projectId) ===
              snapshotWorkspace &&
            bindingMatchesProjectWorkspace(
              later.workspaceBinding,
              snapshotWorkspace,
            ) &&
            sameLinks(snapshotLinks, laterLinks)
          );
        } catch {
          return false;
        }
      }
    },
  };
}

/**
 * A retained Flow receipt has two independently-owned workspace witnesses:
 * the Task's captured binding and the Project's current workspace. Both must
 * name the same working directory before an owner read can observe a receipt.
 */
function bindingMatchesProjectWorkspace(
  binding: unknown,
  workspace: string,
): binding is TaskWorkspaceBinding {
  if (
    !binding ||
    typeof binding !== 'object' ||
    (binding as TaskWorkspaceBinding).availability !== 'available'
  )
    return false;
  const captured = (binding as TaskWorkspaceBinding).workingDirectory;
  if (captured === undefined) return false;
  // The two witnesses arrive in DIFFERENT forms, which is why this cannot be
  // a raw string compare (station#4292): the Task's captured binding holds
  // whatever was stored — `~/dev/repo` verbatim — while `workspace` comes
  // from `resolveProjectWorkspacePath`, which returns
  // `resolve(expandTilde(...))`. For any project stored with a tilde the two
  // named the same directory and compared UNEQUAL, so the owner read was
  // refused. Expand the stored side to compare like with like.
  return resolve(expandTilde(captured)) === workspace;
}

function sameWorkspaceBinding(
  left: unknown,
  right: unknown,
): left is TaskWorkspaceBinding {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object')
    return false;
  const a = left as TaskWorkspaceBinding;
  const b = right as TaskWorkspaceBinding;
  return (
    a.availability === b.availability &&
    // Raw on BOTH sides on purpose (station#4292): same-provenance witness
    // comparison, not a path read. See the note in
    // `bindingMatchesProjectWorkspace` above for the case that genuinely
    // does need expansion — there the two sides arrive in different forms.
    a.workingDirectory === b.workingDirectory &&
    a.repoRoot === b.repoRoot &&
    a.worktreePath === b.worktreePath &&
    a.branch === b.branch &&
    a.sourceSurface === b.sourceSurface &&
    a.capturedAt === b.capturedAt
  );
}

function sameRef(left: GateEvaluationRef, right: GateEvaluationRef) {
  return (
    left.runId === right.runId &&
    left.gateId === right.gateId &&
    left.evaluationId === right.evaluationId
  );
}

/**
 * The only Task -> Session owner adapter for kept tool results. TaskGraph
 * retains opaque links; this adapter resolves those links through the
 * orchestration-owned exact point read and never sees a transcript or store.
 */
export function createTaskToolResultReferenceReadAdapter(input: {
  taskGraph: {
    readTaskTurnReferenceScope(taskId: string): TaskScope | null;
    readTaskToolResultReferenceLinks(
      taskId: string,
    ): readonly ReferenceLink[] | null;
  };
  sessionQueries: Pick<SessionQueryModule, 'readToolResult'>;
  canReadSession: (
    sessionId: string,
    authority: SessionReadAuthority,
  ) => boolean;
}): TaskToolResultReferenceRead {
  return {
    async read({ taskId, authority }) {
      if (!isId(taskId)) return { status: 'not-found' };
      let snapshot: { scope: TaskScope; links: readonly ReferenceLink[] };
      try {
        const scope = input.taskGraph.readTaskTurnReferenceScope(taskId);
        const links = input.taskGraph.readTaskToolResultReferenceLinks(taskId);
        if (!scope || !links || links.length > MAX_TASK_REFERENCES_PER_TASK)
          return { status: 'not-found' };
        snapshot = { scope: { projectId: scope.projectId }, links: [...links] };
      } catch {
        return { status: 'unavailable' };
      }

      const reads = new Map<string, Promise<SessionToolResultQueryOutcome>>();
      const gaps = new Set<'restricted' | 'corrupt' | 'unavailable'>();
      const references: {
        referenceId: string;
        ref: ResultRef;
        result: SafeToolResultProjection;
      }[] = [];
      for (const link of snapshot.links) {
        if (!isId(link.id) || typeof link.targetId !== 'string') {
          gaps.add('corrupt');
          continue;
        }
        const tuple = parseTaskToolResultReference(link.targetId);
        if (!tuple) {
          gaps.add('corrupt');
          continue;
        }
        const key = JSON.stringify([tuple.sessionId, tuple.eventId]);
        let pending = reads.get(key);
        if (!pending) {
          pending = Promise.resolve(
            input.sessionQueries.readToolResult?.(
              {
                type: 'tool-result',
                threadId: tuple.sessionId,
                eventId: tuple.eventId,
              },
              authority,
            ) ?? { status: 'unavailable' },
          );
          reads.set(key, pending);
        }
        let outcome: SessionToolResultQueryOutcome;
        try {
          outcome = await pending;
        } catch {
          gaps.add('unavailable');
          continue;
        }
        if (outcome.status === 'unavailable') {
          gaps.add('unavailable');
          continue;
        }
        if (
          outcome.status !== 'found' ||
          outcome.sessionId !== tuple.sessionId ||
          outcome.eventId !== tuple.eventId ||
          outcome.result.resultId !== tuple.eventId ||
          (outcome.projectSlug !== undefined &&
            outcome.projectSlug !== snapshot.scope.projectId)
        ) {
          // A missing, denied, cross-project, or substituted owner result is
          // intentionally one opaque gap; no protected tuple is returned.
          gaps.add('restricted');
          continue;
        }
        references.push({
          referenceId: link.id,
          ref: {
            authority: '@kontourai/thread',
            schemaVersion: '1.2.0',
            kind: 'result',
            threadId: tuple.sessionId,
            resultId: tuple.eventId,
          },
          result: outcome.result,
        });
      }

      try {
        const currentScope = input.taskGraph.readTaskTurnReferenceScope(taskId);
        const currentLinks =
          input.taskGraph.readTaskToolResultReferenceLinks(taskId);
        // A pre-existing denied or malformed link is already an opaque gap and
        // must not veto unrelated available rows. Conversely, every identity
        // about to be published is re-authorized after owner I/O.
        const sessionsCurrent = references.every((reference) =>
          input.canReadSession(reference.ref.threadId, authority),
        );
        if (
          !sameScope(snapshot.scope, currentScope) ||
          !sameLinks(snapshot.links, currentLinks) ||
          !sessionsCurrent
        )
          return { status: 'unavailable' };
      } catch {
        return { status: 'unavailable' };
      }
      return {
        status: 'found',
        references,
        ...(gaps.size
          ? { gaps: [...gaps].sort().map((state) => ({ state })) }
          : {}),
      };
    },
  };
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096;
}

function sameScope(left: TaskScope, right: TaskScope | null): boolean {
  return right?.projectId === left.projectId;
}

function sameLinks(
  left: readonly ReferenceLink[],
  right: readonly ReferenceLink[] | null,
): boolean {
  return (
    right !== null &&
    left.length === right.length &&
    left.every(
      (link, index) =>
        link.id === right[index]?.id &&
        link.targetId === right[index]?.targetId,
    )
  );
}

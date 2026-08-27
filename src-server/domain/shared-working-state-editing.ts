import { createHash } from 'node:crypto';
import { canonicalizeForDigest } from '@kontourai/station-contracts/fleet-routing-receipt';
import {
  MAX_COLLABORATIVE_EDIT_BATCH_BYTES,
  MAX_COLLABORATIVE_EDIT_BATCH_OPERATIONS,
  MAX_COLLABORATIVE_EDIT_OPERATION_BYTES,
} from '../../src-shared/collaborative-edit-limits.js';
import {
  compareWorkingStateIds,
  SHARED_WORKING_STATE_SCHEMA_VERSION,
  SharedWorkingState,
  type TextDocumentOperation,
  type WorkingStateActor,
  type WorkingStateAttribution,
  type WorkingStateScope,
  type WorkingStateSnapshot,
  type WorkingStateWriteAuthorization,
} from './shared-working-state.js';

export const MAX_SHARED_EDIT_TEXT_CODE_UNITS = 256 * 1024;
export const MAX_SHARED_EDIT_TEXT_BYTES = 256 * 1024;
export const SHARED_WORKING_STATE_EDIT_BATCH_DIGEST_VERSION = 1 as const;

/**
 * One transport batch identity.  This intentionally follows #2889 effect
 * identity: display and correlation attribution are observational, while
 * operation order and the exact scope are effectful.
 */
export function sharedWorkingStateEditBatchDigest(input: {
  readonly intentId: string;
  readonly scope: WorkingStateScope;
  readonly operations: readonly TextDocumentOperation[];
}): string {
  const operations = input.operations.map((operation) =>
    operation.kind === 'insert'
      ? {
          schemaVersion: operation.schemaVersion,
          operationId: operation.operationId,
          documentId: operation.documentId,
          replicaId: operation.replicaId,
          actorId: operation.actor.actorId,
          parents: [...operation.parents].sort(),
          authorizationEpoch: operation.authorizationEpoch,
          kind: operation.kind,
          after: operation.after,
          text: operation.text,
        }
      : {
          schemaVersion: operation.schemaVersion,
          operationId: operation.operationId,
          documentId: operation.documentId,
          replicaId: operation.replicaId,
          actorId: operation.actor.actorId,
          parents: [...operation.parents].sort(),
          authorizationEpoch: operation.authorizationEpoch,
          kind: operation.kind,
          target: [...operation.target].sort(),
        },
  );
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonicalizeForDigest({
          version: SHARED_WORKING_STATE_EDIT_BATCH_DIGEST_VERSION,
          intentId: input.intentId,
          scope: input.scope,
          operations,
        }),
      ) ?? 'null',
    )
    .digest('hex');
}

export interface SharedWorkingStateEditBatch {
  readonly intentId: string;
  readonly digest: string;
  readonly baseRevision: string;
  readonly operations: readonly TextDocumentOperation[];
  readonly optimistic: {
    readonly text: string;
    readonly workingStateRevision: string;
  };
  readonly selection: { readonly anchor: number; readonly focus: number };
}

export type SharedWorkingStateEditPlan =
  | { readonly outcome: 'planned'; readonly batch: SharedWorkingStateEditBatch }
  | { readonly outcome: 'unchanged' }
  | { readonly outcome: 'refused'; readonly reason: string };

export type SharedWorkingStatePendingProjection =
  | {
      readonly outcome: 'projected';
      readonly text: string;
      readonly workingStateRevision: string;
    }
  | { readonly outcome: 'unavailable'; readonly reason: string };

export interface SharedWorkingStateEditingCapability {
  plan(input: {
    readonly currentText: string;
    readonly desiredText: string;
    readonly selection: { readonly anchor: number; readonly focus: number };
    readonly pending: readonly {
      readonly intentId: string;
      readonly operations: readonly TextDocumentOperation[];
    }[];
  }): SharedWorkingStateEditPlan;
  projectPending(input: {
    readonly pending: readonly {
      readonly intentId: string;
      readonly operations: readonly TextDocumentOperation[];
    }[];
  }): SharedWorkingStatePendingProjection;
  transformSelection(input: {
    readonly workingStateRevision: string;
    readonly selection: { readonly anchor: number; readonly focus: number };
    readonly pending: readonly {
      readonly intentId: string;
      readonly operations: readonly TextDocumentOperation[];
    }[];
  }):
    | {
        readonly outcome: 'projected';
        readonly text: string;
        readonly workingStateRevision: string;
        readonly selection: { readonly anchor: number; readonly focus: number };
      }
    | { readonly outcome: 'unavailable'; readonly reason: string };
}

interface VisibleAtom {
  readonly id: string;
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

function utf8Within(value: string): boolean {
  return (
    value.length <= MAX_SHARED_EDIT_TEXT_CODE_UNITS &&
    new TextEncoder().encode(value).byteLength <= MAX_SHARED_EDIT_TEXT_BYTES
  );
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function cloneActor(value: WorkingStateActor): WorkingStateActor | null {
  if (
    !value ||
    Object.keys(value).some(
      (key) => !['actorId', 'kind', 'displayLabel'].includes(key),
    ) ||
    typeof value.actorId !== 'string' ||
    value.actorId.length === 0 ||
    !wellFormed(value.actorId) ||
    (value.kind !== 'human' && value.kind !== 'agent') ||
    (value.displayLabel !== undefined &&
      (typeof value.displayLabel !== 'string' ||
        !wellFormed(value.displayLabel)))
  )
    return null;
  return {
    actorId: value.actorId,
    kind: value.kind,
    ...(value.displayLabel !== undefined
      ? { displayLabel: value.displayLabel }
      : {}),
  };
}

function cloneAttribution(
  value: WorkingStateAttribution | undefined,
): WorkingStateAttribution | null | undefined {
  if (value === undefined) return undefined;
  const allowed = new Set([
    'projectId',
    'taskId',
    'agentSessionId',
    'runId',
    'proposedChangeId',
    'correlationId',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  const result: Record<string, string> = {};
  for (const key of [
    'projectId',
    'taskId',
    'agentSessionId',
    'runId',
    'proposedChangeId',
    'correlationId',
  ] as const) {
    const entry = value[key];
    if (entry !== undefined) {
      if (typeof entry !== 'string' || !wellFormed(entry)) return null;
      result[key] = entry;
    }
  }
  return result;
}

function codePointBoundary(value: string, index: number): boolean {
  if (!Number.isSafeInteger(index) || index < 0 || index > value.length)
    return false;
  if (index === 0 || index === value.length) return true;
  const before = value.charCodeAt(index - 1);
  const after = value.charCodeAt(index);
  return !(
    before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
  );
}

function commonPrefix(left: string, right: string): number {
  const maximum = Math.min(left.length, right.length);
  let index = 0;
  while (index < maximum && left.charCodeAt(index) === right.charCodeAt(index))
    index += 1;
  while (index > 0 && !codePointBoundary(left, index)) index -= 1;
  return index;
}

function commonSuffix(left: string, right: string, prefix: number): number {
  const maximum = Math.min(left.length, right.length) - prefix;
  let count = 0;
  while (
    count < maximum &&
    left.charCodeAt(left.length - count - 1) ===
      right.charCodeAt(right.length - count - 1)
  )
    count += 1;
  while (
    count > 0 &&
    (!codePointBoundary(left, left.length - count) ||
      !codePointBoundary(right, right.length - count))
  )
    count -= 1;
  return count;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>))
      deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function visibleAtoms(snapshot: WorkingStateSnapshot): readonly VisibleAtom[] {
  const children = new Map<
    string | null,
    WorkingStateSnapshot['atoms'][number][]
  >();
  for (const atom of snapshot.atoms) {
    const siblings = children.get(atom.after) ?? [];
    siblings.push(atom);
    children.set(atom.after, siblings);
  }
  for (const siblings of children.values())
    siblings.sort((left, right) => compareWorkingStateIds(left.id, right.id));
  const result: VisibleAtom[] = [];
  const stack = [...(children.get(null) ?? [])].reverse();
  let offset = 0;
  while (stack.length > 0) {
    const atom = stack.pop()!;
    if (!atom.deleted) {
      result.push({
        id: atom.id,
        value: atom.value,
        start: offset,
        end: offset + atom.value.length,
      });
      offset += atom.value.length;
    }
    const descendants = children.get(atom.id) ?? [];
    for (let index = descendants.length - 1; index >= 0; index -= 1)
      stack.push(descendants[index]);
  }
  return result;
}

function applyPending(
  snapshot: WorkingStateSnapshot,
  authorization: WorkingStateWriteAuthorization,
  pending: readonly {
    readonly operations: readonly TextDocumentOperation[];
  }[],
): SharedWorkingState | null {
  try {
    const state = new SharedWorkingState({
      scope: snapshot.scope,
      snapshot,
      maxDeferredOperations: 64,
      maxDeferredBytes: MAX_SHARED_EDIT_TEXT_BYTES,
    });
    for (const intent of pending)
      for (const operation of intent.operations) {
        const result = state.apply(operation, authorization);
        if (result.outcome !== 'applied' && result.outcome !== 'duplicate')
          return null;
      }
    return state;
  } catch {
    return null;
  }
}

export function createSharedWorkingStateEditingCapability(options: {
  readonly scope: WorkingStateScope;
  readonly snapshot: () => WorkingStateSnapshot;
  readonly authorization: () => WorkingStateWriteAuthorization;
  readonly actor: () => WorkingStateActor;
  readonly replicaId: string;
  readonly attribution?: () => WorkingStateAttribution | undefined;
  readonly nextIntentId: () => string;
}): SharedWorkingStateEditingCapability {
  return Object.freeze({
    plan(
      input: Parameters<SharedWorkingStateEditingCapability['plan']>[0],
    ): SharedWorkingStateEditPlan {
      try {
        if (
          typeof input.currentText !== 'string' ||
          typeof input.desiredText !== 'string' ||
          !utf8Within(input.currentText) ||
          !utf8Within(input.desiredText) ||
          !wellFormed(input.currentText) ||
          !wellFormed(input.desiredText) ||
          !codePointBoundary(input.desiredText, input.selection.anchor) ||
          !codePointBoundary(input.desiredText, input.selection.focus)
        )
          return {
            outcome: 'refused',
            reason: 'text or selection is malformed',
          };
        const snapshot = options.snapshot();
        const authorization = options.authorization();
        const actor = cloneActor(options.actor());
        const attribution = cloneAttribution(options.attribution?.());
        if (!actor || attribution === null)
          return {
            outcome: 'refused',
            reason: 'actor attribution is malformed',
          };
        const common = (operationId: string, parents: readonly string[]) => ({
          schemaVersion: SHARED_WORKING_STATE_SCHEMA_VERSION,
          operationId,
          documentId: options.scope.documentId,
          replicaId: options.replicaId,
          actor,
          parents,
          authorizationEpoch: authorization.epoch,
          ...(attribution ? { attribution } : {}),
        });
        const state = applyPending(snapshot, authorization, input.pending);
        if (!state || state.text() !== input.currentText)
          return {
            outcome: 'refused',
            reason: 'editor base no longer matches',
          };
        if (input.currentText === input.desiredText)
          return { outcome: 'unchanged' };
        const start = commonPrefix(input.currentText, input.desiredText);
        const suffix = commonSuffix(
          input.currentText,
          input.desiredText,
          start,
        );
        let end = input.currentText.length - suffix;
        let insertText = input.desiredText.slice(
          start,
          input.desiredText.length - suffix,
        );
        if (
          !codePointBoundary(input.currentText, start) ||
          !codePointBoundary(input.currentText, end)
        )
          return { outcome: 'refused', reason: 'edit splits a Unicode scalar' };
        const atoms = visibleAtoms(state.snapshot());
        const predecessor =
          [...atoms].reverse().find((atom) => atom.end <= start)?.id ?? null;
        const intentId = options.nextIntentId();
        const existingBranch = atoms.find((atom) => atom.start >= start);
        // RGA siblings are ordered by immutable operation identity. If the new
        // insertion sorts after the existing causal branch, a preserved suffix
        // would render before it. Reinsert that suffix only for this ordering;
        // the ordinary before-branch case retains exact cursor transformation.
        if (
          insertText.length > 0 &&
          suffix > 0 &&
          existingBranch &&
          compareWorkingStateIds(`${intentId}:insert:0`, existingBranch.id) > 0
        ) {
          end = input.currentText.length;
          insertText = input.desiredText.slice(start);
        }
        const selected = atoms.filter(
          (atom) => atom.start >= start && atom.end <= end,
        );
        if (
          selected.some(
            (atom) =>
              atom.id.length > 256 ||
              new TextEncoder().encode(atom.id).byteLength > 256,
          )
        )
          return {
            outcome: 'refused',
            reason: 'atom identity exceeds byte bound',
          };
        const operations: TextDocumentOperation[] = [];
        let deleteId: string | null = null;
        if (selected.length > 0) {
          let targets: string[] = [];
          let targetBytes = 0;
          for (const atom of selected) {
            const candidateId = `${intentId}:delete:${operations.length}`;
            const emptyOperation = {
              ...common(candidateId, deleteId ? [deleteId] : []),
              kind: 'delete' as const,
              target: [],
            };
            // JSON's array form is exact here: each serialized target adds its
            // own measured JSON bytes plus one comma after the first member.
            const candidateBytes =
              new TextEncoder().encode(JSON.stringify(emptyOperation))
                .byteLength +
              targetBytes +
              (targets.length === 0 ? 0 : 1) +
              new TextEncoder().encode(JSON.stringify(atom.id)).byteLength;
            if (candidateBytes <= MAX_COLLABORATIVE_EDIT_OPERATION_BYTES) {
              targets.push(atom.id);
              targetBytes +=
                (targets.length === 1 ? 0 : 1) +
                new TextEncoder().encode(JSON.stringify(atom.id)).byteLength;
              continue;
            }
            if (targets.length === 0)
              return {
                outcome: 'refused',
                reason: 'one delete target exceeds operation byte capacity',
              };
            const operationId = `${intentId}:delete:${operations.length}`;
            operations.push({
              ...common(operationId, deleteId ? [deleteId] : []),
              kind: 'delete',
              target: targets,
            });
            deleteId = operationId;
            targets = [atom.id];
            targetBytes = new TextEncoder().encode(
              JSON.stringify(atom.id),
            ).byteLength;
          }
          if (targets.length > 0) {
            const operationId = `${intentId}:delete:${operations.length}`;
            operations.push({
              ...common(operationId, deleteId ? [deleteId] : []),
              kind: 'delete',
              target: targets,
            });
            deleteId = operationId;
          }
        }
        if (insertText.length > 0) {
          operations.push({
            ...common(`${intentId}:insert`, deleteId ? [deleteId] : []),
            kind: 'insert',
            after: predecessor,
            text: insertText,
          });
        }
        if (operations.length === 0)
          return { outcome: 'refused', reason: 'edit selected no exact atoms' };
        let batchBytes = 0;
        if (operations.length > MAX_COLLABORATIVE_EDIT_BATCH_OPERATIONS)
          return {
            outcome: 'refused',
            reason: 'batch operation capacity exceeded',
          };
        for (const operation of operations) {
          const serialized = JSON.stringify(operation);
          if (serialized.length > MAX_COLLABORATIVE_EDIT_OPERATION_BYTES)
            return {
              outcome: 'refused',
              reason: 'operation byte capacity exceeded',
            };
          const operationBytes = new TextEncoder().encode(
            serialized,
          ).byteLength;
          if (operationBytes > MAX_COLLABORATIVE_EDIT_OPERATION_BYTES)
            return {
              outcome: 'refused',
              reason: 'operation byte capacity exceeded',
            };
          batchBytes += operationBytes;
        }
        if (batchBytes > MAX_COLLABORATIVE_EDIT_BATCH_BYTES)
          return { outcome: 'refused', reason: 'batch byte capacity exceeded' };
        const preview = applyPending(state.snapshot(), authorization, [
          { operations },
        ]);
        if (!preview || preview.text() !== input.desiredText)
          return { outcome: 'refused', reason: 'operation preview diverged' };
        return {
          outcome: 'planned',
          batch: deepFreeze({
            intentId,
            digest: sharedWorkingStateEditBatchDigest({
              intentId,
              scope: options.scope,
              operations,
            }),
            baseRevision: state.revision,
            operations,
            optimistic: {
              text: preview.text(),
              workingStateRevision: preview.revision,
            },
            selection: {
              anchor: input.selection.anchor,
              focus: input.selection.focus,
            },
          }),
        };
      } catch {
        return { outcome: 'refused', reason: 'editing authority unavailable' };
      }
    },
    projectPending(
      input: Parameters<
        SharedWorkingStateEditingCapability['projectPending']
      >[0],
    ): SharedWorkingStatePendingProjection {
      try {
        const snapshot = options.snapshot();
        const state = applyPending(
          snapshot,
          options.authorization(),
          input.pending,
        );
        return state
          ? {
              outcome: 'projected',
              text: state.text(),
              workingStateRevision: state.revision,
            }
          : {
              outcome: 'unavailable',
              reason: 'pending operation replay failed',
            };
      } catch {
        return {
          outcome: 'unavailable',
          reason: 'editing authority unavailable',
        };
      }
    },
    transformSelection(
      input: Parameters<
        SharedWorkingStateEditingCapability['transformSelection']
      >[0],
    ): ReturnType<SharedWorkingStateEditingCapability['transformSelection']> {
      try {
        const snapshot = options.snapshot();
        if (snapshot.revision !== input.workingStateRevision)
          return {
            outcome: 'unavailable',
            reason: 'selection revision is stale',
          };
        const source = new SharedWorkingState({
          scope: snapshot.scope,
          snapshot,
        });
        const sourceText = source.text();
        if (
          !codePointBoundary(sourceText, input.selection.anchor) ||
          !codePointBoundary(sourceText, input.selection.focus)
        )
          return { outcome: 'unavailable', reason: 'selection splits Unicode' };
        const sourceAtoms = visibleAtoms(snapshot);
        const projected = applyPending(
          snapshot,
          options.authorization(),
          input.pending,
        );
        if (!projected)
          return { outcome: 'unavailable', reason: 'selection replay failed' };
        const targetAtoms = visibleAtoms(projected.snapshot());
        const targetById = new Map(targetAtoms.map((atom) => [atom.id, atom]));
        const mapBoundary = (offset: number) => {
          for (const atom of sourceAtoms)
            if (atom.start >= offset) {
              const surviving = targetById.get(atom.id);
              if (surviving) return surviving.start;
            }
          return projected.text().length;
        };
        return {
          outcome: 'projected',
          text: projected.text(),
          workingStateRevision: projected.revision,
          selection: {
            anchor: mapBoundary(input.selection.anchor),
            focus: mapBoundary(input.selection.focus),
          },
        };
      } catch {
        return { outcome: 'unavailable', reason: 'selection transform failed' };
      }
    },
  });
}

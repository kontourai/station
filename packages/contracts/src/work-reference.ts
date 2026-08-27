/**
 * A correlation-only identity. Owner status, title, transcript, verdict, and
 * other mutable facts stay in their authoritative APIs and are resolved when
 * observed.
 */
export type WorkReference =
  | { readonly kind: 'project'; readonly id: string }
  | {
      readonly kind: 'task';
      readonly id: string;
      /** Canonical Task owner key (a Station Project slug), never a project UUID. */
      readonly projectId: string;
    }
  | { readonly kind: 'session'; readonly id: string }
  | { readonly kind: 'approval'; readonly id: string }
  | {
      readonly kind: 'receipt';
      readonly owner: 'scheduler-run';
      readonly id: string;
    }
  | {
      readonly kind: 'receipt';
      readonly owner: 'independent-review';
      readonly id: string;
      readonly projectSlug: string;
    }
  | {
      readonly kind: 'run';
      readonly owner: 'flow';
      readonly projectId: string;
      readonly id: string;
      readonly gateId?: string;
    }
  | {
      readonly kind: 'artifact';
      readonly owner: 'run-output';
      readonly runId: string;
      readonly id: string;
    }
  | { readonly kind: 'agent'; readonly id: string };

export const WORK_REFERENCE_KINDS = [
  'project',
  'task',
  'session',
  'approval',
  'receipt',
  'run',
  'artifact',
  'agent',
] as const;
export type WorkReferenceKind = WorkReference['kind'];

const nonEmpty = (value: unknown) =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096;

/**
 * The sole canonical key for equality of a work identity. The JSON tuple is
 * delimiter-safe and records every discriminant and scope field; an absent
 * Flow gate is represented explicitly rather than being collapsed into a run
 * or a string-concatenation collision.
 */
export function workReferenceIdentityKey(reference: WorkReference): string {
  switch (reference.kind) {
    case 'project':
    case 'session':
    case 'approval':
    case 'agent':
      return JSON.stringify([reference.kind, reference.id]);
    case 'task':
      return JSON.stringify(['task', reference.projectId, reference.id]);
    case 'receipt':
      return reference.owner === 'scheduler-run'
        ? JSON.stringify(['receipt', 'scheduler-run', reference.id])
        : JSON.stringify([
            'receipt',
            'independent-review',
            reference.projectSlug,
            reference.id,
          ]);
    case 'run':
      return JSON.stringify([
        'run',
        'flow',
        reference.projectId,
        reference.id,
        reference.gateId ?? null,
      ]);
    case 'artifact':
      return JSON.stringify([
        'artifact',
        'run-output',
        reference.runId,
        reference.id,
      ]);
  }
}

export function isWorkReference(value: unknown): value is WorkReference {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Record<string, unknown>;
  if (!nonEmpty(ref.id)) return false;
  if (
    ref.kind === 'project' ||
    ref.kind === 'session' ||
    ref.kind === 'approval' ||
    ref.kind === 'agent'
  )
    return Object.keys(ref).length === 2;
  if (ref.kind === 'receipt')
    return (
      (ref.owner === 'scheduler-run' && Object.keys(ref).length === 3) ||
      (ref.owner === 'independent-review' &&
        Object.keys(ref).length === 4 &&
        nonEmpty(ref.projectSlug))
    );
  if (ref.kind === 'run') {
    // biome-ignore lint/suspicious/noPrototypeBuiltins: Object.hasOwn is not in this project's ES2020 lib target
    const hasGateId = Object.prototype.hasOwnProperty.call(ref, 'gateId');
    return (
      ref.owner === 'flow' &&
      nonEmpty(ref.projectId) &&
      Object.keys(ref).length === (hasGateId ? 5 : 4) &&
      (!hasGateId || nonEmpty(ref.gateId))
    );
  }
  if (ref.kind === 'artifact')
    return (
      ref.owner === 'run-output' &&
      Object.keys(ref).length === 4 &&
      nonEmpty(ref.runId)
    );
  if (ref.kind !== 'task') return false;
  const required = ['kind', 'id', 'projectId'] as const;
  return Object.keys(ref).length === required.length && nonEmpty(ref.projectId);
}

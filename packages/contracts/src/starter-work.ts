import type { AdoptedSessionResult } from './orchestration.js';
import type { TaskCreateInput, TaskDispatchInput } from './task-graph.js';
import { isWorkReference, type WorkReference } from './work-reference.js';

export const STARTER_WORK_SCHEMA_VERSION = 1 as const;
export const SCHEDULED_CHECK_STARTER_DEFINITION_VERSION = 1 as const;
export type StarterWorkId =
  | 'start-task'
  | 'continue-session'
  | 'inspect-approval'
  | 'inspect-receipt'
  | 'run-scheduled-check';

/** Starter Work deliberately admits only the owners it can resolve today. */
export type StarterWorkReference = Extract<
  WorkReference,
  { kind: 'task' | 'session' | 'approval' | 'receipt' }
>;

export function isStarterWorkReference(
  value: unknown,
): value is StarterWorkReference {
  return (
    isWorkReference(value) &&
    (value.kind === 'task' ||
      value.kind === 'session' ||
      value.kind === 'approval' ||
      value.kind === 'receipt')
  );
}

export interface StarterWorkBinding {
  schemaVersion: typeof STARTER_WORK_SCHEMA_VERSION;
  starterId: StarterWorkId;
  targetRef: StarterWorkReference;
  operationId: string;
  boundAt: string;
}

export type StarterWorkStatus =
  | { state: 'unbound' }
  | { state: 'bound'; binding: StarterWorkBinding }
  | { state: 'unavailable'; reason: 'store-unavailable' | 'corrupt-store' };

export interface StarterWorkBindInput {
  starterId: StarterWorkId;
  targetRef: StarterWorkReference;
  operationId: string;
}

export type StarterWorkBindOutcome =
  | { outcome: 'bound'; binding: StarterWorkBinding; replayed: boolean }
  | { outcome: 'conflict'; binding: StarterWorkBinding };

/**
 * The intentionally small public projection of a registered starter.  The
 * registry, rather than a client supplied string, owns the launch and
 * completion adapters.  A projection is therefore useful to a UI without
 * turning the API into a generic tutorial-state machine.
 */
export interface StarterWorkCatalogEntry {
  readonly id: StarterWorkId;
  readonly title: string;
  readonly description: string;
  readonly targetKind: 'task' | 'session' | 'approval' | 'receipt';
  readonly prerequisite: 'first-run-completed';
  readonly status: StarterWorkStatus;
}

export type StarterInspectionId = Extract<
  StarterWorkId,
  'inspect-approval' | 'inspect-receipt'
>;

export type StarterInspectionReference =
  | Extract<StarterWorkReference, { kind: 'approval' }>
  | Extract<StarterWorkReference, { kind: 'receipt' }>;

export type StarterInspectionCandidate =
  | {
      readonly state: 'current';
      readonly starterId: StarterInspectionId;
      readonly reference: StarterInspectionReference;
    }
  | {
      readonly state: 'missing' | 'unavailable';
      readonly starterId: StarterInspectionId;
      readonly reason: string;
      readonly retrySafe: true;
    };

export interface StarterInspectionLaunchInput {
  readonly starterId: StarterInspectionId;
  readonly operationId: string;
  readonly targetRef: StarterInspectionReference;
}

export type StarterInspectionCompletion =
  | {
      readonly state:
        | 'open'
        | 'resolved'
        | 'expired'
        | 'receipt-present'
        | 'running'
        | 'completed'
        | 'failed'
        | 'indeterminate';
    }
  | { readonly state: 'missing' | 'stale' | 'unavailable' | 'NOT_VERIFIED' };

export type StarterInspectionLaunchResult =
  | {
      readonly state: 'opened';
      readonly starterId: StarterInspectionId;
      readonly targetRef: StarterInspectionReference;
      readonly correlation: StarterWorkCorrelationDisposition;
      readonly href: string;
      readonly completion: StarterInspectionCompletion;
      readonly evidence: {
        readonly state: 'NOT_VERIFIED';
        readonly reason: string;
      };
    }
  | {
      readonly state: 'missing' | 'stale' | 'unavailable' | 'not_verified';
      readonly starterId: StarterInspectionId;
      readonly reason: string;
      readonly retrySafe: true;
    };

export interface ScheduledCheckStarterLaunchInput {
  readonly starterId: 'run-scheduled-check';
  readonly operationId: string;
}

export type ScheduledCheckStarterLaunchResult =
  | {
      readonly state: 'started';
      readonly starterId: 'run-scheduled-check';
      readonly receipt: Extract<
        StarterWorkReference,
        { kind: 'receipt'; owner: 'scheduler-run' }
      >;
      readonly correlation: StarterWorkCorrelationDisposition;
      readonly replayed: boolean;
      readonly href: string;
      readonly completion: StarterInspectionCompletion;
      readonly evidence: {
        readonly state: 'NOT_VERIFIED';
        readonly reason: string;
      };
    }
  | {
      readonly state: 'deferred' | 'unavailable' | 'conflict';
      readonly starterId: 'run-scheduled-check';
      readonly reason: string;
      readonly retrySafe: boolean;
    };

export interface ContinueSessionStarterLaunchInput {
  readonly starterId: 'continue-session';
  readonly operationId: string;
  readonly sourceSessionId: string;
}

export type ContinueSessionStarterLaunchResult =
  | {
      readonly state: 'continued';
      readonly source: StarterSessionReference;
      readonly session: AdoptedSessionResult;
      readonly correlation: StarterWorkCorrelationDisposition;
      readonly receipt?: StarterReceiptReference;
      readonly evidence: {
        readonly state: 'NOT_VERIFIED';
        readonly reason: string;
      };
    }
  | {
      readonly state: 'failed' | 'unavailable' | 'indeterminate';
      readonly source: StarterSessionReference;
      readonly reason: string;
      readonly retrySafe: boolean;
      readonly receipt?: StarterReceiptReference;
    };

/** Server-owned first vertical intent. Browser clients do not compose task,
 * ledger, or dispatcher calls independently. */
export interface StartTaskStarterLaunchInput {
  readonly starterId: 'start-task';
  readonly operationId: string;
  readonly task: TaskCreateInput;
  readonly dispatch?: TaskDispatchInput;
}

export type StarterWorkCorrelationDisposition =
  | {
      readonly state: 'bound';
      readonly binding: StarterWorkBinding;
      readonly replayed: boolean;
    }
  | { readonly state: 'not_verified'; readonly reason: string };
/** Session ownership is observed from Task dispatch; it is not ledger input. */
export interface StarterSessionReference {
  readonly kind: 'session';
  readonly id: string;
}
export interface StarterReceiptReference {
  readonly kind: 'receipt';
  readonly id: string;
}

/** The launch result is total after Task creation: it never conceals a remote
 * start uncertainty behind a generic HTTP error. */
export type StartTaskStarterLaunchResult =
  | StartTaskStarterNotStartedResult
  | StartTaskStarterStartedResult;

/** Readiness is a total, recoverable outcome. No Task or dispatch is claimed. */
export interface StartTaskStarterNotStartedResult {
  readonly state: 'deferred' | 'unavailable';
  readonly reason: string;
  readonly retrySafe: true;
}

export interface StartTaskStarterStartedResult {
  readonly state: 'started';
  readonly task: Extract<StarterWorkReference, { kind: 'task' }>;
  readonly correlation: StarterWorkCorrelationDisposition;
  readonly dispatch:
    | {
        readonly state: 'dispatched';
        readonly session: StarterSessionReference;
      }
    | {
        readonly state: 'failed' | 'unavailable' | 'aborted';
        readonly reason: string;
        readonly retrySafe: boolean;
      }
    | {
        readonly state: 'indeterminate';
        readonly reason: string;
        readonly retrySafe: false;
      };
  /** A Task status never supplies this verdict. Owner receipt evidence must. */
  readonly evidence: {
    readonly state: 'NOT_VERIFIED';
    readonly reason: string;
  };
}

export interface StarterTaskOrSessionObservation {
  readonly starterId: 'start-task' | 'continue-session';
  readonly correlation:
    | StarterWorkCorrelationDisposition
    | { readonly state: 'unbound' };
  readonly task?: Extract<StarterWorkReference, { kind: 'task' }>;
  readonly session?: StarterSessionReference;
  readonly receipt?: StarterReceiptReference;
  readonly evidence: {
    readonly state: 'NOT_VERIFIED';
    readonly reason: string;
  };
}

export interface StarterInspectionObservation {
  readonly starterId: StarterInspectionId;
  readonly correlation:
    | StarterWorkCorrelationDisposition
    | { readonly state: 'unbound' };
  readonly targetRef?: StarterInspectionReference;
  readonly href?: string;
  readonly completion: StarterInspectionCompletion;
  readonly evidence: {
    readonly state: 'NOT_VERIFIED';
    readonly reason: string;
  };
}

export interface StarterScheduledCheckObservation {
  readonly starterId: 'run-scheduled-check';
  readonly correlation:
    | StarterWorkCorrelationDisposition
    | { readonly state: 'unbound' };
  readonly receipt?: Extract<
    StarterWorkReference,
    { kind: 'receipt'; owner: 'scheduler-run' }
  >;
  readonly href?: string;
  readonly completion: StarterInspectionCompletion;
  readonly evidence: {
    readonly state: 'NOT_VERIFIED';
    readonly reason: string;
  };
}

export type StarterWorkObservation =
  | StarterTaskOrSessionObservation
  | StarterInspectionObservation
  | StarterScheduledCheckObservation;

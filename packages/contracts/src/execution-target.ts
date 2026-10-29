import type { AgentId, EngineConnectionId } from './agent-identity.js';
import type { ExecutionConfinementRecord } from './execution-confinement.js';
import type {
  ExecutionPreparationReceipt,
  ExecutionPreparationRequirement,
} from './execution-preparation.js';
import type { EngineId, ModelLaunchPlan } from './provider.js';
import type { WorkspaceIsolationConfig } from './workspace-isolation.js';

declare const environmentIdBrand: unique symbol;

/** Stable identity minted by a Station server for one Environment. */
export type EnvironmentId = string & {
  readonly [environmentIdBrand]: 'EnvironmentId';
};

/**
 * Brands an Environment identity after the caller has obtained it from a
 * trusted Station boundary (for example, the well-known handshake).
 *
 * Environment identities are server-minted opaque values. Unlike Agent IDs,
 * they intentionally have no public text grammar beyond being non-empty.
 */
export function environmentId(value: string): EnvironmentId {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error('Environment identity must not be empty.');
  }
  return normalized as EnvironmentId;
}

/** The Environment on which the target Agent must be resolved. */
export type EnvironmentRef =
  | { kind: 'current' }
  | { kind: 'saved'; id: EnvironmentId };

/**
 * A workspace address interpreted by the target Environment.
 *
 * A project target uses the target Station's project catalog. A directory
 * target is an explicit path on that target. A portable target names the
 * CONSENT identity — the portable Project id plus the offered resource —
 * and the target Station resolves it against its own operator's execution
 * offer; it is never an address the caller can aim at an arbitrary local
 * path or slug. None of these forms is an access or transport configuration.
 */
export type WorkspaceTarget =
  | {
      kind: 'project';
      projectSlug: string;
      cwd?: string;
      /** Explicit thread selection; overrides the project's default. */
      workspaceIsolation?: WorkspaceIsolationConfig;
    }
  | { kind: 'directory'; cwd: string }
  | {
      /**
       * Explicit portable execution intent (#484 phase A): run on the
       * receiving Station only if its operator currently offers execution
       * for exactly this portable Project id and resource, and the resource
       * is currently bound. A NEW UNION MEMBER on purpose — a receiver from
       * before this intent fails validation on the whole workspace object
       * rather than silently stripping fields and executing a local
       * fallback.
       */
      kind: 'project-portable';
      portableProjectId: string;
      resourceId: string;
    }
  | {
      /**
       * #2875 slice 1: the `project-portable` intent plus a version the
       * receiver must find its admitted checkout at before execution
       * starts. Another NEW union member, for the same reason as
       * `project-portable`: an older receiver refuses the whole workspace
       * object instead of stripping the requirement and executing
       * unchecked. Senders gate it on the `executionPreparation` handshake
       * capability.
       */
      kind: 'project-portable-prepared';
      portableProjectId: string;
      resourceId: string;
      preparation: ExecutionPreparationRequirement;
    };

/** Caller-owned model request. Resolution remains adapter- and server-owned. */
export interface ExecutionModelRequest {
  override?: string;
  options?: Readonly<Record<string, unknown>>;
}

/** An override names a receiver-owned default engine Agent, preserving the profile. */
export type ExecutionAgentRef =
  | AgentId
  | {
      kind: 'agent-execution-override';
      agent: AgentId;
      executionAgent: AgentId;
      expectedDefinitionFingerprint?: string;
    };

export function executionProfileAgentId(ref: ExecutionAgentRef): AgentId {
  return typeof ref === 'string' ? ref : ref.agent;
}

export function executionBindingAgentId(ref: ExecutionAgentRef): AgentId {
  return typeof ref === 'string' ? ref : ref.executionAgent;
}

/**
 * Canonical cross-surface address for foreground chat and durable delegation.
 *
 * The public target deliberately contains no provider, engine, connection,
 * endpoint, transport, or credential selector. The selected Environment
 * resolves its own Agent binding and model launch plan. The one engine-shaped
 * field, `expectedEngine`, is a precondition the Environment checks against its
 * own resolution and can only refuse on; it chooses nothing.
 */
export interface ExecutionTarget {
  environment: EnvironmentRef;
  agent: ExecutionAgentRef;
  model?: ExecutionModelRequest;
  workspace?: WorkspaceTarget;
  /**
   * A PRECONDITION, never a selector: the engine this caller's own view of the
   * Agent showed it running on. The target Environment still resolves the
   * binding itself and alone decides where the work runs. When that
   * resolution names a different engine the request is refused with
   * `EXECUTION_ENGINE_CHANGED_CODE` before anything starts, so a caller
   * working from a stale snapshot is told, not run somewhere it did not see.
   *
   * Absent states no expectation. A receiver from before this field ignores
   * it, so a caller needing the guarantee must know its receiver's version.
   * The shape is the resolution receipt's own `engine` (`ResolvedExecutionEngine`),
   * which is why it names nothing a caller could use to aim a request.
   */
  expectedEngine?: ResolvedExecutionEngine;
}

/**
 * The request's `expectedEngine` did not match the engine the target
 * Environment resolved the Agent to. Nothing started; re-read the Agent and
 * choose again.
 */
export const EXECUTION_ENGINE_CHANGED_CODE = 'execution_engine_changed';

/**
 * Why Station refused to continue a conversation in its persisted workspace
 * (#3568): the project context, worktree binding or directory it was bound to
 * is missing, moved, corrupt or no longer matches. Nothing started. Station
 * reports one of these as a held follow-up's `reasonCode`.
 */
export const CONTINUATION_WORKSPACE_REFUSAL_CODES = [
  'continuation_workspace_project_context_missing',
  'continuation_workspace_corrupt_worktree_binding',
  'continuation_workspace_worktree_gone',
  'continuation_workspace_different_project',
  'continuation_workspace_worktree_moved',
  'continuation_workspace_direct_mismatch',
  'continuation_workspace_unbound',
] as const;
export type ContinuationWorkspaceRefusalCode =
  (typeof CONTINUATION_WORKSPACE_REFUSAL_CODES)[number];

export const EXECUTION_RESOLUTION_RECEIPT_SCHEMA_VERSION =
  'station.execution-resolution/v1' as const;

/** Workspace after the target Environment has validated and resolved it. */
export type ResolvedWorkspaceTarget =
  | {
      kind: 'project';
      projectSlug: string;
      cwd: string;
      workspaceIsolation: WorkspaceIsolationConfig;
    }
  | { kind: 'directory'; cwd: string };

/** Engine binding selected by the target Environment. */
export type ResolvedExecutionEngine =
  | { kind: 'station' }
  | { kind: 'connection'; connectionId: EngineConnectionId };

/**
 * Server-produced, content-free evidence of the binding used for execution.
 *
 * Engine/provider identity is safe and useful after resolution, but is never
 * caller authority. Access URLs, SSH details, credentials, and raw transport
 * state must never be added to this receipt.
 */
export interface ExecutionResolutionReceipt {
  schemaVersion: typeof EXECUTION_RESOLUTION_RECEIPT_SCHEMA_VERSION;
  resolvedAt: string;
  environmentId: EnvironmentId;
  agentId: AgentId;
  /** Receiver-owned execution default used instead of the profile binding. */
  executionAgentId?: AgentId;
  definitionFingerprint?: string;
  engine: ResolvedExecutionEngine;
  provider: EngineId;
  modelLaunchPlan: ModelLaunchPlan;
  workspace?: ResolvedWorkspaceTarget;
  /** Present only for a `project-portable-prepared` intent that matched. */
  preparation?: ExecutionPreparationReceipt;
  /**
   * #2494: the started session's confinement, read back from its latest
   * `session.started` record after the start. Never present at resolution
   * time: the posture comes from the started engine's report, which does
   * not exist yet when the binding is resolved. Absent on the foreground
   * chat handle (which does not attach it yet), on a delegation whose start
   * record was not stored or readable when the handle returned, and for a
   * start that recorded none.
   */
  confinement?: ExecutionConfinementRecord;
}

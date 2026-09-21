import type { AgentId, EngineConnectionId } from './agent-identity.js';
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
    };

/** Caller-owned model request. Resolution remains adapter- and server-owned. */
export interface ExecutionModelRequest {
  override?: string;
  options?: Readonly<Record<string, unknown>>;
}

/**
 * Canonical cross-surface address for foreground chat and durable delegation.
 *
 * The public target deliberately contains no provider, engine, connection,
 * endpoint, transport, or credential selector. The selected Environment
 * resolves its own Agent binding and model launch plan.
 */
export interface ExecutionTarget {
  environment: EnvironmentRef;
  agent: AgentId;
  model?: ExecutionModelRequest;
  workspace?: WorkspaceTarget;
}

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
  engine: ResolvedExecutionEngine;
  provider: EngineId;
  modelLaunchPlan: ModelLaunchPlan;
  workspace?: ResolvedWorkspaceTarget;
}

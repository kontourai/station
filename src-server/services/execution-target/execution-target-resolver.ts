import { resolve } from 'node:path';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import {
  type AgentId,
  agentId,
  type EngineConnectionId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type {
  ExecutionResolutionReceipt,
  ExecutionTarget,
  ResolvedExecutionEngine,
  ResolvedWorkspaceTarget,
  WorkspaceTarget,
} from '@kontourai/station-contracts/execution-target';
import {
  EXECUTION_RESOLUTION_RECEIPT_SCHEMA_VERSION,
  environmentId,
} from '@kontourai/station-contracts/execution-target';
import {
  type ModelLaunchCapabilities,
  type ModelLaunchPlan,
  type ProviderKind,
  resolveModelLaunchPlan,
  unsupportedModelOptionError,
  unsupportedModelOptionKeys,
} from '@kontourai/station-contracts/provider';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import type { WorkspaceIsolationMode } from '@kontourai/station-contracts/workspace-isolation';
import type { ProviderAdapterShape } from '../../providers/adapter-shape.js';
import { expandTilde } from '../../utils/paths.js';

/**
 * Private capability for reaching one Environment. It may contain transport
 * authority and therefore must never cross an API, SDK, CLI, MCP, or UI
 * boundary. Public callers provide only `ExecutionTarget.environment`.
 */
export interface EnvironmentAccess {
  apiBase: string;
  environmentId: string;
  environmentName: string;
  kind: 'current' | 'ssh' | 'peer';
  /** Operator-verified binding owned by a saved SSH Environment. */
  verifiedProjectPath?: string;
  /** Remote home captured by the SSH worker during Environment verification. */
  remoteHome?: string;
  requestOptions?: { headers: Record<string, string> };
}

export interface ExecutionTargetAgentView extends Partial<AgentSpec> {
  slug?: string;
  available?: boolean;
  unavailableReason?: string;
}

interface ResolvedProjectView {
  workingDirectory?: string;
  defaultWorkspaceIsolation?: WorkspaceIsolationMode;
}

export interface ExecutionTargetResolverDependencies {
  resolveEnvironmentAccess: (
    target: ExecutionTarget,
  ) => Promise<EnvironmentAccess>;
  getAgent: (
    access: EnvironmentAccess,
    id: AgentId,
  ) => Promise<ExecutionTargetAgentView>;
  getConnection: (
    access: EnvironmentAccess,
    id: EngineConnectionId,
  ) => Promise<ConnectionConfig>;
  getProject: (
    access: EnvironmentAccess,
    slug: string,
  ) => Promise<ResolvedProjectView | undefined>;
  /**
   * Registered adapter lookup on the selected Station. Model-launch support
   * belongs to the adapter declaration; it is not a provider-name policy.
   */
  getProviderAdapter: (
    provider: ProviderKind,
  ) => ProviderAdapterShape | undefined;
  now?: () => Date;
}

export interface ResolvedExecutionTarget {
  /** Private access authority. Never serialize this object. */
  access: EnvironmentAccess;
  agentId: AgentId;
  engine: ResolvedExecutionEngine;
  provider: ProviderKind;
  modelLaunchPlan: ModelLaunchPlan;
  /**
   * The model this turn actually launches with: the caller's per-turn override
   * when there is one, otherwise the Agent's own `execution.modelId`. station#3406:
   * only the override used to reach the adapter, so an Agent that named a model
   * ran on the engine's default and said nothing -- and the ACP adapter's
   * apply-and-verify block (acp-adapter.ts) was skipped entirely, because it is
   * reached only when a model is requested. Resolve it here, once, so every
   * execution path launches the model the Agent declares.
   */
  modelId?: string;
  modelOptions?: Readonly<Record<string, unknown>>;
  workspace?: ResolvedWorkspaceTarget;
  /** Private evidence for cross-Environment project-slug disclosure. */
  projectDirectoryExactMatch?: boolean;
  receipt: ExecutionResolutionReceipt;
}

function assertConnectionReady(connection: ConnectionConfig): void {
  if (connection.kind !== 'agent') {
    throw new Error(
      `Agent binding '${connection.id}' does not resolve to an engine connection`,
    );
  }
  if (!connection.enabled || connection.status === 'disabled') {
    throw new Error(`Engine connection '${connection.id}' is disabled`);
  }
  if (
    connection.status !== 'ready' ||
    !connection.capabilities.includes('agent-runtime')
  ) {
    throw new Error(
      `Engine connection '${connection.id}' is not ready for execution`,
    );
  }
}

function connectionProvider(connection: ConnectionConfig): ProviderKind {
  if (connection.type === 'acp' || connection.capabilities.includes('acp')) {
    return 'acp';
  }
  const provider = connection.config.provider;
  if (typeof provider !== 'string' || !provider.trim()) {
    throw new Error(
      `Engine connection '${connection.id}' has no provider configured`,
    );
  }
  return provider;
}

function assertModelOptionsSupported(
  provider: ProviderKind,
  options: Readonly<Record<string, unknown>> | undefined,
  agent: AgentId,
): void {
  if (provider === 'station-agent' && options && Object.keys(options).length) {
    throw new Error(
      `Station Agent '${agent}' does not support per-invocation engine settings`,
    );
  }
  const unsupported = unsupportedModelOptionKeys(provider, options);
  if (unsupported.length) {
    throw new Error(
      unsupportedModelOptionError(provider, unsupported[0], agent),
    );
  }
}

export const REMOTE_HOME_UNVERIFIED_REASON =
  'remote home unverified — re-verify the environment';

type RemoteProjectPathMatch =
  | { matches: true; configuredPath: string; verifiedPath: string }
  | { matches: false; reason: string };

function normalizeRemoteAbsolutePosixPath(path: string): string | undefined {
  if (!path.startsWith('/')) return undefined;
  const normalized = path.replace(/\/{2,}/g, '/');
  const segments = normalized.slice(1).split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return undefined;
  }
  return normalized === '/' ? normalized : normalized.replace(/\/$/, '');
}

/**
 * Compare paths as strings reported by the remote POSIX host. This is an
 * identity check, never containment: local realpath, filesystem probes, and
 * host case rules would all describe the wrong machine. Tilde paths expand
 * only from the remote home captured during verification; aliases (including
 * symlinks) remain mismatches because there is no safe remote realpath here.
 */
export function matchVerifiedRemoteProjectPath(
  configuredPath: string,
  verifiedPath: string,
  remoteHome?: string,
): RemoteProjectPathMatch {
  const normalizedVerified = normalizeRemoteAbsolutePosixPath(verifiedPath);
  if (!normalizedVerified) {
    return { matches: false, reason: 'verified project path is invalid' };
  }
  let expandedConfigured = configuredPath;
  if (configuredPath.startsWith('~/')) {
    const relative = configuredPath.slice(2);
    if (
      !relative ||
      relative
        .split('/')
        .some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      return { matches: false, reason: 'configured project path is invalid' };
    }
    if (!remoteHome) {
      return { matches: false, reason: REMOTE_HOME_UNVERIFIED_REASON };
    }
    const normalizedHome = normalizeRemoteAbsolutePosixPath(remoteHome);
    if (!normalizedHome) {
      return { matches: false, reason: 'remote home is invalid' };
    }
    expandedConfigured = `${normalizedHome}/${relative}`;
  }
  const normalizedConfigured =
    normalizeRemoteAbsolutePosixPath(expandedConfigured);
  if (!normalizedConfigured) {
    return { matches: false, reason: 'configured project path is invalid' };
  }
  return normalizedConfigured === normalizedVerified
    ? {
        matches: true,
        configuredPath: normalizedConfigured,
        verifiedPath: normalizedVerified,
      }
    : {
        matches: false,
        reason: 'configured project path differs from verified path',
      };
}

async function resolveWorkspace(
  deps: ExecutionTargetResolverDependencies,
  access: EnvironmentAccess,
  workspace: WorkspaceTarget | undefined,
): Promise<{
  workspace?: ResolvedWorkspaceTarget;
  projectDirectoryExactMatch?: boolean;
}> {
  if (!workspace) {
    return access.verifiedProjectPath
      ? { workspace: { kind: 'directory', cwd: access.verifiedProjectPath } }
      : {};
  }
  if (workspace.kind === 'directory') {
    const cwd = workspace.cwd.trim();
    if (!cwd)
      throw new Error('Execution workspace directory must not be empty');
    const verifiedPathMatch = access.verifiedProjectPath
      ? matchVerifiedRemoteProjectPath(
          cwd,
          access.verifiedProjectPath,
          access.remoteHome,
        )
      : undefined;
    if (verifiedPathMatch && !verifiedPathMatch.matches) {
      throw new Error(
        `Execution workspace directory does not match the verified Environment workspace: ${verifiedPathMatch.reason}`,
      );
    }
    return {
      workspace: {
        kind: 'directory',
        // Same expansion as the project branch below, for the same reason: a
        // caller may hand us `~/dev/x`, the session store persists the
        // expanded form, and the continuation guard compares the two as
        // strings. `verifiedProjectPath` stays outside it — remote path.
        cwd: access.verifiedProjectPath ?? resolve(expandTilde(cwd)),
      },
    };
  }

  const slug = workspace.projectSlug.trim();
  if (!slug) throw new Error('Execution workspace project must not be empty');
  const project = await deps.getProject(access, slug);
  if (!project?.workingDirectory) {
    throw new Error(`Project '${slug}' has no working directory configured`);
  }
  const verifiedPathMatch = access.verifiedProjectPath
    ? matchVerifiedRemoteProjectPath(
        project.workingDirectory,
        access.verifiedProjectPath,
        access.remoteHome,
      )
    : undefined;
  if (verifiedPathMatch && !verifiedPathMatch.matches) {
    throw new Error(
      `Project '${slug}' does not match the verified Environment workspace: ${verifiedPathMatch.reason}`,
    );
  }
  const requestedCwd = workspace.cwd?.trim();
  const verifiedCwdMatch =
    requestedCwd && access.verifiedProjectPath
      ? matchVerifiedRemoteProjectPath(
          requestedCwd,
          access.verifiedProjectPath,
          access.remoteHome,
        )
      : undefined;
  if (verifiedCwdMatch && !verifiedCwdMatch.matches) {
    throw new Error(
      `Execution workspace cwd does not match the verified Environment workspace: ${verifiedCwdMatch.reason}`,
    );
  }
  // EXPAND. `project.workingDirectory` is stored tilde-literal on purpose —
  // `~/.station/projects/<slug>/project.json` holds `~/dev/...` verbatim, and
  // every other consumer in the tree does `resolve(expandTilde(...))` before
  // using it. This resolver was the sole outlier, and the cost was not
  // cosmetic: the session cwd persisted at turn 1 IS expanded, so the turn-2
  // continuation guard compared '/Users/me/dev/x' against '~/dev/x' with raw
  // string inequality, never matched, and refused every follow-up turn with
  // "this conversation belongs to a different workspace directory". Every
  // conversation in a tilde-configured project was single-turn (station#3147).
  //
  // `verifiedProjectPath` stays OUTSIDE the expansion deliberately: it is a
  // REMOTE path, and this file's own comment above forbids applying local
  // home expansion or realpath to it — that would describe the wrong machine.
  const localCwd = requestedCwd ?? project.workingDirectory;
  const cwd = access.verifiedProjectPath ?? resolve(expandTilde(localCwd));
  return {
    workspace: {
      kind: 'project',
      projectSlug: slug,
      cwd,
      workspaceIsolation: workspace.workspaceIsolation ?? {
        // An unset project record preserves today's shared-checkout launch.
        mode: project.defaultWorkspaceIsolation ?? 'shared',
      },
    },
    ...(access.verifiedProjectPath
      ? {
          projectDirectoryExactMatch:
            verifiedPathMatch?.matches === true &&
            project.workingDirectory === access.verifiedProjectPath,
        }
      : {}),
  };
}

function launchCapabilities(
  provider: ProviderKind,
  getProviderAdapter: ExecutionTargetResolverDependencies['getProviderAdapter'],
): ModelLaunchCapabilities | undefined {
  return getProviderAdapter(provider)?.metadata.modelLaunch;
}

/**
 * Resolve the complete execution binding on the selected Environment.
 *
 * The caller controls only Environment + Agent + optional model/workspace.
 * Engine connection, provider, transport authority, and the resolution
 * receipt are server-derived. In particular there is no executable
 * connection selector anywhere in this interface.
 */
export async function resolveExecutionTarget(
  target: ExecutionTarget,
  deps: ExecutionTargetResolverDependencies,
): Promise<ResolvedExecutionTarget> {
  const resolvedAgentId = agentId(String(target.agent));
  const access = await deps.resolveEnvironmentAccess(target);
  const trustedEnvironmentId = environmentId(access.environmentId);
  const agent = await deps.getAgent(access, resolvedAgentId);
  if (agent.slug && agent.slug !== resolvedAgentId) {
    throw new Error(
      `Agent binding changed while resolving '${resolvedAgentId}'; select it again`,
    );
  }
  if (agent.available === false) {
    throw new Error(
      agent.unavailableReason || `Agent '${resolvedAgentId}' is unavailable`,
    );
  }

  const boundConnectionId = agent.execution?.agentConnectionId;
  let engine: ResolvedExecutionEngine;
  let provider: ProviderKind;
  if (boundConnectionId) {
    const resolvedEngineConnectionId = engineConnectionId(
      String(boundConnectionId),
    );
    engine = {
      kind: 'connection',
      connectionId: resolvedEngineConnectionId,
    };
    const connection = await deps.getConnection(
      access,
      resolvedEngineConnectionId,
    );
    assertConnectionReady(connection);
    provider = connectionProvider(connection);
  } else {
    engine = { kind: 'station' };
    provider = 'station-agent';
  }

  // An override the caller sent for this turn wins; otherwise the Agent's own
  // declared model is the request. Trimmed-empty on either side means "not
  // stated", never an empty model id handed to an adapter.
  const overrideModelId = target.model?.override?.trim();
  const agentModelId = agent.execution?.modelId?.trim();
  const effectiveModelId = overrideModelId || agentModelId || undefined;

  assertModelOptionsSupported(provider, target.model?.options, resolvedAgentId);
  // Session binding is deliberately read after target resolution. This early
  // gate therefore only answers whether this registered adapter can accept an
  // override at any lifecycle; the orchestration seam applies the precise
  // start/resume/turn declaration once it knows the actual lifecycle.
  const capabilities = launchCapabilities(provider, deps.getProviderAdapter);
  const acceptsOverrideSomewhere =
    capabilities?.overrideAtStart ||
    capabilities?.overrideAtResume ||
    capabilities?.overridePerTurn;
  const modelLaunchPlan = resolveModelLaunchPlan(
    acceptsOverrideSomewhere
      ? {
          ...capabilities,
          overrideAtStart: true,
          overrideAtResume: true,
          overridePerTurn: true,
        }
      : capabilities,
    {
      lifecycle: 'start',
      requestedModelId: effectiveModelId,
    },
  );
  if (modelLaunchPlan.kind === 'unavailable') {
    throw new Error(
      `Agent '${resolvedAgentId}' cannot use the requested model (${modelLaunchPlan.reason})`,
    );
  }

  const workspaceResolution = await resolveWorkspace(
    deps,
    access,
    target.workspace,
  );
  const { workspace } = workspaceResolution;
  const receipt: ExecutionResolutionReceipt = {
    schemaVersion: EXECUTION_RESOLUTION_RECEIPT_SCHEMA_VERSION,
    resolvedAt: (deps.now?.() ?? new Date()).toISOString(),
    environmentId: trustedEnvironmentId,
    agentId: resolvedAgentId,
    engine,
    provider,
    modelLaunchPlan,
    ...(workspace ? { workspace } : {}),
  };

  return {
    access,
    agentId: resolvedAgentId,
    engine,
    provider,
    modelLaunchPlan,
    ...(effectiveModelId ? { modelId: effectiveModelId } : {}),
    ...(target.model?.options ? { modelOptions: target.model.options } : {}),
    ...(workspace ? { workspace } : {}),
    ...(workspaceResolution.projectDirectoryExactMatch !== undefined
      ? {
          projectDirectoryExactMatch:
            workspaceResolution.projectDirectoryExactMatch,
        }
      : {}),
    receipt,
  };
}

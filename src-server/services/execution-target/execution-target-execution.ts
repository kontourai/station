import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentDelegationContext } from '@kontourai/station-contracts/agent';
import type { AgentId } from '@kontourai/station-contracts/agent-identity';
import type { ChatAttachmentInput } from '@kontourai/station-contracts/chat-attachment';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import type { ConversationContextBoundaryProjection } from '@kontourai/station-contracts/conversation-context-boundary';
import type {
  ExecutionResolutionReceipt,
  ExecutionTarget,
  ResolvedExecutionEngine,
  ResolvedWorkspaceTarget,
} from '@kontourai/station-contracts/execution-target';
import {
  FOREGROUND_MESSAGE_INDETERMINATE_CODE,
  type ForegroundMessageIndeterminate,
} from '@kontourai/station-contracts/orchestration';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type {
  ProviderKind,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import { SESSION_VISIBILITY_METADATA_KEY } from '@kontourai/station-contracts/provider';
import type {
  WorkspaceIsolationConfig,
  WorktreeSessionMetadata,
} from '@kontourai/station-contracts/workspace-isolation';
import { createLogger } from '../../utils/logger.js';
import { assertProjectWorktreeDirectory } from '../projects/project-service.js';
import {
  WorktreeProvisioningService,
  type WorktreeProvisionRequest,
} from '../projects/worktree-provisioning-service.js';
import {
  type EnvironmentAccess,
  type ExecutionTargetResolverDependencies,
  resolveExecutionTarget,
} from './execution-target-resolver.js';

const logger = createLogger({ name: 'execution-target-execution' });

async function provisionProjectWorktree(
  workspace: Extract<ResolvedWorkspaceTarget, { kind: 'project' }>,
  threadId: string,
  providerKind: ProviderKind,
  deps: ExecutionTargetExecutionDependencies,
): Promise<WorktreeSessionMetadata | null> {
  await assertProjectWorktreeDirectory(workspace.projectSlug, workspace.cwd);
  return await (deps.provisionWorktree ?? defaultWorktreeProvisioner)({
    repoPath: workspace.cwd,
    threadId,
    providerKind,
    isolation: workspace.workspaceIsolation,
  });
}

export interface ForegroundMessageInput {
  target: ExecutionTarget;
  message: string;
  conversationId?: string;
  attachments?: ChatAttachmentInput[];
  /** Server-only resolver that runs after Environment and child-session resolution. */
  resolveAttachments?: (binding: {
    threadId: string;
    clientTurnId: string;
  }) => ChatAttachmentInput[];
  ambientContext?: string;
  clientTurnId?: string;
  delegation?: AgentDelegationContext;
  userId?: string;
  /**
   * station#4075 stage 2: the caller's resolved `PrincipalRef`, additive
   * alongside `userId`. Resolved at the HTTP/auth seam like `clientOrigin`
   * below; threaded to `deps.sendTurn`'s context so the resulting
   * `turn.started` is attributed at emit time (never inferred after the
   * fact). `undefined` for any caller of this module that has not been
   * updated to resolve one — that caller's turns simply carry no
   * `principal`, an additive/optional field everywhere it lands.
   */
  principal?: PrincipalRef;
  /** Resolved at the HTTP/auth seam; not accepted by public JSON schemas. */
  clientOrigin?: ClientOrigin;
  /**
   * Server-owned visibility choice for machine-triggered turns. It is not in
   * the public orchestration schema: external callers cannot make an ordinary
   * chat disappear by supplying it in JSON.
   */
  ephemeral?: boolean;
  /**
   * station#2821 hardening M3: the inbound webhook token identity that
   * started this turn, stamped into session-start metadata beside
   * `sessionVisibility` so an operator can answer "which sessions did this
   * token start?" from disk. Server-owned like `ephemeral` above — never a
   * public-schema field.
   */
  webhookTokenId?: string;
  /**
   * Opaque, server-minted capability for the one explicit Agent/engine
   * handoff path.  Public chat JSON and ordinary callers cannot manufacture
   * it, so they remain bound to the conversation's Agent.
   */
  handoffCapability?: ConversationHandoffLaunchCapability;
  /** Server-only intent; it is converted to a capability only after preflight. */
  handoffIntent?: ConversationHandoffIntent;
}

const conversationHandoffLaunchCapabilityBrand = Symbol(
  'conversationHandoffLaunchCapability',
);

export type ConversationHandoffLaunchCapability = Readonly<{
  conversationId: string;
  predecessorSessionId: string;
  sessionId: string;
  targetAgentId: string;
  targetEnvironmentId: string;
  targetConnectionId?: string;
  transcriptSeed: string;
  [conversationHandoffLaunchCapabilityBrand]: true;
}>;

/**
 * The handoff authority calls this only after target readiness and durable
 * reservation succeed.  It is intentionally not a boolean escape hatch.
 */
export function createConversationHandoffLaunchCapability(
  input: Omit<
    ConversationHandoffLaunchCapability,
    typeof conversationHandoffLaunchCapabilityBrand
  >,
): ConversationHandoffLaunchCapability {
  return Object.freeze({
    ...input,
    [conversationHandoffLaunchCapabilityBrand]: true as const,
  });
}

const conversationHandoffIntentBrand = Symbol('conversationHandoffIntent');
export type ConversationHandoffIntent = Readonly<{
  idempotencyKey: string;
  [conversationHandoffIntentBrand]: true;
}>;
export function createConversationHandoffIntent(
  idempotencyKey: string,
): ConversationHandoffIntent {
  return Object.freeze({
    idempotencyKey,
    [conversationHandoffIntentBrand]: true as const,
  });
}

export interface ForegroundMessageHandle {
  conversationId: string;
  sessionId: string;
  /** Exact provider turn identity; session identity is not terminal evidence. */
  providerTurnId: string;
  target: { kind: 'agent'; id: AgentId };
  resolution: ExecutionResolutionReceipt;
  /** Present only for the explicit Agent/engine handoff route. */
  handoff?: {
    predecessorSessionId: string;
    sessionId: string;
    currentSessionId: string;
    outcome: 'created' | 'existing';
    target: {
      agentId: AgentId;
      engine: ResolvedExecutionEngine;
      modelId?: string;
    };
    carried: readonly string[];
    reset: readonly string[];
  };
}

/**
 * A foreground start reached session effects but cannot prove its accepted
 * command receipt. The route and SDK preserve this exact evidence so a caller
 * can observe the session instead of issuing a duplicate start.
 */
export class ForegroundMessageIndeterminateError extends Error {
  readonly code = FOREGROUND_MESSAGE_INDETERMINATE_CODE;
  readonly outcome = 'indeterminate' as const;

  constructor(
    readonly detail: ForegroundMessageIndeterminate,
    message: string,
  ) {
    super(message);
    this.name = 'ForegroundMessageIndeterminateError';
  }
}

/**
 * A provider call may have succeeded but omitted the terminal correlation
 * required by the foreground Interface. It deliberately carries the same
 * stable outcome code without inventing a receipt or session projection.
 */
export class ForegroundMessageTurnIdentityUnavailableError extends Error {
  readonly code = FOREGROUND_MESSAGE_INDETERMINATE_CODE;
  readonly outcome = 'indeterminate' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ForegroundMessageTurnIdentityUnavailableError';
  }
}

/**
 * A remote Station can serialize the same fact into a different Error class.
 * The stable code/outcome pair is sufficient to preserve its no-cleanup rule.
 */
function mayHaveStartedForegroundSession(error: unknown): boolean {
  return (
    error instanceof ForegroundMessageIndeterminateError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code ===
        FOREGROUND_MESSAGE_INDETERMINATE_CODE &&
      (error as { outcome?: unknown }).outcome === 'indeterminate')
  );
}

export interface ExecutionSessionBinding {
  environmentId: string;
  agentId: string;
  connectionId?: string;
  userId?: string;
  projectSlug?: string;
  cwd?: string;
  workspaceIsolation?: WorkspaceIsolationConfig;
  worktree?: WorktreeSessionMetadata;
}

export class ContinuationWorkspaceError extends Error {
  constructor(
    readonly code:
      | 'continuation_workspace_project_context_missing'
      | 'continuation_workspace_corrupt_worktree_binding'
      | 'continuation_workspace_worktree_gone'
      | 'continuation_workspace_different_project'
      | 'continuation_workspace_worktree_moved'
      | 'continuation_workspace_direct_mismatch'
      | 'continuation_workspace_unbound',
    message: string,
  ) {
    super(message);
    this.name = 'ContinuationWorkspaceError';
  }
}

export interface ExecutionTargetExecutionDependencies
  extends ExecutionTargetResolverDependencies {
  readSessionBinding: (
    access: EnvironmentAccess,
    sessionId: string,
  ) => Promise<ExecutionSessionBinding | null>;
  startSession: (
    access: EnvironmentAccess,
    input: ProviderSessionStartInput,
  ) => Promise<{ commandId: string; sessionId: string } | undefined>;
  sendTurn: (
    access: EnvironmentAccess,
    input: ProviderSendTurnInput,
    context?: { clientOrigin?: ClientOrigin; principal?: PrincipalRef },
  ) => Promise<{ turnId: string }>;
  /**
   * Server-owned durable conversation/session resolution. It is optional for
   * remote compatibility until every Station speaks lineage, but the current
   * runtime composes it for all local foreground entries.
   */
  resolveConversationSession?: (
    access: EnvironmentAccess,
    conversationId: string,
    requested: { provider: ProviderKind; connectionId?: string },
  ) => Promise<{
    sessionId: string;
    startRequired: boolean;
    /** Server-owned cursor copied only from the predecessor Session. */
    resumeCursor?: unknown;
    /** Bounded provider-neutral transcript fallback when no cursor exists. */
    transcriptSeed?: string;
    /** Explicit one-shot context policy, never inferred from a restart. */
    contextBoundary?: ConversationContextBoundaryProjection;
  }>;
  claimConversationContextBoundaryColdStart?: (
    access: EnvironmentAccess,
    boundaryId: string,
    startCommandId: string,
  ) => void;
  consumeConversationContextBoundary?: (
    access: EnvironmentAccess,
    boundaryId: string,
    startCommandId: string,
  ) => void;
  releaseConversationContextBoundaryFailedClaim?: (
    access: EnvironmentAccess,
    boundaryId: string,
    indeterminate?: boolean,
  ) => void;
  /** Explicit handoff authority; ordinary continuation never calls this. */
  prepareConversationHandoff?: (
    access: EnvironmentAccess,
    input: {
      conversationId: string;
      agentId: AgentId;
      connectionId?: string;
      modelId?: string;
      idempotencyKey: string;
      messageDigest: string;
    },
  ) => Promise<{
    marker: {
      predecessorSessionId: string;
      sessionId: string;
      targetAgentId: string;
      targetEnvironmentId: string;
      targetConnectionId?: string;
    };
    transcriptSeed?: string;
    outcome: 'created' | 'existing';
    carried: readonly string[];
    reset: readonly string[];
    contextBoundary?: ConversationContextBoundaryProjection;
  }>;
  /** Exact provider effect truth for replaying an explicit handoff safely. */
  readConversationHandoffEffect?: (
    access: EnvironmentAccess,
    input: { conversationId: string; idempotencyKey: string },
  ) => Promise<{ providerTurnId?: string } | null>;
  /** Server-local provisioning seam. Remote execution reaches this seam on the target Station. */
  provisionWorktree?: (
    request: WorktreeProvisionRequest,
  ) => ReturnType<WorktreeProvisioningService['provision']>;
  finalizeWorktree?: (
    request: Parameters<WorktreeProvisioningService['finalize']>[0],
  ) => ReturnType<WorktreeProvisioningService['finalize']>;
  /** Loud operational seam for a provisioned worktree whose compensation failed. */
  warn?: (message: string, fields: Record<string, unknown>) => void;
  createConversationId?: () => string;
}

/**
 * Shared foreground execution seam for API, SDK, CLI, MCP, and UI.
 *
 * It deliberately returns a dispatch handle rather than transport state or a
 * provider-specific response. Streaming/history continue through the normal
 * orchestration session APIs using `sessionId`.
 */
export async function executeForegroundMessage(
  input: ForegroundMessageInput,
  deps: ExecutionTargetExecutionDependencies,
): Promise<ForegroundMessageHandle> {
  const message = input.message.trim();
  // The route admits an attachment-only foreground turn. Keep the execution
  // seam aligned with that contract after staged references hydrate JIT; a
  // caption-less screenshot is still a meaningful user request.
  if (!message && !input.attachments?.length && !input.resolveAttachments) {
    throw new Error('Execution message must not be empty');
  }

  const resolved = await resolveExecutionTarget(input.target, deps);
  // Target resolution makes both explicit saved and project-default saved
  // Environments concrete. Refuse process-local staged bytes before their
  // resolver can hydrate or send anything to a non-current Station.
  if (input.resolveAttachments && resolved.access.kind !== 'current') {
    throw new Error(
      'Current-host staged attachments cannot be sent to another Station.',
    );
  }
  const conversationId =
    input.conversationId ??
    deps.createConversationId?.() ??
    `conversation:${randomUUID()}`;
  // A binding belongs to the durable Conversation, not its replaceable
  // execution Session. Read it before selecting/reserving a child so a
  // crashed continuation cannot inherit current-route identity.
  const binding = await deps.readSessionBinding(
    resolved.access,
    conversationId,
  );
  const requestedHandoff =
    input.handoffIntent?.[conversationHandoffIntentBrand] === true;
  const handoffPayloadDigest = requestedHandoff
    ? canonicalHandoffEffectDigest({
        message,
        attachments: input.attachments ?? [],
        ambientContext: input.ambientContext ?? '',
        provider: resolved.provider,
        engine: resolved.engine,
        modelId: resolved.modelId ?? null,
        modelLaunchPlan: resolved.modelLaunchPlan,
        modelOptions: resolved.modelOptions ?? {},
      })
    : undefined;
  if (requestedHandoff && !binding) {
    throw new Error(
      'An Agent/engine handoff requires an existing conversation binding.',
    );
  }
  // Ownership, Environment and workspace are immutable conversation facts.
  // Check them before any handoff reservation so an unauthorized request is
  // strictly read-only.
  if (
    binding &&
    (binding.environmentId !== resolved.access.environmentId ||
      (binding.userId !== undefined && binding.userId !== input.userId))
  ) {
    throw new Error(
      'The requested conversation belongs to a different Environment, Agent, or Station user',
    );
  }
  if (binding) {
    validateContinuationWorkspace(binding, resolved.workspace);
  }
  const preparedHandoff = requestedHandoff
    ? await deps.prepareConversationHandoff?.(resolved.access, {
        conversationId,
        agentId: resolved.agentId,
        ...(resolved.engine.kind === 'connection'
          ? { connectionId: resolved.engine.connectionId }
          : {}),
        ...(resolved.modelId ? { modelId: resolved.modelId } : {}),
        idempotencyKey: input.handoffIntent!.idempotencyKey,
        messageDigest: handoffPayloadDigest!,
      })
    : undefined;
  if (requestedHandoff && !preparedHandoff) {
    throw new Error('Agent/engine handoff is unavailable on this Station.');
  }
  const handoff = preparedHandoff
    ? createConversationHandoffLaunchCapability({
        conversationId,
        predecessorSessionId: preparedHandoff.marker.predecessorSessionId,
        sessionId: preparedHandoff.marker.sessionId,
        targetAgentId: preparedHandoff.marker.targetAgentId,
        targetEnvironmentId: preparedHandoff.marker.targetEnvironmentId,
        ...(preparedHandoff.marker.targetConnectionId
          ? { targetConnectionId: preparedHandoff.marker.targetConnectionId }
          : {}),
        transcriptSeed: preparedHandoff.transcriptSeed ?? '',
      })
    : input.handoffCapability;
  const validHandoff =
    handoff?.[conversationHandoffLaunchCapabilityBrand] === true &&
    handoff.conversationId === conversationId &&
    handoff.targetAgentId === resolved.agentId &&
    handoff.targetEnvironmentId === resolved.access.environmentId &&
    (handoff.targetConnectionId === undefined ||
      (resolved.engine.kind === 'connection' &&
        handoff.targetConnectionId === resolved.engine.connectionId));
  if (binding && binding.agentId !== resolved.agentId && !validHandoff) {
    throw new Error(
      'The requested conversation belongs to a different Environment, Agent, or Station user',
    );
  }
  // The durable handoff marker is reserved before its provider turn. Once
  // that turn has an exact identity, a same-key retry observes and returns
  // the existing effect. Re-starting the marker's Session would either send
  // twice or, after settlement, fail only because that Session is terminal.
  if (preparedHandoff?.outcome === 'existing') {
    const existingEffect = await deps.readConversationHandoffEffect?.(
      resolved.access,
      {
        conversationId,
        idempotencyKey: input.handoffIntent!.idempotencyKey,
      },
    );
    if (existingEffect?.providerTurnId) {
      return {
        conversationId,
        sessionId: preparedHandoff.marker.sessionId,
        providerTurnId: existingEffect.providerTurnId,
        target: { kind: 'agent', id: resolved.agentId },
        resolution: resolved.receipt,
        handoff: {
          predecessorSessionId: preparedHandoff.marker.predecessorSessionId,
          sessionId: preparedHandoff.marker.sessionId,
          currentSessionId: preparedHandoff.marker.sessionId,
          outcome: 'existing',
          target: {
            agentId: resolved.agentId,
            engine: resolved.engine,
            ...(resolved.modelId ? { modelId: resolved.modelId } : {}),
          },
          carried: preparedHandoff.carried,
          reset: preparedHandoff.reset,
        },
      };
    }
  }
  // Validate every durable binding before a continuation can reserve its next
  // child. A rejected Agent/Environment/user/workspace request is read-only.
  const continuation = validHandoff
    ? {
        sessionId: handoff.sessionId,
        // A retry after an accepted cold start must send the one durable
        // handoff turn, not start a second successor.  Its idempotency key
        // still deduplicates a crash after send acceptance.
        startRequired: !(
          preparedHandoff?.outcome === 'existing' &&
          preparedHandoff.contextBoundary?.status === 'consumed'
        ),
        transcriptSeed: handoff.transcriptSeed,
        ...(preparedHandoff?.contextBoundary
          ? { contextBoundary: preparedHandoff.contextBoundary }
          : {}),
      }
    : binding
      ? await deps.resolveConversationSession?.(
          resolved.access,
          conversationId,
          {
            provider: resolved.provider,
            ...(resolved.engine.kind === 'connection'
              ? { connectionId: resolved.engine.connectionId }
              : {}),
          },
        )
      : undefined;
  const sessionId = continuation?.sessionId ?? conversationId;
  const conversationProjectSlug =
    binding?.projectSlug ??
    (resolved.workspace?.kind === 'project'
      ? resolved.workspace.projectSlug
      : undefined);
  const conversationWorkspaceIsolation =
    binding?.workspaceIsolation ??
    (resolved.workspace?.kind === 'project'
      ? resolved.workspace.workspaceIsolation
      : undefined);
  if (!binding || continuation?.startRequired) {
    // A boundary is claimed at the real cold-start seam, never by a warm turn
    // or ordinary recovery.  Empty policy intentionally has no transcript seed.
    const contextBoundaryStartCommandId = continuation?.contextBoundary
      ? randomUUID()
      : undefined;
    if (continuation?.contextBoundary) {
      if (
        continuation.contextBoundary.status !== 'reserved' &&
        continuation.contextBoundary.status !== 'failed'
      )
        throw new Error('Conversation context boundary requires a cold start.');
      deps.claimConversationContextBoundaryColdStart?.(
        resolved.access,
        continuation.contextBoundary.boundaryId,
        contextBoundaryStartCommandId!,
      );
    }
    // A child Session inherits the already-owned worktree. Provisioning a
    // second worktree for the same Conversation would both change its
    // workspace identity and create competing cleanup owners.
    const worktree =
      !binding &&
      resolved.workspace?.kind === 'project' &&
      resolved.workspace.workspaceIsolation.mode === 'worktree'
        ? await provisionProjectWorktree(
            resolved.workspace,
            sessionId,
            resolved.provider,
            deps,
          )
        : null;
    if (
      !binding &&
      resolved.workspace?.kind === 'project' &&
      resolved.workspace.workspaceIsolation.mode === 'worktree' &&
      !worktree
    ) {
      throw new Error('Worktree provisioning did not return a workspace path');
    }
    try {
      const startReceipt = await deps.startSession(resolved.access, {
        threadId: sessionId,
        provider: resolved.provider,
        ...(worktree
          ? { cwd: worktree.path }
          : binding?.worktree?.path
            ? { cwd: binding.worktree.path }
            : binding?.cwd
              ? { cwd: binding.cwd }
              : resolved.workspace?.cwd
                ? { cwd: resolved.workspace.cwd }
                : {}),
        ...(conversationWorkspaceIsolation
          ? { workspaceIsolation: conversationWorkspaceIsolation }
          : {}),
        ...(resolved.modelId ? { modelId: resolved.modelId } : {}),
        ...(continuation?.resumeCursor !== undefined
          ? { resumeCursor: continuation.resumeCursor }
          : {}),
        ...(input.ephemeral ? { persistSession: false } : {}),
        ...(resolved.modelOptions
          ? { modelOptions: { ...resolved.modelOptions } }
          : {}),
        metadata: {
          agentId: resolved.agentId,
          agentSlug: resolved.agentId,
          // Continuations validate this canonical Environment + Agent binding
          // before they can reuse a persisted conversation. Keep it alongside
          // the legacy agent fields so a foreground-created session is as
          // resumable as every delegated session.
          targetKind: 'agent',
          targetId: resolved.agentId,
          ...(resolved.engine.kind === 'connection'
            ? { connectionId: resolved.engine.connectionId }
            : {}),
          environmentId: resolved.access.environmentId,
          conversationId,
          ...(continuation?.contextBoundary
            ? {
                contextBoundary: {
                  boundaryId: continuation.contextBoundary.boundaryId,
                  startCommandId: contextBoundaryStartCommandId,
                  policy: continuation.contextBoundary.policy,
                  priorTranscriptInjected:
                    continuation.contextBoundary.priorTranscriptInjected,
                },
              }
            : {}),
          ...(conversationProjectSlug
            ? {
                projectSlug: conversationProjectSlug,
                ...(conversationWorkspaceIsolation
                  ? { workspaceIsolation: conversationWorkspaceIsolation }
                  : {}),
              }
            : {}),
          ...(worktree
            ? { worktree }
            : binding?.worktree
              ? { worktree: binding.worktree }
              : {}),
          ...(input.userId ? { userId: input.userId } : {}),
          ...(input.delegation ? { delegation: input.delegation } : {}),
          ...(input.ephemeral
            ? { [SESSION_VISIBILITY_METADATA_KEY]: 'ephemeral' }
            : {}),
          ...(input.webhookTokenId
            ? { webhookTokenId: input.webhookTokenId }
            : {}),
        },
      });
      if (continuation?.contextBoundary) {
        // A cold context is spent by the exact accepted start command. The
        // first user turn is deliberately a separate provider effect and may
        // fail without reopening or consuming a different boundary.
        if (
          !startReceipt ||
          startReceipt.commandId !== contextBoundaryStartCommandId ||
          startReceipt.sessionId !== sessionId
        ) {
          throw new ForegroundMessageIndeterminateError(
            {
              code: FOREGROUND_MESSAGE_INDETERMINATE_CODE,
              outcome: 'indeterminate',
              receipt: {
                commandId: contextBoundaryStartCommandId!,
                threadId: sessionId,
                commandType: 'startSession',
                status: 'accepted',
                createdAt: new Date().toISOString(),
              },
              receiptStatus: 'unavailable',
              session: {
                threadId: sessionId,
                provider: resolved.provider,
                status: 'ready',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            },
            'Cold session start did not return its exact accepted receipt; do not retry automatically.',
          );
        }
        try {
          deps.consumeConversationContextBoundary?.(
            resolved.access,
            continuation.contextBoundary.boundaryId,
            contextBoundaryStartCommandId,
          );
        } catch (error) {
          // The provider start is already accepted. A failed local settlement
          // is not proof the transaction did not commit, so fence it rather
          // than releasing and allowing a second empty start.
          throw new ForegroundMessageIndeterminateError(
            {
              code: FOREGROUND_MESSAGE_INDETERMINATE_CODE,
              outcome: 'indeterminate',
              receipt: {
                commandId: contextBoundaryStartCommandId,
                threadId: sessionId,
                commandType: 'startSession',
                status: 'accepted',
                createdAt: new Date().toISOString(),
              },
              receiptStatus: 'unavailable',
              session: {
                threadId: sessionId,
                provider: resolved.provider,
                status: 'ready',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            },
            `Cold session start is accepted but boundary settlement is indeterminate: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } catch (error) {
      if (continuation?.contextBoundary) {
        deps.releaseConversationContextBoundaryFailedClaim?.(
          resolved.access,
          continuation.contextBoundary.boundaryId,
          mayHaveStartedForegroundSession(error),
        );
      }
      // An indeterminate command may have created and attached the session.
      // Its worktree is now owned by that possible session, so compensation
      // must not erase it. The typed error remains unchanged for the route,
      // SDK, and caller to observe rather than retry.
      if (worktree && !mayHaveStartedForegroundSession(error)) {
        try {
          await (deps.finalizeWorktree ?? defaultWorktreeFinalizer)({
            // A start that never persisted cannot be preserved safely: no
            // session event will own or reconcile it. Override preservation
            // only for this compensating transaction.
            metadata: {
              ...worktree,
              cleanupPolicy: 'cleanup',
              preserveOnFailure: false,
            },
            terminalState: 'cancelled',
          });
        } catch (cleanupError) {
          const cleanupMessage =
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError);
          const message = `LEAKED WORKTREE: session start failed and compensating cleanup failed; manual cleanup is required for path=${worktree.path} branch=${worktree.branch} repo=${worktree.repoPath}: ${cleanupMessage}`;
          const leakFields = {
            worktreePath: worktree.path,
            worktreeBranch: worktree.branch,
            worktreeRepoPath: worktree.repoPath,
            cleanupError: cleanupMessage,
          };
          logger.warn(message, leakFields);
          deps.warn?.(message, leakFields);
          if (error instanceof Error)
            error.message = `${error.message} (${message})`;
        }
      }
      throw error;
    }
  }
  const effectiveClientTurnId = requestedHandoff
    ? `handoff:${createHash('sha256')
        .update(`${conversationId}\0${input.handoffIntent!.idempotencyKey}`)
        .digest('hex')}`
    : input.clientTurnId;
  const attachments = input.resolveAttachments
    ? input.resolveAttachments({
        threadId: sessionId,
        clientTurnId: effectiveClientTurnId ?? '',
      })
    : input.attachments;
  const turn = await deps.sendTurn(
    resolved.access,
    {
      threadId: sessionId,
      input: message,
      ...(attachments ? { attachments } : {}),
      ...(continuation?.transcriptSeed || input.ambientContext
        ? {
            ambientContext: [continuation?.transcriptSeed, input.ambientContext]
              .filter(
                (value): value is string =>
                  typeof value === 'string' && value.trim().length > 0,
              )
              .join('\n\n'),
          }
        : {}),
      ...(effectiveClientTurnId ? { clientTurnId: effectiveClientTurnId } : {}),
      // Only an override the CALLER sent for this turn goes on a sendTurn. The
      // Agent's declared model is applied once, at session start, where the
      // adapter declares it can apply one; engines describe their per-turn
      // omission as engine-selected, meaning the model chosen at start still
      // governs. Re-sending it every turn would present the Agent's own model as
      // a per-turn override to adapters that declare they cannot take one.
      ...(input.target.model?.override
        ? { modelId: input.target.model.override }
        : {}),
      ...(resolved.modelOptions
        ? { modelOptions: { ...resolved.modelOptions } }
        : {}),
    },
    input.clientOrigin || input.principal
      ? {
          ...(input.clientOrigin ? { clientOrigin: input.clientOrigin } : {}),
          ...(input.principal ? { principal: input.principal } : {}),
        }
      : undefined,
  );
  if (!turn.turnId) {
    throw new ForegroundMessageTurnIdentityUnavailableError(
      'Foreground turn acceptance did not include a provider turn id',
    );
  }
  return {
    conversationId,
    sessionId,
    providerTurnId: turn.turnId,
    target: { kind: 'agent', id: resolved.agentId },
    resolution: resolved.receipt,
    ...(preparedHandoff
      ? {
          handoff: {
            predecessorSessionId: preparedHandoff.marker.predecessorSessionId,
            sessionId,
            currentSessionId: sessionId,
            outcome: preparedHandoff.outcome,
            target: {
              agentId: resolved.agentId,
              engine: resolved.engine,
              ...(resolved.modelId ? { modelId: resolved.modelId } : {}),
            },
            carried: preparedHandoff.carried,
            reset: preparedHandoff.reset,
          },
        }
      : {}),
  };
}

const defaultWorktreeProvisioningService = new WorktreeProvisioningService();
const defaultWorktreeProvisioner =
  defaultWorktreeProvisioningService.provision.bind(
    defaultWorktreeProvisioningService,
  );
const defaultWorktreeFinalizer =
  defaultWorktreeProvisioningService.finalize.bind(
    defaultWorktreeProvisioningService,
  );

function validateContinuationWorkspace(
  binding: ExecutionSessionBinding,
  workspace: ResolvedWorkspaceTarget | undefined,
): void {
  const requestedIsolation =
    workspace?.kind === 'project'
      ? workspace.workspaceIsolation.mode
      : 'shared';
  const originalIsolation = binding.worktree
    ? 'worktree'
    : binding.workspaceIsolation?.mode;
  // UX audit T3: a conversation that was never bound to a workspace at all is
  // a DIFFERENT situation from one bound somewhere else, and only this one is
  // recoverable — nothing is in the wrong place, the conversation simply has
  // no directory and the caller supplied one. It used to collapse into either
  // an untyped `Error` (project workspace) or
  // `continuation_workspace_direct_mismatch` (directory workspace), both of
  // which read to the client as "belongs elsewhere", so the queued follow-up
  // that triggered it was treated as permanently rejected and destroyed.
  //
  // NOT lazily bound here, deliberately: an engine process's working
  // directory is fixed when it is spawned, so writing a `cwd` onto this
  // conversation's binding would record a directory the running engine is not
  // in — a stored fact nothing derives, which is the exact defect class this
  // audit is about. The honest recovery is the caller's: continue this
  // conversation as it is, or start a new one in the workspace.
  const neverBound =
    !binding.worktree &&
    binding.cwd === undefined &&
    binding.workspaceIsolation === undefined;
  if (workspace && neverBound) {
    throw new ContinuationWorkspaceError(
      'continuation_workspace_unbound',
      'This conversation was started without a workspace, so it cannot be continued inside one. Continue it as it is, or start a new chat in this workspace.',
    );
  }
  if (workspace?.kind === 'project' && !originalIsolation) {
    throw new Error(
      'The requested conversation has no verified workspace isolation',
    );
  }
  if (binding.worktree) {
    const worktree = binding.worktree;
    if (workspace?.kind !== 'project')
      throw new ContinuationWorkspaceError(
        'continuation_workspace_project_context_missing',
        'This conversation must be resumed from its original project.',
      );
    if (originalIsolation !== requestedIsolation) {
      throw new Error(
        'The requested conversation belongs to a different workspace isolation',
      );
    }
    if (!existsSync(worktree.path))
      throw new ContinuationWorkspaceError(
        'continuation_workspace_worktree_gone',
        "This conversation's worktree is gone and cannot be resumed.",
      );
    if (!sameRealPath(worktree.repoPath, workspace.cwd))
      throw new ContinuationWorkspaceError(
        'continuation_workspace_different_project',
        'This conversation belongs to a different project.',
      );
    if (binding.cwd === undefined)
      throw new ContinuationWorkspaceError(
        'continuation_workspace_corrupt_worktree_binding',
        'This conversation has a corrupt worktree binding.',
      );
    if (!sameRealPath(binding.cwd, worktree.path))
      throw new ContinuationWorkspaceError(
        'continuation_workspace_worktree_moved',
        "This conversation's worktree has moved and cannot be resumed.",
      );
    if (binding.cwd !== worktree.path)
      throw new ContinuationWorkspaceError(
        'continuation_workspace_corrupt_worktree_binding',
        'This conversation has a corrupt worktree binding.',
      );
    return;
  }
  if (originalIsolation && originalIsolation !== requestedIsolation) {
    throw new Error(
      'The requested conversation belongs to a different workspace isolation',
    );
  }
  // Omitting workspace context on a continuation preserves the existing
  // session binding. This is necessary for global/directory conversations:
  // their provider process has a concrete cwd even though the UI has no
  // project slug or directory picker to resend. It is not a permissive
  // rebind: an explicit workspace still reaches the exact checks below.
  if (!workspace && binding.cwd !== undefined) return;

  // A direct conversation has no workspace binding. A partial binding is
  // hostile/corrupt; only the fully unbound direct shape may continue.
  if (!workspace && binding.cwd === undefined && !originalIsolation) return;
  // sameRealPath, not raw `!==`. The worktree branch above has always used it;
  // this one did not, so a trailing slash or a symlinked path (/tmp vs
  // /private/tmp on macOS) read as "a different directory" while being the
  // same one. The root cause of station#3147 was upstream — an unexpanded
  // `~/…` reaching here — and is fixed at the resolver, but a guard that
  // rejects equivalent spellings of one directory is its own defect, and this
  // one refuses to continue a conversation, which is not a failure mode worth
  // being brittle about.
  //
  // Deliberately NOT applied to the worktree binding check above: that
  // exactness is intentional there and is covered by its own test.
  // The `binding.cwd === undefined` arm preserves the previous behaviour
  // exactly: raw `undefined !== '/x'` was true, so an unbound binding reaching
  // here with a workspace present already threw. Spelling it out rather than
  // letting it fall out of a type coercion.
  if (
    !workspace ||
    binding.cwd === undefined ||
    !sameRealPath(binding.cwd, workspace.cwd)
  ) {
    throw new ContinuationWorkspaceError(
      'continuation_workspace_direct_mismatch',
      'This conversation belongs to a different workspace directory.',
    );
  }
}

function sameRealPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

export function canonicalHandoffEffectDigest(value: unknown): string {
  const canonicalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(canonicalize);
    if (candidate && typeof candidate === 'object') {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonicalize(entry)]),
      );
    }
    return candidate;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

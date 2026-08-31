import { agentId } from '@kontourai/station-contracts/agent-identity';
import {
  parseStationAnswerNarrativePublishInput,
  parseStationAnswerNarrativeRemoveInput,
} from '@kontourai/station-contracts/answer-narrative-binding';
import type { StagedAttachmentReference } from '@kontourai/station-contracts/attachment-staging';
import {
  CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES,
  CHAT_ATTACHMENT_MAX_COUNT,
  CHAT_ATTACHMENT_MAX_DATA_URL_LENGTH,
  CHAT_ATTACHMENT_MAX_NAME_LENGTH,
  type ChatAttachmentInput,
  validateChatAttachment,
  validateChatAttachments,
} from '@kontourai/station-contracts/chat-attachment';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import type {
  ConversationContextBoundaryProjection,
  ConversationContextBoundaryRequest,
} from '@kontourai/station-contracts/conversation-context-boundary';
import {
  type EnvironmentRef,
  type ExecutionModelRequest,
  type ExecutionTarget,
  environmentId,
} from '@kontourai/station-contracts/execution-target';
import type {
  TerminalProcessDetail,
  TerminalProcessSummary,
} from '@kontourai/station-contracts/orchestration';
import { FOREGROUND_MESSAGE_INDETERMINATE_CODE } from '@kontourai/station-contracts/orchestration';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import {
  ORCHESTRATION_STREAM_CAUGHT_UP_EVENT,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import { SESSION_INVENTORY_CURRENT_GROUP_IDS } from '@kontourai/station-contracts/session-inventory';
import {
  parseStationSessionInventoryMcpNegotiatedInput,
  STATION_SESSION_INVENTORY_MCP_V2_VERSION,
} from '@kontourai/station-contracts/session-inventory-mcp';
import {
  type HostedTenantRegistry,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { SESSION_LIFECYCLE_STATES } from '../../../packages/contracts/src/session-lifecycle.js';
import { CHAT_INPUT_MAX_CHARS } from '../../../src-shared/chat-input-limits.js';
import {
  ORCHESTRATION_STREAM_REPLAY_MAX_SERIALIZED_BYTES,
  ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD,
  SSE_KEEPALIVE_INTERVAL_MS,
} from '../../constants.js';
import {
  getTenantRequestContext,
  tenantExecutionContextForRequest,
} from '../../runtime/bootstrap/runtime-tenant-context.js';
import { resolveClientOriginForRequest } from '../../security/runtime-request-security.js';
import {
  AnswerAssessmentConflictError,
  AnswerAssessmentModule,
  AnswerAssessmentUnavailableError,
} from '../../services/evidence/answer-assessment-module.js';
import {
  AnswerNarrativeBindingModule,
  AnswerNarrativeConflictError,
  AnswerNarrativeUnavailableError,
} from '../../services/evidence/answer-narrative-binding-module.js';
import type { ExactAnswerBasisModule } from '../../services/evidence/exact-answer-basis-module.js';
import type { ReviewedSourceBasisResolver } from '../../services/evidence/reviewed-source-basis-resolver.js';
import {
  ForegroundMessageIndeterminateError,
  ForegroundMessageTurnIdentityUnavailableError,
} from '../../services/execution-target/execution-target-execution.js';
import { PrincipalUnresolvedError } from '../../services/identity/principal-resolver.js';
import { actionOperationActorForRequest } from '../../services/operations/action-operation-authority.js';
import {
  type ActionOperationTrackingService,
  beginActionOperationTracking,
  handoffActionOperationId,
} from '../../services/operations/action-operation-tracker.js';
import { ConversationContextBoundaryNotFoundError } from '../../services/orchestration/conversation-lineage.js';
import type { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import {
  AdoptionContinuationInProgressError,
  OrchestrationCommandDispatchError,
} from '../../services/orchestration/orchestration-service.js';
import {
  OrchestrationStreamPresence,
  orchestrationStreamPresenceSubjectFromAuthority,
} from '../../services/orchestration/orchestration-stream-presence.js';
import type { SessionInventoryAppReadModule } from '../../services/orchestration/session-inventory-app-read-module.js';
import type { SessionInventoryModule } from '../../services/orchestration/session-inventory-module.js';
import { MAX_TOOL_RESULT_DESCRIPTOR_ID_BYTES } from '../../services/orchestration/thread-tool-result-adapter.js';
import { ProjectWorktreeDirectoryError } from '../../services/projects/project-service.js';
import { composeAuthorizedSessionAnswerBasis } from '../../services/projects/task-basis-module.js';
import {
  orchestrationStreamDuration,
  orchestrationStreamPresenceOps,
  orchestrationStreamResumeDecisions,
  orchestrationStreamResumeGap,
  sseOps,
} from '../../telemetry/metrics.js';
import { sessionCorrelationBindings } from '../../utils/logger-correlation.js';
import { assertBoundedJsonResponse } from '../chat/bounded-response.js';
import { errorMessage, getBody, param, validate } from '../schemas/schemas.js';
import { streamSSE } from '../sse-response.js';

// These are intentional public projections. The typed code/outcome and, when
// available, the receipt/session below give callers evidence to observe; a
// thrown implementation message must not become part of the route Interface.
const FOREGROUND_MESSAGE_INDETERMINATE_ERROR =
  'Foreground Agent message may have started. Do not retry automatically.';
const FOREGROUND_CONTINUATION_INDETERMINATE_ERROR =
  'Foreground Agent continuation may have started. Do not retry automatically.';

const reviewedSourceAssociationSchema = z
  .object({
    version: z.literal('station.reviewed-source-association/v1'),
    pluginName: z.string().min(1).max(512),
    sourceClaimId: z.string().min(1).max(512),
    sourceEvidenceId: z.string().min(1).max(512),
    answerClaimId: z.string().min(1).max(512),
    answerCitationEvidenceId: z.string().min(1).max(512),
    owner: z.literal('@kontourai/fieldwork'),
    runId: z.string().min(1).max(512),
    exactRef: z.string().min(1).max(512),
    assessmentRevision: z.number().int().positive(),
    projectId: z.string().min(1).max(512),
    workspaceId: z.string().min(1).max(512),
    principalId: z.string().min(1).max(512),
  })
  .strict();
const answerAssessmentPutSchema = z
  .object({
    expectedAnswer: z.unknown(),
    publicationId: z.string().min(1).max(512),
    bundle: z.unknown(),
    claimId: z.string().min(1).max(512),
    expectedRevision: z.number().int().nonnegative(),
    reviewedSource: reviewedSourceAssociationSchema.optional(),
  })
  .strict();
const answerAssessmentDeleteSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
  })
  .strict();
const answerNarrativePutSchema = z
  .object({
    expectedAnswer: z.unknown(),
    publicationId: z.string().min(1).max(512),
    expectedRevision: z.number().int().nonnegative(),
    ownerId: z.literal('flow-agents.project-narratives/v1'),
    narrativeRef: z.unknown(),
  })
  .strict();
const answerNarrativeDeleteSchema = z
  .object({ expectedRevision: z.number().int().nonnegative() })
  .strict();
const sessionOutputsQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();
const sessionInventoryQueryBaseSchema = z
  .object({
    scope: z.enum(['whole-session', 'current-answer']),
    turnId: z.string().min(1).max(1024).optional(),
  })
  .strict();
const sessionInventoryQuerySchema = sessionInventoryQueryBaseSchema.superRefine(
  (value, ctx) => {
    if (value.scope === 'current-answer' && !value.turnId)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'turnId required' });
    if (value.scope === 'whole-session' && value.turnId)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'turnId not allowed',
      });
  },
);
const sessionInventoryPageQuerySchema = sessionInventoryQueryBaseSchema
  .extend({ continuation: z.string().min(1).max(1024).optional() })
  .superRefine((value, ctx) => {
    if (value.scope === 'current-answer' && !value.turnId)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'turnId required' });
    if (value.scope === 'whole-session' && value.turnId)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'turnId not allowed',
      });
  });
const sessionOutputInspectSchema = z.object({}).strict();

/** Narrow, runtime-checked view of the `ForegroundMessageHandle` shape
 * `executeForegroundMessage` resolves (`execution-target-execution.ts`).
 * The route's own `deps.executeForegroundMessage` is typed `Promise<unknown>`
 * (a generic Hono DI boundary), so this is a real type GUARD, not a cast —
 * a caller-injected value missing `conversationId` is simply not bound. */
function isForegroundDispatchHandle(value: unknown): value is {
  conversationId: string;
  providerTurnId: string;
  target?: { id?: unknown };
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { conversationId?: unknown }).conversationId ===
      'string' &&
    typeof (value as { providerTurnId?: unknown }).providerTurnId ===
      'string' &&
    (value as { providerTurnId: string }).providerTurnId.trim().length > 0
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isForegroundIndeterminateShape(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code ===
      FOREGROUND_MESSAGE_INDETERMINATE_CODE &&
    (error as { outcome?: unknown }).outcome === 'indeterminate'
  );
}

const chatAttachmentSchema = z
  .object({
    kind: z.enum(['image', 'file']),
    name: z.string().min(1).max(CHAT_ATTACHMENT_MAX_NAME_LENGTH),
    mimeType: z.string().min(1).max(128),
    size: z.number().int().positive(),
    dataUrl: z.string().max(CHAT_ATTACHMENT_MAX_DATA_URL_LENGTH),
  })
  .superRefine((attachment, ctx) => {
    const error = validateChatAttachment(
      attachment as unknown as ChatAttachmentInput,
    );
    if (error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
    }
  });

const adoptSessionCommandSchema = z.object({
  type: z.literal('adoptSession'),
  sourceThreadId: z.string().min(1).max(512),
  idempotencyKey: z.string().uuid().max(64).optional(),
});

const interruptTurnCommandSchema = z.object({
  type: z.literal('interruptTurn'),
  threadId: z.string().min(1),
  turnId: z.string().optional(),
  // UX audit T1 review: the dispatch key this Stop is aimed at, so a cancel
  // recorded before its turn started can be bound to THAT turn instead of
  // whatever starts next on the thread. Bounded like every other client id on
  // this route; it is only ever compared, never executed or interpolated.
  clientTurnId: z.string().min(1).max(128).optional(),
});

const steerTurnCommandSchema = z.object({
  type: z.literal('steerTurn'),
  threadId: z.string().min(1),
  // archive#2831: this carries a composer draft verbatim (the queued-message
  // steer path sends the same string the composer's 200k courtesy check
  // gates), so it derives from the same declared maximum — the hardcoded
  // 100_000 that lived here refused at half the composer's limit with a
  // generic zod message, exactly the divergence archive#2807 unified away.
  input: z.string().trim().min(1).max(CHAT_INPUT_MAX_CHARS),
  turnId: z.string().optional(),
});

const respondToRequestCommandSchema = z.object({
  type: z.literal('respondToRequest'),
  threadId: z.string().min(1),
  requestId: z.string().min(1),
  decision: z.enum(['accept', 'acceptForSession', 'decline', 'cancel']),
});

const stopSessionCommandSchema = z.object({
  type: z.literal('stopSession'),
  threadId: z.string().min(1),
});

const sessionTransitionSchema = z.object({
  state: z.enum(SESSION_LIFECYCLE_STATES),
  reason: z
    .enum([
      'blocked_by_user',
      'retry_requested',
      'request_resolved',
      'manual_update',
      'system_recovered',
    ])
    .optional(),
  message: z.string().min(1).optional(),
});

// Exported (archive#2831) for the structural derivation pin in
// __tests__/orchestration-chat-input-limits.test.ts, which walks EVERY
// string field reachable in this union — a new command's text fields are
// seen by that walker without anyone remembering to enumerate them.
export const orchestrationCommandSchema = z.discriminatedUnion('type', [
  adoptSessionCommandSchema,
  interruptTurnCommandSchema,
  steerTurnCommandSchema,
  respondToRequestCommandSchema,
  stopSessionCommandSchema,
]);

const environmentRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('current') }),
  z.object({
    kind: z.literal('saved'),
    id: z.string().min(1).max(512),
  }),
]);

const workspaceTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('project'),
    projectSlug: z.string().min(1).max(512),
    cwd: z.string().min(1).max(4_096).optional(),
  }),
  z.object({
    kind: z.literal('directory'),
    cwd: z.string().min(1).max(4_096),
  }),
]);

const executionTargetSchema = z.object({
  environment: environmentRefSchema.optional(),
  agent: z.string().min(1).max(64),
  model: z
    .object({
      override: z.string().min(1).max(512).optional(),
      options: z.record(z.unknown()).optional(),
    })
    .optional(),
  workspace: workspaceTargetSchema.optional(),
});

function normalizeExecutionTarget(
  target: z.infer<typeof executionTargetSchema>,
  defaultEnvironment: EnvironmentRef = { kind: 'current' },
): ExecutionTarget {
  const selectedEnvironment = target.environment ?? defaultEnvironment;
  return {
    ...target,
    environment:
      selectedEnvironment.kind === 'saved'
        ? { kind: 'saved', id: environmentId(selectedEnvironment.id) }
        : { kind: 'current' },
    agent: agentId(target.agent),
  };
}

// archive#2807: the turn-starting text bounds below derive from the same
// declared prompt maximum the UI composer and `/chat`'s chatSchema use — a
// hardcoded literal here would make the composer's courtesy check lie the
// moment the constant moves. archive#2831 closed the last known gap on this
// seam: `steerTurnCommandSchema.input` (a composer draft, above) now derives
// too. These schemas are exported for the derivation pin (behavioral, for
// the message-shaped fields) and the structural walker (every string field
// of every exported schema here) in
// __tests__/orchestration-chat-input-limits.test.ts.
export const delegateTaskSchema = z.object({
  prompt: z.string().trim().min(1).max(CHAT_INPUT_MAX_CHARS),
  target: executionTargetSchema,
  parentTaskId: z.string().min(1).max(512).optional(),
});

export const foregroundMessageObjectSchema = z.object({
  target: executionTargetSchema,
  // An image-only turn is meaningful: the attachment is the prompt. Keep the
  // text bound, but let the object-level check below require either text or an
  // attachment rather than silently rejecting a caption-less pasted image.
  message: z.string().max(CHAT_INPUT_MAX_CHARS),
  conversationId: z.string().min(1).max(512).optional(),
  ambientContext: z.string().max(4000).optional(),
  attachments: z
    .array(chatAttachmentSchema)
    .max(CHAT_ATTACHMENT_MAX_COUNT)
    .superRefine((attachments, ctx) => {
      const error = validateChatAttachments(
        attachments as unknown as ChatAttachmentInput[],
      );
      if (error) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
      }
    })
    .optional(),
  attachmentRefs: z
    .array(
      z.object({
        stageId: z.string().min(1).max(128),
        clientAttachmentId: z.string().min(1).max(128),
        source: z.literal('current-composer'),
        kind: z.enum(['image', 'file']),
        name: z.string().max(CHAT_ATTACHMENT_MAX_NAME_LENGTH),
        mimeType: z.enum([
          'image/gif',
          'image/jpeg',
          'image/png',
          'image/webp',
          'application/json',
          'application/pdf',
          'text/csv',
          'text/markdown',
          'text/plain',
        ]),
        size: z.number().int(),
        digest: z
          .string()
          .max(71)
          .regex(/^sha256-[0-9a-f]{64}$/),
        expiresAt: z.string().max(40).datetime(),
      }),
    )
    .max(CHAT_ATTACHMENT_MAX_COUNT)
    .optional(),
  clientTurnId: z.string().min(1).max(200).optional(),
});

const agentDelegationContextSchema = z.object({
  mode: z.literal('isolated-child'),
  depth: z.number().int().min(1).max(64),
  maxDepth: z.number().int().min(1).max(64),
  parentAgentSlug: z.string().min(1).max(64),
  parentConversationId: z.string().min(1).max(512).optional(),
  rootAgentSlug: z.string().min(1).max(64),
  rootConversationId: z.string().min(1).max(512).optional(),
  allowedTools: z.array(z.string().min(1).max(256)).max(256).optional(),
  blockedTools: z.array(z.string().min(1).max(256)).max(256).optional(),
  denyApprovals: z.boolean().optional(),
});

function requireMessageOrAttachment(
  value: {
    message: string;
    attachments?: unknown[];
    attachmentRefs?: unknown[];
  },
  ctx: z.RefinementCtx,
): void {
  if (value.attachments?.length && value.attachmentRefs?.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['attachmentRefs'],
      message:
        'Inline attachments and staged attachment references cannot be combined.',
    });
    return;
  }
  if (
    value.message.trim().length > 0 ||
    value.attachments?.length ||
    value.attachmentRefs?.length
  )
    return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['message'],
    message: 'A message or attachment is required.',
  });
}

const foregroundMessageSchema = foregroundMessageObjectSchema.superRefine(
  requireMessageOrAttachment,
);
const delegatedForegroundMessageSchema = foregroundMessageObjectSchema
  .extend({ delegation: agentDelegationContextSchema })
  .superRefine(requireMessageOrAttachment);

// Exported (archive#2831) for the structural derivation pin in
// __tests__/orchestration-chat-input-limits.test.ts: this continuation body
// starts turns too, so its string fields must be walked like every other
// turn-entry schema on this seam.
export const continueForegroundMessageSchema = foregroundMessageObjectSchema
  .omit({
    target: true,
    conversationId: true,
  })
  .extend({
    // A continuation is remote-capable. Never silently strip a current-host
    // reference: that would hide a cross-host byte dispatch from the caller.
    attachmentRefs: z.never().optional(),
    environment: environmentRefSchema.optional(),
    // The persisted binding, not this continuation request, owns execution
    // identity. Preserve legacy clients that sent a scalar `model` field by
    // dropping it; an object is the explicit, validated next-turn override.
    model: z.preprocess(
      (value) =>
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? value
          : undefined,
      executionTargetSchema.shape.model,
    ),
  })
  .superRefine(requireMessageOrAttachment);

export const conversationHandoffSchema = foregroundMessageObjectSchema.extend({
  // A handoff may target another Station; current-host staged references
  // have no portable byte authority and must be refused at validation.
  attachmentRefs: z.never().optional(),
  idempotencyKey: z.string().min(1).max(200),
});

export const conversationContextBoundarySchema = z.object({
  policy: z.enum(['continue-from-history', 'empty-next-cold-start']),
  idempotencyKey: z.string().min(1).max(200),
  expectedCurrentSessionId: z.string().min(1).max(512),
});

const delegationOptionsSchema = z.object({
  environmentId: z.string().min(1).max(512).optional(),
  projectSlug: z.string().min(1).max(512).optional(),
  projectPath: z.string().min(1).max(4_096).optional(),
});

const delegatedTaskListQuerySchema = z.object({
  environmentId: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const delegatedTaskQuerySchema = z.object({
  environmentId: z.string().min(1).max(512).optional(),
});

const delegatedTaskEventsQuerySchema = z.object({
  environmentId: z.string().min(1).max(512).optional(),
  cursor: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const continueDelegatedTaskBodySchema = z.object({
  message: z.string().min(1).max(CHAT_INPUT_MAX_CHARS),
  environmentId: z.string().min(1).max(512).optional(),
  model: z.string().min(1).max(512).optional(),
  // archive#978: per-invocation settings passthrough on a follow-up turn.
  modelOptions: z.record(z.unknown()).optional(),
});

const respondToDelegatedTaskBodySchema = z.object({
  requestId: z.string().min(1).max(512),
  decision: z.enum(['accept', 'acceptForSession', 'decline', 'cancel']),
  environmentId: z.string().min(1).max(512).optional(),
});

const interruptDelegatedTaskBodySchema = z.object({
  environmentId: z.string().min(1).max(512).optional(),
  turnId: z.string().min(1).max(512).optional(),
});

const sessionEventPageQuerySchema = z.object({
  afterSequence: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const sessionEventWindowQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  turnLimit: z.coerce.number().int().min(1).max(20).default(10),
});

interface DelegateTaskRequest {
  prompt: string;
  target: ExecutionTarget;
  parentTaskId?: string;
  userId: string;
}

interface ForegroundMessageRequest {
  target: ExecutionTarget;
  message: string;
  conversationId?: string;
  attachments?: ChatAttachmentInput[];
  resolveAttachments?: (binding: {
    threadId: string;
    clientTurnId: string;
  }) => ChatAttachmentInput[];
  ambientContext?: string;
  clientTurnId?: string;
  userId: string;
  /**
   * archive#4075 stage 2: the dispatching caller's resolved `PrincipalRef`,
   * additive alongside `userId` — carried to `sendTurn`'s dispatch context
   * so the resulting `turn.started` is attributed at emit time. `undefined`
   * on the legacy test-only `getUserId` path (see `resolveActorPrincipal`).
   */
  principal?: PrincipalRef;
  clientOrigin?: ClientOrigin;
}

interface ContinueForegroundMessageRequest {
  conversationId: string;
  environment?: EnvironmentRef;
  model?: ExecutionModelRequest;
  message: string;
  attachments?: ChatAttachmentInput[];
  ambientContext?: string;
  clientTurnId?: string;
  userId: string;
  /** archive#4075 stage 2 review round 1 (F1) — see ForegroundMessageRequest.principal. */
  principal?: PrincipalRef;
  clientOrigin?: ClientOrigin;
}

interface ConversationHandoffRequest
  extends Omit<
    z.infer<typeof conversationHandoffSchema>,
    'target' | 'attachments'
  > {
  target: ExecutionTarget;
  attachments?: ChatAttachmentInput[];
  conversationId: string;
  userId: string;
  /** archive#4075 stage 2 review round 1 (F1) — see ForegroundMessageRequest.principal. */
  principal?: PrincipalRef;
  clientOrigin?: ClientOrigin;
}

interface ConversationContextBoundaryRouteRequest
  extends ConversationContextBoundaryRequest {
  conversationId: string;
  actorId: string;
  clientOrigin: ClientOrigin;
}

type DelegatedTaskListRequest = z.infer<typeof delegatedTaskListQuerySchema> & {
  userId: string;
};

type DelegatedTaskReferenceRequest = z.infer<
  typeof delegatedTaskQuerySchema
> & {
  taskId: string;
  userId: string;
};

type DelegatedTaskEventsRequest = z.infer<
  typeof delegatedTaskEventsQuerySchema
> & {
  taskId: string;
  userId: string;
};

type ContinueDelegatedTaskRequest = z.infer<
  typeof continueDelegatedTaskBodySchema
> & {
  taskId: string;
  userId: string;
};

type RespondToDelegatedTaskRequest = z.infer<
  typeof respondToDelegatedTaskBodySchema
> & {
  taskId: string;
  userId: string;
};

type InterruptDelegatedTaskRequest = z.infer<
  typeof interruptDelegatedTaskBodySchema
> & {
  taskId: string;
  userId: string;
};

/**
 * True when an ORCHESTRATION_EVENT payload should be forwarded to a `/events`
 * subscriber filtered by `threadId`. The eventBus emits `{ event }` where the
 * canonical runtime event carries `threadId`; an unset filter forwards all
 * sessions (the all-sessions stream the app already consumes). Exported for
 * unit coverage of the filter without standing up an SSE stream.
 */
export function orchestrationEventMatchesThread(
  data: Record<string, unknown> | undefined,
  threadId: string | undefined,
): boolean {
  if (!threadId) return true;
  const event = (data as { event?: { threadId?: string } } | undefined)?.event;
  return event?.threadId === threadId;
}

/**
 * Parses an incoming `Last-Event-ID` header into a valid resume cursor
 * (archive#1092). Anything that isn't a plain non-negative integer —
 * missing, malformed, a foreign format from some other stream — is treated
 * as "no cursor" (fail-closed to the snapshot path) rather than thrown.
 * Exported for unit coverage without standing up an SSE stream.
 */
export function parseResumeCursor(
  headerValue: string | null | undefined,
): number | undefined {
  if (!headerValue || !/^\d+$/.test(headerValue)) return undefined;
  const value = Number(headerValue);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Decides replay-vs-snapshot for a reconnecting `/events` client
 * (archive#1092, R1/R2). No cursor, or a cursor ahead of the current head
 * (stale/foreign/post-wipe), always falls to snapshot; a gap within
 * {@link ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD} replays. Exported for
 * unit coverage of the boundary without standing up an SSE stream.
 *
 * `threadMissedCount`, when passed, overrides the `head - cursor` arithmetic
 * used as the gap. This is required for a `threadId`-scoped connection
 * (review finding, post-merge HIGH): `head` is the CROSS-THREAD global
 * sequence, so `head - cursor` counts every thread's traffic, not this
 * thread's. A thread with a small cursor gap can still fail
 * `head - cursor <= threshold` purely because *some other* thread produced
 * over `threshold` events in between — forcing a snapshot for a
 * reconnecting client that has, in truth, missed almost nothing on its own
 * thread. The caller computes `threadMissedCount` via a bounded
 * (`LIMIT threshold + 1`) thread-scoped query so this stays cheap even when
 * the true count is large. Omitted (global, no-`threadId`, stream): the
 * cheap `head - cursor` arithmetic is exact, since `global_sequence` has no
 * gaps.
 */
export function resolveStreamResumePlan(
  cursor: number | undefined,
  head: number,
  threadMissedCount?: number,
): {
  decision: 'replay' | 'snapshot';
  reason: 'no_cursor' | 'invalid_cursor' | 'gap_exceeded' | 'within_threshold';
  gap?: number;
} {
  if (cursor === undefined)
    return { decision: 'snapshot', reason: 'no_cursor' };
  if (cursor > head) return { decision: 'snapshot', reason: 'invalid_cursor' };
  const gap =
    threadMissedCount !== undefined ? threadMissedCount : head - cursor;
  if (gap > ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD) {
    return { decision: 'snapshot', reason: 'gap_exceeded', gap };
  }
  return { decision: 'replay', reason: 'within_threshold', gap };
}

/**
 * archive#4075 stage 2: the minimal per-request shape `resolvePrincipal`
 * needs — a duck-typed subset of Hono's `Context`, not the Hono type itself,
 * so this route module stays decoupled from Hono internals. Every route
 * handler below satisfies it with its own `c` (a real Hono `Context` has
 * `env`/`req.raw`/`req.header` and more, which is fine — a wider object
 * satisfies a narrower structural type).
 */
export interface PrincipalResolutionContext {
  env: unknown;
  req: {
    raw: Request;
    header(name: string): string | undefined;
  };
}

/**
 * archive#4075 stage 2: the ONE place this route module turns "who is
 * calling" into a `PrincipalRef` (+ the wire `userId` string every existing
 * join already keys on, derived from `principal.id`). Fail-closed by
 * construction — never a default:
 *
 * - `deps.resolvePrincipal` present (production, wired once at
 *   `runtime-routes.ts`'s single `createOrchestrationRoutes` call site) —
 *   the authority-gated resolver runs; an unresolvable caller means this
 *   THROWS {@link PrincipalUnresolvedError}, which propagates to the
 *   caller's own try/catch (or, for a route with none, Hono's default error
 *   response) — never a silent `getCachedUser().alias` default. This was
 *   the "one implicit principal" defect (archive#4075 architecture map,
 *   stage-2 probe finding 2): production never wired anything into the
 *   `getUserId` seam, so every one of this file's call sites fell through
 *   to the OS-account alias for every caller and device.
 * - `deps.resolvePrincipal` absent AND `deps.getUserId` present — a
 *   deliberately narrower TEST-ONLY escape hatch, not a default: a test
 *   double must explicitly inject a concrete userId (dozens of this file's
 *   existing route tests do), which is categorically different from a
 *   silent process-global read. `principal` is `undefined` on this path
 *   (no `PrincipalRef` to stamp — those tests were never asserting on
 *   `principal` propagation, and the field is additive/optional
 *   everywhere it lands).
 * - Neither present — throws {@link PrincipalUnresolvedError}. There is no
 *   third branch that fabricates an "unknown-user" value.
 */
function resolveActorPrincipal(
  deps: {
    resolvePrincipal?: (c: PrincipalResolutionContext) => PrincipalRef;
    getUserId?: () => string;
  },
  c: PrincipalResolutionContext,
): { principal: PrincipalRef | undefined; userId: string } {
  if (deps.resolvePrincipal) {
    const principal = deps.resolvePrincipal(c);
    return { principal, userId: principal.id };
  }
  if (deps.getUserId) {
    return { principal: undefined, userId: deps.getUserId() };
  }
  throw new PrincipalUnresolvedError(
    'no principal resolver configured for this route (neither resolvePrincipal nor the legacy getUserId test double is set)',
  );
}

export function createOrchestrationRoutes(
  orchestrationService: OrchestrationService,
  deps: {
    eventBus: {
      subscribe(
        listener: (event: {
          event: string;
          data?: Record<string, unknown>;
        }) => void,
      ): () => void;
    };
    logger: {
      debug(message: string, meta?: Record<string, unknown>): void;
      warn?(message: string, meta?: Record<string, unknown>): void;
      /**
       * Optional (archive#1897 logging slice 3): binds a `conversationId`
       * (+ `agentSlug`/`userId` when known) child logger for the
       * `POST /chat` dispatch line below, so a `read_logs?q=<conversationId>`
       * query and a `MonitoringEmitter` event correlate on the same field
       * name (`logger-correlation.ts`). Optional so every existing narrow
       * `{ debug }` test double (dozens of call sites in this route's test
       * suite) keeps typechecking unchanged.
       */
      child?(bindings: Record<string, unknown>): {
        debug(message: string, meta?: Record<string, unknown>): void;
      };
    };
    terminalService?: {
      listProcessSummaries(): TerminalProcessSummary[];
      readProcess(sessionId: string): TerminalProcessDetail | null;
      close(sessionId: string): Promise<void>;
    };
    delegateTask?: (input: DelegateTaskRequest) => Promise<unknown>;
    executeForegroundMessage?: (
      input: ForegroundMessageRequest,
    ) => Promise<unknown>;
    /** Current-host only; resolves byte-free stage references immediately before dispatch. */
    hydrateStagedAttachments?: (
      owner: PrincipalRef,
      references: readonly StagedAttachmentReference[],
      binding: { threadId: string; clientTurnId: string },
    ) => ChatAttachmentInput[];
    acceptStagedAttachments?: (
      owner: PrincipalRef,
      references: readonly StagedAttachmentReference[],
      binding: { threadId: string; clientTurnId: string },
    ) => void;
    handoffConversation?: (
      input: ConversationHandoffRequest,
    ) => Promise<unknown>;
    reserveConversationContextBoundary?: (
      input: ConversationContextBoundaryRouteRequest,
    ) => Promise<ConversationContextBoundaryProjection>;
    readConversationContextBoundary?: (
      conversationId: string,
      idempotencyKey: string,
      authority: any,
    ) => Promise<ConversationContextBoundaryProjection | null>;
    cancelConversationContextBoundary?: (
      conversationId: string,
      idempotencyKey: string,
      authority: any,
    ) => Promise<ConversationContextBoundaryProjection | null>;
    projectDefaultEnvironment?: (projectSlug: string) => EnvironmentRef;
    continueForegroundMessage?: (
      input: ContinueForegroundMessageRequest,
    ) => Promise<unknown>;
    discoverDelegationOptions?: (
      input: z.infer<typeof delegationOptionsSchema>,
    ) => Promise<unknown>;
    listDelegatedTasks?: (input: DelegatedTaskListRequest) => Promise<unknown>;
    observeDelegatedTask?: (
      input: DelegatedTaskReferenceRequest,
    ) => Promise<unknown>;
    refreshDelegatedTaskActivity?: (input: { userId: string }) => Promise<void>;
    observeDelegatedTaskEvents?: (
      input: DelegatedTaskEventsRequest,
    ) => Promise<unknown>;
    continueDelegatedTask?: (
      input: ContinueDelegatedTaskRequest,
    ) => Promise<unknown>;
    respondToDelegatedTaskRequest?: (
      input: RespondToDelegatedTaskRequest,
    ) => Promise<unknown>;
    interruptDelegatedTask?: (
      input: InterruptDelegatedTaskRequest,
    ) => Promise<unknown>;
    /**
     * archive#4075 stage 2: DEPRECATED legacy test-only escape hatch. Never
     * wired by production runtime composition (production sets
     * `resolvePrincipal` below instead) — see `resolveActorPrincipal`'s
     * doc comment for the full contract. Kept only so this file's existing
     * route tests, which inject a bare userId string, keep working
     * unchanged; do not add a new production caller of this field.
     */
    getUserId?: () => string;
    /**
     * archive#4075 stage 2: resolves the calling request's `PrincipalRef`,
     * fail-closed (throws `PrincipalUnresolvedError` rather than ever
     * defaulting) — see `resolveActorPrincipal`. Wired once, in production,
     * at `runtime-routes.ts`'s single `createOrchestrationRoutes` call
     * site; every route in this file that used to read `getUserId` now
     * reads this instead.
     */
    resolvePrincipal?: (c: PrincipalResolutionContext) => PrincipalRef;
    /** Revalidates protected point-read publication at its response boundary. */
    isRequestPrincipalCurrent?: (request: Request) => boolean;
    /** Personal-only producer binding authority. Hosted requires a tenant adapter. */
    answerAssessmentModule?: AnswerAssessmentModule;
    /** Personal-only exact retained narrative binding owner. */
    answerNarrativeBindingModule?: AnswerNarrativeBindingModule;
    reviewedSourceBasisResolver?: ReviewedSourceBasisResolver;
    /** Shared runtime-composed exact Basis and Session inventory owners. */
    exactAnswerBasis?: ExactAnswerBasisModule;
    sessionInventory?: SessionInventoryModule;
    /** Bounded caller-bound MCP App occurrences for session inventory. */
    sessionInventoryAppRead?: SessionInventoryAppReadModule;
    callerBindingForRequest?: (request: Request) => string | undefined;
    /**
     * Immutable deployment registry supplied by runtime wiring. Its presence,
     * rather than any request field, selects hosted authorization semantics.
     */
    hostedTenantRegistry?: HostedTenantRegistry;
    /**
     * archive#1225: per-user live-subscriber presence for the `/events`
     * stream, shared with the push-on-completion gate
     * (`turn-completion-notifications.ts`) so it knows whether the owning
     * user is actually watching before scheduling a push. Optional and
     * defaulted to a private, route-local instance so every existing test
     * that constructs this route without one keeps working unchanged — a
     * route-local fallback still tracks connect/disconnect correctly within
     * a single route instance, it just can't be queried from outside it
     * (which is exactly what every caller that omits it already does today).
     */
    presence?: OrchestrationStreamPresence;
    /**
     * archive#2802/2 + fix round: read-only list of a thread's
     * recorded turn checkpoint outcomes. Optional — omitted in tests that
     * don't wire the checkpoint layer, where the route answers 503 rather
     * than pretending a thread has no checkpoints. Async by design (fix
     * round M3): every `captured` phase is verified against the live git
     * object store (`objectStatus: ok | missing | object_pruned`) so an
     * index record can never present an expired, pruned checkpoint as an
     * intact one.
     */
    listThreadCheckpoints?: (threadId: string) => Promise<unknown[]>;
    restoreThreadCheckpoint?: (input: {
      threadId: string;
      turnId: string;
      phase: 'baseline' | 'settle';
      confirmed: true;
    }) => Promise<unknown>;
    listCheckpointRestoreEvents?: (threadId: string) => unknown[];
    /** Shared status envelope for the existing attached-session handoff. */
    actionOperations?: ActionOperationTrackingService;
  },
): Hono {
  const app = new Hono();
  const presence = deps.presence ?? new OrchestrationStreamPresence();
  const readAuthorityFor = (c: PrincipalResolutionContext) =>
    sessionReadAuthorityFromRequest(
      resolveActorPrincipal(deps, c).userId,
      getTenantRequestContext(c.req.raw),
      deps.hostedTenantRegistry,
    );
  const toolResultUnavailable = (c: Context, status: 404 | 503 = 404) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json({ success: false, error: 'Tool result unavailable' }, status);
  };
  const boundedToolResultId = (value: string) =>
    value.length > 0 &&
    Buffer.byteLength(value) <=
      Math.min(MAX_TOOL_RESULT_DESCRIPTOR_ID_BYTES, 1_024);

  app.get('/providers', async (c) => {
    const data = await orchestrationService.listProviders(readAuthorityFor(c));
    return c.json({ success: true, data });
  });

  app.get('/providers/:provider/commands', async (c) => {
    const provider = param(c, 'provider');
    const data = await orchestrationService.getProviderCommands(provider);
    return c.json({ success: true, data });
  });

  app.get('/providers/:provider/models', async (c) => {
    const provider = param(c, 'provider');
    const data = await orchestrationService.getProviderModels(provider, {
      signal: c.req.raw.signal,
    });
    return c.json(
      assertBoundedJsonResponse(
        { success: true, data },
        'Orchestration provider model catalog',
      ),
    );
  });

  app.get('/sessions', async (c) => {
    const data = await orchestrationService.listSessions(readAuthorityFor(c));
    return c.json({ success: true, data });
  });

  app.get('/sessions/read-model', async (c) => {
    const authority = readAuthorityFor(c);
    if (deps.refreshDelegatedTaskActivity) {
      await deps.refreshDelegatedTaskActivity({
        userId: resolveActorPrincipal(deps, c).userId,
      });
    }
    const data = await orchestrationService.listSessionReadModel(authority);
    return c.json({ success: true, data });
  });

  app.get('/sessions/loaded', async (c) => {
    const data = await orchestrationService.listLoadedSessionReadModel(
      readAuthorityFor(c),
    );
    return c.json({ success: true, data });
  });

  const handleForegroundMessage = async (c: Context) => {
    if (!deps.executeForegroundMessage) {
      return c.json(
        { success: false, error: 'Foreground Agent execution is unavailable' },
        503,
      );
    }
    try {
      const body = getBody(c) as z.infer<
        typeof foregroundMessageObjectSchema
      > & {
        delegation?: z.infer<typeof agentDelegationContextSchema>;
        automaticBackground?: true;
      };
      const { principal, userId } = resolveActorPrincipal(deps, c);
      const stagedAttachments = body.attachmentRefs as
        | StagedAttachmentReference[]
        | undefined;
      if (stagedAttachments?.length && !principal) {
        throw new PrincipalUnresolvedError(
          'Attachment staging requires a resolved request principal.',
        );
      }
      if (
        stagedAttachments?.length &&
        (!body.conversationId || !body.clientTurnId)
      ) {
        throw new Error(
          'Attachment staging requires the resolved thread and client turn identities.',
        );
      }
      if (stagedAttachments?.length && !deps.hydrateStagedAttachments) {
        throw new Error('Attachment staging is unavailable for this Station.');
      }
      const projectSlug =
        body.target.workspace?.kind === 'project'
          ? body.target.workspace.projectSlug
          : undefined;
      let stagedBinding: { threadId: string; clientTurnId: string } | undefined;
      const foregroundRequest = {
        ...body,
        ...(stagedAttachments?.length
          ? {
              resolveAttachments: (binding) =>
                (() => {
                  stagedBinding = binding;
                  return deps.hydrateStagedAttachments!(
                    principal!,
                    stagedAttachments,
                    binding,
                  );
                })(),
            }
          : body.attachments
            ? { attachments: body.attachments as ChatAttachmentInput[] }
            : {}),
        target: normalizeExecutionTarget(
          body.target,
          !body.target.environment && projectSlug
            ? deps.projectDefaultEnvironment?.(projectSlug)
            : undefined,
        ),
        userId,
        // archive#4075 stage 2: rides alongside `userId` to the ONE
        // production `sendTurn` implementation (station-control-delegation.ts),
        // which stamps it into the dispatch context so the resulting
        // `turn.started` carries the dispatching principal at emit time.
        principal,
        clientOrigin: resolveClientOriginForRequest(c.req.raw),
      } as ForegroundMessageRequest;
      const data = await deps.executeForegroundMessage(foregroundRequest);
      if (!isForegroundDispatchHandle(data)) {
        // The foreground Interface cannot honestly call this accepted without
        // the exact provider turn identity needed for terminal settlement.
        return c.json(
          {
            success: false,
            error:
              'Foreground Agent execution may have started but did not return a provider turn id',
            code: FOREGROUND_MESSAGE_INDETERMINATE_CODE,
            outcome: 'indeterminate',
          },
          409,
        );
      }
      if (stagedAttachments?.length && stagedBinding) {
        deps.acceptStagedAttachments?.(
          principal!,
          stagedAttachments,
          stagedBinding,
        );
      }
      // archive#1897 logging slice 3: bind conversationId/agentSlug/userId
      // on the handle THIS dispatch actually resolved (never the request
      // body's optional `conversationId`, which is absent for a brand-new
      // conversation) so `read_logs?q=<conversationId>` and a
      // `MonitoringEmitter` event correlate on the same field.
      {
        const child = deps.logger.child?.(
          sessionCorrelationBindings({
            conversationId: data.conversationId,
            agentSlug:
              typeof data.target?.id === 'string' ? data.target.id : undefined,
            userId,
          }),
        );
        (child ?? deps.logger).debug('Foreground chat message dispatched', {
          hasAttachments: Boolean(body.attachments?.length),
        });
      }
      return c.json({ success: true, data });
    } catch (error) {
      if (error instanceof ForegroundMessageIndeterminateError) {
        return c.json(
          {
            success: false,
            error: FOREGROUND_MESSAGE_INDETERMINATE_ERROR,
            code: error.code,
            outcome: error.outcome,
            receipt: error.detail.receipt,
            receiptStatus: error.detail.receiptStatus,
            session: error.detail.session,
          },
          409,
        );
      }
      if (error instanceof ForegroundMessageTurnIdentityUnavailableError) {
        return c.json(
          {
            success: false,
            error: FOREGROUND_MESSAGE_INDETERMINATE_ERROR,
            code: error.code,
            outcome: error.outcome,
          },
          409,
        );
      }
      if (isForegroundIndeterminateShape(error)) {
        return c.json(
          {
            success: false,
            error: FOREGROUND_MESSAGE_INDETERMINATE_ERROR,
            code: FOREGROUND_MESSAGE_INDETERMINATE_CODE,
            outcome: 'indeterminate',
          },
          409,
        );
      }
      // A stalled/unreachable server-side mount is temporary infrastructure
      // unavailability, not malformed client input (archive#2552).
      const unreachableWorkspace =
        error instanceof ProjectWorktreeDirectoryError &&
        error.reason === 'unreachable';
      return c.json(
        {
          success: false,
          error: errorMessage(error),
          ...(errorCode(error) ? { code: errorCode(error) } : {}),
        },
        unreachableWorkspace ? 503 : 400,
      );
    }
  };
  app.post('/chat', validate(foregroundMessageSchema), handleForegroundMessage);
  app.post(
    '/chat/delegated',
    validate(delegatedForegroundMessageSchema),
    handleForegroundMessage,
  );
  app.post('/chat/background', validate(foregroundMessageSchema), async (c) => {
    const body = getBody(c);
    c.set('body' as never, { ...body, automaticBackground: true });
    return await handleForegroundMessage(c);
  });

  app.post(
    '/conversations/:conversationId/handoff',
    validate(conversationHandoffSchema),
    async (c) => {
      if (!deps.handoffConversation) {
        return c.json(
          { success: false, error: 'Agent/engine handoff is unavailable' },
          503,
        );
      }
      try {
        const body = getBody(c);
        const { principal, userId } = resolveActorPrincipal(deps, c);
        const data = await deps.handoffConversation({
          ...body,
          target: normalizeExecutionTarget(body.target),
          ...(body.attachments
            ? { attachments: body.attachments as ChatAttachmentInput[] }
            : {}),
          conversationId: param(c, 'conversationId'),
          userId,
          // archive#4075 stage 2 review round 1 (F1): dropped here originally
          // — threaded exactly like /chat above, through
          // executeForegroundMessage/executeExecutionTargetMessage's existing
          // `input.principal` seam, so an explicit engine/Agent handoff's
          // turn.started is attributed at emit time too.
          principal,
          clientOrigin: resolveClientOriginForRequest(c.req.raw),
        });
        if (!isForegroundDispatchHandle(data)) {
          return c.json(
            {
              success: false,
              error:
                'Agent/engine handoff may have started but did not return a provider turn id',
              code: FOREGROUND_MESSAGE_INDETERMINATE_CODE,
              outcome: 'indeterminate',
            },
            409,
          );
        }
        return c.json({ success: true, data });
      } catch (error) {
        if (error instanceof ForegroundMessageIndeterminateError) {
          return c.json(
            {
              success: false,
              error: FOREGROUND_MESSAGE_INDETERMINATE_ERROR,
              code: error.code,
              outcome: error.outcome,
              receipt: error.detail.receipt,
              receiptStatus: error.detail.receiptStatus,
              session: error.detail.session,
            },
            409,
          );
        }
        if (
          error instanceof ForegroundMessageTurnIdentityUnavailableError ||
          isForegroundIndeterminateShape(error)
        ) {
          return c.json(
            {
              success: false,
              error: FOREGROUND_MESSAGE_INDETERMINATE_ERROR,
              code: FOREGROUND_MESSAGE_INDETERMINATE_CODE,
              outcome: 'indeterminate',
            },
            409,
          );
        }
        return c.json(
          {
            success: false,
            error: errorMessage(error),
            ...(errorCode(error) ? { code: errorCode(error) } : {}),
          },
          409,
        );
      }
    },
  );

  app.get(
    '/conversations/:conversationId/handoffs/:idempotencyKey',
    async (c) => {
      const data = await orchestrationService.readConversationHandoffStatus(
        param(c, 'conversationId'),
        param(c, 'idempotencyKey'),
        readAuthorityFor(c),
      );
      if (!data) {
        return c.json(
          { success: false, error: 'Conversation handoff not found' },
          404,
        );
      }
      return c.json({ success: true, data });
    },
  );

  app.post(
    '/conversations/:conversationId/context-boundary',
    validate(conversationContextBoundarySchema),
    async (c) => {
      if (!deps.reserveConversationContextBoundary)
        return c.json(
          {
            success: false,
            error: 'Conversation context boundary is unavailable',
          },
          503,
        );
      try {
        const { principal } = resolveActorPrincipal(deps, c);
        const data = await deps.reserveConversationContextBoundary({
          ...getBody(c),
          conversationId: param(c, 'conversationId'),
          actorId: principal!.id,
          clientOrigin: resolveClientOriginForRequest(c.req.raw),
        });
        return c.json({ success: true, data });
      } catch (error) {
        if (error instanceof ConversationContextBoundaryNotFoundError) {
          return c.json(
            {
              success: false,
              error: 'Conversation context boundary not found',
            },
            404,
          );
        }
        return c.json({ success: false, error: errorMessage(error) }, 409);
      }
    },
  );

  app.get(
    '/conversations/:conversationId/context-boundary/:idempotencyKey',
    async (c) => {
      const data = await deps.readConversationContextBoundary?.(
        param(c, 'conversationId'),
        param(c, 'idempotencyKey'),
        readAuthorityFor(c),
      );
      return data
        ? c.json({ success: true, data })
        : c.json(
            {
              success: false,
              error: 'Conversation context boundary not found',
            },
            404,
          );
    },
  );

  app.delete(
    '/conversations/:conversationId/context-boundary/:idempotencyKey',
    async (c) => {
      const data = await deps.cancelConversationContextBoundary?.(
        param(c, 'conversationId'),
        param(c, 'idempotencyKey'),
        readAuthorityFor(c),
      );
      return data
        ? c.json({ success: true, data })
        : c.json(
            {
              success: false,
              error: 'Conversation context boundary cannot be cancelled',
            },
            409,
          );
    },
  );

  app.post(
    '/chat/:conversationId/continue',
    validate(continueForegroundMessageSchema),
    async (c) => {
      if (!deps.continueForegroundMessage) {
        return c.json(
          {
            success: false,
            error: 'Foreground Agent continuation is unavailable',
          },
          503,
        );
      }
      try {
        const body = getBody(c);
        const { principal, userId } = resolveActorPrincipal(deps, c);
        const data = await deps.continueForegroundMessage({
          ...body,
          ...(body.environment
            ? {
                environment:
                  body.environment.kind === 'saved'
                    ? {
                        kind: 'saved' as const,
                        id: environmentId(body.environment.id),
                      }
                    : { kind: 'current' as const },
              }
            : {}),
          conversationId: param(c, 'conversationId'),
          userId,
          // archive#4075 stage 2 review round 1 (F1, HIGH): this is the
          // PRIMARY send path after session start (the composer's own
          // mutation) — dropped here originally, meaning most ordinary
          // turns got no attribution. Threaded exactly like /chat above,
          // through continueForegroundMessage/continueExecutionTargetMessage's
          // existing `input.principal` seam (`...input` spread already
          // forwards it — station-control-delegation.ts's
          // `continueExecutionTargetMessage`).
          principal,
          clientOrigin: resolveClientOriginForRequest(c.req.raw),
        });
        if (!isForegroundDispatchHandle(data)) {
          return c.json(
            {
              success: false,
              error:
                'Foreground Agent continuation may have started but did not return a provider turn id',
              code: FOREGROUND_MESSAGE_INDETERMINATE_CODE,
              outcome: 'indeterminate',
            },
            409,
          );
        }
        return c.json({ success: true, data });
      } catch (error) {
        if (error instanceof ForegroundMessageIndeterminateError) {
          return c.json(
            {
              success: false,
              error: FOREGROUND_CONTINUATION_INDETERMINATE_ERROR,
              code: error.code,
              outcome: error.outcome,
              receipt: error.detail.receipt,
              receiptStatus: error.detail.receiptStatus,
              session: error.detail.session,
            },
            409,
          );
        }
        if (error instanceof ForegroundMessageTurnIdentityUnavailableError) {
          return c.json(
            {
              success: false,
              error: FOREGROUND_CONTINUATION_INDETERMINATE_ERROR,
              code: error.code,
              outcome: error.outcome,
            },
            409,
          );
        }
        if (isForegroundIndeterminateShape(error)) {
          return c.json(
            {
              success: false,
              error: FOREGROUND_CONTINUATION_INDETERMINATE_ERROR,
              code: FOREGROUND_MESSAGE_INDETERMINATE_CODE,
              outcome: 'indeterminate',
            },
            409,
          );
        }
        return c.json(
          {
            success: false,
            error: errorMessage(error),
            ...(errorCode(error) ? { code: errorCode(error) } : {}),
          },
          400,
        );
      }
    },
  );

  app.post('/delegations', validate(delegateTaskSchema), async (c) => {
    if (!deps.delegateTask) {
      return c.json(
        { success: false, error: 'Task delegation is unavailable' },
        503,
      );
    }
    try {
      const body = getBody(c);
      const data = await deps.delegateTask({
        ...body,
        target: normalizeExecutionTarget(body.target),
        userId: resolveActorPrincipal(deps, c).userId,
      });
      return c.json({ success: true, data });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: errorMessage(error),
        },
        400,
      );
    }
  });

  app.post(
    '/delegations/options',
    validate(delegationOptionsSchema),
    async (c) => {
      if (!deps.discoverDelegationOptions) {
        return c.json(
          { success: false, error: 'Delegation discovery is unavailable' },
          503,
        );
      }
      try {
        const data = await deps.discoverDelegationOptions(getBody(c));
        return c.json({ success: true, data });
      } catch (error) {
        return c.json({ success: false, error: errorMessage(error) }, 400);
      }
    },
  );

  app.get('/delegations', async (c) => {
    if (!deps.listDelegatedTasks) {
      return c.json(
        { success: false, error: 'Delegated task inventory is unavailable' },
        503,
      );
    }
    const parsed = delegatedTaskListQuerySchema.safeParse({
      environmentId: c.req.query('environmentId'),
      limit: c.req.query('limit'),
    });
    if (!parsed.success) {
      return c.json(
        { success: false, error: 'Invalid delegated task list query' },
        400,
      );
    }
    try {
      const data = await deps.listDelegatedTasks({
        ...parsed.data,
        userId: resolveActorPrincipal(deps, c).userId,
      });
      return c.json({ success: true, data });
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.get('/delegations/:taskId', async (c) => {
    if (!deps.observeDelegatedTask) {
      return c.json(
        { success: false, error: 'Delegated task lookup is unavailable' },
        503,
      );
    }
    const parsed = delegatedTaskQuerySchema.safeParse({
      environmentId: c.req.query('environmentId'),
    });
    if (!parsed.success) {
      return c.json(
        { success: false, error: 'Invalid delegated task query' },
        400,
      );
    }
    try {
      const data = await deps.observeDelegatedTask({
        ...parsed.data,
        taskId: param(c, 'taskId'),
        userId: resolveActorPrincipal(deps, c).userId,
      });
      return c.json({ success: true, data });
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.get('/delegations/:taskId/events', async (c) => {
    if (!deps.observeDelegatedTaskEvents) {
      return c.json(
        {
          success: false,
          error: 'Delegated task event history is unavailable',
        },
        503,
      );
    }
    const parsed = delegatedTaskEventsQuerySchema.safeParse({
      environmentId: c.req.query('environmentId'),
      cursor: c.req.query('cursor'),
      limit: c.req.query('limit'),
    });
    if (!parsed.success) {
      return c.json(
        { success: false, error: 'Invalid delegated task events query' },
        400,
      );
    }
    try {
      const data = await deps.observeDelegatedTaskEvents({
        ...parsed.data,
        taskId: param(c, 'taskId'),
        userId: resolveActorPrincipal(deps, c).userId,
      });
      return c.json({ success: true, data });
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.post(
    '/delegations/:taskId/continue',
    validate(continueDelegatedTaskBodySchema),
    async (c) => {
      if (!deps.continueDelegatedTask) {
        return c.json(
          {
            success: false,
            error: 'Delegated task follow-ups are unavailable',
          },
          503,
        );
      }
      try {
        const data = await deps.continueDelegatedTask({
          ...getBody(c),
          taskId: param(c, 'taskId'),
          userId: resolveActorPrincipal(deps, c).userId,
        });
        return c.json({ success: true, data });
      } catch (error) {
        return c.json({ success: false, error: errorMessage(error) }, 400);
      }
    },
  );

  app.post(
    '/delegations/:taskId/respond',
    validate(respondToDelegatedTaskBodySchema),
    async (c) => {
      if (!deps.respondToDelegatedTaskRequest) {
        return c.json(
          { success: false, error: 'Delegated task responses are unavailable' },
          503,
        );
      }
      try {
        const data = await deps.respondToDelegatedTaskRequest({
          ...getBody(c),
          taskId: param(c, 'taskId'),
          userId: resolveActorPrincipal(deps, c).userId,
        });
        return c.json({ success: true, data });
      } catch (error) {
        return c.json({ success: false, error: errorMessage(error) }, 400);
      }
    },
  );

  app.post(
    '/delegations/:taskId/interrupt',
    validate(interruptDelegatedTaskBodySchema),
    async (c) => {
      if (!deps.interruptDelegatedTask) {
        return c.json(
          { success: false, error: 'Delegated task interrupt is unavailable' },
          503,
        );
      }
      try {
        const data = await deps.interruptDelegatedTask({
          ...getBody(c),
          taskId: param(c, 'taskId'),
          userId: resolveActorPrincipal(deps, c).userId,
        });
        return c.json({ success: true, data });
      } catch (error) {
        return c.json({ success: false, error: errorMessage(error) }, 400);
      }
    },
  );

  app.get('/session-board/projects/:projectSlug', async (c) => {
    try {
      const data = await orchestrationService.listProjectSessionBoard(
        param(c, 'projectSlug'),
        readAuthorityFor(c),
      );
      return c.json({ success: true, data });
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.post(
    '/sessions/:threadId/lifecycle',
    validate(sessionTransitionSchema),
    async (c) => {
      try {
        const body = getBody(c);
        const data = await orchestrationService.sessionLifecycles.transition({
          threadId: param(c, 'threadId'),
          authority: readAuthorityFor(c),
          to: body.state,
          reason: body.reason ?? 'manual_update',
          source: 'user_action',
          message: body.message,
        });
        return c.json({ success: true, data });
      } catch (error) {
        return c.json({ success: false, error: errorMessage(error) }, 400);
      }
    },
  );

  app.get('/runs', async (c) => {
    const data = await orchestrationService.listAgentRuns(readAuthorityFor(c));
    return c.json({ success: true, data });
  });

  app.get('/runs/:runId', async (c) => {
    const data = await orchestrationService.readAgentRun(
      param(c, 'runId'),
      readAuthorityFor(c),
    );
    if (!data) {
      return c.json({ success: false, error: 'Run not found' }, 404);
    }
    return c.json({ success: true, data });
  });

  app.get('/commands/receipts', async (c) => {
    const threadId = c.req.query('threadId');
    const data = orchestrationService.listCommandReceipts(
      readAuthorityFor(c),
      threadId,
    );
    return c.json({ success: true, data });
  });

  app.get('/commands/receipts/:commandId', async (c) => {
    const data = orchestrationService.readCommandReceipt(
      param(c, 'commandId'),
      readAuthorityFor(c),
    );
    if (!data) {
      return c.json(
        { success: false, error: 'Command receipt not found' },
        404,
      );
    }
    return c.json({ success: true, data });
  });

  // Session -> Flow run binding; evidence/exception calls then go through
  // the existing /api/projects/:slug/flow routes with the resolved run id.
  app.get('/sessions/:threadId/flow-run', async (c) => {
    try {
      const data = await orchestrationService.readSessionFlowRun(
        param(c, 'threadId'),
        readAuthorityFor(c),
      );
      if (!data) {
        return c.json(
          { success: false, error: 'No Flow run bound to session' },
          404,
        );
      }
      return c.json({ success: true, data });
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  // archive#2802: a thread's recorded turn checkpoints (read-only; the only
  // route this slice ships). Serves the Station-home index annotated with
  // live object verification (checkpoint-read.ts) — it reads the recorded
  // repo only to verify checkpoint objects exist, never to enumerate
  // anything beyond the thread's own refs. Session read authority gates the
  // thread id exactly as the flow-run route above does, so checkpoint
  // metadata cannot be enumerated cross-user by guessing thread ids.
  app.get('/sessions/:threadId/checkpoints', async (c) => {
    if (!deps.listThreadCheckpoints) {
      return c.json(
        { success: false, error: 'Workspace checkpoints are unavailable' },
        503,
      );
    }
    const threadId = param(c, 'threadId');
    if (
      !orchestrationService.canUserReadSession(threadId, readAuthorityFor(c))
    ) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }
    return c.json({
      success: true,
      data: await deps.listThreadCheckpoints(threadId),
    });
  });

  app.post('/sessions/:threadId/checkpoints/:turnId/restore', async (c) => {
    if (!deps.restoreThreadCheckpoint)
      return c.json(
        {
          success: false,
          error: 'Workspace checkpoint restore is unavailable',
        },
        503,
      );
    const threadId = param(c, 'threadId');
    if (!orchestrationService.canUserReadSession(threadId, readAuthorityFor(c)))
      return c.json({ success: false, error: 'Session not found' }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        confirmed: z.literal(true),
        phase: z.enum(['baseline', 'settle']).default('settle'),
      })
      .safeParse(body);
    if (!parsed.success)
      return c.json(
        { success: false, error: 'Explicit confirmation is required' },
        400,
      );
    try {
      return c.json({
        success: true,
        data: await deps.restoreThreadCheckpoint({
          threadId,
          turnId: param(c, 'turnId'),
          ...parsed.data,
        }),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'restore_failed';
      const status =
        reason === 'checkpoint_missing' || reason === 'checkpoint_pruned'
          ? 404
          : 409;
      return c.json(
        {
          success: false,
          error: 'Workspace checkpoint restore failed',
          reason,
        },
        status,
      );
    }
  });

  app.get('/sessions/:threadId/checkpoint-restores', (c) => {
    if (!deps.listCheckpointRestoreEvents)
      return c.json(
        {
          success: false,
          error: 'Workspace checkpoint restore audit is unavailable',
        },
        503,
      );
    const threadId = param(c, 'threadId');
    if (!orchestrationService.canUserReadSession(threadId, readAuthorityFor(c)))
      return c.json({ success: false, error: 'Session not found' }, 404);
    return c.json({
      success: true,
      data: deps.listCheckpointRestoreEvents(threadId),
    });
  });

  // Session -> Builder run join (archive#189 S4). A separate route from
  // `/flow-run` on purpose: the two runs have independent lifecycles, and a
  // session commonly has one and not the other. 404 means "no Builder run
  // could be joined AND there was nothing to disclose about why" — the
  // resolver returns a body whenever the absence itself is the finding.
  app.get('/sessions/:threadId/builder-run', async (c) => {
    try {
      const data = await orchestrationService.readSessionBuilderRun(
        param(c, 'threadId'),
        readAuthorityFor(c),
      );
      if (!data) {
        return c.json(
          { success: false, error: 'No Builder run joined to session' },
          404,
        );
      }
      return c.json({ success: true, data });
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.get('/sessions/:threadId/events', async (c) => {
    const detail = await orchestrationService.readSession(
      param(c, 'threadId'),
      readAuthorityFor(c),
    );
    if (!detail) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }
    return c.json({ success: true, data: detail.events });
  });

  app.get('/sessions/:threadId/event-page', async (c) => {
    const parsed = sessionEventPageQuerySchema.safeParse({
      afterSequence: c.req.query('afterSequence'),
      limit: c.req.query('limit'),
    });
    if (!parsed.success) {
      return c.json(
        { success: false, error: 'Invalid event page cursor or limit' },
        400,
      );
    }
    const data = await orchestrationService.readSessionEventPage(
      param(c, 'threadId'),
      {
        ...parsed.data,
        authority: readAuthorityFor(c),
      },
    );
    if (!data) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }
    return c.json({ success: true, data });
  });

  app.get('/sessions/:threadId/event-window', async (c) => {
    const parsed = sessionEventWindowQuerySchema.safeParse({
      cursor: c.req.query('cursor'),
      turnLimit: c.req.query('turnLimit'),
    });
    if (!parsed.success)
      return c.json({ success: false, error: 'Invalid event window' }, 400);
    const data = await orchestrationService.readSessionEventWindow(
      param(c, 'threadId'),
      { ...parsed.data, authority: readAuthorityFor(c) },
    );
    if (!data)
      return c.json({ success: false, error: 'Session not found' }, 404);
    return c.json({ success: true, data });
  });

  app.get('/conversations/:conversationId/event-window', async (c) => {
    const parsed = sessionEventWindowQuerySchema.safeParse({
      cursor: c.req.query('cursor'),
      turnLimit: c.req.query('turnLimit'),
    });
    if (!parsed.success)
      return c.json({ success: false, error: 'Invalid event window' }, 400);
    const data = await orchestrationService.readConversationEventWindow(
      param(c, 'conversationId'),
      { ...parsed.data, authority: readAuthorityFor(c) },
    );
    if (!data)
      return c.json({ success: false, error: 'Conversation not found' }, 404);
    return c.json({ success: true, data });
  });

  // Native-SDK chat refresh: the persisted events projected into conversation
  // messages (same shape ACP/internal return), via the shared projection.
  const sessionOutputsUnavailable = (c: Context, status: 404 | 503 = 404) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(
      { success: false, error: 'Session outputs unavailable' },
      status,
    );
  };
  app.get('/sessions/:threadId/outputs', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const parsed = sessionOutputsQuerySchema.safeParse({
      cursor: c.req.query('cursor'),
      limit: c.req.query('limit'),
    });
    if (!parsed.success || deps.isRequestPrincipalCurrent?.(c.req.raw) !== true)
      return sessionOutputsUnavailable(c);
    const sessionId = param(c, 'threadId');
    const authority = readAuthorityFor(c);
    if (!orchestrationService.canUserReadSession(sessionId, authority))
      return sessionOutputsUnavailable(c);
    const outcome = await orchestrationService.sessionOutputs?.list({
      sessionId,
      authority,
      ...parsed.data,
      current: () =>
        deps.isRequestPrincipalCurrent?.(c.req.raw) === true &&
        orchestrationService.canUserReadSession(sessionId, authority),
    });
    if (outcome?.status === 'unavailable')
      return sessionOutputsUnavailable(c, 503);
    if (outcome?.status !== 'found') return sessionOutputsUnavailable(c);
    if (
      deps.isRequestPrincipalCurrent?.(c.req.raw) !== true ||
      !orchestrationService.canUserReadSession(sessionId, authority)
    )
      return sessionOutputsUnavailable(c);
    return c.json({ success: true, data: outcome.page });
  });
  app.post(
    '/sessions/:threadId/outputs/:eventId/inspect',
    validate(sessionOutputInspectSchema),
    async (c) => {
      c.header('Cache-Control', 'private, no-store');
      if (deps.isRequestPrincipalCurrent?.(c.req.raw) !== true)
        return sessionOutputsUnavailable(c);
      const sessionId = param(c, 'threadId');
      const authority = readAuthorityFor(c);
      if (!orchestrationService.canUserReadSession(sessionId, authority))
        return sessionOutputsUnavailable(c);
      const outcome = await orchestrationService.sessionOutputs?.inspect({
        sessionId,
        eventId: param(c, 'eventId'),
        authority,
        current: () =>
          deps.isRequestPrincipalCurrent?.(c.req.raw) === true &&
          orchestrationService.canUserReadSession(sessionId, authority),
      });
      if (outcome?.status === 'unavailable')
        return sessionOutputsUnavailable(c, 503);
      if (outcome?.status !== 'found') return sessionOutputsUnavailable(c);
      if (
        deps.isRequestPrincipalCurrent?.(c.req.raw) !== true ||
        !orchestrationService.canUserReadSession(sessionId, authority)
      )
        return sessionOutputsUnavailable(c);
      return c.json({ success: true, data: outcome.inspection });
    },
  );
  const sessionInventoryUnavailable = (c: Context, status: 404 | 503 = 404) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(
      { success: false, error: 'Session inventory unavailable' },
      status,
    );
  };
  app.get('/sessions/:threadId/inventory', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const parsed = sessionInventoryQuerySchema.safeParse({
      scope: c.req.query('scope'),
      turnId: c.req.query('turnId'),
    });
    if (!parsed.success || deps.isRequestPrincipalCurrent?.(c.req.raw) !== true)
      return sessionInventoryUnavailable(c);
    const sessionId = param(c, 'threadId');
    const authority = readAuthorityFor(c);
    if (!orchestrationService.canUserReadSession(sessionId, authority))
      return sessionInventoryUnavailable(c);
    const scope =
      parsed.data.scope === 'current-answer'
        ? {
            kind: 'current-answer' as const,
            sessionId,
            turnId: parsed.data.turnId!,
          }
        : { kind: 'whole-session' as const, sessionId };
    const outcome = await deps.sessionInventory?.read({
      scope,
      authority,
      current: () =>
        deps.isRequestPrincipalCurrent?.(c.req.raw) === true &&
        orchestrationService.canUserReadSession(sessionId, authority),
    });
    if (!outcome || outcome.status === 'unavailable')
      return sessionInventoryUnavailable(c, 503);
    if (
      outcome.status !== 'found' ||
      deps.isRequestPrincipalCurrent?.(c.req.raw) !== true ||
      !orchestrationService.canUserReadSession(sessionId, authority)
    )
      return sessionInventoryUnavailable(c);
    return c.json({ success: true, data: outcome.projection });
  });
  // App reads mint an opaque occurrence before any owner I/O.  This separate
  // POST family intentionally has no GET cache semantics and never accepts a
  // caller-supplied EventStore cursor.
  app.post('/sessions/:threadId/inventory/app-read', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    let occurrenceId: string | undefined;
    const request = c.req.raw;
    const sessionId = param(c, 'threadId');
    const authority = readAuthorityFor(c);
    const callerBinding = deps.callerBindingForRequest?.(request);
    try {
      const negotiated = parseStationSessionInventoryMcpNegotiatedInput(
        await c.req.json(),
      );
      const parsed = negotiated?.input;
      if (
        !parsed ||
        !callerBinding ||
        !deps.sessionInventoryAppRead ||
        parsed.scope.sessionId !== sessionId ||
        parsed.scope.kind === 'kept-in-task'
      )
        return sessionInventoryUnavailable(c, 503);
      const outcome =
        parsed.operation === 'open'
          ? await deps.sessionInventoryAppRead.open({
              version: negotiated!.version,
              scope: parsed.scope,
              routeFamily: 'orchestration',
              callerBinding,
              authority,
              request,
            })
          : await deps.sessionInventoryAppRead.page({
              version: negotiated!.version,
              scope: parsed.scope,
              routeFamily: 'orchestration',
              occurrenceId: parsed.occurrenceId,
              groupId: parsed.groupId,
              continuationToken: parsed.continuationToken,
              callerBinding,
              authority,
              request,
            });
      if (outcome.status !== 'available')
        return sessionInventoryUnavailable(c, 503);
      occurrenceId = outcome.occurrenceId;
      if (
        deps.isRequestPrincipalCurrent?.(request) !== true ||
        !orchestrationService.canUserReadSession(sessionId, authority)
      ) {
        deps.sessionInventoryAppRead.revoke({
          scope: parsed.scope,
          routeFamily: 'orchestration',
          callerBinding,
          occurrenceId,
        });
        return sessionInventoryUnavailable(c, 503);
      }
      return c.json({
        success: true,
        data: outcome.data,
        meta: {
          [negotiated!.version === STATION_SESSION_INVENTORY_MCP_V2_VERSION
            ? 'station.session-inventory-app/v2'
            : 'station.session-inventory-app/v1']: {
            occurrenceId,
            continuations: outcome.continuations,
          },
        },
      });
    } catch {
      if (occurrenceId && callerBinding) {
        try {
          deps.sessionInventoryAppRead?.revoke({
            routeFamily: 'orchestration',
            callerBinding,
            occurrenceId,
          });
        } catch {
          // Preserve an opaque outward failure if best-effort teardown fails.
        }
      }
      return sessionInventoryUnavailable(c, 503);
    }
  });
  app.delete('/sessions/:threadId/inventory/app-read', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const callerBinding = deps.callerBindingForRequest?.(c.req.raw);
    try {
      const body = z
        .object({ occurrenceId: z.string().regex(/^[A-Za-z0-9_-]{24,128}$/) })
        .strict()
        .safeParse(await c.req.json());
      if (!body.success || !callerBinding || !deps.sessionInventoryAppRead)
        return sessionInventoryUnavailable(c, 503);
      // A revoke cannot reveal whether the occurrence existed. Route-family
      // and caller bindings still prevent a direct Session route from
      // consuming a kept-in-task occurrence.
      deps.sessionInventoryAppRead.revoke({
        routeFamily: 'orchestration',
        callerBinding,
        occurrenceId: body.data.occurrenceId,
      });
      return c.json({ success: true });
    } catch {
      return sessionInventoryUnavailable(c, 503);
    }
  });
  app.get('/sessions/:threadId/inventory/groups/:groupId', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const parsed = sessionInventoryPageQuerySchema.safeParse({
      scope: c.req.query('scope'),
      turnId: c.req.query('turnId'),
      continuation: c.req.query('continuation'),
    });
    const groupId = param(c, 'groupId');
    if (
      !parsed.success ||
      !SESSION_INVENTORY_CURRENT_GROUP_IDS.includes(
        groupId as (typeof SESSION_INVENTORY_CURRENT_GROUP_IDS)[number],
      ) ||
      deps.isRequestPrincipalCurrent?.(c.req.raw) !== true
    )
      return sessionInventoryUnavailable(c);
    const sessionId = param(c, 'threadId');
    const authority = readAuthorityFor(c);
    if (!orchestrationService.canUserReadSession(sessionId, authority))
      return sessionInventoryUnavailable(c);
    const scope =
      parsed.data.scope === 'current-answer'
        ? {
            kind: 'current-answer' as const,
            sessionId,
            turnId: parsed.data.turnId!,
          }
        : { kind: 'whole-session' as const, sessionId };
    const outcome = await deps.sessionInventory?.page({
      scope,
      groupId:
        groupId as import('@kontourai/station-contracts/session-inventory').SessionInventoryV2GroupId,
      continuation: parsed.data.continuation,
      authority,
      current: () =>
        deps.isRequestPrincipalCurrent?.(c.req.raw) === true &&
        orchestrationService.canUserReadSession(sessionId, authority),
    });
    if (!outcome || outcome.status === 'unavailable')
      return sessionInventoryUnavailable(c, 503);
    if (
      outcome.status !== 'found' ||
      deps.isRequestPrincipalCurrent?.(c.req.raw) !== true ||
      !orchestrationService.canUserReadSession(sessionId, authority)
    )
      return sessionInventoryUnavailable(c);
    return c.json({ success: true, data: outcome.page });
  });
  app.get('/sessions/:threadId/messages', async (c) => {
    const outcome = await orchestrationService.sessionQueries.read(
      { type: 'conversation', threadId: param(c, 'threadId') },
      readAuthorityFor(c),
    );
    if (outcome.status === 'unavailable') {
      return c.json(
        { success: false, error: 'Session messages unavailable' },
        503,
      );
    }
    const data = outcome.status === 'found' ? outcome.messages : [];
    return c.json({ success: true, data });
  });

  // An answer is addressed by the Session/turn tuple, never by transcript
  // position. The query Module owns both reauthorization and the one ordered
  // event replay, so a denied or missing answer is the same public 404.
  app.get('/sessions/:threadId/turns/:turnId', async (c) => {
    const outcome = await orchestrationService.sessionQueries.readAssistantTurn(
      {
        type: 'assistant-turn',
        threadId: param(c, 'threadId'),
        turnId: param(c, 'turnId'),
      },
      readAuthorityFor(c),
    );
    if (outcome.status === 'unavailable') {
      return c.json(
        { success: false, error: 'Assistant answer unavailable' },
        503,
      );
    }
    if (outcome.status !== 'found') {
      return c.json(
        { success: false, error: 'Assistant answer not found' },
        404,
      );
    }
    return c.json({ success: true, data: outcome });
  });

  app.get('/sessions/:threadId/tool-results/:eventId', async (c) => {
    const threadId = param(c, 'threadId');
    const eventId = param(c, 'eventId');
    // Hosted storage has no tenant-scoped point-read owner. Never fall
    // through to the personal owner merely because a tuple is well formed.
    if (
      deps.hostedTenantRegistry !== undefined ||
      !boundedToolResultId(threadId) ||
      !boundedToolResultId(eventId)
    ) {
      return toolResultUnavailable(c);
    }
    try {
      // A missing current-principal guard is deliberately deny-by-default.
      if (deps.isRequestPrincipalCurrent?.(c.req.raw) !== true)
        return toolResultUnavailable(c);
      const authority = readAuthorityFor(c);
      if (!orchestrationService.canUserReadSession(threadId, authority))
        return toolResultUnavailable(c);
      const outcome =
        await orchestrationService.sessionQueries.readToolResult?.(
          { type: 'tool-result', threadId, eventId },
          authority,
        );
      if (outcome?.status === 'unavailable')
        return toolResultUnavailable(c, 503);
      if (
        outcome?.status !== 'found' ||
        outcome.sessionId !== threadId ||
        outcome.eventId !== eventId ||
        outcome.result.resultId !== eventId
      ) {
        return toolResultUnavailable(c);
      }
      // The final checks are synchronous and adjacent to publication. A
      // revocation during owner I/O therefore withholds without a second read.
      if (
        deps.isRequestPrincipalCurrent?.(c.req.raw) !== true ||
        !orchestrationService.canUserReadSession(threadId, authority)
      ) {
        return toolResultUnavailable(c);
      }
      c.header('Cache-Control', 'private, no-store');
      return c.json({
        success: true,
        data: { sessionId: threadId, eventId, result: outcome.result },
      });
    } catch {
      return toolResultUnavailable(c, 503);
    }
  });

  app.get('/sessions/:threadId/turns/:turnId/narrative/target', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const module = deps.answerNarrativeBindingModule;
    if (!module || deps.isRequestPrincipalCurrent?.(c.req.raw) !== true)
      return c.json({ success: false, error: 'Narrative not found' }, 404);
    const outcome = await orchestrationService.sessionQueries.readAnswerBasis?.(
      {
        type: 'answer-basis',
        threadId: param(c, 'threadId'),
        turnId: param(c, 'turnId'),
      },
      readAuthorityFor(c),
    );
    if (outcome?.status === 'unavailable' || outcome?.status === 'corrupt')
      return c.json({ success: false, error: 'Narrative unavailable' }, 503);
    if (
      outcome?.status !== 'found' ||
      deps.isRequestPrincipalCurrent?.(c.req.raw) !== true
    )
      return c.json({ success: false, error: 'Narrative not found' }, 404);
    try {
      return c.json({
        success: true,
        data: module.readTarget(
          outcome,
          readAuthorityFor(c),
          () => deps.isRequestPrincipalCurrent?.(c.req.raw) === true,
        ),
      });
    } catch (error) {
      return error instanceof AnswerNarrativeUnavailableError
        ? c.json({ success: false, error: 'Narrative unavailable' }, 503)
        : c.json({ success: false, error: 'Narrative not found' }, 404);
    }
  });

  app.put(
    '/sessions/:threadId/turns/:turnId/narrative',
    validate(answerNarrativePutSchema),
    async (c) => {
      c.header('Cache-Control', 'private, no-store');
      const module = deps.answerNarrativeBindingModule;
      const input = parseStationAnswerNarrativePublishInput(getBody(c));
      if (
        !module ||
        !input ||
        deps.isRequestPrincipalCurrent?.(c.req.raw) !== true
      )
        return c.json({ success: false, error: 'Narrative not found' }, 404);
      try {
        return c.json({
          success: true,
          data: await module.publish(
            param(c, 'threadId'),
            param(c, 'turnId'),
            input,
            readAuthorityFor(c),
            () => deps.isRequestPrincipalCurrent?.(c.req.raw) === true,
          ),
        });
      } catch (error) {
        if (error instanceof AnswerNarrativeConflictError)
          return c.json({ success: false, error: 'Narrative conflicts' }, 409);
        if (error instanceof AnswerNarrativeUnavailableError)
          return c.json(
            { success: false, error: 'Narrative unavailable' },
            503,
          );
        return c.json({ success: false, error: 'Narrative not found' }, 404);
      }
    },
  );

  app.delete(
    '/sessions/:threadId/turns/:turnId/narrative',
    validate(answerNarrativeDeleteSchema),
    async (c) => {
      c.header('Cache-Control', 'private, no-store');
      const module = deps.answerNarrativeBindingModule;
      const input = parseStationAnswerNarrativeRemoveInput(getBody(c));
      if (
        !module ||
        !input ||
        deps.isRequestPrincipalCurrent?.(c.req.raw) !== true
      )
        return c.json({ success: false, error: 'Narrative not found' }, 404);
      try {
        return c.json({
          success: true,
          data: await module.remove(
            param(c, 'threadId'),
            param(c, 'turnId'),
            input.expectedRevision,
            readAuthorityFor(c),
            () => deps.isRequestPrincipalCurrent?.(c.req.raw) === true,
          ),
        });
      } catch (error) {
        if (error instanceof AnswerNarrativeConflictError)
          return c.json({ success: false, error: 'Narrative conflicts' }, 409);
        if (error instanceof AnswerNarrativeUnavailableError)
          return c.json(
            { success: false, error: 'Narrative unavailable' },
            503,
          );
        return c.json({ success: false, error: 'Narrative not found' }, 404);
      }
    },
  );

  app.put(
    '/sessions/:threadId/turns/:turnId/assessment',
    validate(answerAssessmentPutSchema),
    async (c) => {
      c.header('Cache-Control', 'private, no-store');
      const module = deps.answerAssessmentModule;
      if (!module || deps.isRequestPrincipalCurrent?.(c.req.raw) !== true)
        return c.json({ success: false, error: 'Assessment not found' }, 404);
      try {
        const data = await module.publish(
          param(c, 'threadId'),
          param(c, 'turnId'),
          getBody(c),
          readAuthorityFor(c),
          () => deps.isRequestPrincipalCurrent?.(c.req.raw) === true,
        );
        return c.json({ success: true, data });
      } catch (error) {
        if (error instanceof AnswerAssessmentConflictError)
          return c.json({ success: false, error: 'Assessment conflicts' }, 409);
        if (error instanceof AnswerAssessmentUnavailableError)
          return c.json(
            { success: false, error: 'Assessment unavailable' },
            503,
          );
        return c.json({ success: false, error: 'Assessment not found' }, 404);
      }
    },
  );

  app.delete(
    '/sessions/:threadId/turns/:turnId/assessment',
    validate(answerAssessmentDeleteSchema),
    async (c) => {
      c.header('Cache-Control', 'private, no-store');
      const module = deps.answerAssessmentModule;
      if (!module || deps.isRequestPrincipalCurrent?.(c.req.raw) !== true)
        return c.json({ success: false, error: 'Assessment not found' }, 404);
      try {
        const data = await module.remove(
          param(c, 'threadId'),
          param(c, 'turnId'),
          getBody(c).expectedRevision,
          readAuthorityFor(c),
          () => deps.isRequestPrincipalCurrent?.(c.req.raw) === true,
        );
        return c.json({ success: true, data });
      } catch (error) {
        if (error instanceof AnswerAssessmentConflictError)
          return c.json({ success: false, error: 'Assessment conflicts' }, 409);
        if (error instanceof AnswerAssessmentUnavailableError)
          return c.json(
            { success: false, error: 'Assessment unavailable' },
            503,
          );
        return c.json({ success: false, error: 'Assessment not found' }, 404);
      }
    },
  );

  app.get('/sessions/:threadId/turns/:turnId/assessment/target', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const module = deps.answerAssessmentModule;
    if (!module || deps.isRequestPrincipalCurrent?.(c.req.raw) !== true)
      return c.json({ success: false, error: 'Assessment not found' }, 404);
    const outcome = await orchestrationService.sessionQueries.readAnswerBasis?.(
      {
        type: 'answer-basis',
        threadId: param(c, 'threadId'),
        turnId: param(c, 'turnId'),
      },
      readAuthorityFor(c),
    );
    if (
      outcome?.status !== 'found' ||
      deps.isRequestPrincipalCurrent?.(c.req.raw) !== true
    )
      return c.json({ success: false, error: 'Assessment not found' }, 404);
    try {
      return c.json({
        success: true,
        data: module.readTarget(
          outcome,
          readAuthorityFor(c),
          () => deps.isRequestPrincipalCurrent?.(c.req.raw) === true,
        ),
      });
    } catch (error) {
      if (error instanceof AnswerAssessmentUnavailableError)
        return c.json({ success: false, error: 'Assessment unavailable' }, 503);
      return c.json({ success: false, error: 'Assessment not found' }, 404);
    }
  });

  app.get('/sessions/:threadId/turns/:turnId/basis', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const sessionId = param(c, 'threadId');
    const authority = readAuthorityFor(c);
    const current = () =>
      deps.isRequestPrincipalCurrent?.(c.req.raw) === true &&
      orchestrationService.canUserReadSession(sessionId, authority);
    const outcome = deps.exactAnswerBasis
      ? await deps.exactAnswerBasis.read({
          sessionId,
          turnId: param(c, 'turnId'),
          authority,
          current,
        })
      : undefined;
    if (outcome?.status === 'unavailable')
      return c.json({ success: false, error: 'Basis unavailable' }, 503);
    if (outcome?.status === 'not-found')
      return c.json({ success: false, error: 'Basis not found' }, 404);
    if (!outcome) {
      const answer =
        await orchestrationService.sessionQueries.readAnswerBasis?.(
          {
            type: 'answer-basis',
            threadId: sessionId,
            turnId: param(c, 'turnId'),
          },
          authority,
        );
      if (
        !answer ||
        answer.status === 'unavailable' ||
        answer.status === 'corrupt'
      )
        return c.json({ success: false, error: 'Basis unavailable' }, 503);
      if (answer.status !== 'found')
        return c.json({ success: false, error: 'Basis not found' }, 404);
      const assessed = deps.answerAssessmentModule
        ? await deps.answerAssessmentModule.readExactAnswerAssessmentWithReviewedSource(
            {
              authorizedAnswer: answer,
              authority,
              current,
            },
          )
        : undefined;
      const narrative = deps.answerNarrativeBindingModule
        ? await deps.answerNarrativeBindingModule.readExactAnswerNarrative({
            authorizedAnswer: answer,
            authority,
            current,
          })
        : undefined;
      const reviewedSource = deps.reviewedSourceBasisResolver
        ? await deps.reviewedSourceBasisResolver.read({
            answer,
            assessment: assessed,
            authority,
            current,
          })
        : undefined;
      if (!current())
        return c.json({ success: false, error: 'Basis not found' }, 404);
      return c.json({
        success: true,
        data: composeAuthorizedSessionAnswerBasis(
          answer,
          assessed?.assessment,
          narrative,
          reviewedSource,
        ),
      });
    }
    if (
      deps.isRequestPrincipalCurrent?.(c.req.raw) !== true ||
      !orchestrationService.canUserReadSession(sessionId, authority)
    )
      return c.json({ success: false, error: 'Basis not found' }, 404);
    return c.json({
      success: true,
      data: outcome.projection,
    });
  });

  app.get('/sessions/:threadId', async (c) => {
    const data = await orchestrationService.readSession(
      param(c, 'threadId'),
      readAuthorityFor(c),
    );
    if (!data) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }
    return c.json({ success: true, data });
  });

  app.get('/processes/terminals', async (c) => {
    // Terminal state is process-global and carries no durable tenant binding.
    // Keep the complete surface unavailable in a hosted deployment until it
    // can be authorized from a tenant-bound terminal record. Do this before
    // looking at the optional service so an unavailable terminal is
    // indistinguishable from an unbound one and no process state is read.
    if (deps.hostedTenantRegistry) {
      return c.json({ success: false, error: 'Terminal not found' }, 404);
    }
    if (!deps.terminalService) {
      return c.json(
        { success: false, error: 'Terminal service unavailable' },
        503,
      );
    }
    return c.json({
      success: true,
      data: deps.terminalService.listProcessSummaries(),
    });
  });

  app.get('/processes/terminals/:sessionId', async (c) => {
    if (deps.hostedTenantRegistry) {
      return c.json({ success: false, error: 'Process not found' }, 404);
    }
    if (!deps.terminalService) {
      return c.json(
        { success: false, error: 'Terminal service unavailable' },
        503,
      );
    }
    const data = deps.terminalService.readProcess(param(c, 'sessionId'));
    if (!data) {
      return c.json({ success: false, error: 'Process not found' }, 404);
    }
    return c.json({ success: true, data });
  });

  app.delete('/processes/terminals/:sessionId', async (c) => {
    if (deps.hostedTenantRegistry) {
      return c.json({ success: false, error: 'Process not found' }, 404);
    }
    if (!deps.terminalService) {
      return c.json(
        { success: false, error: 'Terminal service unavailable' },
        503,
      );
    }
    await deps.terminalService.close(param(c, 'sessionId'));
    return c.json({
      success: true,
      data: { sessionId: param(c, 'sessionId') },
    });
  });

  app.post(
    '/commands',
    validate(orchestrationCommandSchema, {
      maxBodyBytes: CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES,
    }),
    async (c) => {
      const command = getBody(c);
      // Resolved once and reused for both the read authority below and the
      // dispatch context further down, rather than calling
      // `readAuthorityFor(c)` a second time — `resolveActorPrincipal` is the
      // single fail-closed resolution point (archive#4075 stage 2).
      const { principal, userId: actorUserId } = resolveActorPrincipal(deps, c);
      const readAuthority = sessionReadAuthorityFromRequest(
        actorUserId,
        getTenantRequestContext(c.req.raw),
        deps.hostedTenantRegistry,
      );
      const actionOperationActor = actionOperationActorForRequest(
        c.req.raw,
        readAuthority,
        (sessionId) =>
          orchestrationService.canUserReadSession(sessionId, readAuthority),
      );
      const actionOperation =
        command.type === 'adoptSession'
          ? await beginActionOperationTracking({
              service: deps.actionOperations,
              actor: actionOperationActor,
              ...(deps.logger.warn
                ? {
                    logger: {
                      warn: (message: string, meta?: Record<string, unknown>) =>
                        deps.logger.warn?.(message, meta),
                    },
                  }
                : {}),
              operation: {
                id: handoffActionOperationId({
                  accountId: actionOperationActor.accountId,
                  sourceSessionId: command.sourceThreadId,
                  ...(command.idempotencyKey
                    ? { idempotencyKey: command.idempotencyKey }
                    : {}),
                }),
                scope: {
                  accountId: actionOperationActor.accountId,
                  sessionId: command.sourceThreadId,
                },
                title: 'Continue attached session',
                cancellation: 'unsupported',
                domain: {
                  kind: 'session-handoff',
                  sourceSessionId: command.sourceThreadId,
                },
                reentry: {
                  kind: 'session',
                  sessionId: command.sourceThreadId,
                },
              },
            })
          : undefined;
      try {
        await actionOperation?.update({
          status: 'running',
          progress: { kind: 'phase', code: 'creating-continuation' },
        });
        const result = await orchestrationService.dispatchWithReceipt(command, {
          userId: actorUserId,
          // archive#4075 stage 2: this is the STEER path's attribution
          // seam — `dispatchWithReceipt`'s `steerTurn` case wraps
          // `adapter.steerTurn` in the same begin/settle propagation
          // `sendTurn` uses, so the steering caller's principal lands on
          // the adapter-emitted `turn.started (inputKind:'steer')` at
          // emit time.
          principal,
          tenantExecutionContext: tenantExecutionContextForRequest(c.req.raw),
          clientOrigin: resolveClientOriginForRequest(c.req.raw),
        });
        if (actionOperation && command.type === 'adoptSession') {
          const targetSessionId =
            typeof result.result === 'object' &&
            result.result !== null &&
            typeof (result.result as { threadId?: unknown }).threadId ===
              'string'
              ? (result.result as { threadId: string }).threadId
              : undefined;
          await actionOperation.update({
            status: 'succeeded',
            ...(targetSessionId
              ? {
                  domain: {
                    kind: 'session-handoff' as const,
                    sourceSessionId: command.sourceThreadId,
                    targetSessionId,
                  },
                  reentry: {
                    kind: 'session' as const,
                    sessionId: targetSessionId,
                  },
                }
              : {}),
          });
        }
        return c.json({
          success: true,
          data: result.result ?? null,
          receipt: result.receipt,
          ...(result.receiptStatus
            ? { receiptStatus: result.receiptStatus }
            : {}),
        });
      } catch (error) {
        const indeterminate = isForegroundIndeterminateShape(error);
        const reconciliationNeeded =
          command.type === 'adoptSession' &&
          (indeterminate ||
            error instanceof AdoptionContinuationInProgressError ||
            (error instanceof OrchestrationCommandDispatchError &&
              error.indeterminateSession !== undefined));
        await actionOperation?.update(
          reconciliationNeeded
            ? {
                status: 'running',
                progress: {
                  kind: 'phase',
                  code: 'reconciliation-required',
                },
              }
            : {
                status: 'failed',
                errorSummary: 'Session continuation could not be completed.',
              },
        );
        return c.json(
          {
            success: false,
            error: indeterminate
              ? FOREGROUND_MESSAGE_INDETERMINATE_ERROR
              : errorMessage(error),
            ...(indeterminate
              ? {
                  code: FOREGROUND_MESSAGE_INDETERMINATE_CODE,
                  outcome: 'indeterminate' as const,
                }
              : {}),
            ...(error instanceof AdoptionContinuationInProgressError
              ? { code: error.code, retryable: error.retryable }
              : {}),
            ...(error instanceof OrchestrationCommandDispatchError
              ? {
                  receipt: error.receipt,
                  receiptStatus: error.receiptStatus,
                  ...(error.code
                    ? { code: error.code, retryable: error.retryable }
                    : {}),
                  ...(error.indeterminateSession
                    ? {
                        outcome: 'indeterminate',
                        session: error.indeterminateSession,
                      }
                    : {}),
                }
              : {}),
          },
          error instanceof AdoptionContinuationInProgressError || indeterminate
            ? 409
            : 400,
        );
      }
    },
  );

  // archive#1205: this is the ownership-gated orchestration event stream —
  // every frame (live and replay) passes through
  // `orchestrationService.canUserReadSession` below. There is a sibling,
  // UNGATED broadcast route at the bare `/events` mount
  // (`createEventRoutes` in `./events.ts`, mounted in `runtime-routes.ts`)
  // that deliberately does NOT relay `SERVER_EVENTS.ORCHESTRATION_EVENT` at
  // all, specifically so it can never duplicate (and diverge from) this
  // gate. If you change what this route forwards or how it authorizes,
  // check whether `./events.ts`'s file-header note still holds.
  app.get('/events', (c) => {
    // Optional per-session filter: `?threadId=` narrows the stream to one
    // session's events for a focused live feed (e.g. the Sessions view).
    // Absent, the stream stays the all-sessions feed the app already consumes.
    const threadId = c.req.query('threadId');
    // archive#4075 stage 3 slice 2: resolved directly here (not via
    // `readAuthorityFor(c)`, which discards the `principal` half) so the
    // ALREADY-resolved stage-2 `PrincipalRef` can be retained on the
    // presence registration below — never re-resolved. Same
    // resolve-once-reuse-twice pattern as the `sendTurn`/`steerTurn`
    // dispatch handler above.
    const { principal, userId: actorUserId } = resolveActorPrincipal(deps, c);
    const authority = sessionReadAuthorityFromRequest(
      actorUserId,
      getTenantRequestContext(c.req.raw),
      deps.hostedTenantRegistry,
    );
    // archive#1092: a reconnecting `fetchSSE` client already retains and
    // resends this header. A cursor-less connect (the only case pre-#1092
    // clients or a first-ever connect produce) always takes the snapshot
    // path below, byte-identical to the prior behavior (AC4).
    const cursor = parseResumeCursor(c.req.header('Last-Event-ID'));
    return streamSSE(c, async (stream) => {
      sseOps.add(1, {
        op: threadId ? 'orchestration_connect_thread' : 'orchestration_connect',
      });
      // archive#1848: taken before anything can `await`, and paired with the
      // record in `finally` below, so the recorded span always covers this
      // connection's whole life — including a setup-time throw, which is
      // exactly the short-lived case a rate problem looks like.
      const connectedAt = Date.now();
      // archive#1225: register this connection with the presence tracker
      // BEFORE anything else can `await` — the push-on-completion gate
      // (`turn-completion-notifications.ts`) must never see a window where
      // a client that is in fact connecting is reported as absent.
      const presenceSubject =
        orchestrationStreamPresenceSubjectFromAuthority(authority);
      const releasePresence = presenceSubject
        ? presence.connect(presenceSubject, principal)
        : () => {};
      orchestrationStreamPresenceOps.add(1, { op: 'connect' });

      // archive#1225 review (HIGH): `unsub`/`keepAlive` are declared here
      // (not `const` at their original call sites) and the whole setup below
      // through the abort-wait runs inside the `try` below, so `finally` can
      // always release this connection's presence/subscription/timer no
      // matter WHERE an exception originates — including a throw from any
      // of the unguarded event-store reads below
      // (`readEventStreamHead`/`readEventStreamReplay`/
      // `listSessionReadModel`). Hono's `streamSSE` only ever calls
      // `stream.close()` in its own outer `finally` on an uncaught throw; it
      // has no idea this route registered presence/eventBus state that also
      // needs releasing. Without this, a setup-time throw would leak this
      // user's presence count forever — `isConnected(userId)` would stay
      // `true` and silently disable push-on-completion for that user for
      // the rest of the process lifetime.
      let unsub: (() => void) | undefined;
      let keepAlive: ReturnType<typeof setInterval> | undefined;
      try {
        // Ordering fence (R4): subscribe and buffer live events FIRST, before
        // any `await` below can yield to an event that was appended and
        // emitted concurrently. Nothing buffered here is written until after
        // the historical (replay-or-snapshot) frames and the caught-up marker
        // are flushed, so a live event can never overtake buffered history.
        let caughtUp = false;
        const pending: Array<{ event: string; data: string; id?: string }> = [];
        const forward = (frame: {
          event: string;
          data: string;
          id?: string;
        }) => {
          if (caughtUp) {
            stream.writeSSE(frame).catch(() => {});
          } else {
            pending.push(frame);
          }
        };
        unsub = deps.eventBus.subscribe((evt) => {
          if (
            evt.event === SERVER_EVENTS.ORCHESTRATION_SESSION_PROJECTION_UPDATED
          ) {
            const updatedThreadId = (
              evt.data as { threadId?: unknown } | undefined
            )?.threadId;
            if (
              typeof updatedThreadId !== 'string' ||
              (threadId !== undefined && updatedThreadId !== threadId) ||
              !orchestrationService.canUserReadSession(
                updatedThreadId,
                authority,
              )
            )
              return;
            // archive#4054: a watchdog observation is deliberately not a
            // synthetic canonical event. Its owner still wakes the same
            // session query reactively so Home clears the indicator on the
            // next watchdog progress event without polling or re-deriving.
            forward({
              event: SERVER_EVENTS.ORCHESTRATION_SESSION_PROJECTION_UPDATED,
              data: JSON.stringify({ threadId: updatedThreadId }),
            });
            return;
          }
          if (evt.event !== SERVER_EVENTS.ORCHESTRATION_EVENT) return;
          if (!orchestrationEventMatchesThread(evt.data, threadId)) return;
          const eventPayload = (
            evt.data as
              | { event?: { threadId?: string; eventId?: string } }
              | undefined
          )?.event;
          const eventThreadId = eventPayload?.threadId;
          if (
            !eventThreadId ||
            !orchestrationService.canUserReadSession(eventThreadId, authority)
          )
            return;
          const globalSequence = eventPayload?.eventId
            ? orchestrationService.readEventGlobalSequence(eventPayload.eventId)
            : undefined;
          forward({
            event: SERVER_EVENTS.ORCHESTRATION_EVENT,
            data: JSON.stringify(evt.data ?? {}),
            ...(globalSequence !== undefined
              ? { id: String(globalSequence) }
              : {}),
          });
        });

        const head = orchestrationService.readEventStreamHead();
        // Thread-scoped gap fix (review finding, post-merge HIGH): for a
        // `threadId`-scoped connection, decide using this thread's own missed
        // count, not the cross-thread `head - cursor` gap — huge traffic on
        // some OTHER thread must never force this thread's reconnect onto the
        // snapshot path. The bounded query below both answers that question
        // AND, when the decision comes out `replay`, IS the replay data — no
        // second query.
        let threadReplayCandidateCount: number | undefined;
        if (threadId !== undefined && cursor !== undefined && cursor <= head) {
          // archive#1197: `userId` gates each candidate the same way the live
          // path's `canUserReadSession` call does (below) — a reconnecting
          // client must not replay another user's thread history.
          threadReplayCandidateCount =
            orchestrationService.readEventStreamReplayPlan(
              cursor,
              {
                threadId,
                limit: ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD + 1,
                maxSerializedBytes:
                  ORCHESTRATION_STREAM_REPLAY_MAX_SERIALIZED_BYTES,
              },
              authority,
            ).count;
        }
        const plan = resolveStreamResumePlan(
          cursor,
          head,
          threadReplayCandidateCount,
        );
        orchestrationStreamResumeDecisions.add(1, {
          decision: plan.decision,
          reason: plan.reason,
          scope: threadId ? 'thread' : 'all',
        });
        if (plan.gap !== undefined) {
          orchestrationStreamResumeGap.record(plan.gap);
        }

        // The advertised resume cursor for the snapshot/caught-up frames.
        // Starts at `head` (computed above, before any `await`) and is
        // refined below if the snapshot branch runs — see that branch.
        let resolvedHead = head;

        if (plan.decision === 'replay') {
          const replayBudget = orchestrationService.readEventStreamReplayPlan(
            cursor as number,
            {
              ...(threadId ? { threadId } : {}),
              limit: ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD + 1,
              maxSerializedBytes:
                ORCHESTRATION_STREAM_REPLAY_MAX_SERIALIZED_BYTES,
            },
            authority,
          );
          if (!replayBudget.fitsBudget) {
            const sessions =
              await orchestrationService.listSessionReadModel(authority);
            resolvedHead = orchestrationService.readEventStreamHead();
            await stream.writeSSE({
              event: 'orchestration:snapshot',
              data: JSON.stringify({ sessions }),
              id: String(resolvedHead),
            });
          } else {
            const replayed = orchestrationService.readEventStreamReplay(
              cursor as number,
              {
                ...(threadId ? { threadId } : {}),
                limit: ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD + 1,
              },
              authority,
            );
            for (const persisted of replayed) {
              const data = JSON.stringify({
                event: persisted.payload,
                ...orchestrationService.replayTurnProvenanceSidecar(
                  persisted.payload,
                ),
              });
              await stream.writeSSE({
                event: SERVER_EVENTS.ORCHESTRATION_EVENT,
                // archive#1410 (D2): a turn that completed while this client
                // was disconnected is delivered ONLY here — the live publish
                // already happened, and nothing on this path triggers a REST
                // refetch — so the replayed frame must carry the same
                // provenance sibling the live frame did, or that turn's card
                // stays missing until the next remount.
                data,
                id: String(persisted.globalSequence),
              });
            }
          }
        } else {
          const sessions =
            await orchestrationService.listSessionReadModel(authority);
          // LOW (review): `head` was read before the `await` above — another
          // await-yielding-tick's worth of appends could have landed by now.
          // Re-reading here costs one more (cheap, indexed MAX) query and
          // makes the advertised cursor exact rather than merely safe: a
          // stale-but-safe cursor still works correctly (anything newer is
          // buffered and delivered live, see below), but an exact one gives a
          // reconnecting client a tighter future resume point.
          resolvedHead = orchestrationService.readEventStreamHead();
          await stream.writeSSE({
            event: 'orchestration:snapshot',
            data: JSON.stringify({ sessions }),
            id: String(resolvedHead),
          });
        }

        // Ordering-safe completion marker (R4): delivered through the exact
        // same `stream.writeSSE` call path as every other frame, so it cannot
        // be reordered relative to what came before or after it.
        await stream.writeSSE({
          event: ORCHESTRATION_STREAM_CAUGHT_UP_EVENT,
          data: '{}',
          id: String(resolvedHead),
        });
        caughtUp = true;
        for (const frame of pending) {
          await stream.writeSSE(frame);
        }

        keepAlive = setInterval(() => {
          stream.writeSSE({ event: 'ping', data: '' }).catch(() => {});
        }, SSE_KEEPALIVE_INTERVAL_MS);

        try {
          await new Promise((_, reject) => {
            stream.onAbort(() => reject(new Error('aborted')));
          });
        } catch (error) {
          deps.logger.debug('Orchestration SSE client disconnected', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        // archive#1225 review (HIGH): this ALWAYS runs — a throw anywhere
        // above (setup, replay/snapshot writes, the abort-wait) still
        // releases this connection's timer/subscription/presence exactly
        // once, instead of leaking them only on the happy path. `unsub`
        // being `undefined` (a throw before `deps.eventBus.subscribe` ran)
        // or `keepAlive` being `undefined` (a throw before it was created)
        // are both handled explicitly rather than relying on
        // `clearInterval(undefined)`/calling an unset function.
        if (keepAlive !== undefined) clearInterval(keepAlive);
        unsub?.();
        releasePresence();
        orchestrationStreamPresenceOps.add(1, { op: 'disconnect' });
        orchestrationStreamDuration.record(Date.now() - connectedAt, {
          scope: threadId ? 'thread' : 'all',
        });
      }
    });
  });

  /**
   * archive#4075 stage 3 slice 2: the session-agnostic "who's connected"
   * roster — the piece the stage-3 pre-implementation map identified as
   * genuinely missing (Task-scoped room presence can't supply it; archive#2892
   * remains a separate open AC). Reads the SAME `presence` registry the
   * `/events` route above registers into, so it is derived only from
   * genuinely open SSE connections — no client heartbeat, no self-report,
   * no invented TTL. Principal ids only in this slice: no display/alias
   * surface (a later slice's concern, per the pre-implementation map), and
   * no session/thread enumeration.
   *
   * Hosted/tenant: multi-tenant rosters are Track-3/post-gate (deliberate
   * sequencing, not a gap — the pre-implementation map's slice-3 note).
   * This 404s a hosted caller with the SAME signal `readAuthorityFor`
   * above already uses to detect hosted mode
   * (`deps.hostedTenantRegistry !== undefined`) — the identical mechanism
   * `/api/live-activity` uses (`createLiveActivityRoutes`'s
   * `deps.hosted?.()`, wired from `isHostedTenantExecutionRequired` in
   * `runtime-routes.ts`) and `/api/client-presence/summary`'s
   * `clientPresenceAvailable: hostedTenantRegistry === undefined` wiring —
   * rather than inventing a second hosted-detection path for this route.
   */
  app.get('/presence/summary', (c) => {
    if (deps.hostedTenantRegistry !== undefined) {
      return c.json({ error: 'unavailable' }, 404);
    }
    const principals = presence.roster().map((entry) => ({
      id: entry.principal.id,
      kind: entry.principal.kind,
      connections: entry.connections,
    }));
    return c.json({ principals, observedAt: Date.now() });
  });

  return app;
}

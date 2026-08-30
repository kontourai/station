import { parseEngineConnectionId } from '@kontourai/station-contracts/agent-identity';
import { validateChatInputFileParts } from '@kontourai/station-contracts/chat-attachment';
import {
  isSafeToolServerCredentialKey,
  isSafeToolServerId,
} from '@kontourai/station-contracts/tool';
import { z } from 'zod/v3';
import {
  CHAT_INPUT_MAX_CHARS,
  CHAT_INPUT_TOOL_PART_MAX_CHARS,
  chatInputSize,
  collectChatInputFileParts,
} from '../../../../src-shared/chat-input-limits.js';
import { chatInputLimitRefusals } from '../../../telemetry/metrics.js';

// ACP
export const acpConnectionSchema = z.object({
  id: z
    .string()
    .refine((value) => parseEngineConnectionId(value) !== undefined, {
      message:
        'must be a clean engine identity using lowercase letters, digits, and hyphens',
    }),
  command: z.string().min(1),
  name: z.string().optional(),
  args: z.array(z.string()).optional(),
  icon: z.string().optional(),
  cwd: z.string().optional(),
  enabled: z.boolean().optional(),
  /**
   * Explicit opt-in (docs/design/connections-onboarding.md §5): ids of
   * Station tool servers to pass through to this connection's ACP sessions.
   * Absent/empty ⇒ off (the default) — see ACPConnectionConfig. Each id is
   * validated with the SAME safety-only rule storage uses
   * (`isSafeToolServerId` — rejects path separators, `.`, `..`, empty, and
   * dangerous object keys), not an aesthetic naming pattern: a legacy on-disk integration id
   * may contain dots/uppercase, and a user must still be able to opt a real,
   * already-installed tool server into passthrough. The array must not
   * contain duplicates. This value ultimately joins into a filesystem path
   * (`config-loader-storage.ts`'s load/save/deleteIntegrationConfig) and is
   * re-validated defensively there too — this schema check is the first
   * line of defense, not the only one.
   */
  provideToolServers: z
    .array(
      z.string().refine(isSafeToolServerId, {
        message: 'must not be empty, ".", "..", or contain a path separator',
      }),
    )
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'provideToolServers must not contain duplicate ids',
    })
    .optional(),
});

// App-home profiles (archive#896, docs/design/agent-engine-unification.md §6.1's
// overlay model). `includeCredentials` is the explicit opt-in checkbox —
// absent/false ⇒ credentials are never copied (never inferred).
export const appHomeImportRequestSchema = z.object({
  includeCredentials: z.boolean().optional(),
});

// Credential-profile recovery is deliberately management-only: the opaque
// ref selects a Station-owned hashed app-home directory, never a user path.
// Keep this validation aligned with the registry's defensive normalizer so a
// rejected request cannot become a directory name, telemetry attribute, or
// provider argument further down the stack.
const credentialProfileText = (field: 'ref' | 'label') =>
  z
    .string()
    .trim()
    .min(1)
    .max(256)
    .refine(
      (value) =>
        ![...value].some((character) => {
          const code = character.charCodeAt(0);
          return code <= 0x1f || code === 0x7f;
        }),
      {
        message: `${field} must not contain control characters`,
      },
    );

export const credentialProfileRefSchema = credentialProfileText('ref').refine(
  (value) => value !== '.' && value !== '..' && !/[\\/]/.test(value),
  { message: 'ref must not be a path' },
);

export const credentialProfileUpsertRequestSchema = z.object({
  ref: credentialProfileRefSchema,
  label: credentialProfileText('label').optional(),
});

export const credentialProfileEnrollmentRequestSchema = z.object({
  enrolled: z.boolean(),
});

export const credentialRecoveryPolicyRequestSchema = z.object({
  automatic: z.boolean(),
});

export const credentialProfileImportRequestSchema = z.object({
  includeCredentials: z.boolean().optional(),
});

export const credentialProfileApplyRequestSchema = z.object({
  // Applying a profile sends one bounded provider turn. `true` is a separate
  // literal so omitted/false confirmation never reaches the service seam.
  confirmed: z.literal(true),
  timeoutMs: z.number().int().min(5_000).max(60_000).optional(),
});

// Integrations
export const integrationSchema = z.object({
  id: z.string().refine(isSafeToolServerId, {
    message:
      'invalid tool-server id: empty, path-like, and dangerous keys (__proto__, constructor, prototype) are not allowed',
  }),
  enabled: z.boolean().optional(),
  disabledTools: z.array(z.string()).optional(),
  kind: z.string().optional(),
  transport: z.enum(['stdio', 'sse', 'streamable-http']).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  endpoint: z.string().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  /** A glyph or bounded relative local raster path. Remote URLs never render. */
  icon: z.string().max(240).optional(),
  env: z
    .unknown()
    .refine(
      (value) =>
        Boolean(
          value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.keys(value).every(isSafeToolServerCredentialKey),
        ),
      {
        message:
          'invalid tool-server env name: empty, path-like, and dangerous keys (__proto__, constructor, prototype) are not allowed',
      },
    )
    .pipe(z.record(z.string(), z.string()))
    .optional(),
  secretEnv: z
    .unknown()
    .refine(
      (value) =>
        Boolean(
          value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.keys(value).every(isSafeToolServerCredentialKey),
        ),
      {
        message:
          'invalid tool-server env name: empty, path-like, and dangerous keys (__proto__, constructor, prototype) are not allowed',
      },
    )
    .pipe(z.record(z.string(), z.string()))
    .optional(),
  // `secretEnvRefs` is deliberately absent: raw integration JSON cannot
  // create grants or binding references. The structured operator bind/unbind
  // flow is the only writer.
  removeSecretEnvKeys: z
    .array(z.string().refine(isSafeToolServerCredentialKey))
    .optional(),
  timeouts: z
    .object({
      startupMs: z.number().optional(),
      requestMs: z.number().optional(),
    })
    .optional(),
  healthCheck: z
    .object({
      kind: z.enum(['jsonrpc', 'http', 'command']).optional(),
      path: z.string().optional(),
      intervalMs: z.number().optional(),
    })
    .optional(),
});
export const integrationEnabledSchema = z.object({ enabled: z.boolean() });
export const integrationToolsApplySchema = z.object({
  disabledTools: z.array(z.string()),
});

// Agent tools
export const addToolSchema = z.object({ toolId: z.string().min(1) });
export const updateAllowedSchema = z.object({ allowed: z.array(z.string()) });
// Unattended exact-tool grants (archive#2037). The HTTP boundary rejects blank
// values early; the store repeats the same validation for direct callers.
export const unattendedGrantMutationSchema = z.object({
  principalKey: z.string().trim().min(1),
  toolName: z.string().trim().min(1),
});

// Invoke
export const MODEL_SELECTOR_MAX_LENGTH = 512;
export const modelSelectorSchema = z
  .string()
  .min(1)
  .max(MODEL_SELECTOR_MAX_LENGTH);

// archive#2807: the turn-starting text fields on the invoke routes derive
// their size bound from the same declared prompt maximum as chatSchema below.
// Tool-carried text (a tool part's `input`/`output`) is sized against its own
// declared budget, CHAT_INPUT_TOOL_PART_MAX_CHARS, inside chatSchema — two
// budgets, two constants, both declared in src-shared/chat-input-limits.ts.
export const invokeSchema = z.object({
  input: z.string().max(CHAT_INPUT_MAX_CHARS),
  model: modelSelectorSchema.optional(),
  tools: z.array(z.string()).optional(),
  schema: z.any().optional(),
});

export const invokeStreamSchema = z.object({
  prompt: z.string().max(CHAT_INPUT_MAX_CHARS),
  model: modelSelectorSchema.optional(),
  tools: z.array(z.string()).optional(),
  maxSteps: z.number().int().nonnegative().optional(),
  schema: z.any().optional(),
});

export const toolApprovalSchema = z.object({ approved: z.boolean() });

export const globalInvokeSchema = z.object({
  prompt: z.string().max(CHAT_INPUT_MAX_CHARS),
  schema: z.any().optional(),
  tools: z.array(z.string()).optional(),
  maxSteps: z.number().int().nonnegative().optional(),
  model: modelSelectorSchema.optional(),
  structureModel: modelSelectorSchema.optional(),
  system: z.string().max(CHAT_INPUT_MAX_CHARS).optional(),
});

// Chat
export const chatSchema = z.object({
  // archive#2807: refuse an oversized prompt at the validate() boundary,
  // before any provider/engine work. The message names the actual size AND
  // the limit so a client can compute the overage without guessing. Sizing
  // handles every accepted shape and FAILS CLOSED on unrecognized ones (see
  // chatInputSize); `z.any()`'s permissive passthrough is otherwise
  // unchanged. Refusals are counted (chatInputLimitRefusals) so how often
  // the bound fires is observable.
  input: z.any().superRefine((value, ctx) => {
    const size = chatInputSize(value);
    if (!size.recognized) {
      chatInputLimitRefusals.add(1, { reason: 'unrecognized_shape' });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Message shape is not recognized, so its size cannot be verified (refused). Send input as a plain string, or as an array of messages carrying text in parts[] or content.',
      });
      return;
    }
    if (size.length > CHAT_INPUT_MAX_CHARS) {
      chatInputLimitRefusals.add(1, { reason: 'over_limit' });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Message is ${size.length} characters, which is ${
          size.length - CHAT_INPUT_MAX_CHARS
        } over the ${CHAT_INPUT_MAX_CHARS}-character limit.`,
      });
      return;
    }
    // archive#2830: tool-carried text gets its own budget, not the authored
    // limit — machine-generated payloads are legitimately larger than a
    // hand-typed prompt. Same fail-closed traversal, second declared
    // constant; without this check a recognized tool part measured zero.
    if (size.toolPayloadLength > CHAT_INPUT_TOOL_PART_MAX_CHARS) {
      chatInputLimitRefusals.add(1, { reason: 'tool_payload_over_limit' });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Tool-part text is ${size.toolPayloadLength} characters, which is ${
          size.toolPayloadLength - CHAT_INPUT_TOOL_PART_MAX_CHARS
        } over the ${CHAT_INPUT_TOOL_PART_MAX_CHARS}-character limit.`,
      });
      return;
    }
    // archive#2828: the size guard above deliberately excludes file-part
    // `url`s, which left inline attachments on THIS route bounded only by the
    // 22 MiB whole-body cap — a 20 MB base64 data URL measured 0 characters
    // and was admitted. The orchestration seam already applied these limits;
    // this route applies the same ones, from the same constants, over the
    // same traversal.
    const attachments = collectChatInputFileParts(value);
    if (!attachments.recognized) {
      chatInputLimitRefusals.add(1, { reason: 'unrecognized_shape' });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Message shape is not recognized, so its attachments cannot be verified (refused).',
      });
      return;
    }
    const attachmentError = validateChatInputFileParts(attachments.parts);
    if (attachmentError) {
      chatInputLimitRefusals.add(1, { reason: 'attachment_rejected' });
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: attachmentError });
    }
  }),
  // Ambient, model-facing context (timezone, geolocation, …) composed into
  // the model input server-side; never part of the persisted user turn.
  ambientContext: z.string().max(4000).optional(),
  options: z
    .object({ model: modelSelectorSchema.optional() })
    .passthrough()
    .optional(),
  projectSlug: z.string().optional(),
});

// Feedback
export const rateSchema = z.object({
  messageIndex: z.number().int().min(0),
  rating: z.enum(['thumbs_up', 'thumbs_down']),
  conversationId: z.string().optional(),
  reason: z.string().optional(),
});

// Provider
export const providerSchema = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
  config: z.record(z.any()),
  enabled: z.boolean().optional(),
  capabilities: z.array(z.string()).optional(),
});

const BEDROCK_AUTH_MODES = ['chain', 'profile', 'api-key'] as const;

export const connectionSchema = z
  .object({
    id: z.string().optional(),
    kind: z.enum(['model', 'agent', 'runtime']),
    type: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    config: z.record(z.any()),
    enabled: z.boolean(),
    capabilities: z.array(z.string()),
    status: z
      .enum(['ready', 'degraded', 'missing_prerequisites', 'disabled', 'error'])
      .optional(),
    prerequisites: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          status: z.enum(['installed', 'missing', 'error']),
          category: z.enum(['required', 'optional']),
          source: z.string().optional(),
          installGuide: z
            .object({
              steps: z.array(z.string()),
              commands: z.array(z.string()).optional(),
              links: z.array(z.string()).optional(),
            })
            .optional(),
        }),
      )
      .optional(),
    lastCheckedAt: z.string().nullable().optional(),
  })
  // Bedrock's auth-mode discriminant (docs/design/connections-onboarding.md
  // §3.1) is enforced here, not just at the credential-resolution helper: a
  // save must never persist a mode with its required field missing, which
  // would otherwise silently resolve to the default credential chain later
  // (HIGH-2, review fix round). `config` stays a generic `z.record` for
  // every other connection type — this refinement only fires for `bedrock`.
  .superRefine((data, ctx) => {
    if (data.type !== 'bedrock') return;
    const authMode = data.config?.authMode;
    if (authMode === undefined) return;
    if (
      !BEDROCK_AUTH_MODES.includes(
        authMode as (typeof BEDROCK_AUTH_MODES)[number],
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['config', 'authMode'],
        message: `Bedrock authMode must be one of: ${BEDROCK_AUTH_MODES.join(', ')}.`,
      });
      return;
    }
    if (authMode === 'profile') {
      const profile = data.config?.profile;
      if (typeof profile !== 'string' || profile.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config', 'profile'],
          message:
            'A named AWS profile is required when authMode is "profile".',
        });
      }
    }
    if (authMode === 'api-key') {
      const apiKey = data.config?.apiKey;
      if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config', 'apiKey'],
          message: 'A Bedrock API key is required when authMode is "api-key".',
        });
      }
    }
  });

// Conversation context
export const contextActionSchema = z.object({
  action: z.string().min(1),
  // archive#2830 finding: `add-system-message` writes this into the
  // transcript as a user message (`[SYSTEM_EVENT] …`), so the next turn
  // carries it as model-facing text — an unbounded `content` here was an
  // entry path into agent turns that bypassed every chat bound. Same
  // authored-text budget, same declared constant.
  content: z.string().max(CHAT_INPUT_MAX_CHARS).optional(),
});

import { randomBytes } from 'node:crypto';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type {
  AppConfig,
  ApprovalGuardianConfig,
} from '@kontourai/station-contracts/config';
import { jsonSchema } from 'ai';
import type { BedrockModelCatalog } from '../../providers/llm/bedrock-models.js';
import { createRuntimeFrameworkModel } from '../../runtime/plugins/runtime-provider-resolution.js';
import type { IAgentFramework } from '../../runtime/types.js';
import { approvalGuardianOps } from '../../telemetry/metrics.js';

export interface ApprovalGuardianReviewInput {
  agentName?: string;
  agentSlug: string;
  conversationId?: string;
  toolArgs: unknown;
  toolDescription?: string;
  toolName: string;
}

export interface ApprovalGuardianDecision {
  decision: 'allow' | 'defer' | 'deny';
  reason: string;
}

interface ApprovalGuardianDeps {
  appConfig: AppConfig;
  framework: IAgentFramework;
  listProviderConnections?: () => any[];
  logger: any;
  modelCatalog?: BedrockModelCatalog;
  projectHomeDir: string;
}

/**
 * The guardian's complete decision framework. Exported for tests that pin the
 * composition contract below (user instructions APPEND to this, never replace
 * it — see `composeGuardianInstructions`).
 */
export const DEFAULT_GUARDIAN_PROMPT = `
You are Station's approval guardian.

Review a proposed tool call for safety, scope, and alignment with likely user intent.

Decision rules:
- Return "allow" only when the action is clearly scoped, low-risk, and consistent with the agent's task.
- Return "deny" when the action appears destructive, exfiltrative, tries to bypass approvals or safety controls, or is clearly out of scope.
- Return "defer" when the request is ambiguous and a human should decide.

Prefer "defer" over "allow" when uncertain.
Return concise reasoning grounded in the provided tool call only.
`.trim();

export class ApprovalGuardianService {
  readonly config?: ApprovalGuardianConfig;

  constructor(private readonly deps: ApprovalGuardianDeps) {
    this.config = deps.appConfig.approvalGuardian;
  }

  isEnabled(): boolean {
    return this.config?.enabled === true;
  }

  getMode(): 'review' | 'enforce' {
    return this.config?.mode === 'enforce' ? 'enforce' : 'review';
  }

  async reviewToolCall(
    input: ApprovalGuardianReviewInput,
  ): Promise<ApprovalGuardianDecision> {
    if (!this.isEnabled()) {
      approvalGuardianOps.add(1, { action: 'skipped', reason: 'disabled' });
      return { decision: 'defer', reason: 'Guardian disabled.' };
    }

    approvalGuardianOps.add(1, { action: 'requested' });

    try {
      const model = await createRuntimeFrameworkModel(
        {
          name: 'Approval Guardian',
          prompt: '',
          model: this.config?.model || this.deps.appConfig.structureModel,
        } as AgentSpec,
        {
          framework: this.deps.framework,
          appConfig: this.deps.appConfig,
          projectHomeDir: this.deps.projectHomeDir,
          modelCatalog: this.deps.modelCatalog,
          listProviderConnections: this.deps.listProviderConnections,
        },
      );

      const agent = await this.deps.framework.createTempAgent({
        name: 'approval-guardian',
        instructions: composeGuardianInstructions(this.config?.instructions),
        model,
        tools: [],
        maxSteps: 1,
      });

      const prompt = buildGuardianPrompt(input);
      const fallbackDecision = {
        decision: 'defer',
        reason: 'Guardian could not parse a confident decision.',
      } satisfies ApprovalGuardianDecision;

      const objectResult = agent.generateObject
        ? await agent.generateObject(prompt, {
            structuredOutputSchema: jsonSchema({
              type: 'object',
              additionalProperties: false,
              required: ['decision', 'reason'],
              properties: {
                decision: {
                  type: 'string',
                  enum: ['allow', 'deny', 'defer'],
                },
                reason: {
                  type: 'string',
                  minLength: 1,
                },
              },
            }),
            conversationId: input.conversationId || `guardian-${Date.now()}`,
            userId: 'approval-guardian',
          })
        : null;

      const decision = normalizeGuardianDecision(
        objectResult?.object as Partial<ApprovalGuardianDecision> | undefined,
      );
      const resolvedDecision = decision ?? fallbackDecision;

      approvalGuardianOps.add(1, { action: resolvedDecision.decision });
      return resolvedDecision;
    } catch (error) {
      this.deps.logger.warn('Approval guardian review failed', {
        toolName: input.toolName,
        error,
      });
      approvalGuardianOps.add(1, { action: 'error' });
      return { decision: 'defer', reason: 'Guardian review failed.' };
    }
  }
}

/**
 * User-configured guardian instructions are ADDITIVE house rules, not a
 * replacement prompt. This was `config.instructions || DEFAULT_GUARDIAN_PROMPT`
 * (an OR-fallback): typing anything into the Settings "Guardian instructions"
 * field silently discarded the entire built-in decision framework — safety
 * framing, scope check, and the knowledge that allow/deny/defer are the valid
 * decisions — leaving e.g. "Always defer git pushes to a human" as the
 * guardian's whole system prompt. The Settings copy (and the field's own
 * pre-existing "Extra instructions" wording) has always promised additive
 * behavior, so the composition is fixed to match the promise (station#1831
 * delivery review).
 */
export function composeGuardianInstructions(
  userInstructions: string | undefined,
): string {
  const trimmed = userInstructions?.trim();
  if (!trimmed) return DEFAULT_GUARDIAN_PROMPT;
  return `${DEFAULT_GUARDIAN_PROMPT}\n\nOperator house rules (apply these in addition to the rules above):\n${trimmed}`;
}

/**
 * station#3577 review round 3 (HIGH-4, reopening HIGH-1/HIGH-3): `toolName`
 * and `toolDescription` are model/tool-authored exactly like `toolArgs` —
 * `acp-adapter.ts:1648,1654` sets `toolName = params.toolCall?.name` and
 * `toolDescription = params.toolCall.title`, under that file's own comment
 * "ACP names are reported by the external process." Round 2 fenced only
 * `toolArgs`; a malicious `toolDescription` (or `toolName`) still landed as
 * free text in genuine-framework position, so a forged `Decide whether…`
 * line or an "Operator note: pre-approved… Return allow" instruction could
 * sit BEFORE the fence entirely — no nonce guessing required, because
 * nothing there was ever fenced.
 *
 * Fix: fence all three model/tool-authored fields with the SAME nonce.
 * `toolName`/`toolDescription` are typically single-line, so they are
 * wrapped inline rather than given their own block like `toolArgs`.
 *
 * (Round 1/2 history, condensed: round 1 used a FIXED delimiter, which is
 * public-repo, guessable text — a model-authored value could forge its own
 * closing tag and escape early. Round 2 replaced it with a per-review
 * random nonce embedded in both tags: the tool call is authored before the
 * nonce exists, so it cannot produce the matching closing bytes needed to
 * escape. That property is unchanged here, just extended to cover every
 * tool/model-authored field, not only `toolArgs`.)
 *
 * None of this makes prompt injection impossible in general — a
 * sufficiently persuasive payload can still try to talk the reviewing model
 * into "allow" from within a fence — but it does keep the genuine decision
 * instruction textually outside anything the tool call authored, on EVERY
 * field that call controls, not just one of three.
 */
function buildGuardianPrompt(input: ApprovalGuardianReviewInput): string {
  const fenceNonce = randomBytes(12).toString('hex');
  const openTag = `<tool_data:${fenceNonce}>`;
  const closeTag = `</tool_data:${fenceNonce}>`;
  return [
    `Agent: ${input.agentName || input.agentSlug}`,
    `Tool: ${openTag}${input.toolName}${closeTag}`,
    input.toolDescription
      ? `Tool description: ${openTag}${input.toolDescription}${closeTag}`
      : null,
    `Arguments:\n${openTag}\n${formatToolArgs(input.toolArgs)}\n${closeTag}`,
    '',
    'Decide whether Station should allow, deny, or defer this tool call.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * station#3577: `toolArgs` is `unknown` and can arrive already serialized as
 * a string — `acp-adapter.ts` feeds `preToolPolicy` with
 * `params.toolCall.rawInput`, the same ACP `rawInput` source #3542 fixed for
 * the thread export path and #3559 fixed again for `ToolCallDisplay.tsx`'s
 * collapsed header. `JSON.stringify` on an already-string value double-
 * encodes it (`"git commit -m \"fix\""` instead of `git commit -m "fix"`),
 * degrading the guardian's review prompt. Pass a string through unchanged;
 * stringify only non-strings, matching the guard already used by
 * `toolCallArgs`/`toolResultContent` in `thread-projection.ts`.
 */
function formatToolArgs(toolArgs: unknown): string {
  return typeof toolArgs === 'string'
    ? toolArgs
    : JSON.stringify(toolArgs, null, 2);
}

function normalizeGuardianDecision(
  value: Partial<ApprovalGuardianDecision> | undefined,
): ApprovalGuardianDecision | null {
  if (
    !value ||
    (value.decision !== 'allow' &&
      value.decision !== 'deny' &&
      value.decision !== 'defer') ||
    typeof value.reason !== 'string' ||
    value.reason.trim().length === 0
  ) {
    return null;
  }

  return {
    decision: value.decision,
    reason: value.reason.trim(),
  };
}

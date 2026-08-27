/**
 * Auto-generates a short conversation title from the first exchange
 * (station#1566). Follows `ApprovalGuardianService`'s cheap-side-model
 * pattern: a one-shot temp agent bound to `appConfig.structureModel`,
 * `generateObject` against a tiny schema, and a fully non-fatal failure
 * mode — the caller (`finalizeChatRequest`) fires this off in the
 * background, so nothing here may ever throw or hang the turn.
 */
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import { jsonSchema } from 'ai';
import { createRuntimeFrameworkModel } from '../../runtime/plugins/runtime-provider-resolution.js';
import type { RuntimeContext } from '../../runtime/types.js';
import { CHAT_TITLE_SERVICE_PRINCIPAL } from '../../services/identity/service-principals.js';

// Bounds how long a slow/hung provider can delay the background title write
// (never the turn itself — this always runs after the turn has finished).
const TITLE_GENERATION_TIMEOUT_MS = 10_000;
// Keeps the prompt small and bounds token cost regardless of turn length.
const MAX_INPUT_CHARS = 500;
const MAX_TITLE_CHARS = 60;

const TITLE_INSTRUCTIONS = `
You generate short titles for chat conversations.

Given the user's first message and the assistant's reply, produce a concise
title of 3 to 6 words that captures what the conversation is about.

Rules:
- Plain words only — no quotes, no trailing punctuation, no markdown.
- Do not restate "conversation about" or similar framing; just the subject.
`.trim();

export async function generateConversationTitle({
  ctx,
  firstUserText,
  assistantText,
}: {
  ctx: RuntimeContext;
  firstUserText: string;
  assistantText: string;
}): Promise<string | null> {
  const structureModel = ctx.appConfig.structureModel;
  if (!structureModel) {
    // Empty/absent structureModel means title generation is disabled — the
    // same convention `ApprovalGuardianService` and its callers rely on.
    return null;
  }

  // station#1566 review (MEDIUM, accepted with disclosure): this timeout
  // only stops US from WAITING on `run()` — the underlying `generateObject`
  // call is abandoned, not cancelled. `createTempAgent`/`generateObject`
  // have no `AbortSignal` plumbing to cancel an in-flight provider call
  // (`ApprovalGuardianService` follows the same no-AbortSignal convention,
  // though it awaits its call directly with no timeout at all — the
  // abandon-after-10s behavior is specific to this code).
  // Accepted because the blast radius is bounded: this runs at most
  // once per new conversation (guarded by `isNewConversation` at the call
  // site), so an abandoned call is a one-off wasted request, not an
  // accumulating leak.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = async (): Promise<string | null> => {
      const model = await createRuntimeFrameworkModel(
        {
          name: 'Chat Title Generator',
          prompt: '',
          model: structureModel,
        } as AgentSpec,
        {
          framework: ctx.framework,
          appConfig: ctx.appConfig,
          projectHomeDir: ctx.configLoader.getProjectHomeDir(),
          modelCatalog: ctx.modelCatalog,
          listProviderConnections: () =>
            ctx.providerService.listProviderConnections(),
        },
      );

      const agent = await ctx.framework.createTempAgent({
        name: 'chat-title-generator',
        instructions: TITLE_INSTRUCTIONS,
        model,
        tools: [],
        maxSteps: 1,
      });

      if (!agent.generateObject) {
        return null;
      }

      const objectResult = await agent.generateObject(
        buildTitlePrompt(firstUserText, assistantText),
        {
          structuredOutputSchema: jsonSchema({
            type: 'object',
            additionalProperties: false,
            required: ['title'],
            properties: {
              title: { type: 'string', minLength: 1 },
            },
          }),
          conversationId: `chat-title-${Date.now()}`,
          userId: CHAT_TITLE_SERVICE_PRINCIPAL.id,
        },
      );

      return normalizeGeneratedTitle(
        (objectResult?.object as { title?: unknown } | undefined)?.title,
      );
    };

    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TITLE_GENERATION_TIMEOUT_MS);
    });

    return await Promise.race([run(), timeout]);
  } catch (error) {
    // Never fatal — a title is a nice-to-have. The initial truncated title
    // (see `ensureChatConversation`) stands when this fails.
    ctx.logger.debug('Chat title generation failed', { error });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildTitlePrompt(
  firstUserText: string,
  assistantText: string,
): string {
  return [
    `User message: ${truncate(firstUserText, MAX_INPUT_CHARS)}`,
    `Assistant reply: ${truncate(assistantText, MAX_INPUT_CHARS)}`,
  ].join('\n\n');
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function normalizeGeneratedTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }

  let title = raw.trim();
  const wrappedInQuotes =
    title.length >= 2 &&
    ((title.startsWith('"') && title.endsWith('"')) ||
      (title.startsWith("'") && title.endsWith("'")));
  if (wrappedInQuotes) {
    title = title.slice(1, -1).trim();
  }

  title = title.replace(/\s+/g, ' ').trim();
  if (title.length > MAX_TITLE_CHARS) {
    title = title.slice(0, MAX_TITLE_CHARS).trim();
  }

  return title.length > 0 ? title : null;
}

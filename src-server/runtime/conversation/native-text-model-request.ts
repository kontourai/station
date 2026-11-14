// UNWIRED #91: source admission, qualified pricing, reservation and credential owners must consume the final bytes.
import { z } from 'zod/v3';
import {
  NATIVE_MODEL_CHANNEL_LIMITS,
  type NativeModelRequest,
} from '../../services/connections/native-model-stdio-protocol.js';
import { parseBoundedApiRequestBody } from './bounded-api-provider-contract.js';

const count = z.number().int().safe().positive();
const cache = z
  .object({
    type: z.literal('ephemeral'),
    ttl: z.enum(['5m', '1h']).optional(),
  })
  .strict();
const anthropicText = z
  .object({
    type: z.literal('text'),
    text: z.string(),
    cache_control: cache.optional(),
  })
  .strict();
const anthropicBody = z
  .object({
    model: z.string(),
    max_tokens: count,
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.union([z.string(), z.array(anthropicText)]),
          })
          .strict(),
      )
      .min(1),
    system: z.union([z.string(), z.array(anthropicText)]).optional(),
    stream: z.literal(true),
    tools: z.array(z.unknown()),
    metadata: z.unknown().optional(),
    thinking: z
      .object({
        type: z.enum(['enabled', 'disabled', 'adaptive']),
        budget_tokens: count.optional(),
        display: z.literal('omitted').optional(),
      })
      .strict()
      .optional(),
    context_management: z
      .object({
        edits: z.array(
          z
            .object({
              type: z.literal('clear_thinking_20251015'),
              keep: z.literal('all'),
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
  })
  .strict();
const responsesBody = z
  .object({
    model: z.string(),
    max_output_tokens: count.optional(),
    input: z
      .array(
        z
          .object({
            type: z.literal('message').optional(),
            id: z.string().optional(),
            role: z.enum(['system', 'developer', 'user', 'assistant']),
            content: z.array(
              z
                .object({
                  type: z.enum(['input_text', 'output_text']),
                  text: z.string(),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .min(1),
    instructions: z.string().optional(),
    stream: z.literal(true),
    store: z.boolean(),
    tools: z.array(z.unknown()),
    tool_choice: z.enum(['auto', 'none']),
    parallel_tool_calls: z.boolean(),
    reasoning: z
      .object({
        effort: z
          .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
          .optional(),
        summary: z.enum(['auto', 'concise', 'detailed']).optional(),
        mode: z.literal('standard').optional(),
      })
      .strict()
      .optional(),
    include: z.array(z.literal('reasoning.encrypted_content')).optional(),
    prompt_cache_key: z.string().optional(),
    client_metadata: z.unknown().optional(),
  })
  .strict();

/** Narrow a native text request BEFORE qualification, quotation and reservation.
 * This supplies no authority and performs no fetch. The caller must bind and
 * authorize the returned bytes, not the original native request or its hash. */
export function prepareNativeTextModelRequest(
  input: NativeModelRequest,
  policy: Readonly<{
    provider: 'anthropic' | 'openai';
    modelId: string;
    maxOutputTokens: number;
  }>,
): NativeModelRequest {
  try {
    count.parse(policy.maxOutputTokens);
    const path =
      policy.provider === 'anthropic' ? '/v1/messages' : '/v1/responses';
    if (
      !['anthropic', 'openai'].includes(policy.provider) ||
      input.method !== 'POST' ||
      (input.path !== path &&
        !(
          policy.provider === 'anthropic' &&
          input.path === '/v1/messages?beta=true'
        )) ||
      input.body.length > NATIVE_MODEL_CHANNEL_LIMITS.bodyBytes ||
      input.headers.some(
        ([name, value]) =>
          name.toLowerCase() === 'content-encoding' && value !== 'identity',
      )
    )
      throw new Error();
    const parsed = parseBoundedApiRequestBody(
      new TextDecoder('utf-8', { fatal: true }).decode(input.body),
    );
    let body: unknown;
    if (policy.provider === 'anthropic') {
      const native = anthropicBody.parse(parsed);
      if (native.model !== policy.modelId) throw new Error();
      const cap = Math.min(native.max_tokens, policy.maxOutputTokens);
      const thinking = native.thinking;
      const thinkingBudget = thinking?.budget_tokens ?? 0;
      if (
        thinking?.type === 'enabled' &&
        (!thinking.budget_tokens ||
          thinking.budget_tokens < 1024 ||
          cap <= 1024)
      )
        throw new Error();
      if (thinking?.type !== 'enabled' && thinking?.budget_tokens !== undefined)
        throw new Error();
      body = {
        model: native.model,
        max_tokens: cap,
        messages: native.messages,
        ...(native.system !== undefined ? { system: native.system } : {}),
        stream: true,
        tools: [],
        service_tier: 'standard_only',
        inference_geo: 'global',
        ...(thinking
          ? {
              thinking: {
                type: thinking.type,
                ...(thinking.type === 'enabled'
                  ? { budget_tokens: Math.min(thinkingBudget, cap - 1) }
                  : {}),
              },
            }
          : {}),
      };
    } else {
      const native = responsesBody.parse(parsed);
      if (native.model !== policy.modelId) throw new Error();
      body = {
        model: native.model,
        max_output_tokens: Math.min(
          native.max_output_tokens ?? policy.maxOutputTokens,
          policy.maxOutputTokens,
        ),
        input: native.input.map(({ role, content }) => ({
          type: 'message',
          role,
          content,
        })),
        ...(native.instructions !== undefined
          ? { instructions: native.instructions }
          : {}),
        ...(native.reasoning ? { reasoning: native.reasoning } : {}),
        stream: true,
        store: false,
        tools: [],
        tool_choice: 'none',
        parallel_tool_calls: false,
        service_tier: 'default',
        truncation: 'disabled',
      };
    }
    const bytes = Buffer.from(JSON.stringify(body));
    if (bytes.length > NATIVE_MODEL_CHANNEL_LIMITS.bodyBytes) throw new Error();
    return {
      ...input,
      path,
      body: bytes,
      headers: [
        ['content-type', 'application/json'],
        ...input.headers
          .filter(
            ([name]) =>
              policy.provider === 'anthropic' &&
              name.toLowerCase() === 'anthropic-version',
          )
          .map(([name, value]): [string, string] => [name, value]),
      ],
    };
  } catch {
    throw new Error('native_text_model_request_refused');
  }
}

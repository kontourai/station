// UNWIRED(#91): source admission, qualification and reservation must authorize the returned bytes.

import { isApprovalMode } from '@kontourai/station-contracts/provider';
import { z } from 'zod/v3';
import {
  NATIVE_MODEL_CHANNEL_LIMITS,
  type NativeModelRequest,
} from '../../services/connections/native-model-stdio-protocol.js';
import { parseBoundedProviderJson } from './bounded-provider-json.js';

const count = z.number().int().safe().positive();
export type NativeTextModelSettings = Readonly<{
  effort?: string;
  thinking?: boolean;
}>;
const selectedOptions = z
  .object({
    effort: z
      .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
      .optional(),
    reasoningEffort: z
      .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
      .optional(),
    thinking: z.boolean().optional(),
    fastMode: z.literal(false).optional(),
    autoMode: z.literal(false).optional(),
    serviceTier: z.literal('default').optional(),
    approvalMode: z.string().refine(isApprovalMode).optional(),
  })
  .strict();

/** Standard-tier fixed text profile. Policy still passes the canonical posture
 * gate; no tools are offered. Unsupported settings never silently use defaults. */
function normalizeNativeTextModelOptions(
  provider: 'anthropic' | 'openai',
  options?: Readonly<Record<string, unknown>>,
): NativeTextModelSettings {
  try {
    const value = selectedOptions.parse(options ?? {});
    if (
      value.effort !== undefined &&
      value.reasoningEffort !== undefined &&
      value.effort !== value.reasoningEffort
    )
      throw new Error();
    const effort = value.effort ?? value.reasoningEffort;
    if (
      provider === 'anthropic'
        ? value.reasoningEffort !== undefined ||
          value.serviceTier !== undefined ||
          effort === 'none' ||
          effort === 'minimal'
        : value.thinking !== undefined || value.autoMode !== undefined
    )
      throw new Error();
    return Object.freeze({
      ...(effort === undefined ? {} : { effort }),
      ...(value.thinking === undefined ? {} : { thinking: value.thinking }),
    });
  } catch {
    throw new Error('native_text_model_options_unsupported');
  }
}
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

function anthropicRequestBody(
  parsed: unknown,
  modelId: string,
  maxOutputTokens: number,
  settings: NativeTextModelSettings,
  brokered: boolean,
) {
  const native = brokered
    ? anthropicBrokeredBody.parse(parsed)
    : anthropicBody.parse(parsed);
  if (native.model !== modelId) throw new Error();
  const cap = Math.min(native.max_tokens, maxOutputTokens);
  const thinking: typeof native.thinking =
    settings.thinking === false
      ? { type: 'disabled' as const }
      : settings.thinking === true &&
          (!native.thinking || native.thinking.type === 'disabled')
        ? { type: 'enabled' as const, budget_tokens: 1024 }
        : native.thinking;
  const thinkingBudget = thinking?.budget_tokens ?? 0;
  if (
    thinking?.type === 'enabled' &&
    (!thinking.budget_tokens || thinking.budget_tokens < 1024 || cap <= 1024)
  )
    throw new Error();
  if (thinking?.type !== 'enabled' && thinking?.budget_tokens !== undefined)
    throw new Error();
  return {
    model: native.model,
    max_tokens: cap,
    messages: native.messages,
    ...(native.system !== undefined ? { system: native.system } : {}),
    stream: true,
    tools: [],
    service_tier: 'standard_only',
    inference_geo: 'global',
    ...(settings.effort === undefined
      ? {}
      : { output_config: { effort: settings.effort } }),
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
}

function responsesRequestBody(
  parsed: unknown,
  modelId: string,
  maxOutputTokens: number,
  settings: NativeTextModelSettings,
  brokered: boolean,
) {
  const native = brokered
    ? responsesBrokeredBody.parse(parsed)
    : responsesBody.parse(parsed);
  if (native.model !== modelId) throw new Error();
  return {
    model: native.model,
    max_output_tokens: Math.min(
      native.max_output_tokens ?? maxOutputTokens,
      maxOutputTokens,
    ),
    input: native.input.map((item) =>
      item.type === 'function_call' || item.type === 'function_call_output'
        ? item
        : { type: 'message', role: item.role, content: item.content },
    ),
    ...(native.instructions !== undefined
      ? { instructions: native.instructions }
      : {}),
    ...(native.reasoning || settings.effort !== undefined
      ? {
          reasoning: {
            ...native.reasoning,
            ...(settings.effort === undefined
              ? {}
              : { effort: settings.effort }),
          },
        }
      : {}),
    stream: true,
    store: false,
    tools: [],
    tool_choice: brokered ? native.tool_choice : 'none',
    parallel_tool_calls: false,
    service_tier: 'default',
    truncation: 'disabled',
  };
}

/** Narrow a native text request BEFORE qualification, quotation and reservation.
 * This supplies no authority and performs no fetch. The caller must bind and
 * authorize the returned bytes, not the original native request or its hash. */
function prepareNativeModelRequest(
  input: NativeModelRequest,
  policy: Readonly<{
    provider: 'anthropic' | 'openai';
    modelId: string;
    maxOutputTokens: number;
    modelOptions?: Readonly<Record<string, unknown>>;
  }>,
  brokered: boolean,
): NativeModelRequest {
  try {
    count.parse(policy.maxOutputTokens);
    const settings = normalizeNativeTextModelOptions(
      policy.provider,
      policy.modelOptions,
    );
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
    const parsed = parseBoundedProviderJson(
      new TextDecoder('utf-8', { fatal: true }).decode(input.body),
      NATIVE_MODEL_CHANNEL_LIMITS.bodyBytes,
    );
    const body =
      policy.provider === 'anthropic'
        ? anthropicRequestBody(
            parsed,
            policy.modelId,
            policy.maxOutputTokens,
            settings,
            brokered,
          )
        : responsesRequestBody(
            parsed,
            policy.modelId,
            policy.maxOutputTokens,
            settings,
            brokered,
          );
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

/** Fixed sealed-leaf profile: no tool-bearing history or execution tools. */
export function prepareNativeTextModelRequest(
  input: NativeModelRequest,
  policy: Parameters<typeof prepareNativeModelRequest>[1],
): NativeModelRequest {
  return prepareNativeModelRequest(input, policy, false);
}

type BrokeredModelPolicy = Parameters<typeof prepareNativeTextModelRequest>[1] &
  Readonly<{
    tools: readonly {
      name: string;
      description: string;
      inputSchema: Readonly<Record<string, unknown>>;
    }[];
  }>;

const brokerCallId = z.string().min(1).max(256);
const brokerTool = z
  .object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/),
    description: z.string().max(8192),
    inputSchema: z.object({ type: z.literal('object') }).passthrough(),
  })
  .strict();
const anthropicBrokeredBody = anthropicBody.extend({
  messages: z
    .array(
      z
        .object({
          role: z.enum(['user', 'assistant']),
          content: z.union([
            z.string(),
            z.array(
              z.union([
                anthropicText,
                z
                  .object({
                    type: z.literal('tool_use'),
                    id: brokerCallId,
                    name: z.string(),
                    input: z.record(z.unknown()),
                  })
                  .strict(),
                z
                  .object({
                    type: z.literal('tool_result'),
                    tool_use_id: brokerCallId,
                    content: z.union([z.string(), z.array(anthropicText)]),
                    is_error: z.boolean().optional(),
                  })
                  .strict(),
              ]),
            ),
          ]),
        })
        .strict(),
    )
    .min(1),
});
const responsesBrokeredBody = responsesBody.extend({
  input: z
    .array(
      z.union([
        responsesBody.shape.input.element,
        z
          .object({
            type: z.literal('function_call'),
            id: z.string().optional(),
            call_id: brokerCallId,
            name: z.string(),
            namespace: z.literal('mcp__station_delegation'),
            arguments: z.string(),
            status: z.literal('completed').optional(),
          })
          .strict(),
        z
          .object({
            type: z.literal('function_call_output'),
            call_id: brokerCallId,
            output: z.string(),
          })
          .strict(),
      ]),
    )
    .min(1),
});

function brokeredHistory(names: ReadonlySet<string>) {
  const seen = new Set<string>(),
    pending = new Set<string>();
  return {
    use(id: string, name: string) {
      if (seen.has(id) || !names.has(name)) throw new Error();
      seen.add(id);
      pending.add(id);
    },
    result(id: string) {
      if (!pending.delete(id)) throw new Error();
    },
    complete() {
      if (pending.size) throw new Error();
    },
  };
}

function anthropicBrokeredTools(
  parsed: unknown,
  tools: z.infer<typeof brokerTool>[],
) {
  const native = anthropicBrokeredBody.parse(parsed);
  const names = new Set(tools.map((tool) => tool.name));
  const advertised = native.tools.flatMap((tool) => {
    const entry = z.object({ name: z.string() }).passthrough().safeParse(tool);
    return entry.success ? [entry.data.name] : [];
  });
  for (const name of names)
    if (
      advertised.filter((value) => value === `mcp__station_delegation__${name}`)
        .length !== 1
    )
      throw new Error();
  const history = brokeredHistory(names);
  for (const message of native.messages) {
    if (typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type === 'tool_use') {
        const prefix = 'mcp__station_delegation__';
        if (message.role !== 'assistant' || !part.name.startsWith(prefix))
          throw new Error();
        history.use(part.id, part.name.slice(prefix.length));
      } else if (part.type === 'tool_result') {
        if (message.role !== 'user') throw new Error();
        history.result(part.tool_use_id);
      }
    }
  }
  history.complete();
  return tools.map((tool) => ({
    name: `mcp__station_delegation__${tool.name}`,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

function responsesBrokeredTools(
  parsed: unknown,
  tools: z.infer<typeof brokerTool>[],
) {
  const native = responsesBrokeredBody.parse(parsed);
  const names = new Set(tools.map((tool) => tool.name));
  const advertised = native.tools.flatMap((tool) => {
    const entry = z
      .object({
        type: z.literal('namespace'),
        name: z.literal('mcp__station_delegation'),
        tools: z.array(
          z
            .object({ type: z.literal('function'), name: z.string() })
            .passthrough(),
        ),
      })
      .passthrough()
      .safeParse(tool);
    return entry.success ? entry.data.tools.map((item) => item.name) : [];
  });
  for (const name of names)
    if (advertised.filter((value) => value === name).length !== 1)
      throw new Error();
  const history = brokeredHistory(names);
  for (const item of native.input) {
    if (item.type === 'function_call') {
      z.record(z.unknown()).parse(
        parseBoundedProviderJson(
          item.arguments,
          NATIVE_MODEL_CHANNEL_LIMITS.bodyBytes,
        ),
      );
      history.use(item.call_id, item.name);
    } else if (item.type === 'function_call_output')
      history.result(item.call_id);
  }
  history.complete();
  return [
    {
      type: 'namespace',
      name: 'mcp__station_delegation',
      description: 'Tools selected by the current host broker.',
      tools: tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        strict: false,
      })),
    },
  ];
}

/** Prepare bounded text/MCP bytes before a distinct broker qualifies and reserves
 * each physical attempt. History joins are syntax checks, not effect receipts,
 * native acceptance, parent authority or permission to invoke the selected tools. */
export function prepareNativeBrokeredModelRequest(
  input: NativeModelRequest,
  policy: BrokeredModelPolicy,
): NativeModelRequest {
  try {
    if (input.body.length > NATIVE_MODEL_CHANNEL_LIMITS.bodyBytes)
      throw new Error();
    const tools = z
      .array(brokerTool)
      .min(1)
      .max(32)
      .parse(
        parseBoundedProviderJson(
          JSON.stringify(policy.tools),
          NATIVE_MODEL_CHANNEL_LIMITS.bodyBytes,
        ),
      );
    const names = new Set(tools.map((tool) => tool.name));
    if (names.size !== tools.length) throw new Error();
    const parsed = parseBoundedProviderJson(
      new TextDecoder('utf-8', { fatal: true }).decode(input.body),
      NATIVE_MODEL_CHANNEL_LIMITS.bodyBytes,
    );
    const declarations =
      policy.provider === 'anthropic'
        ? anthropicBrokeredTools(parsed, tools)
        : responsesBrokeredTools(parsed, tools);
    const final = prepareNativeModelRequest(input, policy, true);
    const body = JSON.parse(final.body.toString('utf8'));
    body.tools = declarations;
    const bytes = Buffer.from(JSON.stringify(body));
    if (bytes.length > NATIVE_MODEL_CHANNEL_LIMITS.bodyBytes) throw new Error();
    return { ...final, body: bytes };
  } catch {
    throw new Error('native_brokered_model_request_refused');
  }
}

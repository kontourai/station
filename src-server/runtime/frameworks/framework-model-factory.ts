import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { AppConfig } from '@kontourai/station-contracts/config';
import type { ProviderConnectionConfig } from '@kontourai/station-contracts/tool';
import { BedrockModel } from '@strands-agents/sdk';
import { VercelModel } from '@strands-agents/sdk/models/vercel';
import { DEFAULT_OLLAMA_BASE_URL } from '../../constants.js';
import { createBedrockProvider } from '../../providers/llm/bedrock.js';
import type {
  BedrockAuthConfig,
  BedrockAuthMode,
} from '../../providers/llm/bedrock-credentials.js';
import {
  bedrockAiSdkCredentials,
  bedrockStrandsCredentials,
} from '../../providers/llm/bedrock-credentials.js';
import { resolveBedrockRegion } from '../../providers/llm/bedrock-region.js';

export interface FrameworkModelOptions {
  providerConnection: ProviderConnectionConfig | null;
  modelId: string;
  spec: Pick<AgentSpec, 'guardrails' | 'region'>;
  appConfig: Pick<AppConfig, 'defaultMaxOutputTokens' | 'region'>;
}

/**
 * Normalized options for the single ai-sdk model-construction path. Both the
 * managed-runtime engine (VoltAgent/Strands bridge) and the connection-lifecycle
 * LLM providers funnel through {@link buildAiSdkLanguageModel} so there is one
 * home for provider switching + base-URL normalization.
 */
export interface AiSdkModelOptions {
  type: string;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  region?: string;
  /** Bedrock-only: the connection's auth mode (docs §3.1). Defaults to 'chain'. */
  authMode?: BedrockAuthMode;
  /** Bedrock-only: named AWS profile, used when authMode is 'profile'. */
  profile?: string;
  /**
   * station#1994: provider-wire request-body defaults for completion calls,
   * from the connection's `config.modelRequestOptions`. Each key is set on
   * the outgoing JSON body only when the request doesn't already carry it —
   * e.g. `{ "reasoning_effort": "low" }` for an OpenAI-compatible endpoint
   * that rejects plain non-reasoning requests, or `{ "thinking": … }` on the
   * Anthropic wire. Applied only to completion endpoints (`/chat/completions`,
   * `/messages`, `:generateContent`), never catalog or embedding calls.
   * Unsupported for bedrock (request signing owns the body).
   */
  requestBodyDefaults?: Record<string, unknown>;
}

/**
 * Single source of truth that builds an AI SDK v3 language model for a
 * given provider type. Includes the ollama/openai-compat base-URL → `/v1`
 * normalization and bedrock region/credential handling.
 */
export function buildAiSdkLanguageModel(
  opts: AiSdkModelOptions,
): LanguageModelV3 {
  const apiKey = cleanString(opts.apiKey);
  const baseUrl = cleanString(opts.baseUrl);
  const fetchOverride = requestBodyDefaultsFetch(opts.requestBodyDefaults);

  switch (opts.type) {
    case 'openai-compat':
    case 'ollama': {
      const baseURL = normalizeOpenAICompatibleBaseUrl(opts.type, baseUrl);
      return createOpenAICompatible({
        name: opts.type || 'openai-compatible',
        baseURL,
        // Ollama ONLY: ask for `stream_options: { include_usage: true }`
        // so streamed turns carry usage even under strict OpenAI streaming
        // semantics (station#4197). Deliberately NOT set for generic
        // 'openai-compat' connections — that type fronts a population of
        // gateways/proxies (OpenRouter, Groq, Azure-style, self-hosted)
        // where some reject unrecognized request params, and a 4xx on
        // stream_options would break previously-working chat turns to fix
        // a maybe-missing usage figure (delta-review MEDIUM). Ollama's own
        // compat layer accepts the param.
        ...(opts.type === 'ollama' ? { includeUsage: true } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(fetchOverride ? { fetch: fetchOverride } : {}),
      }).chatModel(opts.modelId);
    }
    case 'anthropic': {
      return createAnthropic({
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        ...(fetchOverride ? { fetch: fetchOverride } : {}),
      }).languageModel(opts.modelId);
    }
    case 'google': {
      return createGoogleGenerativeAI({
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        ...(fetchOverride ? { fetch: fetchOverride } : {}),
      }).languageModel(opts.modelId);
    }
    case 'bedrock': {
      return createAmazonBedrock({
        // station#1557: the caller has already resolved through
        // `resolveBedrockRegion`; a second default here would be a third
        // opinion about the region, reachable only when a caller forgets.
        region: resolveBedrockRegion({
          configRegion: opts.region,
          env: process.env,
        }).region,
        ...bedrockAiSdkCredentials({
          authMode: opts.authMode,
          profile: opts.profile,
          apiKey,
        }),
      }).languageModel(opts.modelId);
    }
    default:
      throw new Error(
        `Managed runtime provider '${opts.type || 'unknown'}' is not supported by the current framework bridge.`,
      );
  }
}

function cleanString(value?: string): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * Completion endpoints across the three fetch-capable wires. Catalog
 * (`/models`) and embedding calls must never receive completion-body
 * defaults — an unknown field there is a hard 4xx on strict endpoints.
 */
const COMPLETION_ENDPOINT_PATTERN =
  /(\/chat\/completions|\/messages|:(generateContent|streamGenerateContent))$/;

function isCompletionEndpoint(url: string): boolean {
  try {
    return COMPLETION_ENDPOINT_PATTERN.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * station#1994: wrap `fetch` so connection-configured request-body defaults
 * reach the provider wire. Defaults fill only ABSENT keys — a body field the
 * SDK (or a future per-call option) already set always wins. Non-JSON and
 * non-completion requests pass through byte-identical.
 *
 * Calling-convention assumption (review M1): the installed ai-sdk providers
 * always invoke fetch as `(stringUrl, { method: 'POST', body: string })`
 * (`postToApi` in @ai-sdk/provider-utils). A `Request`-object input carries
 * its body internally and passes through UNMODIFIED here — deliberately, to
 * never corrupt a shape we don't own, at the cost of the defaults silently
 * not applying. If an ai-sdk bump switches to Request objects, the pinning
 * test ('Request-object inputs pass through…') documents where to extend.
 */
export function requestBodyDefaultsFetch(
  defaults: Record<string, unknown> | undefined,
): typeof fetch | undefined {
  const entries = Object.entries(defaults ?? {});
  if (entries.length === 0) return undefined;
  return async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body;
    if (
      method !== 'POST' ||
      typeof body !== 'string' ||
      !isCompletionEndpoint(url)
    ) {
      return fetch(input, init);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return fetch(input, init);
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return fetch(input, init);
    }
    const merged = parsed as Record<string, unknown>;
    let changed = false;
    for (const [key, value] of entries) {
      // Object.hasOwn, not `in`: a default named after a prototype member
      // (`toString`, `constructor`, …) must still be injectable. A
      // `__proto__`-named default remains deliberately un-injectable (the
      // assignment goes through the prototype setter and stringify omits
      // it); only this throwaway local object is affected either way.
      if (!Object.hasOwn(merged, key)) {
        merged[key] = value;
        changed = true;
      }
    }
    if (!changed) return fetch(input, init);
    return fetch(input, { ...init, body: JSON.stringify(merged) });
  };
}

function normalizeOpenAICompatibleBaseUrl(
  type: string,
  baseUrl?: string,
): string {
  if (!baseUrl) {
    return `${DEFAULT_OLLAMA_BASE_URL}/v1`;
  }
  if (type === 'ollama') {
    return /\/v1\/?$/.test(baseUrl)
      ? baseUrl
      : `${baseUrl.replace(/\/$/, '')}/v1`;
  }
  return baseUrl;
}

export function createVoltAgentManagedModel(
  options: FrameworkModelOptions,
): any {
  if (
    !options.providerConnection ||
    options.providerConnection.type === 'bedrock'
  ) {
    // station#1557 review fix: pass the RAW scopes, not a pre-resolved value
    // in both fields. Pre-resolving made `createBedrockProvider`'s own
    // resolution a no-op that always hit its first branch, so the env
    // fallback it advertises was unreachable from the only caller it has.
    return createBedrockProvider({
      appConfig: {
        defaultModel: options.modelId,
        region: options.appConfig.region,
      } as AppConfig,
      agentSpec: {
        model: options.modelId,
        region: options.spec.region,
      } as AgentSpec,
      connectionRegion:
        typeof options.providerConnection?.config.region === 'string'
          ? options.providerConnection.config.region
          : undefined,
      auth: resolveBedrockAuth(options),
    });
  }

  return createManagedLanguageModel(options);
}

export function createStrandsManagedModel(options: FrameworkModelOptions): any {
  if (
    !options.providerConnection ||
    options.providerConnection.type === 'bedrock'
  ) {
    return new BedrockModel({
      modelId: options.modelId,
      region: bedrockRegionFor(options),
      ...bedrockStrandsCredentials(resolveBedrockAuth(options)),
      maxTokens:
        options.spec.guardrails?.maxTokens ??
        options.appConfig.defaultMaxOutputTokens,
      temperature: options.spec.guardrails?.temperature,
      topP: options.spec.guardrails?.topP,
    });
  }

  return new VercelModel({
    provider: createManagedLanguageModel(options),
    maxTokens:
      options.spec.guardrails?.maxTokens ??
      options.appConfig.defaultMaxOutputTokens,
    temperature: options.spec.guardrails?.temperature,
    topP: options.spec.guardrails?.topP,
  });
}

function createManagedLanguageModel(
  options: FrameworkModelOptions,
): LanguageModelV3 {
  const conn = options.providerConnection;
  const requestBodyDefaults = resolveModelRequestOptions(conn?.config);
  return buildAiSdkLanguageModel({
    type: conn?.type ?? 'unknown',
    modelId: options.modelId,
    apiKey: resolveApiKey(conn),
    baseUrl: resolveRawBaseUrl(conn),
    ...(requestBodyDefaults ? { requestBodyDefaults } : {}),
  });
}

/**
 * station#1994: read the connection's `modelRequestOptions` — a plain object
 * of provider-wire body defaults. Anything else (absent, null, array,
 * scalar) resolves to undefined rather than guessing.
 */
export function resolveModelRequestOptions(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const value = config?.modelRequestOptions;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length > 0 ? (value as Record<string, unknown>) : undefined;
}

/** Build the common AI SDK model used by policy/runtime composition layers. */
export function createAiSdkManagedModel(
  options: FrameworkModelOptions,
): LanguageModelV3 {
  if (
    !options.providerConnection ||
    options.providerConnection.type === 'bedrock'
  ) {
    return buildAiSdkLanguageModel({
      type: 'bedrock',
      modelId: options.modelId,
      region: bedrockRegionFor(options),
      ...resolveBedrockAuth(options),
    });
  }
  return createManagedLanguageModel(options);
}

/** Adapt an already-composed AI SDK model to Strands without rebuilding it. */
export function createStrandsAiSdkModel(
  provider: LanguageModelV3,
  options: Pick<FrameworkModelOptions, 'spec' | 'appConfig'>,
): VercelModel {
  return new VercelModel({
    provider,
    maxTokens:
      options.spec.guardrails?.maxTokens ??
      options.appConfig.defaultMaxOutputTokens,
    temperature: options.spec.guardrails?.temperature,
    topP: options.spec.guardrails?.topP,
  });
}

function resolveRawBaseUrl(
  providerConnection: ProviderConnectionConfig | null,
): string | undefined {
  const baseUrl = providerConnection?.config.baseUrl;
  return typeof baseUrl === 'string' && baseUrl.trim().length > 0
    ? baseUrl.trim()
    : undefined;
}

/**
 * station#1557 review fix. This used to be a second, independent copy of the
 * region chain whose tail was `options.appConfig.region || 'us-east-1'` — no
 * `AWS_REGION`. It is the chain EVERY Station-agent execution path runs, so
 * unifying the other readers without it relocated the disagreement rather
 * than closing it: Settings could say "Set by operator: AWS_REGION" and the
 * catalogue could be fetched from that region while every chat turn ran
 * against `us-east-1`.
 */
function bedrockRegionFor(options: FrameworkModelOptions): string {
  return resolveBedrockRegion({
    agentRegion: options.spec.region,
    connectionRegion:
      typeof options.providerConnection?.config.region === 'string'
        ? options.providerConnection.config.region
        : undefined,
    configRegion: options.appConfig.region,
    env: process.env,
  }).region;
}

/**
 * Thread the connection's Bedrock auth mode (docs/design/connections-onboarding.md
 * §3.1) into every Station-agent execution path (HIGH-3, review fix round):
 * VoltAgent (`createVoltAgentManagedModel`), Strands
 * (`createStrandsManagedModel`), and the ai-sdk/Dispatch path
 * (`createAiSdkManagedModel`, consumed by `dispatch-model-policy.ts`) all
 * previously ignored `profile`/`api-key` connections and ran chain-only.
 * Absent connection config (or a `bedrock` config with no `authMode`)
 * resolves to `undefined` here, which every `bedrock*Credentials` mapper
 * treats as chain — unchanged default behavior.
 */
function resolveBedrockAuth(options: FrameworkModelOptions): BedrockAuthConfig {
  const config = options.providerConnection?.config;
  const authMode = config?.authMode;
  const profile = config?.profile;
  const apiKey = config?.apiKey;
  return {
    authMode:
      typeof authMode === 'string' ? (authMode as BedrockAuthMode) : undefined,
    profile: typeof profile === 'string' ? profile : undefined,
    apiKey: typeof apiKey === 'string' ? apiKey : undefined,
  };
}

function resolveApiKey(
  providerConnection: ProviderConnectionConfig | null,
): string | undefined {
  const apiKey = providerConnection?.config.apiKey;
  return typeof apiKey === 'string' && apiKey.trim().length > 0
    ? apiKey.trim()
    : undefined;
}

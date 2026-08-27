import type { ProviderConnectionConfig } from '@kontourai/station-contracts/tool';
import { LanceDBProvider } from './lancedb-provider.js';
import { AnthropicLLMProvider } from './llm/anthropic-llm-provider.js';
import { BedrockEmbeddingProvider } from './llm/bedrock-embedding-provider.js';
import { BedrockLLMProvider } from './llm/bedrock-llm-provider.js';
import { GoogleLLMProvider } from './llm/google-llm-provider.js';
import type {
  IEmbeddingProvider,
  ILLMProvider,
  IVectorDbProvider,
} from './llm/model-provider-types.js';
import {
  OllamaEmbeddingProvider,
  OllamaLLMProvider,
} from './llm/ollama-provider.js';
import {
  OpenAICompatEmbeddingProvider,
  OpenAICompatLLMProvider,
} from './llm/openai-compat-provider.js';

interface OllamaConfig {
  baseUrl?: string;
  locality?: 'local' | 'remote' | 'unknown';
}

interface OpenAICompatConfig {
  baseUrl: string;
  apiKey?: string;
  /** station#1994: provider-wire completion-body defaults. */
  modelRequestOptions?: Record<string, unknown>;
}

interface BedrockProviderConfig {
  region?: string;
  authMode?: 'chain' | 'profile' | 'api-key';
  profile?: string;
  apiKey?: string;
}

interface ApiKeyProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  /** station#1994: provider-wire completion-body defaults. */
  modelRequestOptions?: Record<string, unknown>;
}

interface LanceDBConfig {
  dataDir?: string;
}

interface BedrockEmbeddingConfig {
  region?: string;
  embeddingModel?: string;
  authMode?: 'chain' | 'profile' | 'api-key';
  profile?: string;
  apiKey?: string;
}

export interface ProviderConnectionFactories {
  createLLM?: (
    connection: ProviderConnectionConfig,
  ) => ILLMProvider | null | undefined;
  createEmbedding?: (
    connection: ProviderConnectionConfig,
  ) => IEmbeddingProvider | null | undefined;
  createVectorDb?: (
    connection: ProviderConnectionConfig,
  ) => IVectorDbProvider | null | undefined;
}

const connectionFactoryRegistry = new Map<
  string,
  ProviderConnectionFactories
>();

function registerConnectionFactory(
  type: string,
  factories: ProviderConnectionFactories,
): void {
  const existing = connectionFactoryRegistry.get(type) ?? {};
  connectionFactoryRegistry.set(type, {
    ...existing,
    ...factories,
  });
}

function getConnectionFactory(
  type: string,
): ProviderConnectionFactories | undefined {
  return connectionFactoryRegistry.get(type);
}

export function createLLMProvider(
  conn: ProviderConnectionConfig,
): ILLMProvider | null {
  return getConnectionFactory(conn.type)?.createLLM?.(conn) ?? null;
}

export function createVectorDbProvider(
  conn: ProviderConnectionConfig,
): IVectorDbProvider | null {
  return getConnectionFactory(conn.type)?.createVectorDb?.(conn) ?? null;
}

export function createEmbeddingProvider(
  conn: ProviderConnectionConfig,
): IEmbeddingProvider | null {
  return getConnectionFactory(conn.type)?.createEmbedding?.(conn) ?? null;
}

registerConnectionFactory('ollama', {
  createLLM: (conn) => new OllamaLLMProvider(conn.config as OllamaConfig),
  createEmbedding: (conn) =>
    new OllamaEmbeddingProvider(conn.config as OllamaConfig),
});

registerConnectionFactory('openai-compat', {
  createLLM: (conn) =>
    new OpenAICompatLLMProvider(conn.config as unknown as OpenAICompatConfig),
  createEmbedding: (conn) =>
    new OpenAICompatEmbeddingProvider(
      conn.config as unknown as OpenAICompatConfig,
    ),
});

registerConnectionFactory('bedrock', {
  createLLM: (conn) =>
    new BedrockLLMProvider(conn.config as unknown as BedrockProviderConfig),
  createEmbedding: (conn) =>
    new BedrockEmbeddingProvider(
      conn.config as unknown as BedrockEmbeddingConfig,
    ),
});

registerConnectionFactory('anthropic', {
  createLLM: (conn) =>
    new AnthropicLLMProvider(conn.config as unknown as ApiKeyProviderConfig),
});

registerConnectionFactory('google', {
  createLLM: (conn) =>
    new GoogleLLMProvider(conn.config as unknown as ApiKeyProviderConfig),
});

registerConnectionFactory('lancedb', {
  createVectorDb: (conn) => new LanceDBProvider(conn.config as LanceDBConfig),
});

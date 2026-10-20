import { describe, expect, test } from 'vitest';
import { BedrockEmbeddingProvider } from '../../providers/llm/bedrock-embedding-provider.js';
import { OllamaEmbeddingProvider } from '../../providers/llm/ollama-provider.js';
import { OpenAICompatEmbeddingProvider } from '../../providers/llm/openai-compat-provider.js';
import { knowledgeEmbeddingIdentity } from '../embedding-identity.js';

describe('knowledgeEmbeddingIdentity (#2727)', () => {
  test('a same-width model change changes the identity of every built-in embedder', () => {
    const pairs = [
      [
        new OpenAICompatEmbeddingProvider({
          baseUrl: 'https://example.test/v1',
          model: 'embed-a',
        }),
        new OpenAICompatEmbeddingProvider({
          baseUrl: 'https://example.test/v1',
          model: 'embed-b',
        }),
      ],
      [
        new OllamaEmbeddingProvider({ model: 'embed-a' }),
        new OllamaEmbeddingProvider({ model: 'embed-b' }),
      ],
      [
        new BedrockEmbeddingProvider({ embeddingModel: 'embed-a' }),
        new BedrockEmbeddingProvider({ embeddingModel: 'embed-b' }),
      ],
    ];
    for (const [a, b] of pairs) {
      expect(a.dimensions()).toBe(b.dimensions());
      expect(knowledgeEmbeddingIdentity(a)).not.toBe(
        knowledgeEmbeddingIdentity(b),
      );
    }
  });

  test('credentials and endpoints never enter the identity', () => {
    const withSecret = new OpenAICompatEmbeddingProvider({
      baseUrl: 'https://user:password@one.example.test/v1',
      apiKey: 'sk-secret-value',
      model: 'embed-a',
    });
    const otherEndpoint = new OpenAICompatEmbeddingProvider({
      baseUrl: 'https://two.example.test/v1',
      model: 'embed-a',
    });
    const identity = knowledgeEmbeddingIdentity(withSecret);
    expect(identity).toBe(knowledgeEmbeddingIdentity(otherEndpoint));
    for (const secret of ['sk-secret-value', 'password', 'example.test']) {
      expect(identity).not.toContain(secret);
    }
    const bedrock = new BedrockEmbeddingProvider({
      authMode: 'api-key',
      apiKey: 'bedrock-secret',
      region: 'us-west-2',
    });
    expect(knowledgeEmbeddingIdentity(bedrock)).not.toContain('bedrock-secret');
  });

  test('an embedder without a declared identity falls back to its provider id and width', () => {
    expect(
      knowledgeEmbeddingIdentity({
        id: 'custom-embedder',
        displayName: 'Custom',
        dimensions: () => 8,
        embed: async () => [],
      }),
    ).toBe('provider=custom-embedder|dimensions=8');
  });
});

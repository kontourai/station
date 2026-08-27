import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import { describe, expect, test } from 'vitest';
import {
  redactConnectionSecrets,
  restoreConnectionSecrets,
} from '../provider-secrets.js';

function model(config: Record<string, unknown>): ConnectionConfig {
  return {
    id: 'litellm-work',
    kind: 'model',
    type: 'openai-compat',
    name: 'LiteLLM',
    enabled: true,
    status: 'ready',
    capabilities: ['llm'],
    prerequisites: [],
    config,
  };
}

describe('provider response secrets', () => {
  test('returns only a configured marker, never the saved value', () => {
    expect(
      redactConnectionSecrets(
        model({
          baseUrl: 'http://localhost:4000/v1',
          apiKey: 'sk-must-not-escape',
        }),
      ).config,
    ).toEqual({
      baseUrl: 'http://localhost:4000/v1',
      apiKeyConfigured: true,
    });
  });

  test('preserves the saved secret through an unrelated edit', () => {
    const existing = model({ apiKey: 'sk-saved', baseUrl: 'https://old.test' });
    const incoming = model({
      apiKeyConfigured: true,
      baseUrl: 'https://new.test',
    });

    expect(restoreConnectionSecrets(incoming, existing).config).toEqual({
      apiKey: 'sk-saved',
      baseUrl: 'https://new.test',
    });
  });

  test('replaces the saved secret only when a new value is supplied', () => {
    const existing = model({ apiKey: 'sk-saved' });
    const incoming = model({
      apiKeyConfigured: true,
      apiKey: ' sk-replacement ',
    });

    expect(restoreConnectionSecrets(incoming, existing).config).toEqual({
      apiKey: 'sk-replacement',
    });
  });

  test('removes a saved secret only when the client explicitly requests it', () => {
    const existing = model({ apiKey: 'sk-saved', baseUrl: 'https://old.test' });
    const incoming = model({
      apiKeyConfigured: true,
      apiKeyClearRequested: true,
      baseUrl: 'https://new.test',
    });

    expect(restoreConnectionSecrets(incoming, existing).config).toEqual({
      baseUrl: 'https://new.test',
    });
  });
});

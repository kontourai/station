import { describe, expect, test } from 'vitest';
import type { ProviderConnection } from '../views/provider-settings/types';
import {
  capabilitiesForType,
  defaultConfig,
  describeProvider,
  filterModelProviders,
  finalizeConnectionConfig,
  isConnectionConfigValid,
} from '../views/provider-settings/utils';

const providers: ProviderConnection[] = [
  {
    id: 'bedrock',
    kind: 'model',
    type: 'bedrock',
    name: 'AWS Bedrock',
    config: {},
    enabled: true,
    capabilities: ['llm', 'embedding'],
    status: 'ready',
    prerequisites: [],
    lastCheckedAt: null,
  },
  {
    id: 'vector-only',
    kind: 'model',
    type: 'custom',
    name: 'Vector Only',
    config: {},
    enabled: true,
    capabilities: ['vectordb'],
    status: 'ready',
    prerequisites: [],
    lastCheckedAt: null,
  },
];

describe('provider-settings utils', () => {
  test('capabilitiesForType and defaultConfig reflect provider defaults', () => {
    expect(capabilitiesForType('bedrock')).toEqual(['llm', 'embedding']);
    expect(capabilitiesForType('custom')).toEqual(['llm']);
    expect(defaultConfig('ollama')).toEqual({
      baseUrl: 'http://localhost:11434',
    });
  });

  test('filterModelProviders searches the inventory it is given', () => {
    // station#3747: membership is the model inventory route's answer now
    // (`isLlmModelConnection`, asserted at the service), so this helper only
    // searches. It used to re-derive membership here, and a second derivation
    // of a server fact is exactly what that issue removed.
    expect(filterModelProviders(providers, '')).toHaveLength(2);
    expect(filterModelProviders(providers, 'aws')).toHaveLength(1);
    expect(filterModelProviders(providers, 'aws')[0]?.id).toBe('bedrock');
  });

  test('describeProvider formats a sidebar label', () => {
    expect(describeProvider(providers[0])).toEqual({
      name: 'AWS Bedrock',
      subtitle: 'LLM · EMBEDDING · Amazon Bedrock',
    });
  });
});

// LOW-1 / TESTS(d) (review fix round): the persisted config must OMIT the
// fields the selected authMode doesn't use, not merely empty them.
describe('finalizeConnectionConfig — Bedrock auth-mode persistence', () => {
  test('chain mode omits authMode, profile, and apiKey entirely', () => {
    expect(
      finalizeConnectionConfig('bedrock', {
        region: 'us-east-1',
        authMode: 'chain',
        profile: '',
        apiKey: '',
      }),
    ).toEqual({ region: 'us-east-1' });
  });

  test('profile mode keeps authMode + trimmed profile, omits apiKey', () => {
    expect(
      finalizeConnectionConfig('bedrock', {
        region: 'us-east-1',
        authMode: 'profile',
        profile: '  work  ',
        apiKey: 'leftover-from-a-previous-mode',
      }),
    ).toEqual({ region: 'us-east-1', authMode: 'profile', profile: 'work' });
  });

  test('profile mode with a blank profile omits the field rather than persisting an empty string', () => {
    expect(
      finalizeConnectionConfig('bedrock', {
        region: 'us-east-1',
        authMode: 'profile',
        profile: '   ',
      }),
    ).toEqual({ region: 'us-east-1', authMode: 'profile' });
  });

  test('api-key mode keeps authMode + trimmed apiKey, omits profile', () => {
    expect(
      finalizeConnectionConfig('bedrock', {
        region: 'us-east-1',
        authMode: 'api-key',
        profile: 'leftover-from-a-previous-mode',
        apiKey: '  bedrock-key-abc  ',
      }),
    ).toEqual({
      region: 'us-east-1',
      authMode: 'api-key',
      apiKey: 'bedrock-key-abc',
    });
  });

  test('is a no-op for non-bedrock connection types', () => {
    expect(
      finalizeConnectionConfig('openai-compat', {
        baseUrl: 'https://api.example.test',
        apiKey: 'sk-example',
      }),
    ).toEqual({ baseUrl: 'https://api.example.test', apiKey: 'sk-example' });
  });
});

// HIGH-2 (review fix round): Save must be blocked when the selected auth
// mode's required field is empty — never silently persisted as chain auth.
describe('isConnectionConfigValid — Bedrock auth-mode required fields', () => {
  test('chain mode is always valid', () => {
    expect(isConnectionConfigValid('bedrock', { region: 'us-east-1' })).toBe(
      true,
    );
  });

  test('profile mode requires a non-blank profile', () => {
    expect(
      isConnectionConfigValid('bedrock', {
        authMode: 'profile',
        profile: 'work',
      }),
    ).toBe(true);
    expect(isConnectionConfigValid('bedrock', { authMode: 'profile' })).toBe(
      false,
    );
    expect(
      isConnectionConfigValid('bedrock', {
        authMode: 'profile',
        profile: '   ',
      }),
    ).toBe(false);
  });

  test('api-key mode requires a non-blank apiKey', () => {
    expect(
      isConnectionConfigValid('bedrock', {
        authMode: 'api-key',
        apiKey: 'bedrock-key-abc',
      }),
    ).toBe(true);
    expect(isConnectionConfigValid('bedrock', { authMode: 'api-key' })).toBe(
      false,
    );
    expect(
      isConnectionConfigValid('bedrock', {
        authMode: 'api-key',
        apiKeyConfigured: true,
      }),
    ).toBe(true);
    expect(
      isConnectionConfigValid('bedrock', {
        authMode: 'api-key',
        apiKeyConfigured: true,
        apiKeyClearRequested: true,
      }),
    ).toBe(false);
  });

  test('is always valid for non-bedrock connection types', () => {
    expect(isConnectionConfigValid('ollama', {})).toBe(true);
  });
});

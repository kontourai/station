import { describe, expect, test } from 'vitest';
import type { ProviderConnection } from '../views/provider-settings/types';
import {
  mergeServerIntoEdit,
  WHOLE_CONFIG_DIRTY,
} from '../views/provider-settings/utils';

type Editable = Omit<ProviderConnection, 'id'>;

function connection(overrides: Partial<Editable> = {}): Editable {
  return {
    kind: 'model',
    type: 'ollama',
    name: 'Local Ollama',
    config: { baseUrl: 'http://localhost:11434' },
    enabled: true,
    capabilities: ['llm'],
    status: 'ready',
    prerequisites: [],
    lastCheckedAt: null,
    ...overrides,
  } as Editable;
}

describe('mergeServerIntoEdit (#794)', () => {
  test('with nothing edited, server state wins outright', () => {
    const server = connection({ name: 'Renamed elsewhere' });
    const edit = connection();

    expect(mergeServerIntoEdit(server, edit, new Set())).toEqual(server);
  });

  test('an edited config field survives a refetch that does not have it yet', () => {
    const server = connection();
    const edit = connection({
      config: { baseUrl: 'http://localhost:11434', defaultModel: 'qwen3:30b' },
    });

    const merged = mergeServerIntoEdit(
      server,
      edit,
      new Set(['config.defaultModel']),
    );

    expect(merged.config.defaultModel).toBe('qwen3:30b');
  });

  test('untouched fields still track the server while another field is dirty', () => {
    const server = connection({
      name: 'Renamed elsewhere',
      enabled: false,
      config: { baseUrl: 'http://elsewhere:11434' },
    });
    const edit = connection({
      config: { baseUrl: 'http://localhost:11434', defaultModel: 'qwen3:30b' },
    });

    const merged = mergeServerIntoEdit(
      server,
      edit,
      new Set(['config.defaultModel']),
    );

    // The point of merging rather than ignoring: the user only touched the
    // model, so everything else picks up what changed server-side.
    expect(merged.name).toBe('Renamed elsewhere');
    expect(merged.enabled).toBe(false);
    expect(merged.config.baseUrl).toBe('http://elsewhere:11434');
    expect(merged.config.defaultModel).toBe('qwen3:30b');
  });

  test('an edited top-level field survives while config tracks the server', () => {
    const server = connection({
      name: 'Renamed elsewhere',
      config: { baseUrl: 'http://elsewhere:11434' },
    });
    const edit = connection({ name: 'My Ollama' });

    const merged = mergeServerIntoEdit(server, edit, new Set(['name']));

    expect(merged.name).toBe('My Ollama');
    expect(merged.config.baseUrl).toBe('http://elsewhere:11434');
  });

  test('a client-side clear stays cleared instead of resurrecting from the server', () => {
    // Editing baseUrl drops modelOptions. A refetch must not put them back.
    const server = connection({
      config: {
        baseUrl: 'http://localhost:11434',
        modelOptions: [{ id: 'llama3.2', name: 'Llama 3.2' }],
      },
    });
    const edit = connection({
      config: { baseUrl: 'http://newhost:11434', defaultModel: '' },
    });

    const merged = mergeServerIntoEdit(
      server,
      edit,
      new Set(['config.baseUrl', 'config.defaultModel', 'config.modelOptions']),
    );

    expect(merged.config.baseUrl).toBe('http://newhost:11434');
    expect(merged.config.defaultModel).toBe('');
    expect('modelOptions' in merged.config).toBe(false);
  });

  test('a provider-type change keeps the whole edited config', () => {
    const server = connection({
      type: 'ollama',
      config: { baseUrl: 'http://localhost:11434' },
    });
    const edit = connection({
      type: 'bedrock',
      config: { region: 'us-east-1' },
    });

    const merged = mergeServerIntoEdit(
      server,
      edit,
      new Set(['type', WHOLE_CONFIG_DIRTY]),
    );

    expect(merged.type).toBe('bedrock');
    expect(merged.config).toEqual({ region: 'us-east-1' });
  });

  test('does not mutate either input', () => {
    const server = connection();
    const edit = connection({
      config: { baseUrl: 'http://localhost:11434', defaultModel: 'qwen3:30b' },
    });
    const serverSnapshot = structuredClone(server);
    const editSnapshot = structuredClone(edit);

    mergeServerIntoEdit(server, edit, new Set(['config.defaultModel']));

    expect(server).toEqual(serverSnapshot);
    expect(edit).toEqual(editSnapshot);
  });
});

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  providerOps: { add: vi.fn() },
}));
vi.mock('../../../providers/connection-factories.js', () => ({
  createLLMProvider: vi.fn(),
}));

const { ProviderService, providerTypeLabel } = await import(
  '../provider-service.js'
);
const { createLLMProvider } = await import(
  '../../../providers/connection-factories.js'
);

beforeEach(() => {
  vi.mocked(createLLMProvider).mockReset();
});

function createMockStorageAdapter() {
  const connections: any[] = [];
  return {
    listProviderConnections: vi.fn(() => connections),
    saveProviderConnection: vi.fn((c: any) => connections.push(c)),
    deleteProviderConnection: vi.fn((id: string) => {
      const idx = connections.findIndex((c) => c.id === id);
      if (idx >= 0) connections.splice(idx, 1);
    }),
    getProject: vi.fn().mockResolvedValue({
      defaultProviderId: 'bedrock',
      defaultModel: 'claude-3',
    }),
    listProjects: vi.fn(() => []),
  };
}

describe('ProviderService', () => {
  test('listProviderConnections delegates', () => {
    const adapter = createMockStorageAdapter();
    const svc = new ProviderService(
      adapter as any,
      async () =>
        ({ defaultLLMProvider: 'bedrock', defaultModel: 'claude-3' }) as any,
    );
    svc.listProviderConnections();
    expect(adapter.listProviderConnections).toHaveBeenCalled();
  });

  test('saveProviderConnection persists', async () => {
    const adapter = createMockStorageAdapter();
    const svc = new ProviderService(adapter as any, async () => ({}) as any);
    await svc.saveProviderConnection({ id: 'p1', type: 'bedrock' } as any);
    expect(adapter.saveProviderConnection).toHaveBeenCalledWith({
      id: 'p1',
      type: 'bedrock',
    });
  });

  test('publishes a launchability revision only after a provider mutation commits', async () => {
    const adapter = createMockStorageAdapter();
    const svc = new ProviderService(adapter as any, async () => ({}) as any);
    const revisions: number[] = [];
    const unsubscribe = svc.onLaunchabilityChange((revision) => {
      revisions.push(revision);
    });

    await svc.saveProviderConnection({ id: 'p1', type: 'bedrock' } as any);
    await svc.deleteProviderConnection('p1');
    unsubscribe();
    await svc.saveProviderConnection({ id: 'p2', type: 'ollama' } as any);

    expect(revisions).toEqual([1, 2]);
    expect(svc.getLaunchabilityRevision()).toBe(3);
  });

  test('detects provider changes committed outside ProviderService', () => {
    const adapter = createMockStorageAdapter();
    const svc = new ProviderService(adapter as any, async () => ({}) as any);
    expect(svc.getLaunchabilityRevision()).toBe(0);

    adapter.saveProviderConnection({
      id: 'external',
      type: 'ollama',
      enabled: true,
      capabilities: ['llm'],
      config: {},
    });

    expect(svc.getLaunchabilityRevision()).toBe(1);
  });

  test('captures provider connections and their revision from one read', () => {
    const adapter = createMockStorageAdapter();
    adapter.saveProviderConnection({ id: 'a', type: 'ollama' });
    const svc = new ProviderService(adapter as any, async () => ({}) as any);

    expect(svc.captureLaunchabilitySnapshot()).toEqual({
      revision: 0,
      connections: [{ id: 'a', type: 'ollama' }],
    });
    expect(adapter.listProviderConnections).toHaveBeenCalledTimes(1);
  });

  test('retains only a digest of credential-bearing provider state', () => {
    const adapter = createMockStorageAdapter();
    adapter.saveProviderConnection({
      id: 'secret-provider',
      type: 'custom',
      config: { apiKey: ['must-not-remain', 'in-fingerprint'].join('-') },
    });
    const svc = new ProviderService(adapter as any, async () => ({}) as any);

    svc.captureLaunchabilitySnapshot();

    const fingerprint = (svc as any).providerConnectionsFingerprint as string;
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain('must-not-remain-in-fingerprint');
  });

  test('invalidates launchability before rejecting malformed external provider config', () => {
    const adapter = createMockStorageAdapter();
    const svc = new ProviderService(adapter as any, async () => ({}) as any);
    expect(svc.getLaunchabilityRevision()).toBe(0);
    const listener = vi.fn();
    svc.onLaunchabilityChange(listener);
    adapter.listProviderConnections.mockImplementation(() => {
      throw new Error('provider config malformed');
    });

    expect(() => svc.getLaunchabilityRevision()).toThrow(
      'provider config malformed',
    );
    expect(listener).toHaveBeenCalledWith(1);
  });

  test('does not advance launchability revision when persistence fails', async () => {
    const adapter = createMockStorageAdapter();
    adapter.saveProviderConnection.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const svc = new ProviderService(adapter as any, async () => ({}) as any);
    const listener = vi.fn();
    svc.onLaunchabilityChange(listener);

    await expect(
      svc.saveProviderConnection({ id: 'p1', type: 'bedrock' } as any),
    ).rejects.toThrow('disk full');
    expect(listener).not.toHaveBeenCalled();
    expect(svc.getLaunchabilityRevision()).toBe(0);
  });

  test('does not let a revision listener fail a committed provider mutation', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const adapter = createMockStorageAdapter();
    const svc = new ProviderService(adapter as any, async () => ({}) as any);
    const laterListener = vi.fn();
    svc.onLaunchabilityChange(() => {
      throw new Error('listener failed');
    });
    svc.onLaunchabilityChange(laterListener);

    await expect(
      svc.saveProviderConnection({ id: 'p1', type: 'bedrock' } as any),
    ).resolves.toBeUndefined();
    expect(adapter.saveProviderConnection).toHaveBeenCalled();
    expect(svc.getLaunchabilityRevision()).toBe(1);
    expect(laterListener).toHaveBeenCalledWith(1);
    expect(debug).toHaveBeenCalledWith(
      'Launchability revision listener failed.',
    );
  });

  test('deleteProviderConnection removes', () => {
    const adapter = createMockStorageAdapter();
    const svc = new ProviderService(adapter as any, async () => ({}) as any);
    svc.deleteProviderConnection('p1');
    expect(adapter.deleteProviderConnection).toHaveBeenCalledWith('p1');
  });

  test('resolveProvider uses conversation-level override', async () => {
    const adapter = createMockStorageAdapter();
    adapter.saveProviderConnection({
      id: 'openai',
      type: 'openai-compat',
      enabled: true,
      capabilities: ['llm'],
      config: {},
    });
    vi.mocked(createLLMProvider).mockReturnValue({
      listModels: vi.fn(async () => [{ id: 'gpt-4', name: 'GPT-4' }]),
    } as any);
    const svc = new ProviderService(adapter as any, async () => ({}) as any);
    const result = await svc.resolveProvider({
      conversationProviderId: 'openai',
      conversationModel: 'gpt-4',
    });
    expect(result).toEqual({ providerId: 'openai', model: 'gpt-4' });
  });

  test('resolveProvider rejects partial conversation overrides', async () => {
    const adapter = createMockStorageAdapter();
    const svc = new ProviderService(adapter as any, async () => ({}) as any);

    await expect(
      svc.resolveProvider({ conversationProviderId: 'openai' }),
    ).rejects.toThrow('must be supplied together');
    expect(createLLMProvider).not.toHaveBeenCalled();
  });

  describe('resolveProvider allowModelOnlyFallback (#1288)', () => {
    // Round-2 review finding: resolveDefaultProviderId's project leg must
    // require BOTH defaultProviderId AND defaultModel, exactly like the
    // sibling no-override cascade a few lines below — otherwise a project
    // with only a defaultProviderId set (unreachable via today's UI, but
    // readable from hand-edited config) would resolve a DIFFERENT
    // connection through the model-only fallback than the no-override path
    // would, contradicting the parity this helper exists to guarantee.
    test('a project with defaultProviderId but no defaultModel falls through to the app default, not the project connection', async () => {
      const adapter = createMockStorageAdapter();
      adapter.getProject.mockResolvedValue({
        defaultProviderId: 'bedrock',
        // defaultModel intentionally absent — the project leg must be
        // skipped, not partially honored.
      });
      adapter.saveProviderConnection({
        id: 'bedrock',
        type: 'bedrock',
        enabled: true,
        capabilities: ['llm'],
        config: {},
      });
      adapter.saveProviderConnection({
        id: 'ollama-local',
        type: 'ollama',
        enabled: true,
        capabilities: ['llm'],
        config: {},
      });
      vi.mocked(createLLMProvider).mockReturnValue({
        listModels: vi.fn(async () => [
          { id: 'qwen3-coder:latest', name: 'Qwen3 Coder' },
        ]),
      } as any);
      const svc = new ProviderService(
        adapter as any,
        async () => ({ defaultLLMProvider: 'ollama-local' }) as any,
      );

      await expect(
        svc.resolveProvider({
          conversationModel: 'qwen3-coder:latest',
          projectSlug: 'proj-1',
          allowModelOnlyFallback: true,
        }),
      ).resolves.toEqual({
        providerId: 'ollama-local',
        model: 'qwen3-coder:latest',
      });
    });

    test('multiple enabled connections with no app default hits the ambiguity guard through the model-only path', async () => {
      const adapter = createMockStorageAdapter();
      adapter.getProject.mockRejectedValue(new Error('not found'));
      for (const id of ['provider-a', 'provider-b']) {
        adapter.saveProviderConnection({
          id,
          type: 'ollama',
          enabled: true,
          capabilities: ['llm'],
          config: {},
        });
      }
      const svc = new ProviderService(adapter as any, async () => ({}) as any);

      await expect(
        svc.resolveProvider({
          conversationModel: 'qwen3-coder:latest',
          projectSlug: 'missing',
          allowModelOnlyFallback: true,
        }),
      ).rejects.toThrow('require an application default');
      expect(createLLMProvider).not.toHaveBeenCalled();
    });
  });

  test('resolveProvider falls back to project config', async () => {
    const adapter = createMockStorageAdapter();
    adapter.saveProviderConnection({
      id: 'bedrock',
      type: 'bedrock',
      enabled: true,
      capabilities: ['llm'],
      config: {},
    });
    vi.mocked(createLLMProvider).mockReturnValue({
      listModels: vi.fn(async () => [{ id: 'claude-3', name: 'Claude 3' }]),
    } as any);
    const svc = new ProviderService(adapter as any, async () => ({}) as any);
    const result = await svc.resolveProvider({ projectSlug: 'my-project' });
    expect(result).toEqual({ providerId: 'bedrock', model: 'claude-3' });
  });

  test('resolveProvider falls back to app config', async () => {
    const adapter = createMockStorageAdapter();
    adapter.getProject.mockRejectedValue(new Error('not found'));
    adapter.saveProviderConnection({
      id: 'anthropic',
      type: 'anthropic',
      enabled: true,
      capabilities: ['llm'],
      config: {},
    });
    vi.mocked(createLLMProvider).mockReturnValue({
      listModels: vi.fn(async () => [{ id: 'claude-3.5', name: 'Claude 3.5' }]),
    } as any);
    const svc = new ProviderService(
      adapter as any,
      async () =>
        ({
          defaultLLMProvider: 'anthropic',
          defaultModel: 'claude-3.5',
        }) as any,
    );
    const result = await svc.resolveProvider({ projectSlug: 'missing' });
    expect(result).toEqual({ providerId: 'anthropic', model: 'claude-3.5' });
  });

  test('resolveProvider uses the only enabled application provider without ranking', async () => {
    const adapter = createMockStorageAdapter();
    adapter.getProject.mockRejectedValue(new Error('not found'));
    adapter.saveProviderConnection({
      id: 'ollama-local',
      type: 'ollama',
      enabled: true,
      capabilities: ['llm'],
    });
    const svc = new ProviderService(
      adapter as any,
      async () =>
        ({
          defaultModel: 'llama3.2',
        }) as any,
    );
    vi.mocked(createLLMProvider).mockReturnValue({
      listModels: vi.fn(async () => [{ id: 'llama3.2', name: 'Llama 3.2' }]),
    } as any);

    await expect(
      svc.resolveProvider({ projectSlug: 'missing' }),
    ).resolves.toEqual({ providerId: 'ollama-local', model: 'llama3.2' });
  });

  test('resolveProvider uses the sole connection default when the application model is blank', async () => {
    const adapter = createMockStorageAdapter();
    adapter.saveProviderConnection({
      id: 'ollama-local',
      type: 'ollama',
      enabled: true,
      capabilities: ['llm'],
      config: { defaultModel: 'qwen3:30b' },
    });
    vi.mocked(createLLMProvider).mockReturnValue({
      listModels: vi.fn(async () => [{ id: 'qwen3:30b', name: 'Qwen 3 30B' }]),
    } as any);
    const svc = new ProviderService(
      adapter as any,
      async () => ({ defaultModel: '' }) as any,
    );

    await expect(svc.resolveProvider({})).resolves.toEqual({
      providerId: 'ollama-local',
      model: 'qwen3:30b',
    });
  });

  test('resolveProvider rejects ambiguous application providers', async () => {
    const adapter = createMockStorageAdapter();
    adapter.getProject.mockRejectedValue(new Error('not found'));
    for (const id of ['provider-a', 'provider-b']) {
      adapter.saveProviderConnection({
        id,
        type: 'ollama',
        enabled: true,
        capabilities: ['llm'],
        config: {},
      });
    }
    const svc = new ProviderService(
      adapter as any,
      async () => ({ defaultModel: 'model-a' }) as any,
    );

    await expect(
      svc.resolveProvider({ projectSlug: 'missing' }),
    ).rejects.toThrow('require an application default');
    expect(createLLMProvider).not.toHaveBeenCalled();
  });

  test('resolveProvider rejects an application model without an enabled provider', async () => {
    const adapter = createMockStorageAdapter();
    adapter.getProject.mockRejectedValue(new Error('not found'));
    const svc = new ProviderService(
      adapter as any,
      async () => ({ defaultModel: 'model-a' }) as any,
    );

    await expect(
      svc.resolveProvider({ projectSlug: 'missing' }),
    ).rejects.toThrow('default LLM provider and model must be configured');
    expect(createLLMProvider).not.toHaveBeenCalled();
  });

  test('resolveProvider rejects an unsupported model instead of selecting the first available model', async () => {
    const adapter = createMockStorageAdapter();
    adapter.getProject.mockRejectedValue(new Error('not found'));
    adapter.saveProviderConnection({
      id: 'ollama-local',
      type: 'ollama',
      name: 'Ollama',
      enabled: true,
      capabilities: ['llm'],
      config: {},
    });
    const svc = new ProviderService(
      adapter as any,
      async () =>
        ({
          defaultLLMProvider: 'ollama-local',
          defaultModel: 'us.anthropic.claude-sonnet-4-6',
        }) as any,
    );
    vi.mocked(createLLMProvider).mockReturnValue({
      listModels: vi.fn(async () => [{ id: 'llama3.2', name: 'Llama 3.2' }]),
    } as any);

    await expect(
      svc.resolveProvider({ projectSlug: 'missing' }),
    ).rejects.toThrow('is not launchable for this provider');
  });

  test('resolveProvider throws when a non-bedrock provider has no available models', async () => {
    const adapter = createMockStorageAdapter();
    adapter.getProject.mockRejectedValue(new Error('not found'));
    adapter.saveProviderConnection({
      id: 'ollama-local',
      type: 'ollama',
      name: 'Ollama',
      enabled: true,
      capabilities: ['llm'],
      config: {},
    });
    const svc = new ProviderService(
      adapter as any,
      async () =>
        ({
          defaultLLMProvider: 'ollama-local',
          defaultModel: 'us.anthropic.claude-sonnet-4-6',
        }) as any,
    );
    vi.mocked(createLLMProvider).mockReturnValue({
      listModels: vi.fn(async () => []),
    } as any);

    await expect(
      svc.resolveProvider({ projectSlug: 'missing' }),
    ).rejects.toThrow('is not launchable for this provider');
  });

  test('checkHealth returns provider health', async () => {
    const adapter = createMockStorageAdapter();
    const svc = new ProviderService(adapter as any, async () => ({}) as any);
    const provider = { healthCheck: vi.fn().mockResolvedValue(true) };
    expect(await svc.checkHealth(provider as any, 'test')).toBe(true);
  });

  describe('findDuplicateConnection (#191 R5)', () => {
    test('rejects a second enabled Ollama connection at the same baseUrl', () => {
      const adapter = createMockStorageAdapter();
      adapter.saveProviderConnection({
        id: 'ollama-1',
        type: 'ollama',
        name: 'Ollama',
        enabled: true,
        capabilities: ['llm'],
        config: { baseUrl: 'http://127.0.0.1:11434' },
      });
      const svc = new ProviderService(adapter as any, async () => ({}) as any);

      const duplicate = svc.findDuplicateConnection('ollama', {
        baseUrl: 'http://127.0.0.1:11434',
      });

      expect(duplicate?.id).toBe('ollama-1');
    });

    test('treats trailing slashes and case as the same identity', () => {
      const adapter = createMockStorageAdapter();
      adapter.saveProviderConnection({
        id: 'ollama-1',
        type: 'ollama',
        name: 'Ollama',
        enabled: true,
        capabilities: ['llm'],
        config: { baseUrl: 'HTTP://127.0.0.1:11434/' },
      });
      const svc = new ProviderService(adapter as any, async () => ({}) as any);

      const duplicate = svc.findDuplicateConnection('ollama', {
        baseUrl: 'http://127.0.0.1:11434',
      });

      expect(duplicate?.id).toBe('ollama-1');
    });

    test('defaults an unset baseUrl to the default Ollama endpoint on both sides', () => {
      const adapter = createMockStorageAdapter();
      adapter.saveProviderConnection({
        id: 'ollama-1',
        type: 'ollama',
        name: 'Ollama',
        enabled: true,
        capabilities: ['llm'],
        config: {},
      });
      const svc = new ProviderService(adapter as any, async () => ({}) as any);

      const duplicate = svc.findDuplicateConnection('ollama', {});

      expect(duplicate?.id).toBe('ollama-1');
    });

    test('allows a distinct baseUrl to create', () => {
      const adapter = createMockStorageAdapter();
      adapter.saveProviderConnection({
        id: 'ollama-1',
        type: 'ollama',
        name: 'Ollama',
        enabled: true,
        capabilities: ['llm'],
        config: { baseUrl: 'http://127.0.0.1:11434' },
      });
      const svc = new ProviderService(adapter as any, async () => ({}) as any);

      const duplicate = svc.findDuplicateConnection('ollama', {
        baseUrl: 'http://remote-host:11434',
      });

      expect(duplicate).toBeUndefined();
    });

    test('ignores a disabled connection at the same baseUrl', () => {
      const adapter = createMockStorageAdapter();
      adapter.saveProviderConnection({
        id: 'ollama-1',
        type: 'ollama',
        name: 'Ollama',
        enabled: false,
        capabilities: ['llm'],
        config: { baseUrl: 'http://127.0.0.1:11434' },
      });
      const svc = new ProviderService(adapter as any, async () => ({}) as any);

      const duplicate = svc.findDuplicateConnection('ollama', {
        baseUrl: 'http://127.0.0.1:11434',
      });

      expect(duplicate).toBeUndefined();
    });

    test('does not check identity for non-host-identified provider types', () => {
      const adapter = createMockStorageAdapter();
      adapter.saveProviderConnection({
        id: 'bedrock-1',
        type: 'bedrock',
        name: 'Bedrock',
        enabled: true,
        capabilities: ['llm'],
        config: {},
      });
      const svc = new ProviderService(adapter as any, async () => ({}) as any);

      const duplicate = svc.findDuplicateConnection('bedrock', {});

      expect(duplicate).toBeUndefined();
    });

    test('an update (PUT-equivalent save of an already-persisted connection) is never blocked by the check', () => {
      const adapter = createMockStorageAdapter();
      adapter.saveProviderConnection({
        id: 'ollama-1',
        type: 'ollama',
        name: 'Ollama',
        enabled: true,
        capabilities: ['llm'],
        config: { baseUrl: 'http://127.0.0.1:11434' },
      });
      const svc = new ProviderService(adapter as any, async () => ({}) as any);

      // The PUT route never calls findDuplicateConnection at all — this test
      // documents that saveProviderConnection itself has no dedup gate, so
      // renaming/re-saving an existing row always succeeds.
      expect(() =>
        svc.saveProviderConnection({
          id: 'ollama-1',
          type: 'ollama',
          name: 'Ollama (renamed)',
          enabled: true,
          capabilities: ['llm'],
          config: { baseUrl: 'http://127.0.0.1:11434' },
        } as any),
      ).not.toThrow();
    });
  });

  // #191 code-review M2: the dedup-conflict message must not hardcode a
  // single provider name, since HOST_IDENTIFIED_PROVIDER_TYPES is designed
  // to grow beyond Ollama.
  describe('providerTypeLabel (#191 code-review M2)', () => {
    test('title-cases a simple provider type', () => {
      expect(providerTypeLabel('ollama')).toBe('Ollama');
    });

    test('title-cases each hyphen/underscore-separated segment', () => {
      expect(providerTypeLabel('openai-compat')).toBe('Openai Compat');
      expect(providerTypeLabel('some_type')).toBe('Some Type');
    });

    test('is generic across a future non-Ollama host-identified type', () => {
      // Simulates the plausible future Bedrock addition the code comment
      // names — the label must not say "Ollama" for it.
      expect(providerTypeLabel('bedrock')).toBe('Bedrock');
    });
  });
});

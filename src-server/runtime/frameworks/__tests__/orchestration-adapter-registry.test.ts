import { describe, expect, test, vi } from 'vitest';
import type { ProviderAdapterShape } from '../../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { withPrivateOrchestrationAdapter } from '../orchestration-adapter-registry.js';

function adapter(provider: string): ProviderAdapterShape {
  return {
    provider,
    metadata: {
      displayName: provider,
      description: provider,
      capabilities: [],
    },
    startSession: vi.fn(),
    sendTurn: vi.fn(),
    interruptTurn: vi.fn(),
    respondToRequest: vi.fn(),
    stopSession: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([]),
    hasSession: vi.fn().mockResolvedValue(false),
    stopAll: vi.fn(),
    streamEvents: vi.fn(),
  } as unknown as ProviderAdapterShape;
}

describe('withPrivateOrchestrationAdapter', () => {
  test('resolves the private adapter without publishing it to the public registry', () => {
    const codex = adapter('codex');
    const stationAgent = adapter('station-agent');
    const register = vi.fn();
    const unsubscribe = vi.fn();
    const onChange = vi.fn(() => unsubscribe);
    const publicRegistry: IProviderAdapterRegistry = {
      register,
      get: (provider) => (provider === codex.provider ? codex : undefined),
      list: () => [codex],
      onChange,
    };
    const registry = withPrivateOrchestrationAdapter(
      publicRegistry,
      stationAgent,
    );

    expect(registry.get('station-agent')).toBe(stationAgent);
    expect(registry.get('codex')).toBe(codex);
    expect(registry.list()).toEqual([codex, stationAgent]);
    expect(publicRegistry.list()).toEqual([codex]);
    expect(register).not.toHaveBeenCalled();
    const listener = vi.fn();
    expect(registry.onChange?.(listener)).toBe(unsubscribe);
    expect(onChange).toHaveBeenCalledWith(listener);
  });

  test('continues to publish plugin registrations through the public registry', () => {
    const stationAgent = adapter('station-agent');
    const register = vi.fn();
    const publicRegistry: IProviderAdapterRegistry = {
      register,
      get: () => undefined,
      list: () => [],
    };
    const registry = withPrivateOrchestrationAdapter(
      publicRegistry,
      stationAgent,
    );
    const plugin = adapter('plugin-provider');

    registry.register(plugin);
    expect(register).toHaveBeenCalledWith(plugin);
  });
});

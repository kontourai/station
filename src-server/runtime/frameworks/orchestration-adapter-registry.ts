import type { ProviderAdapterShape } from '../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../providers/provider-interfaces.js';

/**
 * Add orchestration-only adapters without publishing them through the global
 * provider registry that also feeds user-facing engine connection inventory.
 */
export function withPrivateOrchestrationAdapter(
  publicRegistry: IProviderAdapterRegistry,
  privateAdapters: ProviderAdapterShape | readonly ProviderAdapterShape[],
): IProviderAdapterRegistry {
  const adapters = Array.isArray(privateAdapters)
    ? privateAdapters
    : [privateAdapters];
  const privateByProvider = new Map(
    adapters.map((adapter) => [adapter.provider, adapter]),
  );
  return {
    register: (adapter) => publicRegistry.register(adapter),
    get: (provider) =>
      privateByProvider.get(provider) ?? publicRegistry.get(provider),
    list: () => [
      ...publicRegistry
        .list()
        .filter((adapter) => !privateByProvider.has(adapter.provider)),
      ...adapters,
    ],
    ...(publicRegistry.onChange
      ? { onChange: (listener) => publicRegistry.onChange!(listener) }
      : {}),
  };
}

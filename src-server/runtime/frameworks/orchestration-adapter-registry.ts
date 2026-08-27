import type { ProviderAdapterShape } from '../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../providers/provider-interfaces.js';

/**
 * Add one orchestration-only adapter without publishing it through the global
 * provider registry that also feeds user-facing engine connection inventory.
 */
export function withPrivateOrchestrationAdapter(
  publicRegistry: IProviderAdapterRegistry,
  privateAdapter: ProviderAdapterShape,
): IProviderAdapterRegistry {
  return {
    register: (adapter) => publicRegistry.register(adapter),
    get: (provider) =>
      provider === privateAdapter.provider
        ? privateAdapter
        : publicRegistry.get(provider),
    list: () => [
      ...publicRegistry
        .list()
        .filter((adapter) => adapter.provider !== privateAdapter.provider),
      privateAdapter,
    ],
    ...(publicRegistry.onChange
      ? { onChange: (listener) => publicRegistry.onChange!(listener) }
      : {}),
  };
}

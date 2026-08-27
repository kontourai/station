/**
 * The K2 adapter registry — additive, instance-scoped (one per `KnowledgeStoreProvider`,
 * not a module-level singleton), mirroring `connection-factories.ts`'s
 * `registerConnectionFactory`/`getConnectionFactory` shape and
 * docs/guides/plugins.md's "custom types also supported via the generic provider
 * registry" pattern. Plugins register additional adapters via
 * `KnowledgeStoreProvider.registerAdapter`.
 */
import type { KnowledgeAdapterDescriptor } from '@kontourai/station-contracts/knowledge-store';

export class KnowledgeAdapterRegistry {
  private readonly descriptors = new Map<string, KnowledgeAdapterDescriptor>();

  /** Registering a duplicate `id` extends (last-write-wins), never throws. */
  register(descriptor: KnowledgeAdapterDescriptor): void {
    this.descriptors.set(descriptor.id, descriptor);
  }

  get(id: string): KnowledgeAdapterDescriptor | undefined {
    return this.descriptors.get(id);
  }

  list(): KnowledgeAdapterDescriptor[] {
    return Array.from(this.descriptors.values());
  }
}

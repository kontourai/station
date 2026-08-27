/**
 * The K3 index-adapter registry — additive, instance-scoped, mirroring
 * `src-server/knowledge-store/adapter-registry.ts`'s `Map`-based, last-write-wins
 * pattern, keyed by index-provider `id` instead of store-adapter `id`. Pre-registers
 * the built-in `sqlite-vec` provider (ADR-0009's chosen index) in the constructor —
 * the same shape `KnowledgeStoreProvider` uses to pre-register its two Kit-format
 * store adapters. A future real-LanceDB index adapter (the ADR's documented
 * runner-up) registers alongside it the same way; plugins may register further
 * providers via `register()`.
 */
import type { KnowledgeIndexProvider } from '@kontourai/station-contracts/knowledge-index';
import { SqliteVecIndexProvider } from './sqlite-vec-index-provider.js';

export class KnowledgeIndexAdapterRegistry {
  private readonly providers = new Map<string, KnowledgeIndexProvider>();

  constructor(
    builtins: KnowledgeIndexProvider[] = [new SqliteVecIndexProvider()],
  ) {
    for (const provider of builtins) this.register(provider);
  }

  /** Registering a duplicate `id` extends (last-write-wins), never throws. */
  register(provider: KnowledgeIndexProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): KnowledgeIndexProvider | undefined {
    return this.providers.get(id);
  }

  list(): KnowledgeIndexProvider[] {
    return Array.from(this.providers.values());
  }
}

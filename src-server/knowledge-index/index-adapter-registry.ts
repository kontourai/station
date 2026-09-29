/**
 * Instance-local index registry, initially containing sqlite-vec.
 * Runtime routes create their own instance and select that built-in provider.
 * This register method alone is not a published plugin contribution surface.
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

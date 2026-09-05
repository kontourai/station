import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';

/** Private, process-owned nesting capability. Request data can never create it. */
type PublicationContext = {
  home: string;
  active: boolean;
  installing: Set<string>;
  retiring: Set<string>;
};
const publication = new AsyncLocalStorage<PublicationContext>();

export function withPluginPublicationContext<T>(
  home: string,
  operation: () => Promise<T>,
): Promise<T> {
  const current = publication.getStore();
  if (current?.home === resolve(home)) return operation();
  return publication.run(
    {
      home: resolve(home),
      active: false,
      installing: new Set(),
      retiring: new Set(),
    },
    operation,
  );
}

export async function acquirePluginPublicationLease(
  home: string,
  acquire: () => Promise<() => Promise<void>>,
): Promise<() => Promise<void>> {
  const context = publication.getStore();
  if (!context || context.home !== resolve(home))
    throw new Error('Plugin publication requires its owned execution context');
  if (context.active) return async () => {};
  const release = await acquire();
  context.active = true;
  return async () => {
    context.active = false;
    await release();
  };
}

export function enterPluginInstallationGraph(
  home: string,
  plugin: string,
): () => void {
  const context = publication.getStore();
  if (!context || context.home !== resolve(home))
    throw new Error('Plugin installation requires its owned execution context');
  if (context.installing.has(plugin))
    throw new Error(`Plugin dependency cycle detected: ${plugin}`);
  context.installing.add(plugin);
  return () => {
    context.installing.delete(plugin);
  };
}

export function assertPluginDependencyAcyclic(
  home: string,
  plugin: string,
): void {
  const context = publication.getStore();
  if (context?.home === resolve(home) && context.installing.has(plugin))
    throw new Error(`Plugin dependency cycle detected: ${plugin}`);
}

export function pluginRetiringInPublication(plugin: string): boolean {
  return publication.getStore()?.retiring.has(plugin) ?? false;
}
export async function withPluginRetirementScope<T>(
  plugin: string,
  operation: () => Promise<T>,
): Promise<T> {
  const context = publication.getStore();
  if (!context?.active)
    throw new Error('Plugin retirement requires its owned publication lease');
  if (context.retiring.has(plugin)) return operation();
  context.retiring.add(plugin);
  try {
    return await operation();
  } finally {
    context.retiring.delete(plugin);
  }
}

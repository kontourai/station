/**
 * Layout Provider System
 *
 * Manages provider registration and resolution for layouts.
 * Providers are resolved layout-first, then global fallback.
 */

// Provider metadata (from package.json stationProvider field)
export interface ProviderMetadata {
  layout: string; // layout slug, or '*' for global
  type: string; // provider type (e.g., 'calendar', 'crm')
}

interface ProviderEntry {
  id: string;
  metadata: ProviderMetadata;
  factory: () => any;
}

// Registry: layout -> type -> providers
const registry = new Map<string, Map<string, Map<string, ProviderEntry>>>();

// Active providers: layout -> type -> { id, instance }
const active = new Map<string, Map<string, { id: string; instance: any }>>();

// User config: layout -> type -> providerId
const config = new Map<string, Map<string, string>>();

/** Register a provider */
export function registerProvider(
  id: string,
  metadata: ProviderMetadata,
  factory: () => any,
) {
  const { layout, type } = metadata;

  if (!registry.has(layout)) {
    registry.set(layout, new Map());
  }
  const layoutRegistry = registry.get(layout)!;

  if (!layoutRegistry.has(type)) {
    layoutRegistry.set(type, new Map());
  }
  layoutRegistry.get(type)!.set(id, { id, metadata, factory });
}

/** Configure which provider to use for a layout + type */
export function configureProvider(
  layout: string,
  type: string,
  providerId: string,
) {
  if (!config.has(layout)) {
    config.set(layout, new Map());
  }
  config.get(layout)!.set(type, providerId);

  // Clear active instance so it gets re-resolved
  active.get(layout)?.delete(type);
}

/** Find provider entry - layout first, then global */
function findProvider(
  layout: string,
  type: string,
  providerId: string,
): ProviderEntry | null {
  // Check layout-specific
  const layoutEntry = registry.get(layout)?.get(type)?.get(providerId);
  if (layoutEntry) return layoutEntry;

  // Check global (workspace: '*')
  const globalEntry = registry.get('*')?.get(type)?.get(providerId);
  if (globalEntry) return globalEntry;

  return null;
}

/** Get active provider instance for a layout + type */
export function getProvider<T = any>(layout: string, type: string): T {
  // Check if already instantiated
  const layoutActive = active.get(layout);
  if (layoutActive?.has(type)) {
    return layoutActive.get(type)!.instance as T;
  }

  // Get configured provider ID
  const providerId = config.get(layout)?.get(type);
  if (!providerId) {
    throw new Error(
      `No provider configured for layout '${layout}' type '${type}'`,
    );
  }

  // Find and instantiate
  const entry = findProvider(layout, type, providerId);
  if (!entry) {
    throw new Error(
      `Provider '${providerId}' not found for layout '${layout}' type '${type}'`,
    );
  }

  const instance = entry.factory();

  // Cache instance
  if (!active.has(layout)) {
    active.set(layout, new Map());
  }
  active.get(layout)!.set(type, { id: providerId, instance });

  return instance as T;
}

/** Check if provider is configured and available */
export function hasProvider(layout: string, type: string): boolean {
  const providerId = config.get(layout)?.get(type);
  if (!providerId) return false;
  return !!findProvider(layout, type, providerId);
}

/** Get active provider ID for a layout + type */
export function getActiveProviderId(
  layout: string,
  type: string,
): string | null {
  return active.get(layout)?.get(type)?.id ?? null;
}

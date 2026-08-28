import { connectionTypeLabel } from '../../utils/execution';
import type { ProviderConnection } from './types';

export function capabilitiesForType(
  type: string,
): Array<'llm' | 'embedding' | 'vectordb'> {
  if (type === 'bedrock' || type === 'ollama' || type === 'openai-compat') {
    return ['llm', 'embedding'];
  }
  return ['llm'];
}

export function defaultConfig(type: string): Record<string, unknown> {
  if (type === 'ollama') {
    return { baseUrl: 'http://localhost:11434' };
  }
  if (type === 'openai-compat') {
    return { baseUrl: '', apiKey: '' };
  }
  if (type === 'anthropic' || type === 'google') {
    return { apiKey: '' };
  }
  if (type === 'bedrock') {
    return { region: '' };
  }
  return {};
}

/**
 * Bedrock only persists the fields its selected `authMode` actually uses
* (docs/design/connections-onboarding.md §3.1;, review):
 * `authMode` itself is omitted for the default "chain" mode (keeping the
 * absent-means-chain convention), and `profile`/`apiKey` are omitted — not
 * merely emptied — for the modes that don't use them, so a save never
 * writes a stray empty-string field into the persisted connection config.
 * A no-op for every non-bedrock type.
 */
/**
 * Whether a connection's config is complete enough to save (/,
* review): a Bedrock connection in "profile" or "api-key" auth
 * mode must have its corresponding field filled in before Save is enabled —
 * an empty required field must never silently persist as chain auth.
 * A no-op (`true`) for every non-bedrock type.
 */
export function isConnectionConfigValid(
  type: string,
  config: Record<string, unknown>,
): boolean {
  if (type !== 'bedrock') return true;
  const authMode =
    typeof config.authMode === 'string' ? config.authMode : 'chain';
  if (authMode === 'profile') {
    return (
      typeof config.profile === 'string' && config.profile.trim().length > 0
    );
  }
  if (authMode === 'api-key') {
    const replacement =
      typeof config.apiKey === 'string' && config.apiKey.trim().length > 0;
    const savedSecret =
      config.apiKeyConfigured === true && config.apiKeyClearRequested !== true;
    return replacement || savedSecret;
  }
  return true;
}

export function finalizeConnectionConfig(
  type: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (type !== 'bedrock') return config;
  const { authMode, profile, apiKey, ...rest } = config;
  const mode = typeof authMode === 'string' ? authMode : 'chain';
  const trimmedProfile = typeof profile === 'string' ? profile.trim() : '';
  const trimmedApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  return {
    ...rest,
    ...(mode !== 'chain' ? { authMode: mode } : {}),
    ...(mode === 'profile' && trimmedProfile
      ? { profile: trimmedProfile }
      : {}),
    ...(mode === 'api-key' && trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
  };
}

export function filterModelProviders(
  providers: ProviderConnection[],
  search: string,
): ProviderConnection[] {
  const normalizedSearch = search.toLowerCase();
// archive#3747: these providers arrive from `/api/connections/models`, which
// is the LLM-capable inventory. The capability re-filter here was a second
// (and differently-worded) derivation of the route's own membership rule.
  return providers.filter(
    (provider) =>
      provider.name.toLowerCase().includes(normalizedSearch) ||
      provider.type.toLowerCase().includes(normalizedSearch),
  );
}

export function describeProvider(provider: ProviderConnection): {
  name: string;
  subtitle: string;
} {
  return {
    name: provider.name || provider.type,
    subtitle:
      provider.capabilities
        .filter((capability) => capability !== 'vectordb')
        .map((capability) => capability.toUpperCase())
        .join(' · ') +
      (provider.type ? ` · ${connectionTypeLabel(provider.type)}` : ''),
  };
}

/**
 * A field the user has edited since the form was seeded for the current
 * provider. Either a top-level key (`'name'`) or a single config entry
 * (`'config.defaultModel'`). The sentinel `'config'` means the whole config
 * object was replaced (a provider-type change) and no server config should
 * survive.
 */
export type DirtyFieldPath = string;

export const WHOLE_CONFIG_DIRTY: DirtyFieldPath = 'config';

/**
 * Merge freshly fetched server state into an in-progress edit.
 *
 * React Query hands the view a new providers array on every refetch, and one
 * follows every Test Connection. Re-seeding the form wholesale from that data
 * threw away whatever the user had typed but not yet saved (archive#794). Ignoring the
 * data instead would leave the form stale against changes made elsewhere.
 *
 * So: server wins for every field the user has not touched, the user wins for
 * every field they have. Untouched fields still track the server, and an edit
 * is never silently reverted.
 */
export function mergeServerIntoEdit(
  fromServer: Omit<ProviderConnection, 'id'>,
  currentEdit: Omit<ProviderConnection, 'id'>,
  dirty: ReadonlySet<DirtyFieldPath>,
): Omit<ProviderConnection, 'id'> {
  if (dirty.size === 0) return fromServer;

  const merged: Omit<ProviderConnection, 'id'> = { ...fromServer };

  for (const path of dirty) {
    if (path === WHOLE_CONFIG_DIRTY || path.startsWith('config.')) continue;
    const key = path as keyof Omit<ProviderConnection, 'id'>;
    if (key in currentEdit) {
      (merged as Record<string, unknown>)[key] = (
        currentEdit as Record<string, unknown>
      )[key];
    }
  }

  if (dirty.has(WHOLE_CONFIG_DIRTY)) {
    merged.config = { ...currentEdit.config };
    return merged;
  }

  const config = { ...fromServer.config };
  for (const path of dirty) {
    if (!path.startsWith('config.')) continue;
    const key = path.slice('config.'.length);
// Deleted-on-the-client keys (modelOptions is cleared when baseUrl
// changes) must stay deleted rather than resurrect from the server copy.
    if (key in currentEdit.config) {
      config[key] = (currentEdit.config as Record<string, unknown>)[key];
    } else {
      delete config[key];
    }
  }
  merged.config = config;
  return merged;
}

/**
 * Reads the value a dirty path points at, so a submitted value can be compared
 * against what the form holds when the save resolves.
 *
 * `WHOLE_CONFIG_DIRTY` has no single value; it returns the config object, whose
 * identity changes on every edit, so a type change is never treated as
 * unchanged. That is the conservative direction — it keeps the field dirty.
 */
export function readFormPath(
  form: Omit<ProviderConnection, 'id'> | null,
  path: DirtyFieldPath,
): unknown {
  if (!form) return undefined;
  if (path === WHOLE_CONFIG_DIRTY) return form.config;
  if (path.startsWith('config.')) {
    return (form.config as Record<string, unknown>)[
      path.slice('config.'.length)
    ];
  }
  return (form as Record<string, unknown>)[path];
}

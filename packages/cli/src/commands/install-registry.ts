import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { loadConfigFile, writeConfigFileAtomically } from './config.js';
import { withRequestTimeout } from './core-api.js';
import { PROJECT_HOME } from './helpers.js';
import {
  effectiveAppConfigOffline,
  lockedSettingOffline,
  withoutManagedNoOpsOffline,
} from './managed-settings-guard.js';

interface RegistryManifestPlugin {
  id: string;
  source: string;
  displayName?: string;
  version?: string;
  description?: string;
}

interface RegistryManifest {
  plugins: RegistryManifestPlugin[];
}

/** Official registry, GitHub-hosted, used when none is configured. */
const DEFAULT_REGISTRY_REF = 'kontourai/station-registry';

/**
 * Resolve a registry reference to a fetchable manifest URL. A GitHub repo can
 * serve as a registry via a shorthand, so anyone can host their own:
 *   owner/repo               -> https://raw.githubusercontent.com/owner/repo/main/registry.json
 *   owner/repo@branch        -> .../<branch>/registry.json
 *   https://github.com/o/r   -> raw .../main/registry.json (also .../tree/<branch>)
 * Direct https manifest URLs and local paths pass through unchanged.
 */
export function resolveRegistryUrl(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.startsWith('/') || trimmed.startsWith('.')) return trimmed;

  let owner: string | undefined;
  let repo: string | undefined;
  let branch = 'main';

  const ghUrl = trimmed.match(
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/tree\/([^/\s]+))?\/?$/,
  );
  if (ghUrl) {
    owner = ghUrl[1];
    repo = ghUrl[2];
    if (ghUrl[3]) branch = ghUrl[3];
  } else if (
    !trimmed.includes('://') &&
    /^[\w.-]+\/[\w.-]+(?:@[\w./-]+)?$/.test(trimmed)
  ) {
    const [path, refBranch] = trimmed.split('@');
    const parts = path.split('/');
    owner = parts[0];
    repo = parts[1]?.replace(/\.git$/, '');
    if (refBranch) branch = refBranch;
  }

  if (owner && repo) {
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/registry.json`;
  }
  return trimmed;
}

/**
 * station#3239: this command and `station config set registryUrl`
 * (`packages/cli/src/commands/config.ts`) used to read/write two different
 * files — `config.json` here, `config/app.json` there — so a `config set`
 * silently had no effect on `station registry` and vice versa. `app.json`
 * is the file the settings registry actually owns (`registryUrl` in
 * `@kontourai/station-contracts/settings-registry`), so it is the one
 * source of truth now.
 */
const APP_CONFIG_PATH = join(PROJECT_HOME, 'config', 'app.json');
/** Pre-fix location. Read-only, for migrating an existing value forward. */
const LEGACY_CONFIG_PATH = join(PROJECT_HOME, 'config.json');

function readJsonStringField(path: string, field: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<
      string,
      unknown
    >;
    const value = parsed?.[field];
    return typeof value === 'string' && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stores `registryUrl` in `config/app.json` through the loader and writer
 * `station config set --offline` uses, so the two commands cannot diverge
 * again. The loader refuses a file that is not a JSON object (and says so)
 * instead of treating it as empty: this write replaces the whole file, so
 * "empty" would discard every other setting the operator had in it.
 */
function persistRegistryUrl(registryUrl: string): void {
  // #4517: `registryUrl` is a Station setting the managed policy can lock.
  if (Object.keys(withoutManagedNoOpsOffline({ registryUrl })).length === 0)
    return;
  const config = loadConfigFile();
  config.registryUrl = registryUrl;
  writeConfigFileAtomically(config);
}

function readStoredAppConfig(): Record<string, unknown> {
  if (!existsSync(APP_CONFIG_PATH)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(APP_CONFIG_PATH, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readConfiguredRegistryUrl(): string | undefined {
  const stored = readStoredAppConfig();
  // #4517: the installed policy's registry. A lock is the registry in
  // effect, and the stored and legacy values are never consulted; a default
  // applies only where neither is set. An installed policy that cannot be
  // used refuses the read (both calls throw) instead of falling back.
  const effective = effectiveAppConfigOffline(stored);
  let configured = lockedSettingOffline('registryUrl')
    ? nonBlank(effective.registryUrl)
    : nonBlank(stored.registryUrl);
  if (!configured) {
    // Migration: a value set by an older `station registry <url>` (or
    // never moved) still lives at the legacy path. Read it once and copy
    // it forward so `station config get registryUrl` — and every
    // subsequent read here — agree without the user re-typing it. Not
    // reached under a lock, so the copy cannot be refused by one.
    const legacy = readJsonStringField(LEGACY_CONFIG_PATH, 'registryUrl');
    if (legacy) {
      configured = legacy;
      try {
        persistRegistryUrl(legacy);
      } catch {
        // Best-effort forward-copy; the legacy value still resolves this
        // call even if the copy fails (e.g. read-only home directory, or
        // an `app.json` that cannot be parsed, which the copy refuses to
        // replace).
      }
    }
  }
  configured ??= nonBlank(effective.registryUrl);
  return resolveRegistryUrl(configured ?? DEFAULT_REGISTRY_REF);
}

function saveRegistryUrl(registryUrl: string): void {
  persistRegistryUrl(registryUrl);
  console.log(`  ✓ Registry URL saved: ${registryUrl}`);
}

function parseRegistryManifest(raw: unknown): RegistryManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Malformed registry manifest: expected an object');
  }

  const manifest = raw as { plugins?: unknown };
  if (!Array.isArray(manifest.plugins)) {
    throw new Error('Malformed registry manifest: plugins must be an array');
  }

  const seen = new Set<string>();
  const plugins = manifest.plugins.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(
        `Malformed registry manifest: plugins[${index}] must be an object`,
      );
    }
    const plugin = entry as Record<string, unknown>;
    if (!isCanonicalPluginId(plugin.id)) {
      throw new Error(
        `Malformed registry manifest: plugins[${index}].id must be a canonical plugin identifier`,
      );
    }
    if (seen.has(plugin.id)) {
      throw new Error(`Duplicate registry plugin id: ${plugin.id}`);
    }
    seen.add(plugin.id);
    if (typeof plugin.source !== 'string' || !plugin.source.trim()) {
      throw new Error(
        `Malformed registry manifest: plugins[${index}].source must be a string`,
      );
    }
    return plugin as unknown as RegistryManifestPlugin;
  });

  return { plugins };
}

async function fetchRegistryManifest(
  registryUrl: string,
): Promise<RegistryManifest> {
  if (registryUrl.startsWith('/') || registryUrl.startsWith('.')) {
    return parseRegistryManifest(
      JSON.parse(readFileSync(registryUrl, 'utf-8')),
    );
  }

  const response = await fetch(registryUrl, withRequestTimeout());
  if (!response.ok) {
    throw new Error(
      `Failed to fetch registry (${response.status} ${response.statusText}) from ${registryUrl}. ` +
        'Point Station at a registry with: station registry <owner/repo> (a GitHub repo) or a manifest URL.',
    );
  }
  return parseRegistryManifest(await response.json());
}

export async function showOrSaveRegistry(registryUrl?: string): Promise<void> {
  ensureStationHomeSchemaSync(PROJECT_HOME);
  const url = registryUrl || readConfiguredRegistryUrl();

  if (!url) {
    console.error('No registry URL configured.');
    console.log('  Set one: station registry <url>');
    console.log('  Or: station config set registryUrl <url>');
    process.exit(1);
  }

  if (registryUrl) {
    saveRegistryUrl(registryUrl);
    return;
  }

  console.log(`📋 Fetching registry from ${url}...\n`);
  try {
    // In-process fetch with manifest validation and an actionable error
    // message; no curl subprocess (works on Windows, no external dep).
    const manifest = await fetchRegistryManifest(url);
    const plugins = manifest.plugins || [];

    if (!plugins.length) {
      console.log('Registry is empty.');
      return;
    }

    // Installed state is not shown here. The running Station owns it (which
    // registry installed what, under which plugin name), and
    // `station registry plugins list` reports it from there.
    console.log('Available Plugins:\n');
    for (const plugin of plugins) {
      console.log(
        `  ${plugin.displayName || plugin.id} (${plugin.id}@${plugin.version || '?'})`,
      );
      if (plugin.description) console.log(`    ${plugin.description}`);
    }
    console.log(`\n  Install with: station registry install <id>`);
    console.log('  Installed state: station registry plugins list');
  } catch (error: any) {
    console.error(error.message);
    process.exit(1);
  }
}

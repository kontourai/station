import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';
import { acquireFileMutationLock } from '@kontourai/station-shared/lifecycle-events';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { withRequestTimeout } from './core-api.js';
import { PLUGINS_DIR, PROJECT_HOME } from './helpers.js';

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

function getRegistryInstallsPath(): string {
  return join(PROJECT_HOME, 'config', 'registry-installs.json');
}

/** Official registry, GitHub-hosted, used when none is configured. */
const DEFAULT_REGISTRY_REF = 'kontourai/station-registry';

/**
 * Registry entries install into a directory named by the plugin manifest's
 * `name`. Aliases, registry manifests, and local plugin manifests therefore
 * share the plugin contract's canonical path-safe identity.
 */
const INVALID_INSTALLED_PLUGIN_NAME =
  'Installed plugin manifest has an invalid plugin name';

function isCanonicalRegistryPluginId(value: unknown): value is string {
  return isCanonicalPluginId(value);
}

function assertCanonicalRegistryPluginId(
  value: unknown,
  message: string,
): asserts value is string {
  if (!isCanonicalRegistryPluginId(value)) {
    throw new Error(message);
  }
}

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

/** Same-directory temp-file-then-rename so a concurrent reader never sees a torn write. */
function persistRegistryUrl(registryUrl: string): void {
  const configDir = join(PROJECT_HOME, 'config');
  mkdirSync(configDir, { recursive: true });
  let config: Record<string, unknown> = {};
  if (existsSync(APP_CONFIG_PATH)) {
    try {
      config = JSON.parse(readFileSync(APP_CONFIG_PATH, 'utf-8'));
    } catch {}
  }
  config.registryUrl = registryUrl;
  const tempPath = join(
    configDir,
    `app.json.${process.pid}.${randomUUID()}.tmp`,
  );
  writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf-8');
  try {
    renameSync(tempPath, APP_CONFIG_PATH);
  } finally {
    try {
      rmSync(tempPath, { force: true });
    } catch {}
  }
}

function readConfiguredRegistryUrl(): string | undefined {
  let configured = readJsonStringField(APP_CONFIG_PATH, 'registryUrl');
  if (!configured) {
    // Migration: a value set by an older `station registry <url>` (or
    // never moved) still lives at the legacy path. Read it once and copy
    // it forward so `station config get registryUrl` — and every
    // subsequent read here — agree without the user re-typing it.
    const legacy = readJsonStringField(LEGACY_CONFIG_PATH, 'registryUrl');
    if (legacy) {
      configured = legacy;
      try {
        persistRegistryUrl(legacy);
      } catch {
        // Best-effort forward-copy; the legacy value still resolves this
        // call even if the copy fails (e.g. read-only home directory).
      }
    }
  }
  const ref =
    typeof configured === 'string' && configured.trim()
      ? configured
      : DEFAULT_REGISTRY_REF;
  return resolveRegistryUrl(ref);
}

function saveRegistryUrl(registryUrl: string): void {
  persistRegistryUrl(registryUrl);
  console.log(`  ✓ Registry URL saved: ${registryUrl}`);
}

export class RegistryInstallAliasesUnavailableError extends Error {
  constructor() {
    super('Registry install aliases are unavailable');
    this.name = 'RegistryInstallAliasesUnavailableError';
  }
}

export class RegistryInstallAliasesPersistenceError extends Error {
  constructor() {
    super('Registry install aliases could not be persisted');
    this.name = 'RegistryInstallAliasesPersistenceError';
  }
}

function emptyRegistryInstallAliases(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

function readRegistryInstallAliases(
  aliasesPath = getRegistryInstallsPath(),
): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(aliasesPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyRegistryInstallAliases();
    }
    throw new RegistryInstallAliasesUnavailableError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RegistryInstallAliasesUnavailableError();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RegistryInstallAliasesUnavailableError();
  }

  const aliases = emptyRegistryInstallAliases();
  for (const [registryId, pluginName] of Object.entries(parsed)) {
    if (
      !isCanonicalRegistryPluginId(registryId) ||
      !isCanonicalRegistryPluginId(pluginName)
    ) {
      throw new RegistryInstallAliasesUnavailableError();
    }
    aliases[registryId] = pluginName;
  }
  return aliases;
}

function syncAliasDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const descriptor = openSync(directory, fsConstants.O_RDONLY);
  let primaryFailed = false;
  let primaryError: unknown;
  try {
    fsyncSync(descriptor);
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  }

  let closeFailed = false;
  try {
    closeSync(descriptor);
  } catch {
    closeFailed = true;
  }

  if (primaryFailed) {
    throw primaryError;
  }
  if (closeFailed) {
    throw new RegistryInstallAliasesPersistenceError();
  }
}

function writeRegistryInstallAliases(
  aliasesPath: string,
  aliases: Record<string, string>,
): void {
  const temporaryPath = `${aliasesPath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let primaryFailed = false;
  let primaryError: unknown;
  try {
    descriptor = openSync(
      temporaryPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(descriptor, JSON.stringify(aliases, null, 2), 'utf-8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, aliasesPath);
    syncAliasDirectory(dirname(aliasesPath));
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  }

  let cleanupFailed = false;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch {
      cleanupFailed = true;
    }
  }
  try {
    rmSync(temporaryPath, { force: true });
  } catch {
    cleanupFailed = true;
  }

  if (primaryFailed) {
    throw primaryError;
  }
  if (cleanupFailed) {
    throw new RegistryInstallAliasesPersistenceError();
  }
}

function assertRegistryAliasAvailable(
  aliases: Record<string, string>,
  registryId: string,
  pluginName: string,
): void {
  const existingTarget = aliases[registryId];
  if (existingTarget && existingTarget !== pluginName) {
    throw new Error(
      `Registry item '${registryId}' already points to plugin '${existingTarget}', not '${pluginName}'`,
    );
  }

  for (const [existingRegistryId, existingPluginName] of Object.entries(
    aliases,
  )) {
    if (
      existingRegistryId !== registryId &&
      existingPluginName === pluginName
    ) {
      throw new Error(
        `Plugin '${pluginName}' is already linked to registry item '${existingRegistryId}'`,
      );
    }
  }
}

export function recordRegistryInstall(
  registryId: string,
  pluginName: string,
): void {
  assertCanonicalRegistryPluginId(
    registryId,
    'Registry install requires a canonical registry plugin id',
  );
  assertCanonicalRegistryPluginId(
    pluginName,
    'Registry install requires a canonical installed plugin name',
  );
  if (registryId === pluginName) {
    return;
  }

  ensureStationHomeSchemaSync(PROJECT_HOME);
  const aliasesPath = getRegistryInstallsPath();
  mkdirSync(dirname(aliasesPath), { recursive: true });
  const release = acquireFileMutationLock(`${aliasesPath}.mutation`);
  try {
    const aliases = readRegistryInstallAliases(aliasesPath);
    assertRegistryAliasAvailable(aliases, registryId, pluginName);
    aliases[registryId] = pluginName;
    writeRegistryInstallAliases(aliasesPath, aliases);
  } finally {
    release();
  }
}

function isGitPluginSource(source: string): boolean {
  return (
    source.startsWith('git@') ||
    source.endsWith('.git') ||
    (source.startsWith('https://') &&
      (source.includes('.git') ||
        source.includes('gitlab') ||
        source.includes('github')))
  );
}

function sourceProtocol(source: string): string | null {
  if (source.startsWith('git@')) {
    return null;
  }
  if (process.platform === 'win32' && /^[a-zA-Z]:[\\/]/.test(source)) {
    return null;
  }
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(source)) {
    return null;
  }
  try {
    return new URL(source).protocol;
  } catch {
    return null;
  }
}

function assertSupportedRegistrySource(source: string): void {
  const protocol = sourceProtocol(source);
  if (!protocol) {
    return;
  }

  if (protocol !== 'https:') {
    throw new Error(`Unsupported plugin source protocol: ${protocol}`);
  }

  if (!isGitPluginSource(source)) {
    throw new Error(
      'Unsupported plugin source URL: registry installs must use a git HTTPS source or a contained local path',
    );
  }
}

function assertPathInside(root: string, candidate: string): void {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  if (
    candidatePath !== rootPath &&
    !candidatePath.startsWith(`${rootPath}${sep}`)
  ) {
    throw new Error(`Registry source '${candidate}' escapes the registry root`);
  }
}

function localRegistryRoot(registryUrl: string): string {
  const manifestDir = dirname(resolve(registryUrl));
  return resolve(manifestDir, '..');
}

function normalizeRegistrySource(source: string, registryUrl: string): string {
  assertSupportedRegistrySource(source);

  if (source.startsWith('git@') || source.startsWith('https://')) {
    return source;
  }
  if (registryUrl.startsWith('/') || registryUrl.startsWith('.')) {
    const root = localRegistryRoot(registryUrl);
    const resolvedSource = isAbsolute(source)
      ? resolve(source)
      : resolve(dirname(registryUrl), source);
    assertPathInside(root, resolvedSource);
    return resolvedSource;
  }
  const resolvedSource = new URL(source, registryUrl).toString();
  assertSupportedRegistrySource(resolvedSource);
  return resolvedSource;
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
    if (!isCanonicalRegistryPluginId(plugin.id)) {
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

function readLocalPluginName(source: string): string | null {
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(source)) {
    return null;
  }
  const manifestPath = join(source, 'plugin.json');
  if (!existsSync(manifestPath)) {
    return null;
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      name?: unknown;
    };
    assertCanonicalRegistryPluginId(
      manifest.name,
      INVALID_INSTALLED_PLUGIN_NAME,
    );
    return manifest.name;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === INVALID_INSTALLED_PLUGIN_NAME
    ) {
      throw error;
    }
    throw new Error(INVALID_INSTALLED_PLUGIN_NAME);
  }
}

export async function resolveRegistryPluginSource(
  id: string | undefined,
): Promise<string> {
  if (!id) {
    throw new Error('registry install requires a plugin id');
  }
  assertCanonicalRegistryPluginId(
    id,
    'registry install requires a canonical plugin id',
  );
  ensureStationHomeSchemaSync(PROJECT_HOME);

  const registryUrl = readConfiguredRegistryUrl();
  if (!registryUrl) {
    throw new Error(
      'No registry URL configured. Set one with: station registry <url> ' +
        '(or station config set registryUrl <url>).',
    );
  }

  const manifest = await fetchRegistryManifest(registryUrl);
  const plugin = manifest.plugins.find((entry) => entry.id === id);
  if (!plugin) {
    throw new Error(`Plugin '${id}' not found in registry`);
  }

  const source = normalizeRegistrySource(plugin.source, registryUrl);
  const pluginName = readLocalPluginName(source);
  if (pluginName) {
    assertRegistryAliasAvailable(readRegistryInstallAliases(), id, pluginName);
  }
  return source;
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
    // Reuse the install path's fetcher: same manifest validation and actionable
    // error message, and no curl subprocess (works on Windows, no external dep).
    const manifest = await fetchRegistryManifest(url);
    const plugins = manifest.plugins || [];

    if (!plugins.length) {
      console.log('Registry is empty.');
      return;
    }

    const installed = new Set<string>();
    const aliases = readRegistryInstallAliases();
    if (existsSync(PLUGINS_DIR)) {
      for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
        if (entry.isDirectory()) installed.add(entry.name);
      }
    }

    console.log('Available Plugins:\n');
    for (const plugin of plugins) {
      const installedPluginName = aliases[plugin.id] || plugin.id;
      const status = installed.has(installedPluginName) ? ' [installed]' : '';
      console.log(
        `  ${plugin.displayName || plugin.id} (${plugin.id}@${plugin.version || '?'})${status}`,
      );
      if (plugin.description) console.log(`    ${plugin.description}`);
    }
    console.log(`\n  Install with: station registry install <id>`);
  } catch (error: any) {
    console.error(error.message);
    process.exit(1);
  }
}

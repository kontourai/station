import { randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type {
  InstallResult,
  RegistryItem,
} from '@kontourai/station-contracts/catalog';
import {
  isCanonicalPluginId,
  type PluginManifest,
} from '@kontourai/station-contracts/plugin';
import { DistributionProfileService } from '../../services/plugins/distribution-profile-service.js';
import {
  computePluginContentDigest,
  PLUGIN_TREE_COPY,
  withPluginContentLock,
} from '../../services/plugins/plugin-content-integrity.js';
import { resolveInstalledPluginRoot } from '../../services/plugins/plugin-incarnation.js';
import { derivePluginConsentBasis } from '../../services/plugins/plugin-install-consent.js';
import {
  readPluginManifestFileSync,
  readPluginManifestFileSyncWithFormat,
} from '../../services/plugins/plugin-manifest-loader.js';
import { assertPluginIdentityAvailable } from '../../services/plugins/reserved-plugin-identities.js';
import { readCurrentWorkspacePaneCatalog } from '../../services/projects/workspace-pane-catalog.js';
import { execGit } from '../../utils/git-exec.js';
import type { Logger } from '../../utils/logger.js';
import { errorMessage } from '../schemas/schemas.js';

interface PluginRegistryInstaller {
  /**
   * `expectedInstalledPluginName` is the identity assertion, not a hint. A
   * registry provider derives its write target from the FETCHED manifest's
   * name, while a dependency install has already committed to
   * `<plugins>/<dependency.id>` — for the lock it took, for the tree it will
   * validate, and for the tree it may roll back. A provider that honours this
   * refuses before it writes anything; one that ignores it cannot be
   * prevented from here, which is why the caller also deletes nothing it
   * cannot prove it created (archive#4309 follow-up review, MEDIUM 3).
   */
  install(
    id: string,
    options?: { expectedInstalledPluginName?: string },
  ): Promise<InstallResult & { rollback?: () => Promise<void> }>;
  listAvailable?(): Promise<RegistryItem[]>;
  resolveSource?(id: string): Promise<string | null>;
}

export interface PluginGitInfo {
  hash: string;
  branch: string;
  remote?: string;
}

export interface PluginConflict {
  type: string;
  id: string;
  existingSource?: string;
}

export interface ResolvedPluginDependency {
  id: string;
  source?: string;
  status: 'installed' | 'will-install' | 'missing';
  components?: Array<{ type: string; id: string }>;
  git?: PluginGitInfo;
  consent?: {
    contentDigest: string;
    permissions: string[];
    dependencies: string[];
    pendingConsent: Array<{ permission: string; tier: string }>;
  };
}

export interface PluginDependencyLifecycle {
  commit?(): void;
  validatePortableInstalled?(dependency: {
    id: string;
    version?: string;
  }): Promise<boolean>;
  installPortable?(input: {
    dependencyId: string;
    source: string;
    manifest: PluginManifest;
  }): Promise<void>;

  validateInstalled?(input: {
    dependencyId: string;
    manifest: PluginManifest;
  }): void;
  validate(input: {
    dependencyId: string;
    dependencyDir: string;
    manifest: PluginManifest;
  }): void;
  activate(input: {
    dependencyId: string;
    dependencyDir: string;
    manifest: PluginManifest;
  }): Promise<void>;
  rollback(dependencyId: string): Promise<void>;
}

function extractPluginName(source: string): string {
  if (
    source.startsWith('git@') ||
    source.includes('.git') ||
    source.startsWith('https://')
  ) {
    const match = source.split('#')[0].match(/\/([^/]+?)(?:\.git)?$/);
    return match ? match[1] : 'unknown';
  }
  // basename (not split('/').pop()) so a Windows path with no forward
  // slashes doesn't fall through with the whole path as the "name".
  return basename(source) || 'unknown';
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

function assertSupportedPluginSource(source: string): void {
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

export function resolvePluginDependencySource(
  dependency: { id: string; source?: string; version?: string },
  parentSourceDir: string,
  allowedLocalRoot: string = dirname(resolve(parentSourceDir)),
): { id: string; source?: string; version?: string } {
  if (!dependency.source || shouldPreserveDependencySource(dependency.source)) {
    return dependency;
  }
  if (dangerousProtocolOrGitSource(parentSourceDir)) {
    throw new Error(
      `Plugin dependency '${dependency.id}' uses a relative source under a non-local parent source`,
    );
  }
  const source = resolve(parentSourceDir, dependency.source);
  const root = resolve(allowedLocalRoot);
  const sourceRelative = relative(root, source);
  if (
    sourceRelative === '' ||
    sourceRelative.startsWith('..') ||
    isAbsolute(sourceRelative)
  ) {
    throw new Error(
      `Plugin dependency '${dependency.id}' relative source escapes its allowed package root`,
    );
  }
  let current = root;
  for (const segment of sourceRelative.split(sep)) {
    if (existsSync(current)) {
      const status = lstatSync(current);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new Error(
          `Plugin dependency '${dependency.id}' relative source has a non-directory or symbolic-link ancestor`,
        );
      }
    }
    current = join(current, segment);
  }
  if (existsSync(current)) {
    const status = lstatSync(current);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error(
        `Plugin dependency '${dependency.id}' relative source must be a physical directory`,
      );
    }
  }
  return {
    ...dependency,
    source,
  };
}

function dangerousProtocolOrGitSource(source: string): boolean {
  return source.startsWith('git@') || sourceProtocol(source) !== null;
}

function looksLikeWindowsAbsolutePath(source: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(source);
}

function isPortableAbsoluteSource(source: string): boolean {
  return isAbsolute(source) || looksLikeWindowsAbsolutePath(source);
}

function shouldPreserveDependencySource(source: string): boolean {
  return (
    dangerousProtocolOrGitSource(source) || isPortableAbsoluteSource(source)
  );
}

function assertPluginDependencyId(id: string): void {
  if (!isCanonicalPluginId(id)) {
    throw new Error(`Invalid plugin dependency id: ${id}`);
  }
}

function assertPathInside(
  root: string,
  candidate: string,
  label: string,
): void {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  if (
    candidatePath !== rootPath &&
    !candidatePath.startsWith(`${rootPath}${sep}`)
  ) {
    throw new Error(`${label} escapes root`);
  }
}

function readInstalledDependencyManifest(
  pluginsDir: string,
  dependencyId: string,
): PluginManifest {
  const dependencyDir = join(pluginsDir, dependencyId);
  assertPathInside(pluginsDir, dependencyDir, 'Plugin dependency target');
  if (!existsSync(dependencyDir)) {
    throw new Error(
      `Plugin dependency '${dependencyId}' did not materialize after install`,
    );
  }
  const dependencyStat = lstatSync(dependencyDir);
  if (dependencyStat.isSymbolicLink()) {
    try {
      if (
        resolveInstalledPluginRoot(pluginsDir, dependencyId)?.kind !==
        'incarnation'
      )
        throw new Error('Plugin dependency target escapes root');
    } catch (error) {
      throw new Error(
        'Plugin dependency target escapes root or does not identify an owned materialization',
        { cause: error },
      );
    }
  } else if (!dependencyStat.isDirectory()) {
    throw new Error(
      `Plugin dependency '${dependencyId}' target is not a directory`,
    );
  }
  const rootPath = realpathSync(pluginsDir);
  const dependencyPath = realpathSync(dependencyDir);
  if (
    dependencyPath !== rootPath &&
    !dependencyPath.startsWith(`${rootPath}${sep}`)
  ) {
    throw new Error('Plugin dependency target escapes root');
  }
  const manifestPath = join(dependencyDir, 'plugin.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Plugin dependency '${dependencyId}' is missing plugin.json`,
    );
  }
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile()) {
    throw new Error(
      `Plugin dependency '${dependencyId}' manifest is not a regular file`,
    );
  }
  const manifest = readPluginManifestFileSync(manifestPath) as PluginManifest;
  if ((manifest.name || dependencyId) !== dependencyId) {
    throw new Error(
      `Plugin dependency '${dependencyId}' manifest name does not match`,
    );
  }
  return manifest;
}

/**
 * Builds a dependency in its INSTALLED directory.
 *
 * This mutates another plugin's live tree: `buildPlugin` runs
 * `ensurePluginDeps` (an `npm install` inside `<plugins>/<dependencyId>`) and
 * writes `dist/bundle.js`. When the dependency was already installed, that
 * happens to a plugin the operator never touched, as a side effect of
 * installing something else — so it takes THAT plugin's content lock
 * (archive#4288, review HIGH 3). Without it the memoized digest survives the
 * mutation, so the tree reads `bound` in-process against bytes that are no
 * longer the ones any grant was given for, and only starts telling the truth
 * after a restart.
 *
 * The lock is re-entrant per async context, which is what makes this safe to
 * take while the installing plugin's own lock is held: a self-referential or
 * cyclic dependency resolves to the same key and runs inline instead of
 * deadlocking.
 */
async function buildDependencyIfNeeded(
  pluginsDir: string,
  dependencyId: string,
  manifest: PluginManifest,
  buildPlugin: (pluginDir: string, name: string) => Promise<void>,
): Promise<void> {
  if (!manifest.entrypoint) return;
  const dependencyDir = join(pluginsDir, dependencyId);
  await withPluginContentLock(pluginsDir, dependencyId, () =>
    buildPlugin(dependencyDir, dependencyId),
  );
  const bundlePath = join(dependencyDir, 'dist', 'bundle.js');
  if (!existsSync(bundlePath) || !lstatSync(bundlePath).isFile()) {
    throw new Error(
      `Plugin dependency '${dependencyId}' did not produce dist/bundle.js`,
    );
  }
}

function unsupportedDependencyFeatures(
  dependencyDir: string,
  manifest: PluginManifest,
  lifecycle: boolean,
): string[] {
  if (
    readPluginManifestFileSyncWithFormat(join(dependencyDir, 'plugin.json'))
      .format === 'agent-plugin-1.0'
  )
    return [];
  const unsupported: string[] = [];
  if (manifest.agents?.length) unsupported.push('agents');
  if (manifest.layout) unsupported.push('layout');
  if (manifest.layouts?.length) unsupported.push('layouts');
  if (manifest.workspacePanes?.length) unsupported.push('workspacePanes');
  if (manifest.operationalEventSubscriptions?.length) {
    unsupported.push('operationalEventSubscriptions');
  }
  if (manifest.providers?.length && !lifecycle) unsupported.push('providers');
  if (manifest.integrations?.required?.length) unsupported.push('integrations');
  if (manifest.tools?.required?.length) unsupported.push('tools');
  if (manifest.knowledge?.namespaces?.length) unsupported.push('knowledge');
  if (manifest.prompts) unsupported.push('prompts');
  if (manifest.skills?.length) unsupported.push('skills');
  if (manifest.settings?.length && !lifecycle) unsupported.push('settings');
  const unsupportedPermissions = (manifest.permissions ?? []).filter(
    (permission) => !lifecycle || permission !== 'providers.register',
  );
  if (unsupportedPermissions.length) unsupported.push('permissions');
  if (manifest.serverModule) unsupported.push('serverModule');
  if (existsSync(join(dependencyDir, 'integrations'))) {
    unsupported.push('bundled integrations');
  }

  return unsupported;
}

function assertDependencyLifecycleSupported(
  dependencyId: string,
  dependencyDir: string,
  manifest: PluginManifest,
  lifecycle?: PluginDependencyLifecycle,
): void {
  const unsupported = unsupportedDependencyFeatures(
    dependencyDir,
    manifest,
    Boolean(lifecycle),
  );
  if (unsupported.length) {
    throw new Error(
      `Plugin dependency '${dependencyId}' declares lifecycle features that require canonical install support: ${unsupported.join(', ')}`,
    );
  }
}

export class PluginPreviewUnsupportedDependencyError extends Error {
  constructor(dependencyId: string, features: readonly string[]) {
    super(
      `Plugin dependency '${dependencyId}' is not supported by canonical installation: ${features.join(', ')}`,
    );
    this.name = 'PluginPreviewUnsupportedDependencyError';
  }
}

export async function getPluginGitInfo(
  dir: string,
  logger: Logger,
): Promise<PluginGitInfo | undefined> {
  if (!existsSync(join(dir, '.git'))) return undefined;
  try {
    const { stdout: hash } = await execGit(['rev-parse', '--short', 'HEAD'], {
      cwd: dir,
      encoding: 'utf-8',
    });
    const { stdout: branch } = await execGit(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: dir, encoding: 'utf-8' },
    );
    let remote: string | undefined;
    try {
      const { stdout } = await execGit(['remote', 'get-url', 'origin'], {
        cwd: dir,
        encoding: 'utf-8',
      });
      remote = stdout.trim();
    } catch (error) {
      logger.debug('Failed to get git remote URL for plugin', { error });
    }
    return { hash: hash.trim(), branch: branch.trim(), remote };
  } catch (error) {
    logger.debug('Failed to get git info for plugin', { error });
    return undefined;
  }
}

export async function fetchPluginSource(
  source: string,
  pluginsDir: string,
  logger: Logger,
): Promise<{ tempDir: string; tempName: string } | { error: string }> {
  try {
    assertSupportedPluginSource(source);
  } catch (error: unknown) {
    return { error: errorMessage(error) };
  }

  const isGit = isGitPluginSource(source);

  const tempName = extractPluginName(source);
  // archive#4288, review MEDIUM 2. The staging directory used to be
  // `.preview-<source basename>` — derived, predictable, and shared by every
  // fetch of a source with that basename. Two consequences, both reachable
  // now that preview-then-install is the ORDINARY traffic pattern rather than
  // an unusual one:
  //
  // 1. A concurrent `POST /preview` for a different source with the same
  //    basename `rmSync`s this fetch's staged tree out from under it, in the
  //    unlocked window between the consent gate's digest and the copy into
  //    `<plugins>/<name>` (the content lock is keyed on the MANIFEST name and
  //    taken after the gate, so it does not cover this).
  // 2. Self-collision: a dependency whose source basename matches its
  //    parent's deletes the parent's staged tree mid-install.
  //
  // Randomising the suffix removes the collision rather than detecting it
  // afterwards. It is deliberately not a claim that the staged tree is
  // tamper-proof: a same-user process can still find it by listing
  // `<plugins>`, and can equally overwrite `<plugins>/<name>` after the
  // install. What it makes true is that no two concurrent fetches share a
  // path. The `.preview-` prefix is kept: the install's `finally` and the
  // tests' leak assertions both key on it.
  const tempDir = join(
    pluginsDir,
    `.preview-${tempName}-${randomBytes(8).toString('hex')}`,
  );
  try {
    assertPathInside(pluginsDir, tempDir, 'Plugin preview target');
  } catch (error: unknown) {
    return { error: errorMessage(error) };
  }

  mkdirSync(tempDir, { recursive: true });

  if (isGit) {
    const [url, branch] = source.split('#');
    const cloneArgs = ['clone', '--depth', '1'];
    if (branch) cloneArgs.push('--branch', branch);
    cloneArgs.push(url, tempDir);
    try {
      await execGit(cloneArgs, { timeout: 30000 });
    } catch (error) {
      logger.debug('Failed to clone with branch, retrying without', { error });
      rmSync(tempDir, { recursive: true, force: true });
      mkdirSync(tempDir, { recursive: true });
      try {
        await execGit(['clone', '--depth', '1', url, tempDir], {
          timeout: 30000,
        });
      } catch (cloneError: unknown) {
        rmSync(tempDir, { recursive: true, force: true });
        return { error: `Failed to clone: ${errorMessage(cloneError)}` };
      }
    }
  } else {
    if (!existsSync(source)) {
      rmSync(tempDir, { recursive: true });
      return { error: `Source not found: ${source}` };
    }
    if (!existsSync(join(source, 'plugin.json'))) {
      rmSync(tempDir, { recursive: true });
      return { error: 'Not a valid plugin: plugin.json not found' };
    }
    cpSync(source, tempDir, PLUGIN_TREE_COPY);
  }

  if (!existsSync(join(tempDir, 'plugin.json'))) {
    rmSync(tempDir, { recursive: true, force: true });
    return { error: 'Not a valid plugin: plugin.json not found' };
  }

  return { tempDir, tempName };
}

export function detectPluginConflicts(
  manifest: PluginManifest,
  agentsDir: string,
  pluginsDir: string,
  logger: Logger,
): PluginConflict[] {
  const conflicts: PluginConflict[] = [];

  for (const agent of manifest.agents || []) {
    const slug = agent.slug;
    if (existsSync(join(agentsDir, slug, 'agent.json'))) {
      conflicts.push({
        type: 'agent',
        id: slug,
        existingSource: 'installed',
      });
    }
  }

  if (!manifest.layout && !manifest.workspacePanes?.length) return conflicts;
  if (!existsSync(pluginsDir)) return conflicts;

  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const installedManifest = readPluginManifestFileSync(
        join(pluginsDir, entry.name, 'plugin.json'),
      ) as PluginManifest;
      if (
        manifest.layout &&
        installedManifest.name !== manifest.name &&
        installedManifest.layout?.slug === manifest.layout.slug
      ) {
        conflicts.push({
          type: 'layout',
          id: manifest.layout.slug,
          existingSource: installedManifest.name,
        });
      }
    } catch (error) {
      logger.debug('Failed to inspect installed plugin for layout conflict', {
        plugin: entry.name,
        error,
      });
    }
  }

  return conflicts;
}

/** Full inert catalog preflight, including built-ins and legacy adaptations. */
export function detectWorkspacePaneCatalogConflicts(
  manifest: PluginManifest,
  projectHomeDir: string,
): PluginConflict[] {
  if (!manifest.workspacePanes?.length) return [];
  const existingCatalog = readCurrentWorkspacePaneCatalog(
    new DistributionProfileService(projectHomeDir),
    '__plugin-install-preflight__',
  );
  return manifest.workspacePanes.flatMap((pane) => {
    const existing = existingCatalog.descriptors.find(
      (descriptor) => descriptor.id === pane.id,
    );
    if (
      !existing ||
      (existing.provenance.origin === 'plugin' &&
        existing.provenance.pluginId === manifest.name)
    ) {
      return [];
    }
    return [
      {
        type: 'pane',
        id: pane.id,
        existingSource:
          existing.provenance.origin === 'plugin'
            ? existing.provenance.pluginId
            : existing.provenance.origin,
      },
    ];
  });
}

export async function resolvePluginDependencies(
  manifest: PluginManifest,
  pluginsDir: string,
  getPluginRegistryProvider: () => PluginRegistryInstaller,
  logger: Logger,
  seen: Set<string> = new Set(),
  parentSourceDir: string = pluginsDir,
  allowedLocalRoot: string = dirname(resolve(parentSourceDir)),
  validation?: {
    beforeResolve(id: string): void;
    resolved(dependency: ResolvedPluginDependency): void | Promise<void>;
  },
): Promise<ResolvedPluginDependency[]> {
  const dependencies: ResolvedPluginDependency[] = [];
  if (!manifest.dependencies?.length) return dependencies;

  for (const dependency of manifest.dependencies) {
    validation?.beforeResolve(dependency.id);
    if (seen.has(dependency.id)) continue;
    seen.add(dependency.id);

    let depManifest: PluginManifest | null = null;
    let depGit: PluginGitInfo | undefined;
    let status: ResolvedPluginDependency['status'] = 'missing';
    let consent: ResolvedPluginDependency['consent'];
    let unsupported: string[] = [];
    const resolvedDependency = resolvePluginDependencySource(
      dependency,
      parentSourceDir,
      allowedLocalRoot,
    );
    let dependencySourceContext = resolvedDependency.source;

    const dependencyDir = join(pluginsDir, dependency.id);
    if (existsSync(join(dependencyDir, 'plugin.json'))) {
      status = 'installed';
      try {
        depManifest = readPluginManifestFileSync(
          join(dependencyDir, 'plugin.json'),
        );
      } catch (error) {
        logger.debug('Failed to read installed dependency manifest', {
          dep: dependency.id,
          error,
        });
      }
      depGit = await getPluginGitInfo(dependencyDir, logger);
      if (depManifest) {
        unsupported = unsupportedDependencyFeatures(
          dependencyDir,
          depManifest,
          true,
        );
      }
      const basis = depManifest
        ? derivePluginConsentBasis(dependencyDir, depManifest)
        : null;
      if (basis) {
        consent = {
          contentDigest: basis.contentDigest,
          permissions: basis.required,
          dependencies: basis.dependencies,
          pendingConsent: basis.pendingConsent,
        };
      }
    } else if (resolvedDependency.source) {
      status = 'will-install';
      const result = await fetchPluginSource(
        resolvedDependency.source,
        pluginsDir,
        logger,
      );
      if (!('error' in result)) {
        try {
          try {
            depManifest = readPluginManifestFileSync(
              join(result.tempDir, 'plugin.json'),
            );
          } catch (error) {
            logger.debug('Failed to read fetched dependency manifest', {
              dep: dependency.id,
              error,
            });
          }
          depGit = await getPluginGitInfo(result.tempDir, logger);
          if (depManifest) {
            unsupported = unsupportedDependencyFeatures(
              result.tempDir,
              depManifest,
              true,
            );
            const basis = derivePluginConsentBasis(result.tempDir, depManifest);
            if (basis) {
              consent = {
                contentDigest: basis.contentDigest,
                permissions: basis.required,
                dependencies: basis.dependencies,
                pendingConsent: basis.pendingConsent,
              };
            }
          }
        } finally {
          rmSync(result.tempDir, { recursive: true, force: true });
        }
      }
    } else {
      try {
        const registry = getPluginRegistryProvider();
        const resolvedSource = await registry.resolveSource?.(dependency.id);
        const available = resolvedSource
          ? [{ id: dependency.id, source: resolvedSource }]
          : ((await registry.listAvailable?.()) ?? []);
        const match = available.find((entry) => entry.id === dependency.id);
        if (match) {
          status = 'will-install';
          if (match.source) {
            dependencySourceContext = match.source;
            const result = await fetchPluginSource(
              match.source,
              pluginsDir,
              logger,
            );
            if (!('error' in result)) {
              try {
                depManifest = readPluginManifestFileSync(
                  join(result.tempDir, 'plugin.json'),
                );
                unsupported = unsupportedDependencyFeatures(
                  result.tempDir,
                  depManifest,
                  true,
                );
                const basis = derivePluginConsentBasis(
                  result.tempDir,
                  depManifest,
                );
                if (basis) {
                  consent = {
                    contentDigest: basis.contentDigest,
                    permissions: basis.required,
                    dependencies: basis.dependencies,
                    pendingConsent: basis.pendingConsent,
                  };
                }
              } finally {
                rmSync(result.tempDir, { recursive: true, force: true });
              }
            }
          }
        }
      } catch (error) {
        logger.debug('Failed to check registry for dependency', {
          dep: dependency.id,
          error,
        });
      }
    }

    if (unsupported.length > 0) {
      throw new PluginPreviewUnsupportedDependencyError(
        dependency.id,
        unsupported,
      );
    }
    const components: Array<{ type: string; id: string }> = [];
    if (depManifest) {
      for (const agent of depManifest.agents || []) {
        components.push({
          type: 'agent',
          id: `${depManifest.name}:${agent.slug}`,
        });
      }
      if (depManifest.layout) {
        components.push({ type: 'layout', id: depManifest.layout.slug });
      }
      for (const provider of depManifest.providers || []) {
        components.push({ type: 'provider', id: provider.type });
      }
    }

    const resolved: ResolvedPluginDependency = {
      id: dependency.id,
      source: dependency.source,
      status,
      components: components.length ? components : undefined,
      git: depGit,
      consent,
    };
    // An installation preflight validates this exact source before recursion
    // can acquire anything named by its manifest. Ordinary preview is inert
    // discovery and does not supply an installation decision.
    await validation?.resolved(resolved);
    dependencies.push(resolved);

    if (depManifest) {
      dependencies.push(
        ...(await resolvePluginDependencies(
          depManifest,
          pluginsDir,
          getPluginRegistryProvider,
          logger,
          seen,
          dependencySourceContext &&
            !dangerousProtocolOrGitSource(dependencySourceContext)
            ? dependencySourceContext
            : dependencyDir,
          allowedLocalRoot,
          validation,
        )),
      );
    }
  }

  return dependencies;
}

/**
 * The outcome of one dependency install.
 *
 * `cause` carries the ORIGINAL thrown value, not just its message. A
 * `PluginContentLockCycleError` is refused concurrency, not a bad dependency,
 * and a caller can only tell the two apart — and answer 409 rather than 500,
 * naming the plugins involved — if the instance survives this result boundary
 * (archive#4309 follow-up). Callers that only report the failure can keep
 * reading `error` and ignore it.
 */
export interface PluginDependencyInstallResult {
  success: boolean;
  error?: string;
  cause?: unknown;
}

function dependencyFailure(error: unknown): PluginDependencyInstallResult {
  return { success: false, error: errorMessage(error), cause: error };
}

/**
 * Validates and rebuilds a dependency that is ALREADY present at
 * `<plugins>/<dependencyId>` — the manifest identity check, the lifecycle
 * refusal and the locked rebuild, in that order.
 *
 * Shared by the two places that meet an installed tree: the ordinary
 * already-installed path, and the source path when a concurrent operation
 * landed the dependency while this one was fetching it. Both must treat that
 * tree the same way, and neither may delete it.
 */
async function validateAndBuildInstalledDependency(
  pluginsDir: string,
  dependencyId: string,
  buildPlugin: (pluginDir: string, name: string) => Promise<void>,
  lifecycle?: PluginDependencyLifecycle,
  stagedSourceAlreadyValidated = false,
): Promise<void> {
  await withPluginContentLock(pluginsDir, dependencyId, async () => {
    const manifest = readInstalledDependencyManifest(pluginsDir, dependencyId);
    const format = readPluginManifestFileSyncWithFormat(
      join(pluginsDir, dependencyId, 'plugin.json'),
    ).format;
    if (format === 'agent-plugin-1.0') {
      if (
        resolveInstalledPluginRoot(pluginsDir, dependencyId)?.kind !==
        'incarnation'
      )
        throw new Error(
          `Portable dependency '${dependencyId}' needs migration through its installation owner`,
        );
      return;
    }
    assertDependencyLifecycleSupported(
      dependencyId,
      join(pluginsDir, dependencyId),
      manifest,
      lifecycle,
    );
    if (
      lifecycle &&
      (manifest.providers?.length || manifest.settings?.length)
    ) {
      lifecycle.validateInstalled?.({ dependencyId, manifest });
      return;
    }
    // Adoption alone is read-only, but an entrypoint rebuild executes a build
    // and replaces browser bytes. Bind that effect to the installed preview
    // basis while holding the same content lock through the actual build.
    if (manifest.entrypoint && !stagedSourceAlreadyValidated) {
      lifecycle?.validate({
        dependencyId,
        dependencyDir: join(pluginsDir, dependencyId),
        manifest,
      });
    }
    await buildDependencyIfNeeded(
      pluginsDir,
      dependencyId,
      manifest,
      buildPlugin,
    );
  });
}

async function recordCreatedDependency(options: {
  dependencyId: string;
  pluginsDir: string;
  targetDir: string;
  createdPluginTrees: Set<string>;
  createdPluginDigests: Map<string, string>;
  lifecycle?: PluginDependencyLifecycle;
}): Promise<void> {
  const installedDigest = computePluginContentDigest(
    options.pluginsDir,
    options.dependencyId,
  );
  if (!installedDigest) {
    const digestError = new Error(
      `Plugin dependency '${options.dependencyId}' could not bind rollback ownership to installed bytes`,
    );
    // The creating frame still holds this dependency's content lock, so this
    // is the last point at which the undigestible tree can be removed without
    // risking deletion of a later replacement. Never hand a name-only entry
    // to the outer rollback.
    try {
      await options.lifecycle?.rollback(options.dependencyId);
      rmSync(options.targetDir, { recursive: true, force: true });
    } catch (rollbackError) {
      throw new AggregateError(
        [digestError, rollbackError],
        `Plugin dependency '${options.dependencyId}' digest binding and rollback both failed`,
      );
    }
    throw digestError;
  }
  options.createdPluginTrees.add(options.dependencyId);
  options.createdPluginDigests.set(options.dependencyId, installedDigest);
}

/**
 * Installs one dependency, recursing into its own dependencies.
 *
 * `createdPluginTrees` is an OUT parameter, threaded through the recursion:
 * every `<plugins>/<id>` this call brings into being and leaves in place is
 * added to it. A caller that has to undo a partial install needs the identity
 * of what it created, and the only place that knows is the frame that created
 * it — a directory listing taken before and after cannot tell this install's
 * tree from one a concurrent install landed in the same window
 * (archive#4309 follow-up review, HIGH 1).
 *
 * `approvedIds` is the set of plugin ids an operator's install decision named,
 * threaded through the recursion the same way (archive#4288, review MEDIUM 1).
 * The consent gate can only check the ids the PARENT's staged manifest
 * declares; every level below it is read from a manifest fetched after the
 * decision was taken. So `P` depending on `D` is approved as `['D']`, `D`'s
 * repo gains `E` before the install runs, `P`'s bytes never change — and `E`
 * lands. Checked HERE because this is the frame that fetches, and refusing
 * before the fetch is what makes the refusal free.
 *
 * When omitted, no allow-list is enforced. The one production caller,
 * `installPluginFromSource`, always supplies one derived from the decision it
 * already refused to proceed without; callers that pass nothing are tests
 * exercising other properties of this function.
 */
export async function installPluginDependency(
  dependency: { id: string; source?: string; version?: string },
  pluginsDir: string,
  getPluginRegistryProvider: () => PluginRegistryInstaller,
  buildPlugin: (pluginDir: string, name: string) => Promise<void>,
  logger: Logger,
  installing: Set<string> = new Set(),
  createdPluginTrees: Set<string> = new Set(),
  approvedIds?: ReadonlySet<string>,
  lifecycle?: PluginDependencyLifecycle,
  allowedLocalRoot?: string,
  createdPluginDigests: Map<string, string> = new Map(),
): Promise<PluginDependencyInstallResult> {
  try {
    assertPluginDependencyId(dependency.id);
    // A dependency is a plugin, installed under one gesture from another
    // plugin's manifest — the path least likely to be read by the operator
    // approving it. It gets the same identity refusal the top-level install
    // gets, including on the already-installed branch below, which rebuilds
    // that plugin's tree in place.
    assertPluginIdentityAvailable(dependency.id);
  } catch (error: unknown) {
    return dependencyFailure(error);
  }
  if (approvedIds && !approvedIds.has(dependency.id)) {
    // Before the `existsSync` branch on purpose: that branch does not fetch,
    // but it does run this plugin's build against its installed tree, which is
    // still a write to a plugin the decision never named.
    return {
      success: false,
      error:
        `Plugin dependency '${dependency.id}' was not approved: it is not one of the plugins ` +
        `the install was reviewed against (${[...approvedIds].join(', ') || 'none'}). ` +
        `Preview the plugin again before installing it.`,
    };
  }
  const targetDir = join(pluginsDir, dependency.id);
  try {
    assertPathInside(pluginsDir, targetDir, 'Plugin dependency target');
  } catch (error: unknown) {
    return dependencyFailure(error);
  }

  // Recursion membership is graph authority and must win over filesystem
  // presence. Registry installers materialize a parent before traversing its
  // children, so checking the target first turns A -> B -> A into an
  // "already installed" success instead of a cycle refusal.
  if (installing.has(dependency.id)) {
    return {
      success: false,
      error: `Plugin dependency cycle detected: ${dependency.id}`,
    };
  }
  try {
    if (await lifecycle?.validatePortableInstalled?.(dependency))
      return { success: true };
  } catch (error) {
    return dependencyFailure(error);
  }
  if (existsSync(targetDir)) {
    try {
      const installedManifest = readInstalledDependencyManifest(
        pluginsDir,
        dependency.id,
      );
      if (
        dependency.version &&
        dependency.version !== '*' &&
        dependency.version !== installedManifest.version
      )
        throw new Error(
          `Plugin dependency '${dependency.id}' requires exact version '${dependency.version}', found '${installedManifest.version}'`,
        );
      await validateAndBuildInstalledDependency(
        pluginsDir,
        dependency.id,
        buildPlugin,
        lifecycle,
      );
      return { success: true };
    } catch (error: unknown) {
      return dependencyFailure(error);
    }
  }
  installing.add(dependency.id);
  let dependencySource = dependency.source;
  if (!dependencySource) {
    try {
      dependencySource =
        (await getPluginRegistryProvider().resolveSource?.(dependency.id)) ??
        undefined;
    } catch (error) {
      installing.delete(dependency.id);
      return dependencyFailure(error);
    }
  }
  if (dependencySource) {
    try {
      const result = await fetchPluginSource(
        dependencySource,
        pluginsDir,
        logger,
      );
      if ('error' in result) return { success: false, error: result.error };
      const { tempDir } = result;
      const { manifest: depManifest, format } =
        readPluginManifestFileSyncWithFormat(join(tempDir, 'plugin.json'));
      try {
        if (
          dependency.version &&
          dependency.version !== '*' &&
          dependency.version !== depManifest.version
        )
          throw new Error(
            `Plugin dependency '${dependency.id}' requires exact version '${dependency.version}', found '${depManifest.version}'`,
          );
        if (format === 'agent-plugin-1.0') {
          if (!lifecycle?.installPortable)
            throw new Error(
              `Portable dependency '${dependency.id}' requires its canonical installation owner`,
            );
          if (depManifest.name !== dependency.id)
            throw new Error(
              `Plugin dependency '${dependency.id}' source manifest name does not match`,
            );
          await lifecycle.installPortable({
            dependencyId: dependency.id,
            source: dependencySource,
            manifest: depManifest,
          });
          return { success: true };
        }
        if ((depManifest.name || dependency.id) !== dependency.id) {
          throw new Error(
            `Plugin dependency '${dependency.id}' source manifest name does not match`,
          );
        }
        assertDependencyLifecycleSupported(
          dependency.id,
          tempDir,
          depManifest,
          lifecycle,
        );
        lifecycle?.validate({
          dependencyId: dependency.id,
          dependencyDir: tempDir,
          manifest: depManifest,
        });
        await buildPlugin(tempDir, dependency.id);
        for (const transitive of depManifest.dependencies || []) {
          const resolvedTransitive = resolvePluginDependencySource(
            transitive,
            dependencySource,
            allowedLocalRoot,
          );
          const transitiveResult = await installPluginDependency(
            resolvedTransitive,
            pluginsDir,
            getPluginRegistryProvider,
            buildPlugin,
            logger,
            installing,
            createdPluginTrees,
            approvedIds,
            lifecycle,
            allowedLocalRoot,
            createdPluginDigests,
          );
          if (!transitiveResult.success) {
            throw new Error(
              transitiveResult.error ||
                `Plugin dependency '${transitive.id}' failed to install`,
              { cause: transitiveResult.cause },
            );
          }
        }
        // Everything above touches `tempDir` and OTHER plugins' installs;
        // `<plugins>/<id>` does not exist yet, so a failure up there has
        // nothing of ours to roll back — and used to delete that path anyway
        // (archive#4309 follow-up), which is how a concurrent install of the
        // same dependency lost its tree.
        //
        // From here the dependency's own tree is created, so the creation AND
        // the rollback that may undo it both run under the dependency's
        // content lock. The lock is re-entrant per async context, so
        // `buildDependencyIfNeeded` inside re-enters rather than deadlocking,
        // and a cycle is refused HERE — before anything is written — which is
        // why THIS function's rollback never has to take a lock from a catch
        // that fired because a lock could not be taken: it is already inside
        // the lock it needs. That says nothing about the caller's rollback,
        // which runs after this frame has released — see
        // `removeDependencyTreesCreatedByThisInstall` in
        // plugin-install-shared.ts (archive#4309 follow-up review, HIGH 1).
        return await withPluginContentLock(
          pluginsDir,
          dependency.id,
          async () => {
            if (existsSync(targetDir)) {
              // Another operation installed this dependency while we were
              // fetching its source. Its tree is not ours to replace, and not
              // ours to delete on failure.
              await validateAndBuildInstalledDependency(
                pluginsDir,
                dependency.id,
                buildPlugin,
                lifecycle,
              );
              return { success: true };
            }
            cpSync(tempDir, targetDir, { recursive: true });
            try {
              await validateAndBuildInstalledDependency(
                pluginsDir,
                dependency.id,
                buildPlugin,
                lifecycle,
                // This call owns a new tree copied from the staged source
                // validated before its build; its generated digest differs
                // legitimately from the source approval. Concurrent adoption
                // above must instead validate that installed tree's own basis.
                true,
              );
              await lifecycle?.activate({
                dependencyId: dependency.id,
                dependencyDir: targetDir,
                manifest: depManifest,
              });
            } catch (error) {
              try {
                await lifecycle?.rollback(dependency.id);
              } catch (rollbackError) {
                throw new AggregateError(
                  [error, rollbackError],
                  `Plugin dependency '${dependency.id}' activation and rollback both failed`,
                );
              }
              // Under this plugin's lock, and only the tree this call created.
              rmSync(targetDir, { recursive: true, force: true });
              throw error;
            }
            // Created here and left standing: bind deletion authority to its
            // exact bytes before exposing it to the caller's later rollback.
            await recordCreatedDependency({
              dependencyId: dependency.id,
              pluginsDir,
              targetDir,
              createdPluginTrees,
              createdPluginDigests,
              lifecycle,
            });
            return { success: true };
          },
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (error) {
      logger.debug('Failed to install plugin dependency from source', {
        dep: dependency.id,
        error,
      });
      return dependencyFailure(error);
    } finally {
      installing.delete(dependency.id);
    }
  }

  try {
    // The write, the validation that may reject it and the rollback that
    // deletes it all run under the dependency's content lock rather than
    // beside it (archive#4309 follow-up). The transitive loop stays inside
    // because it runs AFTER the tree exists, and a failure in it has to be
    // able to remove what this call installed; the dependency locks it takes
    // are nested, which the wait-for cycle check refuses rather than
    // deadlocks on.
    //
    // The span is therefore O(this dependency's whole transitive subtree): a
    // registry fetch, a `git clone`, an `npm install`, a bundle build, and
    // then the same again for every dependency below it. Everything else that
    // takes this plugin's content lock — a consent decision, an update, an
    // uninstall — QUEUES behind it, so the ceiling on that wait is the
    // subtree, not one install step. That is why the registry manifest fetch
    // is time-bounded (archive#4309 follow-up review, MEDIUM 2): an
    // unbounded network read inside here has no computable ceiling at all.
    return await withPluginContentLock(pluginsDir, dependency.id, async () => {
      if (existsSync(targetDir)) {
        // Another operation landed this dependency while we waited for its
        // lock. Adopt and validate it — never call the provider over it. The
        // JSON-manifest provider's install is `rmSync(targetDir)` +
        // `cpSync(staged, targetDir)` whenever an alias it owns already names
        // this plugin, so calling it here DELETES the concurrent operation's
        // tree from inside the provider, and the caller then cannot even roll
        // that back because it did not create it (archive#4309 follow-up
        // review, MEDIUM 1). Same shape as the source branch above.
        await validateAndBuildInstalledDependency(
          pluginsDir,
          dependency.id,
          buildPlugin,
          lifecycle,
        );
        return { success: true };
      }
      const registryProvider = getPluginRegistryProvider();
      const registryResult = await registryProvider.install(
        dependency.id,
        // See `PluginRegistryInstaller.install`: the provider picks its target
        // from the fetched manifest's name, this call has already committed to
        // `<plugins>/<dependency.id>`, and a provider that honours this
        // refuses before writing rather than rewriting another plugin's tree
        // under this plugin's lock.
        { expectedInstalledPluginName: dependency.id },
      );
      if (!registryResult.success) {
        return { success: false, error: registryResult.message };
      }
      // Nothing was there when the provider was called, so anything at
      // `targetDir` now is this call's to validate and, on failure, to undo.
      const createdHere = existsSync(targetDir);
      try {
        const depManifest = readInstalledDependencyManifest(
          pluginsDir,
          dependency.id,
        );
        assertDependencyLifecycleSupported(
          dependency.id,
          targetDir,
          depManifest,
          lifecycle,
        );
        lifecycle?.validate({
          dependencyId: dependency.id,
          dependencyDir: targetDir,
          manifest: depManifest,
        });
        await buildDependencyIfNeeded(
          pluginsDir,
          dependency.id,
          depManifest,
          buildPlugin,
        );
        for (const transitive of depManifest.dependencies || []) {
          const transitiveResult = await installPluginDependency(
            transitive,
            pluginsDir,
            getPluginRegistryProvider,
            buildPlugin,
            logger,
            installing,
            createdPluginTrees,
            approvedIds,
            lifecycle,
            allowedLocalRoot,
            createdPluginDigests,
          );
          if (!transitiveResult.success) {
            throw new Error(
              transitiveResult.error ||
                `Plugin dependency '${transitive.id}' failed to install`,
              { cause: transitiveResult.cause },
            );
          }
        }
        await lifecycle?.activate({
          dependencyId: dependency.id,
          dependencyDir: targetDir,
          manifest: depManifest,
        });
        // Bind deletion authority before reporting success. Keeping this in
        // the provider-validation try means an undigestible tree receives the
        // same registry compensation as any other post-install refusal.
        await recordCreatedDependency({
          dependencyId: dependency.id,
          pluginsDir,
          targetDir,
          createdPluginTrees,
          createdPluginDigests,
          lifecycle,
        });
      } catch (error) {
        logger.debug(
          'Failed to validate plugin dependency after registry install',
          { dep: dependency.id, error },
        );
        if (createdHere) {
          const rollbackFailures: unknown[] = [];
          try {
            await lifecycle?.rollback(dependency.id);
          } catch (rollbackError) {
            rollbackFailures.push(rollbackError);
          }
          try {
            await registryResult.rollback?.();
          } catch (rollbackError) {
            rollbackFailures.push(rollbackError);
          }
          rmSync(targetDir, { recursive: true, force: true });
          if (rollbackFailures.length > 0) {
            return dependencyFailure(
              new AggregateError(
                [error, ...rollbackFailures],
                `Plugin dependency '${dependency.id}' activation and rollback both failed`,
              ),
            );
          }
        } else {
          // The provider reported success but nothing is at `targetDir`: it
          // resolved a different plugin name and wrote somewhere else. That
          // tree is not this call's to delete — the validation above has
          // already failed with `did not materialize after install`, which is
          // what the caller reports.
          logger.warn(
            'Registry install reported success but left no tree at the dependency path; deleting nothing',
            { dep: dependency.id },
          );
        }
        return dependencyFailure(error);
      }
      return { success: true };
    });
  } catch (error: unknown) {
    return dependencyFailure(error);
  } finally {
    installing.delete(dependency.id);
  }
}

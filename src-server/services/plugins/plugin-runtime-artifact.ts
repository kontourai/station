import { lstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import type { PackageMcpAdmissionJournal } from './package-mcp-admission.js';
import {
  computePluginContentDigest,
  computePluginContentDigestAsync,
  observePluginContentAsync,
} from './plugin-content-integrity.js';
import { resolveInstalledPluginRoot } from './plugin-incarnation.js';
import { captureLocalPluginInstallation } from './plugin-installation-local.js';
import {
  parsePluginManifestDocument,
  readPluginManifestFileSync,
} from './plugin-manifest-loader.js';
import type { CapturedPluginPermissionArtifact } from './plugin-permissions.js';

/** Runtime-only selection. Pending generations never become execution inputs. */
export interface PluginRuntimeArtifact
  extends CapturedPluginPermissionArtifact {
  readonly packageRoot: string;
  readonly manifest: PluginManifest;
  isCurrentAsync(): Promise<boolean>;
}

function runtimeArtifactCandidate(
  pluginsDir: string,
  pluginId: string,
  journal?: PackageMcpAdmissionJournal,
) {
  const captured = journal
    ? captureLocalPluginInstallation(pluginsDir, journal, pluginId)
    : null;
  const root =
    captured?.root ??
    (journal ? null : resolveInstalledPluginRoot(pluginsDir, pluginId));
  if (!root || (!journal && root.kind !== 'legacy')) return null;
  if (captured && !captured.isCurrent()) return null;
  const manifestPath = join(root.packageRoot, 'plugin.json');
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink())
    throw new Error('Plugin manifest must be a regular file.');
  const manifest = readPluginManifestFileSync(manifestPath);
  if (manifest.name !== pluginId) return null;
  return { pluginsDir, pluginId, root, captured, manifest };
}

function bindRuntimeArtifact(
  candidate: NonNullable<ReturnType<typeof runtimeArtifactCandidate>>,
  digest: string | null,
): PluginRuntimeArtifact | null {
  const { pluginsDir, pluginId, root, captured, manifest } = candidate;
  if (
    !digest ||
    manifest.name !== pluginId ||
    (captured?.installation && captured.installation.contentDigest !== digest)
  )
    return null;
  const selectionCurrent = () => {
    try {
      if (captured) return captured.isCurrent();
      const current = resolveInstalledPluginRoot(pluginsDir, pluginId);
      return (
        current?.kind === 'legacy' && current.packageRoot === root.packageRoot
      );
    } catch {
      return false;
    }
  };
  if (!selectionCurrent()) return null;
  return Object.freeze({
    pluginId,
    ...(captured?.installation
      ? { generation: captured.installation.incarnation }
      : {}),
    packageRoot: root.packageRoot,
    manifest,
    digest,
    isCurrent() {
      return (
        selectionCurrent() &&
        computePluginContentDigest(
          dirname(root.packageRoot),
          basename(root.packageRoot),
        ) === digest
      );
    },
    async isCurrentAsync() {
      return (
        selectionCurrent() &&
        (await computePluginContentDigestAsync(
          dirname(root.packageRoot),
          basename(root.packageRoot),
        )) === digest &&
        selectionCurrent()
      );
    },
  });
}

export function capturePluginRuntimeArtifact(
  pluginsDir: string,
  pluginId: string,
  journal?: PackageMcpAdmissionJournal,
): PluginRuntimeArtifact | null {
  const candidate = runtimeArtifactCandidate(pluginsDir, pluginId, journal);
  if (!candidate) return null;
  const artifact = bindRuntimeArtifact(
    candidate,
    computePluginContentDigest(
      dirname(candidate.root.packageRoot),
      basename(candidate.root.packageRoot),
    ),
  );
  return artifact?.isCurrent() ? artifact : null;
}

/** HTTP callers recheck every byte without monopolizing the server event loop. */
export async function capturePluginRuntimeArtifactAsync(
  pluginsDir: string,
  pluginId: string,
  journal?: PackageMcpAdmissionJournal,
): Promise<PluginRuntimeArtifact | null> {
  const candidate = runtimeArtifactCandidate(pluginsDir, pluginId, journal);
  if (!candidate) return null;
  const observed = await observePluginContentAsync(
    dirname(candidate.root.packageRoot),
    basename(candidate.root.packageRoot),
  );
  if (!observed || observed.manifestText === undefined) return null;
  return bindRuntimeArtifact(
    {
      ...candidate,
      manifest: parsePluginManifestDocument(
        observed.manifestText,
        join(candidate.root.packageRoot, 'plugin.json'),
      ),
    },
    observed.digest,
  );
}

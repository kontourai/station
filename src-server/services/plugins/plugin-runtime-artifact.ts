import { basename, dirname, join } from 'node:path';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import type { PackageMcpAdmissionJournal } from './package-mcp-admission.js';
import { computePluginContentDigest } from './plugin-content-integrity.js';
import { resolveInstalledPluginRoot } from './plugin-incarnation.js';
import { captureLocalPluginInstallation } from './plugin-installation-local.js';
import { readPluginManifestFileSync } from './plugin-manifest-loader.js';
import type { CapturedPluginPermissionArtifact } from './plugin-permissions.js';

/** Runtime-only selection. Pending generations never become execution inputs. */
export interface PluginRuntimeArtifact
  extends CapturedPluginPermissionArtifact {
  readonly packageRoot: string;
  readonly manifest: PluginManifest;
}

export function capturePluginRuntimeArtifact(
  pluginsDir: string,
  pluginId: string,
  journal?: PackageMcpAdmissionJournal,
): PluginRuntimeArtifact | null {
  const captured = journal
    ? captureLocalPluginInstallation(pluginsDir, journal, pluginId)
    : null;
  const root =
    captured?.root ??
    (journal ? null : resolveInstalledPluginRoot(pluginsDir, pluginId));
  if (!root || (!journal && root.kind !== 'legacy')) return null;
  if (captured && !captured.isCurrent()) return null;
  const digest = computePluginContentDigest(
    dirname(root.packageRoot),
    basename(root.packageRoot),
  );
  if (
    !digest ||
    (captured?.installation && captured.installation.contentDigest !== digest)
  )
    return null;
  const manifest = readPluginManifestFileSync(
    join(root.packageRoot, 'plugin.json'),
  );
  if (manifest.name !== pluginId) return null;
  const isCurrent = () => {
    try {
      if (captured) {
        if (!captured.isCurrent()) return false;
      } else {
        const current = resolveInstalledPluginRoot(pluginsDir, pluginId);
        if (
          current?.kind !== 'legacy' ||
          current.packageRoot !== root.packageRoot
        )
          return false;
      }
      return (
        computePluginContentDigest(
          dirname(root.packageRoot),
          basename(root.packageRoot),
        ) === digest
      );
    } catch {
      return false;
    }
  };
  return isCurrent()
    ? Object.freeze({
        pluginId,
        ...(captured?.installation
          ? { generation: captured.installation.incarnation }
          : {}),
        packageRoot: root.packageRoot,
        manifest,
        digest,
        isCurrent,
      })
    : null;
}

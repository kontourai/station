import { lstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { PluginInstallationReadiness } from '@kontourai/station-contracts/plugin';
import { scanInstalledPluginInventory } from './installed-plugin-inventory.js';
import type { PackageMcpAdmissionJournal } from './package-mcp-admission.js';
import { computePluginContentDigest } from './plugin-content-integrity.js';
import { resolveInstalledPluginRoot } from './plugin-incarnation.js';
import { captureLocalPluginInstallation } from './plugin-installation-local.js';
import { readPluginManifestFileSync } from './plugin-manifest-loader.js';

/** Inert discovery only. This result is never an invocation or activation permit. */
export function readPluginCatalogInstallation(
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
  const digest = computePluginContentDigest(
    dirname(root.packageRoot),
    basename(root.packageRoot),
  );
  if (
    !digest ||
    (captured?.installation && captured.installation.contentDigest !== digest)
  )
    return null;
  const manifestPath = join(root.packageRoot, 'plugin.json');
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink())
    throw new Error('Plugin manifest must be a regular file.');
  const manifest = readPluginManifestFileSync(manifestPath);
  if (manifest.name !== pluginId) return null;
  let readiness: PluginInstallationReadiness = { state: 'ready' };
  if (captured?.installation) {
    const current = journal!.currentInstallation(pluginId);
    if (
      current.state !== 'observed' ||
      current.installation.incarnation !== captured.installation.incarnation
    )
      return null;
    const inspection = journal!.inspect(captured.installation);
    readiness = captured.isCurrent()
      ? { state: 'ready' }
      : inspection.state === 'observed' &&
          inspection.admission === 'activation-pending'
        ? { state: 'pending', recovery: 'review' }
        : { state: 'unavailable' };
  }
  return {
    manifest,
    packageRoot: root.packageRoot,
    retained: root.kind === 'incarnation',
    readiness,
    artifact: {
      pluginId,
      digest,
      isCurrent: () =>
        captured
          ? captured.isCurrent() &&
            computePluginContentDigest(
              dirname(root.packageRoot),
              basename(root.packageRoot),
            ) === digest
          : resolveInstalledPluginRoot(pluginsDir, pluginId)?.packageRoot ===
              root.packageRoot &&
            computePluginContentDigest(
              dirname(root.packageRoot),
              basename(root.packageRoot),
            ) === digest,
    },
  };
}

export function listPluginCatalogIdentities(
  pluginsDir: string,
  journal?: PackageMcpAdmissionJournal,
): string[] {
  const selected = journal?.selectedInstallations();
  if (selected?.state === 'unavailable')
    throw new Error('Plugin installation inventory unavailable.');
  return [
    ...new Set([
      ...scanInstalledPluginInventory(pluginsDir).map(
        (entry) => entry.directoryName,
      ),
      ...(selected?.installations.map((entry) => entry.pluginId) ?? []),
    ]),
  ].sort();
}

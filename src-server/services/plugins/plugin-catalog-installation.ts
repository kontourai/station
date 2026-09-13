import { lstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { PluginInstallationReadiness } from '@kontourai/station-contracts/plugin';
import { scanInstalledPluginInventory } from './installed-plugin-inventory.js';
import type { PackageMcpAdmissionJournal } from './package-mcp-admission.js';
import {
  computePluginContentDigest,
  computePluginContentDigestAsync,
} from './plugin-content-integrity.js';
import { resolveInstalledPluginRoot } from './plugin-incarnation.js';
import { captureLocalPluginInstallation } from './plugin-installation-local.js';
import { readPluginManifestFileSync } from './plugin-manifest-loader.js';

/** Inert discovery only. This result is never an invocation or activation permit. */
function catalogInstallationCandidate(
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
  return { pluginsDir, pluginId, journal, captured, root };
}

function bindCatalogInstallation(
  candidate: NonNullable<ReturnType<typeof catalogInstallationCandidate>>,
  digest: string | null,
) {
  const { pluginsDir, pluginId, journal, captured, root } = candidate;
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
  if (
    !captured &&
    resolveInstalledPluginRoot(pluginsDir, pluginId)?.packageRoot !==
      root.packageRoot
  )
    return null;
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
  const selectionCurrent = () =>
    captured
      ? captured.isCurrent()
      : resolveInstalledPluginRoot(pluginsDir, pluginId)?.packageRoot ===
        root.packageRoot;
  return {
    manifest,
    packageRoot: root.packageRoot,
    retained: root.kind === 'incarnation',
    readiness,
    artifact: {
      pluginId,
      digest,
      isCurrent: () =>
        selectionCurrent() &&
        computePluginContentDigest(
          dirname(root.packageRoot),
          basename(root.packageRoot),
        ) === digest,
      isCurrentAsync: async () =>
        selectionCurrent() &&
        (await computePluginContentDigestAsync(
          dirname(root.packageRoot),
          basename(root.packageRoot),
        )) === digest &&
        selectionCurrent(),
    },
  };
}

export function readPluginCatalogInstallation(
  pluginsDir: string,
  pluginId: string,
  journal?: PackageMcpAdmissionJournal,
) {
  const candidate = catalogInstallationCandidate(pluginsDir, pluginId, journal);
  return candidate
    ? bindCatalogInstallation(
        candidate,
        computePluginContentDigest(
          dirname(candidate.root.packageRoot),
          basename(candidate.root.packageRoot),
        ),
      )
    : null;
}

export async function readPluginCatalogInstallationAsync(
  pluginsDir: string,
  pluginId: string,
  journal?: PackageMcpAdmissionJournal,
) {
  const candidate = catalogInstallationCandidate(pluginsDir, pluginId, journal);
  return candidate
    ? bindCatalogInstallation(
        candidate,
        await computePluginContentDigestAsync(
          dirname(candidate.root.packageRoot),
          basename(candidate.root.packageRoot),
        ),
      )
    : null;
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

import { lstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { PluginInstallationReadiness } from '@kontourai/station-contracts/plugin';
import { scanInstalledPluginInventory } from './installed-plugin-inventory.js';
import type {
  PackageMcpAdmissionJournal,
  PackageMcpInstallation,
} from './package-mcp-admission.js';
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
    /** The journal generation this observation bound, for display reads only. */
    installation: captured?.installation,
    artifact: {
      pluginId,
      ...(captured?.installation
        ? { generation: captured.installation.incarnation }
        : {}),
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

export type PluginTrustMigrationClassification =
  | { kind: 'absent' }
  /** The bytes or manifest could not be read now; retry on a later start. */
  | { kind: 'transient' }
  /** Installed bytes disagree with their authority; never grandfathered. */
  | { kind: 'mismatch' }
  | {
      kind: 'installed';
      digest: string;
      installation: PackageMcpInstallation | undefined;
    };

/**
 * #2998: what the install trust migration may conclude about one plugin. It
 * separates "cannot read it now" (retry) from "it does not match its own
 * authority" (never grandfathered), which the catalog read folds together.
 */
export async function classifyPluginForTrustMigration(
  pluginsDir: string,
  pluginId: string,
  journal?: PackageMcpAdmissionJournal,
): Promise<PluginTrustMigrationClassification> {
  let candidate: ReturnType<typeof catalogInstallationCandidate>;
  try {
    candidate = catalogInstallationCandidate(pluginsDir, pluginId, journal);
  } catch {
    return { kind: 'transient' };
  }
  if (!candidate) return { kind: 'absent' };
  const { captured, root } = candidate;
  let digest: string | null;
  try {
    digest = await computePluginContentDigestAsync(
      dirname(root.packageRoot),
      basename(root.packageRoot),
    );
  } catch {
    return { kind: 'transient' };
  }
  if (!digest) return { kind: 'transient' };
  if (captured?.installation && captured.installation.contentDigest !== digest)
    return { kind: 'mismatch' };
  try {
    const manifestPath = join(root.packageRoot, 'plugin.json');
    const manifestStat = lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink())
      return { kind: 'mismatch' };
    if (readPluginManifestFileSync(manifestPath).name !== pluginId)
      return { kind: 'mismatch' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return typeof code === 'string' && /^E[A-Z0-9]+$/.test(code)
      ? { kind: 'transient' }
      : { kind: 'mismatch' };
  }
  if (
    !captured &&
    resolveInstalledPluginRoot(pluginsDir, pluginId)?.packageRoot !==
      root.packageRoot
  )
    return { kind: 'mismatch' };
  return {
    kind: 'installed',
    digest,
    installation: captured?.installation ?? undefined,
  };
}

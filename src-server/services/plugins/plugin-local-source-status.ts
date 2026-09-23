/**
 * Which Project folders are the source of an installed local-folder plugin,
 * and whether each still holds the code that was installed (#2323 S4).
 *
 * The match is derived, never stored. An installation records its
 * acquisition origin as a hash over {owner, registry, realpath of source}
 * (`pluginAcquisitionOrigin`); this recomputes that hash for each Project's
 * working directory, as an unregistered local source, and keeps the
 * installations whose recorded origin equals it. A folder that was installed
 * through a registry, or from another spelling that realpaths elsewhere,
 * does not match, which is the same rule the installer applies when it
 * refuses to hand a data scope to a different origin.
 *
 * "Changed" compares the folder's in-place tree digest with the SOURCE digest
 * the installation's activation plan recorded at consent (the preview's
 * `contentDigest`), not with the installed artifact's digest, which includes
 * the built bundle and never equals a source tree.
 *
 * Read-only: nothing here stages, builds, installs or writes. The result
 * names plugins and Projects, never a host path.
 */
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { PluginLocalSourceStatus } from '@kontourai/station-contracts/plugin';
import { expandTilde } from '../../utils/paths.js';
import type {
  PackageMcpAdmissionJournal,
  PackageMcpInstallation,
} from './package-mcp-admission.js';
import { pluginAcquisitionOrigin } from './plugin-acquisition-origin.js';
import { observeLocalPluginSourceDigest } from './plugin-source-digest.js';
import { resolvePluginValidateSource } from './plugin-validate-source.js';

export class PluginInstallationsUnavailableError extends Error {
  constructor() {
    super('Plugin installations are unavailable; reload Plugins and retry.');
    this.name = 'PluginInstallationsUnavailableError';
  }
}

export async function observeLocalPluginSourceStatuses(input: {
  projectHomeDir: string;
  journal: Pick<
    PackageMcpAdmissionJournal,
    'selectedInstallations' | 'activationPlan'
  >;
  projects: ReadonlyArray<{ slug: string; workingDirectory?: string }>;
}): Promise<PluginLocalSourceStatus[]> {
  const selected = input.journal.selectedInstallations();
  if (selected.state !== 'observed')
    throw new PluginInstallationsUnavailableError();
  const byOrigin = new Map<string, PackageMcpInstallation[]>();
  for (const installation of selected.installations) {
    if (!installation.origin) continue;
    const list = byOrigin.get(installation.origin) ?? [];
    list.push(installation);
    byOrigin.set(installation.origin, list);
  }
  if (byOrigin.size === 0) return [];

  const statuses: PluginLocalSourceStatus[] = [];
  for (const project of input.projects) {
    const stored = project.workingDirectory?.trim();
    if (!stored) continue;
    const expanded = expandTilde(stored);
    if (!isAbsolute(expanded)) continue;
    // The same refusal validate applies, before any filesystem call: a
    // Project folder on a UNC or automount path is never stat-ed here.
    const resolved = resolvePluginValidateSource(expanded);
    if (!resolved.ok || !existsSync(resolved.path)) continue;
    let origin: string;
    try {
      origin = pluginAcquisitionOrigin({
        projectHomeDir: input.projectHomeDir,
        source: resolved.path,
      });
    } catch {
      continue;
    }
    for (const installation of byOrigin.get(origin) ?? []) {
      const base = {
        pluginName: installation.pluginId,
        projectSlug: project.slug,
      };
      const installedSourceDigest =
        input.journal.activationPlan(installation)?.sourceDigest;
      if (!installedSourceDigest) {
        statuses.push({ ...base, status: 'unknown', reason: 'not-recorded' });
        continue;
      }
      if (!isAbsolute(stored)) {
        statuses.push({
          ...base,
          status: 'unknown',
          reason: 'source-path-not-absolute',
          installedSourceDigest,
        });
        continue;
      }
      const observed = await observeLocalPluginSourceDigest(resolved.path);
      if ('unavailable' in observed) {
        statuses.push({
          ...base,
          status: 'unknown',
          reason: observed.unavailable,
          installedSourceDigest,
        });
        continue;
      }
      statuses.push({
        ...base,
        status:
          observed.digest === installedSourceDigest ? 'unchanged' : 'changed',
        installedSourceDigest,
        currentSourceDigest: observed.digest,
      });
    }
  }
  return statuses;
}

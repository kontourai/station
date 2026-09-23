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
 * Cost: Projects are member-creatable, so many Projects can name one
 * folder. Each canonical folder is walked at most once per request,
 * concurrent requests join a walk already in flight, and one request walks
 * at most LOCAL_SOURCE_STATUS_MAX_FOLDERS distinct folders.
 *
 * Read-only: nothing here stages, builds, installs or writes. The result
 * names plugins and Projects, never a host path.
 */
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { PluginLocalSourceStatus } from '@kontourai/station-contracts/plugin';
import { expandTilde } from '../../utils/paths.js';
import type {
  PackageMcpAdmissionJournal,
  PackageMcpInstallation,
} from './package-mcp-admission.js';
import { pluginAcquisitionOrigin } from './plugin-acquisition-origin.js';
import {
  type LocalSourceDigestObservation,
  observeLocalPluginSourceDigest,
} from './plugin-source-digest.js';
import { resolvePluginValidateSource } from './plugin-validate-source.js';

/** The one sentence a caller sees when the installation journal is unreadable. */
export const PLUGIN_INSTALLATIONS_UNAVAILABLE =
  'Plugin installations are unavailable; reload Plugins and retry.';

export class PluginInstallationsUnavailableError extends Error {
  constructor() {
    super(PLUGIN_INSTALLATIONS_UNAVAILABLE);
    this.name = 'PluginInstallationsUnavailableError';
  }
}

/**
 * The most distinct source folders one request walks (#2323 S4 review).
 * Projects are member-creatable, so the Project list is not a cost bound;
 * the number of distinct matching folders is. Past it, a folder reads
 * `unknown` / `too-many-sources` rather than being walked.
 */
export const LOCAL_SOURCE_STATUS_MAX_FOLDERS = 16;

/**
 * Walks in flight, by canonical folder, shared across requests: concurrent
 * status reads of one folder share one walk. Entries leave when the walk
 * settles, so nothing here is a cache; a later read walks again and sees
 * later edits.
 */
const inFlightWalks = new Map<string, Promise<LocalSourceDigestObservation>>();

function observeShared(folder: string): Promise<LocalSourceDigestObservation> {
  const joined = inFlightWalks.get(folder);
  if (joined) return joined;
  const walk = observeLocalPluginSourceDigest(folder).finally(() => {
    inFlightWalks.delete(folder);
  });
  inFlightWalks.set(folder, walk);
  return walk;
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

  // One walk per canonical folder per request, however many Projects name
  // it, and at most LOCAL_SOURCE_STATUS_MAX_FOLDERS of them.
  const walks = new Map<string, Promise<LocalSourceDigestObservation>>();
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
    let folder: string;
    let origin: string;
    try {
      folder = realpathSync.native(resolved.path);
      origin = pluginAcquisitionOrigin({
        projectHomeDir: input.projectHomeDir,
        source: folder,
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
      let walk = walks.get(folder);
      if (!walk) {
        if (walks.size >= LOCAL_SOURCE_STATUS_MAX_FOLDERS) {
          statuses.push({
            ...base,
            status: 'unknown',
            reason: 'too-many-sources',
            installedSourceDigest,
          });
          continue;
        }
        walk = observeShared(folder);
        walks.set(folder, walk);
      }
      const observed = await walk;
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

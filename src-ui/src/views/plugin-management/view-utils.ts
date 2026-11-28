import {
  describeActivationDeadline,
  type PluginLifecycleUnapplied,
} from '@kontourai/station-contracts/plugin';
import {
  isRejectedPlugin,
  type Plugin,
  type PluginUpdateSummary,
  type PreviewData,
  type ReadyPlugin,
  type ReinstallFromSource,
} from './types';

export function pluginSelectionId(plugin: Plugin) {
  return isRejectedPlugin(plugin) ? `rejected:${plugin.name}` : plugin.name;
}

export function filterPlugins(plugins: Plugin[], search: string) {
  const query = search.toLowerCase();
  return plugins.filter((plugin) => {
    if (!query) return true;
    if (isRejectedPlugin(plugin)) {
      return (
        plugin.displayName.toLowerCase().includes(query) ||
        plugin.rejection.reason.toLowerCase().includes(query) ||
        plugin.rejection.recovery.instruction.toLowerCase().includes(query)
      );
    }
    return (
      (plugin.displayName || plugin.name).toLowerCase().includes(query) ||
      plugin.description?.toLowerCase().includes(query)
    );
  });
}

function readinessPrefix(plugin: {
  installationReadiness?: { state: string };
  activationInFlight?: true;
}) {
  const state = plugin.installationReadiness?.state;
  if (state === 'pending')
    return plugin.activationInFlight ? 'Activating… · ' : 'Needs recovery · ';
  if (state === 'unavailable') return 'Unavailable · ';
  return '';
}

export function buildPluginListItems(
  plugins: Plugin[],
  updates: readonly PluginUpdateSummary[] = [],
) {
  const available = new Set(updates.map((update) => update.name));
  return plugins.map((plugin) =>
    isRejectedPlugin(plugin)
      ? {
          id: pluginSelectionId(plugin),
          name: plugin.displayName,
          subtitle: `Rejected · ${plugin.rejection.reason}`,
        }
      : {
          id: pluginSelectionId(plugin),
          name: plugin.displayName || plugin.name,
          subtitle: `${readinessPrefix(plugin)}v${plugin.version}${available.has(plugin.name) ? ' · Update available' : ''}${plugin.description ? ` · ${plugin.description}` : ''}`,
        },
  );
}

export function slugifyProjectName(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'default'
  );
}

export function toggleSetValue(
  current: ReadonlySet<string>,
  value: string,
): Set<string> {
  const next = new Set(current);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}

/**
 * A path-safe identifier as a person would read it: `getting-started` ->
 * "Getting Started" (#1536 review M4). Reached only when the payload carries
 * no display name of its own — a manifest slug is what the reader is stuck
 * with otherwise, and it is the thing they were shown before.
 *
 * Deliberately conservative: an identifier carrying a separator that is not a
 * word break (a dotted or slashed id) is returned unchanged rather than
 * mangled into a fabricated name, the same rule `prettifyModelId` follows.
 */
function humanizeContributionSlug(slug: string): string {
  const id = slug.trim();
  if (!id || /[./:]/.test(id)) return id;
  return (
    id
      .split(/[-_]+/)
      .filter(Boolean)
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join(' ') || id
  );
}

/**
 * What an installed plugin CONTRIBUTES, in the reader's words.
 *
 * The detail page listed `ui` and `layout:getting-started` capability chips
 * and nothing else, so after installing a starter there was no way to see
 * what had arrived or to reach it (#1536 G2). This is the same manifest data
 * the chips render, and it carries the `layoutSlug` the Add Layout flow needs.
 *
 * Each entry is NAMED — its own display name when the payload
 * carries one (panes always do; a layout will once the route sends it), and a
 * humanized identifier otherwise. It used to pass the raw slug through under
 * the field called `name`, so the section promised things and rendered
 * `getting-started`.
 */
interface PluginContribution {
  kind: 'layout' | 'pane' | 'agent' | 'provider';
  kindLabel: string;
  /** Stable within a plugin; the render key. */
  id: string;
  name: string;
  /** Present only on a layout, and only then can it be added to a project. */
  layoutSlug?: string;
}

export function pluginContributions(plugin: ReadyPlugin): PluginContribution[] {
  const contributions: PluginContribution[] = [];
  if (plugin.layout) {
    const declared =
      plugin.layout.name || plugin.layout.displayName || plugin.layout.title;
    contributions.push({
      kind: 'layout',
      kindLabel: 'Layout',
      id: `layout:${plugin.layout.slug}`,
      name: declared || humanizeContributionSlug(plugin.layout.slug),
      layoutSlug: plugin.layout.slug,
    });
  }
  for (const pane of plugin.workspacePanes ?? []) {
    contributions.push({
      kind: 'pane',
      kindLabel: 'Pane',
      id: `pane:${pane.id}`,
      name: pane.name || humanizeContributionSlug(pane.id),
    });
  }
  for (const agent of plugin.agents ?? []) {
    contributions.push({
      kind: 'agent',
      kindLabel: 'Agent',
      id: `agent:${agent.slug}`,
      name: humanizeContributionSlug(agent.slug),
    });
  }
  for (const provider of plugin.providers ?? []) {
    contributions.push({
      kind: 'provider',
      kindLabel: 'Connection type',
      id: `provider:${provider.type}`,
      // A provider TYPE is an identifier the operator matches against
      // configuration, not a product name — shown as declared.
      name: provider.type,
    });
  }
  return contributions;
}

/**
 * The project an "Add to project" action would target without asking. Only
 * when there is exactly one: with none there is nothing to add to, and with
 * several the destination is a real question the Add Layout picker asks.
 */
export function soleLayoutTargetProject<
  T extends { slug: string; name: string },
>(projects: readonly T[]): T | null {
  return projects.length === 1 ? projects[0] : null;
}

export interface ReinstallPermissionChange {
  permission: string;
  /** Set when the permission belongs to a dependency, not the plugin itself. */
  dependency?: string;
}

/**
 * #2323 S4: what a reinstall from source changes, against what is installed.
 *
 * Permissions are compared with CURRENT grants. "added" is what the new
 * version, or a dependency it brings, requests and does not hold now (a
 * dependency that is not installed holds nothing). "removed" is what the
 * plugin itself holds now and the new version no longer requests; a
 * dependency's grants are never dropped by a reinstall, so they are not
 * listed there. This is disclosure, not the decision: the consent step still
 * asks exactly what it asks for any install.
 *
 * "Code" compares the preview's digest with the source digest the
 * installation recorded; with no recorded digest it is `unknown`, never
 * `unchanged`. A dependency the install would add, reported with no
 * permissions, is listed as unknown. A preview that reported no permissions has no permission
 * delta (`null`), rather than one claiming every grant was dropped.
 */
export function reinstallDelta(
  installed: Pick<
    ReinstallFromSource,
    'grantedPermissions' | 'installedGrants' | 'installedSourceDigest'
  >,
  preview: Pick<PreviewData, 'contentDigest' | 'permissions' | 'dependencies'>,
): {
  permissions: {
    added: ReinstallPermissionChange[];
    removed: ReinstallPermissionChange[];
    /**
     * Dependencies the install would add whose permissions the preview did
     * not report. Their permissions are unknown here, never "no change".
     */
    unknownDependencies: string[];
  } | null;
  code: 'changed' | 'unchanged' | 'unknown';
} {
  const code =
    !installed.installedSourceDigest || !preview.contentDigest
      ? 'unknown'
      : installed.installedSourceDigest === preview.contentDigest
        ? 'unchanged'
        : 'changed';
  if (!preview.permissions) return { permissions: null, code };
  const required = new Set(preview.permissions.required);
  const granted = new Set(installed.grantedPermissions);
  const added: ReinstallPermissionChange[] = [...required]
    .filter((entry) => !granted.has(entry))
    .sort()
    .map((permission) => ({ permission }));
  const unknownDependencies: string[] = [];
  for (const dependency of preview.dependencies ?? []) {
    if (!dependency.consent && dependency.status !== 'installed') {
      unknownDependencies.push(dependency.id);
      continue;
    }
    const held = new Set(installed.installedGrants[dependency.id] ?? []);
    for (const permission of [
      ...new Set(dependency.consent?.permissions ?? []),
    ].sort())
      if (!held.has(permission))
        added.push({ permission, dependency: dependency.id });
  }
  return {
    permissions: {
      added,
      removed: [...granted]
        .filter((entry) => !required.has(entry))
        .sort()
        .map((permission) => ({ permission })),
      unknownDependencies,
    },
    code,
  };
}

/**
 * An install or update the server saved but did not apply (its designed
 * `202`). Not a failure, so no retry is offered: a second install would
 * install the plugin again. What follows comes from the receipt's
 * `recovery`, never its reason text: `required` means nothing resumes the
 * activation and the person recovers it from its row; `none` means Station
 * finishes on its own; `unknown` (an older server) defers to the row.
 */
export function unappliedMessage(
  verb: 'installed' | 'updated',
  pluginName: string,
  unapplied: PluginLifecycleUnapplied,
) {
  if (unapplied.kind === 'projection')
    return `${pluginName} was ${verb}, but Station had not finished listing it, so plugins are being reloaded to pick it up. Its code and data are kept.`;
  if (unapplied.recovery === 'none')
    return `${pluginName} was ${verb}. Station finishes applying it in the background.`;
  if (unapplied.recovery === 'unknown')
    return `${pluginName} was ${verb}, but Station did not say whether it is active. If its row reads Needs recovery, choose Recover plugin there.`;
  const stopped = unapplied.deadlineMs
    ? `its activation did not finish within ${describeActivationDeadline(unapplied.deadlineMs)}`
    : 'its activation did not finish';
  return `${pluginName} was ${verb}, but ${stopped}, so it is not active. Choose Recover plugin to activate it; trusted permissions are asked for after that.`;
}

/** Only a change Station finishes on its own reads as a success. */
export function unappliedTone(
  unapplied: PluginLifecycleUnapplied,
): 'success' | 'warning' {
  return unapplied.kind === 'activation' && unapplied.recovery === 'none'
    ? 'success'
    : 'warning';
}

/**
 * A recovery that was stopped again. Recovery runs under the same deadline,
 * so a retry may work, and Remove is the way out.
 */
export function recoveryStoppedNotice(unapplied: PluginLifecycleUnapplied) {
  const stopped =
    unapplied.kind === 'activation' && unapplied.deadlineMs
      ? `its activation did not finish within ${describeActivationDeadline(unapplied.deadlineMs)}`
      : 'its activation did not finish';
  return `Recovery was saved, but the plugin is still not active: ${stopped}. Trying again may work; Remove plugin is the way out.`;
}

/** What a declined post-install (or post-recovery) approval left behind. */
export function consentFailureMessage(
  pluginName: string,
  pending: Array<{ tier: string }>,
) {
  if (pending.some((permission) => permission.tier === 'trusted')) {
    return `${pluginName} is active, but its server features stay off until you approve its trusted permissions. Review its request in Apps › Library.`;
  }

  return `${pluginName} was installed, but required permissions were not approved.`;
}

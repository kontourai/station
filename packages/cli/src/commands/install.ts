import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  describeActivationDeadline,
  type PluginLifecycleUnapplied,
  type PluginManifest,
  readPluginLifecycleResponse,
} from '@kontourai/station-contracts/plugin';
import type { AuthenticatedFetchInit } from '@kontourai/station-sdk/client';
import {
  authenticatedFetch,
  type InstalledPluginRecord,
  listPlugins,
  StationRequestTimeoutError,
} from '@kontourai/station-sdk/client';
import type { ParsedCoreArgs, ResolvedApiBase } from './core-api.js';
import {
  configureApiCredential,
  resolveApiBase,
  resolveApiBaseDetailed,
} from './core-api.js';
import { INVOKED_CWD, isGitUrl } from './helpers.js';
import { showOrSaveRegistry } from './install-registry.js';
import { promptYN } from './platform.js';

const NO_FLAGS: ParsedCoreArgs = {
  flags: {},
  positionals: [],
  repeatedFlags: {},
};

type PluginRecord = InstalledPluginRecord;

function resolvePluginSourceForStation(
  source: string,
  target: ResolvedApiBase,
): string {
  if (isGitUrl(source)) return source;
  if (target.source !== 'active-local' && target.source !== 'loopback') {
    throw new Error(
      `Local plugin source ${JSON.stringify(source)} cannot be sent to remote Station ${JSON.stringify(target.station ?? target.apiBase)} because the CLI and server do not have a proved shared filesystem. Use a git URL instead.`,
    );
  }
  const localSource = resolve(INVOKED_CWD, source);
  return existsSync(localSource) ? localSource : source;
}

/**
 * The error a plugin command throws when its Station request never got an
 * answer. A refused or failed connection is genuinely "not reachable", and
 * gets the lifecycle-specific wording. A deadline miss is not: Station
 * accepted the connection and was still working, and a timed-out write may
 * already have been applied (#369). That error passes through unchanged so
 * `explainRequestFailure` still sees it and reports a timeout, indeterminate
 * for a write, instead of a false "not reachable" that invites a blind retry.
 */
function stationRequestFailure(
  error: unknown,
  apiBase: string,
  requirement: string,
): Error {
  if (error instanceof StationRequestTimeoutError) return error;
  return new Error(`Station at ${apiBase} is not reachable. ${requirement}`, {
    cause: error,
  });
}

const PLUGIN_LIFECYCLE_REQUIREMENT =
  'Plugin lifecycle commands require a running Station so CLI and API mutations share one registry transaction.';

function resolvePluginTarget(parsed: ParsedCoreArgs): ResolvedApiBase {
  const target = resolveApiBaseDetailed(parsed);
  configureApiCredential(parsed, target.apiBase);
  return target;
}

/**
 * A plugin lifecycle request whose designed `202` (saved, not applied) is an
 * accepted outcome rather than a failure.
 */
async function pluginLifecycleRequest<T>(
  parsed: ParsedCoreArgs,
  path: string,
  init: AuthenticatedFetchInit,
  target?: ResolvedApiBase,
): Promise<{ payload: T; unapplied?: PluginLifecycleUnapplied }> {
  let unapplied: PluginLifecycleUnapplied | undefined;
  const payload = await pluginRequest<T>(parsed, path, init, target, (o) => {
    if (o.state === 'saved') unapplied = o.unapplied;
    return o.state !== 'refused';
  });
  return { payload, ...(unapplied ? { unapplied } : {}) };
}

/**
 * What a saved-but-unapplied install or update means, from the receipt's
 * `recovery` (never its reason text): `required` is a plugin activation that
 * nothing resumes; `none` finishes on its own; `unknown` is an older server.
 */
function unappliedLines(
  verb: 'Installed' | 'Updated',
  name: string,
  unapplied: PluginLifecycleUnapplied,
): string[] {
  if (unapplied.kind === 'projection')
    return [
      `⚠️ ${verb} ${name}, but Station has not finished listing it.`,
      '  Reload plugins on the Station host to pick it up; its code and data are kept.',
    ];
  if (unapplied.recovery === 'none')
    return [
      `✅ ${verb} ${name} through Station; it finishes applying in the background.`,
    ];
  if (unapplied.recovery === 'unknown')
    return [
      `⚠️ ${verb} ${name}, but Station did not say whether it is active.`,
      '  Open Plugins on the Station host; if it reads Needs recovery, recover it there.',
    ];
  const stopped = unapplied.deadlineMs
    ? `its activation did not finish within ${describeActivationDeadline(unapplied.deadlineMs)}`
    : 'its activation did not finish';
  return [
    `⚠️ ${verb} ${name}, but ${stopped}, so it is not active.`,
    '  Run `station plugin recover <name>`, or choose Recover plugin in Plugins on the Station host, to activate it.',
    `  Do not ${verb === 'Installed' ? 'install' : 'update'} it again; trusted permissions are approved after recovery.`,
  ];
}

/**
 * Exit status for a saved-but-unapplied change, after the CLI's precedent
 * for distinct outcomes (`home recovery-plan` exits 2): a plugin left
 * inactive is not a success a script should continue from. A change Station
 * finishes on its own (`recovery: 'none'`) keeps exit 0, and so does one from
 * a server that did not say (`unknown`): the CLI cannot claim the plugin is
 * inactive, so its text defers to the plugin's row.
 */
function markUnappliedExit(unapplied: PluginLifecycleUnapplied): void {
  if (
    unapplied.kind === 'activation' &&
    (unapplied.recovery === 'none' || unapplied.recovery === 'unknown')
  )
    return;
  process.exitCode = 2;
}

async function pluginRequest<T>(
  parsed: ParsedCoreArgs,
  path: string,
  init?: AuthenticatedFetchInit,
  target: ResolvedApiBase = resolvePluginTarget(parsed),
  accept?: (outcome: ReturnType<typeof readPluginLifecycleResponse>) => boolean,
): Promise<T> {
  const apiBase = target.apiBase;
  let response: Response;
  try {
    response = await authenticatedFetch(`${apiBase}/api/plugins${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    throw stationRequestFailure(error, apiBase, PLUGIN_LIFECYCLE_REQUIREMENT);
  }

  const payload = (await response.json()) as T & {
    success?: boolean;
    error?: string;
  };
  if (
    accept
      ? !accept(readPluginLifecycleResponse(response.status, payload))
      : !response.ok || payload.success === false
  ) {
    throw new Error(
      payload.error || `Plugin request failed with HTTP ${response.status}`,
    );
  }
  return payload;
}

/**
 * What `POST /preview` reports, which is also everything a consent decision
 * needs (station#4288). `contentDigest` and `permissions` are optional in the
 * TYPE only because a Station older than this route does not send them;
 * {@link install} refuses without them rather than inventing a decision.
 */
interface PluginPreviewResult {
  valid: boolean;
  error?: string;
  manifest?: PluginManifest;
  components: Array<{ type: string; id: string; conflict?: unknown }>;
  dependencies?: Array<{
    id: string;
    status?: string;
    consent?: {
      contentDigest: string;
      grantRevision?: string;
      registryTrustRevision?: string;
      permissions: string[];
      dependencies: string[];
      pendingConsent: Array<{ permission: string; tier: string }>;
    };
  }>;
  contentDigest?: string;
  /**
   * `excluded`: Station staged this source without its git metadata (a
   * proposal names it, or it was installed that way before). The install
   * sends it back so Station stages the same bytes; without it the install
   * is refused.
   */
  gitMetadata?: 'excluded';
  grantRevision?: string;
  registryTrustRevision?: string;
  permissions?: {
    required: string[];
    autoGranted: string[];
    pendingConsent: Array<{ permission: string; tier: string }>;
  };
}

async function previewPlugin(
  source: string,
  parsed: ParsedCoreArgs,
  target: ResolvedApiBase,
): Promise<PluginPreviewResult> {
  const result = await pluginRequest<PluginPreviewResult>(
    parsed,
    '/preview',
    {
      method: 'POST',
      body: JSON.stringify({
        source: resolvePluginSourceForStation(source, target),
      }),
      // POST to carry the source; the route inspects a manifest and installs
      // nothing, so a timeout here reports as a read, not a write.
      readOnly: true,
    },
    target,
  );
  if (!result.valid) throw new Error(result.error || 'Plugin is not valid');
  return result;
}

export async function preview(
  source: string,
  parsed: ParsedCoreArgs = NO_FLAGS,
): Promise<void> {
  const target = resolvePluginTarget(parsed);
  const result = await previewPlugin(source, parsed, target);
  console.log(JSON.stringify(result, null, 2));
}

/**
 * What the operator is shown before they answer. Deliberately the SERVER's
 * derivation, printed verbatim: the CLI computes nothing about what a plugin
 * requires, so there is no second opinion for the two to disagree on.
 */
function describeInstall(
  source: string,
  preview: PluginPreviewResult,
): string[] {
  const manifest = preview.manifest;
  const lines = [
    `Install ${manifest?.displayName || manifest?.name || source}` +
      `${manifest?.version ? `@${manifest.version}` : ''} from ${source}?`,
    `  contents  ${preview.contentDigest}`,
  ];
  const required = preview.permissions?.required ?? [];
  lines.push(
    `  requires  ${required.length > 0 ? required.join(', ') : 'no permissions'}`,
  );
  const pending = preview.permissions?.pendingConsent ?? [];
  if (pending.length > 0) {
    lines.push(
      `  approving ${pending
        .map((entry) => `${entry.permission} (${entry.tier})`)
        .join(', ')}`,
    );
  }
  // Named, not counted: these install under the same gesture, and the
  // approval binds their ids.
  const dependencies = preview.dependencies ?? [];
  if (dependencies.length > 0) {
    lines.push(
      `  installs  ${dependencies.map((entry) => entry.id).join(', ')} alongside it`,
    );
    for (const dependency of dependencies) {
      const required = dependency.consent?.permissions ?? [];
      lines.push(
        `    ${dependency.id} requires ${required.length > 0 ? required.join(', ') : 'no permissions'}`,
      );
    }
  }
  // Contribution kinds no permission expresses. Named from the manifest the
  // server returned, for the same reason the server refuses them for callers
  // that hold no decision: a Pane or an entrypoint is browser code running in
  // Station's own page, and nothing in `requires` above mentions it.
  const contributes = [
    manifest?.entrypoint ? 'an in-page bundle' : null,
    manifest?.layout || manifest?.layouts?.length ? 'a layout' : null,
    manifest?.workspacePanes?.length ? 'workspace panes' : null,
    manifest?.agents?.length ? `${manifest.agents.length} agent(s)` : null,
  ].filter((entry): entry is string => entry !== null);
  if (contributes.length > 0) {
    lines.push(`  contributes ${contributes.join(', ')}`);
  }
  return lines;
}

export async function install(
  source: string,
  skipList: string[] = [],
  parsed: ParsedCoreArgs = NO_FLAGS,
  /**
   * How to ask the operator — or `null` when there is nobody to ask, which is
   * what a non-TTY stdin means. Injectable so BOTH branches are executable in
   * a test: a gate whose refusal never runs is unproven, and tying the
   * question to `process.stdin.isTTY` inside the function would make the
   * approval branch unreachable from one.
   */
  confirm: ((question: string) => Promise<boolean>) | null = process.stdin.isTTY
    ? promptYN
    : null,
): Promise<{ pluginName: string; version: string }> {
  const target = resolvePluginTarget(parsed);
  // station#4288. The install carries the operator's decision, and a decision
  // is about what a preview showed — so the CLI previews FIRST, prints what
  // the server derived from the copy it staged, and only then asks. Sending
  // `/install` with no `consent` is refused by the route, which is correct:
  // the CLI used to install third-party code with no disclosure at all.
  const previewed = await previewPlugin(source, parsed, target);
  if (!previewed.contentDigest || !previewed.permissions) {
    throw new Error(
      `Station at ${target.apiBase} did not report what installing this plugin requires, so there is nothing to approve. Upgrade Station, or install the plugin from its Plugins page.`,
    );
  }
  // Installed but not active (Needs recovery): recover it rather than add
  // another copy of its code. `--reinstall` installs again on purpose, for a
  // source that changed since. An inventory that cannot be read does not
  // block the install; the server remains the authority on what it accepts.
  const previewedName = previewed.manifest?.name;
  if (previewedName && parsed.flags.reinstall !== true) {
    let rows: Awaited<ReturnType<typeof listPlugins>> | undefined;
    try {
      rows = await listPlugins(target.apiBase);
    } catch {
      rows = undefined;
    }
    const inactive = rows?.some(
      (row) =>
        row.name === previewedName &&
        'installationReadiness' in row &&
        row.installationReadiness?.state === 'pending',
    );
    if (inactive)
      throw new Error(
        `${previewedName} is already installed but not active. Run \`station plugin recover ${previewedName}\` to activate it, or pass --reinstall to install another copy of its code. Nothing was installed.`,
      );
  }

  const revisionPresent = (value: unknown) =>
    typeof value === 'string' && value.length > 0;
  if (
    !revisionPresent(previewed.grantRevision) ||
    (previewed.dependencies ?? []).some(
      (dependency) =>
        dependency.consent &&
        !revisionPresent(dependency.consent.grantRevision),
    )
  )
    throw new Error(
      'Station preview omitted a current permission revision. Upgrade Station and preview again; no installation was sent.',
    );

  for (const line of describeInstall(source, previewed)) console.log(line);
  // `--yes` is an approval the operator typed, with the source in the same
  // command line. Everything else has to be answered interactively — and a
  // non-interactive run without `--yes` is refused rather than assumed,
  // because assuming it is exactly the "consent nobody gave" this gate exists
  // to stop.
  if (parsed.flags.yes !== true) {
    if (!confirm) {
      throw new Error(
        'Not installed: nothing approved it, and there is no terminal to ask. Re-run with --yes to approve what is listed above, or install it from the Plugins page. Nothing was added or changed.',
      );
    }
    if (!(await confirm('Install it?'))) {
      throw new Error(
        'Not installed: the install was not approved. Nothing was added or changed.',
      );
    }
  }

  const { payload: result, unapplied } = await pluginLifecycleRequest<{
    success: boolean;
    plugin?: { name: string; version: string };
    permissions?: {
      pendingConsent?: Array<{ permission: string; tier: string }>;
      dependencies?: Array<{
        id: string;
        pendingConsent: Array<{ permission: string; tier: string }>;
      }>;
    };
  }>(
    parsed,
    '/install',
    {
      method: 'POST',
      body: JSON.stringify({
        source: resolvePluginSourceForStation(source, target),
        skip: skipList,
        consent: {
          permissions: previewed.permissions.required,
          contentDigest: previewed.contentDigest,
          registryTrustRevision: previewed.registryTrustRevision,
          grantRevision: previewed.grantRevision,
          ...(previewed.gitMetadata
            ? { gitMetadata: previewed.gitMetadata }
            : {}),
          dependencies: (previewed.dependencies ?? []).map(
            (dependency) => dependency.id,
          ),
          ...((previewed.dependencies ?? []).some(
            (dependency) => dependency.consent,
          )
            ? {
                dependencyApprovals: (previewed.dependencies ?? []).flatMap(
                  (dependency) =>
                    dependency.consent
                      ? [
                          {
                            id: dependency.id,
                            permissions: dependency.consent.permissions,
                            contentDigest: dependency.consent.contentDigest,
                            registryTrustRevision:
                              dependency.consent.registryTrustRevision,
                            grantRevision: dependency.consent.grantRevision,
                            dependencies: dependency.consent.dependencies,
                          },
                        ]
                      : [],
                ),
              }
            : {}),
        },
      }),
    },
    target,
  );
  if (unapplied) {
    // A designed `202`: saved, not applied. Host approvals cannot be
    // reviewed until the plugin is active, so none are listed here.
    const name = result.plugin?.name ?? previewed.manifest?.name ?? source;
    const version = result.plugin?.version ?? previewed.manifest?.version;
    for (const line of unappliedLines(
      'Installed',
      version ? `${name}@${version}` : name,
      unapplied,
    ))
      console.log(line);
    markUnappliedExit(unapplied);
    return { pluginName: name, version: version ?? '' };
  }
  const installed = result.plugin;
  if (!installed)
    throw new Error('Station did not return the installed plugin details.');
  const pendingHostApprovals = [
    ...(result.permissions?.pendingConsent ?? []).map((entry) => ({
      plugin: installed.name,
      ...entry,
    })),
    ...(result.permissions?.dependencies ?? []).flatMap((dependency) =>
      dependency.pendingConsent
        .filter((entry) => entry.tier === 'trusted')
        .map((entry) => ({ plugin: dependency.id, ...entry })),
    ),
  ];
  if (pendingHostApprovals.length > 0) {
    console.log(
      `⚠️ Installed ${installed.name}@${installed.version}, but activation is incomplete.`,
    );
    for (const pending of pendingHostApprovals) {
      console.log(
        `  ${pending.plugin} requires host approval for ${pending.permission}.`,
      );
    }
    console.log(
      '  Finish these reviews on the Station host in the Plugins page.',
    );
  } else if (
    result.permissions?.dependencies === undefined &&
    (previewed.dependencies ?? []).some((dependency) =>
      dependency.consent?.pendingConsent.some(
        (entry) => entry.tier === 'trusted',
      ),
    )
  ) {
    console.log(
      `Installed ${installed.name}@${installed.version}, but Station did not report current dependency approval status. Check the Plugins page on the Station host.`,
    );
  } else {
    console.log(
      `✅ Installed ${installed.name}@${installed.version} through Station`,
    );
  }
  return {
    pluginName: installed.name,
    version: installed.version,
  };
}

/** What `GET /api/plugins/:name/recovery-preview` reports: the review. */
interface PluginRecoveryReview {
  manifest?: { name?: string; displayName?: string; version?: string };
  recoveryRevision: string;
  contentDigest: string;
  grantRevision: string;
  registryTrustRevision?: string;
  registryTrust?: { state?: string };
  permissions: {
    required: string[];
    pendingConsent: Array<{ permission: string; tier: string }>;
  };
  dependencies: Array<{
    id: string;
    consent: {
      contentDigest: string;
      permissions: string[];
      dependencies: string[];
      grantRevision: string;
      registryTrustRevision?: string;
    };
  }>;
}

/**
 * Recover an installed plugin whose activation did not finish (Needs
 * recovery), as the Plugins view does: read the recovery review, print what
 * it found, take the operator's explicit decision (interactively, or
 * `--yes` typed with the name), then send exactly the reviewed revisions.
 * Nothing is approved that the review did not show, and a non-interactive
 * run without `--yes` is refused, as for `install`.
 */
export async function recover(
  name: string,
  parsed: ParsedCoreArgs = NO_FLAGS,
  confirm: ((question: string) => Promise<boolean>) | null = process.stdin.isTTY
    ? promptYN
    : null,
): Promise<void> {
  if (!name) throw new Error('Usage: station plugin recover <name> [--yes]');
  const target = resolvePluginTarget(parsed);
  const path = `/${encodeURIComponent(name)}`;
  const review = await pluginRequest<PluginRecoveryReview>(
    parsed,
    `${path}/recovery-preview`,
    { readOnly: true },
    target,
  );
  const label = review.manifest?.displayName || review.manifest?.name || name;
  const required = review.permissions.required;
  const lines = [
    `Recover ${label}${review.manifest?.version ? `@${review.manifest.version}` : ''} from its retained code and data?`,
    `  contents  ${review.contentDigest}`,
    `  registry  ${review.registryTrust?.state ?? 'no verified registry claim'}`,
    `  requires  ${required.length > 0 ? required.join(', ') : 'no permissions'}`,
  ];
  if (review.permissions.pendingConsent.length > 0)
    lines.push(
      `  approving ${review.permissions.pendingConsent
        .map((entry) => `${entry.permission} (${entry.tier})`)
        .join(', ')}`,
    );
  for (const dependency of review.dependencies)
    lines.push(
      `  dependency ${dependency.id} requires ${dependency.consent.permissions.join(', ') || 'no permissions'}`,
    );
  if (
    review.permissions.pendingConsent.some((entry) => entry.tier === 'trusted')
  )
    lines.push(
      '  Trusted permissions still need the separate host approval in Plugins afterwards.',
    );
  for (const line of lines) console.log(line);
  if (parsed.flags.yes !== true) {
    if (!confirm)
      throw new Error(
        'Not recovered: nothing approved it, and there is no terminal to ask. Re-run with --yes to approve what is listed above. Nothing was changed.',
      );
    if (!(await confirm('Recover it?')))
      throw new Error(
        'Not recovered: the recovery was not approved. Nothing was changed.',
      );
  }
  const { payload: result, unapplied } = await pluginLifecycleRequest<{
    success: boolean;
    permissions?: {
      pendingConsent?: Array<{ permission: string; tier: string }>;
    };
  }>(
    parsed,
    `${path}/recover`,
    {
      method: 'POST',
      body: JSON.stringify({
        recoveryRevision: review.recoveryRevision,
        consent: {
          contentDigest: review.contentDigest,
          grantRevision: review.grantRevision,
          ...(review.registryTrustRevision
            ? { registryTrustRevision: review.registryTrustRevision }
            : {}),
          permissions: required,
          dependencies: review.dependencies.map((dependency) => dependency.id),
          dependencyApprovals: review.dependencies.map(({ id, consent }) => ({
            id,
            ...consent,
          })),
        },
      }),
    },
    target,
  );
  if (unapplied) {
    if (unapplied.kind === 'activation' && unapplied.recovery !== 'none') {
      const stopped = unapplied.deadlineMs
        ? `its activation did not finish within ${describeActivationDeadline(unapplied.deadlineMs)}`
        : 'its activation did not finish';
      console.log(
        `⚠️ Recovery of ${label} was saved, but it is still not active: ${stopped}.`,
      );
      console.log(
        '  Trying again may work; `station plugin remove` is the way out.',
      );
    } else
      for (const line of unappliedLines('Installed', label, unapplied))
        console.log(line);
    markUnappliedExit(unapplied);
    return;
  }
  const owed = result.permissions?.pendingConsent ?? [];
  if (owed.length > 0) {
    console.log(
      `⚠️ Recovered ${label}; it is active but still needs host approval.`,
    );
    for (const entry of owed)
      console.log(`  ${label} requires host approval for ${entry.permission}.`);
    console.log(
      '  Finish these reviews on the Station host in the Plugins page.',
    );
    return;
  }
  console.log(`✅ Recovered ${label}; it is active.`);
}

async function installedPlugins(
  parsed: ParsedCoreArgs,
): Promise<PluginRecord[]> {
  const target = resolvePluginTarget(parsed);
  try {
    return await listPlugins(target.apiBase);
  } catch (error) {
    if (
      !(
        error instanceof TypeError ||
        error instanceof StationRequestTimeoutError
      )
    ) {
      throw error;
    }
    throw stationRequestFailure(
      error,
      target.apiBase,
      PLUGIN_LIFECYCLE_REQUIREMENT,
    );
  }
}

export async function list(parsed: ParsedCoreArgs = NO_FLAGS): Promise<void> {
  const plugins = await installedPlugins(parsed);
  if (plugins.length === 0) {
    console.log('No plugins installed');
    return;
  }
  console.log(JSON.stringify(plugins, null, 2));
}

/**
 * A lifecycle change that withdrew plugin command effects commits at once but
 * is not finished until every captured effect settles (kontourai/station#1419).
 * Station answers 202 with the withdrawal; say so rather than "done".
 */
interface CommandEffectsWithdrawal {
  withdrawalId: string;
  status: string;
  outstanding: number;
}

function commandEffectsNote(
  withdrawal: CommandEffectsWithdrawal | undefined,
  unavailable?: boolean,
): string {
  if (unavailable)
    return ' Its plugin command effects could not be recorded, so completion cannot be confirmed.';
  if (!withdrawal || withdrawal.status === 'completed') return '';
  const effects =
    withdrawal.outstanding === 1
      ? '1 plugin command effect is'
      : `${withdrawal.outstanding} plugin command effects are`;
  return withdrawal.status === 'winding-down'
    ? ` ${effects} still winding down (withdrawal ${withdrawal.withdrawalId}).`
    : ` ${effects} unresolved (${withdrawal.status}, withdrawal ${withdrawal.withdrawalId}).`;
}

export async function remove(
  name: string,
  parsed: ParsedCoreArgs = NO_FLAGS,
): Promise<void> {
  const { payload: result, unapplied } = await pluginLifecycleRequest<{
    success: boolean;
    commandEffects?: CommandEffectsWithdrawal;
    commandEffectsUnavailable?: boolean;
  }>(parsed, `/${encodeURIComponent(name)}`, { method: 'DELETE' });
  const note = commandEffectsNote(
    result.commandEffects,
    result.commandEffectsUnavailable,
  );
  // A removal activates nothing: a saved removal whose runtime reload did not
  // finish is completed by Station's next reconciliation.
  const removed = unapplied
    ? `✅ Removed ${name} through Station; it finishes unloading in the background`
    : `✅ Removed ${name} through Station`;
  console.log(note ? `${removed}.${note}` : removed);
}

export async function info(
  name: string,
  parsed: ParsedCoreArgs = NO_FLAGS,
): Promise<void> {
  const plugins = await installedPlugins(parsed);
  // A rejected row is identified only by its directory entry. Prefer a
  // validated manifest identity when both happen to use the same string.
  const plugin =
    plugins.find(
      (candidate) =>
        candidate.name === name &&
        !('status' in candidate && candidate.status === 'rejected'),
    ) ?? plugins.find((candidate) => candidate.name === name);
  if (!plugin) throw new Error(`Plugin ${name} not found`);
  console.log(JSON.stringify(plugin, null, 2));
}

export async function update(
  name: string,
  parsed: ParsedCoreArgs = NO_FLAGS,
): Promise<void> {
  const { payload: result, unapplied } = await pluginLifecycleRequest<{
    success: boolean;
    plugin?: { name?: string; version?: string };
    commandEffects?: CommandEffectsWithdrawal;
    commandEffectsUnavailable?: boolean;
  }>(parsed, `/${encodeURIComponent(name)}/update`, { method: 'POST' });
  const updatedName = result.plugin?.name ?? name;
  const version = result.plugin?.version ? `@${result.plugin.version}` : '';
  if (unapplied) {
    for (const line of unappliedLines(
      'Updated',
      `${updatedName}${version}`,
      unapplied,
    ))
      console.log(line);
    markUnappliedExit(unapplied);
    return;
  }
  const note = commandEffectsNote(
    result.commandEffects,
    result.commandEffectsUnavailable,
  );
  console.log(
    note
      ? `✅ Updated ${updatedName}${version} through Station.${note}`
      : `✅ Updated ${updatedName}${version} through Station`,
  );
}

export async function registry(registryUrl?: string): Promise<void> {
  await showOrSaveRegistry(registryUrl);
}

export async function installRegistryPlugin(
  id: string,
  parsed: ParsedCoreArgs = NO_FLAGS,
): Promise<void> {
  const apiBase = resolveApiBase(parsed);
  configureApiCredential(parsed, apiBase);
  let response: Response;
  try {
    response = await authenticatedFetch(
      `${apiBase}/api/registry/plugins/install`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      },
    );
  } catch (error) {
    throw stationRequestFailure(
      error,
      apiBase,
      'Registry plugin installation requires the canonical Station lifecycle.',
    );
  }
  const result = (await response.json()) as {
    success?: boolean;
    error?: string;
    message?: string;
  };
  const outcome = readPluginLifecycleResponse(response.status, result);
  if (outcome.state === 'refused') {
    throw new Error(
      result.error ||
        result.message ||
        `Registry install failed with HTTP ${response.status}`,
    );
  }
  if (outcome.state === 'saved') {
    for (const line of unappliedLines(
      'Installed',
      `registry plugin ${id}`,
      outcome.unapplied,
    ))
      console.log(line);
    markUnappliedExit(outcome.unapplied);
    return;
  }
  console.log(`✅ Installed registry plugin ${id} through Station`);
}

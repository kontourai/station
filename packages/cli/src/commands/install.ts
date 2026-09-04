import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import type { AuthenticatedFetchInit } from '@kontourai/station-sdk/client';
import {
  authenticatedFetch,
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

type PluginRecord = PluginManifest & { hasBundle?: boolean };

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

function resolvePluginTarget(parsed: ParsedCoreArgs): ResolvedApiBase {
  const target = resolveApiBaseDetailed(parsed);
  configureApiCredential(parsed, target.apiBase);
  return target;
}

async function pluginRequest<T>(
  parsed: ParsedCoreArgs,
  path: string,
  init?: AuthenticatedFetchInit,
  target: ResolvedApiBase = resolvePluginTarget(parsed),
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
    throw new Error(
      `Station at ${apiBase} is not reachable. Plugin lifecycle commands require a running Station so CLI and API mutations share one registry transaction.`,
      { cause: error },
    );
  }

  const payload = (await response.json()) as T & {
    success?: boolean;
    error?: string;
  };
  if (!response.ok || payload.success === false) {
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
      permissions: string[];
      dependencies: string[];
      pendingConsent: Array<{ permission: string; tier: string }>;
    };
  }>;
  contentDigest?: string;
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
      // nothing. (Today `pluginRequest` rewraps every transport failure, so no
      // reporter sees this error's classification — see station#3402's
      // follow-up. The declaration belongs with the operation regardless.)
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

  const result = await pluginRequest<{
    success: boolean;
    plugin: { name: string; version: string };
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
  const pendingHostApprovals = [
    ...(result.permissions?.pendingConsent ?? []).map((entry) => ({
      plugin: result.plugin.name,
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
      `⚠️ Installed ${result.plugin.name}@${result.plugin.version}, but activation is incomplete.`,
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
      `Installed ${result.plugin.name}@${result.plugin.version}, but Station did not report current dependency approval status. Check the Plugins page on the Station host.`,
    );
  } else {
    console.log(
      `✅ Installed ${result.plugin.name}@${result.plugin.version} through Station`,
    );
  }
  return {
    pluginName: result.plugin.name,
    version: result.plugin.version,
  };
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
    throw new Error(
      `Station at ${target.apiBase} is not reachable. Plugin lifecycle commands require a running Station so CLI and API mutations share one registry transaction.`,
      { cause: error },
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

export async function remove(
  name: string,
  parsed: ParsedCoreArgs = NO_FLAGS,
): Promise<void> {
  await pluginRequest<{ success: boolean }>(
    parsed,
    `/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  );
  console.log(`✅ Removed ${name} through Station`);
}

export async function info(
  name: string,
  parsed: ParsedCoreArgs = NO_FLAGS,
): Promise<void> {
  const plugin = (await installedPlugins(parsed)).find(
    (candidate) => candidate.name === name,
  );
  if (!plugin) throw new Error(`Plugin ${name} not found`);
  console.log(JSON.stringify(plugin, null, 2));
}

export async function update(
  name: string,
  parsed: ParsedCoreArgs = NO_FLAGS,
): Promise<void> {
  const result = await pluginRequest<{
    success: boolean;
    plugin?: { name?: string; version?: string };
  }>(parsed, `/${encodeURIComponent(name)}/update`, { method: 'POST' });
  const updatedName = result.plugin?.name ?? name;
  const version = result.plugin?.version ? `@${result.plugin.version}` : '';
  console.log(`✅ Updated ${updatedName}${version} through Station`);
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
    throw new Error(
      `Station at ${apiBase} is not reachable. Registry plugin installation requires the canonical Station lifecycle.`,
      { cause: error },
    );
  }
  const result = (await response.json()) as {
    success?: boolean;
    error?: string;
    message?: string;
  };
  if (!response.ok || result.success === false) {
    throw new Error(
      result.error ||
        result.message ||
        `Registry install failed with HTTP ${response.status}`,
    );
  }
  console.log(`✅ Installed registry plugin ${id} through Station`);
}

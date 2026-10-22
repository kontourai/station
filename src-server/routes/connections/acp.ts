import { isDeepStrictEqual } from 'node:util';
import {
  type ACPConnectionConfig,
  type ACPConnectionRegistryEntry,
  type ACPEngineInstallRecipe,
  type ACPPublicRegistrySourceStatus,
  ACPStatus,
  engineSupportsPlatform,
  installRecipeForPlatform,
  normalizeACPArgs,
} from '@kontourai/station-contracts/acp';
import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import { sanitizeFreeText } from '@kontourai/station-shared/redaction';
import { Hono } from 'hono';
import {
  loadOrCreateAgentRegistry,
  materializeEngineAgent,
  registerEngineConnection,
  unregisterEngineConnection,
} from '../../domain/agent-registry.js';
import type { ConfigLoader } from '../../domain/config-loader.js';
import { nativeRuntimeConnectionIds } from '../../providers/adapter-identity.js';
import type { ProviderAdapterShape } from '../../providers/adapter-shape.js';
import {
  recaptureLoginShellPath,
  resolveAugmentedPath,
} from '../../providers/auth/cli-auth.js';
import { listProviders } from '../../providers/registries/registry.js';
import type { RuntimeContext } from '../../runtime/types.js';
import { listValidatedACPRegistryEntries } from '../../services/acp/acp-engine-descriptors.js';
import { ACPProviderRouteValidationError } from '../../services/acp/acp-process.js';
import type { PublicAgentRegistrySource } from '../../services/acp/public-agent-registry.js';
import {
  mapPublicRegistryListings,
  type PublicRegistryCatalog,
} from '../../services/acp/public-agent-registry-catalog.js';
import {
  type IntegrationSecretResolution,
  SecretBindingResolutionError,
} from '../../services/secrets/secret-binding-administration.js';
import { acpOps } from '../../telemetry/metrics.js';
import { sanitizedTransportError } from '../../utils/outward-error.js';
import {
  acpConnectionSchema,
  acpDisableProviderSchema,
  acpSetProviderSchema,
  getBody,
  param,
  validate,
} from '../schemas/schemas.js';
import {
  captureConfigurationMutation,
  configurationMutationResponse,
} from '../system/configuration-activation.js';
import {
  changesAny,
  refuseUngrantedCommandChoice,
} from '../working-directory-authority.js';

function getProviderConnections(): ACPConnectionConfig[] {
  return listProviders('acpConnections').flatMap((entry: any) =>
    (entry.provider.getConnections?.() || []).map((conn: any) => ({
      ...conn,
      source: 'plugin' as const,
    })),
  );
}

/**
 * #3355: an ACP connection may not take an id a native runtime Adapter
 * answers to (its engine id or public connection id). Both would resolve to
 * one public engine connection, and engine attribution — keyed by that id —
 * would then label the native engine's Agents `acp`. Every registered
 * `providerAdapter` entry counts, builtin or plugin, so an override cannot
 * reopen the id. Returns the refusal message, or `null` when the id is free.
 */
function nativeEngineIdCollision(id: string): string | null {
  const adapters = listProviders('providerAdapter').map(
    (entry) => entry.provider as ProviderAdapterShape,
  );
  const owner = nativeRuntimeConnectionIds(adapters).get(id);
  if (owner === undefined) return null;
  return `Connection id '${id}' is already used by the '${owner}' engine. Choose a different id for the ACP connection.`;
}

function mergeACPConnections(
  configConnections: ACPConnectionConfig[],
  providerConnections: ACPConnectionConfig[],
): ACPConnectionConfig[] {
  const configIds = new Set(
    configConnections.map((connection) => connection.id),
  );
  return [
    ...configConnections,
    ...providerConnections.filter(
      (connection) => !configIds.has(connection.id),
    ),
  ];
}

export interface UnconnectedACPRegistryEntry {
  id: string;
  name: string;
  /** The entry's command was found on the host. */
  detected: boolean;
  /** The install recipe for the host's platform, when the descriptor has one. */
  install?: ACPEngineInstallRecipe;
}

/**
 * Registry entries with no ACP connection yet (neither user-authored nor
 * plugin-provided), whether or not their command was found on the host. Keyed on
 * the ACP connection id, because a connected ACP Engine reports the generic
 * `engineId: 'acp'` in `listEngineConnectionStates` and can never be matched
 * against a registry id that way (station#1548). Read-only: nothing here
 * launches the command.
 */
export async function listUnconnectedACPRegistryEntries(configLoader: {
  loadACPConfig: () => Promise<{ connections: ACPConnectionConfig[] }>;
}): Promise<UnconnectedACPRegistryEntry[]> {
  return (await detectedRegistryEntries(configLoader))
    .filter((entry) => !entry.installed)
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      detected: entry.detected === true,
      ...(entry.hostInstall ? { install: entry.hostInstall } : {}),
    }));
}

/**
 * The connections that count as installed for every registry projection
 * (onboarding, Add engine, GET /connections): user config plus plugin-provided
 * connections, minus any whose engine identity is not registered. The install
 * route saves config BEFORE the identity CAS, so a failed commit leaves a
 * config entry that is retryable but not an installed Engine; counting it as
 * installed hid it from every repair surface at once (station#1548 review).
 * Transport-only contexts (no filesystem loader, test fixtures) carry no
 * identity evidence and keep the legacy reading: every config entry counts.
 */
async function installedACPConnections(configLoader: {
  loadACPConfig: () => Promise<{ connections: ACPConnectionConfig[] }>;
}): Promise<ACPConnectionConfig[]> {
  const config = await configLoader.loadACPConfig();
  const registeredIds = await registeredRuntimeConnectionIds(configLoader);
  return mergeACPConnections(
    config.connections,
    getProviderConnections(),
  ).filter((connection) =>
    isRegisteredRuntimeConnection(connection.id, registeredIds),
  );
}

/**
 * Registry entries with `detected` read after the login-shell PATH capture
 * has landed. Built-in entries detect with the synchronous `findCliBinary`,
 * which on the first call after start sees only the process PATH and
 * well-known dirs, so an engine reachable only through the user's shell PATH
 * read as not found. The capture is resolved once per process.
 */
async function detectedRegistryEntries(configLoader: {
  loadACPConfig: () => Promise<{ connections: ACPConnectionConfig[] }>;
}): Promise<ACPConnectionRegistryEntry[]> {
  await resolveAugmentedPath();
  return getRegistryEntries(await installedACPConnections(configLoader));
}

function getRegistryEntries(
  installedConnections: ACPConnectionConfig[],
  publicRegistry?: PublicAgentRegistrySource,
): ACPConnectionRegistryEntry[] {
  return getRegistryCatalog(installedConnections, publicRegistry).entries;
}

/**
 * The Add engine catalogue: built-in and plugin entries, then the public
 * agent registry's listings when this Station reads it. Built-ins win every
 * id; a listing only adds display facts to a built-in card.
 */
function getRegistryCatalog(
  installedConnections: ACPConnectionConfig[],
  publicRegistry?: PublicAgentRegistrySource,
): {
  entries: ACPConnectionRegistryEntry[];
  publicRefused: PublicRegistryCatalog['refused'];
} {
  const installedSources = new Map<string, 'user' | 'plugin'>();
  for (const connection of installedConnections) {
    if (!installedSources.has(connection.id)) {
      installedSources.set(
        connection.id,
        connection.source === 'plugin' ? 'plugin' : 'user',
      );
    }
  }

  const entriesById = new Map<string, ACPConnectionRegistryEntry>();
  for (const {
    entry: registryEntry,
    builtin,
    source: providerSource,
  } of listValidatedACPRegistryEntries()) {
    const hostInstall = installRecipeForPlatform(
      registryEntry.install,
      process.platform,
    );
    entriesById.set(registryEntry.id, {
      ...registryEntry,
      // An entry that does not launch on this host is never connectable here.
      ...(engineSupportsPlatform(registryEntry, process.platform)
        ? {}
        : { detected: false }),
      source: builtin ? 'core' : 'plugin',
      // A plugin is named by the identity it registered under, never by a
      // label its own entries choose.
      sourceName: builtin
        ? (registryEntry.sourceName ?? providerSource)
        : providerSource,
      // Only the public registry projection below may set this.
      publicRegistry: undefined,
      installed: installedSources.has(registryEntry.id),
      installedSource: installedSources.get(registryEntry.id),
      // Always the server's own projection; a provider cannot supply it.
      hostInstall: hostInstall ? { ...hostInstall } : undefined,
    });
  }

  let publicRefused: PublicRegistryCatalog['refused'] = [];
  if (publicRegistry) {
    const present = Array.from(entriesById.values());
    const catalog = mapPublicRegistryListings({
      agents: publicRegistry.agents(),
      builtins: present.filter((entry) => entry.source === 'core'),
      takenIds: new Set(
        present
          .filter((entry) => entry.source !== 'core')
          .map((entry) => entry.id),
      ),
      platform: process.platform,
      arch: process.arch,
      commandExists: publicRegistry.commandExists,
    });
    publicRefused = catalog.refused;
    for (const [builtinId, listing] of catalog.enrichments) {
      const builtin = entriesById.get(builtinId);
      if (builtin) builtin.publicRegistry = listing;
    }
    const savedById = new Map(
      installedConnections.map((connection) => [connection.id, connection]),
    );
    for (const entry of catalog.entries) {
      const update = publicRegistryUpdate(savedById.get(entry.id), entry);
      entriesById.set(entry.id, {
        ...entry,
        ...(update && entry.publicRegistry
          ? { publicRegistry: { ...entry.publicRegistry, update } }
          : {}),
        installed: installedSources.has(entry.id),
        installedSource: installedSources.get(entry.id),
      });
    }
  }
  return {
    entries: Array.from(entriesById.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    publicRefused,
  };
}

/**
 * What changed in the listing since a connection was added from it. Only a
 * connection that records its listing is compared; the saved connection is
 * reported on, never changed.
 */
function publicRegistryUpdate(
  saved: ACPConnectionConfig | undefined,
  entry: ACPConnectionRegistryEntry,
): { version: string; command?: string; args?: string[] } | undefined {
  const listing = entry.publicRegistry;
  if (!saved?.publicRegistry || !listing) return undefined;
  const launch = listing.hostLaunch;
  const commandChanged =
    launch !== undefined &&
    (saved.command !== launch.command ||
      !isDeepStrictEqual(saved.args ?? [], launch.args));
  if (!commandChanged && saved.publicRegistry.version === listing.version) {
    return undefined;
  }
  return {
    version: listing.version,
    ...(commandChanged && launch
      ? { command: launch.command, args: [...launch.args] }
      : {}),
  };
}

const DISABLED_PUBLIC_REGISTRY_STATUS: ACPPublicRegistrySourceStatus = {
  enabled: false,
  origin: 'none',
  fetchedAt: null,
  checkedAt: null,
  lastError: null,
  refreshing: false,
  refused: [],
};

/** The command the person confirmed, when the request carries one. */
async function confirmedCommand(
  request: Request,
): Promise<{ command: string; args: string[] } | undefined> {
  const body = (await request.json().catch(() => undefined)) as
    | { confirmCommand?: { command?: unknown; args?: unknown } }
    | undefined;
  const confirm = body?.confirmCommand;
  if (
    typeof confirm?.command !== 'string' ||
    !Array.isArray(confirm.args) ||
    !confirm.args.every((arg) => typeof arg === 'string')
  ) {
    return undefined;
  }
  return { command: confirm.command, args: confirm.args as string[] };
}

function findRegistryEntry(
  id: string,
  installedConnections: ACPConnectionConfig[],
  publicRegistry?: PublicAgentRegistrySource,
): ACPConnectionRegistryEntry | null {
  return (
    getRegistryEntries(installedConnections, publicRegistry).find(
      (entry) => entry.id === id,
    ) ?? null
  );
}

const ACP_PROVIDER_ROUTE_PUBLIC_ERRORS = Object.freeze({
  observation_required:
    'Provider routing must be observed before it can be changed.',
  provider_not_found:
    'The requested ACP provider was not advertised by this agent.',
  protocol_unsupported:
    'The requested protocol was not advertised for this ACP provider.',
});

function acpProviderRoutePublicError(
  error: ACPProviderRouteValidationError,
): string {
  return ACP_PROVIDER_ROUTE_PUBLIC_ERRORS[error.code];
}

function normalizeACPConnection(
  value: Record<string, any>,
): ACPConnectionConfig {
  return {
    id: value.id,
    name: value.name,
    command: value.command,
    args: normalizeACPArgs(value.args ?? []),
    icon: value.icon ?? '🔌',
    enabled: value.enabled !== false,
    ...(value.cwd ? { cwd: value.cwd } : {}),
    ...(value.interactive !== undefined
      ? { interactive: value.interactive }
      : {}),
    ...(value.provideToolServers
      ? { provideToolServers: value.provideToolServers }
      : {}),
    ...(value.publicRegistry ? { publicRegistry: value.publicRegistry } : {}),
  };
}

/**
 * Only after the connection's own probe succeeded. The probe (not this
 * function) is what decides whether a CLI ACP provider can be onboarded:
 * materializing the registry identity and the Agent file for a connection
 * that could not handshake is what put a permanently-broken engine's row in
 * the New Chat picker — an "Agent" for a provider that never worked, which
 * the built-in harnesses never produce (their defaults materialize from boot
 * adoption and Enable, both behind a ready engine). Callers gate on
 * `connectNewACPConnection`'s answer.
 */
async function registerPersistedACPConnection(
  ctx: RuntimeContext,
  id: string,
  name: string = id,
): Promise<Awaited<ReturnType<typeof materializeEngineAgent>> | undefined> {
  // Transport-only route fixtures do not expose a filesystem loader. Real
  // runtime contexts do, and therefore always take the durable identity path.
  if (typeof (ctx.configLoader as any).getProjectHomeDir !== 'function') return;
  await registerEngineConnection(
    ctx.configLoader as ConfigLoader,
    engineConnectionId(id),
    { kind: 'user-acp' },
  );
  return materializeEngineAgent(ctx.configLoader as ConfigLoader, id, name);
}

/**
 * Hand the connection to the bridge and report whether onboarding actually
 * worked: the probe's boolean, with a REJECTING probe (spawn/workspace
 * failure — the command never ran) read as the same "not onboarded" answer.
 * The catch is not error-to-success conversion: the durable connection and
 * its status are what carry the failure (the bridge records the probe's
 * phase+message on the connection, and every repair surface reads that), and
 * the caller's only decision here is whether the Agent may be created.
 */
async function connectNewACPConnection(
  ctx: RuntimeContext,
  connection: ACPConnectionConfig,
): Promise<boolean> {
  if (!connection.enabled) return false;
  try {
    return (await ctx.acpBridge.addConnection(connection)) === true;
  } catch {
    return false;
  }
}

/**
 * The receipt names the Agent the install materialized or adopted. The
 * install is already committed by the time this reads the file; an adopted
 * Agent can be selected while its file is mid-write (materializeEngineAgent
 * tolerates that), so an unreadable file must not turn a committed install
 * into a 500 — the slug alone is still an honest receipt.
 */
async function installedAgentReceipt(
  configLoader: ConfigLoader,
  slug: string,
): Promise<Record<string, unknown>> {
  try {
    return { slug, ...(await configLoader.loadAgent(slug)) };
  } catch {
    return { slug };
  }
}

async function unregisterPersistedACPConnection(
  ctx: RuntimeContext,
  id: string,
): Promise<void> {
  if (typeof (ctx.configLoader as any).getProjectHomeDir !== 'function') return;
  await unregisterEngineConnection(
    ctx.configLoader as ConfigLoader,
    engineConnectionId(id),
  );
}

function isRegisteredRuntimeConnection(
  id: string,
  registeredIds: Set<string> | null,
): boolean {
  return registeredIds === null || registeredIds.has(id);
}

async function registeredRuntimeConnectionIds(configLoader: {
  loadACPConfig?: unknown;
  getProjectHomeDir?: unknown;
}): Promise<Set<string> | null> {
  if (typeof (configLoader as any).getProjectHomeDir !== 'function') {
    return null;
  }
  const registry = await loadOrCreateAgentRegistry(
    configLoader as ConfigLoader,
  );
  return new Set(registry.engineConnections.map(({ id }) => String(id)));
}

/**
 * One connection as GET /connections serves it: its config merged with the
 * bridge's live status. The create and install routes answer with this same
 * projection, because a connection whose first probe failed is not listed
 * (its identity never registered) and the response is then the only place
 * the caller can read the probe's status and reason.
 */
function connectionStatusView(
  cfg: ACPConnectionConfig,
  status: ReturnType<RuntimeContext['acpBridge']['getStatus']>,
) {
  return {
    ...cfg,
    ...(status.connections.find((s) => s.id === cfg.id) || {
      status: ACPStatus.UNAVAILABLE,
      modes: [],
      sessionId: null,
      mcpServers: [],
    }),
  };
}

/**
 * Registers a saved connection that a background probe (the cold first-contact
 * continuation, or the periodic sweep) just handshaked for the first time.
 * The result counts only for the config that probe ran: the saved entry must
 * still match it exactly, or the result is dropped. Already-registered
 * connections never enter the configuration queue; the cold probe itself ran
 * outside it.
 */
async function registerFirstHandshakeACPConnection(
  ctx: RuntimeContext,
  probed: ACPConnectionConfig,
): Promise<'registered' | 'already-registered' | 'config-changed' | 'skipped'> {
  if (typeof ctx.configLoader.getProjectHomeDir !== 'function') {
    return 'skipped';
  }
  if (
    (await registeredRuntimeConnectionIds(ctx.configLoader))?.has(probed.id)
  ) {
    return 'already-registered';
  }
  const { value } = await captureConfigurationMutation(
    ctx.applyAgentConfigurationMutation,
    async (beginMutation) => {
      const saved = (await ctx.configLoader.loadACPConfig()).connections.find(
        (connection) => connection.id === probed.id,
      );
      if (!saved || !isDeepStrictEqual(saved, probed)) {
        return 'config-changed' as const;
      }
      if (
        (await registeredRuntimeConnectionIds(ctx.configLoader))?.has(probed.id)
      ) {
        return 'already-registered' as const;
      }
      beginMutation();
      await registerPersistedACPConnection(ctx, probed.id, probed.name);
      return 'registered' as const;
    },
  );
  return value;
}

export function createACPRoutes(
  ctx: RuntimeContext,
  options: {
    /** Absent when this Station does not read the public agent registry. */
    publicAgentRegistry?: PublicAgentRegistrySource;
  } = {},
) {
  const app = new Hono();
  const publicRegistry = options.publicAgentRegistry;

  // Background first handshakes register here; nothing awaits them.
  ctx.acpBridge.onFirstHandshake?.((config) => {
    void registerFirstHandshakeACPConnection(ctx, config).catch((error) => {
      ctx.logger?.warn?.('ACP first-handshake registration failed', {
        id: config.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  app.get('/status', (c) => {
    return c.json({ success: true, data: ctx.acpBridge.getStatus() });
  });

  app.get('/connections', async (c) => {
    const allConnections = await installedACPConnections(ctx.configLoader);
    const status = ctx.acpBridge.getStatus();
    const connections = allConnections.map((cfg) =>
      connectionStatusView(cfg, status),
    );
    return c.json({ success: true, data: connections });
  });

  // Saved user connections whose engine never registered (a failed first
  // add). Kept off GET /connections and every installed projection
  // (station#1548); this read is their repair handle.
  app.get('/connections/unregistered', async (c) => {
    const registeredIds = await registeredRuntimeConnectionIds(
      ctx.configLoader,
    );
    if (registeredIds === null) return c.json({ success: true, data: [] });
    const config = await ctx.configLoader.loadACPConfig();
    const status = ctx.acpBridge.getStatus();
    const data = config.connections
      .filter((connection) => !registeredIds.has(connection.id))
      .map((connection) => connectionStatusView(connection, status));
    return c.json({ success: true, data });
  });

  // Retry check for a saved connection, registered or not, whether or not
  // the bridge holds a probe for it (after a restart it does not hold
  // unregistered ones): the same probe-then-register as a repeated add, from
  // the saved config, so it chooses no command.
  app.post('/connections/:id/check', async (c) => {
    return configurationMutationResponse(
      await captureConfigurationMutation(
        ctx.applyAgentConfigurationMutation,
        async (beginMutation) => {
          const id = param(c, 'id');
          const saved = (
            await ctx.configLoader.loadACPConfig()
          ).connections.find((connection) => connection.id === id);
          if (!saved) {
            return c.json(
              { success: false, error: 'Connection not found' },
              404,
            );
          }
          beginMutation();
          const connected = await connectNewACPConnection(ctx, saved);
          if (connected) {
            await registerPersistedACPConnection(ctx, saved.id, saved.name);
          } else {
            ctx.acpBridge.continueFirstContact?.(saved.id);
          }
          return c.json({
            success: true,
            data: connectionStatusView(saved, ctx.acpBridge.getStatus()),
          });
        },
      ),
    );
  });

  app.get('/registry', async (c) => {
    await publicRegistry?.ready();
    publicRegistry?.refreshIfStale();
    await resolveAugmentedPath();
    const entries = getRegistryEntries(
      await installedACPConnections(ctx.configLoader),
      publicRegistry,
    );
    return c.json({ success: true, data: entries });
  });

  app.get('/registry/source', async (c) => {
    if (!publicRegistry) {
      return c.json({ success: true, data: DISABLED_PUBLIC_REGISTRY_STATUS });
    }
    await publicRegistry.ready();
    // The same bounded background check the catalogue read starts, so the
    // status a client reads first already says a download is running.
    publicRegistry.refreshIfStale();
    return c.json({
      success: true,
      data: await publicRegistryStatus(publicRegistry),
    });
  });

  // Downloads the public listing now. Operate tier, like the PATH re-check:
  // it makes this Station reach out to the network on request.
  app.post('/registry/source/refresh', async (c) => {
    if (!publicRegistry) {
      return c.json({ success: true, data: DISABLED_PUBLIC_REGISTRY_STATUS });
    }
    await publicRegistry.refresh();
    return c.json({
      success: true,
      data: await publicRegistryStatus(publicRegistry),
    });
  });

  async function publicRegistryStatus(
    source: PublicAgentRegistrySource,
  ): Promise<ACPPublicRegistrySourceStatus> {
    const status = source.status();
    const { publicRefused } = getRegistryCatalog(
      await installedACPConnections(ctx.configLoader),
      source,
    );
    return { ...status, refused: [...status.refused, ...publicRefused] };
  }

  // "Check again" after an install: re-read the login-shell PATH so a bin
  // directory the installer added to the shell rc since Station started is
  // searched, then list again. A POST at the operate tier because it runs the
  // host user's shell (rate-limited and bounded); the GET above never does.
  app.post('/registry/recheck', async (c) => {
    await recaptureLoginShellPath();
    const entries = getRegistryEntries(
      await installedACPConnections(ctx.configLoader),
      publicRegistry,
    );
    return c.json({ success: true, data: entries });
  });

  app.post('/registry/:id/install', async (c) => {
    return configurationMutationResponse(
      await captureConfigurationMutation(
        ctx.applyAgentConfigurationMutation,
        async (beginMutation) => {
          const id = param(c, 'id');
          const collision = nativeEngineIdCollision(id);
          if (collision) {
            return c.json({ success: false, error: collision }, 400);
          }
          const config = await ctx.configLoader.loadACPConfig();
          const providerConns = getProviderConnections();
          const provided = providerConns.find((conn) => conn.id === id);
          if (provided) {
            return c.json(
              {
                success: false,
                error: `${provided.name || id} is already provided by a plugin.`,
              },
              409,
            );
          }

          const entry = findRegistryEntry(
            id,
            [...config.connections, ...providerConns],
            publicRegistry,
          );
          if (!entry) {
            return c.json(
              {
                success: false,
                error: `Engine registry entry '${id}' not found`,
              },
              404,
            );
          }
          if (!engineSupportsPlatform(entry, process.platform)) {
            return c.json(
              {
                success: false,
                error: `${entry.name} does not run on ${process.platform}, the platform Station runs on.`,
              },
              400,
            );
          }

          const listing =
            entry.source === 'registry' ? entry.publicRegistry : undefined;
          if (entry.source === 'registry') {
            // A public listing names the program and arguments Station will
            // run, so adding one is choosing a command: the same authority,
            // and the person must have confirmed exactly what runs now.
            const commandRefused = refuseUngrantedCommandChoice(c);
            if (commandRefused) return commandRefused;
            const launch = listing?.hostLaunch;
            if (!launch) {
              return c.json(
                {
                  success: false,
                  error:
                    listing?.unavailableReason ??
                    `${entry.name} cannot be connected on this computer.`,
                },
                400,
              );
            }
            const confirmed = await confirmedCommand(c.req.raw);
            if (
              !confirmed ||
              confirmed.command !== launch.command ||
              !isDeepStrictEqual(confirmed.args, launch.args)
            ) {
              return c.json(
                {
                  success: false,
                  code: 'registry-listing-not-confirmed',
                  error: `Review ${entry.name} again before connecting: the command confirmed is not the one the public registry lists now. Nothing was saved.`,
                },
                409,
              );
            }
          }

          const newConn = normalizeACPConnection({
            id: entry.id,
            name: entry.name,
            command: entry.command,
            args: entry.args || [],
            icon: entry.icon || '🔌',
            cwd: entry.cwd,
            enabled: true,
            interactive: entry.interactive,
            ...(listing
              ? { publicRegistry: { id: listing.id, version: listing.version } }
              : {}),
          });
          const existing = config.connections.find((conn) => conn.id === id);
          if (existing && !isDeepStrictEqual(existing, newConn)) {
            return c.json(
              {
                success: false,
                error: `${existing.name || id} is already saved with different settings. Use Edit setup on it, or remove it first.`,
              },
              409,
            );
          }
          if (!existing) config.connections.push(newConn);
          // Durable ACP config first, then the identity/default CAS. A failed
          // CAS deliberately leaves retryable config that remains invisible.
          await ctx.configLoader.saveACPConfig(config);
          beginMutation();
          // Probe BEFORE materializing anything user-visible. The old order
          // created the Agent (and the picker row) unconditionally, so an
          // engine that could not be onboarded left a permanent "Needs: …"
          // ghost row behind its own failed install. The config entry stays —
          // retryable, and invisible to every installed surface until the
          // identity below registers — and a later install/re-check of the
          // same entry re-probes and materializes once the engine works.
          const connected = await connectNewACPConnection(ctx, newConn);
          // A never-connected engine that ran out of the request budget gets
          // its cold retry in the background; the response reads `probing`.
          if (!connected) ctx.acpBridge.continueFirstContact?.(newConn.id);
          const agent = connected
            ? await registerPersistedACPConnection(
                ctx,
                newConn.id,
                newConn.name,
              )
            : undefined;
          acpOps.add(1, { op: 'create' });
          return c.json({
            success: true,
            data: connectionStatusView(newConn, ctx.acpBridge.getStatus()),
            ...(agent
              ? {
                  agent: {
                    data: await installedAgentReceipt(
                      ctx.configLoader as ConfigLoader,
                      agent.slug,
                    ),
                    created: agent.created,
                  },
                }
              : {}),
          });
        },
      ),
    );
  });

  app.post('/connections', validate(acpConnectionSchema), async (c) => {
    // The command and folder a connection runs are chosen here.
    const commandRefused = refuseUngrantedCommandChoice(c);
    if (commandRefused) return commandRefused;
    return configurationMutationResponse(
      await captureConfigurationMutation(
        ctx.applyAgentConfigurationMutation,
        async (beginMutation) => {
          const body = getBody(c);
          if (!body.id || !body.command) {
            return c.json(
              { success: false, error: 'id and command are required' },
              400,
            );
          }
          const collision = nativeEngineIdCollision(body.id);
          if (collision) {
            return c.json({ success: false, error: collision }, 400);
          }
          const config = await ctx.configLoader.loadACPConfig();
          const newConn = normalizeACPConnection({
            id: body.id,
            name: body.name || body.id,
            command: body.command,
            args: body.args || [],
            icon: body.icon || '🔌',
            cwd: body.cwd,
            enabled: body.enabled !== false,
            ...(body.provideToolServers
              ? { provideToolServers: body.provideToolServers }
              : {}),
          });
          const existing = config.connections.find(
            (connection) => connection.id === newConn.id,
          );
          if (existing && !isDeepStrictEqual(existing, newConn)) {
            const name = existing.name || body.id;
            return c.json(
              {
                success: false,
                error: `${name} already uses the ID "${body.id}". Choose a different ID under Advanced, or use Edit setup on ${name}.`,
              },
              409,
            );
          }
          if (!existing) {
            config.connections.push(newConn);
            await ctx.configLoader.saveACPConfig(config);
          }
          beginMutation();
          // Same gate as the registry install: no handshake, no Agent.
          const connected = await connectNewACPConnection(ctx, newConn);
          if (connected) {
            await registerPersistedACPConnection(ctx, newConn.id, newConn.name);
          } else {
            ctx.acpBridge.continueFirstContact?.(newConn.id);
          }
          acpOps.add(1, { op: 'create' });
          return c.json({
            success: true,
            data: connectionStatusView(newConn, ctx.acpBridge.getStatus()),
          });
        },
      ),
    );
  });

  app.put(
    '/connections/:id',
    validate(acpConnectionSchema.partial()),
    async (c) => {
      return configurationMutationResponse(
        await captureConfigurationMutation(
          ctx.applyAgentConfigurationMutation,
          async (beginMutation) => {
            const id = param(c, 'id');
            const body = getBody(c);
            const config = await ctx.configLoader.loadACPConfig();
            const idx = config.connections.findIndex((conn) => conn.id === id);
            if (idx === -1)
              return c.json(
                { success: false, error: 'Connection not found' },
                404,
              );
            const stored = config.connections[idx];
            // Both sides without empty-string arguments (an earlier form saved
            // blank arguments as ['']), so a rename is not read as a command
            // change.
            const previous = stored.args
              ? { ...stored, args: normalizeACPArgs(stored.args) }
              : stored;
            const updates = Array.isArray(body.args)
              ? { ...body, args: normalizeACPArgs(body.args) }
              : body;
            // Changing what a connection runs, or where, is choosing a
            // command; renaming or toggling it is not.
            if (changesAny(updates, previous, ['command', 'args', 'cwd'])) {
              const commandRefused = refuseUngrantedCommandChoice(c);
              if (commandRefused) return commandRefused;
            }
            // Edit setup sends every field: an empty folder means none, an
            // empty icon means the default.
            const next: ACPConnectionConfig = { ...previous, ...updates, id };
            if (next.cwd === '') delete next.cwd;
            if (next.icon === '') next.icon = '🔌';
            if (changesAny(updates, previous, ['command', 'args'])) {
              delete next.publicRegistry;
            }
            if (isDeepStrictEqual(stored, next)) {
              // Nothing to save or re-probe; still answer the status the
              // setup dialog reads.
              return c.json({
                success: true,
                data: connectionStatusView(previous, ctx.acpBridge.getStatus()),
              });
            }
            config.connections[idx] = next;
            await ctx.configLoader.saveACPConfig(config);
            beginMutation();
            await ctx.acpBridge.removeConnection(id);
            // Same gate as the create paths: an edit that still cannot
            // handshake does not (re)materialize the engine's Agent. An
            // Agent that already exists is left exactly as it is — the
            // projection marks it unavailable through the connection, and a
            // repair that does handshake materializes or adopts below.
            const connected = await connectNewACPConnection(ctx, next);
            if (connected) {
              await registerPersistedACPConnection(ctx, id, next.name);
            } else {
              ctx.acpBridge.continueFirstContact?.(id);
            }
            acpOps.add(1, { op: 'update' });
            return c.json({
              success: true,
              data: connectionStatusView(next, ctx.acpBridge.getStatus()),
            });
          },
        ),
      );
    },
  );

  app.delete('/connections/:id', async (c) => {
    return configurationMutationResponse(
      await captureConfigurationMutation(
        ctx.applyAgentConfigurationMutation,
        async (beginMutation) => {
          const id = param(c, 'id');
          const config = await ctx.configLoader.loadACPConfig();
          if (!config.connections.some((conn) => conn.id === id)) {
            return c.json(
              { success: false, error: 'Connection not found' },
              404,
            );
          }
          // Registry removal first means a following config-write failure
          // leaves only retryable, non-authoritative ACP data on disk.
          await unregisterPersistedACPConnection(ctx, id);
          config.connections = config.connections.filter(
            (conn) => conn.id !== id,
          );
          await ctx.configLoader.saveACPConfig(config);
          beginMutation();
          await ctx.acpBridge.removeConnection(id);
          acpOps.add(1, { op: 'delete' });
          return c.json({ success: true });
        },
      ),
    );
  });

  app.post('/connections/:id/reconnect', async (c) => {
    const id = param(c, 'id');
    // Existence is judged by the bridge's live probe set — the same
    // projection GET /status serves. Reconnect acts on a live connection;
    // a config entry that never onboarded has no probe to reconnect, and
    // the bridge's own `false` cannot distinguish that from a failed
    // handshake, so the explicit 404 is resolved here.
    const connection = ctx.acpBridge
      .getStatus()
      .connections.find((entry) => entry.id === id);
    if (!connection) {
      return c.json({ success: false, error: 'Connection not found' }, 404);
    }
    // The probe contract already redacts secrets in `lastError.message`
    // (acp-probe.ts); the client-facing channel additionally runs it through
    // `sanitizeFreeText`, which strips paths/URLs and bounds the length. The
    // raw command/args are never echoed.
    const failure = (detail?: string, phase?: string) =>
      c.json(
        {
          success: false,
          // Retry check's own words; the engine's name, never the protocol.
          error: `Could not check ${connection.name || id}.`,
          ...(phase ? { phase } : {}),
          ...(detail ? { detail: sanitizeFreeText(detail) } : {}),
        },
        502,
      );
    try {
      const result = await ctx.acpBridge.reconnect(id);
      if (!result) {
        const current = ctx.acpBridge
          .getStatus()
          .connections.find((entry) => entry.id === id);
        return failure(current?.lastError?.message, current?.lastError?.phase);
      }
    } catch (error) {
      return failure(sanitizedTransportError(error).message);
    }
    return c.json({ success: true });
  });

  app.post(
    '/connections/:id/providers/set',
    validate(acpSetProviderSchema),
    async (c) => {
      const id = param(c, 'id');
      const body = getBody(c);
      let resolution: IntegrationSecretResolution | undefined;
      try {
        ctx.acpBridge.assertProviderSupported(
          id,
          body.providerId,
          body.apiType,
        );
        if (Object.keys(body.secretHeaderRefs ?? {}).length > 0) {
          if (!ctx.acpProviderSecretResolver) {
            throw new Error('ACP provider secret resolution is unavailable.');
          }
          resolution =
            await ctx.acpProviderSecretResolver.resolveForAcpProvider({
              connectionId: id,
              providerId: body.providerId,
              secretHeaderRefs: body.secretHeaderRefs ?? {},
            });
        }
        await ctx.acpBridge.setProvider(id, {
          providerId: body.providerId,
          apiType: body.apiType,
          baseUrl: body.baseUrl,
          headers: resolution?.environment,
        });
        resolution?.settlement.settle({ outcome: 'success' });
        return c.json({
          success: true,
          data: {
            providerId: body.providerId,
            apiType: body.apiType,
            baseUrl: body.baseUrl,
          },
        });
      } catch (error) {
        resolution?.settlement.settle({
          outcome: 'failure',
          reason: 'child_establishment_failed',
        });
        if (error instanceof SecretBindingResolutionError) {
          return c.json(
            {
              success: false,
              error: 'The ACP provider secret binding cannot be established.',
            },
            400,
          );
        }
        if (error instanceof ACPProviderRouteValidationError) {
          return c.json(
            { success: false, error: acpProviderRoutePublicError(error) },
            409,
          );
        }
        if (
          (error as Error | undefined)?.name ===
          'ACPProviderRoutingUnsupportedError'
        ) {
          return c.json(
            {
              success: false,
              error:
                'This ACP agent did not advertise provider routing support.',
            },
            409,
          );
        }
        throw error;
      }
    },
  );

  app.post(
    '/connections/:id/providers/disable',
    validate(acpDisableProviderSchema),
    async (c) => {
      const id = param(c, 'id');
      const body = getBody(c);
      try {
        await ctx.acpBridge.disableProvider(id, body.providerId);
        return c.json({ success: true });
      } catch (error) {
        if (
          (error as Error | undefined)?.name ===
          'ACPRequiredProviderDisableError'
        ) {
          return c.json(
            {
              success: false,
              error:
                'The requested ACP provider is required and cannot be disabled.',
            },
            409,
          );
        }
        if (
          (error as Error | undefined)?.name ===
          'ACPProviderRoutingUnsupportedError'
        ) {
          return c.json(
            {
              success: false,
              error:
                'This ACP agent did not advertise provider routing support.',
            },
            409,
          );
        }
        throw error;
      }
    },
  );

  return app;
}

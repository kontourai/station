import { resolve } from 'node:path';
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_ENV,
} from '../../utils/internal-api-token.js';

export function builtinStationControlServerPath(): string {
  return resolve(import.meta.dirname || process.cwd(), 'station-control.js');
}

/**
 * station#1547: the sibling built-in `station-docs` stdio server, resolved the
 * same way. It is the deliberate opposite of station-control below — it needs
 * NO credential and NO environment, because everything it serves is static
 * documentation compiled into its own bundle. That absence is the entire
 * reason it can be delivered to every engine, including the ones whose
 * matrix has no reviewed mechanism for station-control's `env`, so there is
 * no `withStationDocsRuntimeEnv` and no docs equivalent of
 * `isBuiltinStationControl`'s exemption gate: nothing about this server ever
 * needs exempting.
 */
export function builtinStationDocsServerPath(): string {
  return resolve(import.meta.dirname || process.cwd(), 'station-docs.js');
}

/**
 * The canonical id of the built-in docs server, declared once (station#1547
 * AC5) because three unrelated modules now name it: the factory that persists
 * the integration (`runtime-default-agent.ts`), the resolver's synthetic
 * Station-identity spec (`session-agent-resolution.ts`), and the ACP
 * adapter's runtime grant. A fourth string literal is how those three drift.
 */
export const BUILTIN_STATION_DOCS_TOOL_SERVER_ID = 'station-docs';

/**
 * Identity check for the built-in docs server, the exact shape
 * {@link isBuiltinStationControl} holds — read that doc comment for the
 * actual post-#3063 contract (registered-id discrimination, fail-toward-
 * genuine), which applies here identically.
 *
 * What THIS gate protects, distinctly: it gates a GRANT rather than an
 * exemption — the ACP adapter delivers this server to an engine that never
 * asked for it, so what it must not do is spawn some FOREIGN binary sitting
 * under the id `station-docs` into that engine. Post-#3063 that cannot
 * happen by construction: any def resolved through a registered
 * `ConfigLoader` under this id carries the genuine shipped command/args
 * (the overlay replaces file content wholesale), so passing this gate
 * implies the genuine docs bundle is what spawns. A def from a path WITHOUT
 * the overlay (hand-built, cross-process, stale app path after an update)
 * fails the exact-path match and is simply not granted.
 */
export function isBuiltinStationDocs(
  toolId: string,
  toolDef: ToolDef,
): boolean {
  const serverPath = toolDef.args?.[0];
  return (
    toolId === BUILTIN_STATION_DOCS_TOOL_SERVER_ID &&
    toolDef.command === 'node' &&
    typeof serverPath === 'string' &&
    resolve(serverPath) === builtinStationDocsServerPath()
  );
}

/**
 * Identity check for the canonical built-in station-control MCP server: an
 * exact match on the tool id AND the absolute `command`/`args[0]` path.
 * Exported (station#1157) so every caller that needs to recognize "is this
 * really the built-in station-control child" reuses this ONE gate rather
 * than re-deriving it: `withStationControlRuntimeEnv` below,
 * `mcp-manager.ts`'s spawn config, and `session-agent-resolution.ts`'s
 * resolver-stage secret-boundary-env exemption (station#1157) all call this
 * directly.
 *
 * THE ACTUAL CONTRACT, post-#3063 (review INFO-2 — the older "file-content
 * spoof resistance" description overstated it): the persisted built-in file
 * carries no command/args at all, and `ConfigLoader.loadIntegration`'s
 * runtime-identity overlay injects the GENUINE shipped command/args for any
 * def loaded under a registered built-in id — including a hand-authored
 * file a user saved under `integrations/station-control/`. So for
 * overlay-resolved defs this gate no longer discriminates on file content;
 * it distinguishes "a registered built-in id, resolved by this process"
 * from everything else. That is fail-toward-genuine: the check cannot be
 * spoofed INTO running a foreign binary, because whatever the file said,
 * what passes here (and what spawns, and what receives the token) is the
 * genuine built-in at this instance's own dist path. The path match still
 * does real work for defs that arrive WITHOUT the overlay — hand-built
 * ToolDefs, cross-process/persisted shapes, or a stale path after an app
 * update — which fail toward NOT-builtin (no token, no exemption, no
 * grant). Reviewer-verified consequence check: no token exfil path opens up
 * — the internal token rides spawn env only, sse/http transports never
 * receive env, and header-token URLs are built from `this.port`, never from
 * a resolved def.
 */
export function isBuiltinStationControl(
  toolId: string,
  toolDef: ToolDef,
): boolean {
  const serverPath = toolDef.args?.[0];
  return (
    toolId === BUILTIN_STATION_CONTROL_TOOL_SERVER_ID &&
    toolDef.command === 'node' &&
    typeof serverPath === 'string' &&
    resolve(serverPath) === builtinStationControlServerPath()
  );
}

/**
 * Attach Station's process-local API credential only to the built-in
 * station-control child. The credential must never be persisted in the
 * integration definition, while arbitrary third-party MCP servers must not
 * receive it.
 */
export function withStationControlRuntimeEnv(
  toolId: string,
  toolDef: ToolDef,
  env: Record<string, string> | undefined,
  tenantExecutionContext?: TenantExecutionContext,
): Record<string, string> | undefined {
  const runtimeEnv = env ? { ...env } : undefined;
  if (runtimeEnv) {
    delete runtimeEnv[INTERNAL_API_TOKEN_ENV];
    // A parent process is never tenant authority. Only the trusted execution
    // context supplied by the server below may carry this reserved value to
    // the exact built-in child.
    delete runtimeEnv.STATION_INTERNAL_TENANT;
  }
  if (!isBuiltinStationControl(toolId, toolDef)) return runtimeEnv;
  return {
    ...runtimeEnv,
    [INTERNAL_API_TOKEN_ENV]: getInternalApiToken(),
    ...(tenantExecutionContext
      ? { STATION_INTERNAL_TENANT: tenantExecutionContext.tenantId }
      : {}),
  };
}

/**
 * The non-secret operational env the built-in station-control child needs
 * to reach THIS running instance's API — `STATION_API_BASE`/`STATION_PORT`,
 * read verbatim by `resolveControlApiBase()` (station-control-shared.ts).
 * Station#1157: extracted from `runtime-default-agent.ts`'s
 * `createRuntimeSelfIntegration` (which now calls this instead of inlining
 * the literal) so every caller that reconstructs station-control's spawn
 * env for a given port — Station's own engine and, as of #1157, the Claude
 * adapter's in-process MCP passthrough — shares one definition. `port` must
 * be the ACTUALLY bound port for this instance (not `process.env.PORT`,
 * which is stale/unset under `PORT=0`/auto-allocate — see
 * `resolveRuntimePort`/`allocateFreePortBlock` in `index.ts`).
 */
export function stationControlSpawnEnv(port: number): Record<string, string> {
  return {
    STATION_API_BASE: `http://127.0.0.1:${port}`,
    STATION_PORT: String(port),
  };
}

/**
 * station#3063: the RUNNING instance's spawn identity for the built-in
 * station-control server — the fields that used to be baked into the
 * persisted `integrations/station-control/integration.json` and are now
 * resolved fresh at LOAD time (`ConfigLoader.loadIntegration`'s
 * builtin-runtime-identity overlay, registered by `StationRuntime`'s
 * constructor).
 *
 * Why they must never be persisted again: two supported servers sharing one
 * `~/.station` home (the desktop app + the launchd service, station#2895)
 * each embedded their OWN dist path and port, so every `reloadAgents()`
 * rewrite flipped the bytes and retriggered the OTHER process's config
 * watcher — an unbounded cross-process reload loop (~1/s) that the #1588
 * byte-identical save skip structurally cannot converge, because the two
 * writers' bytes legitimately disagree. Keeping instance identity out of the
 * persisted file (and out of every save — see
 * `ConfigLoader.saveIntegration`'s projection) is what makes the persisted
 * bytes a fixpoint both instances agree on. It also fixes a correctness
 * hole the loop obscured: with a baked path, whichever instance wrote LAST
 * owned the file, and the other instance's `isBuiltinStationControl` exact
 * path match failed — silently withholding the internal API token from its
 * own built-in child.
 */
export function stationControlRuntimeIdentity(
  port: number,
): Pick<ToolDef, 'command' | 'args' | 'env'> {
  return {
    command: BUILTIN_INTEGRATION_SPAWN_COMMAND,
    args: [builtinStationControlServerPath()],
    env: stationControlSpawnEnv(port),
  };
}

/**
 * station#3063: the one spawn executable both built-in tool servers use.
 * Shared so surfaces that read the PERSISTED files directly (which carry no
 * `command` anymore — e.g. the registry/marketplace disk scan in
 * `integration-registry-provider.ts`) can derive binary presence from the
 * same truth the runtime overlay spawns with, instead of re-hardcoding
 * strings.
 */
const BUILTIN_INTEGRATION_SPAWN_COMMAND = 'node';

/**
 * The canonical id of the built-in station-control server — the exact string
 * `isBuiltinStationControl` matches on and `StationRuntime`'s constructor
 * registers the runtime-identity overlay under (station#3063).
 */
export const BUILTIN_STATION_CONTROL_TOOL_SERVER_ID = 'station-control';

/**
 * station#3063: the spawn command a registered built-in integration id runs
 * under, or `undefined` for every other id. This is what the persisted
 * file's absent `command` field RESOLVES to at spawn time (see
 * `stationControlRuntimeIdentity`/`stationDocsRuntimeIdentity`), so
 * disk-reading surfaces that derive "binary present?" status must consult
 * this rather than concluding 'missing binary' from the stripped file.
 */
/**
 * True for a tool server the RUNTIME registers and re-materializes on every
 * start (`materializeBuiltinIntegrations`), rather than one a user added.
 *
 * Audit CI-R7: the UI had no reliable way to ask this. `ToolDef.kind` is not
 * it — these two persist as `kind: 'mcp'` (they really are stdio MCP servers;
 * `'builtin'` discriminates Strands' in-process vended tools), so the editor's
 * `kind === 'builtin'` test was false for both and offered Delete on a server
 * the next reload re-creates. The id is the only thing that has ever
 * identified them, so the predicate says so once, here, beside the other
 * registered-id gates, instead of being re-derived per surface.
 */
export function isRuntimeManagedIntegrationId(id: string): boolean {
  return (
    id === BUILTIN_STATION_CONTROL_TOOL_SERVER_ID ||
    id === BUILTIN_STATION_DOCS_TOOL_SERVER_ID
  );
}

export function builtinIntegrationRuntimeSpawnCommand(
  id: string,
): string | undefined {
  return id === BUILTIN_STATION_CONTROL_TOOL_SERVER_ID ||
    id === BUILTIN_STATION_DOCS_TOOL_SERVER_ID
    ? BUILTIN_INTEGRATION_SPAWN_COMMAND
    : undefined;
}

/**
 * station#3063: the running instance's spawn identity for the built-in
 * station-docs server. Deliberately declares NO `env` key — the station#1547
 * credential-free contract (see `createRuntimeDocsIntegration`'s doc comment
 * and its AC3 test guard) applies to the loaded/delivered shape, which this
 * overlay now produces.
 */
export function stationDocsRuntimeIdentity(): Pick<
  ToolDef,
  'command' | 'args'
> {
  return {
    command: BUILTIN_INTEGRATION_SPAWN_COMMAND,
    args: [builtinStationDocsServerPath()],
  };
}

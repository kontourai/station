/**
 * ACP MCP passthrough resolution (docs/design/connections-onboarding.md §5,
 * productization of the flag-gated `spike/acp-mcp-passthrough` helper — this
 * module supersedes that spike; it is not derived from its code).
 *
 * Pure(ish) mapping from an ACP connection's opted-in tool-server ids
 * (`ACPConnectionConfig.provideToolServers`) to the ACP SDK's stdio
 * `McpServer` entries passed into `session/new`. `session/load` — resuming
 * an existing ACP session — is now wired too (archive#895 wave B, via
 * `AcpAdapter.startReservedSession`), reusing this same resolver so a
 * resumed session gets the identical passthrough tool servers a fresh one
 * would. Kept side-effect-light and
 * unit-testable: the only I/O is the injected `resolveToolServer` callback,
 * `findAbsoluteBinary` (defaults to the real PATH-scanning resolver), and an
 * `existsSync` check on the final absolute command path.
 *
 * Station uses the MCP specification's canonical `stdio` name for local child
 * processes. AUTHORED passthrough — anything a user or agent configured — is
 * stdio-only, deliberately and still: an authored http/sse tool server is
 * skipped `unsupported-transport`, exactly as before.
 *
 * archive#1684 adds ONE http entry, and it is not authored passthrough: the
 * canonical BUILT-IN `station-control` server, delivered on its own reviewed
 * mechanism (`builtinStationControlDelivery: 'http-header-token'` on the
 * `acp` matrix cell). It is not a relaxation of the rule above — it is a
 * different server reached a different way, and the two do not interact.
 *
 * Security boundary (repo review, 2026-07-26): a tool server whose `ToolDef`
 * declares ANY `env` entries is never passed through, full stop — those
 * entries can carry secrets (API tokens, etc.), and `session/new`'s
 * `mcpServers` payload is visible to the external agent app driving the ACP
 * session, not confined to the spawned MCP child process. Excluding
 * env-bearing tool servers entirely (rather than trying to redact/filter
 * individual entries) is the only shape that can't leak a secret we didn't
 * anticipate.
 *
 * The station-control branch does NOT weaken that boundary, and the reason is
 * worth stating precisely, because "it skips the env check" is the wrong
 * summary:
 *
 *  - It never forwards `toolDef.env`. The built-in server's persisted env
 *    (`STATION_API_BASE`/`STATION_PORT`) is not filtered, redacted, or
 *    partially copied — it is not read. The emitted entry has no `env` field
 *    at all, because an `McpServerHttp` has no such field to put it in. The
 *    bearer token REPLACES the env rather than accompanying it.
 *  - It is gated on `isBuiltinStationControl`, an exact command/args
 *    identity check, NOT on `id === 'station-control'`. Post-#3063 the
 *    ConfigLoader overlay injects the genuine command/args for any def
 *    resolved under the registered built-in id, so a file a user saved
 *    under `integrations/station-control/` reaches here AS the genuine
 *    built-in and takes this branch — delivering the real header-token
 *    endpoint, never the author's binary or env (fail-toward-genuine; see
 *    the gate's doc comment). A def arriving WITHOUT the overlay's genuine
 *    identity fails the check, falls through to the ordinary path below,
 *    and is skipped `requires-env-secrets` like anything else with an env.
 *  - It fails CLOSED. Without a caller-supplied `stationControlAuth` the
 *    server is skipped `engine-capability-absent`; it never falls through to
 *    the stdio path, because the stdio path would spawn the real
 *    station-control binary with no credential at all.
 */
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { EnvVariable, McpServer } from '@agentclientprotocol/sdk';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { isBuiltinStationControl } from '../../runtime/bootstrap/station-control-runtime-env.js';
import { findCliBinary } from '../auth/cli-auth.js';

/** Matches the `any`-typed logger threaded through the ACP substrate. */
type AcpLogger = any;

export type AcpToolServerSkipReason =
  | 'not-found'
  | 'disabled'
  | 'unsupported-transport'
  | 'requires-env-secrets'
  | 'binary-not-found'
  /** archive#1684: the built-in station-control server was asked for, but
   * the connected engine's live handshake gave this session no usable
   * `mcpCapabilities.http`, so no credential was minted. The `detail` is
   * supplied by the caller — only the adapter knows whether the engine
   * answered no or whether there was no handshake result to read at all,
   * and collapsing those two into one string would report a fact Station
   * does not have. */
  | 'engine-capability-absent'
  /** archive#1684: the built-in station-control server was asked for and no
   * credential was supplied, with nothing said about the engine — see
   * `STATION_CONTROL_UNEXPLAINED_SKIP`. Distinct from the reason above
   * precisely so a caller that never consulted the engine cannot emit a
   * receipt that blames it. */
  | 'delivery-failed';

export interface AcpToolServerSkip {
  id: string;
  reason: AcpToolServerSkipReason;
  detail?: string;
}

export interface ResolveAcpPassthroughMcpServersInput {
  /** `ACPConnectionConfig.provideToolServers` — absent/empty ⇒ no lookups, no servers. */
  toolServerIds: string[] | undefined;
  /** Resolve one tool-server id to its configured `ToolDef`; `null` when unknown. */
  resolveToolServer: (id: string) => Promise<ToolDef | null>;
  logger?: AcpLogger;
  /** Injectable for tests; defaults to the real PATH-scanning resolver. */
  findAbsoluteBinary?: (command: string) => string | null;
  /** Injectable for tests; defaults to `node:fs`'s `existsSync`. */
  commandExists?: (absolutePath: string) => boolean;
  /**
   * archive#1684: the already-minted header-channel credential for the
   * canonical built-in station-control server — the bare endpoint URL
   * (`buildStationControlMcpHeaderUrl`, no token in it) plus the token that
   * will ride `Authorization: Bearer`. Per session, and bounded to the
   * 12-hour `DEFAULT_TTL_MS` (`station-control-mcp-token.ts`) as a fallback
   * for a session that never cleanly stops. Minted entirely by the caller
   * (`acp-adapter.ts`), and only after that caller has verified the live
   * `initialize` handshake advertised `mcpCapabilities.http` — this module
   * mints nothing and verifies nothing.
   *
   * Attached ONLY to a server passing `isBuiltinStationControl`; ignored for
   * every other server, including one sharing that id. Absent ⇒ the built-in
   * server is skipped, never delivered by some other means.
   */
  stationControlAuth?: { url: string; token: string };
  /**
   * Why `stationControlAuth` is absent, when the caller knows. Both fields
   * are caller-owned, including the REASON: this module observes only "no
   * credential was handed to me", and the several distinct facts behind that
   * — the engine answered no at `initialize`, there was no handshake result
   * to read, or Station itself has no minting closure wired — are knowable
   * only at the adapter. Reporting any of them as the others would be a
   * receipt asserting something nobody computed.
   *
   * Absent ⇒ the fallback below, which says exactly what this module saw and
   * nothing about why.
   */
  stationControlUnavailable?: {
    reason: AcpToolServerSkipReason;
    detail: string;
  };
}

/**
 * The honest skip when the caller supplied no credential AND no reason: a
 * statement about this module's own observation only. `'delivery-failed'`
 * rather than `'engine-capability-absent'` deliberately — an absent
 * credential is not evidence about the ENGINE, and a caller that never
 * consulted the engine must not be able to produce a receipt blaming it.
 */
const STATION_CONTROL_UNEXPLAINED_SKIP = {
  reason: 'delivery-failed',
  detail: 'no station-control MCP auth was supplied for this session',
} as const satisfies { reason: AcpToolServerSkipReason; detail: string };

export interface ResolveAcpPassthroughMcpServersResult {
  servers: McpServer[];
  skipped: AcpToolServerSkip[];
  /**
   * archive#1684 (review fix): did THIS call actually push the `type: 'http'`
   * built-in station-control entry?
   *
   * Stated by the producer rather than inferred by the caller, because the
   * two questions a caller would otherwise conflate are decided here and only
   * here: the caller mints on an ID (`'station-control'` appears in the
   * requested list) while this module delivers on an IDENTITY
   * (`isBuiltinStationControl`). Those can still disagree: post-#3063 an
   * overlay-resolved def under the built-in id is always genuine, but a def
   * that reaches this module WITHOUT the overlay's identity (a hand-built
   * ToolDef, or a resolver that isn't the registered ConfigLoader) fails
   * the gate and is not delivered the credential. A caller that scanned
   * `servers` for the NAME `station-control` would read such an entry's
   * stdio fallback as a successful delivery, so the name is not usable
   * evidence either. `false` here is the only honest signal that a minted
   * credential was never handed to anyone.
   */
  stationControlDelivered: boolean;
}

function toEnvVariables(
  env: Record<string, string> | undefined,
): EnvVariable[] {
  if (!env) return [];
  return Object.entries(env).map(([name, value]) => ({ name, value }));
}

/** Absolute paths pass through untouched; bare commands resolve via PATH. */
function resolveAbsoluteCommand(
  command: string,
  findAbsoluteBinary: (command: string) => string | null,
): string | null {
  if (isAbsolute(command)) return command;
  return findAbsoluteBinary(command);
}

/**
 * Resolve the explicit-opt-in tool-server ids for one ACP connection into ACP
 * `McpServer` entries — stdio for every authored server, plus the single
 * `type: 'http'` entry for the built-in station-control server when the
 * caller supplied its credential (archive#1684). Never throws: an unresolvable id is recorded in
 * `skipped` with a reason, never silently dropped from observability. Empty
 * or absent `toolServerIds` short-circuits to `{ servers: [], skipped: [] }`
 * without invoking `resolveToolServer` — the off-by-default case must stay
 * a true no-op.
 */
export async function resolveAcpPassthroughMcpServers(
  input: ResolveAcpPassthroughMcpServersInput,
): Promise<ResolveAcpPassthroughMcpServersResult> {
  const {
    toolServerIds,
    resolveToolServer,
    logger = console,
    findAbsoluteBinary = findCliBinary,
    commandExists = existsSync,
    stationControlAuth,
    stationControlUnavailable = STATION_CONTROL_UNEXPLAINED_SKIP,
  } = input;

  const servers: McpServer[] = [];
  const skipped: AcpToolServerSkip[] = [];
  // Set on the ONE branch below that pushes the http entry — never derived
  // from `servers`, see the field's doc comment.
  let stationControlDelivered = false;
  if (!toolServerIds || toolServerIds.length === 0) {
    return { servers, skipped, stationControlDelivered };
  }

  for (const id of toolServerIds) {
    const toolDef = await resolveToolServer(id);
    if (!toolDef) {
      skipped.push({ id, reason: 'not-found' });
      logger.warn?.(
        `ACP MCP passthrough: tool server '${id}' is not configured; skipping.`,
      );
      continue;
    }

    if (toolDef.enabled === false) {
      skipped.push({ id, reason: 'disabled' });
      logger.info?.(
        `ACP MCP passthrough: tool server '${id}' is disabled; skipping.`,
      );
      continue;
    }

    // archive#1684: the ONE http entry, and the only branch that may reach
    // a server declaring `env` — see this module's header comment for why
    // that is not an env exemption. Placed above the env gate deliberately:
    // the built-in server's persisted `STATION_API_BASE`/`STATION_PORT` is
    // exactly the env the gate below exists to stop, and the point of this
    // branch is that none of it is sent. `isBuiltinStationControl` is an
    // exact command/args identity match, so an unrelated integration saved
    // under the id `station-control` never reaches here.
    if (isBuiltinStationControl(id, toolDef)) {
      if (!stationControlAuth) {
        // Fail closed. NOT a fall-through to the stdio path below: that path
        // would hand the external agent app the real station-control binary
        // with no credential, which is a broken server presented as a
        // working one.
        skipped.push({
          id,
          reason: stationControlUnavailable.reason,
          detail: stationControlUnavailable.detail,
        });
        logger.warn?.(
          'ACP MCP passthrough: the built-in station-control server was not delivered — ' +
            `${stationControlUnavailable.detail}.`,
        );
        continue;
      }
      servers.push({
        type: 'http',
        name: toolDef.id,
        url: stationControlAuth.url,
        // The credential, and the whole payload Station sends for this
        // server. No `env` field exists on an `McpServerHttp` — the token
        // replaces the env rather than travelling beside it.
        headers: [
          {
            name: 'Authorization',
            value: `Bearer ${stationControlAuth.token}`,
          },
        ],
      });
      stationControlDelivered = true;
      continue;
    }

    // Security boundary first, independent of transport: any declared env
    // entry can carry a secret, and session/new's payload is visible to the
    // external agent app — never the spawned MCP process alone.
    if (
      (toolDef.env && Object.keys(toolDef.env).length > 0) ||
      (toolDef.secretEnvRefs && Object.keys(toolDef.secretEnvRefs).length > 0)
    ) {
      skipped.push({ id, reason: 'requires-env-secrets' });
      logger.warn?.(
        `ACP MCP passthrough: tool server '${id}' declares environment variables; ` +
          'not sharing it with an external agent app (secrets stay server-side). Skipping.',
      );
      continue;
    }

    if (toolDef.kind !== 'mcp' || toolDef.transport !== 'stdio') {
      skipped.push({
        id,
        reason: 'unsupported-transport',
        detail: toolDef.transport,
      });
      logger.warn?.(
        `ACP MCP passthrough: tool server '${id}' uses transport '${toolDef.transport ?? 'unknown'}', ` +
          'and authored passthrough is stdio-only; skipping. (The built-in station-control ' +
          'server is delivered over http above, on its own reviewed mechanism — that is not a ' +
          'general http passthrough channel.)',
      );
      continue;
    }

    if (!toolDef.command) {
      skipped.push({ id, reason: 'binary-not-found' });
      logger.warn?.(
        `ACP MCP passthrough: tool server '${id}' has no command configured; skipping.`,
      );
      continue;
    }

    const absoluteCommand = resolveAbsoluteCommand(
      toolDef.command,
      findAbsoluteBinary,
    );
    if (!absoluteCommand || !commandExists(absoluteCommand)) {
      skipped.push({ id, reason: 'binary-not-found', detail: toolDef.command });
      logger.warn?.(
        `ACP MCP passthrough: could not resolve an existing absolute path for tool server ` +
          `'${id}''s command '${toolDef.command}'; skipping.`,
      );
      continue;
    }

    servers.push({
      name: toolDef.id,
      command: absoluteCommand,
      args: toolDef.args ?? [],
      // Always empty here: the requires-env-secrets check above already
      // skipped any toolDef with a non-empty `env`. Still routed through
      // the pure mapper (not hardcoded `[]`) so this stays correct if that
      // invariant ever changes.
      env: toEnvVariables(toolDef.env),
    });
  }

  return { servers, skipped, stationControlDelivered };
}

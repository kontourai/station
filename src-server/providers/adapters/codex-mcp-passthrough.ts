/**
 * Maps authored tool servers to Codex configuration. Public third-party server
 * definitions use spawn overrides; built-in Station credentials travel only in
 * thread/start, thread/resume and thread/fork JSON-RPC configuration over stdin.
 * The external engine retains credential custody; this is never bound assurance.
 */
import type {
  CapabilityUndeliveredReason,
  ResolvedAgentToolServer,
} from '@kontourai/station-contracts/provider';
import { builtinStationApiServerId } from '../../runtime/bootstrap/station-control-runtime-env.js';
import { toPassthroughToolDef } from './agent-tool-server-mapping.js';

export interface CodexToolServerSkip {
  id: string;
  reason: CapabilityUndeliveredReason;
  detail?: string;
}

export type CodexStationMcpAuth = string | { url: string; token: string };

interface ResolveCodexMcpServersResult {
  /** Flattened `-c` flag pairs, ready to append to the `codex app-server`
   * spawn argv (each config override is TWO array entries: `'-c'` then the
   * `key=value` string — spawn's array-argv form, never a shell string, so
   * no shell-injection surface regardless of value content). */
  configArgs: string[];
  /** Private thread configuration. Never append, log or include this in delivery receipts. */
  privateConfig: Record<string, unknown>;
  /** Ids that produced at least one config-override arg above, in the same
   * order `toolServers` was given (for the delivery-channel report). */
  deliveredIds: string[];
  skipped: CodexToolServerSkip[];
}

const SAFE_MCP_SERVER_ID = /^[a-zA-Z0-9_-]+$/;

/** TOML basic-string escaping for a `-c key="value"` argument (backslash and
 * double-quote only — codex-cli 0.145.0's `-c` parser accepts a bare dotted
 * key path plus a TOML-syntax value; confirmed live that this covers a
 * URL's query string, an absolute path, and a JSON-syntax string array
 * value without any parse ambiguity). */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

export function resolveCodexMcpServers(
  toolServers: ResolvedAgentToolServer[],
  stationControlMcpUrl?: CodexStationMcpAuth,
  stationKnowledgeMcpUrl?: CodexStationMcpAuth,
  oauthProxyUrls: ReadonlyMap<string, string> = new Map(),
): ResolveCodexMcpServersResult {
  const configArgs: string[] = [];
  const privateConfig: Record<string, unknown> = {};
  const deliveredIds: string[] = [];
  const skipped: CodexToolServerSkip[] = [];

  for (const server of toolServers) {
    if (!SAFE_MCP_SERVER_ID.test(server.id)) {
      skipped.push({
        id: server.id,
        reason: 'delivery-failed',
        detail: 'tool-server id is not a safe codex mcp_servers key',
      });
      continue;
    }

    const toolDef = toPassthroughToolDef(server);
    const keyPrefix = `mcp_servers.${server.id}`;
    const selectionArgs =
      server.allowedTools === undefined
        ? []
        : [
            '-c',
            `${keyPrefix}.enabled_tools=${tomlStringArray(server.allowedTools)}`,
          ];
    if (server.disabledTools?.length)
      selectionArgs.push(
        '-c',
        `${keyPrefix}.disabled_tools=${tomlStringArray(server.disabledTools)}`,
      );

    const builtin = builtinStationApiServerId(server.id, toolDef);
    if (builtin) {
      const url =
        builtin === 'station-knowledge'
          ? stationKnowledgeMcpUrl
          : stationControlMcpUrl;
      if (!url) {
        skipped.push({
          id: server.id,
          reason: 'delivery-failed',
          detail: `${builtin} MCP auth was not available for this session`,
        });
        continue;
      }
      if (typeof url === 'string') {
        privateConfig[`${keyPrefix}.url`] = url;
      } else {
        privateConfig[`${keyPrefix}.url`] = url.url;
        privateConfig[`${keyPrefix}.http_headers`] = {
          Authorization: `Bearer ${url.token}`,
        };
      }
      configArgs.push(...selectionArgs);
      deliveredIds.push(server.id);
      continue;
    }

    if (toolDef.transport === 'stdio') {
      if (!toolDef.command) {
        skipped.push({ id: server.id, reason: 'binary-not-found' });
        continue;
      }
      configArgs.push(
        '-c',
        `${keyPrefix}.command=${tomlString(toolDef.command)}`,
      );
      if (toolDef.args && toolDef.args.length > 0) {
        configArgs.push(
          '-c',
          `${keyPrefix}.args=${tomlStringArray(toolDef.args)}`,
        );
      }
      configArgs.push(...selectionArgs);
      deliveredIds.push(server.id);
      continue;
    }

    if (
      toolDef.transport === 'sse' ||
      toolDef.transport === 'streamable-http'
    ) {
      if (!toolDef.endpoint) {
        skipped.push({
          id: server.id,
          reason: 'delivery-failed',
          detail: 'no endpoint configured',
        });
        continue;
      }
      configArgs.push(
        '-c',
        `${keyPrefix}.url=${tomlString(oauthProxyUrls.get(server.id) ?? toolDef.endpoint)}`,
      );
      configArgs.push(...selectionArgs);
      deliveredIds.push(server.id);
      continue;
    }

    // Missing or externally supplied non-canonical values fail closed.
    skipped.push({
      id: server.id,
      reason: 'unsupported-transport',
      detail: toolDef.transport,
    });
  }

  return {
    configArgs,
    privateConfig,
    deliveredIds,
    skipped,
  };
}

import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import type { ProviderSessionStartInput } from '../adapter-shape.js';
import { toPassthroughToolDef } from './agent-tool-server-mapping.js';

type LaunchAgent = ProviderSessionStartInput['agent'];
type ResolveToolServer = (id: string) => Promise<ToolDef | null>;

/**
 * The tool server ids an ACP-family launch (the ACP adapter and OpenCode's
 * native MCP) requests. An authored `toolServers` list, an authored empty
 * one included, wins over the connection's `provideToolServers`
 * (archive#895, authored-field-wins); `toolServerMode: 'add'` keeps the
 * connection's servers beside the authored ones.
 */
export function acpLaunchToolServerIds(
  agent: LaunchAgent,
  config: Pick<ACPConnectionConfig, 'provideToolServers'>,
): string[] | undefined {
  const authored = agent?.toolServers;
  if (authored === undefined) return config.provideToolServers;
  return [
    ...new Set([
      ...(agent?.toolServerMode === 'add'
        ? (config.provideToolServers ?? [])
        : []),
      ...authored.map((server) => server.id),
    ]),
  ];
}

/**
 * How an ACP-family launch reads one requested id: an authored server from
 * the resolved Agent definition, otherwise (no authored list, or `add` mode)
 * the integration itself through `resolveToolServer`.
 */
export function acpLaunchToolServerResolver(
  agent: LaunchAgent,
  resolveToolServer: ResolveToolServer | undefined,
): ResolveToolServer {
  const authored = agent?.toolServers;
  if (authored === undefined) return resolveToolServer ?? (async () => null);
  return async (id) => {
    const match = authored.find((server) => server.id === id);
    if (match) return toPassthroughToolDef(match);
    return agent?.toolServerMode === 'add'
      ? ((await resolveToolServer?.(id)) ?? null)
      : null;
  };
}

/**
 * Every tool server definition an ACP-family launch reads, by id, `null`
 * for one that does not resolve. Station fingerprints this to tell whether a
 * running session's connection-provided servers changed under it.
 */
export async function acpLaunchToolServerDefinitions(
  agent: LaunchAgent,
  config: Pick<ACPConnectionConfig, 'provideToolServers'>,
  resolveToolServer: ResolveToolServer | undefined,
): Promise<Array<{ id: string; definition: ToolDef | null }>> {
  const resolve = acpLaunchToolServerResolver(agent, resolveToolServer);
  return Promise.all(
    (acpLaunchToolServerIds(agent, config) ?? []).map(async (id) => ({
      id,
      definition: await resolve(id),
    })),
  );
}

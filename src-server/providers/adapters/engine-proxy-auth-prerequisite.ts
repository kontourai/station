import type { Prerequisite } from '@kontourai/station-contracts/tool';

/**
 * How a CLI runtime's authentication cell reads when the connection does NOT
 * authenticate with the CLI's own login but with the KEY of a selected model
 * connection (`agentConnections.<engine>.config.proxyConnectionId`).
 *
 * This is the ONE derivation of that fact, and it belongs here — in the
 * adapter layer — because the route is resolved at the LAUNCH seam
 * (`engineProxyLaunch` in `services/connections/engine-proxy-routing.ts`,
 * reached through each adapter's `getConnectionLaunch`): for a proxy-routed
 * connection the spawn carries the proxy key as `STATION_ENGINE_PROXY_KEY`
 * (Codex) or `ANTHROPIC_AUTH_TOKEN` (Claude) and the CLI's own login is never
 * consulted.
 *
 * It used to be derived TWICE. `connection-service`'s runtime inventory
 * rewrote the auth cell of `claude-auth`/`codex-auth` from the same route,
 * while `orchestration-service.assertAdapterReady` asked the ADAPTER directly
 * — so on 2026-10-22 one connection was simultaneously `status: "ready"` (the
 * inventory's rewrite), `readinessState: "unavailable_prerequisites"` (the
 * adapter's `codex login status` probe) and unlaunchable ("codex prerequisites
 * missing: Codex login"), all in one payload. The engine ran fine: `codex
 * exec` over the same proxy answered with no login at all. One fact, one
 * derivation — the adapter that owns the launch.
 */

/** The name the auth cell takes when its basis is the proxy route's key. */
export const ENGINE_PROXY_AUTH_PREREQUISITE_NAME = 'Proxy key';

/**
 * The prerequisite id `buildCliRuntimePrerequisites` mints for `command`'s
 * authentication cell. Named here so the substitution below and the builder
 * cannot drift apart on the string.
 */
export function cliAuthPrerequisiteId(command: string): string {
  return `${command}-auth`;
}

/**
 * Rewrite `prerequisites`' auth cell so it reports the route's key as the
 * basis, or return them untouched when this connection has no route.
 *
 * The description deliberately claims no more than a saved key: the route
 * resolves an enabled OpenAI-compatible model connection and a non-empty key
 * (`resolveEngineProxy`), which is why the cell is `installed` rather than
 * `missing` — but whether the proxy actually answers is the smoke's question,
 * not this read's.
 */
export function applyEngineProxyAuthPrerequisite(
  prerequisites: Prerequisite[],
  command: string,
  routeLabel: string | undefined,
): Prerequisite[] {
  if (!routeLabel) return prerequisites;
  const id = cliAuthPrerequisiteId(command);
  return prerequisites.map((item) =>
    item.id === id
      ? {
          ...item,
          name: ENGINE_PROXY_AUTH_PREREQUISITE_NAME,
          status: 'installed' as const,
          description: `A key is saved for ${routeLabel}. Check the connection to verify an answer.`,
        }
      : item,
  );
}

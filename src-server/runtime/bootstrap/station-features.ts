/**
 * archive#980 fix (HIGH, independent review): `STATION_FEATURES` parsing,
 * shared so `runtime-initialize.ts`'s one-time boot computation and
 * `station-runtime.ts`'s live `getManagedChatOrchestrationEnabled` getter
 * agree on the same check. The getter reads `process.env` directly through
 * this helper rather than `this.appConfig.managedChatOrchestration` —
 * `this.appConfig` is wholesale reassigned from a fresh disk load (which
 * never carries this non-persisted field) on every
 * `reloadAgentsFromDisk()`/`reloadDefaultAgent()` call, which
 * `applyAgentConfigurationMutation` runs on every agent/connection/app-config
 * save. Reading `this.appConfig.managedChatOrchestration` would silently
 * revert the flag to `false` after the first unrelated config mutation —
 * the same trap `getMcpUiFrameOrigin` (`() => this.mcpUiFrameServer?.origin`)
 * already avoids by not routing through `appConfig` either.
 */
export function parseStationFeatures(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return (env.STATION_FEATURES || '').split(',').filter(Boolean);
}

export function isManagedChatOrchestrationFeatureEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseStationFeatures(env).includes('managed-chat-orchestration');
}

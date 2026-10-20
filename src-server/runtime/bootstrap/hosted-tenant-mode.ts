/** Pure deployment-mode detection; safe before telemetry provider registration. */
export const HOSTED_TENANT_REGISTRY_FILE_ENV =
  'STATION_HOSTED_TENANT_REGISTRY_FILE';

export function isHostedTenantExecutionRequired(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment[HOSTED_TENANT_REGISTRY_FILE_ENV] !== undefined;
}

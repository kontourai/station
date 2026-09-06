const PRIVATE_TENANT_PREFIX = 'personal-controller:';
const HOME_REF_PREFIX = 'paired:';

export function personalControllerTenantId(
  controllerEnvironmentId: string,
): string {
  return `${PRIVATE_TENANT_PREFIX}${controllerEnvironmentId}`;
}

export function pairedHomeRef(deviceId: string): string {
  return `${HOME_REF_PREFIX}${deviceId}`;
}

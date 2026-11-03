/**
 * A paired-device grant that may drive work but holds no host shell
 * (`terminal:operate`), so it never has owner-device standing
 * (`DevicePairingService.credentialHasOwnerStanding`). Tests use it for "an
 * ordinary paired device": a Standard grant the owner pairs carries a shell
 * and acts as the owner.
 */
export const DEVICE_WITHOUT_HOST_SHELL =
  'orchestration:read orchestration:operate';

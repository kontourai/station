/**
 * The complete PlatformProfileContext contract used by credential-recovery
 * suites. Keep this a strict Pick so a production export added to this seam
 * is supplied once here, rather than failing independently in every case.
 */
type CredentialRecoveryPlatformProfileContext = Pick<
  typeof import('../../../platform/PlatformProfileContext'),
  | 'nativeProfileBootstrapRecoveryError'
  | 'nativeProfileRepository'
  | 'useNativeProfileSelection'
  | 'useNativeProfileStoreEpoch'
  | 'usePlatformProfile'
>;

const nativeProfileRepository = (): ReturnType<
  CredentialRecoveryPlatformProfileContext['nativeProfileRepository']
> =>
  // NativeStationProfileStorage is a concrete class with private state. These
  // browser-only tests exercise only this public no-op subset of the adapter.
  ({
    get: () => null,
    set: () => {},
    remove: () => {},
    commitVerifiedPairing: async () => {},
    makeDefault: async () => {},
    authorizeActiveConnection: async () => false,
    pendingLocalSelfProvisionProfileName: () => undefined,
    refresh: async () => false,
  }) as unknown as ReturnType<
    CredentialRecoveryPlatformProfileContext['nativeProfileRepository']
  >;

export const credentialRecoveryPlatformProfileContext = {
  nativeProfileBootstrapRecoveryError: () => undefined,
  nativeProfileRepository,
  useNativeProfileSelection: () => async () => {},
  useNativeProfileStoreEpoch: () => 0,
  usePlatformProfile: () => ({
    isTauri: false,
    target: 'web',
    isMobile: false,
    isDesktop: false,
    supervisesBundledServer: false,
    isDevBuild: false,
  }),
} satisfies CredentialRecoveryPlatformProfileContext;

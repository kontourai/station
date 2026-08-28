// Core (framework-agnostic)

export {
  bindHostTunnelAccess,
  createDirectHttpAccessMethod,
  createHostTunnelAccessMethod,
  requiresHostAdapter,
} from './core/accessMethods';

export type {
  ConnectionHealthCheckResult,
  ConnectionHealthCoordinatorOptions,
  ConnectionHealthSnapshot,
} from './core/ConnectionHealthCoordinator';
export { ConnectionHealthCoordinator } from './core/ConnectionHealthCoordinator';
export { ConnectionStore } from './core/ConnectionStore';
export type {
  ConnectionAttemptResult,
  ConnectionSupervisorOptions,
  ConnectionSupervisorSignal,
  ConnectionSupervisorSnapshot,
  ConnectionSupervisorState,
  ConnectionSupervisorTelemetryEvent,
  FailureClassification,
  SyncStatus,
} from './core/ConnectionSupervisor';
export { ConnectionSupervisor } from './core/ConnectionSupervisor';
export type {
  ConnectionCandidateDiscoveryResult,
  ConnectionCandidateProviderResult,
  ConnectionCandidateProviderStatus,
} from './core/connectionCandidates';
export {
  connectionCandidateProviderCount,
  discoverConnectionCandidates,
  registerConnectionCandidateProvider,
} from './core/connectionCandidates';
export {
  classifyConnectionFailure,
  classifyHttpFailureResponse,
  classifyNativeTransportRefusal,
  connectionFailureNeedsDecision,
} from './core/connectionFailureClassification';
export type { ConnectionIndicatorState } from './core/connectionIndicator';
export {
  connectionIndicatorActionLabel,
  connectionIndicatorLabel,
  connectionIndicatorState,
} from './core/connectionIndicator';
export type {
  NativePairingExchangeTransport,
  PendingPairingApproval,
  PendingPairingExchange,
} from './core/devicePairing';
export {
  clearPendingExchange,
  decodeDevicePairingPayload,
  encodeDevicePairingPayload,
  exchangeDevicePairing,
  isTransportFailure,
  loadPendingExchange,
  observePendingPairingApproval,
  requestCurrentStationAccess,
  requestDevicePairing,
  setNativePairingExchangeTransport,
} from './core/devicePairing';
export type {
  EndpointCompatibility,
  EndpointCompatibilityContext,
} from './core/environmentProfiles';
export {
  classifyEndpoint,
  connectionFailureCopy,
  createAccessEndpoint,
  endpointId,
  FAILURE_COPY_REASONS,
  inferEndpointKind,
  rankCompatibleEndpoints,
  selectCompatibleEndpoint,
} from './core/environmentProfiles';
export { HEALTH_PROBE_TIMEOUT_MS } from './core/healthProbe';
export {
  isCleartextNonLoopback,
  normalizeHostInput,
} from './core/hostInput';
export type {
  AttemptLocalSelfProvisionDeps,
  LocalSelfProvisionAttempt,
} from './core/localSelfProvision';
export {
  attemptLocalSelfProvision,
  attemptLocalSelfProvisionOnce,
  attemptLocalSelfProvisionOnceWithOutcome,
  attemptLocalSelfProvisionWithOutcome,
  retryLocalSelfProvisionAfterRejection,
} from './core/localSelfProvision';
export type {
  PairingDeepLinkChannel,
  PairingDeepLinkParseResult,
} from './core/pairingDeepLink';
export {
  encodePairingDeepLink,
  PAIRING_DEEP_LINK_VERSION,
  PAIRING_LINK_REMEDY,
  pairingDeepLinkScheme,
  parsePairingDeepLink,
} from './core/pairingDeepLink';
export type {
  CompletePaired,
  CompletePendingPairingOptions,
  PendingPairingCompletion,
  PendingPairingExchangeResult,
  PendingPairingProgress,
} from './core/pendingPairingCompletion';
export type { CompletePendingPairing } from './core/pendingPairingCompletionLoader';
export { completePendingPairing } from './core/pendingPairingCompletionLoader';
// KnownEnvironmentRegistry (station#1096 R2) is intentionally NOT re-exported
// from this bare entry point — only from the dedicated
// `@kontourai/station-connect/known-environment` subpath. This entry is
// reachable from the app's eager root bundle (`ApiBaseContext` →
// `ConnectionsProvider`/`useConnections`); the registry is only used from
// the Connections hub's lazily-loaded route chunk, and re-exporting it here
// too pulled its code into the eager bundle and broke the UI bundle budget
// (`npm run ui-bundle:budget`) even though nothing in the eager path ever
// referenced it. See `./core/knownEnvironmentRegistry.ts` for the module.
export {
  type CredentialVaultBackend,
  defaultCredentialStorage,
  defaultStorage,
  HydratedCredentialStorage,
  LocalStorageAdapter,
  RejectingCredentialStorage,
  SessionStorageAdapter,
} from './core/storage';
export type {
  AccessEndpoint,
  AccessEndpointKind,
  ConnectionCandidate,
  ConnectionCandidateProvider,
  ConnectionCandidateProviderContext,
  ConnectionCandidateSource,
  ConnectionCredentialProvider,
  ConnectionFailure,
  ConnectionFailureReason,
  ConnectionStatus,
  CredentialRef,
  DirectHttpAccessMethod,
  DiscoveredServer,
  EnvironmentAccessMethod,
  EnvironmentCapabilities,
  EnvironmentConnectionState,
  HostTunnelAccessMethod,
  InjectedConnection,
  InjectedConnectionStatus,
  ResolvedHostTunnelAccess,
  SavedConnection,
  StationHandshakeIdentity,
  StorageAdapter,
} from './core/types';
export type { ConnectionManagerModalProps } from './react/ConnectionManagerModal';
export { ConnectionManagerModal } from './react/ConnectionManagerModal';
export type { ConnectionStatusDotProps } from './react/ConnectionStatusDot';
export { ConnectionStatusDot } from './react/ConnectionStatusDot';
export type { RequestCredentialEvidence } from './react/ConnectionsContext';
// React
export {
  ConnectionsProvider,
  DEFAULT_CONNECTION_CREDENTIAL_KEY,
  useConnections,
} from './react/ConnectionsContext';
export type { PairingResult } from './react/DevicePairingPanel';
export { JoinDevicePairingPanel } from './react/DevicePairingPanel';
export { HttpsPreferenceHint } from './react/HttpsPreferenceHint';
export type {
  PairingCompletionDeps,
  PairingCompletionTarget,
} from './react/pairingCompletion';
export { completeVerifiedPairing } from './react/pairingCompletion';
export type { QRDisplayProps } from './react/QRDisplay';
export { QRDisplay } from './react/QRDisplay';
export type { QRScannerProps } from './react/QRScanner';
export { QRScanner } from './react/QRScanner';
export {
  type RequestAuthorityScope,
  type RequestAuthorityScopeOptions,
  requestAuthorityScopeFromCredentialEvidence,
} from './react/request-authority';
export type { UseConnectionCandidatesResult } from './react/useConnectionCandidates';
export { useConnectionCandidates } from './react/useConnectionCandidates';
export type {
  ConnectionStatusResult,
  UseConnectionStatusOptions,
} from './react/useConnectionStatus';
export { useConnectionStatus } from './react/useConnectionStatus';
export type { UseHostUrlOptions, UseHostUrlResult } from './react/useHostUrl';
export { useHostUrl } from './react/useHostUrl';
export type {
  UseNetworkDiscoveryOptions,
  UseNetworkDiscoveryResult,
} from './react/useNetworkDiscovery';
export { useNetworkDiscovery } from './react/useNetworkDiscovery';
export { usePendingPairingApproval } from './react/usePendingPairingApproval';

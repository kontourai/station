//! Host-owned native broker invitation redemption and v2 grant custody.
//!
//! Main-window commands accept only a profile name, expected revision, and
//! invitation. The authority provider reloads the owner-only profile and its
//! independently approved Station signing key; neither trust nor keyring
//! identity comes from the renderer. A secret-free keyring index quarantines
//! grants awaiting broker retirement and supports restart-safe cleanup. This
//! module does not register an active signaling or application-data consumer.

use crate::native_relay_proof_key::{
    NativeBrokerRedemptionChallenge, NativeBrokerRedemptionInvitation, NativeBrokerRequestBody,
    NativeBrokerRequestIdentity, NativeBrokerRequestProofChallenge,
    NativeInvitationObservationChallenge, NativeProofKeyChannel, NativeProofKeyOwner,
    NativeProofKeyPublicMetadata, NativeRelayProofKeyVault, NativeSupersededScopeObservation,
    P256PublicJwk, ProofKeyError, SUPERSEDED_SCOPE_OBSERVE_PATH,
};
use crate::native_station_key_custody::{
    CandidateError, LockedTrustProfileSnapshot, NativeStationTrustStore,
    StationTrustApprovedDescriptor, TrustProfileBinding,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ring::digest::{digest, SHA256};
use ring::hmac;
#[cfg(test)]
use ring::signature;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::collections::HashMap;
use std::collections::HashSet;
use std::io::Read;
#[cfg(test)]
use std::io::Write;
#[cfg(test)]
use std::net::TcpListener;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(test)]
use std::sync::Arc;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::AppHandle;
use tauri::Manager;
use zeroize::Zeroizing;

const REDEEM_PATH: &str = "/broker/v1/native/grants/redeem";
const OPEN_PATH: &str = "/broker/v1/native/connections/open";
const READ_PATH: &str = "/broker/v1/native/connections/read";
const RETIRE_PATH: &str = "/broker/v1/native/grants/retire";
const RENEW_PATH: &str = "/broker/v1/native/grants/renew";
const ICE_CONFIGURATION_PATH: &str = "/broker/v1/native/ice/configuration";
const NATIVE_INVITATION_VERSION: &str = "station-broker-native-route-invitation/v2";
const NATIVE_GRANT_VERSION: &str = "station-broker-native-client-grant/v2";
const NATIVE_RETIRE_VERSION: &str = "station-broker-native-grant-retire/v2";
const NATIVE_RENEW_VERSION: &str = "station-broker-native-grant-renew/v2";
const NATIVE_RENEWED_VERSION: &str = "station-broker-native-grant-renewed/v2";
const NATIVE_DEVICE_SELF_RECEIPT_ERROR_VERSION: &str =
    "station-native-device-proof-self-receipt-error/v1";
static NATIVE_DEVICE_RECEIPT_OPERATION: Mutex<()> = Mutex::new(());

fn try_native_device_receipt_operation() -> Result<MutexGuard<'static, ()>, String> {
    NATIVE_DEVICE_RECEIPT_OPERATION
        .try_lock()
        .map_err(|error| match error {
            std::sync::TryLockError::WouldBlock => {
                "Station is already checking a Device binding receipt".to_owned()
            }
            std::sync::TryLockError::Poisoned(_) => {
                "Station Device receipt reconciliation is unavailable".to_owned()
            }
        })
}
const MAX_GRANT_AGE_MS: u64 = 24 * 60 * 60 * 1000;
const NATIVE_GRANT_RENEWAL_GRACE_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const NATIVE_GRANT_RENEWAL_EARLY_WINDOW_MS: u64 = 12 * 60 * 60 * 1000;
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_NATIVE_SIGNAL_SDP_BYTES: usize = 128 * 1024;
const MAX_NATIVE_SIGNAL_PROOF_BYTES: usize = 4096;
const NATIVE_BROKER_SIGNAL_OFFER_LIFETIME_MS: u64 = 30 * 1000;
// The proof may be 30 seconds old and the broker's clock can therefore place
// a 30-second offer as far as 60 seconds ahead of this host's current time.
// Keep one second for integer-second proof timestamps and millisecond expiry.
const MAX_NATIVE_SIGNAL_RESPONSE_HORIZON_MS: u64 = 61 * 1000;
// The broker accepts request proofs up to 30 seconds old. Include that
// maximum client clock lag, the fixed 15-second transport timeout, and a
// one-second rounding margin so its 30-second offer cannot outlive the grant.
const NATIVE_SIGNAL_BROKER_PROOF_CLOCK_LAG_MS: u64 = 30 * 1000;
const MIN_NATIVE_SIGNAL_OPEN_GRANT_LIFETIME_MS: u64 = NATIVE_BROKER_SIGNAL_OFFER_LIFETIME_MS
    + (BROKER_REQUEST_TIMEOUT.as_secs() * 1000)
    + NATIVE_SIGNAL_BROKER_PROOF_CLOCK_LAG_MS
    + 1000;
const MAX_GRANT_INDEX_ENTRIES: usize = 10_000;
const MAX_BACKGROUND_CLEANUP_RETRIES: usize = 8;
const GRANT_ACCOUNT_PREFIX: &str = "relay-native-client-grant:v2:";
const GRANT_INDEX_PREFIX: &str = "relay-native-client-grant:index:v2:";
const GRANT_CLEANUP_RECORD_PREFIX: &str = "relay-native-client-grant:cleanup:v2:";
const GRANT_CLEANUP_INDEX_PREFIX: &str = "relay-native-client-grant:cleanup-index:v2:";
const GRANT_CLEANUP_OWNER_INDEX_PREFIX: &str = "relay-native-client-grant:cleanup-owners:v1:";
const BROKER_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const JS_SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;
static NATIVE_GRANT_VAULT_LOCK: Mutex<()> = Mutex::new(());
/// Serializes invite redemption with every explicit revocation. Redemption
/// holds this guard from its initial profile/trust check through grant
/// publication or compensation, so a revoke cannot return ahead of an
/// in-flight grant commit.
static NATIVE_RELAY_ROUTE_OPERATION_LOCK: Mutex<()> = Mutex::new(());

fn native_relay_route_operation_guard() -> RedemptionResult<MutexGuard<'static, ()>> {
    NATIVE_RELAY_ROUTE_OPERATION_LOCK
        .lock()
        .map_err(|_| NativeRedemptionError::GrantStore)
}

/// Serialize a native relay route revocation with any in-flight grant
/// redemption. Callers must stage the durable route quarantine while holding
/// this guard and before reporting revocation complete.
pub(crate) fn with_native_relay_route_operation_lock<T>(
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _guard = native_relay_route_operation_guard()
        .map_err(|_| "Station native relay state is unavailable.".to_owned())?;
    operation()
}

pub(crate) type RedemptionResult<T> = Result<T, NativeRedemptionError>;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NativeRedemptionError {
    InvalidProfile,
    StaleProfile,
    StationTrustRequired,
    InvitationInvalid,
    InvitationExpired,
    StationTrustUnavailable,
    ProofKey,
    ProofKeyMissing,
    BrokerTransport,
    BrokerRejected,
    GrantInvalid,
    GrantStore,
    GrantMissing,
    GrantExists,
    GrantExpired,
    GrantRenewalConflict,
    GrantRenewalNotDue,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NativeGrantStoreWriteDisposition {
    NotWritten,
    MayHaveWritten,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NativeGrantStoreFailure {
    pub(crate) primary: NativeRedemptionError,
    pub(crate) write_disposition: NativeGrantStoreWriteDisposition,
    pub(crate) cleanup_id: Option<String>,
}

impl From<NativeRedemptionError> for NativeGrantStoreFailure {
    fn from(primary: NativeRedemptionError) -> Self {
        Self {
            primary,
            write_disposition: NativeGrantStoreWriteDisposition::NotWritten,
            cleanup_id: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NativeGrantCleanupDisposition {
    NotAttempted,
    Complete,
    Pending {
        local_revoke_failed: bool,
        broker_retire_failed: bool,
        custody_failed: bool,
    },
}

impl Serialize for NativeGrantCleanupDisposition {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeMap;
        match self {
            Self::NotAttempted => serializer.serialize_str("notAttempted"),
            Self::Complete => serializer.serialize_str("complete"),
            Self::Pending {
                local_revoke_failed,
                broker_retire_failed,
                custody_failed,
            } => {
                let mut value = serializer.serialize_map(Some(4))?;
                value.serialize_entry("status", "pending")?;
                value.serialize_entry("localRevokeFailed", local_revoke_failed)?;
                value.serialize_entry("brokerRetireFailed", broker_retire_failed)?;
                value.serialize_entry("custodyFailed", custody_failed)?;
                value.end()
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeGrantRecoveryInfo {
    pub(crate) broker_origin: String,
    pub(crate) station_id: String,
    pub(crate) enrollment_id: String,
    pub(crate) routing_generation: u64,
    pub(crate) grant_id: String,
    pub(crate) cleanup_id: Option<String>,
    pub(crate) cleanup_error: Option<NativeRedemptionError>,
    pub(crate) credential_status: NativeGrantRecoveryCredentialStatus,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NativeGrantRecoveryCredentialStatus {
    NotStored,
    RetainedOrUnknown,
    DurablePending,
}

/// Secret-free diagnostic returned to the main renderer after redemption
/// fails. In particular, this carries the exact broker route and grant ID
/// needed for recovery without exposing the invitation or grant credential.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeRedemptionFailure {
    pub(crate) primary: NativeRedemptionError,
    pub(crate) cleanup: NativeGrantCleanupDisposition,
    pub(crate) recovery: Option<NativeGrantRecoveryInfo>,
}

struct NativeGrantCleanupAttemptFailure {
    error: NativeRedemptionError,
    local_revoke_failed: bool,
    broker_retire_failed: bool,
    custody_failed: bool,
}

impl NativeGrantCleanupAttemptFailure {
    fn broker(error: NativeRedemptionError) -> Self {
        Self {
            error,
            local_revoke_failed: false,
            broker_retire_failed: true,
            custody_failed: false,
        }
    }

    fn local(error: NativeRedemptionError) -> Self {
        Self {
            error,
            local_revoke_failed: true,
            broker_retire_failed: false,
            custody_failed: false,
        }
    }

    fn custody(error: NativeRedemptionError) -> Self {
        Self {
            error,
            local_revoke_failed: false,
            broker_retire_failed: false,
            custody_failed: true,
        }
    }
}

impl From<NativeRedemptionError> for NativeRedemptionFailure {
    fn from(primary: NativeRedemptionError) -> Self {
        Self {
            primary,
            cleanup: NativeGrantCleanupDisposition::NotAttempted,
            recovery: None,
        }
    }
}

impl PartialEq<NativeRedemptionError> for NativeRedemptionFailure {
    fn eq(&self, other: &NativeRedemptionError) -> bool {
        self.primary == *other
    }
}

/// A snapshot reconstructed by a native owner of `profiles.json`; none of its
/// owner fields are accepted from a renderer command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NativeRelayProfileSnapshot {
    pub(crate) revision: u64,
    pub(crate) profile_name: String,
    pub(crate) station_endpoint: String,
    pub(crate) broker_origin: String,
    pub(crate) station_id: String,
    pub(crate) enrollment_id: String,
    pub(crate) app_identifier: String,
    pub(crate) channel: NativeProofKeyChannel,
    pub(crate) client_instance_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum NativeStationTrustStatus {
    Approved,
    Revoked,
}

/// Mirrors the browser-approved connection-key contract at the native seam.
/// A production provider must read this from host-owned approval state and
/// re-read its revision during `with_current_context`. It must have imported
/// the key as a P-256 verification key before marking it approved; shape and
/// thumbprint checks alone do not validate an EC point.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ApprovedNativeStationTrust {
    pub(crate) revision: u64,
    pub(crate) status: NativeStationTrustStatus,
    pub(crate) station_endpoint: String,
    pub(crate) station_id: String,
    pub(crate) enrollment_id: String,
    pub(crate) generation: u64,
    pub(crate) signing_key: P256PublicJwk,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NativeRedemptionContext {
    pub(crate) profile: NativeRelayProfileSnapshot,
    pub(crate) station_trust: ApprovedNativeStationTrust,
}

/// `with_current_context` must hold the same profile lock used by the native
/// profile writer through the callback. It must reload both profile revision
/// and approved Station trust while locked.
pub(crate) trait NativeRedemptionContextProvider: Send + Sync {
    fn with_current_context<T>(
        &self,
        profile_name: &str,
        operation: impl FnOnce(NativeRedemptionContext) -> RedemptionResult<T>,
    ) -> RedemptionResult<T>;
}

/// Production authority is reconstructed from the current owner-only saved
/// profile and the OS-keyring approval record. The profile lock remains held
/// through `operation`; only a validated public P-256 descriptor crosses the
/// trust-store seam.
pub(crate) struct AppNativeRedemptionContextProvider {
    app: AppHandle,
    existing_route: bool,
}

fn with_locked_saved_relay_profile<T>(
    app: &AppHandle,
    profile_name: &str,
    operation: impl FnOnce(
        NativeRelayProfileSnapshot,
        LockedTrustProfileSnapshot,
    ) -> RedemptionResult<T>,
) -> RedemptionResult<T> {
    with_locked_saved_relay_profile_store(
        app,
        profile_name,
        |profile, locked_snapshot, _store, _path| operation(profile, locked_snapshot),
    )
}

fn with_locked_saved_relay_profile_store<T>(
    app: &AppHandle,
    profile_name: &str,
    operation: impl FnOnce(
        NativeRelayProfileSnapshot,
        LockedTrustProfileSnapshot,
        &super::CredentialProfileStore,
        &std::path::Path,
    ) -> RedemptionResult<T>,
) -> RedemptionResult<T> {
    with_locked_saved_enrollment_profile_store(app, profile_name, None, false, operation)
}

fn with_locked_saved_enrollment_profile_store<T>(
    app: &AppHandle,
    profile_name: &str,
    enrollment_reference: Option<&super::NativeCredentialReference>,
    allow_published_profile: bool,
    operation: impl FnOnce(
        NativeRelayProfileSnapshot,
        LockedTrustProfileSnapshot,
        &super::CredentialProfileStore,
        &std::path::Path,
    ) -> RedemptionResult<T>,
) -> RedemptionResult<T> {
    let path =
        super::station_profiles_path(app).map_err(|_| NativeRedemptionError::StaleProfile)?;
    let _profile_lock = super::lock_station_profiles_for_app(app, &path)
        .map_err(|_| NativeRedemptionError::StaleProfile)?;
    let contents = super::read_station_profile_store(&path)
        .map_err(|_| NativeRedemptionError::StaleProfile)?;
    let store = super::parse_station_profile_store(&contents)
        .map_err(|_| NativeRedemptionError::StaleProfile)?;
    let app_identifier = app.config().identifier.clone();
    let channel_name = super::native_app_channel(&app_identifier, cfg!(debug_assertions));
    let channel = match channel_name {
        "stable" => NativeProofKeyChannel::Stable,
        "beta" => NativeProofKeyChannel::Beta,
        "nightly" => NativeProofKeyChannel::Nightly,
        "dev" => NativeProofKeyChannel::Dev,
        _ => return Err(NativeRedemptionError::InvalidProfile),
    };
    let published_reference = if allow_published_profile {
        store
            .profiles
            .iter()
            .find(|profile| profile.name.eq_ignore_ascii_case(profile_name))
            .and_then(|profile| profile.credential_ref.as_ref())
    } else {
        None
    };
    let profile = snapshot_from_owned_enrollment_profile(
        &store,
        profile_name,
        &app_identifier,
        channel,
        enrollment_reference.or(published_reference),
    )?;
    let binding = TrustProfileBinding {
        profile_owner_id: profile.profile_name.clone(),
        app_identifier: profile.app_identifier.clone(),
        channel: profile.channel.keyring_label().to_owned(),
        client_instance_id: profile.client_instance_id.clone(),
        broker_origin: profile.broker_origin.clone(),
        station_id: profile.station_id.clone(),
        enrollment_id: profile.enrollment_id.clone(),
    };
    operation(
        profile.clone(),
        LockedTrustProfileSnapshot {
            binding,
            revision: profile.revision,
        },
        &store,
        &path,
    )
}

impl AppNativeRedemptionContextProvider {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self {
            app,
            existing_route: false,
        }
    }

    // Existing grant custody survives Device publication; it grants no account or Device authority.
    fn for_existing_route(app: AppHandle) -> Self {
        Self {
            app,
            existing_route: true,
        }
    }
}

impl NativeRedemptionContextProvider for AppNativeRedemptionContextProvider {
    fn with_current_context<T>(
        &self,
        profile_name: &str,
        operation: impl FnOnce(NativeRedemptionContext) -> RedemptionResult<T>,
    ) -> RedemptionResult<T> {
        with_locked_saved_enrollment_profile_store(
            &self.app,
            profile_name,
            None,
            self.existing_route,
            |profile, locked_snapshot, _, _| {
                let mut trust_store = NativeStationTrustStore::system();
                let approved = trust_store
                    .approved_descriptor_for_locked_profile(&locked_snapshot)
                    .map_err(|error| match error {
                        crate::native_station_key_custody::CandidateError::TrustStore => {
                            NativeRedemptionError::StationTrustUnavailable
                        }
                        _ => NativeRedemptionError::StationTrustRequired,
                    })?;
                operation(NativeRedemptionContext {
                    station_trust: approved_station_trust(&profile, approved)?,
                    profile,
                })
            },
        )
    }
}

fn approved_station_trust(
    profile: &NativeRelayProfileSnapshot,
    approved: StationTrustApprovedDescriptor,
) -> RedemptionResult<ApprovedNativeStationTrust> {
    if approved.station_id != profile.station_id
        || approved.enrollment_id != profile.enrollment_id
        || approved.revision == 0
    {
        return Err(NativeRedemptionError::StationTrustRequired);
    }
    Ok(ApprovedNativeStationTrust {
        revision: approved.revision,
        status: NativeStationTrustStatus::Approved,
        station_endpoint: profile.station_endpoint.clone(),
        station_id: approved.station_id,
        enrollment_id: approved.enrollment_id,
        generation: approved.generation,
        signing_key: approved.signing_key,
    })
}

/// Typed invitation from the share surface. Its secret uses zeroizing memory;
/// broker origin and all identity fields are checked against host state before
/// any request is sent.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeRelayInvitationV2 {
    pub(crate) version: String,
    pub(crate) broker_origin: String,
    pub(crate) scope: NativeRelayScopeV2,
    pub(crate) station_signing_key_id: String,
    pub(crate) station_signing_generation: u64,
    pub(crate) surface: NativeRelayClientSurfaceV2,
    pub(crate) invitation_id: String,
    invitation_secret: SecretText,
    pub(crate) expires_at: u64,
}

impl NativeRelayInvitationV2 {
    pub(crate) fn link_secret_valid(&self) -> bool {
        valid_opaque(self.invitation_secret.expose()) && valid_safe_id(&self.invitation_id)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeRelayScopeV2 {
    pub(crate) station_id: String,
    pub(crate) enrollment_id: String,
    pub(crate) routing_generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeRelayClientSurfaceV2 {
    pub(crate) kind: String,
    pub(crate) app_identifier: String,
    pub(crate) channel: String,
    pub(crate) client_instance_id: String,
    pub(crate) key_thumbprint: String,
}

struct SecretText(Zeroizing<String>);

impl SecretText {
    fn expose(&self) -> &str {
        &self.0
    }
}

impl Serialize for SecretText {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.0.as_str())
    }
}

impl<'de> Deserialize<'de> for SecretText {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        String::deserialize(deserializer).map(|value| Self(Zeroizing::new(value)))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeRedemptionProof<'a> {
    public_key: &'a P256PublicJwk,
    nonce: &'a str,
    jws: String,
}

#[derive(Serialize)]
struct NativeRedemptionRequest<'a> {
    invitation: &'a NativeRelayInvitationV2,
    proof: NativeRedemptionProof<'a>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeRelayClientGrantV2 {
    version: String,
    broker_origin: String,
    scope: NativeRelayScopeV2,
    station_signing_key_id: String,
    station_signing_generation: u64,
    surface: NativeRelayClientSurfaceV2,
    proof_public_key: P256PublicJwk,
    credential: NativeRelayCredential,
    expires_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeRelayCredential {
    id: String,
    secret: SecretText,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeGrantRenewalIntent {
    renewal_id: String,
    expected_expires_at: u64,
    request_body: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeGrantRenewalReceipt {
    version: String,
    renewal_id: String,
    expires_at: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeGrantRenewalRequestBody {
    version: String,
    scope: NativeRelayScopeV2,
    surface: NativeRelayClientSurfaceV2,
    renewal_id: String,
    expected_expires_at: u64,
}

pub(crate) struct NativeGrantRequestRecord {
    pub(crate) grant: NativeRelayClientGrantV2,
    renewal_intent: Option<NativeGrantRenewalIntent>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeRelayGrantRoute {
    broker_origin: String,
    station_id: String,
    enrollment_id: String,
    routing_generation: u64,
    grant_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeRelayGrantBinding {
    owner: NativeProofKeyOwner,
    route: NativeRelayGrantRoute,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StoredNativeRelayGrantV2 {
    schema_version: u8,
    binding: NativeRelayGrantBinding,
    grant: NativeRelayClientGrantV2,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    renewal_intent: Option<NativeGrantRenewalIntent>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredNativeRelayGrantV2Ref<'a> {
    schema_version: u8,
    binding: NativeRelayGrantBinding,
    grant: &'a NativeRelayClientGrantV2,
    #[serde(skip_serializing_if = "Option::is_none")]
    renewal_intent: Option<&'a NativeGrantRenewalIntent>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum NativeCleanupRemoteBasis {
    IndividualGrantRetired,
    SupersededGenerationObserved {
        observation: NativeSupersededScopeObservation,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeGrantCleanupIndexEntry {
    pub(crate) cleanup_id: String,
    pub(crate) route: NativeRelayGrantRoute,
    grant_secret_digest: String,
    staged_at: u64,
    record_present: bool,
    broker_retired: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remote_basis: Option<NativeCleanupRemoteBasis>,
    local_cleanup_required: bool,
    local_cleanup_complete: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeGrantCleanupOwnerIndex {
    schema_version: u8,
    owners: Vec<NativeProofKeyOwner>,
}

/// Safe-to-display cleanup status. It deliberately omits the grant-secret
/// digest and owner keyring identity.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeRelayGrantCleanupStatus {
    pub(crate) cleanup_id: String,
    pub(crate) route: NativeRelayGrantRoute,
    pub(crate) staged_at: u64,
    pub(crate) record_present: bool,
    pub(crate) broker_retired: bool,
    pub(crate) local_cleanup_required: bool,
    pub(crate) local_cleanup_complete: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeRelayGrantStatusItem {
    pub(crate) metadata: NativeRelayGrantMetadata,
    pub(crate) expired: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeGrantCleanupIndex {
    schema_version: u8,
    entries: Vec<NativeGrantCleanupIndexEntry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StoredNativeGrantCleanupV2 {
    schema_version: u8,
    cleanup_id: String,
    binding: NativeRelayGrantBinding,
    local_cleanup_required: bool,
    staged_at: u64,
    grant: NativeRelayClientGrantV2,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredNativeGrantCleanupV2Ref<'a> {
    schema_version: u8,
    cleanup_id: &'a str,
    binding: NativeRelayGrantBinding,
    local_cleanup_required: bool,
    staged_at: u64,
    grant: &'a NativeRelayClientGrantV2,
}

pub(crate) struct NativeGrantCleanupPending {
    pub(crate) entry: NativeGrantCleanupIndexEntry,
    pub(crate) grant: NativeRelayClientGrantV2,
    durable_cleanup_record: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeRelayGrantMetadata {
    pub(crate) route: NativeRelayGrantRoute,
    pub(crate) station_signing_key_id: String,
    pub(crate) station_signing_generation: u64,
    pub(crate) expires_at: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeRelayGrantState {
    pub(crate) profile_name: String,
    pub(crate) profile_revision: u64,
    pub(crate) station_id: String,
    pub(crate) enrollment_id: String,
    pub(crate) grants: Vec<NativeRelayGrantStatusItem>,
    pub(crate) cleanups: Vec<NativeRelayGrantCleanupStatus>,
}

impl NativeRelayGrantState {
    pub(crate) fn for_saved_profile(
        profile: &NativeRelayProfileSnapshot,
        grants: Vec<NativeRelayGrantStatusItem>,
        cleanups: Vec<NativeRelayGrantCleanupStatus>,
    ) -> Self {
        Self {
            profile_name: profile.profile_name.clone(),
            profile_revision: profile.revision,
            station_id: profile.station_id.clone(),
            enrollment_id: profile.enrollment_id.clone(),
            grants,
            cleanups,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeRelayRecoveryOutcome {
    route: NativeRelayGrantRoute,
    remote_basis: Option<NativeCleanupRemoteBasis>,
    local_cleanup_complete: bool,
    failure: Option<NativeRedemptionError>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeRelayRecoveryResult {
    pub(crate) state: NativeRelayGrantState,
    pub(crate) outcomes: Vec<NativeRelayRecoveryOutcome>,
}

/// Tagged, secret-free response to an invite-redemption command. Domain
/// failures remain structured data so recovery details are not flattened
/// into an opaque Tauri error string.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum NativeRelayGrantRedemptionResult {
    Redeemed { grant: NativeRelayGrantMetadata },
    Failed { failure: NativeRedemptionFailure },
}

pub(crate) trait NativeGrantBackend: Send {
    fn get(&mut self, account: &str) -> RedemptionResult<Option<Zeroizing<String>>>;
    fn set(&mut self, account: &str, value: &str) -> RedemptionResult<()>;
    fn delete(&mut self, account: &str) -> RedemptionResult<()>;
}

pub(crate) trait NativeGrantCustody: Send + Sync {
    fn register_cleanup_owner(&self, owner: &NativeProofKeyOwner) -> RedemptionResult<()>;
    fn metadata_for_context(
        &self,
        owner: &NativeProofKeyOwner,
        context: &NativeRedemptionContext,
        now: u64,
    ) -> RedemptionResult<Vec<NativeRelayGrantStatusItem>>;
    fn stage_context_cleanup(
        &self,
        owner: &NativeProofKeyOwner,
        context: &NativeRedemptionContext,
        now: u64,
    ) -> RedemptionResult<Vec<NativeRelayGrantCleanupStatus>>;
    fn store(
        &self,
        owner: &NativeProofKeyOwner,
        grant: &NativeRelayClientGrantV2,
        now: u64,
    ) -> Result<NativeRelayGrantMetadata, NativeGrantStoreFailure>;
    fn revoke_if_matches(
        &self,
        owner: &NativeProofKeyOwner,
        grant: &NativeRelayClientGrantV2,
    ) -> RedemptionResult<bool>;
    fn stage_cleanup(
        &self,
        owner: &NativeProofKeyOwner,
        grant: &NativeRelayClientGrantV2,
        local_cleanup_required: bool,
        now: u64,
    ) -> RedemptionResult<NativeGrantCleanupIndexEntry>;
    fn load_cleanup(
        &self,
        owner: &NativeProofKeyOwner,
        cleanup_id: &str,
    ) -> RedemptionResult<Option<NativeGrantCleanupPending>>;
    fn pending_cleanups(
        &self,
        owner: &NativeProofKeyOwner,
    ) -> RedemptionResult<Vec<NativeGrantCleanupIndexEntry>>;
    fn mark_broker_retired(
        &self,
        owner: &NativeProofKeyOwner,
        cleanup_id: &str,
    ) -> RedemptionResult<()>;
    fn record_recovery_basis(
        &self,
        owner: &NativeProofKeyOwner,
        cleanup_id: &str,
        grant: &NativeRelayClientGrantV2,
        basis: NativeCleanupRemoteBasis,
    ) -> RedemptionResult<()>;
    fn mark_local_cleanup_complete(
        &self,
        owner: &NativeProofKeyOwner,
        cleanup_id: &str,
    ) -> RedemptionResult<()>;
    fn finish_cleanup(&self, owner: &NativeProofKeyOwner, cleanup_id: &str)
        -> RedemptionResult<()>;
    fn load_request_grant(
        &self,
        owner: &NativeProofKeyOwner,
        context: &NativeRedemptionContext,
        now: u64,
        allow_expired_for_renewal: bool,
    ) -> RedemptionResult<NativeGrantRequestRecord>;
    fn save_renewal_intent(
        &self,
        owner: &NativeProofKeyOwner,
        grant: &NativeRelayClientGrantV2,
        intent: NativeGrantRenewalIntent,
    ) -> RedemptionResult<NativeGrantRenewalIntent>;
    fn complete_renewal(
        &self,
        owner: &NativeProofKeyOwner,
        grant: &NativeRelayClientGrantV2,
        intent: &NativeGrantRenewalIntent,
        receipt: &NativeGrantRenewalReceipt,
        now: u64,
    ) -> RedemptionResult<NativeRelayGrantMetadata>;
}

pub(crate) struct NativeRelayGrantVault<B> {
    backend: Mutex<B>,
}

impl<B: NativeGrantBackend> NativeRelayGrantVault<B> {
    fn new(backend: B) -> Self {
        Self {
            backend: Mutex::new(backend),
        }
    }

    pub(crate) fn registered_cleanup_owners(
        &self,
        app_identifier: &str,
        channel: &str,
    ) -> RedemptionResult<Vec<NativeProofKeyOwner>> {
        let _global = NATIVE_GRANT_VAULT_LOCK
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        Ok(read_native_grant_cleanup_owner_index(&mut *backend, app_identifier, channel)?.owners)
    }

    pub(crate) fn cleanup_statuses_for_channel(
        &self,
        app_identifier: &str,
        channel: &str,
    ) -> RedemptionResult<Vec<NativeRelayGrantCleanupStatus>> {
        let _global = NATIVE_GRANT_VAULT_LOCK
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let owners = read_native_grant_cleanup_owner_index(&mut *backend, app_identifier, channel)?;
        let mut statuses = Vec::new();
        for owner in owners.owners {
            statuses.extend(
                read_native_grant_cleanup_index(&mut *backend, &owner)?
                    .entries
                    .into_iter()
                    .map(cleanup_status),
            );
        }
        Ok(statuses)
    }

    pub(crate) fn register_cleanup_owner(
        &self,
        owner: &NativeProofKeyOwner,
    ) -> RedemptionResult<()> {
        let _global = NATIVE_GRANT_VAULT_LOCK
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        register_cleanup_owner_locked(&mut *backend, owner)
    }

    pub(crate) fn metadata_for_context(
        &self,
        owner: &NativeProofKeyOwner,
        context: &NativeRedemptionContext,
        now: u64,
    ) -> RedemptionResult<Vec<NativeRelayGrantStatusItem>> {
        validate_profile_context(context)?;
        if !profile_matches_owner(&context.profile, owner) {
            return Err(NativeRedemptionError::InvalidProfile);
        }
        self.metadata_for_profile_route(
            owner,
            &context.profile.broker_origin,
            &context.profile.station_id,
            &context.profile.enrollment_id,
            now,
        )
    }

    pub(crate) fn metadata_for_profile_route(
        &self,
        owner: &NativeProofKeyOwner,
        broker_origin: &str,
        station_id: &str,
        enrollment_id: &str,
        now: u64,
    ) -> RedemptionResult<Vec<NativeRelayGrantStatusItem>> {
        let _global = NATIVE_GRANT_VAULT_LOCK
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let cleanup = read_native_grant_cleanup_index(&mut *backend, owner)?;
        let index = read_native_grant_index(&mut *backend, owner)?;
        let mut metadata = Vec::new();
        for entry in index.into_iter().filter(|entry| {
            entry.route.broker_origin == broker_origin
                && entry.route.station_id == station_id
                && entry.route.enrollment_id == enrollment_id
        }) {
            if cleanup.entries.iter().any(|item| item.route == entry.route) {
                continue;
            }
            let binding = NativeRelayGrantBinding {
                owner: owner.clone(),
                route: entry.route,
            };
            let account = native_grant_account(&binding)?;
            let encoded = backend
                .get(&account)?
                .ok_or(NativeRedemptionError::GrantStore)?;
            let stored: StoredNativeRelayGrantV2 =
                serde_json::from_str(&encoded).map_err(|_| NativeRedemptionError::GrantStore)?;
            validate_indexed_grant(owner, &stored, &binding, now)?;
            metadata.push(NativeRelayGrantStatusItem {
                metadata: native_grant_metadata(binding.route, &stored.grant),
                expired: stored.grant.expires_at <= now,
            });
        }
        Ok(metadata)
    }

    pub(crate) fn cleanup_statuses_for_profile_route(
        &self,
        owner: &NativeProofKeyOwner,
        broker_origin: &str,
        station_id: &str,
        enrollment_id: &str,
    ) -> RedemptionResult<Vec<NativeRelayGrantCleanupStatus>> {
        let _global = NATIVE_GRANT_VAULT_LOCK
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        Ok(read_native_grant_cleanup_index(&mut *backend, owner)?
            .entries
            .into_iter()
            .filter(|entry| {
                entry.route.broker_origin == broker_origin
                    && entry.route.station_id == station_id
                    && entry.route.enrollment_id == enrollment_id
            })
            .map(cleanup_status)
            .collect())
    }

    pub(crate) fn stage_context_cleanup(
        &self,
        owner: &NativeProofKeyOwner,
        context: &NativeRedemptionContext,
        now: u64,
    ) -> RedemptionResult<Vec<NativeRelayGrantCleanupStatus>> {
        validate_profile_context(context)?;
        if !profile_matches_owner(&context.profile, owner) {
            return Err(NativeRedemptionError::InvalidProfile);
        }
        let _global = NATIVE_GRANT_VAULT_LOCK
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        stage_profile_route_cleanup_locked(
            &mut *backend,
            owner,
            &context.profile.broker_origin,
            &context.profile.station_id,
            &context.profile.enrollment_id,
            now,
        )
    }

    pub(crate) fn stage_removed_profile_route_cleanup(
        &self,
        owner: &NativeProofKeyOwner,
        broker_origin: &str,
        station_id: &str,
        enrollment_id: &str,
        now: u64,
    ) -> RedemptionResult<Vec<NativeRelayGrantCleanupStatus>> {
        if !canonical_broker_origin(broker_origin)
            || !valid_uuid(station_id)
            || !valid_uuid(enrollment_id)
        {
            return Err(NativeRedemptionError::InvalidProfile);
        }
        let _global = NATIVE_GRANT_VAULT_LOCK
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        stage_profile_route_cleanup_locked(
            &mut *backend,
            owner,
            broker_origin,
            station_id,
            enrollment_id,
            now,
        )
    }

    fn store(
        &self,
        owner: &NativeProofKeyOwner,
        grant: &NativeRelayClientGrantV2,
        now: u64,
    ) -> Result<NativeRelayGrantMetadata, NativeGrantStoreFailure> {
        let _global = NATIVE_GRANT_VAULT_LOCK
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let route = validate_native_grant(owner, &grant, now)?;
        let binding = NativeRelayGrantBinding {
            owner: owner.clone(),
            route: route.clone(),
        };
        if read_native_grant_cleanup_index(&mut *backend, owner)?
            .entries
            .iter()
            .any(|entry| entry.route == route)
        {
            return Err(NativeGrantStoreFailure {
                primary: NativeRedemptionError::GrantStore,
                write_disposition: NativeGrantStoreWriteDisposition::NotWritten,
                cleanup_id: None,
            });
        }
        let account = native_grant_account(&binding)?;
        if backend.get(&account)?.is_some() {
            return Err(NativeGrantStoreFailure {
                primary: NativeRedemptionError::GrantExists,
                write_disposition: NativeGrantStoreWriteDisposition::NotWritten,
                cleanup_id: None,
            });
        }
        let pending =
            match stage_native_grant_cleanup_locked(&mut *backend, owner, grant, true, now) {
                Ok(entry) => entry,
                Err(primary) => {
                    return Err(NativeGrantStoreFailure {
                        primary,
                        write_disposition: NativeGrantStoreWriteDisposition::NotWritten,
                        cleanup_id: None,
                    })
                }
            };
        if !pending.record_present {
            return Err(NativeGrantStoreFailure {
                primary: NativeRedemptionError::GrantStore,
                write_disposition: NativeGrantStoreWriteDisposition::NotWritten,
                cleanup_id: Some(pending.cleanup_id),
            });
        }
        let payload = StoredNativeRelayGrantV2Ref {
            schema_version: 1,
            binding: binding.clone(),
            grant,
            renewal_intent: None,
        };
        let encoded = Zeroizing::new(
            serde_json::to_string(&payload).map_err(|_| NativeRedemptionError::GrantInvalid)?,
        );
        // Stage the cleanup-only record and route quarantine before publishing
        // the active account. A partially committed write is therefore never
        // visible through metadata, including after a process restart.
        if let Err(primary) = add_native_grant_index(&mut *backend, &binding) {
            return Err(NativeGrantStoreFailure {
                primary,
                write_disposition: NativeGrantStoreWriteDisposition::NotWritten,
                cleanup_id: Some(pending.cleanup_id),
            });
        }
        if backend.set(&account, &encoded).is_err() {
            let write_disposition = match backend.get(&account) {
                Ok(None) => {
                    let _ = remove_native_grant_index(&mut *backend, &binding);
                    NativeGrantStoreWriteDisposition::NotWritten
                }
                // Either the write committed before surfacing its error or the
                // backend cannot establish that it did not.
                Ok(Some(_)) | Err(_) => NativeGrantStoreWriteDisposition::MayHaveWritten,
            };
            return Err(NativeGrantStoreFailure {
                primary: NativeRedemptionError::GrantStore,
                write_disposition,
                cleanup_id: Some(pending.cleanup_id),
            });
        }
        if release_provisional_quarantine_after_commit_locked(
            &mut *backend,
            owner,
            &pending.cleanup_id,
            grant,
        )
        .is_err()
        {
            return Err(NativeGrantStoreFailure {
                primary: NativeRedemptionError::GrantStore,
                write_disposition: NativeGrantStoreWriteDisposition::MayHaveWritten,
                cleanup_id: Some(pending.cleanup_id),
            });
        }
        Ok(native_grant_metadata(binding.route, grant))
    }

    fn metadata(
        &self,
        owner: &NativeProofKeyOwner,
        route: &NativeRelayGrantRoute,
        now: u64,
    ) -> RedemptionResult<Option<NativeRelayGrantMetadata>> {
        let _global = NATIVE_GRANT_VAULT_LOCK
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let binding = NativeRelayGrantBinding {
            owner: owner.clone(),
            route: route.clone(),
        };
        let account = native_grant_account(&binding)?;
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let pending_index = read_native_grant_cleanup_index(&mut *backend, owner)?;
        if pending_index
            .entries
            .iter()
            .any(|entry| entry.route == *route)
        {
            return Ok(None);
        }
        let Some(encoded) = backend.get(&account)? else {
            return Ok(None);
        };
        let stored: StoredNativeRelayGrantV2 =
            serde_json::from_str(&encoded).map_err(|_| NativeRedemptionError::GrantInvalid)?;
        if stored.schema_version != 1 || stored.binding != binding {
            return Err(NativeRedemptionError::GrantInvalid);
        }
        if stored.grant.expires_at <= now {
            return Ok(None);
        }
        validate_native_grant(owner, &stored.grant, now)?;
        Ok(Some(native_grant_metadata(binding.route, &stored.grant)))
    }

    fn load_request_grant(
        &self,
        owner: &NativeProofKeyOwner,
        context: &NativeRedemptionContext,
        now: u64,
        allow_expired_for_renewal: bool,
    ) -> RedemptionResult<NativeGrantRequestRecord> {
        let _global = NATIVE_GRANT_VAULT_LOCK
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        validate_profile_context(context)?;
        if !profile_matches_owner(&context.profile, owner)
            || context.station_trust.station_id != context.profile.station_id
            || context.station_trust.enrollment_id != context.profile.enrollment_id
            || context.station_trust.station_endpoint != context.profile.station_endpoint
        {
            return Err(NativeRedemptionError::InvalidProfile);
        }
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let pending = read_native_grant_cleanup_index(&mut *backend, owner)?;
        let entries = read_native_grant_index(&mut *backend, owner)?;
        let mut matches = Vec::new();
        for entry in entries {
            if entry.route.broker_origin != context.profile.broker_origin
                || entry.route.station_id != context.profile.station_id
                || entry.route.enrollment_id != context.profile.enrollment_id
            {
                continue;
            }
            if pending.entries.iter().any(|item| item.route == entry.route) {
                return Err(NativeRedemptionError::GrantStore);
            }
            let binding = NativeRelayGrantBinding {
                owner: owner.clone(),
                route: entry.route.clone(),
            };
            let account = native_grant_account(&binding)?;
            let Some(encoded) = backend.get(&account)? else {
                return Err(NativeRedemptionError::GrantStore);
            };
            let stored: StoredNativeRelayGrantV2 =
                serde_json::from_str(&encoded).map_err(|_| NativeRedemptionError::GrantInvalid)?;
            if stored.schema_version != 1 || stored.binding != binding {
                return Err(NativeRedemptionError::GrantInvalid);
            }
            if stored.grant.station_signing_generation != context.station_trust.generation
                || stored.grant.station_signing_key_id
                    != station_signing_key_id(&context.station_trust.signing_key)
            {
                continue;
            }
            if stored.grant.expires_at <= now {
                if !allow_expired_for_renewal {
                    continue;
                }
                let within_initial_grace =
                    now.saturating_sub(stored.grant.expires_at) <= NATIVE_GRANT_RENEWAL_GRACE_MS;
                // A renewal can commit at the end of the original grace and
                // lose its reply. The broker retains that exact receipt until
                // the resulting 24-hour grant plus another seven-day grace.
                // Extend lookup only for a validated durable intent; open/read
                // still use the non-renewal path and refuse expired grants.
                let within_pending_receipt_window =
                    stored.renewal_intent.as_ref().is_some_and(|intent| {
                        validate_native_renewal_intent(intent, &stored.grant).is_ok()
                    }) && now
                        <= stored
                            .grant
                            .expires_at
                            .saturating_add(NATIVE_GRANT_RENEWAL_GRACE_MS.saturating_mul(2))
                            .saturating_add(MAX_GRANT_AGE_MS);
                if !within_initial_grace && !within_pending_receipt_window {
                    continue;
                }
                validate_native_grant(owner, &stored.grant, stored.grant.expires_at - 1)?;
            } else {
                validate_native_grant(owner, &stored.grant, now)?;
            }
            matches.push(NativeGrantRequestRecord {
                grant: stored.grant,
                renewal_intent: stored.renewal_intent,
            });
        }
        if matches.len() != 1 {
            return Err(NativeRedemptionError::GrantInvalid);
        }
        Ok(matches.remove(0))
    }

    fn save_renewal_intent(
        &self,
        owner: &NativeProofKeyOwner,
        grant: &NativeRelayClientGrantV2,
        intent: NativeGrantRenewalIntent,
    ) -> RedemptionResult<NativeGrantRenewalIntent> {
        let _global = NATIVE_GRANT_VAULT_LOCK
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let binding = NativeRelayGrantBinding {
            owner: owner.clone(),
            route: native_route_for_grant(grant),
        };
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        if read_native_grant_cleanup_index(&mut *backend, owner)?
            .entries
            .iter()
            .any(|entry| entry.route == binding.route)
        {
            return Err(NativeRedemptionError::GrantStore);
        }
        let account = native_grant_account(&binding)?;
        let encoded = backend
            .get(&account)?
            .ok_or(NativeRedemptionError::GrantStore)?;
        let mut stored: StoredNativeRelayGrantV2 =
            serde_json::from_str(&encoded).map_err(|_| NativeRedemptionError::GrantStore)?;
        if stored.schema_version != 1
            || stored.binding != binding
            || !same_native_grant(&stored.grant, grant)
            || validate_native_renewal_intent(&intent, &stored.grant).is_err()
        {
            return Err(NativeRedemptionError::GrantStore);
        }
        if let Some(existing) = &stored.renewal_intent {
            if existing.renewal_id != intent.renewal_id
                || existing.expected_expires_at != intent.expected_expires_at
                || existing.request_body != intent.request_body
            {
                return Err(NativeRedemptionError::GrantStore);
            }
            return Ok(existing.clone());
        }
        stored.renewal_intent = Some(intent.clone());
        let serialized = Zeroizing::new(
            serde_json::to_string(&stored).map_err(|_| NativeRedemptionError::GrantStore)?,
        );
        backend.set(&account, &serialized)?;
        Ok(intent)
    }

    fn complete_renewal(
        &self,
        owner: &NativeProofKeyOwner,
        grant: &NativeRelayClientGrantV2,
        intent: &NativeGrantRenewalIntent,
        receipt: &NativeGrantRenewalReceipt,
        now: u64,
    ) -> RedemptionResult<NativeRelayGrantMetadata> {
        let _global = NATIVE_GRANT_VAULT_LOCK
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let binding = NativeRelayGrantBinding {
            owner: owner.clone(),
            route: native_route_for_grant(grant),
        };
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        if read_native_grant_cleanup_index(&mut *backend, owner)?
            .entries
            .iter()
            .any(|entry| entry.route == binding.route)
        {
            return Err(NativeRedemptionError::GrantStore);
        }
        let account = native_grant_account(&binding)?;
        let encoded = backend
            .get(&account)?
            .ok_or(NativeRedemptionError::GrantStore)?;
        let mut stored: StoredNativeRelayGrantV2 =
            serde_json::from_str(&encoded).map_err(|_| NativeRedemptionError::GrantStore)?;
        if stored.schema_version != 1
            || stored.binding != binding
            || !same_native_grant(&stored.grant, grant)
            || stored.renewal_intent.as_ref() != Some(intent)
            || validate_native_renewal_intent(intent, &stored.grant).is_err()
            || receipt.version != NATIVE_RENEWED_VERSION
            || receipt.renewal_id != intent.renewal_id
            || receipt.expires_at <= intent.expected_expires_at
            || receipt.expires_at
                > intent
                    .expected_expires_at
                    .saturating_add(NATIVE_GRANT_RENEWAL_GRACE_MS)
                    .saturating_add(MAX_GRANT_AGE_MS)
            || receipt.expires_at > now.saturating_add(MAX_GRANT_AGE_MS)
            || now.saturating_sub(receipt.expires_at) > NATIVE_GRANT_RENEWAL_GRACE_MS
        {
            return Err(NativeRedemptionError::GrantStore);
        }
        stored.grant.expires_at = receipt.expires_at;
        stored.renewal_intent = None;
        // The broker can replay this exact receipt during its seven-day
        // idempotency grace. Preserve its expiry and clear the intent so a
        // following renewal can proceed even if the replayed grant is stale.
        validate_native_grant(owner, &stored.grant, receipt.expires_at - 1)?;
        let serialized = Zeroizing::new(
            serde_json::to_string(&stored).map_err(|_| NativeRedemptionError::GrantStore)?,
        );
        backend.set(&account, &serialized)?;
        Ok(native_grant_metadata(binding.route, &stored.grant))
    }

    fn revoke_if_matches(
        &self,
        owner: &NativeProofKeyOwner,
        expected: &NativeRelayClientGrantV2,
    ) -> RedemptionResult<bool> {
        let _global = NATIVE_GRANT_VAULT_LOCK
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let route = native_route_for_grant(expected);
        let binding = NativeRelayGrantBinding {
            owner: owner.clone(),
            route,
        };
        let account = native_grant_account(&binding)?;
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let Some(encoded) = backend.get(&account)? else {
            remove_native_grant_index(&mut *backend, &binding)?;
            return Ok(false);
        };
        let stored: StoredNativeRelayGrantV2 =
            serde_json::from_str(&encoded).map_err(|_| NativeRedemptionError::GrantInvalid)?;
        if stored.schema_version != 1 || stored.binding != binding {
            return Err(NativeRedemptionError::GrantInvalid);
        }
        if !same_native_grant(&stored.grant, expected) {
            return Ok(false);
        }
        backend.delete(&account)?;
        remove_native_grant_index(&mut *backend, &binding)?;
        Ok(true)
    }

    fn stage_cleanup(
        &self,
        owner: &NativeProofKeyOwner,
        grant: &NativeRelayClientGrantV2,
        local_cleanup_required: bool,
        now: u64,
    ) -> RedemptionResult<NativeGrantCleanupIndexEntry> {
        let _global = NATIVE_GRANT_VAULT_LOCK
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        stage_native_grant_cleanup_locked(&mut *backend, owner, grant, local_cleanup_required, now)
    }

    pub(crate) fn load_cleanup(
        &self,
        owner: &NativeProofKeyOwner,
        cleanup_id: &str,
    ) -> RedemptionResult<Option<NativeGrantCleanupPending>> {
        let _global = NATIVE_GRANT_VAULT_LOCK
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let index = read_native_grant_cleanup_index(&mut *backend, owner)?;
        let Some(mut entry) = index
            .entries
            .into_iter()
            .find(|entry| entry.cleanup_id == cleanup_id)
        else {
            return Ok(None);
        };
        let account = native_grant_cleanup_record_account(owner, cleanup_id)?;
        let Some(encoded) = backend.get(&account)? else {
            if entry.record_present {
                entry.record_present = false;
                update_native_grant_cleanup_index_entry(&mut *backend, owner, &entry)?;
            }
            if entry.local_cleanup_required {
                let binding = NativeRelayGrantBinding {
                    owner: owner.clone(),
                    route: entry.route.clone(),
                };
                if let Some(active) = backend.get(&native_grant_account(&binding)?)? {
                    let stored: StoredNativeRelayGrantV2 = serde_json::from_str(&active)
                        .map_err(|_| NativeRedemptionError::GrantStore)?;
                    if stored.schema_version == 1
                        && stored.binding == binding
                        && native_grant_secret_digest(&stored.grant) == entry.grant_secret_digest
                    {
                        validate_native_grant(
                            owner,
                            &stored.grant,
                            native_grant_validation_time(&stored.grant, entry.staged_at)?,
                        )?;
                        return Ok(Some(NativeGrantCleanupPending {
                            entry,
                            grant: stored.grant,
                            durable_cleanup_record: false,
                        }));
                    }
                }
            }
            return Ok(None);
        };
        let stored: StoredNativeGrantCleanupV2 =
            serde_json::from_str(&encoded).map_err(|_| NativeRedemptionError::GrantStore)?;
        let binding = NativeRelayGrantBinding {
            owner: owner.clone(),
            route: entry.route.clone(),
        };
        let route = validate_native_grant(
            owner,
            &stored.grant,
            native_grant_validation_time(&stored.grant, stored.staged_at)?,
        )?;
        if stored.schema_version != 1
            || stored.cleanup_id != cleanup_id
            || stored.binding != binding
            || route != entry.route
            || stored.staged_at != entry.staged_at
            || stored.local_cleanup_required != entry.local_cleanup_required
            || native_grant_secret_digest(&stored.grant) != entry.grant_secret_digest
        {
            return Err(NativeRedemptionError::GrantStore);
        }
        if !entry.record_present {
            entry.record_present = true;
            update_native_grant_cleanup_index_entry(&mut *backend, owner, &entry)?;
        }
        Ok(Some(NativeGrantCleanupPending {
            entry,
            grant: stored.grant,
            durable_cleanup_record: true,
        }))
    }

    pub(crate) fn pending_cleanups(
        &self,
        owner: &NativeProofKeyOwner,
    ) -> RedemptionResult<Vec<NativeGrantCleanupIndexEntry>> {
        let _global = NATIVE_GRANT_VAULT_LOCK
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        Ok(read_native_grant_cleanup_index(&mut *backend, owner)?.entries)
    }

    fn mark_broker_retired(
        &self,
        owner: &NativeProofKeyOwner,
        cleanup_id: &str,
    ) -> RedemptionResult<()> {
        let _global = NATIVE_GRANT_VAULT_LOCK
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        update_cleanup_state(&mut *backend, owner, cleanup_id, |entry| {
            entry.broker_retired = true;
            entry.remote_basis = Some(NativeCleanupRemoteBasis::IndividualGrantRetired);
            Ok(())
        })
    }

    pub(crate) fn record_recovery_basis(
        &self,
        owner: &NativeProofKeyOwner,
        cleanup_id: &str,
        grant: &NativeRelayClientGrantV2,
        basis: NativeCleanupRemoteBasis,
    ) -> RedemptionResult<()> {
        let _global = NATIVE_GRANT_VAULT_LOCK
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let route = native_route_for_grant(grant);
        if let NativeCleanupRemoteBasis::SupersededGenerationObserved { observation } = &basis {
            if !valid_scope_observation(observation, &route) {
                return Err(NativeRedemptionError::GrantInvalid);
            }
        }
        let binding = NativeRelayGrantBinding {
            owner: owner.clone(),
            route: route.clone(),
        };
        if let Some(encoded) = backend.get(&native_grant_account(&binding)?)? {
            let stored: StoredNativeRelayGrantV2 =
                serde_json::from_str(&encoded).map_err(|_| NativeRedemptionError::GrantStore)?;
            if stored.binding != binding || !same_native_grant(&stored.grant, grant) {
                return Err(NativeRedemptionError::StaleProfile);
            }
        }
        update_cleanup_state(&mut *backend, owner, cleanup_id, |entry| {
            if entry.route != route
                || entry.grant_secret_digest != native_grant_secret_digest(grant)
            {
                return Err(NativeRedemptionError::GrantInvalid);
            }
            entry.broker_retired =
                matches!(basis, NativeCleanupRemoteBasis::IndividualGrantRetired);
            entry.remote_basis = Some(basis);
            Ok(())
        })
    }

    fn mark_local_cleanup_complete(
        &self,
        owner: &NativeProofKeyOwner,
        cleanup_id: &str,
    ) -> RedemptionResult<()> {
        let _global = NATIVE_GRANT_VAULT_LOCK
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        update_cleanup_state(&mut *backend, owner, cleanup_id, |entry| {
            entry.local_cleanup_complete = true;
            Ok(())
        })
    }

    fn finish_cleanup(
        &self,
        owner: &NativeProofKeyOwner,
        cleanup_id: &str,
    ) -> RedemptionResult<()> {
        let _global = NATIVE_GRANT_VAULT_LOCK
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        let mut index = read_native_grant_cleanup_index(&mut *backend, owner)?;
        let Some(entry) = index
            .entries
            .iter()
            .find(|entry| entry.cleanup_id == cleanup_id)
            .cloned()
        else {
            return Ok(());
        };
        if (!entry.broker_retired && entry.remote_basis.is_none()) || !entry.local_cleanup_complete
        {
            return Err(NativeRedemptionError::GrantStore);
        }
        let account = native_grant_cleanup_record_account(owner, cleanup_id)?;
        backend.delete(&account)?;
        index.entries.retain(|entry| entry.cleanup_id != cleanup_id);
        write_native_grant_cleanup_index_confirmed(&mut *backend, owner, &index)
    }
}

impl<B: NativeGrantBackend> NativeGrantCustody for NativeRelayGrantVault<B> {
    fn register_cleanup_owner(&self, owner: &NativeProofKeyOwner) -> RedemptionResult<()> {
        NativeRelayGrantVault::register_cleanup_owner(self, owner)
    }

    fn metadata_for_context(
        &self,
        owner: &NativeProofKeyOwner,
        context: &NativeRedemptionContext,
        now: u64,
    ) -> RedemptionResult<Vec<NativeRelayGrantStatusItem>> {
        NativeRelayGrantVault::metadata_for_context(self, owner, context, now)
    }

    fn stage_context_cleanup(
        &self,
        owner: &NativeProofKeyOwner,
        context: &NativeRedemptionContext,
        now: u64,
    ) -> RedemptionResult<Vec<NativeRelayGrantCleanupStatus>> {
        NativeRelayGrantVault::stage_context_cleanup(self, owner, context, now)
    }

    fn store(
        &self,
        owner: &NativeProofKeyOwner,
        grant: &NativeRelayClientGrantV2,
        now: u64,
    ) -> Result<NativeRelayGrantMetadata, NativeGrantStoreFailure> {
        NativeRelayGrantVault::store(self, owner, grant, now)
    }

    fn revoke_if_matches(
        &self,
        owner: &NativeProofKeyOwner,
        grant: &NativeRelayClientGrantV2,
    ) -> RedemptionResult<bool> {
        NativeRelayGrantVault::revoke_if_matches(self, owner, grant)
    }

    fn stage_cleanup(
        &self,
        owner: &NativeProofKeyOwner,
        grant: &NativeRelayClientGrantV2,
        local_cleanup_required: bool,
        now: u64,
    ) -> RedemptionResult<NativeGrantCleanupIndexEntry> {
        NativeRelayGrantVault::stage_cleanup(self, owner, grant, local_cleanup_required, now)
    }

    fn load_cleanup(
        &self,
        owner: &NativeProofKeyOwner,
        cleanup_id: &str,
    ) -> RedemptionResult<Option<NativeGrantCleanupPending>> {
        NativeRelayGrantVault::load_cleanup(self, owner, cleanup_id)
    }

    fn pending_cleanups(
        &self,
        owner: &NativeProofKeyOwner,
    ) -> RedemptionResult<Vec<NativeGrantCleanupIndexEntry>> {
        NativeRelayGrantVault::pending_cleanups(self, owner)
    }

    fn mark_broker_retired(
        &self,
        owner: &NativeProofKeyOwner,
        cleanup_id: &str,
    ) -> RedemptionResult<()> {
        NativeRelayGrantVault::mark_broker_retired(self, owner, cleanup_id)
    }

    fn record_recovery_basis(
        &self,
        owner: &NativeProofKeyOwner,
        cleanup_id: &str,
        grant: &NativeRelayClientGrantV2,
        basis: NativeCleanupRemoteBasis,
    ) -> RedemptionResult<()> {
        NativeRelayGrantVault::record_recovery_basis(self, owner, cleanup_id, grant, basis)
    }

    fn mark_local_cleanup_complete(
        &self,
        owner: &NativeProofKeyOwner,
        cleanup_id: &str,
    ) -> RedemptionResult<()> {
        NativeRelayGrantVault::mark_local_cleanup_complete(self, owner, cleanup_id)
    }

    fn finish_cleanup(
        &self,
        owner: &NativeProofKeyOwner,
        cleanup_id: &str,
    ) -> RedemptionResult<()> {
        NativeRelayGrantVault::finish_cleanup(self, owner, cleanup_id)
    }

    fn load_request_grant(
        &self,
        owner: &NativeProofKeyOwner,
        context: &NativeRedemptionContext,
        now: u64,
        allow_expired_for_renewal: bool,
    ) -> RedemptionResult<NativeGrantRequestRecord> {
        NativeRelayGrantVault::load_request_grant(
            self,
            owner,
            context,
            now,
            allow_expired_for_renewal,
        )
    }

    fn save_renewal_intent(
        &self,
        owner: &NativeProofKeyOwner,
        grant: &NativeRelayClientGrantV2,
        intent: NativeGrantRenewalIntent,
    ) -> RedemptionResult<NativeGrantRenewalIntent> {
        NativeRelayGrantVault::save_renewal_intent(self, owner, grant, intent)
    }

    fn complete_renewal(
        &self,
        owner: &NativeProofKeyOwner,
        grant: &NativeRelayClientGrantV2,
        intent: &NativeGrantRenewalIntent,
        receipt: &NativeGrantRenewalReceipt,
        now: u64,
    ) -> RedemptionResult<NativeRelayGrantMetadata> {
        NativeRelayGrantVault::complete_renewal(self, owner, grant, intent, receipt, now)
    }
}

pub(crate) struct OsNativeGrantBackend;

impl NativeGrantBackend for OsNativeGrantBackend {
    fn get(&mut self, account: &str) -> RedemptionResult<Option<Zeroizing<String>>> {
        super::initialize_credential_store().map_err(|_| NativeRedemptionError::GrantStore)?;
        let entry = crate::native_secure_entry::NativeSecureEntry::new(
            super::STATION_CREDENTIAL_SERVICE,
            account,
        )
        .map_err(|_| NativeRedemptionError::GrantStore)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(_) => Err(NativeRedemptionError::GrantStore),
        }
    }

    fn set(&mut self, account: &str, value: &str) -> RedemptionResult<()> {
        super::initialize_credential_store().map_err(|_| NativeRedemptionError::GrantStore)?;
        let entry = crate::native_secure_entry::NativeSecureEntry::new(
            super::STATION_CREDENTIAL_SERVICE,
            account,
        )
        .map_err(|_| NativeRedemptionError::GrantStore)?;
        entry
            .set_password(value)
            .map_err(|_| NativeRedemptionError::GrantStore)
    }

    fn delete(&mut self, account: &str) -> RedemptionResult<()> {
        super::initialize_credential_store().map_err(|_| NativeRedemptionError::GrantStore)?;
        let entry = crate::native_secure_entry::NativeSecureEntry::new(
            super::STATION_CREDENTIAL_SERVICE,
            account,
        )
        .map_err(|_| NativeRedemptionError::GrantStore)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(_) => Err(NativeRedemptionError::GrantStore),
        }
    }
}

pub(crate) fn native_relay_grant_vault() -> NativeRelayGrantVault<OsNativeGrantBackend> {
    NativeRelayGrantVault::new(OsNativeGrantBackend)
}

/// Best-effort restart/profile-write recovery. Each failed entry remains in
/// the owner-indexed durable quarantine for an explicit host retry.
pub(crate) fn retry_pending_cleanup_for_app(app: &AppHandle) -> RedemptionResult<()> {
    let app_identifier = app.config().identifier.clone();
    let channel = super::native_app_channel(&app_identifier, cfg!(debug_assertions));
    let grants = native_relay_grant_vault();
    let owners = grants.registered_cleanup_owners(&app_identifier, channel)?;
    let context = AppNativeRedemptionContextProvider::for_existing_route(app.clone());
    let proof_keys = NativeRelayProofKeyVault::new();
    let http = UreqNativeBrokerTransport::new();
    let service = NativeRelayRedemptionService::new(
        &context,
        &proof_keys,
        &http,
        &grants,
        native_now_ms_or_zero,
    );
    let mut remaining = MAX_BACKGROUND_CLEANUP_RETRIES;
    for owner in owners {
        for cleanup_id in service.pending_cleanup_ids(&owner)? {
            if remaining == 0 {
                return Ok(());
            }
            // Failure is intentionally retained and surfaced by cleanup
            // status; one unavailable broker must not starve sibling entries.
            let _ = service.retry_pending_cleanup(&owner, &cleanup_id);
            remaining -= 1;
        }
    }
    Ok(())
}

fn native_now_ms_or_zero() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeRelayGrantIndexEntry {
    owner: NativeProofKeyOwner,
    route: NativeRelayGrantRoute,
}

fn native_grant_index_account(owner: &NativeProofKeyOwner) -> String {
    let app_hash = URL_SAFE_NO_PAD.encode(digest(&SHA256, owner.app_identifier().as_bytes()));
    format!(
        "{GRANT_INDEX_PREFIX}{}:{app_hash}:{}",
        owner.channel_label(),
        owner.client_instance_id()
    )
}

fn native_grant_account(binding: &NativeRelayGrantBinding) -> RedemptionResult<String> {
    let route = &binding.route;
    let parts = [
        binding.owner.app_identifier().to_owned(),
        binding.owner.channel_label().to_owned(),
        binding.owner.client_instance_id(),
        route.broker_origin.clone(),
        route.station_id.clone(),
        route.enrollment_id.clone(),
        route.routing_generation.to_string(),
        route.grant_id.clone(),
    ];
    let mut account = GRANT_ACCOUNT_PREFIX.to_owned();
    for part in parts {
        account.push_str(&part.len().to_string());
        account.push(':');
        account.push_str(&part);
        account.push(':');
    }
    if account.len() > 2048 {
        return Err(NativeRedemptionError::InvalidProfile);
    }
    Ok(account)
}

fn read_native_grant_index(
    backend: &mut impl NativeGrantBackend,
    owner: &NativeProofKeyOwner,
) -> RedemptionResult<Vec<NativeRelayGrantIndexEntry>> {
    let Some(encoded) = backend.get(&native_grant_index_account(owner))? else {
        return Ok(Vec::new());
    };
    let entries: Vec<NativeRelayGrantIndexEntry> =
        serde_json::from_str(&encoded).map_err(|_| NativeRedemptionError::GrantStore)?;
    if entries.len() > MAX_GRANT_INDEX_ENTRIES || entries.iter().any(|entry| entry.owner != *owner)
    {
        return Err(NativeRedemptionError::GrantStore);
    }
    Ok(entries)
}

fn validate_indexed_grant(
    owner: &NativeProofKeyOwner,
    stored: &StoredNativeRelayGrantV2,
    binding: &NativeRelayGrantBinding,
    now: u64,
) -> RedemptionResult<()> {
    if stored.schema_version != 1 || stored.binding != *binding {
        return Err(NativeRedemptionError::GrantStore);
    }
    let route = validate_native_grant(
        owner,
        &stored.grant,
        native_grant_validation_time(&stored.grant, now)?,
    )?;
    if route != binding.route {
        return Err(NativeRedemptionError::GrantStore);
    }
    Ok(())
}

fn native_grant_validation_time(
    grant: &NativeRelayClientGrantV2,
    now: u64,
) -> RedemptionResult<u64> {
    grant
        .expires_at
        .checked_sub(1)
        .map(|last_live_second| now.min(last_live_second))
        .ok_or(NativeRedemptionError::GrantInvalid)
}

fn cleanup_status(entry: NativeGrantCleanupIndexEntry) -> NativeRelayGrantCleanupStatus {
    NativeRelayGrantCleanupStatus {
        cleanup_id: entry.cleanup_id,
        route: entry.route,
        staged_at: entry.staged_at,
        record_present: entry.record_present,
        broker_retired: entry.broker_retired,
        local_cleanup_required: entry.local_cleanup_required,
        local_cleanup_complete: entry.local_cleanup_complete,
    }
}

fn stage_profile_route_cleanup_locked(
    backend: &mut impl NativeGrantBackend,
    owner: &NativeProofKeyOwner,
    broker_origin: &str,
    station_id: &str,
    enrollment_id: &str,
    now: u64,
) -> RedemptionResult<Vec<NativeRelayGrantCleanupStatus>> {
    let matches_profile = |route: &NativeRelayGrantRoute| {
        route.broker_origin == broker_origin
            && route.station_id == station_id
            && route.enrollment_id == enrollment_id
    };
    let mut quarantined = read_native_grant_cleanup_index(backend, owner)?.entries;
    let active = read_native_grant_index(backend, owner)?;
    let active: Vec<_> = active
        .into_iter()
        .filter(|entry| matches_profile(&entry.route))
        .collect();
    let already_quarantined = quarantined
        .iter()
        .any(|entry| matches_profile(&entry.route));
    if active.is_empty() && !already_quarantined {
        return Ok(Vec::new());
    }
    register_cleanup_owner_locked(backend, owner)?;
    for entry in active {
        if quarantined
            .iter()
            .any(|cleanup| cleanup.route == entry.route)
        {
            continue;
        }
        let binding = NativeRelayGrantBinding {
            owner: owner.clone(),
            route: entry.route.clone(),
        };
        let account = native_grant_account(&binding)?;
        let encoded = backend
            .get(&account)?
            .ok_or(NativeRedemptionError::GrantStore)?;
        let stored: StoredNativeRelayGrantV2 =
            serde_json::from_str(&encoded).map_err(|_| NativeRedemptionError::GrantStore)?;
        validate_indexed_grant(owner, &stored, &binding, now)?;
        let cleanup = stage_native_grant_cleanup_locked(backend, owner, &stored.grant, true, now)?;
        quarantined.push(cleanup);
    }
    Ok(quarantined
        .into_iter()
        .filter(|entry| matches_profile(&entry.route))
        .map(cleanup_status)
        .collect())
}

fn write_native_grant_index(
    backend: &mut impl NativeGrantBackend,
    owner: &NativeProofKeyOwner,
    entries: &[NativeRelayGrantIndexEntry],
) -> RedemptionResult<()> {
    if entries.len() > MAX_GRANT_INDEX_ENTRIES || entries.iter().any(|entry| entry.owner != *owner)
    {
        return Err(NativeRedemptionError::GrantStore);
    }
    let encoded = serde_json::to_string(entries).map_err(|_| NativeRedemptionError::GrantStore)?;
    backend.set(&native_grant_index_account(owner), &encoded)
}

fn add_native_grant_index(
    backend: &mut impl NativeGrantBackend,
    binding: &NativeRelayGrantBinding,
) -> RedemptionResult<()> {
    let mut entries = read_native_grant_index(backend, &binding.owner)?;
    let entry = NativeRelayGrantIndexEntry {
        owner: binding.owner.clone(),
        route: binding.route.clone(),
    };
    if !entries.contains(&entry) {
        if entries.len() >= MAX_GRANT_INDEX_ENTRIES {
            return Err(NativeRedemptionError::GrantStore);
        }
        entries.push(entry);
        write_native_grant_index(backend, &binding.owner, &entries)?;
    }
    Ok(())
}

fn remove_native_grant_index(
    backend: &mut impl NativeGrantBackend,
    binding: &NativeRelayGrantBinding,
) -> RedemptionResult<()> {
    let mut entries = read_native_grant_index(backend, &binding.owner)?;
    entries.retain(|entry| entry.owner != binding.owner || entry.route != binding.route);
    write_native_grant_index(backend, &binding.owner, &entries)
}

fn native_grant_cleanup_index_account(owner: &NativeProofKeyOwner) -> String {
    let app_hash = URL_SAFE_NO_PAD.encode(digest(&SHA256, owner.app_identifier().as_bytes()));
    format!(
        "{GRANT_CLEANUP_INDEX_PREFIX}{}:{app_hash}:{}",
        owner.channel_label(),
        owner.client_instance_id()
    )
}

fn native_grant_cleanup_owner_index_account(
    app_identifier: &str,
    channel: &str,
) -> RedemptionResult<String> {
    if !valid_app_identifier(app_identifier)
        || !matches!(channel, "stable" | "beta" | "nightly" | "dev")
    {
        return Err(NativeRedemptionError::InvalidProfile);
    }
    let app_hash = URL_SAFE_NO_PAD.encode(digest(&SHA256, app_identifier.as_bytes()));
    Ok(format!(
        "{GRANT_CLEANUP_OWNER_INDEX_PREFIX}{channel}:{app_hash}"
    ))
}

fn read_native_grant_cleanup_owner_index(
    backend: &mut impl NativeGrantBackend,
    app_identifier: &str,
    channel: &str,
) -> RedemptionResult<NativeGrantCleanupOwnerIndex> {
    let account = native_grant_cleanup_owner_index_account(app_identifier, channel)?;
    let Some(encoded) = backend.get(&account)? else {
        return Ok(NativeGrantCleanupOwnerIndex {
            schema_version: 1,
            owners: Vec::new(),
        });
    };
    let index: NativeGrantCleanupOwnerIndex =
        serde_json::from_str(&encoded).map_err(|_| NativeRedemptionError::GrantStore)?;
    let mut identities = std::collections::HashSet::new();
    if index.schema_version != 1
        || index.owners.len() > MAX_GRANT_INDEX_ENTRIES
        || index.owners.iter().any(|owner| {
            if owner.app_identifier() != app_identifier || owner.channel_label() != channel {
                return true;
            }
            let client_instance_id = owner.client_instance_id();
            NativeProofKeyOwner::new(app_identifier, channel_enum(channel), &client_instance_id)
                .is_err()
                || !identities.insert(client_instance_id)
        })
    {
        return Err(NativeRedemptionError::GrantStore);
    }
    Ok(index)
}

fn channel_enum(channel: &str) -> NativeProofKeyChannel {
    match channel {
        "stable" => NativeProofKeyChannel::Stable,
        "beta" => NativeProofKeyChannel::Beta,
        "nightly" => NativeProofKeyChannel::Nightly,
        _ => NativeProofKeyChannel::Dev,
    }
}

fn write_native_grant_cleanup_owner_index_confirmed(
    backend: &mut impl NativeGrantBackend,
    app_identifier: &str,
    channel: &str,
    expected: &NativeGrantCleanupOwnerIndex,
) -> RedemptionResult<()> {
    let account = native_grant_cleanup_owner_index_account(app_identifier, channel)?;
    let encoded = serde_json::to_string(expected).map_err(|_| NativeRedemptionError::GrantStore)?;
    if backend.set(&account, &encoded).is_ok() {
        return Ok(());
    }
    match backend.get(&account) {
        Ok(Some(actual)) if actual.as_str() == encoded => Ok(()),
        _ => Err(NativeRedemptionError::GrantStore),
    }
}

fn register_cleanup_owner_locked(
    backend: &mut impl NativeGrantBackend,
    owner: &NativeProofKeyOwner,
) -> RedemptionResult<()> {
    let channel = owner.channel_label();
    let mut index =
        read_native_grant_cleanup_owner_index(backend, owner.app_identifier(), channel)?;
    if !index.owners.contains(owner) {
        if index.owners.len() >= MAX_GRANT_INDEX_ENTRIES {
            return Err(NativeRedemptionError::GrantStore);
        }
        index.owners.push(owner.clone());
        write_native_grant_cleanup_owner_index_confirmed(
            backend,
            owner.app_identifier(),
            channel,
            &index,
        )?;
    }
    Ok(())
}

fn native_grant_cleanup_record_account(
    owner: &NativeProofKeyOwner,
    cleanup_id: &str,
) -> RedemptionResult<String> {
    if !valid_uuid(cleanup_id) {
        return Err(NativeRedemptionError::GrantStore);
    }
    let app_hash = URL_SAFE_NO_PAD.encode(digest(&SHA256, owner.app_identifier().as_bytes()));
    Ok(format!(
        "{GRANT_CLEANUP_RECORD_PREFIX}{}:{app_hash}:{}:{cleanup_id}",
        owner.channel_label(),
        owner.client_instance_id()
    ))
}

fn valid_scope_observation(
    observation: &NativeSupersededScopeObservation,
    route: &NativeRelayGrantRoute,
) -> bool {
    observation.version == "station-broker-native-superseded-scope-observed/v1"
        && observation.disposition == "superseded-generation-not-admitted"
        && valid_opaque(&observation.request_nonce)
        && URL_SAFE_NO_PAD
            .decode(&observation.request_nonce)
            .is_ok_and(|bytes| {
                bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == observation.request_nonce
            })
        && observation.scope.station_id == route.station_id
        && observation.scope.enrollment_id == route.enrollment_id
        && observation.scope.routing_generation == route.routing_generation
        && observation.lease_revision <= JS_SAFE_INTEGER_MAX
}

fn valid_cleanup_route(route: &NativeRelayGrantRoute) -> bool {
    canonical_broker_origin(&route.broker_origin)
        && valid_uuid(&route.station_id)
        && valid_uuid(&route.enrollment_id)
        && route.routing_generation > 0
        && route.routing_generation <= JS_SAFE_INTEGER_MAX
        && valid_grant_id(&route.grant_id)
}

fn read_native_grant_cleanup_index(
    backend: &mut impl NativeGrantBackend,
    owner: &NativeProofKeyOwner,
) -> RedemptionResult<NativeGrantCleanupIndex> {
    let Some(encoded) = backend.get(&native_grant_cleanup_index_account(owner))? else {
        return Ok(NativeGrantCleanupIndex {
            schema_version: 1,
            entries: Vec::new(),
        });
    };
    let index: NativeGrantCleanupIndex =
        serde_json::from_str(&encoded).map_err(|_| NativeRedemptionError::GrantStore)?;
    let mut ids = std::collections::HashSet::new();
    if index.schema_version != 1
        || index.entries.len() > MAX_GRANT_INDEX_ENTRIES
        || index.entries.iter().any(|entry| {
            !valid_uuid(&entry.cleanup_id)
                || !valid_cleanup_route(&entry.route)
                || !valid_opaque(&entry.grant_secret_digest)
                || entry.staged_at > JS_SAFE_INTEGER_MAX
                || !ids.insert(entry.cleanup_id.as_str())
                || entry
                    .remote_basis
                    .as_ref()
                    .is_some_and(|basis| match basis {
                        NativeCleanupRemoteBasis::IndividualGrantRetired => !entry.broker_retired,
                        NativeCleanupRemoteBasis::SupersededGenerationObserved { observation } => {
                            entry.broker_retired
                                || !valid_scope_observation(observation, &entry.route)
                        }
                    })
                || (entry.local_cleanup_required
                    && entry.local_cleanup_complete
                    && !entry.broker_retired
                    && entry.remote_basis.is_none())
                || (!entry.local_cleanup_required && !entry.local_cleanup_complete)
        })
    {
        return Err(NativeRedemptionError::GrantStore);
    }
    Ok(index)
}

fn write_native_grant_cleanup_index_confirmed(
    backend: &mut impl NativeGrantBackend,
    owner: &NativeProofKeyOwner,
    expected: &NativeGrantCleanupIndex,
) -> RedemptionResult<()> {
    let account = native_grant_cleanup_index_account(owner);
    let encoded = Zeroizing::new(
        serde_json::to_string(expected).map_err(|_| NativeRedemptionError::GrantStore)?,
    );
    if backend.set(&account, &encoded).is_ok() {
        return Ok(());
    }
    match backend.get(&account) {
        Ok(Some(actual)) if actual.as_str() == encoded.as_str() => Ok(()),
        _ => Err(NativeRedemptionError::GrantStore),
    }
}

fn update_native_grant_cleanup_index_entry(
    backend: &mut impl NativeGrantBackend,
    owner: &NativeProofKeyOwner,
    expected_entry: &NativeGrantCleanupIndexEntry,
) -> RedemptionResult<()> {
    let mut index = read_native_grant_cleanup_index(backend, owner)?;
    let entry = index
        .entries
        .iter_mut()
        .find(|entry| entry.cleanup_id == expected_entry.cleanup_id)
        .ok_or(NativeRedemptionError::GrantStore)?;
    if entry.route != expected_entry.route {
        return Err(NativeRedemptionError::GrantStore);
    }
    *entry = expected_entry.clone();
    write_native_grant_cleanup_index_confirmed(backend, owner, &index)
}

fn update_cleanup_state(
    backend: &mut impl NativeGrantBackend,
    owner: &NativeProofKeyOwner,
    cleanup_id: &str,
    update: impl FnOnce(&mut NativeGrantCleanupIndexEntry) -> RedemptionResult<()>,
) -> RedemptionResult<()> {
    let mut index = read_native_grant_cleanup_index(backend, owner)?;
    let entry = index
        .entries
        .iter_mut()
        .find(|entry| entry.cleanup_id == cleanup_id)
        .ok_or(NativeRedemptionError::GrantStore)?;
    update(entry)?;
    write_native_grant_cleanup_index_confirmed(backend, owner, &index)
}

fn stored_cleanup_matches(
    stored: &StoredNativeGrantCleanupV2,
    cleanup_id: &str,
    binding: &NativeRelayGrantBinding,
    grant: &NativeRelayClientGrantV2,
    local_cleanup_required: bool,
    staged_at: u64,
) -> bool {
    stored.schema_version == 1
        && stored.cleanup_id == cleanup_id
        && stored.binding == *binding
        && stored.local_cleanup_required == local_cleanup_required
        && stored.staged_at == staged_at
        && same_native_grant(&stored.grant, grant)
}

fn stage_native_grant_cleanup_locked(
    backend: &mut impl NativeGrantBackend,
    owner: &NativeProofKeyOwner,
    grant: &NativeRelayClientGrantV2,
    local_cleanup_required: bool,
    now: u64,
) -> RedemptionResult<NativeGrantCleanupIndexEntry> {
    register_cleanup_owner_locked(backend, owner)?;
    let route = validate_native_grant(owner, grant, native_grant_validation_time(grant, now)?)?;
    let binding = NativeRelayGrantBinding {
        owner: owner.clone(),
        route: route.clone(),
    };
    let mut index = read_native_grant_cleanup_index(backend, owner)?;
    if index.entries.len() >= MAX_GRANT_INDEX_ENTRIES {
        return Err(NativeRedemptionError::GrantStore);
    }
    let cleanup_id = uuid::Uuid::new_v4().to_string();
    let mut entry = NativeGrantCleanupIndexEntry {
        cleanup_id: cleanup_id.clone(),
        route,
        grant_secret_digest: native_grant_secret_digest(grant),
        staged_at: now,
        record_present: false,
        broker_retired: false,
        remote_basis: None,
        local_cleanup_required,
        local_cleanup_complete: !local_cleanup_required,
    };
    index.entries.push(entry.clone());
    // The secret-free route quarantine is durable before the cleanup secret
    // or any remote retirement request can be lost.
    write_native_grant_cleanup_index_confirmed(backend, owner, &index)?;

    let account = native_grant_cleanup_record_account(owner, &cleanup_id)?;
    let record = StoredNativeGrantCleanupV2Ref {
        schema_version: 1,
        cleanup_id: &cleanup_id,
        binding,
        local_cleanup_required,
        staged_at: now,
        grant,
    };
    let encoded = Zeroizing::new(
        serde_json::to_string(&record).map_err(|_| NativeRedemptionError::GrantStore)?,
    );
    let binding = NativeRelayGrantBinding {
        owner: owner.clone(),
        route: entry.route.clone(),
    };
    let wrote = backend.set(&account, &encoded).is_ok();
    entry.record_present = if wrote {
        true
    } else {
        match backend.get(&account) {
            Ok(Some(actual)) => serde_json::from_str::<StoredNativeGrantCleanupV2>(&actual)
                .is_ok_and(|stored| {
                    stored_cleanup_matches(
                        &stored,
                        &cleanup_id,
                        &binding,
                        grant,
                        local_cleanup_required,
                        now,
                    )
                }),
            Ok(None) | Err(_) => false,
        }
    };
    if entry.record_present {
        let mut latest = read_native_grant_cleanup_index(backend, owner)?;
        let stored_entry = latest
            .entries
            .iter_mut()
            .find(|candidate| candidate.cleanup_id == cleanup_id)
            .ok_or(NativeRedemptionError::GrantStore)?;
        stored_entry.record_present = true;
        // The entry already quarantines this route. If only the informational
        // presence bit fails to update, `load_cleanup` discovers the record by
        // its deterministic account and repairs the bit on the next read.
        let _ = write_native_grant_cleanup_index_confirmed(backend, owner, &latest);
    }
    Ok(entry)
}

/// Remove the pre-commit cleanup quarantine only after the exact active grant
/// write has been confirmed. This path publishes a successful grant; failed
/// retirements are cleared only by `finish_cleanup` below.
fn release_provisional_quarantine_after_commit_locked(
    backend: &mut impl NativeGrantBackend,
    owner: &NativeProofKeyOwner,
    cleanup_id: &str,
    expected_grant: &NativeRelayClientGrantV2,
) -> RedemptionResult<()> {
    let binding = NativeRelayGrantBinding {
        owner: owner.clone(),
        route: native_route_for_grant(expected_grant),
    };
    let active_account = native_grant_account(&binding)?;
    let Some(active_encoded) = backend.get(&active_account)? else {
        return Err(NativeRedemptionError::GrantStore);
    };
    let active: StoredNativeRelayGrantV2 =
        serde_json::from_str(&active_encoded).map_err(|_| NativeRedemptionError::GrantStore)?;
    if active.schema_version != 1
        || active.binding != binding
        || !same_native_grant(&active.grant, expected_grant)
    {
        return Err(NativeRedemptionError::GrantStore);
    }
    let mut index = read_native_grant_cleanup_index(backend, owner)?;
    let Some(entry) = index
        .entries
        .iter()
        .find(|entry| entry.cleanup_id == cleanup_id)
    else {
        return Err(NativeRedemptionError::GrantStore);
    };
    if entry.route != binding.route
        || entry.grant_secret_digest != native_grant_secret_digest(expected_grant)
    {
        return Err(NativeRedemptionError::GrantStore);
    }
    let record_account = native_grant_cleanup_record_account(owner, cleanup_id)?;
    let Some(encoded_record) = backend.get(&record_account)? else {
        return Err(NativeRedemptionError::GrantStore);
    };
    let record: StoredNativeGrantCleanupV2 =
        serde_json::from_str(&encoded_record).map_err(|_| NativeRedemptionError::GrantStore)?;
    if !stored_cleanup_matches(
        &record,
        cleanup_id,
        &binding,
        expected_grant,
        true,
        entry.staged_at,
    ) {
        return Err(NativeRedemptionError::GrantStore);
    }
    // Delete the secret-bearing provisional record while quarantine is still
    // durable. A failed or ambiguous delete therefore cannot strand an
    // unindexed bearer; metadata stays blocked until the index is removed.
    backend.delete(&record_account)?;
    index.entries.retain(|entry| entry.cleanup_id != cleanup_id);
    write_native_grant_cleanup_index_confirmed(backend, owner, &index)?;
    Ok(())
}

pub(crate) trait NativeProofKeyOperations: Send + Sync {
    fn restore(
        &self,
        owner: &NativeProofKeyOwner,
    ) -> Result<NativeProofKeyPublicMetadata, ProofKeyError>;
    fn sign(
        &self,
        owner: &NativeProofKeyOwner,
        challenge: &NativeBrokerRedemptionChallenge,
    ) -> Result<Vec<u8>, ProofKeyError>;
    fn sign_native_request(
        &self,
        owner: &NativeProofKeyOwner,
        challenge: &NativeBrokerRequestProofChallenge,
    ) -> Result<Vec<u8>, ProofKeyError>;
}

impl NativeProofKeyOperations for NativeRelayProofKeyVault {
    fn restore(
        &self,
        owner: &NativeProofKeyOwner,
    ) -> Result<NativeProofKeyPublicMetadata, ProofKeyError> {
        NativeRelayProofKeyVault::restore(self, owner)
    }
    fn sign(
        &self,
        owner: &NativeProofKeyOwner,
        challenge: &NativeBrokerRedemptionChallenge,
    ) -> Result<Vec<u8>, ProofKeyError> {
        NativeRelayProofKeyVault::sign_es256_p1363(self, owner, challenge)
    }
    fn sign_native_request(
        &self,
        owner: &NativeProofKeyOwner,
        challenge: &NativeBrokerRequestProofChallenge,
    ) -> Result<Vec<u8>, ProofKeyError> {
        NativeRelayProofKeyVault::sign_native_request_es256_p1363(self, owner, challenge)
    }
}

#[cfg(test)]
impl NativeProofKeyOperations for crate::native_relay_proof_key::MemoryNativeRelayProofKeyVault {
    fn restore(
        &self,
        owner: &NativeProofKeyOwner,
    ) -> Result<NativeProofKeyPublicMetadata, ProofKeyError> {
        crate::native_relay_proof_key::MemoryNativeRelayProofKeyVault::restore(self, owner)
    }
    fn sign(
        &self,
        owner: &NativeProofKeyOwner,
        challenge: &NativeBrokerRedemptionChallenge,
    ) -> Result<Vec<u8>, ProofKeyError> {
        crate::native_relay_proof_key::MemoryNativeRelayProofKeyVault::sign_es256_p1363(
            self, owner, challenge,
        )
    }
    fn sign_native_request(
        &self,
        owner: &NativeProofKeyOwner,
        challenge: &NativeBrokerRequestProofChallenge,
    ) -> Result<Vec<u8>, ProofKeyError> {
        crate::native_relay_proof_key::MemoryNativeRelayProofKeyVault::sign_native_request_es256_p1363(
            self, owner, challenge,
        )
    }
}

pub(crate) trait NativeBrokerTransport: Send + Sync {
    fn redeem(&self, broker_origin: &str, request_body: &[u8]) -> RedemptionResult<BrokerResponse>;
}

pub(crate) trait NativeBrokerRequestTransport: Send + Sync {
    fn send_fixed_request(
        &self,
        grant: &NativeRelayClientGrantV2,
        challenge: &NativeBrokerRequestProofChallenge,
        compact_proof: &str,
    ) -> RedemptionResult<BrokerResponse>;
}

pub(crate) struct BrokerResponse {
    status: u16,
    body: Zeroizing<Vec<u8>>,
}

pub(crate) struct UreqNativeBrokerTransport {
    timeout: Duration,
}

impl UreqNativeBrokerTransport {
    pub(crate) fn new() -> Self {
        Self {
            timeout: BROKER_REQUEST_TIMEOUT,
        }
    }

    #[cfg(test)]
    fn with_timeout(timeout: Duration) -> Self {
        Self { timeout }
    }
}

impl NativeBrokerTransport for UreqNativeBrokerTransport {
    fn redeem(&self, broker_origin: &str, request_body: &[u8]) -> RedemptionResult<BrokerResponse> {
        if request_body.len() > MAX_REQUEST_BYTES || !canonical_broker_origin(broker_origin) {
            return Err(NativeRedemptionError::InvitationInvalid);
        }
        let base =
            url::Url::parse(broker_origin).map_err(|_| NativeRedemptionError::InvitationInvalid)?;
        let target = base
            .join(REDEEM_PATH)
            .map_err(|_| NativeRedemptionError::InvitationInvalid)?;
        if target.origin().ascii_serialization() != broker_origin || target.path() != REDEEM_PATH {
            return Err(NativeRedemptionError::InvitationInvalid);
        }
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .max_redirects(0)
            .timeout_global(Some(self.timeout))
            .http_status_as_error(false)
            .build()
            .into();
        let mut response = agent
            .post(target.as_str())
            .header("Content-Type", "application/json")
            .send(request_body)
            .map_err(|_| NativeRedemptionError::BrokerTransport)?;
        let status = response.status().as_u16();
        let mut body = Zeroizing::new(Vec::new());
        let mut reader = response.body_mut().as_reader();
        let mut chunk = Zeroizing::new([0_u8; 8192]);
        loop {
            let read = reader
                .read(&mut chunk[..])
                .map_err(|_| NativeRedemptionError::BrokerTransport)?;
            if read == 0 {
                break;
            }
            if body.len().saturating_add(read) > MAX_RESPONSE_BYTES {
                return Err(NativeRedemptionError::BrokerTransport);
            }
            body.extend_from_slice(&chunk[..read]);
        }
        Ok(BrokerResponse { status, body })
    }
}

pub(crate) fn observe_superseded_scope(
    keys: &NativeRelayProofKeyVault,
    owner: &NativeProofKeyOwner,
    invitation: &NativeRelayInvitationV2,
    grant: &NativeRelayClientGrantV2,
    now: u64,
) -> RedemptionResult<NativeSupersededScopeObservation> {
    if !older_grant_matches_invitation(owner, grant, invitation) {
        return Err(NativeRedemptionError::GrantInvalid);
    }
    let public = keys
        .restore(owner)
        .map_err(|_| NativeRedemptionError::ProofKey)?;
    let input = NativeBrokerRedemptionInvitation {
        broker_origin: invitation.broker_origin.clone(),
        station_id: invitation.scope.station_id.clone(),
        enrollment_id: invitation.scope.enrollment_id.clone(),
        routing_generation: invitation.scope.routing_generation,
        station_signing_key_id: invitation.station_signing_key_id.clone(),
        station_signing_generation: invitation.station_signing_generation,
        app_identifier: invitation.surface.app_identifier.clone(),
        invitation_id: invitation.invitation_id.clone(),
        invitation_secret: Zeroizing::new(invitation.invitation_secret.expose().to_owned()),
        expires_at: invitation.expires_at,
    };
    let challenge = NativeInvitationObservationChallenge::from_invitation(
        owner,
        &public,
        &input,
        grant.scope.routing_generation,
        now / 1000,
    )
    .map_err(|_| NativeRedemptionError::InvitationInvalid)?;
    let signature = keys
        .sign_invitation_observation_es256_p1363(owner, &challenge)
        .map_err(|_| NativeRedemptionError::ProofKey)?;
    let proof = challenge
        .compact_jws(&signature)
        .map_err(|_| NativeRedemptionError::ProofKey)?;
    let target = format!(
        "{}{}",
        invitation.broker_origin, SUPERSEDED_SCOPE_OBSERVE_PATH
    );
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .timeout_global(Some(Duration::from_secs(10)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut response = agent
        .post(&target)
        .header("Content-Type", "application/json")
        .header(
            "Authorization",
            &format!("Bearer {}", invitation.invitation_secret.expose()),
        )
        .header("X-Broker-Credential-Id", &invitation.invitation_id)
        .header("X-Station-Native-Proof", &proof)
        .send(challenge.body())
        .map_err(|_| NativeRedemptionError::BrokerTransport)?;
    if response.status().as_u16() != 200 {
        return Err(NativeRedemptionError::BrokerRejected);
    }
    let mut bytes = Zeroizing::new(Vec::new());
    response
        .body_mut()
        .as_reader()
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| NativeRedemptionError::BrokerTransport)?;
    challenge
        .validate_response(&bytes)
        .map_err(|_| NativeRedemptionError::BrokerRejected)
}

fn older_grant_matches_invitation(
    owner: &NativeProofKeyOwner,
    grant: &NativeRelayClientGrantV2,
    invitation: &NativeRelayInvitationV2,
) -> bool {
    grant.broker_origin == invitation.broker_origin
        && grant.scope.station_id == invitation.scope.station_id
        && grant.scope.enrollment_id == invitation.scope.enrollment_id
        && grant.scope.routing_generation < invitation.scope.routing_generation
        && grant.surface == invitation.surface
        && grant.surface.app_identifier == owner.app_identifier()
        && grant.surface.channel == owner.channel_label()
        && grant.surface.client_instance_id == owner.client_instance_id()
}

impl NativeBrokerRequestTransport for UreqNativeBrokerTransport {
    fn send_fixed_request(
        &self,
        grant: &NativeRelayClientGrantV2,
        challenge: &NativeBrokerRequestProofChallenge,
        compact_proof: &str,
    ) -> RedemptionResult<BrokerResponse> {
        if !canonical_broker_origin(&grant.broker_origin)
            || !valid_opaque(grant.credential.secret.expose())
            || !valid_grant_id(&grant.credential.id)
            || compact_proof.is_empty()
            || compact_proof.len() > 8192
            || challenge.body().len() > MAX_REQUEST_BYTES
            || !challenge.matches_identity(&native_request_identity(grant))
        {
            return Err(NativeRedemptionError::GrantInvalid);
        }
        let path = challenge.path();
        let response_limit = if path == ICE_CONFIGURATION_PATH {
            16 * 1024
        } else {
            MAX_RESPONSE_BYTES
        };
        if !matches!(
            path,
            OPEN_PATH | READ_PATH | RETIRE_PATH | RENEW_PATH | ICE_CONFIGURATION_PATH
        ) {
            return Err(NativeRedemptionError::GrantInvalid);
        }
        let base = url::Url::parse(&grant.broker_origin)
            .map_err(|_| NativeRedemptionError::GrantInvalid)?;
        let target = base
            .join(path)
            .map_err(|_| NativeRedemptionError::GrantInvalid)?;
        if target.origin().ascii_serialization() != grant.broker_origin || target.path() != path {
            return Err(NativeRedemptionError::GrantInvalid);
        }
        let authorization = Zeroizing::new(format!("Bearer {}", grant.credential.secret.expose()));
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .max_redirects(0)
            .timeout_global(Some(self.timeout))
            .http_status_as_error(false)
            .build()
            .into();
        let mut response = agent
            .post(target.as_str())
            .header("Authorization", authorization.as_str())
            .header("X-Broker-Credential-Id", &grant.credential.id)
            .header("X-Station-Native-Proof", compact_proof)
            .header("Content-Type", "application/json")
            .send(challenge.body())
            .map_err(|_| NativeRedemptionError::BrokerTransport)?;
        let status = response.status().as_u16();
        let mut body = Zeroizing::new(Vec::new());
        let mut reader = response.body_mut().as_reader();
        let mut chunk = Zeroizing::new([0_u8; 8192]);
        loop {
            let read = reader
                .read(&mut chunk[..])
                .map_err(|_| NativeRedemptionError::BrokerTransport)?;
            if read == 0 {
                break;
            }
            if body.len().saturating_add(read) > response_limit {
                return Err(NativeRedemptionError::BrokerTransport);
            }
            body.extend_from_slice(&chunk[..read]);
        }
        Ok(BrokerResponse { status, body })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeGrantRetireReceipt {
    version: String,
    retired: bool,
}

fn validate_profile_context(context: &NativeRedemptionContext) -> RedemptionResult<()> {
    let profile = &context.profile;
    if profile.revision > JS_SAFE_INTEGER_MAX
        || profile.profile_name.is_empty()
        || profile.profile_name.len() > 128
        || !valid_app_identifier(&profile.app_identifier)
        || !valid_uuid(&profile.client_instance_id)
        || !canonical_station_origin(&profile.station_endpoint)
        || !canonical_broker_origin(&profile.broker_origin)
        || profile.station_id.len() != 36
        || !valid_uuid(&profile.station_id)
        || !valid_uuid(&profile.enrollment_id)
    {
        return Err(NativeRedemptionError::InvalidProfile);
    }
    let trust = &context.station_trust;
    if trust.status != NativeStationTrustStatus::Approved
        || trust.revision == 0
        || trust.revision > JS_SAFE_INTEGER_MAX
        || trust.station_endpoint != profile.station_endpoint
        || trust.station_id != profile.station_id
        || trust.enrollment_id != profile.enrollment_id
        || !valid_station_jwk(&trust.signing_key)
    {
        return Err(NativeRedemptionError::StationTrustRequired);
    }
    Ok(())
}

fn profile_matches_owner(
    profile: &NativeRelayProfileSnapshot,
    owner: &NativeProofKeyOwner,
) -> bool {
    profile.app_identifier == owner.app_identifier()
        && profile.channel.keyring_label() == owner.channel_label()
        && profile.client_instance_id == owner.client_instance_id()
}

pub(crate) fn validate_invitation_and_trust(
    context: &NativeRedemptionContext,
    invitation: &NativeRelayInvitationV2,
    now: u64,
    client_key: Option<&NativeProofKeyPublicMetadata>,
) -> RedemptionResult<()> {
    validate_profile_context(context)?;
    let profile = &context.profile;
    let trust = &context.station_trust;
    if invitation.version != NATIVE_INVITATION_VERSION
        || invitation.broker_origin != profile.broker_origin
        || invitation.scope.station_id != profile.station_id
        || invitation.scope.enrollment_id != profile.enrollment_id
        || invitation.scope.routing_generation == 0
        || invitation.scope.routing_generation > JS_SAFE_INTEGER_MAX
        || invitation.station_signing_generation != trust.generation
        || invitation.station_signing_generation == 0
        || invitation.station_signing_generation > JS_SAFE_INTEGER_MAX
        || invitation.station_signing_key_id != station_signing_key_id(&trust.signing_key)
        || !valid_opaque(&invitation.station_signing_key_id)
        || !valid_safe_id(&invitation.invitation_id)
        || !valid_opaque(invitation.invitation_secret.expose())
        || invitation.expires_at <= now
        || invitation.expires_at > JS_SAFE_INTEGER_MAX
        || invitation.surface.kind != "station-native"
        || invitation.surface.app_identifier != profile.app_identifier
        || invitation.surface.channel != profile.channel.keyring_label()
        || invitation.surface.client_instance_id != profile.client_instance_id
    {
        return Err(if invitation.expires_at <= now {
            NativeRedemptionError::InvitationExpired
        } else {
            NativeRedemptionError::InvitationInvalid
        });
    }
    if let Some(client_key) = client_key {
        if invitation.surface.key_thumbprint != client_key.thumbprint() {
            return Err(NativeRedemptionError::InvitationInvalid);
        }
    } else if !valid_opaque(&invitation.surface.key_thumbprint) {
        return Err(NativeRedemptionError::InvitationInvalid);
    }
    Ok(())
}

fn validate_returned_grant(
    context: &NativeRedemptionContext,
    invitation: &NativeRelayInvitationV2,
    client_key: &NativeProofKeyPublicMetadata,
    grant: &NativeRelayClientGrantV2,
    now: u64,
) -> RedemptionResult<NativeRelayGrantRoute> {
    let route = NativeRelayGrantRoute {
        broker_origin: grant.broker_origin.clone(),
        station_id: grant.scope.station_id.clone(),
        enrollment_id: grant.scope.enrollment_id.clone(),
        routing_generation: grant.scope.routing_generation,
        grant_id: grant.credential.id.clone(),
    };
    if grant.version != NATIVE_GRANT_VERSION
        || grant.broker_origin != context.profile.broker_origin
        || grant.scope != invitation.scope
        || grant.station_signing_key_id != invitation.station_signing_key_id
        || grant.station_signing_generation != invitation.station_signing_generation
        || grant.surface != invitation.surface
        || grant.proof_public_key != *client_key.jwk()
        || !valid_grant_id(&grant.credential.id)
        || !valid_opaque(grant.credential.secret.expose())
        || grant.expires_at <= now
        || grant.expires_at > now.saturating_add(MAX_GRANT_AGE_MS)
    {
        return Err(NativeRedemptionError::GrantInvalid);
    }
    Ok(route)
}

fn native_grant_metadata(
    route: NativeRelayGrantRoute,
    grant: &NativeRelayClientGrantV2,
) -> NativeRelayGrantMetadata {
    NativeRelayGrantMetadata {
        route,
        station_signing_key_id: grant.station_signing_key_id.clone(),
        station_signing_generation: grant.station_signing_generation,
        expires_at: grant.expires_at,
    }
}

fn validate_native_grant(
    owner: &NativeProofKeyOwner,
    grant: &NativeRelayClientGrantV2,
    now: u64,
) -> RedemptionResult<NativeRelayGrantRoute> {
    let route = native_route_for_grant(grant);
    if grant.version != NATIVE_GRANT_VERSION
        || !canonical_broker_origin(&grant.broker_origin)
        || !valid_uuid(&grant.scope.station_id)
        || !valid_uuid(&grant.scope.enrollment_id)
        || grant.scope.routing_generation == 0
        || grant.scope.routing_generation > JS_SAFE_INTEGER_MAX
        || !valid_grant_id(&grant.credential.id)
        || !valid_opaque(grant.credential.secret.expose())
        || grant.station_signing_generation == 0
        || grant.station_signing_generation > JS_SAFE_INTEGER_MAX
        || !valid_opaque(&grant.station_signing_key_id)
        || grant.expires_at <= now
        || grant.expires_at > now.saturating_add(MAX_GRANT_AGE_MS)
        || grant.surface.kind != "station-native"
        || grant.surface.app_identifier != owner.app_identifier()
        || grant.surface.channel != owner.channel_label()
        || grant.surface.client_instance_id != owner.client_instance_id()
        || !valid_opaque(&grant.surface.key_thumbprint)
        || !valid_station_jwk(&grant.proof_public_key)
        || station_signing_key_id(&grant.proof_public_key) != grant.surface.key_thumbprint
    {
        return Err(NativeRedemptionError::GrantInvalid);
    }
    Ok(route)
}

fn native_route_for_grant(grant: &NativeRelayClientGrantV2) -> NativeRelayGrantRoute {
    NativeRelayGrantRoute {
        broker_origin: grant.broker_origin.clone(),
        station_id: grant.scope.station_id.clone(),
        enrollment_id: grant.scope.enrollment_id.clone(),
        routing_generation: grant.scope.routing_generation,
        grant_id: grant.credential.id.clone(),
    }
}

fn validate_native_renewal_intent(
    intent: &NativeGrantRenewalIntent,
    grant: &NativeRelayClientGrantV2,
) -> RedemptionResult<()> {
    if intent.renewal_id.len() < 8
        || intent.renewal_id.len() > 128
        || !intent
            .renewal_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        || intent.expected_expires_at != grant.expires_at
        || intent.request_body.len() > MAX_REQUEST_BYTES
    {
        return Err(NativeRedemptionError::GrantRenewalConflict);
    }
    let body: NativeGrantRenewalRequestBody = serde_json::from_slice(&intent.request_body)
        .map_err(|_| NativeRedemptionError::GrantRenewalConflict)?;
    if body.version != NATIVE_RENEW_VERSION
        || body.scope != grant.scope
        || body.surface != grant.surface
        || body.renewal_id != intent.renewal_id
        || body.expected_expires_at != intent.expected_expires_at
    {
        return Err(NativeRedemptionError::GrantRenewalConflict);
    }
    Ok(())
}

fn native_request_identity(grant: &NativeRelayClientGrantV2) -> NativeBrokerRequestIdentity<'_> {
    NativeBrokerRequestIdentity {
        broker_origin: &grant.broker_origin,
        grant_id: &grant.credential.id,
        station_id: &grant.scope.station_id,
        enrollment_id: &grant.scope.enrollment_id,
        routing_generation: grant.scope.routing_generation,
        app_identifier: &grant.surface.app_identifier,
        channel: &grant.surface.channel,
        client_instance_id: &grant.surface.client_instance_id,
        key_thumbprint: &grant.surface.key_thumbprint,
        station_signing_key_id: &grant.station_signing_key_id,
        station_signing_generation: grant.station_signing_generation,
        bearer_secret: grant.credential.secret.expose(),
    }
}

fn same_native_grant(
    stored: &NativeRelayClientGrantV2,
    expected: &NativeRelayClientGrantV2,
) -> bool {
    stored.version == expected.version
        && stored.broker_origin == expected.broker_origin
        && stored.scope == expected.scope
        && stored.station_signing_key_id == expected.station_signing_key_id
        && stored.station_signing_generation == expected.station_signing_generation
        && stored.surface == expected.surface
        && stored.proof_public_key == expected.proof_public_key
        && stored.credential.id == expected.credential.id
        && stored.expires_at == expected.expires_at
        && same_grant_secret(
            stored.credential.secret.expose(),
            expected.credential.secret.expose(),
        )
}

fn native_grant_secret_digest(grant: &NativeRelayClientGrantV2) -> String {
    URL_SAFE_NO_PAD.encode(digest(&SHA256, grant.credential.secret.expose().as_bytes()))
}

fn same_grant_secret(stored: &str, expected: &str) -> bool {
    // Use ring's constant-time HMAC verification instead of String equality.
    // The fixed domain key is not secret; this comparison protects the
    // deletion decision from leaking whether a replacement bearer matches.
    let key = hmac::Key::new(hmac::HMAC_SHA256, b"station-native-grant-local-match-v1");
    let expected_tag = hmac::sign(&key, expected.as_bytes());
    hmac::verify(&key, stored.as_bytes(), expected_tag.as_ref()).is_ok()
}

fn station_signing_key_id(jwk: &P256PublicJwk) -> String {
    let canonical = format!(
        "{{\"crv\":\"{}\",\"kty\":\"{}\",\"x\":\"{}\",\"y\":\"{}\"}}",
        jwk.crv(),
        jwk.kty(),
        jwk.x(),
        jwk.y()
    );
    URL_SAFE_NO_PAD.encode(digest(&SHA256, canonical.as_bytes()))
}

fn valid_station_jwk(jwk: &P256PublicJwk) -> bool {
    jwk.kty() == "EC" && jwk.crv() == "P-256" && valid_opaque(jwk.x()) && valid_opaque(jwk.y())
}

fn valid_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
        && matches!(bytes[14].to_ascii_lowercase(), b'1'..=b'8')
        && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
}

fn valid_safe_id(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn valid_opaque(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn valid_grant_id(value: &str) -> bool {
    value.len() == 22
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn valid_app_identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value.len() <= 255
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
}

fn canonical_station_origin(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    url.origin().ascii_serialization() == value
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && (url.scheme() == "https" || (url.scheme() == "http" && is_exact_loopback(&url)))
}

fn canonical_broker_origin(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    url.origin().ascii_serialization() == value
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && (url.scheme() == "https" || (url.scheme() == "http" && is_contract_loopback(&url)))
}

fn is_exact_loopback(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain("localhost")) => true,
        Some(url::Host::Ipv4(host)) => host == Ipv4Addr::LOCALHOST,
        Some(url::Host::Ipv6(host)) => host == Ipv6Addr::LOCALHOST,
        _ => false,
    }
}

fn is_contract_loopback(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain("localhost")) => true,
        Some(url::Host::Ipv4(host)) => host == Ipv4Addr::LOCALHOST,
        Some(url::Host::Ipv6(host)) => host == Ipv6Addr::LOCALHOST,
        _ => false,
    }
}

fn snapshot_from_owned_enrollment_profile(
    store: &super::CredentialProfileStore,
    profile_name: &str,
    app_identifier: &str,
    channel: NativeProofKeyChannel,
    reference: Option<&super::NativeCredentialReference>,
) -> RedemptionResult<NativeRelayProfileSnapshot> {
    let Some(reference) = reference else {
        return snapshot_from_saved_profile(store, profile_name, app_identifier, channel);
    };
    let mut route_store = store.clone();
    let profile = route_store
        .profiles
        .iter_mut()
        .find(|profile| profile.name.eq_ignore_ascii_case(profile_name))
        .ok_or(NativeRedemptionError::InvalidProfile)?;
    if profile.credential_ref.is_some() {
        if profile.credential_ref.as_ref() != Some(reference)
            || !matches!(
                profile.configuration_state.as_str(),
                "requires-auth" | "configured"
            )
            || profile
                .relay_route
                .as_ref()
                .map(|route| route.station_id.as_str())
                != profile._environment_id.as_deref()
        {
            return Err(NativeRedemptionError::InvalidProfile);
        }
        profile.credential_ref = None;
        profile.configuration_state = "unconfigured".into();
    }
    snapshot_from_saved_profile(&route_store, profile_name, app_identifier, channel)
}

pub(crate) fn snapshot_from_saved_profile(
    store: &super::CredentialProfileStore,
    profile_name: &str,
    app_identifier: &str,
    channel: NativeProofKeyChannel,
) -> RedemptionResult<NativeRelayProfileSnapshot> {
    if store.revision > JS_SAFE_INTEGER_MAX || !valid_app_identifier(app_identifier) {
        return Err(NativeRedemptionError::InvalidProfile);
    }
    let profile = store
        .profiles
        .iter()
        .find(|profile| profile.name.eq_ignore_ascii_case(profile_name))
        .ok_or(NativeRedemptionError::InvalidProfile)?;
    let route = profile
        .relay_route
        .as_ref()
        .ok_or(NativeRedemptionError::InvalidProfile)?;
    if profile.configuration_state != "unconfigured"
        || profile.setup_source != "manual"
        || profile.credential_ref.is_some()
    {
        return Err(NativeRedemptionError::InvalidProfile);
    }
    let client_instance_id = profile
        .client_instance_id
        .clone()
        .ok_or(NativeRedemptionError::InvalidProfile)?;
    if !valid_uuid(&client_instance_id)
        || !canonical_station_origin(&profile.endpoint)
        || !canonical_broker_origin(&route.broker_origin)
        || !valid_uuid(&route.station_id)
        || !valid_uuid(&route.enrollment_id)
    {
        return Err(NativeRedemptionError::InvalidProfile);
    }
    let snapshot = NativeRelayProfileSnapshot {
        revision: store.revision,
        profile_name: profile.name.clone(),
        station_endpoint: profile.endpoint.clone(),
        broker_origin: route.broker_origin.clone(),
        station_id: route.station_id.clone(),
        enrollment_id: route.enrollment_id.clone(),
        app_identifier: app_identifier.to_owned(),
        channel,
        client_instance_id,
    };
    Ok(snapshot)
}

/// Persist a route quarantine for every v2 grant whose exact host owner/route
/// disappears from profiles.json. This runs under the caller's existing
/// profiles.json lock and performs no network I/O.
pub(crate) fn stage_removed_profile_routes(
    app: &AppHandle,
    current: &super::CredentialProfileStore,
    next: &super::CredentialProfileStore,
) -> Result<(), String> {
    let app_identifier = app.config().identifier.clone();
    let channel_label = super::native_app_channel(&app_identifier, cfg!(debug_assertions));
    let channel = match channel_label {
        "stable" => NativeProofKeyChannel::Stable,
        "beta" => NativeProofKeyChannel::Beta,
        "nightly" => NativeProofKeyChannel::Nightly,
        "dev" => NativeProofKeyChannel::Dev,
        _ => return Err("Station could not identify its native relay channel.".into()),
    };
    let vault = native_relay_grant_vault();
    let now = native_now_ms()?;
    for profile in &current.profiles {
        let Some(route) = profile.relay_route.as_ref() else {
            continue;
        };
        let Some(client_instance_id) = profile.client_instance_id.as_deref() else {
            continue;
        };
        let same_owner_route_remains = next.profiles.iter().any(|candidate| {
            candidate.relay_route.as_ref() == Some(route)
                && candidate.client_instance_id.as_deref() == Some(client_instance_id)
        });
        if same_owner_route_remains {
            continue;
        }
        let owner = NativeProofKeyOwner::new(&app_identifier, channel, client_instance_id)
            .map_err(|_| {
                "Station could not bind removed relay cleanup to this installation.".to_owned()
            })?;
        vault
            .stage_removed_profile_route_cleanup(
                &owner,
                &route.broker_origin,
                &route.station_id,
                &route.enrollment_id,
                now,
            )
            .map_err(|_| "Station could not quarantine a removed native relay grant.".to_owned())?;
    }
    Ok(())
}

/// Stage grant cleanup from a profile snapshot while its owner-only profile
/// lock is already held. This does not require Station trust to remain
/// Approved, which is essential for the pre-commit trust-revocation hook.
pub(crate) fn stage_locked_profile_routes_cleanup(
    snapshot: &LockedTrustProfileSnapshot,
    approved_bindings: &[TrustProfileBinding],
) -> Result<Vec<(NativeProofKeyOwner, Vec<NativeRelayGrantCleanupStatus>)>, CandidateError> {
    if !approved_bindings.contains(&snapshot.binding) {
        return Err(CandidateError::ProfileStale);
    }
    let vault = native_relay_grant_vault();
    let now = native_now_ms().map_err(|_| CandidateError::TrustStore)?;
    let mut unique = HashSet::new();
    let mut staged_routes = Vec::new();
    for binding in approved_bindings {
        if binding.app_identifier != snapshot.binding.app_identifier
            || binding.channel != snapshot.binding.channel
            || binding.station_id != snapshot.binding.station_id
        {
            return Err(CandidateError::TrustStore);
        }
        let channel = match binding.channel.as_str() {
            "stable" => NativeProofKeyChannel::Stable,
            "beta" => NativeProofKeyChannel::Beta,
            "nightly" => NativeProofKeyChannel::Nightly,
            "dev" => NativeProofKeyChannel::Dev,
            _ => return Err(CandidateError::ProfileStale),
        };
        let owner = NativeProofKeyOwner::new(
            &binding.app_identifier,
            channel,
            &binding.client_instance_id,
        )
        .map_err(|_| CandidateError::ProfileStale)?;
        let unique_key = (
            owner.client_instance_id().to_owned(),
            binding.broker_origin.clone(),
            binding.station_id.clone(),
            binding.enrollment_id.clone(),
        );
        if !unique.insert(unique_key) {
            continue;
        }
        let cleanups = vault
            .stage_removed_profile_route_cleanup(
                &owner,
                &binding.broker_origin,
                &binding.station_id,
                &binding.enrollment_id,
                now,
            )
            .map_err(|_| CandidateError::TrustStore)?;
        staged_routes.push((owner, cleanups));
    }
    Ok(staged_routes)
}

/// Retry the exact cleanup entries staged before a trust mutation. Failures
/// stay durably indexed and are visible through the cleanup status command.
pub(crate) fn retry_staged_profile_route_cleanup(
    app: &AppHandle,
    staged_routes: &[(NativeProofKeyOwner, Vec<NativeRelayGrantCleanupStatus>)],
) {
    let context = AppNativeRedemptionContextProvider::for_existing_route(app.clone());
    let proof_keys = NativeRelayProofKeyVault::new();
    let http = UreqNativeBrokerTransport::new();
    let grants = native_relay_grant_vault();
    let service = NativeRelayRedemptionService::new(
        &context,
        &proof_keys,
        &http,
        &grants,
        native_now_ms_or_zero,
    );
    let mut remaining = MAX_BACKGROUND_CLEANUP_RETRIES;
    for (owner, staged) in staged_routes {
        for entry in staged {
            if remaining == 0 {
                return;
            }
            let _ = service.retry_pending_cleanup(owner, &entry.cleanup_id);
            remaining -= 1;
        }
    }
}

fn native_now_ms() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .ok_or_else(|| "Station's system clock is invalid.".to_owned())
}

fn grant_index_account(owner: &NativeProofKeyOwner) -> String {
    let app_hash = URL_SAFE_NO_PAD.encode(digest(&SHA256, owner.app_identifier().as_bytes()));
    format!(
        "{GRANT_INDEX_PREFIX}{}:{app_hash}:{}",
        owner.channel_label(),
        owner.client_instance_id()
    )
}

fn grant_account(binding: &NativeRelayGrantBinding) -> RedemptionResult<String> {
    let parts = [
        binding.owner.app_identifier().to_owned(),
        binding.owner.channel_label().to_owned(),
        binding.owner.client_instance_id(),
        binding.route.broker_origin.clone(),
        binding.route.station_id.clone(),
        binding.route.enrollment_id.clone(),
        binding.route.routing_generation.to_string(),
        binding.route.grant_id.clone(),
    ];
    let mut account = GRANT_ACCOUNT_PREFIX.to_owned();
    for part in parts {
        account.push_str(&part.len().to_string());
        account.push(':');
        account.push_str(&part);
        account.push(':');
    }
    if account.len() > 2048 {
        return Err(NativeRedemptionError::GrantInvalid);
    }
    Ok(account)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::mpsc::{self, Receiver, Sender};

    const NOW: u64 = 1_700_000_000_000;
    const STATION_ID: &str = "11111111-1111-4111-8111-111111111111";
    const ENROLLMENT_ID: &str = "22222222-2222-4222-8222-222222222222";
    const INSTANCE_ID: &str = "33333333-3333-4333-8333-333333333333";

    #[test]
    fn enrollment_route_survives_only_its_owned_profile_publication() {
        let reference = super::super::NativeCredentialReference {
            kind: "station-bearer".into(),
            id: format!("native-enrollment:{}", uuid::Uuid::new_v4()),
        };
        let fresh = serde_json::json!({
            "schemaVersion": 1, "revision": 1, "defaultProfile": null, "projectProfiles": {},
            "profiles": [{"schemaVersion": 1, "name": "relay", "endpoint": "https://station.example",
                "relayRoute": {"brokerOrigin": "https://broker.example", "stationId": STATION_ID,
                    "enrollmentId": ENROLLMENT_ID}, "clientInstanceId": INSTANCE_ID,
                "setupSource": "manual", "configurationState": "unconfigured", "createdAt": 1, "updatedAt": 1}]
        }).to_string();
        let store = super::super::parse_station_profile_store(&fresh).unwrap();
        let original = snapshot_from_saved_profile(
            &store,
            "relay",
            "io.kontourai.station.dev.instance",
            NativeProofKeyChannel::Dev,
        )
        .unwrap();
        for state in ["requires-auth", "configured"] {
            let published = super::super::native_enrollment_next_store(
                &store,
                "relay",
                &reference,
                STATION_ID,
                INSTANCE_ID,
                state,
            )
            .unwrap();
            let published = super::super::parse_station_profile_store(&published).unwrap();
            assert!(snapshot_from_saved_profile(
                &published,
                "relay",
                "io.kontourai.station.dev.instance",
                NativeProofKeyChannel::Dev
            )
            .is_err());
            let route = snapshot_from_owned_enrollment_profile(
                &published,
                "relay",
                "io.kontourai.station.dev.instance",
                NativeProofKeyChannel::Dev,
                Some(&reference),
            )
            .unwrap();
            assert_eq!(route.station_id, original.station_id);
            assert_eq!(route.enrollment_id, original.enrollment_id);
            assert_eq!(route.client_instance_id, original.client_instance_id);
            assert_eq!(route.revision, published.revision);
            let foreign = super::super::NativeCredentialReference {
                kind: reference.kind.clone(),
                id: format!("native-enrollment:{}", uuid::Uuid::new_v4()),
            };
            assert!(snapshot_from_owned_enrollment_profile(
                &published,
                "relay",
                "io.kontourai.station.dev.instance",
                NativeProofKeyChannel::Dev,
                Some(&foreign)
            )
            .is_err());
            let mut replaced = published.clone();
            replaced.profiles[0]._environment_id = Some(ENROLLMENT_ID.into());
            assert!(snapshot_from_owned_enrollment_profile(
                &replaced,
                "relay",
                "io.kontourai.station.dev.instance",
                NativeProofKeyChannel::Dev,
                Some(&reference)
            )
            .is_err());
        }
    }

    struct MemoryAuthority(Mutex<NativeRedemptionContext>);

    impl NativeRedemptionContextProvider for MemoryAuthority {
        fn with_current_context<T>(
            &self,
            profile_name: &str,
            operation: impl FnOnce(NativeRedemptionContext) -> RedemptionResult<T>,
        ) -> RedemptionResult<T> {
            let current = self
                .0
                .lock()
                .map_err(|_| NativeRedemptionError::InvalidProfile)?;
            if current.profile.profile_name != profile_name {
                return Err(NativeRedemptionError::InvalidProfile);
            }
            operation(current.clone())
        }
    }

    struct NeverTransport(AtomicBool);

    impl NativeBrokerTransport for NeverTransport {
        fn redeem(&self, _: &str, _: &[u8]) -> RedemptionResult<BrokerResponse> {
            self.0.store(true, Ordering::SeqCst);
            Err(NativeRedemptionError::BrokerTransport)
        }
    }

    impl NativeBrokerRequestTransport for NeverTransport {
        fn send_fixed_request(
            &self,
            _: &NativeRelayClientGrantV2,
            _: &NativeBrokerRequestProofChallenge,
            _: &str,
        ) -> RedemptionResult<BrokerResponse> {
            self.0.store(true, Ordering::SeqCst);
            Err(NativeRedemptionError::BrokerTransport)
        }
    }

    struct NativeSignalTransport {
        authority: Arc<MemoryAuthority>,
        status: u16,
        response_body: Vec<u8>,
        mutate_profile_after_request: bool,
        return_transport_error: bool,
        observed: Mutex<Option<(String, Vec<u8>, bool)>>,
    }

    impl NativeBrokerRequestTransport for NativeSignalTransport {
        fn send_fixed_request(
            &self,
            grant: &NativeRelayClientGrantV2,
            challenge: &NativeBrokerRequestProofChallenge,
            compact_proof: &str,
        ) -> RedemptionResult<BrokerResponse> {
            assert_eq!(grant.broker_origin, "https://broker.example");
            let body = challenge.body().to_vec();
            let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert!(parsed.get("credential").is_none());
            assert!(parsed.get("proofKey").is_none());
            let proof_shape_valid = compact_proof.split('.').count() == 3;
            *self
                .observed
                .lock()
                .map_err(|_| NativeRedemptionError::BrokerTransport)? =
                Some((challenge.path().to_owned(), body, proof_shape_valid));
            if self.mutate_profile_after_request {
                let mut current = self
                    .authority
                    .0
                    .lock()
                    .map_err(|_| NativeRedemptionError::StaleProfile)?;
                current.profile.revision += 1;
            }
            if self.return_transport_error {
                return Err(NativeRedemptionError::BrokerTransport);
            }
            Ok(BrokerResponse {
                status: self.status,
                body: Zeroizing::new(self.response_body.clone()),
            })
        }
    }

    fn native_signal_service<'a, H: NativeBrokerRequestTransport>(
        prepared: &'a Prepared,
        transport: &'a H,
        grants: &'a NativeRelayGrantVault<MemoryNativeGrantBackend>,
    ) -> NativeRelaySignalService<
        'a,
        MemoryAuthority,
        crate::native_relay_proof_key::MemoryNativeRelayProofKeyVault,
        H,
        NativeRelayGrantVault<MemoryNativeGrantBackend>,
        impl Fn() -> u64,
    > {
        NativeRelaySignalService::new(
            prepared.authority.as_ref(),
            &prepared.proof_keys,
            transport,
            grants,
            || NOW,
        )
    }

    fn stored_signal_grant(prepared: &Prepared) -> NativeRelayGrantVault<MemoryNativeGrantBackend> {
        stored_signal_grant_until(prepared, NOW + 3_600_000)
    }

    fn stored_signal_grant_until(
        prepared: &Prepared,
        expires_at: u64,
    ) -> NativeRelayGrantVault<MemoryNativeGrantBackend> {
        let grants = NativeRelayGrantVault::new(MemoryNativeGrantBackend::default());
        let grant = sample_grant(prepared, expires_at);
        grants.store(&prepared.owner, &grant, NOW).unwrap();
        grants
    }

    struct NativeRenewTransport {
        drop_first_response: AtomicBool,
        seen_renewal_ids: Mutex<Vec<String>>,
    }

    impl NativeBrokerRequestTransport for NativeRenewTransport {
        fn send_fixed_request(
            &self,
            grant: &NativeRelayClientGrantV2,
            challenge: &NativeBrokerRequestProofChallenge,
            compact_proof: &str,
        ) -> RedemptionResult<BrokerResponse> {
            assert_eq!(challenge.path(), RENEW_PATH);
            assert_eq!(compact_proof.split('.').count(), 3);
            let body: NativeGrantRenewalRequestBody =
                serde_json::from_slice(challenge.body()).unwrap();
            assert_eq!(body.scope, grant.scope);
            assert_eq!(body.surface, grant.surface);
            assert_eq!(body.expected_expires_at, grant.expires_at);
            self.seen_renewal_ids
                .lock()
                .unwrap()
                .push(body.renewal_id.clone());
            if self.drop_first_response.swap(false, Ordering::SeqCst) {
                return Err(NativeRedemptionError::BrokerTransport);
            }
            let receipt = NativeGrantRenewalReceipt {
                version: NATIVE_RENEWED_VERSION.to_owned(),
                renewal_id: body.renewal_id,
                expires_at: NOW + MAX_GRANT_AGE_MS,
            };
            Ok(BrokerResponse {
                status: 200,
                body: Zeroizing::new(serde_json::to_vec(&receipt).unwrap()),
            })
        }
    }

    #[test]
    fn explicit_recovery_uses_distinct_durable_scope_basis_and_preserves_individual_retirement() {
        for individual in [false, true] {
            let mut prepared = prepared("https://broker.example".into(), 7);
            let grants = stored_signal_grant_until(
                &prepared,
                if individual {
                    NOW + 1_000
                } else {
                    NOW + 3_600_000
                },
            );
            let mut foreign = sample_grant(&prepared, NOW + 3_600_000);
            foreign.scope.station_id = "44444444-4444-4444-8444-444444444444".into();
            foreign.credential.id = "F".repeat(22);
            grants.store(&prepared.owner, &foreign, NOW).unwrap();
            prepared.invitation.scope.routing_generation = if individual { 9 } else { 10 };
            let cancelled = AtomicBool::new(false);
            let gate = Mutex::new(());
            let normal = SuccessfulRetirement;
            let failed = NeverTransport(AtomicBool::new(false));
            let observe = |_: &NativeProofKeyOwner,
                           grant: &NativeRelayClientGrantV2|
             -> RedemptionResult<NativeSupersededScopeObservation> {
                assert!(
                    !individual,
                    "same-generation retirement must not use observation"
                );
                assert!(!grants.pending_cleanups(&prepared.owner).unwrap().is_empty());
                Ok(NativeSupersededScopeObservation {
                    version: "station-broker-native-superseded-scope-observed/v1".into(),
                    request_nonce: "A".repeat(43),
                    scope: crate::native_relay_proof_key::NativeObservedScope {
                        station_id: grant.scope.station_id.clone(),
                        enrollment_id: grant.scope.enrollment_id.clone(),
                        routing_generation: grant.scope.routing_generation,
                    },
                    disposition: "superseded-generation-not-admitted".into(),
                    lease_revision: 2,
                })
            };
            let outcomes = if individual {
                NativeRelayRedemptionService::new(
                    prepared.authority.as_ref(),
                    &prepared.proof_keys,
                    &normal,
                    &grants,
                    || NOW + 2_000,
                )
                .recover_link_cleanup(
                    "Local",
                    7,
                    &prepared.invitation,
                    observe,
                    (&cancelled, &gate),
                )
                .unwrap()
            } else {
                NativeRelayRedemptionService::new(
                    prepared.authority.as_ref(),
                    &prepared.proof_keys,
                    &failed,
                    &grants,
                    || NOW + 2_000,
                )
                .recover_link_cleanup(
                    "Local",
                    7,
                    &prepared.invitation,
                    observe,
                    (&cancelled, &gate),
                )
                .unwrap()
            };
            assert_eq!(outcomes.len(), 1);
            assert!(outcomes[0].local_cleanup_complete);
            assert_eq!(
                matches!(
                    outcomes[0].remote_basis,
                    Some(NativeCleanupRemoteBasis::IndividualGrantRetired)
                ),
                individual
            );
            assert!(grants.pending_cleanups(&prepared.owner).unwrap().is_empty());
            assert!(grants
                .metadata_for_profile_route(
                    &prepared.owner,
                    "https://broker.example",
                    STATION_ID,
                    ENROLLMENT_ID,
                    NOW
                )
                .unwrap()
                .is_empty());
            assert_eq!(
                grants
                    .metadata_for_profile_route(
                        &prepared.owner,
                        "https://broker.example",
                        &foreign.scope.station_id,
                        ENROLLMENT_ID,
                        NOW
                    )
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(prepared.authority.0.lock().unwrap().profile.revision, 7);
            assert_eq!(
                prepared.authority.0.lock().unwrap().station_trust.status,
                NativeStationTrustStatus::Approved
            );
        }
    }

    struct ReplacedProofKey<'a> {
        original: &'a crate::native_relay_proof_key::MemoryNativeRelayProofKeyVault,
        replacement: NativeProofKeyPublicMetadata,
        changed: AtomicBool,
    }
    impl NativeProofKeyOperations for ReplacedProofKey<'_> {
        fn restore(
            &self,
            owner: &NativeProofKeyOwner,
        ) -> Result<NativeProofKeyPublicMetadata, ProofKeyError> {
            if self.changed.load(Ordering::Acquire) {
                Ok(self.replacement.clone())
            } else {
                self.original.restore(owner)
            }
        }
        fn sign(
            &self,
            owner: &NativeProofKeyOwner,
            challenge: &NativeBrokerRedemptionChallenge,
        ) -> Result<Vec<u8>, ProofKeyError> {
            self.original.sign_es256_p1363(owner, challenge)
        }
        fn sign_native_request(
            &self,
            owner: &NativeProofKeyOwner,
            challenge: &NativeBrokerRequestProofChallenge,
        ) -> Result<Vec<u8>, ProofKeyError> {
            self.original
                .sign_native_request_es256_p1363(owner, challenge)
        }
    }

    #[test]
    fn recovery_rechecks_profile_key_cancellation_and_exact_vault_after_observation() {
        for refusal in [
            "profile",
            "key",
            "cancel",
            "replacement",
            "journal",
            "delete",
            "unsupported",
            "foreign-observation",
        ] {
            let mut prepared = prepared("https://broker.example".into(), 7);
            let grants = stored_signal_grant(&prepared);
            let original_binding = NativeRelayGrantBinding {
                owner: prepared.owner.clone(),
                route: native_route_for_grant(&sample_grant(&prepared, NOW + 3_600_000)),
            };
            prepared.invitation.scope.routing_generation = 10;
            let cancelled = AtomicBool::new(false);
            let gate = Mutex::new(());
            let transport = NeverTransport(AtomicBool::new(false));
            let replacement_vault =
                crate::native_relay_proof_key::MemoryNativeRelayProofKeyVault::new();
            let keys = ReplacedProofKey {
                original: &prepared.proof_keys,
                replacement: replacement_vault.create(&prepared.owner).unwrap(),
                changed: AtomicBool::new(false),
            };
            let outcomes = NativeRelayRedemptionService::new(
                prepared.authority.as_ref(),
                &keys,
                &transport,
                &grants,
                || NOW,
            )
            .recover_link_cleanup(
                "Local",
                7,
                &prepared.invitation,
                |_, grant| {
                    if refusal == "profile" {
                        prepared.authority.0.lock().unwrap().profile.revision += 1;
                    }
                    if refusal == "key" {
                        keys.changed.store(true, Ordering::Release);
                    }
                    if refusal == "cancel" {
                        cancelled.store(true, Ordering::Release);
                    }
                    if refusal == "replacement" {
                        let mut replacement = sample_grant(&prepared, NOW + 3_600_000);
                        replacement.scope = grant.scope.clone();
                        replacement.credential.secret = SecretText(Zeroizing::new("R".repeat(43)));
                        let binding = NativeRelayGrantBinding {
                            owner: prepared.owner.clone(),
                            route: native_route_for_grant(&replacement),
                        };
                        let encoded = serde_json::to_string(&StoredNativeRelayGrantV2Ref {
                            schema_version: 1,
                            binding: binding.clone(),
                            grant: &replacement,
                            renewal_intent: None,
                        })
                        .unwrap();
                        grants
                            .backend
                            .lock()
                            .unwrap()
                            .shared
                            .lock()
                            .unwrap()
                            .values
                            .insert(native_grant_account(&binding).unwrap(), encoded);
                    }
                    if refusal == "journal" {
                        let backend = grants.backend.lock().unwrap();
                        let mut shared = backend.shared.lock().unwrap();
                        shared.fail_set_number = Some(shared.sets + 1);
                    }
                    if refusal == "delete" {
                        let backend = grants.backend.lock().unwrap();
                        let mut shared = backend.shared.lock().unwrap();
                        shared.fail_delete_number = Some(shared.deletes + 1);
                    }
                    if refusal == "unsupported" {
                        return Err(NativeRedemptionError::BrokerRejected);
                    }
                    Ok(NativeSupersededScopeObservation {
                        version: "station-broker-native-superseded-scope-observed/v1".into(),
                        request_nonce: "A".repeat(43),
                        scope: crate::native_relay_proof_key::NativeObservedScope {
                            station_id: if refusal == "foreign-observation" {
                                "44444444-4444-4444-8444-444444444444".into()
                            } else {
                                grant.scope.station_id.clone()
                            },
                            enrollment_id: grant.scope.enrollment_id.clone(),
                            routing_generation: grant.scope.routing_generation,
                        },
                        disposition: "superseded-generation-not-admitted".into(),
                        lease_revision: 2,
                    })
                },
                (&cancelled, &gate),
            )
            .unwrap();
            assert!(!outcomes[0].local_cleanup_complete, "{refusal}");
            assert!(outcomes[0].failure.is_some(), "{refusal}");
            assert!(!grants.pending_cleanups(&prepared.owner).unwrap().is_empty());
            assert!(
                grants
                    .backend
                    .lock()
                    .unwrap()
                    .get(&native_grant_account(&original_binding).unwrap())
                    .unwrap()
                    .is_some(),
                "{refusal}"
            );
            if refusal == "replacement" {
                let stored = grants
                    .backend
                    .lock()
                    .unwrap()
                    .get(&native_grant_account(&original_binding).unwrap())
                    .unwrap()
                    .unwrap();
                let stored: StoredNativeRelayGrantV2 = serde_json::from_str(&stored).unwrap();
                assert_eq!(stored.grant.credential.secret.expose(), "R".repeat(43));
            }
            if refusal == "delete" {
                let pending = grants.pending_cleanups(&prepared.owner).unwrap();
                assert!(!pending[0].broker_retired);
                assert!(matches!(
                    pending[0].remote_basis,
                    Some(NativeCleanupRemoteBasis::SupersededGenerationObserved { .. })
                ));
                let backend = grants.backend.lock().unwrap().clone();
                backend.shared.lock().unwrap().fail_delete_number = None;
                let restarted = NativeRelayGrantVault::new(backend);
                transport.0.store(false, Ordering::Release);
                NativeRelayRedemptionService::new(
                    prepared.authority.as_ref(),
                    &keys,
                    &transport,
                    &restarted,
                    || NOW,
                )
                .retry_pending_cleanup(&prepared.owner, &pending[0].cleanup_id)
                .unwrap();
                assert!(!transport.0.load(Ordering::Acquire));
                assert!(restarted
                    .pending_cleanups(&prepared.owner)
                    .unwrap()
                    .is_empty());
            }
        }
    }

    struct BlockingRecoveryRestore<'a> {
        original: &'a crate::native_relay_proof_key::MemoryNativeRelayProofKeyVault,
        calls: std::sync::atomic::AtomicUsize,
        reached: Sender<()>,
        release: Mutex<Receiver<()>>,
    }
    impl NativeProofKeyOperations for BlockingRecoveryRestore<'_> {
        fn restore(
            &self,
            owner: &NativeProofKeyOwner,
        ) -> Result<NativeProofKeyPublicMetadata, ProofKeyError> {
            if self.calls.fetch_add(1, Ordering::SeqCst) == 1 {
                self.reached.send(()).map_err(|_| ProofKeyError::Store)?;
                self.release
                    .lock()
                    .map_err(|_| ProofKeyError::Store)?
                    .recv_timeout(Duration::from_secs(3))
                    .map_err(|_| ProofKeyError::Store)?;
            }
            self.original.restore(owner)
        }
        fn sign(
            &self,
            owner: &NativeProofKeyOwner,
            challenge: &NativeBrokerRedemptionChallenge,
        ) -> Result<Vec<u8>, ProofKeyError> {
            self.original.sign_es256_p1363(owner, challenge)
        }
        fn sign_native_request(
            &self,
            owner: &NativeProofKeyOwner,
            challenge: &NativeBrokerRequestProofChallenge,
        ) -> Result<Vec<u8>, ProofKeyError> {
            self.original
                .sign_native_request_es256_p1363(owner, challenge)
        }
    }

    #[test]
    fn pending_replacement_during_blocking_restore_refuses_old_journal_deletion_and_success() {
        let mut prepared = prepared("https://broker.example".into(), 7);
        let grants = stored_signal_grant(&prepared);
        let binding = NativeRelayGrantBinding {
            owner: prepared.owner.clone(),
            route: native_route_for_grant(&sample_grant(&prepared, NOW + 3_600_000)),
        };
        prepared.invitation.scope.routing_generation = 10;
        let (reached_tx, reached_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let keys = BlockingRecoveryRestore {
            original: &prepared.proof_keys,
            calls: std::sync::atomic::AtomicUsize::new(0),
            reached: reached_tx,
            release: Mutex::new(release_rx),
        };
        let cancelled = AtomicBool::new(false);
        let gate = Mutex::new(());
        let transport = NeverTransport(AtomicBool::new(false));
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                NativeRelayRedemptionService::new(
                    prepared.authority.as_ref(),
                    &keys,
                    &transport,
                    &grants,
                    || NOW,
                )
                .recover_link_cleanup(
                    "Local",
                    7,
                    &prepared.invitation,
                    |_, grant| {
                        Ok(NativeSupersededScopeObservation {
                            version: "station-broker-native-superseded-scope-observed/v1".into(),
                            request_nonce: "A".repeat(43),
                            scope: crate::native_relay_proof_key::NativeObservedScope {
                                station_id: grant.scope.station_id.clone(),
                                enrollment_id: grant.scope.enrollment_id.clone(),
                                routing_generation: grant.scope.routing_generation,
                            },
                            disposition: "superseded-generation-not-admitted".into(),
                            lease_revision: 1,
                        })
                    },
                    (&cancelled, &gate),
                )
            });
            reached_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            let replacement_commit = gate
                .try_lock()
                .expect("pending replacement must remain nonblocking during key restore");
            cancelled.store(true, Ordering::Release);
            drop(replacement_commit);
            release_tx.send(()).unwrap();
            let outcomes = worker.join().unwrap().unwrap();
            assert!(!outcomes[0].local_cleanup_complete);
            assert_eq!(
                outcomes[0].failure,
                Some(NativeRedemptionError::StaleProfile)
            );
            let pending = grants.pending_cleanups(&prepared.owner).unwrap();
            assert!(pending[0].remote_basis.is_none());
            assert!(!pending[0].broker_retired);
            assert!(grants
                .backend
                .lock()
                .unwrap()
                .get(&native_grant_account(&binding).unwrap())
                .unwrap()
                .is_some());
        });
    }

    #[test]
    fn same_route_pending_cleanup_refuses_before_request_gate_and_http_but_foreign_cleanup_does_not(
    ) {
        for foreign in [false, true] {
            let prepared = prepared("https://broker.example".into(), 7);
            let grants = stored_signal_grant(&prepared);
            let mut grant = sample_grant(&prepared, NOW + 3_600_000);
            if foreign {
                grant.scope.station_id = "44444444-4444-4444-8444-444444444444".into();
                grant.credential.id = "F".repeat(22);
                grants.store(&prepared.owner, &grant, NOW).unwrap();
            }
            grants
                .stage_cleanup(&prepared.owner, &grant, true, NOW)
                .unwrap();
            let transport = NeverTransport(AtomicBool::new(false));
            let consumed = AtomicBool::new(false);
            let failure = NativeRelayRedemptionService::new(
                prepared.authority.as_ref(),
                &prepared.proof_keys,
                &transport,
                &grants,
                || NOW,
            )
            .redeem_with_request_gate("Local", 7, prepared.invitation, None, || {
                consumed.store(true, Ordering::Release);
                Ok(())
            })
            .unwrap_err();
            assert_eq!(transport.0.load(Ordering::Acquire), foreign);
            assert_eq!(consumed.load(Ordering::Acquire), foreign);
            assert_eq!(
                failure.primary,
                if foreign {
                    NativeRedemptionError::BrokerTransport
                } else {
                    NativeRedemptionError::GrantStore
                }
            );
        }
    }

    #[test]
    fn equal_and_future_generation_failures_remain_pending_without_observation() {
        for current in [8, 9] {
            let mut prepared = prepared("https://broker.example".into(), 7);
            let grants = stored_signal_grant(&prepared);
            prepared.invitation.scope.routing_generation = current;
            let transport = NeverTransport(AtomicBool::new(false));
            let cancelled = AtomicBool::new(false);
            let gate = Mutex::new(());
            let outcomes = NativeRelayRedemptionService::new(
                prepared.authority.as_ref(),
                &prepared.proof_keys,
                &transport,
                &grants,
                || NOW,
            )
            .recover_link_cleanup(
                "Local",
                7,
                &prepared.invitation,
                |_, _| panic!("equal/future scope must not be observed"),
                (&cancelled, &gate),
            )
            .unwrap();
            assert!(!outcomes[0].local_cleanup_complete);
            assert!(outcomes[0].remote_basis.is_none());
        }
    }

    #[test]
    fn native_renewal_reuses_durable_intent_after_lost_response() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let grants = stored_signal_grant_until(&prepared, NOW + 12 * 60 * 60 * 1000);
        let transport = NativeRenewTransport {
            drop_first_response: AtomicBool::new(true),
            seen_renewal_ids: Mutex::new(Vec::new()),
        };
        let service = native_signal_service(&prepared, &transport, &grants);
        assert_eq!(
            service.renew("Local", 7),
            Err(NativeRedemptionError::BrokerTransport)
        );
        let pending = grants
            .load_request_grant(
                &prepared.owner,
                &prepared.authority.0.lock().unwrap(),
                NOW,
                true,
            )
            .unwrap();
        assert!(pending.renewal_intent.is_some());
        let metadata = service.renew("Local", 7).unwrap();
        assert_eq!(metadata.expires_at, NOW + MAX_GRANT_AGE_MS);
        let completed = grants
            .load_request_grant(
                &prepared.owner,
                &prepared.authority.0.lock().unwrap(),
                NOW,
                true,
            )
            .unwrap();
        assert!(completed.renewal_intent.is_none());
        let seen = transport.seen_renewal_ids.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0], seen[1]);
    }

    #[test]
    fn native_renewal_recovers_receipt_after_original_grace_ends() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let grants = NativeRelayGrantVault::new(MemoryNativeGrantBackend::default());
        let old_expiry = NOW - NATIVE_GRANT_RENEWAL_GRACE_MS + 3_600_000;
        let original = sample_grant(&prepared, old_expiry);
        grants
            .store(&prepared.owner, &original, old_expiry - 3_600_000)
            .unwrap();
        let transport = NativeRenewTransport {
            drop_first_response: AtomicBool::new(true),
            seen_renewal_ids: Mutex::new(Vec::new()),
        };
        let clock = AtomicU64::new(NOW);
        let service = NativeRelaySignalService::new(
            prepared.authority.as_ref(),
            &prepared.proof_keys,
            &transport,
            &grants,
            || clock.load(Ordering::SeqCst),
        );
        assert_eq!(
            service.renew("Local", 7),
            Err(NativeRedemptionError::BrokerTransport)
        );
        clock.store(NOW + 2 * 3_600_000, Ordering::SeqCst);
        assert!(clock.load(Ordering::SeqCst) > old_expiry + NATIVE_GRANT_RENEWAL_GRACE_MS);
        let renewed = service.renew("Local", 7).unwrap();
        assert_eq!(renewed.expires_at, NOW + MAX_GRANT_AGE_MS);
        let seen = transport.seen_renewal_ids.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0], seen[1]);
    }

    #[test]
    fn native_renewal_grace_does_not_enable_expired_open_until_receipt_commits() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let grants = NativeRelayGrantVault::new(MemoryNativeGrantBackend::default());
        let expired = sample_grant(&prepared, NOW - 1_000);
        grants
            .store(&prepared.owner, &expired, NOW - 3_600_000)
            .unwrap();
        let context = prepared.authority.0.lock().unwrap().clone();
        assert!(grants
            .load_request_grant(&prepared.owner, &context, NOW, false)
            .is_err());
        let transport = NativeRenewTransport {
            drop_first_response: AtomicBool::new(false),
            seen_renewal_ids: Mutex::new(Vec::new()),
        };
        native_signal_service(&prepared, &transport, &grants)
            .renew("Local", 7)
            .unwrap();
        assert!(grants
            .load_request_grant(&prepared.owner, &context, NOW, false)
            .is_ok());
    }

    #[test]
    fn native_renewal_rechecks_profile_even_after_transport_failure() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let grants = stored_signal_grant_until(&prepared, NOW + 12 * 60 * 60 * 1000);
        let transport = NativeSignalTransport {
            authority: Arc::clone(&prepared.authority),
            status: 200,
            response_body: Vec::new(),
            mutate_profile_after_request: true,
            return_transport_error: true,
            observed: Mutex::new(None),
        };
        assert_eq!(
            native_signal_service(&prepared, &transport, &grants).renew("Local", 7),
            Err(NativeRedemptionError::StaleProfile)
        );
        assert_eq!(
            transport.observed.lock().unwrap().as_ref().unwrap().0,
            RENEW_PATH
        );
    }

    #[test]
    fn grant_status_revision_is_secret_free_and_rejects_renewal_after_profile_change() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let status = {
            let context = prepared.authority.0.lock().unwrap();
            NativeRelayGrantState::for_saved_profile(&context.profile, Vec::new(), Vec::new())
        };
        let status_json = serde_json::to_value(&status).unwrap();
        assert_eq!(status_json["profileRevision"], 7);
        assert!(status_json.get("credential").is_none());
        assert!(!status_json.to_string().contains("secret"));

        let grants = stored_signal_grant_until(&prepared, NOW + 12 * 60 * 60 * 1000);
        let transport = NativeSignalTransport {
            authority: Arc::clone(&prepared.authority),
            status: 200,
            response_body: Vec::new(),
            mutate_profile_after_request: false,
            return_transport_error: false,
            observed: Mutex::new(None),
        };
        prepared.authority.0.lock().unwrap().profile.revision += 1;

        assert_eq!(
            native_signal_service(&prepared, &transport, &grants)
                .renew("Local", status.profile_revision),
            Err(NativeRedemptionError::StaleProfile)
        );
        assert!(transport.observed.lock().unwrap().is_none());
    }

    #[test]
    fn application_signaling_commands_share_the_diagnostic_host_path_and_registration() {
        // The application seam is a naming alias over the same host-owned
        // service path, so its registration and custody boundary must stay
        // pinned next to the diagnostic commands they mirror.
        let lib = include_str!("lib.rs");
        for command in [
            "native_relay_redemption::station_native_relay_diagnostic_binding",
            "native_relay_redemption::station_native_relay_signal_diagnostic_open",
            "native_relay_redemption::station_native_relay_signal_diagnostic_read",
            "native_relay_redemption::station_native_relay_application_binding",
            "native_relay_redemption::station_native_relay_application_open",
            "native_relay_redemption::station_native_relay_application_read",
        ] {
            assert!(
                lib.contains(&format!("        {command},")),
                "signaling command not registered in lib.rs: {command}"
            );
        }
    }

    #[test]
    fn device_candidate_ipc_is_native_registered_and_keeps_the_main_window_guard() {
        let lib = include_str!("lib.rs");
        assert!(lib.contains("native_relay_redemption::station_native_device_binding_candidate,"));
        let mobile_handlers = lib
            .split("#[cfg(mobile)]\n    let builder = builder.invoke_handler")
            .nth(1)
            .expect("the mobile handler exists")
            .split("]);")
            .next()
            .expect("the mobile handler is bounded");
        assert!(mobile_handlers.contains("station_native_device_binding_candidate"));

        let command_file = include_str!("native_relay_redemption.rs");
        let command_start = command_file
            .find("pub(crate) async fn station_native_device_binding_candidate(")
            .expect("the candidate command is defined");
        let command_body = &command_file[command_start..];
        assert!(command_body
            .split("\n#[tauri::command")
            .next()
            .expect("the command body is bounded")
            .contains("require_main_app_window(&window, &app)"));
    }

    #[test]
    fn device_receipt_ipc_is_native_registered_and_cached_status_is_not_fresh() {
        let lib = include_str!("lib.rs");
        assert!(
            lib.contains("native_relay_redemption::station_native_device_binding_self_receipt,")
        );
        let mobile_handlers = lib
            .split("#[cfg(mobile)]\n    let builder = builder.invoke_handler")
            .nth(1)
            .expect("the mobile handler exists")
            .split("]);")
            .next()
            .expect("the mobile handler is bounded");
        assert!(mobile_handlers.contains("station_native_device_binding_self_receipt"));

        let status = cached_receipt_status(Some(
            crate::native_device_binding_candidate::NativeDeviceReceiptObservationV1 {
                status:
                    crate::native_device_binding_candidate::NativeDeviceReceiptObservation::Current,
                observed_at_ms: 1_800_000_000_000,
            },
        ))
        .unwrap();
        assert_eq!(
            status.status,
            crate::native_device_binding_candidate::NativeDeviceBindingSelfReceiptStatus::PreviouslyConfirmedCurrent
        );
        assert_eq!(
            status.source,
            crate::native_device_binding_candidate::NativeDeviceReceiptStatusSource::CachedObservation
        );
        assert_eq!(status.observed_at_ms, 1_800_000_000_000);
        assert!(status.receipt.is_none());
        assert!(cached_receipt_status(Some(
            crate::native_device_binding_candidate::NativeDeviceReceiptObservationV1 {
                status: crate::native_device_binding_candidate::NativeDeviceReceiptObservation::Unavailable,
                observed_at_ms: 1_800_000_000_000,
            },
        ))
        .is_none());
    }

    #[test]
    fn device_receipt_target_is_derived_from_the_exact_station_and_candidate_id() {
        assert_eq!(
            native_device_self_receipt_url(
                "https://station.example.test",
                "11111111-1111-4111-8111-111111111111"
            )
            .unwrap(),
            "https://station.example.test/api/auth/native-device-bindings/11111111-1111-4111-8111-111111111111/receipt"
        );
        assert!(native_device_self_receipt_url(
            "https://user@station.example.test",
            "11111111-1111-4111-8111-111111111111"
        )
        .is_err());
        assert!(native_device_self_receipt_url(
            "https://station.example.test",
            "../../other-route"
        )
        .is_err());
    }

    #[test]
    fn receipt_single_flight_refuses_a_second_operation_without_waiting() {
        let current = try_native_device_receipt_operation().unwrap();
        let started = std::time::Instant::now();
        let refusal = try_native_device_receipt_operation()
            .expect_err("the active receipt read owns the process single-flight");
        assert_eq!(
            refusal,
            "Station is already checking a Device binding receipt"
        );
        assert!(started.elapsed() < Duration::from_millis(100));
        drop(current);
        assert!(try_native_device_receipt_operation().is_ok());
    }

    #[test]
    fn receipt_404_requires_the_exact_versioned_closed_not_found_envelope() {
        let valid = serde_json::json!({
            "error": {
                "version": "station-native-device-proof-self-receipt-error/v1",
                "code": "not_found",
            }
        });
        assert_eq!(
            exact_native_self_receipt_error(&serde_json::to_vec(&valid).unwrap()),
            Some(NativeDeviceSelfReceiptErrorCode::NotFound)
        );

        for invalid in [
            serde_json::json!({ "error": { "code": "not_found" } }),
            serde_json::json!({
                "error": {
                    "version": "station-native-device-proof-self-receipt-error/v1",
                    "code": "not_found",
                    "extra": true,
                }
            }),
            serde_json::json!({
                "error": {
                    "version": "station-native-device-proof-self-receipt-error/v1",
                    "code": "not_found",
                },
                "extra": true,
            }),
        ] {
            assert_eq!(
                exact_native_self_receipt_error(&serde_json::to_vec(&invalid).unwrap()),
                None
            );
        }
    }

    #[test]
    fn application_signaling_ipc_rejects_custody_and_route_fields() {
        // The application commands reuse the diagnostic input envelopes, so a
        // bearer, private key, broker URL, or project authority must fail
        // deserialization exactly as it does on the diagnostic seam.
        let read = serde_json::json!({
            "profileName": "Local",
            "expectedProfileRevision": 7,
            "nonce": "signal-nonce-01",
        });
        let open = serde_json::json!({
            "profileName": "Local",
            "expectedProfileRevision": 7,
            "nonce": "signal-nonce-01",
            "offerSdp": "v=0\r\n",
        });
        let binding = serde_json::json!({
            "profileName": "Local",
            "expectedProfileRevision": 7,
        });
        assert!(
            serde_json::from_value::<NativeRelaySignalDiagnosticOpenInput>(open.clone()).is_ok()
        );
        assert!(
            serde_json::from_value::<NativeRelaySignalDiagnosticReadInput>(read.clone()).is_ok()
        );
        assert!(
            serde_json::from_value::<NativeRelayDiagnosticBindingInput>(binding.clone()).is_ok()
        );
        for field in ["grantBearer", "privateKey", "brokerUrl", "projectId"] {
            let mut open_with_field = open.clone();
            open_with_field[field] = serde_json::json!("must-not-cross-ipc");
            assert!(
                serde_json::from_value::<NativeRelaySignalDiagnosticOpenInput>(open_with_field)
                    .is_err()
            );
            let mut read_with_field = read.clone();
            read_with_field[field] = serde_json::json!("must-not-cross-ipc");
            assert!(
                serde_json::from_value::<NativeRelaySignalDiagnosticReadInput>(read_with_field)
                    .is_err()
            );
            let mut binding_with_field = binding.clone();
            binding_with_field[field] = serde_json::json!("must-not-cross-ipc");
            assert!(serde_json::from_value::<NativeRelayDiagnosticBindingInput>(
                binding_with_field
            )
            .is_err());
        }

        let binding: NativeRelayDiagnosticBindingInput = serde_json::from_value(binding).unwrap();
        assert!(validate_native_relay_binding_input(&binding).is_ok());
        let mut stale = binding.clone();
        stale.expected_profile_revision = 0;
        assert!(validate_native_relay_binding_input(&stale).is_err());
        stale.expected_profile_revision = JS_SAFE_INTEGER_MAX + 1;
        assert!(validate_native_relay_binding_input(&stale).is_err());
    }

    #[test]
    fn native_signal_diagnostic_ipc_accepts_only_bounded_saved_profile_inputs() {
        let open: NativeRelaySignalDiagnosticOpenInput =
            serde_json::from_value(serde_json::json!({
                "profileName": "Local",
                "expectedProfileRevision": 7,
                "nonce": "signal-nonce-01",
                "offerSdp": "v=0\r\no=- diagnostic\r\n",
            }))
            .unwrap();
        assert!(validate_diagnostic_open_input(&open).is_ok());

        let mut extra = serde_json::json!({
            "profileName": "Local",
            "expectedProfileRevision": 7,
            "nonce": "signal-nonce-01",
            "offerSdp": "v=0",
        });
        extra["grantBearer"] = serde_json::json!("never-renderer-owned");
        assert!(serde_json::from_value::<NativeRelaySignalDiagnosticOpenInput>(extra).is_err());

        let mut too_large = open.clone();
        too_large.offer_sdp = "s".repeat(MAX_NATIVE_SIGNAL_SDP_BYTES + 1);
        assert!(validate_diagnostic_open_input(&too_large).is_err());
        let mut bad_nonce = open;
        bad_nonce.nonce = "../route".into();
        assert!(validate_diagnostic_open_input(&bad_nonce).is_err());
    }

    #[test]
    fn native_signal_diagnostic_read_ipc_rejects_transport_and_auth_fields() {
        let input: NativeRelaySignalDiagnosticReadInput =
            serde_json::from_value(serde_json::json!({
                "profileName": "Local",
                "expectedProfileRevision": 7,
                "nonce": "signal-nonce-01",
            }))
            .unwrap();
        assert!(validate_diagnostic_read_input(&input).is_ok());

        for field in ["brokerUrl", "privateKey", "grantBearer", "projectId"] {
            let mut value = serde_json::json!({
                "profileName": "Local",
                "expectedProfileRevision": 7,
                "nonce": "signal-nonce-01",
            });
            value[field] = serde_json::json!("must-not-cross-ipc");
            assert!(serde_json::from_value::<NativeRelaySignalDiagnosticReadInput>(value).is_err());
        }
    }

    #[test]
    fn native_diagnostic_binding_is_exact_revision_and_secret_free() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let context = prepared.authority.0.lock().unwrap().clone();
        let grant = sample_grant(&prepared, NOW + 3_600_000);
        let binding = diagnostic_binding_from_current("Local", 7, context.clone(), grant).unwrap();
        let encoded = serde_json::to_value(&binding).unwrap();
        assert_eq!(encoded["profileName"], "Local");
        assert_eq!(encoded["profileRevision"], 7);
        assert_eq!(encoded["scope"]["stationId"], STATION_ID);
        assert_eq!(encoded["surface"]["clientInstanceId"], INSTANCE_ID);
        assert!(encoded.get("credential").is_none());
        assert!(encoded.get("privateKey").is_none());
        assert!(encoded.get("brokerOrigin").is_none());

        let grant = sample_grant(&prepared, NOW + 3_600_000);
        assert!(matches!(
            diagnostic_binding_from_current("Other", 7, context.clone(), grant),
            Err(NativeRedemptionError::StaleProfile)
        ));
        let grant = sample_grant(&prepared, NOW + 3_600_000);
        assert!(matches!(
            diagnostic_binding_from_current("Local", 8, context, grant),
            Err(NativeRedemptionError::StaleProfile)
        ));
        let mut revoked = prepared.authority.0.lock().unwrap().clone();
        revoked.station_trust.status = NativeStationTrustStatus::Revoked;
        let grant = sample_grant(&prepared, NOW + 3_600_000);
        assert!(matches!(
            diagnostic_binding_from_current("Local", 7, revoked, grant),
            Err(NativeRedemptionError::StaleProfile)
        ));
    }

    #[test]
    fn native_signal_service_uses_fixed_proven_requests_and_returns_secret_free_dtos() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let grants = stored_signal_grant(&prepared);
        let open_transport = NativeSignalTransport {
            authority: prepared.authority.clone(),
            status: 200,
            response_body: serde_json::to_vec(&serde_json::json!({
                "version": NATIVE_SIGNAL_OPENED_VERSION,
                "expiresAt": NOW + 30_000,
            }))
            .unwrap(),
            mutate_profile_after_request: false,
            return_transport_error: false,
            observed: Mutex::new(None),
        };
        let open_request = NativeRelaySignalOpenRequest {
            profile_name: "Local".to_owned(),
            expected_profile_revision: 7,
            nonce: "signal-nonce-01".to_owned(),
            offer_sdp: "v=0\r\no=- native-diagnostic\r\n".to_owned(),
        };
        let opened = native_signal_service(&prepared, &open_transport, &grants)
            .open(&open_request)
            .unwrap();
        assert_eq!(opened.expires_at, NOW + 30_000);
        assert_eq!(
            serde_json::to_value(&opened).unwrap(),
            serde_json::json!({ "expiresAt": NOW + 30_000 })
        );
        let (path, body, valid_proof) = open_transport.observed.lock().unwrap().clone().unwrap();
        assert_eq!(path, OPEN_PATH);
        assert!(valid_proof);
        let open_body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(open_body["connection"]["nonce"], "signal-nonce-01");
        assert_eq!(
            open_body["connection"]["offerSdp"],
            "v=0\r\no=- native-diagnostic\r\n"
        );

        let read_transport = NativeSignalTransport {
            authority: prepared.authority.clone(),
            status: 200,
            response_body: serde_json::to_vec(&serde_json::json!({
                "version": NATIVE_SIGNAL_ANSWER_VERSION,
                "answerSdp": "v=0\r\no=- station-answer\r\n",
                "stationProof": "opaque-station-proof",
                "expiresAt": NOW + 30_000,
            }))
            .unwrap(),
            mutate_profile_after_request: false,
            return_transport_error: false,
            observed: Mutex::new(None),
        };
        let read_request = NativeRelaySignalReadRequest {
            profile_name: "Local".to_owned(),
            expected_profile_revision: 7,
            nonce: "signal-nonce-01".to_owned(),
        };
        let answer = native_signal_service(&prepared, &read_transport, &grants)
            .read(&read_request)
            .unwrap();
        assert_eq!(
            answer.station_proof.as_deref(),
            Some("opaque-station-proof")
        );
        assert_eq!(
            serde_json::to_value(&answer).unwrap(),
            serde_json::json!({
                "answerSdp": "v=0\r\no=- station-answer\r\n",
                "stationProof": "opaque-station-proof",
                "expiresAt": NOW + 30_000,
            })
        );
        let (path, _body, valid_proof) = read_transport.observed.lock().unwrap().clone().unwrap();
        assert_eq!(path, READ_PATH);
        assert!(valid_proof);
        let serialized = serde_json::to_string(&answer).unwrap();
        assert!(!serialized.contains(&"S".repeat(43)));
        assert!(!serialized.contains("credential"));
        assert!(!serialized.contains("proofKey"));
    }

    #[test]
    fn native_signal_accepts_broker_expiry_with_clock_ten_seconds_ahead() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let grants = stored_signal_grant(&prepared);
        let open_transport = NativeSignalTransport {
            authority: prepared.authority.clone(),
            status: 200,
            response_body: serde_json::to_vec(&serde_json::json!({
                "version": NATIVE_SIGNAL_OPENED_VERSION,
                "expiresAt": NOW + 40_000,
            }))
            .unwrap(),
            mutate_profile_after_request: false,
            return_transport_error: false,
            observed: Mutex::new(None),
        };
        let opened = native_signal_service(&prepared, &open_transport, &grants).open(
            &NativeRelaySignalOpenRequest {
                profile_name: "Local".to_owned(),
                expected_profile_revision: 7,
                nonce: "signal-clock-offset-01".to_owned(),
                offer_sdp: "v=0\r\no=- native-diagnostic\r\n".to_owned(),
            },
        );
        assert_eq!(opened.unwrap().expires_at, NOW + 40_000);

        let read_transport = NativeSignalTransport {
            authority: prepared.authority.clone(),
            status: 200,
            response_body: serde_json::to_vec(&serde_json::json!({
                "version": NATIVE_SIGNAL_ANSWER_VERSION,
                "answerSdp": null,
                "stationProof": null,
                "expiresAt": NOW + 40_000,
            }))
            .unwrap(),
            mutate_profile_after_request: false,
            return_transport_error: false,
            observed: Mutex::new(None),
        };
        let answer = native_signal_service(&prepared, &read_transport, &grants).read(
            &NativeRelaySignalReadRequest {
                profile_name: "Local".to_owned(),
                expected_profile_revision: 7,
                nonce: "signal-clock-offset-01".to_owned(),
            },
        );
        assert_eq!(answer.unwrap().expires_at, NOW + 40_000);
    }

    #[test]
    fn native_signal_service_rechecks_profile_after_broker_response() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let grants = stored_signal_grant(&prepared);
        let transport = NativeSignalTransport {
            authority: prepared.authority.clone(),
            status: 200,
            response_body: serde_json::to_vec(&serde_json::json!({
                "version": NATIVE_SIGNAL_ANSWER_VERSION,
                "answerSdp": null,
                "stationProof": null,
                "expiresAt": NOW + 30_000,
            }))
            .unwrap(),
            mutate_profile_after_request: true,
            return_transport_error: false,
            observed: Mutex::new(None),
        };
        let read_request = NativeRelaySignalReadRequest {
            profile_name: "Local".to_owned(),
            expected_profile_revision: 7,
            nonce: "signal-nonce-01".to_owned(),
        };
        let result = native_signal_service(&prepared, &transport, &grants).read(&read_request);
        assert_eq!(result.unwrap_err(), NativeRedemptionError::StaleProfile);
    }

    #[test]
    fn native_signal_service_bounds_offer_and_requires_complete_answer_envelope() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let grants = stored_signal_grant(&prepared);
        let oversized_transport = NativeSignalTransport {
            authority: prepared.authority.clone(),
            status: 200,
            response_body: Vec::new(),
            mutate_profile_after_request: false,
            return_transport_error: false,
            observed: Mutex::new(None),
        };
        let oversized = native_signal_service(&prepared, &oversized_transport, &grants).open(
            &NativeRelaySignalOpenRequest {
                profile_name: "Local".to_owned(),
                expected_profile_revision: 7,
                nonce: "signal-nonce-01".to_owned(),
                offer_sdp: "o".repeat(MAX_NATIVE_SIGNAL_SDP_BYTES + 1),
            },
        );
        assert_eq!(oversized.unwrap_err(), NativeRedemptionError::GrantInvalid);
        assert!(oversized_transport.observed.lock().unwrap().is_none());

        let incomplete_transport = NativeSignalTransport {
            authority: prepared.authority.clone(),
            status: 200,
            response_body: serde_json::to_vec(&serde_json::json!({
                "version": NATIVE_SIGNAL_ANSWER_VERSION,
                "stationProof": null,
                "expiresAt": NOW + 30_000,
            }))
            .unwrap(),
            mutate_profile_after_request: false,
            return_transport_error: false,
            observed: Mutex::new(None),
        };
        let incomplete = native_signal_service(&prepared, &incomplete_transport, &grants).read(
            &NativeRelaySignalReadRequest {
                profile_name: "Local".to_owned(),
                expected_profile_revision: 7,
                nonce: "signal-nonce-01".to_owned(),
            },
        );
        assert_eq!(
            incomplete.unwrap_err(),
            NativeRedemptionError::BrokerRejected
        );
    }

    #[test]
    fn native_signal_open_requires_full_broker_offer_lifetime_before_network() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let grants = stored_signal_grant_until(
            &prepared,
            NOW + MIN_NATIVE_SIGNAL_OPEN_GRANT_LIFETIME_MS - 1,
        );
        let transport = NativeSignalTransport {
            authority: prepared.authority.clone(),
            status: 200,
            response_body: Vec::new(),
            mutate_profile_after_request: false,
            return_transport_error: false,
            observed: Mutex::new(None),
        };
        let request = NativeRelaySignalOpenRequest {
            profile_name: "Local".to_owned(),
            expected_profile_revision: 7,
            nonce: "signal-nonce-01".to_owned(),
            offer_sdp: "v=0\r\no=- native-diagnostic\r\n".to_owned(),
        };
        let result = native_signal_service(&prepared, &transport, &grants).open(&request);
        assert_eq!(result.unwrap_err(), NativeRedemptionError::GrantExpired);
        assert!(transport.observed.lock().unwrap().is_none());
        // The request remains available to the owner so a lost response can
        // be recovered with the same nonce using the bounded read operation.
        assert_eq!(request.nonce, "signal-nonce-01");
    }

    #[test]
    fn native_signal_lost_open_response_retains_nonce_for_bounded_read_recovery() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let grants = stored_signal_grant(&prepared);
        let open_transport = NativeSignalTransport {
            authority: prepared.authority.clone(),
            status: 0,
            response_body: Vec::new(),
            mutate_profile_after_request: false,
            return_transport_error: true,
            observed: Mutex::new(None),
        };
        let open_request = NativeRelaySignalOpenRequest {
            profile_name: "Local".to_owned(),
            expected_profile_revision: 7,
            nonce: "signal-nonce-01".to_owned(),
            offer_sdp: "v=0\r\no=- native-diagnostic\r\n".to_owned(),
        };
        let open_result =
            native_signal_service(&prepared, &open_transport, &grants).open(&open_request);
        assert_eq!(
            open_result.unwrap_err(),
            NativeRedemptionError::BrokerTransport
        );
        assert_eq!(open_request.nonce, "signal-nonce-01");

        let read_transport = NativeSignalTransport {
            authority: prepared.authority.clone(),
            status: 200,
            response_body: serde_json::to_vec(&serde_json::json!({
                "version": NATIVE_SIGNAL_ANSWER_VERSION,
                "answerSdp": null,
                "stationProof": null,
                "expiresAt": NOW + 30_000,
            }))
            .unwrap(),
            mutate_profile_after_request: false,
            return_transport_error: false,
            observed: Mutex::new(None),
        };
        let read_request = NativeRelaySignalReadRequest {
            profile_name: open_request.profile_name.clone(),
            expected_profile_revision: open_request.expected_profile_revision,
            nonce: open_request.nonce.clone(),
        };
        let result = native_signal_service(&prepared, &read_transport, &grants).read(&read_request);
        assert_eq!(result.unwrap().answer_sdp, None);
        let (path, body, proof_valid) = read_transport.observed.lock().unwrap().clone().unwrap();
        assert_eq!(path, READ_PATH);
        assert!(proof_valid);
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["nonce"], "signal-nonce-01");
    }

    #[test]
    fn native_signal_refuses_revoked_trust_and_quarantined_grants() {
        let prepared_revoked = prepared("https://broker.example".to_owned(), 7);
        let grants = stored_signal_grant(&prepared_revoked);
        let transport = NativeSignalTransport {
            authority: prepared_revoked.authority.clone(),
            status: 200,
            response_body: Vec::new(),
            mutate_profile_after_request: false,
            return_transport_error: false,
            observed: Mutex::new(None),
        };
        prepared_revoked
            .authority
            .0
            .lock()
            .unwrap()
            .station_trust
            .status = NativeStationTrustStatus::Revoked;
        let request = NativeRelaySignalOpenRequest {
            profile_name: "Local".to_owned(),
            expected_profile_revision: 7,
            nonce: "signal-nonce-01".to_owned(),
            offer_sdp: "v=0\r\no=- native-diagnostic\r\n".to_owned(),
        };
        let revoked = native_signal_service(&prepared_revoked, &transport, &grants).open(&request);
        assert_eq!(
            revoked.unwrap_err(),
            NativeRedemptionError::StationTrustRequired
        );
        assert!(transport.observed.lock().unwrap().is_none());

        let prepared = prepared("https://broker.example".to_owned(), 7);
        let grants = stored_signal_grant(&prepared);
        let active_grant = sample_grant(&prepared, NOW + 3_600_000);
        grants
            .stage_cleanup(&prepared.owner, &active_grant, true, NOW)
            .unwrap();
        let transport = NativeSignalTransport {
            authority: prepared.authority.clone(),
            status: 200,
            response_body: Vec::new(),
            mutate_profile_after_request: false,
            return_transport_error: false,
            observed: Mutex::new(None),
        };
        let quarantined = native_signal_service(&prepared, &transport, &grants).open(&request);
        assert_eq!(quarantined.unwrap_err(), NativeRedemptionError::GrantStore);
        assert!(transport.observed.lock().unwrap().is_none());
    }

    #[test]
    fn native_signal_rechecks_context_when_transport_fails() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let grants = stored_signal_grant(&prepared);
        let transport = NativeSignalTransport {
            authority: prepared.authority.clone(),
            status: 0,
            response_body: Vec::new(),
            mutate_profile_after_request: true,
            return_transport_error: true,
            observed: Mutex::new(None),
        };
        let request = NativeRelaySignalReadRequest {
            profile_name: "Local".to_owned(),
            expected_profile_revision: 7,
            nonce: "signal-nonce-01".to_owned(),
        };
        let result = native_signal_service(&prepared, &transport, &grants).read(&request);
        assert_eq!(result.unwrap_err(), NativeRedemptionError::StaleProfile);
        assert_eq!(request.nonce, "signal-nonce-01");
    }

    struct SuccessfulRetirement;

    impl NativeBrokerTransport for SuccessfulRetirement {
        fn redeem(&self, _: &str, _: &[u8]) -> RedemptionResult<BrokerResponse> {
            Err(NativeRedemptionError::BrokerTransport)
        }
    }

    struct BlockingRedeemTransport {
        started: Sender<()>,
        release: Mutex<Receiver<()>>,
    }

    impl NativeBrokerTransport for BlockingRedeemTransport {
        fn redeem(&self, _: &str, request: &[u8]) -> RedemptionResult<BrokerResponse> {
            self.started
                .send(())
                .map_err(|_| NativeRedemptionError::BrokerTransport)?;
            self.release
                .lock()
                .map_err(|_| NativeRedemptionError::BrokerTransport)?
                .recv()
                .map_err(|_| NativeRedemptionError::BrokerTransport)?;
            Ok(BrokerResponse {
                status: 200,
                body: Zeroizing::new(grant_body(request, NOW + 3_600_000)),
            })
        }
    }

    impl NativeBrokerRequestTransport for BlockingRedeemTransport {
        fn send_fixed_request(
            &self,
            _: &NativeRelayClientGrantV2,
            challenge: &NativeBrokerRequestProofChallenge,
            _: &str,
        ) -> RedemptionResult<BrokerResponse> {
            if challenge.path() != RETIRE_PATH {
                return Err(NativeRedemptionError::GrantInvalid);
            }
            Ok(BrokerResponse {
                status: 200,
                body: Zeroizing::new(
                    serde_json::to_vec(&serde_json::json!({
                        "version": NATIVE_RETIRE_VERSION,
                        "retired": true,
                    }))
                    .unwrap(),
                ),
            })
        }
    }

    impl NativeBrokerRequestTransport for SuccessfulRetirement {
        fn send_fixed_request(
            &self,
            _: &NativeRelayClientGrantV2,
            challenge: &NativeBrokerRequestProofChallenge,
            _: &str,
        ) -> RedemptionResult<BrokerResponse> {
            if challenge.path() != RETIRE_PATH {
                return Err(NativeRedemptionError::GrantInvalid);
            }
            Ok(BrokerResponse {
                status: 200,
                body: Zeroizing::new(
                    serde_json::to_vec(&serde_json::json!({
                        "version": NATIVE_RETIRE_VERSION,
                        "retired": true,
                    }))
                    .unwrap(),
                ),
            })
        }
    }

    struct Prepared {
        authority: Arc<MemoryAuthority>,
        proof_keys: crate::native_relay_proof_key::MemoryNativeRelayProofKeyVault,
        owner: NativeProofKeyOwner,
        public: NativeProofKeyPublicMetadata,
        invitation: NativeRelayInvitationV2,
    }

    fn prepared(broker_origin: String, revision: u64) -> Prepared {
        let owner = NativeProofKeyOwner::new(
            "io.kontourai.station",
            NativeProofKeyChannel::Stable,
            INSTANCE_ID,
        )
        .unwrap();
        let proof_keys = crate::native_relay_proof_key::MemoryNativeRelayProofKeyVault::new();
        let public = proof_keys.create(&owner).unwrap();
        let profile = NativeRelayProfileSnapshot {
            revision,
            profile_name: "Local".to_owned(),
            station_endpoint: "https://station.example.test".to_owned(),
            broker_origin: broker_origin.clone(),
            station_id: STATION_ID.to_owned(),
            enrollment_id: ENROLLMENT_ID.to_owned(),
            app_identifier: "io.kontourai.station".to_owned(),
            channel: NativeProofKeyChannel::Stable,
            client_instance_id: INSTANCE_ID.to_owned(),
        };
        let trust = ApprovedNativeStationTrust {
            revision: 3,
            status: NativeStationTrustStatus::Approved,
            station_endpoint: profile.station_endpoint.clone(),
            station_id: STATION_ID.to_owned(),
            enrollment_id: ENROLLMENT_ID.to_owned(),
            generation: 4,
            // A real P-256 public point generated by the same audited key
            // implementation; approval is injected as host-owned test state.
            signing_key: public.jwk().clone(),
        };
        let invitation = NativeRelayInvitationV2 {
            version: NATIVE_INVITATION_VERSION.to_owned(),
            broker_origin,
            scope: NativeRelayScopeV2 {
                station_id: STATION_ID.to_owned(),
                enrollment_id: ENROLLMENT_ID.to_owned(),
                routing_generation: 9,
            },
            station_signing_key_id: station_signing_key_id(&trust.signing_key),
            station_signing_generation: trust.generation,
            surface: NativeRelayClientSurfaceV2 {
                kind: "station-native".to_owned(),
                app_identifier: profile.app_identifier.clone(),
                channel: profile.channel.keyring_label().to_owned(),
                client_instance_id: profile.client_instance_id.clone(),
                key_thumbprint: public.thumbprint().to_owned(),
            },
            invitation_id: "invite-12345678".to_owned(),
            invitation_secret: SecretText(Zeroizing::new("I".repeat(43))),
            expires_at: NOW + 60_000,
        };
        Prepared {
            authority: Arc::new(MemoryAuthority(Mutex::new(NativeRedemptionContext {
                profile,
                station_trust: trust,
            }))),
            proof_keys,
            owner,
            public,
            invitation,
        }
    }

    fn grant_body(request: &[u8], expires_at: u64) -> Vec<u8> {
        let value: serde_json::Value = serde_json::from_slice(request).unwrap();
        let invitation = &value["invitation"];
        let proof = &value["proof"];
        serde_json::to_vec(&serde_json::json!({
            "version": NATIVE_GRANT_VERSION,
            "brokerOrigin": invitation["brokerOrigin"],
            "scope": invitation["scope"],
            "stationSigningKeyId": invitation["stationSigningKeyId"],
            "stationSigningGeneration": invitation["stationSigningGeneration"],
            "surface": invitation["surface"],
            "proofPublicKey": proof["publicKey"],
            "credential": {"id": "G".repeat(22), "secret": "S".repeat(43)},
            "expiresAt": expires_at
        }))
        .unwrap()
    }

    fn write_native_retire_receipt(socket: &mut std::net::TcpStream, status: u16) {
        let receipt = br#"{"version":"station-broker-native-grant-retire/v2","retired":true}"#;
        write!(socket, "HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", receipt.len()).unwrap();
        socket.write_all(receipt).unwrap();
    }

    fn read_request(socket: &mut std::net::TcpStream) -> Vec<u8> {
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut request = Vec::new();
        let mut chunk = [0_u8; 4096];
        loop {
            let read = socket.read(&mut chunk).unwrap();
            assert_ne!(read, 0, "client ended before request headers");
            request.extend_from_slice(&chunk[..read]);
            let Some(header_end) = request.windows(4).position(|value| value == b"\r\n\r\n") else {
                assert!(request.len() <= MAX_REQUEST_BYTES);
                continue;
            };
            let header = String::from_utf8_lossy(&request[..header_end]);
            let content_length = header
                .lines()
                .find_map(|line| {
                    line.split_once(':').and_then(|(name, value)| {
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                })
                .unwrap();
            let request_end = header_end + 4 + content_length;
            while request.len() < request_end {
                let read = socket.read(&mut chunk).unwrap();
                assert_ne!(read, 0, "client ended before request body");
                request.extend_from_slice(&chunk[..read]);
            }
            request.truncate(request_end);
            return request;
        }
    }

    fn request_header_body(request: &[u8]) -> (&[u8], &[u8]) {
        let header_end = request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .unwrap();
        (&request[..header_end], &request[header_end + 4..])
    }

    fn request_header_value<'a>(header: &'a [u8], name: &str) -> Option<&'a str> {
        let text = std::str::from_utf8(header).ok()?;
        text.lines().skip(1).find_map(|line| {
            line.split_once(':').and_then(|(header_name, value)| {
                header_name
                    .eq_ignore_ascii_case(name)
                    .then_some(value.trim())
            })
        })
    }

    fn verify_native_retire_request_proof(
        request: &[u8],
        public_key: &P256PublicJwk,
        broker_origin: &str,
    ) -> serde_json::Value {
        let (header, body) = request_header_body(request);
        assert!(String::from_utf8_lossy(header)
            .to_ascii_lowercase()
            .starts_with("post /broker/v1/native/grants/retire http/1.1"));
        let expected_authorization = format!("Bearer {}", "S".repeat(43));
        assert_eq!(
            request_header_value(header, "authorization"),
            Some(expected_authorization.as_str())
        );
        assert_eq!(
            request_header_value(header, "x-broker-credential-id"),
            Some("GGGGGGGGGGGGGGGGGGGGGG")
        );
        let compact = request_header_value(header, "x-station-native-proof").unwrap();
        let parts = compact.split('.').collect::<Vec<_>>();
        assert_eq!(parts.len(), 3);
        assert_eq!(
            URL_SAFE_NO_PAD.decode(parts[0]).unwrap(),
            br#"{"alg":"ES256","typ":"station-broker-native-request+jws"}"#
        );
        let claims_bytes = URL_SAFE_NO_PAD.decode(parts[1]).unwrap();
        let claims: serde_json::Value = serde_json::from_slice(&claims_bytes).unwrap();
        assert_eq!(claims["version"], "station-broker-native-request-proof/v1");
        assert_eq!(claims["aud"], broker_origin);
        assert_eq!(claims["brokerOrigin"], broker_origin);
        assert_eq!(claims["purpose"], "station-native-grant-retire-v2");
        assert_eq!(claims["method"], "POST");
        assert_eq!(claims["path"], RETIRE_PATH);
        assert_eq!(claims["grantId"], "GGGGGGGGGGGGGGGGGGGGGG");
        let key_thumbprint = station_signing_key_id(public_key);
        assert_eq!(claims["surface"]["keyThumbprint"], key_thumbprint);
        assert_eq!(
            claims["stationSigningKeyId"],
            station_signing_key_id(public_key)
        );
        assert_eq!(
            claims["bodySha256"],
            URL_SAFE_NO_PAD.encode(digest(&SHA256, body))
        );
        assert_eq!(
            claims["ath"],
            URL_SAFE_NO_PAD.encode(digest(&SHA256, "S".repeat(43).as_bytes()))
        );
        assert_eq!(
            URL_SAFE_NO_PAD
                .decode(claims["jti"].as_str().unwrap())
                .unwrap()
                .len(),
            32
        );
        assert_eq!(
            claims["exp"].as_u64().unwrap() - claims["iat"].as_u64().unwrap(),
            30
        );
        let body_value: serde_json::Value = serde_json::from_slice(body).unwrap();
        assert_eq!(body_value["version"], NATIVE_RETIRE_VERSION);
        assert_eq!(body_value["scope"]["stationId"], STATION_ID);
        assert_eq!(body_value["scope"]["enrollmentId"], ENROLLMENT_ID);
        assert_eq!(body_value["scope"]["routingGeneration"], 9);
        assert_eq!(body_value["surface"]["keyThumbprint"], key_thumbprint);

        let x = URL_SAFE_NO_PAD.decode(public_key.x()).unwrap();
        let y = URL_SAFE_NO_PAD.decode(public_key.y()).unwrap();
        let mut point = vec![0x04];
        point.extend_from_slice(&x);
        point.extend_from_slice(&y);
        let signing_input = format!("{}.{}", parts[0], parts[1]);
        let signature_bytes = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, point)
            .verify(signing_input.as_bytes(), &signature_bytes)
            .unwrap();
        claims
    }

    fn spawn_server(
        response: impl FnOnce(&[u8]) -> (u16, Vec<u8>) + Send + 'static,
    ) -> (String, std::thread::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let origin = format!("http://{address}");
        let thread = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let request = read_request(&mut socket);
            let (status, body) = response(&request);
            let text = match status {
                200 => "OK",
                302 => "Found",
                _ => "Error",
            };
            if let Err(error) = write!(
                socket,
                "HTTP/1.1 {status} {text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            ) {
                assert!(
                    matches!(
                        error.kind(),
                        std::io::ErrorKind::BrokenPipe
                            | std::io::ErrorKind::ConnectionReset
                            | std::io::ErrorKind::ConnectionAborted
                    ),
                    "unexpected server response error: {error}"
                );
                return request;
            }
            if let Err(error) = socket.write_all(&body) {
                assert!(
                    matches!(
                        error.kind(),
                        std::io::ErrorKind::BrokenPipe
                            | std::io::ErrorKind::ConnectionReset
                            | std::io::ErrorKind::ConnectionAborted
                    ),
                    "unexpected server body error: {error}"
                );
            }
            request
        });
        (origin, thread)
    }

    fn service<'a, H: NativeBrokerTransport + NativeBrokerRequestTransport>(
        authority: &'a MemoryAuthority,
        proof_keys: &'a crate::native_relay_proof_key::MemoryNativeRelayProofKeyVault,
        http: &'a H,
        grants: &'a NativeRelayGrantVault<MemoryNativeGrantBackend>,
    ) -> NativeRelayRedemptionService<
        'a,
        MemoryAuthority,
        crate::native_relay_proof_key::MemoryNativeRelayProofKeyVault,
        H,
        NativeRelayGrantVault<MemoryNativeGrantBackend>,
        impl Fn() -> u64,
    > {
        NativeRelayRedemptionService::new(authority, proof_keys, http, grants, || NOW)
    }

    fn renewal_intent_for(
        grant: &NativeRelayClientGrantV2,
        renewal_id: &str,
    ) -> NativeGrantRenewalIntent {
        let request = NativeGrantRenewalRequestBody {
            version: NATIVE_RENEW_VERSION.to_owned(),
            scope: grant.scope.clone(),
            surface: grant.surface.clone(),
            renewal_id: renewal_id.to_owned(),
            expected_expires_at: grant.expires_at,
        };
        NativeGrantRenewalIntent {
            renewal_id: renewal_id.to_owned(),
            expected_expires_at: grant.expires_at,
            request_body: serde_json::to_vec(&request).unwrap(),
        }
    }

    #[test]
    fn delayed_exact_renewal_receipt_clears_intent_and_allows_fresh_renewal() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let grants = NativeRelayGrantVault::new(MemoryNativeGrantBackend::default());
        let original = sample_grant(&prepared, NOW + 12 * 60 * 60 * 1000);
        let metadata = grants.store(&prepared.owner, &original, NOW).unwrap();
        let intent = renewal_intent_for(&original, "renewal-first-01");
        grants
            .save_renewal_intent(&prepared.owner, &original, intent.clone())
            .unwrap();

        let receipt = NativeGrantRenewalReceipt {
            version: NATIVE_RENEWED_VERSION.to_owned(),
            renewal_id: intent.renewal_id.clone(),
            expires_at: NOW + 24 * 60 * 60 * 1000,
        };
        let retry_at = NOW + 36 * 60 * 60 * 1000;
        assert!(receipt.expires_at < retry_at);
        let wrong_receipt = NativeGrantRenewalReceipt {
            renewal_id: "renewal-other-01".to_owned(),
            ..receipt.clone()
        };
        assert_eq!(
            grants.complete_renewal(
                &prepared.owner,
                &original,
                &intent,
                &wrong_receipt,
                retry_at,
            ),
            Err(NativeRedemptionError::GrantStore)
        );

        let completed = grants
            .complete_renewal(&prepared.owner, &original, &intent, &receipt, retry_at)
            .unwrap();
        assert_eq!(completed.expires_at, receipt.expires_at);
        let context = prepared.authority.0.lock().unwrap().clone();
        let recovered = grants
            .load_request_grant(&prepared.owner, &context, retry_at, true)
            .unwrap();
        assert_eq!(recovered.grant.expires_at, receipt.expires_at);
        assert!(recovered.renewal_intent.is_none());

        let next_intent = renewal_intent_for(&recovered.grant, "renewal-next-01");
        grants
            .save_renewal_intent(&prepared.owner, &recovered.grant, next_intent.clone())
            .unwrap();
        assert_ne!(next_intent.renewal_id, intent.renewal_id);
        assert_eq!(
            grants
                .metadata(&prepared.owner, &metadata.route, retry_at)
                .unwrap(),
            None
        );
    }

    #[test]
    fn native_redemption_uses_fixed_post_and_stores_only_secret_free_metadata() {
        let (origin, server) = spawn_server(|request| {
            let (header, body) = request_header_body(request);
            let header = String::from_utf8_lossy(header).to_ascii_lowercase();
            assert!(header.starts_with("post /broker/v1/native/grants/redeem http/1.1"));
            assert!(!header.contains("authorization:"));
            assert!(!header.contains("origin:"));
            assert!(!header.contains("cookie:"));
            let request_value: serde_json::Value = serde_json::from_slice(body).unwrap();
            let compact = request_value["proof"]["jws"].as_str().unwrap();
            let parts = compact.split('.').collect::<Vec<_>>();
            assert_eq!(parts.len(), 3);
            let payload = URL_SAFE_NO_PAD.decode(parts[1]).unwrap();
            let payload: serde_json::Value = serde_json::from_slice(&payload).unwrap();
            assert_ne!(
                payload["invitationSecretDigest"],
                serde_json::Value::String("I".repeat(43))
            );
            let key = &request_value["proof"]["publicKey"];
            let x = URL_SAFE_NO_PAD.decode(key["x"].as_str().unwrap()).unwrap();
            let y = URL_SAFE_NO_PAD.decode(key["y"].as_str().unwrap()).unwrap();
            let mut point = vec![0x04];
            point.extend_from_slice(&x);
            point.extend_from_slice(&y);
            let signing_input = format!("{}.{}", parts[0], parts[1]);
            let signature_bytes = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
            signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, point)
                .verify(signing_input.as_bytes(), &signature_bytes)
                .unwrap();
            let grant = grant_body(body, NOW + 3_600_000);
            (200, grant)
        });
        let mut prepared = prepared(origin.clone(), 7);
        prepared.invitation.broker_origin = origin.clone();
        let authority = NativeRelayGrantVault::new(MemoryNativeGrantBackend::default());
        let transport = UreqNativeBrokerTransport::new();
        let service = service(
            &prepared.authority,
            &prepared.proof_keys,
            &transport,
            &authority,
        );
        let stored_grant = sample_grant(&prepared, NOW + 3_600_000);
        let metadata = service.redeem("Local", 7, prepared.invitation).unwrap();
        let request = server.join().unwrap();
        assert!(String::from_utf8_lossy(&request).contains("I".repeat(43).as_str()));
        let encoded = serde_json::to_string(&metadata).unwrap();
        assert!(!encoded.contains(&"S".repeat(43)));
        assert_eq!(metadata.expires_at, NOW + 3_600_000);
        assert!(authority
            .metadata(&prepared.owner, &metadata.route, NOW)
            .unwrap()
            .is_some());
        assert!(authority
            .revoke_if_matches(&prepared.owner, &stored_grant)
            .unwrap());
        assert!(authority
            .metadata(&prepared.owner, &metadata.route, NOW)
            .unwrap()
            .is_none());
    }

    #[test]
    fn supersession_after_actual_grant_record_write_quarantines_and_compensates_that_grant() {
        struct BlockedGrantWrite {
            inner: MemoryNativeGrantBackend,
            reached: Sender<()>,
            resume: Receiver<()>,
            blocked_once: bool,
        }
        impl NativeGrantBackend for BlockedGrantWrite {
            fn get(&mut self, account: &str) -> RedemptionResult<Option<Zeroizing<String>>> {
                self.inner.get(account)
            }
            fn set(&mut self, account: &str, value: &str) -> RedemptionResult<()> {
                self.inner.set(account, value)?;
                if !self.blocked_once && account.starts_with(GRANT_ACCOUNT_PREFIX) {
                    self.blocked_once = true;
                    self.reached
                        .send(())
                        .map_err(|_| NativeRedemptionError::GrantStore)?;
                    self.resume
                        .recv_timeout(Duration::from_secs(2))
                        .map_err(|_| NativeRedemptionError::GrantStore)?;
                }
                Ok(())
            }
            fn delete(&mut self, account: &str) -> RedemptionResult<()> {
                self.inner.delete(account)
            }
        }
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let prepared = prepared(origin, 7);
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let request = read_request(&mut socket);
            let (_, body) = request_header_body(&request);
            let grant = grant_body(body, NOW + 3_600_000);
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", grant.len()).unwrap();
            socket.write_all(&grant).unwrap();
            drop(socket);
            let (mut socket, _) = listener.accept().unwrap();
            let request = read_request(&mut socket);
            let (header, _) = request_header_body(&request);
            assert!(String::from_utf8_lossy(header)
                .starts_with("POST /broker/v1/native/grants/retire HTTP/1.1"));
            write_native_retire_receipt(&mut socket, 200);
        });
        let (reached_tx, reached_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let backend = MemoryNativeGrantBackend::default();
        let grants = NativeRelayGrantVault::new(BlockedGrantWrite {
            inner: backend.clone(),
            reached: reached_tx,
            resume: resume_rx,
            blocked_once: false,
        });
        let transport = UreqNativeBrokerTransport::new();
        let service = NativeRelayRedemptionService::new(
            prepared.authority.as_ref(),
            &prepared.proof_keys,
            &transport,
            &grants,
            || NOW,
        );
        let cancelled = AtomicBool::new(false);
        let gate = Mutex::new(());
        let failure = std::thread::scope(|scope| {
            let redeem = scope.spawn(|| {
                service.redeem_with_cancellation(
                    "Local",
                    7,
                    prepared.invitation,
                    Some((&cancelled, &gate)),
                )
            });
            reached_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("the actual grant record was written before supersession");
            cancelled.store(true, Ordering::Release);
            resume_tx.send(()).unwrap();
            redeem.join().unwrap().unwrap_err()
        });
        assert_eq!(failure.primary, NativeRedemptionError::StaleProfile);
        assert_eq!(failure.cleanup, NativeGrantCleanupDisposition::Complete);
        assert!(grants
            .metadata_for_context(&prepared.owner, &prepared.authority.0.lock().unwrap(), NOW)
            .unwrap()
            .is_empty());
        assert!(grants.pending_cleanups(&prepared.owner).unwrap().is_empty());
        assert!(!backend
            .shared
            .lock()
            .unwrap()
            .values
            .keys()
            .any(|account| account.starts_with(GRANT_ACCOUNT_PREFIX)));
        server.join().unwrap();
    }

    #[test]
    fn cancelled_link_redemption_retires_late_broker_grant_without_activating_it() {
        for retire_status in [200, 503] {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let prepared = prepared(origin, 7);
            let cancelled = Arc::new(AtomicBool::new(false));
            let cancel_at_response = cancelled.clone();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let redeem = read_request(&mut socket);
                let (_, body) = request_header_body(&redeem);
                let grant = grant_body(body, NOW + 3_600_000);
                cancel_at_response.store(true, Ordering::Release);
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", grant.len()).unwrap();
                socket.write_all(&grant).unwrap();
                drop(socket);
                let (mut socket, _) = listener.accept().unwrap();
                let retire = read_request(&mut socket);
                let (header, _) = request_header_body(&retire);
                assert!(String::from_utf8_lossy(header)
                    .starts_with("POST /broker/v1/native/grants/retire HTTP/1.1"));
                write_native_retire_receipt(&mut socket, retire_status);
            });
            let grants = NativeRelayGrantVault::new(MemoryNativeGrantBackend::default());
            let transport = UreqNativeBrokerTransport::new();
            let service = service(
                &prepared.authority,
                &prepared.proof_keys,
                &transport,
                &grants,
            );
            let gate = Mutex::new(());
            let failure = service
                .redeem_with_cancellation(
                    "Local",
                    7,
                    prepared.invitation,
                    Some((&cancelled, &gate)),
                )
                .unwrap_err();
            assert_eq!(failure.primary, NativeRedemptionError::StaleProfile);
            assert!(grants
                .metadata_for_context(&prepared.owner, &prepared.authority.0.lock().unwrap(), NOW)
                .unwrap()
                .is_empty());
            if retire_status == 200 {
                assert_eq!(failure.cleanup, NativeGrantCleanupDisposition::Complete);
                assert!(failure.recovery.is_none());
            } else {
                assert_eq!(
                    failure.cleanup,
                    NativeGrantCleanupDisposition::Pending {
                        local_revoke_failed: false,
                        broker_retire_failed: true,
                        custody_failed: false
                    }
                );
                assert_eq!(
                    failure.recovery.as_ref().unwrap().credential_status,
                    NativeGrantRecoveryCredentialStatus::DurablePending
                );
            }
            server.join().unwrap();
        }
    }

    #[test]
    fn unapproved_or_stale_profile_fails_before_any_broker_request() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let prepared = prepared(origin, 7);
        {
            let mut context = prepared.authority.0.lock().unwrap();
            context.station_trust.status = NativeStationTrustStatus::Revoked;
        }
        let never = NeverTransport(AtomicBool::new(false));
        let grants = NativeRelayGrantVault::new(MemoryNativeGrantBackend::default());
        let service = service(&prepared.authority, &prepared.proof_keys, &never, &grants);
        assert_eq!(
            service.redeem("Local", 7, prepared.invitation).unwrap_err(),
            NativeRedemptionError::StationTrustRequired
        );
        assert!(!never.0.load(Ordering::SeqCst));
        drop(listener);
    }

    #[test]
    fn missing_invitation_bound_proof_key_fails_without_create_or_broker_request() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let prepared = prepared(origin, 7);
        let empty_keys = crate::native_relay_proof_key::MemoryNativeRelayProofKeyVault::new();
        assert_eq!(
            empty_keys.restore(&prepared.owner).unwrap_err(),
            ProofKeyError::Missing
        );
        let never = NeverTransport(AtomicBool::new(false));
        let grants = NativeRelayGrantVault::new(MemoryNativeGrantBackend::default());
        let service = NativeRelayRedemptionService::new(
            &*prepared.authority,
            &empty_keys,
            &never,
            &grants,
            || NOW,
        );
        let failure = service.redeem("Local", 7, prepared.invitation).unwrap_err();
        assert_eq!(failure.primary, NativeRedemptionError::ProofKeyMissing);
        assert_eq!(failure.cleanup, NativeGrantCleanupDisposition::NotAttempted);
        assert!(!never.0.load(Ordering::SeqCst));
        assert_eq!(
            empty_keys.restore(&prepared.owner).unwrap_err(),
            ProofKeyError::Missing
        );
        drop(listener);
    }

    #[test]
    fn cleanup_owner_index_is_readback_verified_before_broker_request() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let backend = MemoryNativeGrantBackend::default();
        backend.shared.lock().unwrap().fail_set_number = Some(1);
        let grants = NativeRelayGrantVault::new(backend.clone());
        let never = NeverTransport(AtomicBool::new(false));
        let service = NativeRelayRedemptionService::new(
            &*prepared.authority,
            &prepared.proof_keys,
            &never,
            &grants,
            || NOW,
        );
        let failure = service.redeem("Local", 7, prepared.invitation).unwrap_err();
        assert_eq!(failure.primary, NativeRedemptionError::GrantStore);
        assert_eq!(failure.cleanup, NativeGrantCleanupDisposition::NotAttempted);
        assert!(!never.0.load(Ordering::SeqCst));
        let shared = backend.shared.lock().unwrap();
        assert!(shared.values.is_empty());
    }

    #[test]
    fn cleanup_owner_registry_survives_vault_recreation_without_secrets() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let backend = MemoryNativeGrantBackend::default();
        let first = NativeRelayGrantVault::new(backend.clone());
        first.register_cleanup_owner(&prepared.owner).unwrap();
        drop(first);
        let restarted = NativeRelayGrantVault::new(backend.clone());
        assert_eq!(
            restarted
                .registered_cleanup_owners("io.kontourai.station", "stable")
                .unwrap(),
            vec![prepared.owner.clone()]
        );
        let account =
            native_grant_cleanup_owner_index_account("io.kontourai.station", "stable").unwrap();
        let encoded = backend
            .shared
            .lock()
            .unwrap()
            .values
            .get(&account)
            .unwrap()
            .clone();
        assert!(!encoded.contains(&"S".repeat(43)));
        assert!(!encoded.contains("grant_secret"));
    }

    #[test]
    fn wrong_owner_cannot_retry_or_clear_another_installations_cleanup() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let backend = MemoryNativeGrantBackend::default();
        let grants = NativeRelayGrantVault::new(backend.clone());
        let grant = sample_grant(&prepared, NOW + 3_600_000);
        grants.store(&prepared.owner, &grant, NOW).unwrap();
        let pending = grants
            .stage_cleanup(&prepared.owner, &grant, true, NOW)
            .unwrap();
        let wrong_owner = NativeProofKeyOwner::new(
            "io.kontourai.station",
            NativeProofKeyChannel::Stable,
            "44444444-4444-4444-8444-444444444444",
        )
        .unwrap();
        let never = NeverTransport(AtomicBool::new(false));
        let service = NativeRelayRedemptionService::new(
            &*prepared.authority,
            &prepared.proof_keys,
            &never,
            &grants,
            || NOW,
        );
        assert_eq!(
            service.retry_pending_cleanup(&wrong_owner, &pending.cleanup_id),
            Err(NativeRedemptionError::GrantMissing)
        );
        assert!(!never.0.load(Ordering::SeqCst));
        let original = grants
            .pending_cleanups(&prepared.owner)
            .unwrap()
            .into_iter()
            .find(|entry| entry.cleanup_id == pending.cleanup_id)
            .unwrap();
        assert!(!original.broker_retired);
        assert!(backend.shared.lock().unwrap().values.contains_key(
            &native_grant_cleanup_record_account(&prepared.owner, &pending.cleanup_id,).unwrap()
        ));
    }

    #[test]
    fn invitation_origin_and_expiry_are_checked_before_proof_or_http() {
        assert!(!canonical_station_origin("ftp://localhost"));
        assert!(canonical_station_origin("http://localhost"));
        assert!(canonical_station_origin("https://station.example.test"));
        for invalid in ["origin", "expiry"] {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let mut prepared = prepared(origin, 7);
            if invalid == "origin" {
                prepared.invitation.broker_origin = "https://untrusted.example".to_owned();
            } else {
                prepared.invitation.expires_at = NOW;
            }
            let never = NeverTransport(AtomicBool::new(false));
            let grants = NativeRelayGrantVault::new(MemoryNativeGrantBackend::default());
            let service = service(&prepared.authority, &prepared.proof_keys, &never, &grants);
            let expected = if invalid == "expiry" {
                NativeRedemptionError::InvitationExpired
            } else {
                NativeRedemptionError::InvitationInvalid
            };
            assert_eq!(
                service.redeem("Local", 7, prepared.invitation).unwrap_err(),
                expected
            );
            assert!(!never.0.load(Ordering::SeqCst));
            drop(listener);
        }
    }

    #[test]
    fn profile_revision_change_during_http_response_prevents_local_commit() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let origin = format!("http://{address}");
        let prepared = prepared(origin.clone(), 7);
        let grants = NativeRelayGrantVault::new(MemoryNativeGrantBackend::default());
        let mut preexisting = sample_grant(&prepared, NOW + 3_600_000);
        preexisting.credential.secret = SecretText(Zeroizing::new("O".repeat(43)));
        let preexisting_metadata = grants.store(&prepared.owner, &preexisting, NOW).unwrap();
        let changed = prepared.authority.clone();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let request = read_request(&mut socket);
            let (header, body) = request_header_body(&request);
            assert!(String::from_utf8_lossy(header)
                .to_ascii_lowercase()
                .starts_with("post /broker/v1/native/grants/redeem http/1.1"));
            changed.0.lock().unwrap().profile.revision = 8;
            let body = grant_body(body, NOW + 3_600_000);
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            socket.write_all(&body).unwrap();
            drop(socket);

            let (mut retire_socket, _) = listener.accept().unwrap();
            let retire = read_request(&mut retire_socket);
            let (retire_header, retire_body) = request_header_body(&retire);
            let retire_header = String::from_utf8_lossy(retire_header).to_ascii_lowercase();
            assert!(retire_header.starts_with("post /broker/v1/native/grants/retire http/1.1"));
            assert!(retire_header.contains(&format!("authorization: bearer {}", "s".repeat(43))));
            assert!(retire_header.contains(&format!("x-broker-credential-id: {}", "g".repeat(22))));
            assert!(!retire_header.contains("origin:"));
            assert!(!retire_header.contains("cookie:"));
            let retire_json: serde_json::Value = serde_json::from_slice(retire_body).unwrap();
            assert_eq!(
                retire_json
                    .as_object()
                    .unwrap()
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>(),
                vec!["scope", "surface", "version"]
            );
            assert_eq!(retire_json["version"], NATIVE_RETIRE_VERSION);
            let receipt = serde_json::json!({
                "version": NATIVE_RETIRE_VERSION,
                "retired": true,
            });
            let receipt = serde_json::to_vec(&receipt).unwrap();
            write!(
                retire_socket,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                receipt.len()
            )
            .unwrap();
            retire_socket.write_all(&receipt).unwrap();
            (request, retire)
        });
        let transport = UreqNativeBrokerTransport::new();
        let service = service(
            &prepared.authority,
            &prepared.proof_keys,
            &transport,
            &grants,
        );
        let failure = service.redeem("Local", 7, prepared.invitation).unwrap_err();
        assert_eq!(failure.primary, NativeRedemptionError::StaleProfile);
        assert_eq!(failure.cleanup, NativeGrantCleanupDisposition::Complete);
        let (redeem_request, retire_request) = server.join().unwrap();
        assert!(String::from_utf8_lossy(&redeem_request)
            .starts_with("POST /broker/v1/native/grants/redeem "));
        assert!(String::from_utf8_lossy(&retire_request)
            .starts_with("POST /broker/v1/native/grants/retire "));
        assert!(grants
            .metadata(&prepared.owner, &preexisting_metadata.route, NOW)
            .unwrap()
            .is_some());
        let binding = NativeRelayGrantBinding {
            owner: prepared.owner.clone(),
            route: preexisting_metadata.route.clone(),
        };
        let account = native_grant_account(&binding).unwrap();
        let backend = grants.backend.lock().unwrap();
        let shared = backend.shared.lock().unwrap();
        let stored: StoredNativeRelayGrantV2 =
            serde_json::from_str(shared.values.get(&account).unwrap()).unwrap();
        assert_eq!(stored.grant.credential.secret.expose(), "O".repeat(43));
    }

    #[test]
    fn stale_before_store_and_failed_retire_persists_cleanup_without_active_grant() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let origin = format!("http://{address}");
        let prepared = prepared(origin.clone(), 7);
        let changed = prepared.authority.clone();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let redeem = read_request(&mut socket);
            let (_, body) = request_header_body(&redeem);
            changed.0.lock().unwrap().profile.revision = 8;
            let grant = grant_body(body, NOW + 3_600_000);
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                grant.len()
            )
            .unwrap();
            socket.write_all(&grant).unwrap();
            drop(socket);

            let (mut retire, _) = listener.accept().unwrap();
            let request = read_request(&mut retire);
            let (header, _) = request_header_body(&request);
            let header = String::from_utf8_lossy(header).to_ascii_lowercase();
            assert!(header.starts_with("post /broker/v1/native/grants/retire http/1.1"));
            assert!(header.contains(&format!("authorization: bearer {}", "s".repeat(43))));
            write!(
                retire,
                "HTTP/1.1 503 Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        });
        let grants = NativeRelayGrantVault::new(MemoryNativeGrantBackend::default());
        let transport = UreqNativeBrokerTransport::new();
        let service = service(
            &prepared.authority,
            &prepared.proof_keys,
            &transport,
            &grants,
        );
        let failure = service.redeem("Local", 7, prepared.invitation).unwrap_err();
        assert_eq!(failure.primary, NativeRedemptionError::StaleProfile);
        assert_eq!(
            failure.cleanup,
            NativeGrantCleanupDisposition::Pending {
                local_revoke_failed: false,
                broker_retire_failed: true,
                custody_failed: false,
            }
        );
        assert_eq!(
            failure
                .recovery
                .as_ref()
                .map(|recovery| recovery.credential_status),
            Some(NativeGrantRecoveryCredentialStatus::DurablePending)
        );
        let expected_grant_id = "G".repeat(22);
        assert_eq!(
            failure
                .recovery
                .as_ref()
                .map(|recovery| recovery.grant_id.as_str()),
            Some(expected_grant_id.as_str())
        );
        server.join().unwrap();
        let recovery = failure.recovery.as_ref().unwrap();
        let cleanup_id = recovery.cleanup_id.as_deref().unwrap();
        let pending = grants
            .load_cleanup(&prepared.owner, cleanup_id)
            .unwrap()
            .unwrap();
        assert_eq!(pending.grant.credential.secret.expose(), "S".repeat(43));
        assert_eq!(
            grants
                .metadata(&prepared.owner, &pending.entry.route, NOW)
                .unwrap(),
            None
        );
        let backend = grants.backend.lock().unwrap();
        let shared = backend.shared.lock().unwrap();
        assert!(shared
            .values
            .keys()
            .all(|account| !account.starts_with(GRANT_ACCOUNT_PREFIX)));
    }

    #[test]
    fn duplicate_grant_id_retires_new_response_without_deleting_existing_keyring_secret() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let origin = format!("http://{address}");
        let prepared = prepared(origin.clone(), 7);
        let grants = NativeRelayGrantVault::new(MemoryNativeGrantBackend::default());
        let mut existing = sample_grant(&prepared, NOW + 3_600_000);
        existing.credential.secret = SecretText(Zeroizing::new("O".repeat(43)));
        let existing_metadata = grants.store(&prepared.owner, &existing, NOW).unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let redeem = read_request(&mut socket);
            let (_, body) = request_header_body(&redeem);
            let replacement_grant = grant_body(body, NOW + 3_600_000);
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                replacement_grant.len()
            )
            .unwrap();
            socket.write_all(&replacement_grant).unwrap();
            drop(socket);

            let (mut retire, _) = listener.accept().unwrap();
            let retire_request = read_request(&mut retire);
            let (header, _) = request_header_body(&retire_request);
            let header = String::from_utf8_lossy(header).to_ascii_lowercase();
            assert!(header.contains(&format!("authorization: bearer {}", "s".repeat(43))));
            let receipt = serde_json::to_vec(&serde_json::json!({
                "version": NATIVE_RETIRE_VERSION,
                "retired": true,
            }))
            .unwrap();
            write!(
                retire,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                receipt.len()
            )
            .unwrap();
            retire.write_all(&receipt).unwrap();
        });
        let transport = UreqNativeBrokerTransport::new();
        let service = service(
            &prepared.authority,
            &prepared.proof_keys,
            &transport,
            &grants,
        );
        let failure = service.redeem("Local", 7, prepared.invitation).unwrap_err();
        assert_eq!(failure.primary, NativeRedemptionError::GrantExists);
        assert_eq!(failure.cleanup, NativeGrantCleanupDisposition::Complete);
        server.join().unwrap();
        assert!(grants
            .metadata(&prepared.owner, &existing_metadata.route, NOW)
            .unwrap()
            .is_some());
        let binding = NativeRelayGrantBinding {
            owner: prepared.owner.clone(),
            route: existing_metadata.route,
        };
        let account = native_grant_account(&binding).unwrap();
        let backend = grants.backend.lock().unwrap();
        let shared = backend.shared.lock().unwrap();
        let stored: StoredNativeRelayGrantV2 =
            serde_json::from_str(shared.values.get(&account).unwrap()).unwrap();
        assert_eq!(stored.grant.credential.secret.expose(), "O".repeat(43));
    }

    #[test]
    fn ambiguous_keyring_write_preserves_retry_credential_when_broker_retire_fails() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let origin = format!("http://{address}");
        let prepared = prepared(origin.clone(), 7);
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let redeem_request = read_request(&mut socket);
            let (_, body) = request_header_body(&redeem_request);
            let grant = grant_body(body, NOW + 3_600_000);
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                grant.len()
            )
            .unwrap();
            socket.write_all(&grant).unwrap();
            drop(socket);

            let (mut retire_socket, _) = listener.accept().unwrap();
            let retire_request = read_request(&mut retire_socket);
            let (header, _) = request_header_body(&retire_request);
            let header = String::from_utf8_lossy(header).to_ascii_lowercase();
            assert!(header.starts_with("post /broker/v1/native/grants/retire http/1.1"));
            assert!(header.contains(&format!("authorization: bearer {}", "s".repeat(43))));
            assert!(header.contains(&format!("x-broker-credential-id: {}", "g".repeat(22))));
            write!(
                retire_socket,
                "HTTP/1.1 503 Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            retire_request
        });
        let backend = MemoryNativeGrantBackend::default();
        // Cleanup index, cleanup record, presence marker and active index are
        // persisted before the active payload write.
        backend.shared.lock().unwrap().fail_after_set_number = Some(5);
        let grants = NativeRelayGrantVault::new(backend);
        let transport = UreqNativeBrokerTransport::new();
        let service = service(
            &prepared.authority,
            &prepared.proof_keys,
            &transport,
            &grants,
        );
        let failure = service.redeem("Local", 7, prepared.invitation).unwrap_err();
        assert_eq!(failure.primary, NativeRedemptionError::GrantStore);
        assert_eq!(
            failure.cleanup,
            NativeGrantCleanupDisposition::Pending {
                local_revoke_failed: false,
                broker_retire_failed: true,
                custody_failed: false,
            }
        );
        let expected_grant_id = "G".repeat(22);
        assert_eq!(
            failure
                .recovery
                .as_ref()
                .map(|recovery| recovery.grant_id.as_str()),
            Some(expected_grant_id.as_str())
        );
        assert_eq!(
            failure
                .recovery
                .as_ref()
                .map(|recovery| recovery.credential_status),
            Some(NativeGrantRecoveryCredentialStatus::DurablePending)
        );
        server.join().unwrap();
        // Failed-retirement grants remain quarantined after an ambiguous
        // active-secret write.
        let route = failure.recovery.as_ref().unwrap();
        let route = NativeRelayGrantRoute {
            broker_origin: route.broker_origin.clone(),
            station_id: route.station_id.clone(),
            enrollment_id: route.enrollment_id.clone(),
            routing_generation: route.routing_generation,
            grant_id: route.grant_id.clone(),
        };
        assert!(grants
            .metadata(&prepared.owner, &route, NOW)
            .unwrap()
            .is_none());
        let backend = grants.backend.lock().unwrap();
        let shared = backend.shared.lock().unwrap();
        assert!(shared
            .values
            .values()
            .any(|value| value.contains(&"S".repeat(43))));
        assert!(shared
            .values
            .iter()
            .any(|(account, value)| { account.starts_with(GRANT_INDEX_PREFIX) && value != "[]" }));
    }

    #[test]
    fn dual_storage_and_retirement_failure_returns_secret_free_manual_recovery_data() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let prepared = prepared(origin.clone(), 7);
        let server = std::thread::spawn(move || {
            let (mut redeem_socket, _) = listener.accept().unwrap();
            let redeem = read_request(&mut redeem_socket);
            let (_, body) = request_header_body(&redeem);
            let grant = grant_body(body, NOW + 3_600_000);
            write!(
                redeem_socket,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                grant.len()
            )
            .unwrap();
            redeem_socket.write_all(&grant).unwrap();
            drop(redeem_socket);

            let (mut retire_socket, _) = listener.accept().unwrap();
            let retirement = read_request(&mut retire_socket);
            let (header, _) = request_header_body(&retirement);
            assert!(String::from_utf8_lossy(header)
                .to_ascii_lowercase()
                .starts_with("post /broker/v1/native/grants/retire http/1.1"));
            write!(
                retire_socket,
                "HTTP/1.1 503 Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        });
        let backend = MemoryNativeGrantBackend::default();
        {
            let mut state = backend.shared.lock().unwrap();
            // Owner registry succeeds; both the provisional cleanup index and
            // the compensation cleanup index fail, followed by broker refusal.
            state.fail_set_numbers.extend([2, 3]);
        }
        let grants = NativeRelayGrantVault::new(backend.clone());
        let transport = UreqNativeBrokerTransport::new();
        let service = service(
            &prepared.authority,
            &prepared.proof_keys,
            &transport,
            &grants,
        );
        let failure = service.redeem("Local", 7, prepared.invitation).unwrap_err();
        assert_eq!(failure.primary, NativeRedemptionError::GrantStore);
        assert_eq!(
            failure.cleanup,
            NativeGrantCleanupDisposition::Pending {
                local_revoke_failed: false,
                broker_retire_failed: true,
                custody_failed: false,
            }
        );
        let recovery = failure.recovery.as_ref().unwrap();
        assert_eq!(recovery.grant_id, "G".repeat(22));
        assert!(recovery.cleanup_id.is_none());
        assert_eq!(
            grants
                .cleanup_statuses_for_channel("io.kontourai.station", "stable")
                .unwrap(),
            Vec::new()
        );
        let wire =
            serde_json::to_value(NativeRelayGrantRedemptionResult::Failed { failure }).unwrap();
        let encoded = wire.to_string();
        assert_eq!(wire["status"], "failed");
        assert_eq!(wire["failure"]["primary"], "grantStore");
        assert_eq!(wire["failure"]["cleanup"]["status"], "pending");
        assert_eq!(
            wire["failure"]["cleanup"],
            serde_json::json!({
                "status": "pending",
                "localRevokeFailed": false,
                "brokerRetireFailed": true,
                "custodyFailed": false,
            })
        );
        assert_eq!(
            serde_json::to_value(NativeGrantCleanupDisposition::Complete).unwrap(),
            serde_json::json!("complete")
        );
        assert_eq!(
            serde_json::to_value(NativeGrantCleanupDisposition::NotAttempted).unwrap(),
            serde_json::json!("notAttempted")
        );
        assert_eq!(wire["failure"]["recovery"]["stationId"], STATION_ID);
        assert_eq!(wire["failure"]["recovery"]["grantId"], "G".repeat(22));
        assert!(!encoded.contains(&"S".repeat(43)));
        assert!(!encoded.contains(&"I".repeat(43)));
        server.join().unwrap();
        let persisted = backend.shared.lock().unwrap();
        assert!(persisted
            .values
            .keys()
            .all(|account| !account.starts_with(GRANT_CLEANUP_INDEX_PREFIX)));
    }

    #[test]
    fn lost_retire_ack_retries_after_vault_recreation_and_clears_exact_grant() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let origin = format!("http://{address}");
        let prepared = prepared(origin.clone(), 7);
        let proof_public_key = prepared.public.jwk().clone();
        let proof_broker_origin = origin.clone();
        let server = std::thread::spawn(move || {
            let (mut redeem_socket, _) = listener.accept().unwrap();
            let redeem = read_request(&mut redeem_socket);
            let (_, body) = request_header_body(&redeem);
            let grant = grant_body(body, NOW + 3_600_000);
            write!(
                redeem_socket,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                grant.len()
            )
            .unwrap();
            redeem_socket.write_all(&grant).unwrap();
            drop(redeem_socket);

            // Broker retires the credential but the acknowledgement is lost.
            let (mut first_retire, _) = listener.accept().unwrap();
            let first_request = read_request(&mut first_retire);
            let first_claims = verify_native_retire_request_proof(
                &first_request,
                &proof_public_key,
                &proof_broker_origin,
            );
            drop(first_retire);

            // Restart recovery repeats the exact fixed-path idempotent call.
            let (mut retry, _) = listener.accept().unwrap();
            let retry_request = read_request(&mut retry);
            let retry_claims = verify_native_retire_request_proof(
                &retry_request,
                &proof_public_key,
                &proof_broker_origin,
            );
            assert_ne!(first_claims["jti"], retry_claims["jti"]);
            assert_eq!(first_claims["bodySha256"], retry_claims["bodySha256"]);
            let receipt = serde_json::to_vec(&serde_json::json!({
                "version": NATIVE_RETIRE_VERSION,
                "retired": true,
            }))
            .unwrap();
            write!(
                retry,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                receipt.len()
            )
            .unwrap();
            retry.write_all(&receipt).unwrap();
        });
        let backend = MemoryNativeGrantBackend::default();
        backend.shared.lock().unwrap().fail_after_set_number = Some(5);
        let grants = NativeRelayGrantVault::new(backend.clone());
        let transport = UreqNativeBrokerTransport::new();
        let redemption_service = service(
            &prepared.authority,
            &prepared.proof_keys,
            &transport,
            &grants,
        );
        let failure = redemption_service
            .redeem("Local", 7, prepared.invitation)
            .unwrap_err();
        assert_eq!(failure.primary, NativeRedemptionError::GrantStore);
        let recovery = failure.recovery.as_ref().unwrap();
        let cleanup_id = recovery.cleanup_id.clone().unwrap();
        let route = NativeRelayGrantRoute {
            broker_origin: recovery.broker_origin.clone(),
            station_id: recovery.station_id.clone(),
            enrollment_id: recovery.enrollment_id.clone(),
            routing_generation: recovery.routing_generation,
            grant_id: recovery.grant_id.clone(),
        };
        assert!(grants
            .metadata(&prepared.owner, &route, NOW)
            .unwrap()
            .is_none());

        // Recreate the process-owned vault over the same OS-keyring backend.
        drop(redemption_service);
        drop(grants);
        let restarted_grants = NativeRelayGrantVault::new(backend);
        let restarted_service = service(
            &prepared.authority,
            &prepared.proof_keys,
            &transport,
            &restarted_grants,
        );
        assert_eq!(
            restarted_service
                .pending_cleanup_ids(&prepared.owner)
                .unwrap(),
            vec![cleanup_id.clone()]
        );
        prepared.authority.0.lock().unwrap().station_trust.status =
            NativeStationTrustStatus::Revoked;
        restarted_service
            .retry_pending_cleanup(&prepared.owner, &cleanup_id)
            .unwrap();
        server.join().unwrap();
        let route = NativeRelayGrantRoute {
            broker_origin: origin,
            station_id: STATION_ID.to_owned(),
            enrollment_id: ENROLLMENT_ID.to_owned(),
            routing_generation: 9,
            grant_id: "G".repeat(22),
        };
        assert!(restarted_grants
            .metadata(&prepared.owner, &route, NOW)
            .unwrap()
            .is_none());
        assert!(restarted_grants
            .pending_cleanups(&prepared.owner)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn index_only_pending_cleanup_survives_restart_and_stays_manual_revoke_only() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let backend = MemoryNativeGrantBackend::default();
        // Owner registry, cleanup index, then cleanup record.
        backend.shared.lock().unwrap().fail_set_number = Some(3);
        let first_vault = NativeRelayGrantVault::new(backend.clone());
        let grant = sample_grant(&prepared, NOW + 3_600_000);
        let route = native_route_for_grant(&grant);
        let failure = first_vault.store(&prepared.owner, &grant, NOW).unwrap_err();
        let cleanup_id = failure.cleanup_id.unwrap();
        assert!(first_vault
            .metadata(&prepared.owner, &route, NOW)
            .unwrap()
            .is_none());
        drop(first_vault);

        let restarted_vault = NativeRelayGrantVault::new(backend);
        assert!(restarted_vault
            .metadata(&prepared.owner, &route, NOW)
            .unwrap()
            .is_none());
        let pending = restarted_vault.pending_cleanups(&prepared.owner).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].cleanup_id, cleanup_id);
        assert!(!pending[0].record_present);
        assert!(restarted_vault
            .load_cleanup(&prepared.owner, &cleanup_id)
            .unwrap()
            .is_none());
        let transport = NeverTransport(AtomicBool::new(false));
        let service = service(
            &prepared.authority,
            &prepared.proof_keys,
            &transport,
            &restarted_vault,
        );
        assert_eq!(
            service
                .retry_pending_cleanup(&prepared.owner, &cleanup_id)
                .unwrap_err(),
            NativeRedemptionError::GrantStore
        );
        assert!(!transport.0.load(Ordering::SeqCst));
        assert!(restarted_vault
            .metadata(&prepared.owner, &route, NOW)
            .unwrap()
            .is_none());
        let backend = restarted_vault.backend.lock().unwrap();
        let shared = backend.shared.lock().unwrap();
        let encoded = shared
            .values
            .get(&native_grant_cleanup_index_account(&prepared.owner))
            .unwrap();
        assert!(!encoded.contains(&"S".repeat(43)));
    }

    #[test]
    fn cleanup_retry_never_deletes_a_replacement_with_the_same_route() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let vault = NativeRelayGrantVault::new(MemoryNativeGrantBackend::default());
        let mut replacement = sample_grant(&prepared, NOW + 3_600_000);
        replacement.credential.secret = SecretText(Zeroizing::new("O".repeat(43)));
        let metadata = vault.store(&prepared.owner, &replacement, NOW).unwrap();
        let candidate = sample_grant(&prepared, NOW + 3_600_000);
        let pending = vault
            .stage_cleanup(&prepared.owner, &candidate, true, NOW)
            .unwrap();
        assert!(vault
            .metadata(&prepared.owner, &metadata.route, NOW)
            .unwrap()
            .is_none());
        let transport = SuccessfulRetirement;
        let service = service(
            &prepared.authority,
            &prepared.proof_keys,
            &transport,
            &vault,
        );
        service
            .retry_pending_cleanup(&prepared.owner, &pending.cleanup_id)
            .unwrap();
        assert!(vault
            .metadata(&prepared.owner, &metadata.route, NOW)
            .unwrap()
            .is_some());
        let binding = NativeRelayGrantBinding {
            owner: prepared.owner.clone(),
            route: metadata.route,
        };
        let account = native_grant_account(&binding).unwrap();
        let backend = vault.backend.lock().unwrap();
        let shared = backend.shared.lock().unwrap();
        let stored: StoredNativeRelayGrantV2 =
            serde_json::from_str(shared.values.get(&account).unwrap()).unwrap();
        assert_eq!(stored.grant.credential.secret.expose(), "O".repeat(43));
    }

    #[test]
    fn request_transport_refuses_redirects_and_bounds_responses_and_time() {
        let (origin, redirect_server) = spawn_server(|_| (302, b"redirect body".to_vec()));
        let transport = UreqNativeBrokerTransport::new();
        let response = transport.redeem(&origin, b"{}").unwrap();
        assert_eq!(response.status, 302);
        redirect_server.join().unwrap();

        let (origin, oversized_server) =
            spawn_server(|_| (200, vec![b'x'; MAX_RESPONSE_BYTES + 1]));
        assert!(matches!(
            transport.redeem(&origin, b"{}"),
            Err(NativeRedemptionError::BrokerTransport)
        ));
        oversized_server.join().unwrap();

        let (origin, slow_server) = spawn_server(|_| {
            std::thread::sleep(Duration::from_millis(750));
            (200, b"{}".to_vec())
        });
        let short = UreqNativeBrokerTransport::with_timeout(Duration::from_millis(300));
        assert!(matches!(
            short.redeem(&origin, b"{}"),
            Err(NativeRedemptionError::BrokerTransport)
        ));
        slow_server.join().unwrap();
    }

    #[test]
    fn grant_index_write_failure_keeps_only_cleanup_quarantine() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let backend = MemoryNativeGrantBackend::default();
        // Owner registry, quarantine index, cleanup record, presence marker,
        // then the active grant index.
        backend.shared.lock().unwrap().fail_set_number = Some(5);
        let vault = NativeRelayGrantVault::new(backend);
        let grant = sample_grant(&prepared, NOW + 3_600_000);
        let route = native_route_for_grant(&grant);
        assert_eq!(
            vault
                .store(&prepared.owner, &grant, NOW)
                .unwrap_err()
                .primary,
            NativeRedemptionError::GrantStore
        );
        let backend = vault.backend.lock().unwrap();
        let shared = backend.shared.lock().unwrap();
        let active_account = native_grant_account(&NativeRelayGrantBinding {
            owner: prepared.owner.clone(),
            route: route.clone(),
        })
        .unwrap();
        assert!(!shared.values.contains_key(&active_account));
        assert!(shared
            .values
            .keys()
            .all(|account| !account.starts_with(GRANT_ACCOUNT_PREFIX)));
        assert!(shared
            .values
            .iter()
            .filter(|(account, _)| account.starts_with(GRANT_INDEX_PREFIX))
            .all(|(_, value)| value == "[]"));
        assert!(shared
            .values
            .values()
            .any(|value| value.contains(&"S".repeat(43))));
    }

    #[test]
    fn cleanup_index_write_failure_aborts_before_active_grant_publication() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let backend = MemoryNativeGrantBackend::default();
        // The owner index is written first; failure at #2 targets quarantine.
        backend.shared.lock().unwrap().fail_set_number = Some(2);
        let vault = NativeRelayGrantVault::new(backend);
        let grant = sample_grant(&prepared, NOW + 3_600_000);
        let route = native_route_for_grant(&grant);
        let failure = vault.store(&prepared.owner, &grant, NOW).unwrap_err();
        assert_eq!(
            failure.write_disposition,
            NativeGrantStoreWriteDisposition::NotWritten
        );
        assert_eq!(failure.cleanup_id, None);
        assert!(vault
            .metadata(&prepared.owner, &route, NOW)
            .unwrap()
            .is_none());
        let account = native_grant_account(&NativeRelayGrantBinding {
            owner: prepared.owner.clone(),
            route,
        })
        .unwrap();
        let backend = vault.backend.lock().unwrap();
        let shared = backend.shared.lock().unwrap();
        assert!(!shared.values.contains_key(&account));
        assert!(shared
            .values
            .values()
            .all(|value| !value.contains(&"S".repeat(43))));
    }

    #[test]
    fn cleanup_record_write_failure_leaves_index_only_quarantine_for_manual_revoke() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let backend = MemoryNativeGrantBackend::default();
        // Owner registry, quarantine index, then cleanup record.
        backend.shared.lock().unwrap().fail_set_number = Some(3);
        let vault = NativeRelayGrantVault::new(backend);
        let grant = sample_grant(&prepared, NOW + 3_600_000);
        let route = native_route_for_grant(&grant);
        let failure = vault.store(&prepared.owner, &grant, NOW).unwrap_err();
        assert_eq!(
            failure.write_disposition,
            NativeGrantStoreWriteDisposition::NotWritten
        );
        let cleanup_id = failure.cleanup_id.as_deref().unwrap();
        assert!(vault
            .load_cleanup(&prepared.owner, cleanup_id)
            .unwrap()
            .is_none());
        assert!(vault
            .metadata(&prepared.owner, &route, NOW)
            .unwrap()
            .is_none());
        let index = vault.pending_cleanups(&prepared.owner).unwrap();
        assert_eq!(index.len(), 1);
        assert_eq!(index[0].cleanup_id, cleanup_id);
        assert!(!index[0].record_present);
        let backend = vault.backend.lock().unwrap();
        let shared = backend.shared.lock().unwrap();
        let encoded = shared
            .values
            .get(&native_grant_cleanup_index_account(&prepared.owner))
            .unwrap();
        assert!(!encoded.contains(&"S".repeat(43)));
        assert!(shared
            .values
            .keys()
            .all(|account| !account.starts_with(GRANT_ACCOUNT_PREFIX)));
    }

    #[test]
    fn provisional_record_delete_failure_keeps_quarantine_indexed_across_restart() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let backend = MemoryNativeGrantBackend::default();
        backend.shared.lock().unwrap().fail_delete_number = Some(1);
        let first_vault = NativeRelayGrantVault::new(backend.clone());
        let grant = sample_grant(&prepared, NOW + 3_600_000);
        let route = native_route_for_grant(&grant);
        let failure = first_vault.store(&prepared.owner, &grant, NOW).unwrap_err();
        assert_eq!(
            failure.write_disposition,
            NativeGrantStoreWriteDisposition::MayHaveWritten
        );
        let cleanup_id = failure.cleanup_id.unwrap();
        assert!(first_vault
            .metadata(&prepared.owner, &route, NOW)
            .unwrap()
            .is_none());
        let pending = first_vault.pending_cleanups(&prepared.owner).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].cleanup_id, cleanup_id);
        assert!(pending[0].record_present);
        let record_account =
            native_grant_cleanup_record_account(&prepared.owner, &cleanup_id).unwrap();
        {
            let backend = first_vault.backend.lock().unwrap();
            let shared = backend.shared.lock().unwrap();
            assert!(shared
                .values
                .get(&record_account)
                .unwrap()
                .contains(&"S".repeat(43)));
            assert!(shared
                .values
                .get(&native_grant_cleanup_index_account(&prepared.owner))
                .unwrap()
                .contains(&cleanup_id));
        }
        drop(first_vault);

        let restarted_vault = NativeRelayGrantVault::new(backend);
        assert!(restarted_vault
            .metadata(&prepared.owner, &route, NOW)
            .unwrap()
            .is_none());
        let transport = SuccessfulRetirement;
        let service = service(
            &prepared.authority,
            &prepared.proof_keys,
            &transport,
            &restarted_vault,
        );
        service
            .retry_pending_cleanup(&prepared.owner, &cleanup_id)
            .unwrap();
        assert!(restarted_vault
            .metadata(&prepared.owner, &route, NOW)
            .unwrap()
            .is_none());
        assert!(restarted_vault
            .pending_cleanups(&prepared.owner)
            .unwrap()
            .is_empty());
        let backend = restarted_vault.backend.lock().unwrap();
        let shared = backend.shared.lock().unwrap();
        assert!(shared
            .values
            .values()
            .all(|value| !value.contains(&"S".repeat(43))));
    }

    #[test]
    fn provisional_record_delete_then_error_recovers_from_active_grant_after_restart() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let backend = MemoryNativeGrantBackend::default();
        backend.shared.lock().unwrap().fail_after_delete_number = Some(1);
        let first_vault = NativeRelayGrantVault::new(backend.clone());
        let grant = sample_grant(&prepared, NOW + 3_600_000);
        let route = native_route_for_grant(&grant);
        let failure = first_vault.store(&prepared.owner, &grant, NOW).unwrap_err();
        assert_eq!(
            failure.write_disposition,
            NativeGrantStoreWriteDisposition::MayHaveWritten
        );
        let cleanup_id = failure.cleanup_id.unwrap();
        let record_account =
            native_grant_cleanup_record_account(&prepared.owner, &cleanup_id).unwrap();
        {
            let backend = first_vault.backend.lock().unwrap();
            let shared = backend.shared.lock().unwrap();
            assert!(!shared.values.contains_key(&record_account));
            assert!(shared
                .values
                .get(&native_grant_cleanup_index_account(&prepared.owner))
                .unwrap()
                .contains(&cleanup_id));
        }
        assert!(first_vault
            .metadata(&prepared.owner, &route, NOW)
            .unwrap()
            .is_none());
        drop(first_vault);

        let restarted_vault = NativeRelayGrantVault::new(backend);
        assert!(restarted_vault
            .metadata(&prepared.owner, &route, NOW)
            .unwrap()
            .is_none());
        let transport = SuccessfulRetirement;
        let service = service(
            &prepared.authority,
            &prepared.proof_keys,
            &transport,
            &restarted_vault,
        );
        service
            .retry_pending_cleanup(&prepared.owner, &cleanup_id)
            .unwrap();
        assert!(restarted_vault
            .pending_cleanups(&prepared.owner)
            .unwrap()
            .is_empty());
        assert!(restarted_vault
            .metadata(&prepared.owner, &route, NOW)
            .unwrap()
            .is_none());
        let backend = restarted_vault.backend.lock().unwrap();
        let shared = backend.shared.lock().unwrap();
        assert!(shared
            .values
            .values()
            .all(|value| !value.contains(&"S".repeat(43))));
    }

    #[test]
    fn native_grant_maximum_age_is_twenty_four_hours() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let too_long = sample_grant(&prepared, NOW + MAX_GRANT_AGE_MS + 1);
        assert_eq!(
            validate_native_grant(&prepared.owner, &too_long, NOW).unwrap_err(),
            NativeRedemptionError::GrantInvalid
        );
        let at_limit = sample_grant(&prepared, NOW + MAX_GRANT_AGE_MS);
        assert!(validate_native_grant(&prepared.owner, &at_limit, NOW).is_ok());
    }

    #[test]
    fn stored_grant_metadata_revalidates_proof_jwk_thumbprint() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let vault = NativeRelayGrantVault::new(MemoryNativeGrantBackend::default());
        let grant = sample_grant(&prepared, NOW + 3_600_000);
        let metadata = vault.store(&prepared.owner, &grant, NOW).unwrap();
        let binding = NativeRelayGrantBinding {
            owner: prepared.owner.clone(),
            route: metadata.route.clone(),
        };
        let account = native_grant_account(&binding).unwrap();
        {
            let backend = vault.backend.lock().unwrap();
            let mut shared = backend.shared.lock().unwrap();
            let encoded = shared.values.get_mut(&account).unwrap();
            let mut payload: serde_json::Value = serde_json::from_str(encoded).unwrap();
            payload["grant"]["proofPublicKey"]["x"] = serde_json::Value::String("X".repeat(43));
            *encoded = serde_json::to_string(&payload).unwrap();
        }
        assert_eq!(
            vault
                .metadata(&prepared.owner, &metadata.route, NOW)
                .unwrap_err(),
            NativeRedemptionError::GrantInvalid
        );
    }

    fn sample_grant(prepared: &Prepared, expires_at: u64) -> NativeRelayClientGrantV2 {
        NativeRelayClientGrantV2 {
            version: NATIVE_GRANT_VERSION.to_owned(),
            broker_origin: prepared.invitation.broker_origin.clone(),
            scope: prepared.invitation.scope.clone(),
            station_signing_key_id: prepared.invitation.station_signing_key_id.clone(),
            station_signing_generation: prepared.invitation.station_signing_generation,
            surface: prepared.invitation.surface.clone(),
            proof_public_key: prepared.public.jwk().clone(),
            credential: NativeRelayCredential {
                id: "G".repeat(22),
                secret: SecretText(Zeroizing::new("S".repeat(43))),
            },
            expires_at,
        }
    }

    #[test]
    fn candidate_producer_binds_the_current_profile_device_and_route_before_manager_custody() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let mut context = prepared.authority.0.lock().unwrap().clone();
        let station_owner = NativeProofKeyOwner::new(
            "io.kontourai.station",
            NativeProofKeyChannel::Stable,
            "88888888-8888-4888-8888-888888888888",
        )
        .unwrap();
        let station_keys = crate::native_relay_proof_key::MemoryNativeRelayProofKeyVault::new();
        let station_public = station_keys.create(&station_owner).unwrap();
        context.station_trust.signing_key = station_public.jwk().clone();
        let mut grant = sample_grant(&prepared, NOW + 3_600_000);
        grant.station_signing_key_id = station_signing_key_id(station_public.jwk());
        assert_ne!(grant.station_signing_key_id, grant.surface.key_thumbprint);
        let identity = crate::native_device_custody::CurrentDeviceIdentity {
            device_id: "55555555-5555-4555-8555-555555555555".into(),
            device_kind: "device".into(),
            binding_id: "66666666-6666-4666-8666-666666666666".into(),
            profile_revision: 7,
        };
        let authority = device_candidate_authority_from_current_owners(
            &context.profile,
            &context.station_trust,
            &identity,
            "Paired Device Profile",
            INSTANCE_ID,
            &context.profile.station_endpoint,
            STATION_ID,
            &grant,
        )
        .unwrap();
        let candidate_backend = crate::native_proof_key_core::MemorySecretBackend::default();
        let manager =
            crate::native_device_binding_candidate::NativeDeviceBindingCandidateManager::new(
                candidate_backend,
            );
        let keys = crate::native_device_proof_key::MemoryNativeDeviceProofKeyVault::new();
        let candidate =
            serde_json::to_value(manager.candidate(&authority, &keys).unwrap()).unwrap();
        assert_eq!(candidate["stationId"], STATION_ID);
        assert_eq!(candidate["deviceId"], identity.device_id);
        assert_eq!(
            candidate["surface"]["keyThumbprint"],
            grant.surface.key_thumbprint
        );
        assert_eq!(candidate["surface"]["clientInstanceId"], INSTANCE_ID);

        let mut transitioned = identity.clone();
        transitioned.device_id = "77777777-7777-4777-8777-777777777777".into();
        let next_authority = device_candidate_authority_from_current_owners(
            &context.profile,
            &context.station_trust,
            &transitioned,
            "Paired Device Profile",
            INSTANCE_ID,
            &context.profile.station_endpoint,
            STATION_ID,
            &grant,
        )
        .unwrap();
        assert!(manager.candidate(&next_authority, &keys).is_err());

        assert!(device_candidate_authority_from_current_owners(
            &context.profile,
            &context.station_trust,
            &identity,
            "Paired Device Profile",
            INSTANCE_ID,
            &context.profile.station_endpoint,
            "99999999-9999-4999-8999-999999999999",
            &grant,
        )
        .is_err());

        let mut stale = identity;
        stale.profile_revision += 1;
        assert!(device_candidate_authority_from_current_owners(
            &context.profile,
            &context.station_trust,
            &stale,
            "Paired Device Profile",
            INSTANCE_ID,
            &context.profile.station_endpoint,
            STATION_ID,
            &grant,
        )
        .is_err());
    }

    #[test]
    fn profile_route_status_and_revoke_quarantine_survive_vault_restart() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let backend = MemoryNativeGrantBackend::default();
        let vault = NativeRelayGrantVault::new(backend.clone());
        let context = prepared.authority.0.lock().unwrap().clone();
        let grant = sample_grant(&prepared, NOW + 3_600_000);
        vault.store(&prepared.owner, &grant, NOW).unwrap();

        let status = vault
            .metadata_for_context(&prepared.owner, &context, NOW)
            .unwrap();
        assert_eq!(status.len(), 1);
        assert_eq!(status[0].metadata.route, native_route_for_grant(&grant));
        assert!(!status[0].expired);

        let cleanups = vault
            .stage_context_cleanup(&prepared.owner, &context, NOW)
            .unwrap();
        assert_eq!(cleanups.len(), 1);
        assert!(!cleanups[0].broker_retired);
        assert!(vault
            .metadata_for_context(&prepared.owner, &context, NOW)
            .unwrap()
            .is_empty());

        drop(vault);
        let restarted = NativeRelayGrantVault::new(backend);
        assert_eq!(
            restarted
                .registered_cleanup_owners("io.kontourai.station", "stable")
                .unwrap(),
            vec![prepared.owner.clone()]
        );
        assert_eq!(
            restarted
                .cleanup_statuses_for_profile_route(
                    &prepared.owner,
                    "https://broker.example",
                    STATION_ID,
                    ENROLLMENT_ID,
                )
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn route_status_and_cleanup_remain_available_without_station_trust() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let vault = NativeRelayGrantVault::new(MemoryNativeGrantBackend::default());
        let grant = sample_grant(&prepared, NOW + 3_600_000);
        let route = native_route_for_grant(&grant);
        vault.store(&prepared.owner, &grant, NOW).unwrap();

        let visible = vault
            .metadata_for_profile_route(
                &prepared.owner,
                "https://broker.example",
                STATION_ID,
                ENROLLMENT_ID,
                NOW,
            )
            .unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].metadata.route, route);

        let staged = vault
            .stage_removed_profile_route_cleanup(
                &prepared.owner,
                "https://broker.example",
                STATION_ID,
                ENROLLMENT_ID,
                NOW,
            )
            .unwrap();
        assert_eq!(staged.len(), 1);
        assert!(vault
            .metadata_for_profile_route(
                &prepared.owner,
                "https://broker.example",
                STATION_ID,
                ENROLLMENT_ID,
                NOW,
            )
            .unwrap()
            .is_empty());
        assert_eq!(
            vault
                .cleanup_statuses_for_profile_route(
                    &prepared.owner,
                    "https://broker.example",
                    STATION_ID,
                    ENROLLMENT_ID,
                )
                .unwrap(),
            staged
        );
    }

    #[test]
    fn route_revoke_waits_for_inflight_redemption_then_retires_its_grant() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let grants = NativeRelayGrantVault::new(MemoryNativeGrantBackend::default());
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let transport = BlockingRedeemTransport {
            started: started_tx,
            release: Mutex::new(release_rx),
        };
        let service = service(
            &prepared.authority,
            &prepared.proof_keys,
            &transport,
            &grants,
        );
        let owner = prepared.owner.clone();
        let invitation = prepared.invitation;
        let service_ref = &service;
        let grants_ref = &grants;
        let route = NativeRelayGrantRoute {
            broker_origin: "https://broker.example".to_owned(),
            station_id: STATION_ID.to_owned(),
            enrollment_id: ENROLLMENT_ID.to_owned(),
            routing_generation: 9,
            grant_id: "G".repeat(22),
        };
        let staged = std::thread::scope(|scope| {
            let redeem = scope.spawn(move || service_ref.redeem("Local", 7, invitation));
            started_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("redemption reached the blocked broker response");

            let (revoked_tx, revoked_rx) = mpsc::channel();
            let (attempt_tx, attempt_rx) = mpsc::channel();
            let revocation_owner = owner.clone();
            let revocation = scope.spawn(move || {
                attempt_tx.send(()).unwrap();
                let result = with_native_relay_route_operation_lock(|| {
                    grants_ref
                        .stage_removed_profile_route_cleanup(
                            &revocation_owner,
                            "https://broker.example",
                            STATION_ID,
                            ENROLLMENT_ID,
                            NOW,
                        )
                        .map_err(|_| "grant quarantine failed".to_owned())
                });
                revoked_tx.send(result).unwrap();
            });
            attempt_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("revocation reached the serialized route operation");
            assert!(matches!(
                revoked_rx.recv_timeout(Duration::from_millis(100)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ));
            release_tx.send(()).unwrap();
            redeem.join().unwrap().unwrap();
            let staged = revoked_rx
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap();
            revocation.join().unwrap();
            staged
        });

        assert_eq!(staged.len(), 1);
        assert_eq!(staged[0].route, route);
        assert!(grants
            .metadata(&prepared.owner, &route, NOW)
            .unwrap()
            .is_none());
        service
            .retry_pending_cleanup(&prepared.owner, &staged[0].cleanup_id)
            .unwrap();
        assert!(grants.pending_cleanups(&prepared.owner).unwrap().is_empty());
        assert!(grants
            .metadata(&prepared.owner, &route, NOW)
            .unwrap()
            .is_none());
    }
}

#[cfg(test)]
#[derive(Clone, Default)]
struct MemoryNativeGrantBackend {
    shared: Arc<Mutex<MemoryNativeGrantBackendState>>,
}

#[cfg(test)]
#[derive(Default)]
struct MemoryNativeGrantBackendState {
    values: HashMap<String, String>,
    fail_set_number: Option<usize>,
    fail_set_numbers: HashSet<usize>,
    fail_after_set_number: Option<usize>,
    sets: usize,
    fail_delete_number: Option<usize>,
    fail_after_delete_number: Option<usize>,
    deletes: usize,
}

#[cfg(test)]
impl NativeGrantBackend for MemoryNativeGrantBackend {
    fn get(&mut self, account: &str) -> RedemptionResult<Option<Zeroizing<String>>> {
        Ok(self
            .shared
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?
            .values
            .get(account)
            .map(|value| Zeroizing::new(value.clone())))
    }
    fn set(&mut self, account: &str, value: &str) -> RedemptionResult<()> {
        let mut shared = self
            .shared
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        shared.sets += 1;
        if shared.fail_set_number == Some(shared.sets)
            || shared.fail_set_numbers.contains(&shared.sets)
        {
            return Err(NativeRedemptionError::GrantStore);
        }
        shared.values.insert(account.to_owned(), value.to_owned());
        if shared.fail_after_set_number == Some(shared.sets) {
            return Err(NativeRedemptionError::GrantStore);
        }
        Ok(())
    }
    fn delete(&mut self, account: &str) -> RedemptionResult<()> {
        let mut shared = self
            .shared
            .lock()
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        shared.deletes += 1;
        if shared.fail_delete_number == Some(shared.deletes) {
            return Err(NativeRedemptionError::GrantStore);
        }
        shared.values.remove(account);
        if shared.fail_after_delete_number == Some(shared.deletes) {
            return Err(NativeRedemptionError::GrantStore);
        }
        Ok(())
    }
}

pub(crate) struct NativeRelayRedemptionService<'a, P, K, H, G, C> {
    context_provider: &'a P,
    proof_keys: &'a K,
    http: &'a H,
    grants: &'a G,
    now: C,
}

/// Renderer-safe input for the host-owned native signaling diagnostic. The
/// credential and proof key are deliberately absent; the host loads and uses
/// them from OS custody after resolving the selected saved profile.
pub(crate) struct NativeRelaySignalOpenRequest {
    pub(crate) profile_name: String,
    pub(crate) expected_profile_revision: u64,
    pub(crate) nonce: String,
    pub(crate) offer_sdp: String,
}

pub(crate) struct NativeRelaySignalReadRequest {
    pub(crate) profile_name: String,
    pub(crate) expected_profile_revision: u64,
    pub(crate) nonce: String,
}

/// Exact IPC input for the opt-in signaling diagnostic. It intentionally has
/// no bearer, key, broker URL, or application payload fields.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeRelaySignalDiagnosticOpenInput {
    profile_name: String,
    expected_profile_revision: u64,
    nonce: String,
    offer_sdp: String,
}

/// Exact IPC input for polling a previously opened diagnostic offer.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeRelaySignalDiagnosticReadInput {
    profile_name: String,
    expected_profile_revision: u64,
    nonce: String,
}

/// Secret-free broker receipt; it contains no URL, bearer, or signing key.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeRelaySignalOpened {
    pub(crate) expires_at: u64,
}

/// Signaling-only data returned to the native host. This does not authorize or
/// carry application traffic; the transport proof is returned as opaque data
/// for the separate native verification layer.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeRelaySignalAnswer {
    pub(crate) answer_sdp: Option<String>,
    pub(crate) station_proof: Option<String>,
    pub(crate) expires_at: u64,
}

/// Host-derived, secret-free descriptor used only by the opt-in renderer
/// diagnostic. The saved profile revision and approved Station key are read
/// under the same profile/trust lock as signaling admission.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeRelayDiagnosticBinding {
    profile_name: String,
    profile_revision: u64,
    scope: NativeRelayScopeV2,
    surface: NativeRelayClientSurfaceV2,
    trust_revision: u64,
    station_id: String,
    enrollment_id: String,
    generation: u64,
    signing_key: P256PublicJwk,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeRelayDiagnosticBindingInput {
    profile_name: String,
    expected_profile_revision: u64,
}

fn diagnostic_binding_from_current(
    profile_name: &str,
    expected_profile_revision: u64,
    context: NativeRedemptionContext,
    grant: NativeRelayClientGrantV2,
) -> RedemptionResult<NativeRelayDiagnosticBinding> {
    if context.profile.profile_name != profile_name
        || context.profile.revision != expected_profile_revision
        || context.station_trust.status != NativeStationTrustStatus::Approved
        || grant.surface.kind != "station-native"
        || grant.scope.station_id != context.profile.station_id
        || grant.scope.enrollment_id != context.profile.enrollment_id
        || grant.surface.app_identifier != context.profile.app_identifier
        || grant.surface.channel != context.profile.channel.keyring_label()
        || grant.surface.client_instance_id != context.profile.client_instance_id
    {
        return Err(NativeRedemptionError::StaleProfile);
    }
    Ok(NativeRelayDiagnosticBinding {
        profile_name: context.profile.profile_name,
        profile_revision: context.profile.revision,
        scope: grant.scope,
        surface: grant.surface,
        trust_revision: context.station_trust.revision,
        station_id: context.station_trust.station_id,
        enrollment_id: context.station_trust.enrollment_id,
        generation: context.station_trust.generation,
        signing_key: context.station_trust.signing_key,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeRelaySignalOpenedWire {
    version: String,
    expires_at: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeRelaySignalAnswerWire {
    version: String,
    answer_sdp: RequiredNullableText,
    station_proof: RequiredNullableText,
    expires_at: u64,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RequiredNullableText {
    Text(String),
    Null(()),
}

impl RequiredNullableText {
    fn into_option(self) -> Option<String> {
        match self {
            Self::Text(value) => Some(value),
            Self::Null(()) => None,
        }
    }
}

const NATIVE_SIGNAL_OPENED_VERSION: &str = "station-broker-native-connection-opened/v2";
const NATIVE_SIGNAL_ANSWER_VERSION: &str = "station-broker-native-connection-answer/v2";

/// Narrow host service for v2 broker signaling. It has no route or URL input,
/// never returns a grant bearer, and rechecks the saved profile, approved
/// Station trust and exact keyring grant after every broker round trip.
pub(crate) struct NativeRelaySignalService<'a, P, K, H, G, C> {
    context_provider: &'a P,
    proof_keys: &'a K,
    http: &'a H,
    grants: &'a G,
    now: C,
}

impl<'a, P, K, H, G, C> NativeRelaySignalService<'a, P, K, H, G, C>
where
    P: NativeRedemptionContextProvider,
    K: NativeProofKeyOperations,
    H: NativeBrokerRequestTransport,
    G: NativeGrantCustody,
    C: Fn() -> u64,
{
    pub(crate) fn new(
        context_provider: &'a P,
        proof_keys: &'a K,
        http: &'a H,
        grants: &'a G,
        now: C,
    ) -> Self {
        Self {
            context_provider,
            proof_keys,
            http,
            grants,
            now,
        }
    }

    /// The caller retains `request.nonce` if transport fails: open may have
    /// committed at the broker before its response was lost. The broker
    /// expires that offer after 30 seconds; use the same nonce with `read`
    /// during that window instead of retrying open (which is replay-rejected).
    pub(crate) fn open(
        &self,
        request: &NativeRelaySignalOpenRequest,
    ) -> RedemptionResult<NativeRelaySignalOpened> {
        if !valid_safe_id(&request.nonce)
            || request.offer_sdp.is_empty()
            || request.offer_sdp.as_bytes().len() > MAX_NATIVE_SIGNAL_SDP_BYTES
        {
            return Err(NativeRedemptionError::GrantInvalid);
        }
        let (context, owner, grant) =
            self.load_current_grant(&request.profile_name, request.expected_profile_revision)?;
        let now = (self.now)();
        if grant.expires_at.saturating_sub(now) < MIN_NATIVE_SIGNAL_OPEN_GRANT_LIFETIME_MS {
            return Err(NativeRedemptionError::GrantExpired);
        }
        let challenge = NativeBrokerRequestProofChallenge::from_request(
            native_request_identity(&grant),
            NativeBrokerRequestBody::Open {
                nonce: &request.nonce,
                offer_sdp: &request.offer_sdp,
            },
            (self.now)() / 1000,
        )
        .map_err(|_| NativeRedemptionError::GrantInvalid)?;
        let signature = self
            .proof_keys
            .sign_native_request(&owner, &challenge)
            .map_err(|_| NativeRedemptionError::ProofKey)?;
        let compact_proof = challenge
            .compact_jws(&signature)
            .map_err(|_| NativeRedemptionError::ProofKey)?;
        let response = self
            .http
            .send_fixed_request(&grant, &challenge, &compact_proof);
        let recheck = self.recheck_current_grant(&request.profile_name, &context, &owner, &grant);
        recheck?;
        let response = response?;
        if response.status != 200 || response.body.len() > MAX_RESPONSE_BYTES {
            return Err(NativeRedemptionError::BrokerRejected);
        }
        let receipt: NativeRelaySignalOpenedWire = serde_json::from_slice(&response.body)
            .map_err(|_| NativeRedemptionError::BrokerRejected)?;
        let now = (self.now)();
        if receipt.version != NATIVE_SIGNAL_OPENED_VERSION
            || receipt.expires_at <= now
            || receipt.expires_at > now.saturating_add(MAX_NATIVE_SIGNAL_RESPONSE_HORIZON_MS)
            || receipt.expires_at > grant.expires_at
        {
            return Err(NativeRedemptionError::BrokerRejected);
        }
        Ok(NativeRelaySignalOpened {
            expires_at: receipt.expires_at,
        })
    }

    pub(crate) fn read(
        &self,
        request: &NativeRelaySignalReadRequest,
    ) -> RedemptionResult<NativeRelaySignalAnswer> {
        if !valid_safe_id(&request.nonce) {
            return Err(NativeRedemptionError::GrantInvalid);
        }
        let (context, owner, grant) =
            self.load_current_grant(&request.profile_name, request.expected_profile_revision)?;
        let challenge = NativeBrokerRequestProofChallenge::from_request(
            native_request_identity(&grant),
            NativeBrokerRequestBody::Read {
                nonce: &request.nonce,
            },
            (self.now)() / 1000,
        )
        .map_err(|_| NativeRedemptionError::GrantInvalid)?;
        let signature = self
            .proof_keys
            .sign_native_request(&owner, &challenge)
            .map_err(|_| NativeRedemptionError::ProofKey)?;
        let compact_proof = challenge
            .compact_jws(&signature)
            .map_err(|_| NativeRedemptionError::ProofKey)?;
        let response = self
            .http
            .send_fixed_request(&grant, &challenge, &compact_proof);
        let recheck = self.recheck_current_grant(&request.profile_name, &context, &owner, &grant);
        recheck?;
        let response = response?;
        if response.status != 200 || response.body.len() > MAX_RESPONSE_BYTES {
            return Err(NativeRedemptionError::BrokerRejected);
        }
        let answer: NativeRelaySignalAnswerWire = serde_json::from_slice(&response.body)
            .map_err(|_| NativeRedemptionError::BrokerRejected)?;
        let now = (self.now)();
        let answer_sdp = answer.answer_sdp.into_option();
        let station_proof = answer.station_proof.into_option();
        if answer.version != NATIVE_SIGNAL_ANSWER_VERSION
            || answer_sdp.is_some() != station_proof.is_some()
            || answer_sdp.as_ref().is_some_and(|sdp| {
                sdp.is_empty() || sdp.as_bytes().len() > MAX_NATIVE_SIGNAL_SDP_BYTES
            })
            || station_proof.as_ref().is_some_and(|proof| {
                proof.is_empty() || proof.as_bytes().len() > MAX_NATIVE_SIGNAL_PROOF_BYTES
            })
            || answer.expires_at <= now
            || answer.expires_at > now.saturating_add(MAX_NATIVE_SIGNAL_RESPONSE_HORIZON_MS)
            || answer.expires_at > grant.expires_at
        {
            return Err(NativeRedemptionError::BrokerRejected);
        }
        Ok(NativeRelaySignalAnswer {
            answer_sdp,
            station_proof,
            expires_at: answer.expires_at,
        })
    }

    /// Renew a routing grant without exposing its bearer or accepting a
    /// renderer-supplied renewal ID. A persisted intent makes a lost broker
    /// response retry the same renewal instead of extending the lease twice.
    pub(crate) fn renew(
        &self,
        profile_name: &str,
        expected_profile_revision: u64,
    ) -> RedemptionResult<NativeRelayGrantMetadata> {
        let (context, owner, record) =
            self.context_provider
                .with_current_context(profile_name, |context| {
                    validate_profile_context(&context)?;
                    if context.profile.profile_name != profile_name
                        || context.profile.revision != expected_profile_revision
                    {
                        return Err(NativeRedemptionError::StaleProfile);
                    }
                    let owner = NativeProofKeyOwner::new(
                        &context.profile.app_identifier,
                        context.profile.channel,
                        &context.profile.client_instance_id,
                    )
                    .map_err(|_| NativeRedemptionError::InvalidProfile)?;
                    let record =
                        self.grants
                            .load_request_grant(&owner, &context, (self.now)(), true)?;
                    Ok((context, owner, record))
                })?;
        let grant = &record.grant;
        let intent = match record.renewal_intent {
            Some(intent) => {
                validate_native_renewal_intent(&intent, grant)?;
                intent
            }
            None => {
                let renewal_id = uuid::Uuid::new_v4().to_string();
                let challenge = NativeBrokerRequestProofChallenge::from_request(
                    native_request_identity(grant),
                    NativeBrokerRequestBody::Renew {
                        renewal_id: &renewal_id,
                        expected_expires_at: grant.expires_at,
                    },
                    (self.now)() / 1000,
                )
                .map_err(|_| NativeRedemptionError::GrantInvalid)?;
                let intent = NativeGrantRenewalIntent {
                    renewal_id,
                    expected_expires_at: grant.expires_at,
                    request_body: challenge.body().to_vec(),
                };
                self.grants.save_renewal_intent(&owner, grant, intent)?
            }
        };
        let challenge = NativeBrokerRequestProofChallenge::from_request(
            native_request_identity(grant),
            NativeBrokerRequestBody::Renew {
                renewal_id: &intent.renewal_id,
                expected_expires_at: intent.expected_expires_at,
            },
            (self.now)() / 1000,
        )
        .map_err(|_| NativeRedemptionError::GrantInvalid)?;
        if challenge.body() != intent.request_body {
            return Err(NativeRedemptionError::GrantRenewalConflict);
        }
        let signature = self
            .proof_keys
            .sign_native_request(&owner, &challenge)
            .map_err(|_| NativeRedemptionError::ProofKey)?;
        let compact_proof = challenge
            .compact_jws(&signature)
            .map_err(|_| NativeRedemptionError::ProofKey)?;
        let response = self
            .http
            .send_fixed_request(grant, &challenge, &compact_proof);
        self.context_provider
            .with_current_context(profile_name, |current| {
                validate_profile_context(&current)?;
                if current != context {
                    return Err(NativeRedemptionError::StaleProfile);
                }
                let latest =
                    self.grants
                        .load_request_grant(&owner, &current, (self.now)(), true)?;
                if !same_native_grant(&latest.grant, grant)
                    || latest.renewal_intent.as_ref() != Some(&intent)
                {
                    return Err(NativeRedemptionError::GrantRenewalConflict);
                }
                let response = response?;
                if response.status != 200 || response.body.len() > MAX_RESPONSE_BYTES {
                    return Err(NativeRedemptionError::BrokerRejected);
                }
                let receipt: NativeGrantRenewalReceipt = serde_json::from_slice(&response.body)
                    .map_err(|_| NativeRedemptionError::BrokerRejected)?;
                self.grants
                    .complete_renewal(&owner, grant, &intent, &receipt, (self.now)())
            })
    }

    fn load_current_grant(
        &self,
        profile_name: &str,
        expected_profile_revision: u64,
    ) -> RedemptionResult<(
        NativeRedemptionContext,
        NativeProofKeyOwner,
        NativeRelayClientGrantV2,
    )> {
        self.context_provider
            .with_current_context(profile_name, |context| {
                validate_profile_context(&context)?;
                if context.profile.profile_name != profile_name
                    || context.profile.revision != expected_profile_revision
                {
                    return Err(NativeRedemptionError::StaleProfile);
                }
                let owner = NativeProofKeyOwner::new(
                    &context.profile.app_identifier,
                    context.profile.channel,
                    &context.profile.client_instance_id,
                )
                .map_err(|_| NativeRedemptionError::InvalidProfile)?;
                let record =
                    self.grants
                        .load_request_grant(&owner, &context, (self.now)(), false)?;
                Ok((context, owner, record.grant))
            })
    }

    fn recheck_current_grant(
        &self,
        profile_name: &str,
        expected_context: &NativeRedemptionContext,
        owner: &NativeProofKeyOwner,
        expected_grant: &NativeRelayClientGrantV2,
    ) -> RedemptionResult<()> {
        self.context_provider
            .with_current_context(profile_name, |context| {
                validate_profile_context(&context)?;
                if &context != expected_context {
                    return Err(NativeRedemptionError::StaleProfile);
                }
                let record =
                    self.grants
                        .load_request_grant(owner, &context, (self.now)(), false)?;
                if !same_native_grant(&record.grant, expected_grant) {
                    return Err(NativeRedemptionError::GrantInvalid);
                }
                Ok(())
            })
    }
}

impl<'a, P, K, H, G, C> NativeRelayRedemptionService<'a, P, K, H, G, C>
where
    P: NativeRedemptionContextProvider,
    K: NativeProofKeyOperations,
    H: NativeBrokerTransport + NativeBrokerRequestTransport,
    G: NativeGrantCustody,
    C: Fn() -> u64,
{
    pub(crate) fn new(
        context_provider: &'a P,
        proof_keys: &'a K,
        http: &'a H,
        grants: &'a G,
        now: C,
    ) -> Self {
        Self {
            context_provider,
            proof_keys,
            http,
            grants,
            now,
        }
    }

    fn retire_pending_grant(
        &self,
        owner: &NativeProofKeyOwner,
        grant: &NativeRelayClientGrantV2,
    ) -> RedemptionResult<()> {
        if grant.surface.app_identifier != owner.app_identifier()
            || grant.surface.channel != owner.channel_label()
            || grant.surface.client_instance_id != owner.client_instance_id()
        {
            return Err(NativeRedemptionError::GrantInvalid);
        }
        let challenge = NativeBrokerRequestProofChallenge::from_request(
            native_request_identity(grant),
            NativeBrokerRequestBody::Retire,
            (self.now)() / 1000,
        )
        .map_err(|_| NativeRedemptionError::GrantInvalid)?;
        let signature = self
            .proof_keys
            .sign_native_request(owner, &challenge)
            .map_err(|_| NativeRedemptionError::ProofKey)?;
        let compact_proof = challenge
            .compact_jws(&signature)
            .map_err(|_| NativeRedemptionError::ProofKey)?;
        let response = self
            .http
            .send_fixed_request(grant, &challenge, &compact_proof)?;
        if response.status != 200 {
            return Err(NativeRedemptionError::BrokerRejected);
        }
        let receipt: NativeGrantRetireReceipt = serde_json::from_slice(&response.body)
            .map_err(|_| NativeRedemptionError::BrokerRejected)?;
        if receipt.version != NATIVE_RETIRE_VERSION || !receipt.retired {
            return Err(NativeRedemptionError::BrokerRejected);
        }
        Ok(())
    }

    pub(crate) fn pending_cleanup_ids(
        &self,
        owner: &NativeProofKeyOwner,
    ) -> RedemptionResult<Vec<String>> {
        Ok(self
            .grants
            .pending_cleanups(owner)?
            .into_iter()
            .map(|entry| entry.cleanup_id)
            .collect())
    }

    pub(crate) fn retry_pending_cleanup(
        &self,
        owner: &NativeProofKeyOwner,
        cleanup_id: &str,
    ) -> RedemptionResult<()> {
        self.retry_cleanup_with_fallback(owner, cleanup_id, None)
            .map_err(|failure| failure.error)
    }

    fn retry_cleanup_with_fallback(
        &self,
        owner: &NativeProofKeyOwner,
        cleanup_id: &str,
        fallback: Option<&NativeRelayClientGrantV2>,
    ) -> Result<(), NativeGrantCleanupAttemptFailure> {
        let loaded = self
            .grants
            .load_cleanup(owner, cleanup_id)
            .map_err(NativeGrantCleanupAttemptFailure::custody)?;
        let (entry, grant) = match loaded {
            Some(pending) => (Some(pending.entry), Some(pending.grant)),
            None => {
                let entry = self
                    .grants
                    .pending_cleanups(owner)
                    .map_err(NativeGrantCleanupAttemptFailure::custody)?
                    .into_iter()
                    .find(|entry| entry.cleanup_id == cleanup_id)
                    .ok_or_else(|| {
                        NativeGrantCleanupAttemptFailure::custody(
                            NativeRedemptionError::GrantMissing,
                        )
                    })?;
                (Some(entry), None)
            }
        };
        let Some(entry) = entry else {
            return Err(NativeGrantCleanupAttemptFailure::custody(
                NativeRedemptionError::GrantMissing,
            ));
        };
        if grant.is_none()
            && (entry.broker_retired || entry.remote_basis.is_some())
            && entry.local_cleanup_complete
        {
            return self
                .grants
                .finish_cleanup(owner, cleanup_id)
                .map_err(NativeGrantCleanupAttemptFailure::custody);
        }
        let grant = grant.as_ref().or(fallback).ok_or_else(|| {
            NativeGrantCleanupAttemptFailure::custody(NativeRedemptionError::GrantStore)
        })?;
        if native_route_for_grant(grant) != entry.route {
            return Err(NativeGrantCleanupAttemptFailure::custody(
                NativeRedemptionError::GrantInvalid,
            ));
        }
        if !entry.broker_retired && entry.remote_basis.is_none() {
            self.retire_pending_grant(owner, grant)
                .map_err(NativeGrantCleanupAttemptFailure::broker)?;
            self.grants
                .mark_broker_retired(owner, cleanup_id)
                .map_err(NativeGrantCleanupAttemptFailure::custody)?;
        }
        if entry.local_cleanup_required && !entry.local_cleanup_complete {
            self.grants
                .revoke_if_matches(owner, grant)
                .map_err(NativeGrantCleanupAttemptFailure::local)?;
            self.grants
                .mark_local_cleanup_complete(owner, cleanup_id)
                .map_err(NativeGrantCleanupAttemptFailure::custody)?;
        }
        self.grants
            .finish_cleanup(owner, cleanup_id)
            .map_err(NativeGrantCleanupAttemptFailure::custody)
    }

    pub(crate) fn recover_link_cleanup(
        &self,
        profile_name: &str,
        expected_revision: u64,
        invitation: &NativeRelayInvitationV2,
        observe: impl Fn(
            &NativeProofKeyOwner,
            &NativeRelayClientGrantV2,
        ) -> RedemptionResult<NativeSupersededScopeObservation>,
        cancellation: (&AtomicBool, &Mutex<()>),
    ) -> RedemptionResult<Vec<NativeRelayRecoveryOutcome>> {
        let _route_guard = native_relay_route_operation_guard()?;
        let before = self
            .context_provider
            .with_current_context(profile_name, |context| {
                if context.profile.revision != expected_revision
                    || cancellation.0.load(Ordering::Acquire)
                {
                    return Err(NativeRedemptionError::StaleProfile);
                }
                validate_invitation_and_trust(&context, invitation, (self.now)(), None)?;
                Ok(context)
            })?;
        let owner = NativeProofKeyOwner::new(
            &before.profile.app_identifier,
            before.profile.channel,
            &before.profile.client_instance_id,
        )
        .map_err(|_| NativeRedemptionError::InvalidProfile)?;
        let public = self
            .proof_keys
            .restore(&owner)
            .map_err(|_| NativeRedemptionError::ProofKey)?;
        validate_invitation_and_trust(&before, invitation, (self.now)(), Some(&public))?;
        let staged = self
            .context_provider
            .with_current_context(profile_name, |current| {
                if current != before || cancellation.0.load(Ordering::Acquire) {
                    return Err(NativeRedemptionError::StaleProfile);
                }
                self.grants
                    .stage_context_cleanup(&owner, &current, (self.now)())
            })?;
        let mut outcomes = Vec::new();
        for entry in staged.into_iter().take(MAX_BACKGROUND_CLEANUP_RETRIES) {
            let Some(pending) = self.grants.load_cleanup(&owner, &entry.cleanup_id)? else {
                outcomes.push(NativeRelayRecoveryOutcome {
                    route: entry.route,
                    remote_basis: None,
                    local_cleanup_complete: false,
                    failure: Some(NativeRedemptionError::GrantStore),
                });
                continue;
            };
            let basis = pending
                .entry
                .remote_basis
                .clone()
                .or(if pending.entry.broker_retired {
                    Some(NativeCleanupRemoteBasis::IndividualGrantRetired)
                } else {
                    None
                });
            let remote = match basis {
                Some(basis) => Ok(basis),
                None => match self.retire_pending_grant(&owner, &pending.grant) {
                    Ok(()) => Ok(NativeCleanupRemoteBasis::IndividualGrantRetired),
                    Err(_)
                        if older_grant_matches_invitation(&owner, &pending.grant, invitation) =>
                    {
                        observe(&owner, &pending.grant).map(|observation| {
                            NativeCleanupRemoteBasis::SupersededGenerationObserved { observation }
                        })
                    }
                    Err(error) => Err(error),
                },
            };
            let recovered = remote.and_then(|basis| {
                // Keyring reads can block. Pending replacement remains free to
                // cancel this attempt until the short destructive commit.
                let fresh = self
                    .proof_keys
                    .restore(&owner)
                    .map_err(|_| NativeRedemptionError::ProofKey)?;
                let _commit = cancellation
                    .1
                    .lock()
                    .map_err(|_| NativeRedemptionError::GrantStore)?;
                self.context_provider
                    .with_current_context(profile_name, |current| {
                        if current != before
                            || current.profile.revision != expected_revision
                            || cancellation.0.load(Ordering::Acquire)
                        {
                            return Err(NativeRedemptionError::StaleProfile);
                        }
                        validate_invitation_and_trust(
                            &current,
                            invitation,
                            (self.now)(),
                            Some(&public),
                        )?;
                        if fresh != public {
                            return Err(NativeRedemptionError::ProofKey);
                        }
                        self.grants.record_recovery_basis(
                            &owner,
                            &entry.cleanup_id,
                            &pending.grant,
                            basis.clone(),
                        )?;
                        self.retry_pending_cleanup(&owner, &entry.cleanup_id)?;
                        Ok(basis)
                    })
            });
            let recorded_basis = if let Ok(basis) = &recovered {
                Some(basis.clone())
            } else {
                self.grants
                    .pending_cleanups(&owner)?
                    .into_iter()
                    .find(|pending| pending.cleanup_id == entry.cleanup_id)
                    .and_then(|pending| {
                        pending.remote_basis.or(if pending.broker_retired {
                            Some(NativeCleanupRemoteBasis::IndividualGrantRetired)
                        } else {
                            None
                        })
                    })
            };
            outcomes.push(NativeRelayRecoveryOutcome {
                route: entry.route,
                local_cleanup_complete: recovered.is_ok(),
                remote_basis: recorded_basis,
                failure: recovered.err(),
            });
        }
        Ok(outcomes)
    }

    pub(crate) fn redeem(
        &self,
        profile_name: &str,
        expected_profile_revision: u64,
        invitation: NativeRelayInvitationV2,
    ) -> Result<NativeRelayGrantMetadata, NativeRedemptionFailure> {
        self.redeem_with_cancellation(profile_name, expected_profile_revision, invitation, None)
    }

    pub(crate) fn redeem_with_cancellation(
        &self,
        profile_name: &str,
        expected_profile_revision: u64,
        invitation: NativeRelayInvitationV2,
        cancellation: Option<(&AtomicBool, &Mutex<()>)>,
    ) -> Result<NativeRelayGrantMetadata, NativeRedemptionFailure> {
        self.redeem_with_request_gate(
            profile_name,
            expected_profile_revision,
            invitation,
            cancellation,
            || Ok(()),
        )
    }

    pub(crate) fn redeem_with_request_gate(
        &self,
        profile_name: &str,
        expected_profile_revision: u64,
        invitation: NativeRelayInvitationV2,
        cancellation: Option<(&AtomicBool, &Mutex<()>)>,
        before_request: impl FnOnce() -> RedemptionResult<()>,
    ) -> Result<NativeRelayGrantMetadata, NativeRedemptionFailure> {
        let check_cancelled = || {
            if cancellation.is_some_and(|(cancelled, _)| cancelled.load(Ordering::Acquire)) {
                Err(NativeRedemptionError::StaleProfile)
            } else {
                Ok(())
            }
        };
        check_cancelled()?;
        let _route_operation_guard =
            native_relay_route_operation_guard().map_err(NativeRedemptionFailure::from)?;
        let before = self
            .context_provider
            .with_current_context(profile_name, |context| {
                validate_profile_context(&context)?;
                if context.profile.profile_name != profile_name
                    || context.profile.revision != expected_profile_revision
                {
                    return Err(NativeRedemptionError::StaleProfile);
                }
                validate_invitation_and_trust(&context, &invitation, (self.now)(), None)?;
                Ok(context)
            })?;
        let owner = NativeProofKeyOwner::new(
            &before.profile.app_identifier,
            before.profile.channel,
            &before.profile.client_instance_id,
        )
        .map_err(|_| NativeRedemptionError::InvalidProfile)?;
        let unresolved_cleanup = self
            .grants
            .pending_cleanups(&owner)?
            .into_iter()
            .any(|entry| {
                entry.route.broker_origin == before.profile.broker_origin
                    && entry.route.station_id == before.profile.station_id
                    && entry.route.enrollment_id == before.profile.enrollment_id
                    && (!entry.broker_retired
                        || (entry.local_cleanup_required && !entry.local_cleanup_complete))
            });
        if unresolved_cleanup {
            return Err(NativeRedemptionError::GrantStore.into());
        }
        // Persist the secret-free owner identity before any broker can issue
        // a credential. Every post-request compensation path can then be
        // discovered after a profile edit or process restart.
        self.grants.register_cleanup_owner(&owner)?;
        let public = match self.proof_keys.restore(&owner) {
            Ok(public) => public,
            Err(ProofKeyError::Missing) => {
                return Err(NativeRedemptionError::ProofKeyMissing.into())
            }
            Err(_) => return Err(NativeRedemptionError::ProofKey.into()),
        };
        validate_invitation_and_trust(&before, &invitation, (self.now)(), Some(&public))?;
        let challenge_invitation = NativeBrokerRedemptionInvitation {
            broker_origin: invitation.broker_origin.clone(),
            station_id: invitation.scope.station_id.clone(),
            enrollment_id: invitation.scope.enrollment_id.clone(),
            routing_generation: invitation.scope.routing_generation,
            station_signing_key_id: invitation.station_signing_key_id.clone(),
            station_signing_generation: invitation.station_signing_generation,
            app_identifier: invitation.surface.app_identifier.clone(),
            invitation_id: invitation.invitation_id.clone(),
            invitation_secret: Zeroizing::new(invitation.invitation_secret.expose().to_owned()),
            expires_at: invitation.expires_at,
        };
        let challenge =
            NativeBrokerRedemptionChallenge::from_invitation(&owner, &public, challenge_invitation)
                .map_err(|_| NativeRedemptionError::InvitationInvalid)?;
        let signature = self
            .proof_keys
            .sign(&owner, &challenge)
            .map_err(|_| NativeRedemptionError::ProofKey)?;
        let proof = NativeRedemptionProof {
            public_key: public.jwk(),
            nonce: challenge.nonce(),
            jws: challenge
                .compact_jws(&signature)
                .map_err(|_| NativeRedemptionError::ProofKey)?,
        };
        let request_body = Zeroizing::new(
            serde_json::to_vec(&NativeRedemptionRequest {
                invitation: &invitation,
                proof,
            })
            .map_err(|_| NativeRedemptionError::InvitationInvalid)?,
        );
        if request_body.len() > MAX_REQUEST_BYTES {
            return Err(NativeRedemptionError::InvitationInvalid.into());
        }
        self.context_provider
            .with_current_context(profile_name, |current| {
                if current != before || current.profile.revision != expected_profile_revision {
                    return Err(NativeRedemptionError::StaleProfile);
                }
                validate_profile_context(&current)?;
                validate_invitation_and_trust(&current, &invitation, (self.now)(), Some(&public))
            })?;
        check_cancelled()?;
        before_request()?;
        let response = self
            .http
            .redeem(&before.profile.broker_origin, &request_body)?;
        if response.status != 200 {
            return Err(NativeRedemptionError::BrokerRejected.into());
        }
        let grant: NativeRelayClientGrantV2 = serde_json::from_slice(&response.body)
            .map_err(|_| NativeRedemptionError::GrantInvalid)?;
        let now = (self.now)();
        let route = validate_returned_grant(&before, &invitation, &public, &grant, now)?;
        let mut store_write_disposition: Option<NativeGrantStoreWriteDisposition> = None;
        let mut store_cleanup_id: Option<String> = None;
        let commit_result = self
            .context_provider
            .with_current_context(profile_name, |current| {
                // Cancel and grant commit share this fence. Network I/O never
                // holds it, so cancellation can reject a late broker reply.
                let _commit_guard = match cancellation {
                    Some((_, gate)) => Some(
                        gate.lock()
                            .map_err(|_| NativeRedemptionError::StaleProfile)?,
                    ),
                    None => None,
                };
                check_cancelled()?;
                if current != before || current.profile.revision != expected_profile_revision {
                    return Err(NativeRedemptionError::StaleProfile);
                }
                validate_profile_context(&current)?;
                validate_invitation_and_trust(&current, &invitation, now, Some(&public))?;
                let metadata = match self.grants.store(&owner, &grant, now) {
                    Ok(metadata) => {
                        store_write_disposition =
                            Some(NativeGrantStoreWriteDisposition::MayHaveWritten);
                        metadata
                    }
                    Err(failure) => {
                        store_write_disposition = Some(failure.write_disposition);
                        store_cleanup_id = failure.cleanup_id;
                        return Err(failure.primary);
                    }
                };
                if metadata.route != route {
                    return Err(NativeRedemptionError::GrantInvalid);
                }
                check_cancelled()?;
                Ok(metadata)
            });
        if let Err(primary) = commit_result {
            // Exact local revoke and self-retire target only this returned
            // grant ID and credential. Cleanup status is returned separately
            // so it never masks the original profile/storage failure.
            let local_cleanup_required = matches!(
                store_write_disposition,
                Some(NativeGrantStoreWriteDisposition::MayHaveWritten)
            );
            let cleanup_id = match store_cleanup_id {
                Some(cleanup_id) => Some(cleanup_id),
                None => self
                    .grants
                    .stage_cleanup(&owner, &grant, local_cleanup_required, now)
                    .ok()
                    .map(|entry| entry.cleanup_id),
            };
            let cleanup_result = if let Some(cleanup_id) = cleanup_id.as_deref() {
                self.retry_cleanup_with_fallback(&owner, cleanup_id, Some(&grant))
            } else {
                match self.retire_pending_grant(&owner, &grant) {
                    Err(error) => Err(NativeGrantCleanupAttemptFailure::broker(error)),
                    Ok(()) if local_cleanup_required => self
                        .grants
                        .revoke_if_matches(&owner, &grant)
                        .map(|_| ())
                        .map_err(NativeGrantCleanupAttemptFailure::local),
                    Ok(()) => Ok(()),
                }
            };
            let cleanup = match &cleanup_result {
                Ok(()) => NativeGrantCleanupDisposition::Complete,
                Err(failure) => NativeGrantCleanupDisposition::Pending {
                    local_revoke_failed: failure.local_revoke_failed,
                    broker_retire_failed: failure.broker_retire_failed,
                    custody_failed: failure.custody_failed,
                },
            };
            let durable_cleanup_record = cleanup_id.as_deref().is_some_and(|cleanup_id| {
                self.grants
                    .load_cleanup(&owner, cleanup_id)
                    .ok()
                    .flatten()
                    .is_some_and(|pending| pending.durable_cleanup_record)
            });
            let recovery = cleanup_result.err().map(|failure| NativeGrantRecoveryInfo {
                broker_origin: route.broker_origin.clone(),
                station_id: route.station_id.clone(),
                enrollment_id: route.enrollment_id.clone(),
                routing_generation: route.routing_generation,
                grant_id: route.grant_id.clone(),
                cleanup_id,
                cleanup_error: Some(failure.error),
                credential_status: if durable_cleanup_record {
                    NativeGrantRecoveryCredentialStatus::DurablePending
                } else if local_cleanup_required
                    && (failure.broker_retire_failed
                        || failure.local_revoke_failed
                        || failure.custody_failed)
                {
                    NativeGrantRecoveryCredentialStatus::RetainedOrUnknown
                } else {
                    NativeGrantRecoveryCredentialStatus::NotStored
                },
            });
            return Err(NativeRedemptionFailure {
                primary,
                cleanup,
                recovery,
            });
        }
        commit_result.map_err(NativeRedemptionFailure::from)
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_grant_redeem(
    window: tauri::WebviewWindow,
    app: AppHandle,
    profile_name: String,
    expected_profile_revision: u64,
    invitation: NativeRelayInvitationV2,
) -> Result<NativeRelayGrantRedemptionResult, String> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    if profile_name.is_empty() || profile_name.len() > 256 {
        return Err("The selected saved Station name is invalid.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let context = AppNativeRedemptionContextProvider::new(app.clone());
        let proof_keys = NativeRelayProofKeyVault::new();
        let http = UreqNativeBrokerTransport::new();
        let grants = native_relay_grant_vault();
        let service = NativeRelayRedemptionService::new(
            &context,
            &proof_keys,
            &http,
            &grants,
            native_now_ms_or_zero,
        );
        match service.redeem(&profile_name, expected_profile_revision, invitation) {
            Ok(grant) => Ok(NativeRelayGrantRedemptionResult::Redeemed { grant }),
            Err(failure) => Ok(NativeRelayGrantRedemptionResult::Failed { failure }),
        }
    })
    .await
    .map_err(|_| "Station could not redeem the native relay invitation.".to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_grant_status(
    window: tauri::WebviewWindow,
    app: AppHandle,
    profile_name: String,
) -> Result<NativeRelayGrantState, String> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    if profile_name.is_empty() || profile_name.len() > 256 {
        return Err("The selected saved Station name is invalid.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let grants = native_relay_grant_vault();
        with_locked_saved_enrollment_profile_store(
            &app,
            &profile_name,
            None,
            true,
            |profile, _locked_snapshot, _, _| {
                let owner = NativeProofKeyOwner::new(
                    &profile.app_identifier,
                    profile.channel,
                    &profile.client_instance_id,
                )
                .map_err(|_| NativeRedemptionError::InvalidProfile)?;
                Ok(NativeRelayGrantState::for_saved_profile(
                    &profile,
                    grants.metadata_for_profile_route(
                        &owner,
                        &profile.broker_origin,
                        &profile.station_id,
                        &profile.enrollment_id,
                        native_now_ms_or_zero(),
                    )?,
                    grants.cleanup_statuses_for_profile_route(
                        &owner,
                        &profile.broker_origin,
                        &profile.station_id,
                        &profile.enrollment_id,
                    )?,
                ))
            },
        )
        .map_err(|_| "Station could not read native relay grant status.".to_owned())
    })
    .await
    .map_err(|_| "Station could not read native relay grant status.".to_owned())?
}

/// Creates or resumes one host-owned provisional Device binding candidate.
/// The renderer selects only a saved profile and expected revision; all
/// Station, Device, route, surface and key-owner fields come from current
/// locked host snapshots. This command does no approval, receipt
/// reconciliation, peer-session work, or signing.
fn device_candidate_authority_from_current_owners(
    profile: &NativeRelayProfileSnapshot,
    station_trust: &ApprovedNativeStationTrust,
    identity: &crate::native_device_custody::CurrentDeviceIdentity,
    active_profile_name: &str,
    client_instance_id: &str,
    exact_origin: &str,
    environment_id: &str,
    grant: &NativeRelayClientGrantV2,
) -> Result<crate::native_device_binding_candidate::NativeDeviceBindingCandidateAuthority, String> {
    if active_profile_name.is_empty()
        || active_profile_name.len() > 256
        || identity.profile_revision != profile.revision
        || client_instance_id != profile.client_instance_id
        || exact_origin != profile.station_endpoint
        || environment_id != profile.station_id
        || identity.device_kind != "device"
        || station_trust.status != NativeStationTrustStatus::Approved
        || station_trust.station_id != profile.station_id
        || station_trust.enrollment_id != profile.enrollment_id
        || station_trust.station_endpoint != profile.station_endpoint
        || grant.broker_origin != profile.broker_origin
        || grant.scope.station_id != profile.station_id
        || grant.scope.enrollment_id != profile.enrollment_id
        || grant.surface.kind != "station-native"
        || grant.surface.app_identifier != profile.app_identifier
        || grant.surface.channel != profile.channel.keyring_label()
        || grant.surface.client_instance_id != profile.client_instance_id
        || grant.station_signing_generation != station_trust.generation
        || station_signing_key_id(&station_trust.signing_key) != grant.station_signing_key_id
    {
        return Err("The current Device candidate owners do not agree".into());
    }
    let route = native_route_for_grant(grant);
    Ok(crate::native_device_binding_candidate::NativeDeviceBindingCandidateAuthority::from_current_owners(
        profile.profile_name.clone(),
        profile.revision,
        station_trust.revision,
        identity.binding_id.clone(),
        profile.app_identifier.clone(),
        profile.channel,
        profile.client_instance_id.clone(),
        profile.station_id.clone(),
        identity.device_id.clone(),
        crate::native_device_binding_candidate::NativeDeviceBindingSurfaceV1::from_current_route(
            grant.surface.kind.clone(),
            grant.surface.app_identifier.clone(),
            grant.surface.channel.clone(),
            grant.surface.client_instance_id.clone(),
            grant.surface.key_thumbprint.clone(),
        ),
        crate::native_device_binding_candidate::NativeDeviceBindingRouteV1::from_current_route(
            route.broker_origin,
            route.station_id,
            route.enrollment_id,
            route.routing_generation,
            route.grant_id,
        ),
    ))
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_device_binding_candidate(
    window: tauri::WebviewWindow,
    app: AppHandle,
    profile_name: String,
    expected_profile_revision: u64,
) -> Result<crate::native_device_binding_candidate::NativeDeviceBindingCandidateV1, String> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    if profile_name.is_empty()
        || profile_name.len() > 256
        || expected_profile_revision == 0
        || expected_profile_revision > JS_SAFE_INTEGER_MAX
    {
        return Err("The selected Device candidate profile is invalid.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        with_locked_saved_relay_profile_store(
            &app,
            &profile_name,
            |profile, locked_snapshot, store, path| {
                if profile.revision != expected_profile_revision {
                    return Err(NativeRedemptionError::StaleProfile);
                }
                let mut trust_store = NativeStationTrustStore::system();
                let approved = trust_store
                    .approved_descriptor_for_locked_profile(&locked_snapshot)
                    .map_err(|error| match error {
                        CandidateError::TrustStore => {
                            NativeRedemptionError::StationTrustUnavailable
                        }
                        _ => NativeRedemptionError::StationTrustRequired,
                    })?;
                let station_trust = approved_station_trust(&profile, approved)?;
                let context = NativeRedemptionContext {
                    profile: profile.clone(),
                    station_trust: station_trust.clone(),
                };
                let relay_owner = NativeProofKeyOwner::new(
                    &profile.app_identifier,
                    profile.channel,
                    &profile.client_instance_id,
                )
                .map_err(|_| NativeRedemptionError::InvalidProfile)?;
                let grants = native_relay_grant_vault();
                let grant = grants
                    .load_request_grant(&relay_owner, &context, native_now_ms_or_zero(), false)?
                    .grant;

                let candidate = super::with_active_device_identity_in_locked_profile(
                    &app,
                    store,
                    path,
                    |identity, active_profile_name, client_instance_id, exact_origin, environment_id| {
                        let authority = device_candidate_authority_from_current_owners(
                            &profile,
                            &station_trust,
                            identity,
                            active_profile_name,
                            client_instance_id,
                            exact_origin,
                            environment_id,
                            &grant,
                        )?;
                        let manager =
                            crate::native_device_binding_candidate::NativeDeviceBindingCandidateManager::system();
                        let keys = crate::native_device_proof_key::NativeDeviceProofKeyVault::new();
                        let candidate = manager
                            .candidate(&authority, &keys)
                            .map_err(|_| "Station could not create the Device candidate key".to_owned())?;
                        let current_grant = grants
                            .load_request_grant(
                                &relay_owner,
                                &context,
                                native_now_ms_or_zero(),
                                false,
                            )
                            .map_err(|_| "The approved route changed during Device candidate creation".to_owned())?
                            .grant;
                        if !same_native_grant(&current_grant, &grant) {
                            return Err("The approved route changed during Device candidate creation".into());
                        }
                        let current_approved = NativeStationTrustStore::system()
                            .approved_descriptor_for_locked_profile(&locked_snapshot)
                            .map_err(|_| "Station trust changed during Device candidate creation".to_owned())?;
                        if approved_station_trust(&profile, current_approved)
                            .map_err(|_| "Station trust changed during Device candidate creation".to_owned())?
                            != station_trust
                        {
                            return Err("Station trust changed during Device candidate creation".into());
                        }
                        Ok(candidate)
                    },
                )
                .map_err(|_| NativeRedemptionError::StaleProfile)?;
                Ok(candidate)
            },
        )
        .map_err(|_| "Station could not create the Device binding candidate.".to_owned())
    })
    .await
    .map_err(|_| "Station could not create the Device binding candidate.".to_owned())?
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeDeviceSelfReceiptEnvelope {
    data: crate::native_device_binding_candidate::NativeDeviceProofSelfReceiptV1,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeDeviceSelfReceiptErrorEnvelope {
    error: NativeDeviceSelfReceiptErrorV1,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeDeviceSelfReceiptErrorV1 {
    version: String,
    code: NativeDeviceSelfReceiptErrorCode,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum NativeDeviceSelfReceiptErrorCode {
    NotFound,
    DeviceRequired,
    InvalidRequest,
    Unavailable,
}

fn exact_native_self_receipt_error(body: &[u8]) -> Option<NativeDeviceSelfReceiptErrorCode> {
    let envelope: NativeDeviceSelfReceiptErrorEnvelope = serde_json::from_slice(body).ok()?;
    (envelope.error.version == NATIVE_DEVICE_SELF_RECEIPT_ERROR_VERSION)
        .then_some(envelope.error.code)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NativeDeviceReceiptCapture {
    pub(crate) authority:
        crate::native_device_binding_candidate::NativeDeviceBindingCandidateAuthority,
    pub(crate) candidate: crate::native_device_binding_candidate::NativeDeviceBindingCandidateV1,
    pub(crate) station_origin: String,
    pub(crate) context: NativeRedemptionContext,
    pub(crate) grant_digest: String,
    pub(crate) grant_expires_at: u64,
}

pub(crate) fn with_existing_native_device_candidate<T>(
    app: &AppHandle,
    profile_name: &str,
    expected_profile_revision: u64,
    operation: impl FnOnce(NativeDeviceReceiptCapture) -> Result<T, String>,
) -> Result<T, String> {
    with_current_native_device_candidate(
        app,
        profile_name,
        expected_profile_revision,
        None,
        |authority, manager, keys| manager.existing_candidate(authority, keys),
        operation,
    )
}

pub(crate) fn with_owned_enrollment_device_candidate<T>(
    app: &AppHandle,
    profile_name: &str,
    expected_profile_revision: u64,
    reference: &super::NativeCredentialReference,
    operation: impl FnOnce(NativeDeviceReceiptCapture) -> Result<T, String>,
) -> Result<T, String> {
    with_current_native_device_candidate(
        app,
        profile_name,
        expected_profile_revision,
        Some(reference),
        |authority, manager, keys| manager.existing_candidate(authority, keys),
        operation,
    )
}

pub(crate) fn adopt_authenticated_native_enrollment(
    app: &AppHandle,
    profile_name: &str,
    expected_profile_revision: u64,
    authenticated: &crate::native_enrollment_host::AuthenticatedEnrollmentActivation,
) -> Result<(), String> {
    with_current_native_device_candidate(
        app,
        profile_name,
        expected_profile_revision,
        Some(authenticated.reference()),
        |authority, manager, keys| {
            manager.adopt_authenticated_enrollment(authority, authenticated, keys)
        },
        |_| Ok(()),
    )
}

fn with_current_native_device_candidate<T>(
    app: &AppHandle,
    profile_name: &str,
    expected_profile_revision: u64,
    enrollment_reference: Option<&super::NativeCredentialReference>,
    candidate_operation: impl FnOnce(
        &crate::native_device_binding_candidate::NativeDeviceBindingCandidateAuthority,
        &crate::native_device_binding_candidate::NativeDeviceBindingCandidateManager<
            crate::native_proof_key_core::KeyringSecretBackend,
        >,
        &crate::native_device_proof_key::NativeDeviceProofKeyVault,
    ) -> Result<
        crate::native_device_binding_candidate::NativeDeviceBindingCandidateV1,
        String,
    >,
    operation: impl FnOnce(NativeDeviceReceiptCapture) -> Result<T, String>,
) -> Result<T, String> {
    let result = with_locked_saved_enrollment_profile_store(
        app,
        profile_name,
        enrollment_reference,
        true,
        |profile, locked_snapshot, store, path| {
            if profile.revision != expected_profile_revision {
                return Err(NativeRedemptionError::StaleProfile);
            }
            let mut trust_store = NativeStationTrustStore::system();
            let approved = trust_store
                .approved_descriptor_for_locked_profile(&locked_snapshot)
                .map_err(|error| match error {
                    CandidateError::TrustStore => NativeRedemptionError::StationTrustUnavailable,
                    _ => NativeRedemptionError::StationTrustRequired,
                })?;
            let station_trust = approved_station_trust(&profile, approved)?;
            let context = NativeRedemptionContext {
                profile: profile.clone(),
                station_trust: station_trust.clone(),
            };
            let relay_owner = NativeProofKeyOwner::new(
                &profile.app_identifier,
                profile.channel,
                &profile.client_instance_id,
            )
            .map_err(|_| NativeRedemptionError::InvalidProfile)?;
            let grants = native_relay_grant_vault();
            let grant = grants
                .load_request_grant(&relay_owner, &context, native_now_ms_or_zero(), false)?
                .grant;

            super::with_active_device_identity_in_locked_profile(
                app,
                store,
                path,
                |identity, active_profile_name, client_instance_id, exact_origin, environment_id| {
                    let authority = device_candidate_authority_from_current_owners(
                        &profile,
                        &station_trust,
                        identity,
                        active_profile_name,
                        client_instance_id,
                        exact_origin,
                        environment_id,
                        &grant,
                    )?;
                    let manager = crate::native_device_binding_candidate::NativeDeviceBindingCandidateManager::system();
                    let keys = crate::native_device_proof_key::NativeDeviceProofKeyVault::new();
                    let candidate = candidate_operation(&authority, &manager, &keys)?;
                    let current_grant = grants
                        .load_request_grant(
                            &relay_owner,
                            &context,
                            native_now_ms_or_zero(),
                            false,
                        )
                        .map_err(|_| "The approved route changed during receipt lookup".to_owned())?
                        .grant;
                    if !same_native_grant(&current_grant, &grant) {
                        return Err("The approved route changed during receipt lookup".into());
                    }
                    let current_approved = NativeStationTrustStore::system()
                        .approved_descriptor_for_locked_profile(&locked_snapshot)
                        .map_err(|_| "Station trust changed during receipt lookup".to_owned())?;
                    if approved_station_trust(&profile, current_approved)
                        .map_err(|_| "Station trust changed during receipt lookup".to_owned())?
                        != station_trust
                    {
                        return Err("Station trust changed during receipt lookup".into());
                    }
                    Ok(operation(NativeDeviceReceiptCapture {
                        authority,
                        candidate,
                        station_origin: profile.station_endpoint.clone(),
                        context: context.clone(),
                        grant_digest: URL_SAFE_NO_PAD.encode(ring::digest::digest(
                            &ring::digest::SHA256,
                            &Zeroizing::new(serde_json::to_vec(&grant).map_err(|_| "The current route is unavailable".to_owned())?),
                        )),
                        grant_expires_at: grant.expires_at,
                    }))
                },
            )
            .map_err(|_| NativeRedemptionError::StaleProfile)
        },
    )
    .map_err(|_| "Station could not verify the current Device candidate owner".to_owned())?;
    result.map_err(|_| "Station could not verify the current Device candidate owner".to_owned())
}

fn capture_existing_native_device_candidate(
    app: &AppHandle,
    profile_name: &str,
    expected_profile_revision: u64,
) -> Result<NativeDeviceReceiptCapture, String> {
    with_existing_native_device_candidate(app, profile_name, expected_profile_revision, Ok)
}

fn native_device_self_receipt_url(origin: &str, binding_id: &str) -> Result<String, String> {
    let canonical_v4 = uuid::Uuid::parse_str(binding_id)
        .ok()
        .is_some_and(|id| id.to_string() == binding_id && id.get_version_num() == 4);
    if !crate::exact_origin(origin)
        .map(|resolved| resolved == origin)
        .unwrap_or(false)
        || !canonical_v4
    {
        return Err("The current Station receipt target is invalid".into());
    }
    Ok(format!(
        "{origin}/api/auth/native-device-bindings/{binding_id}/receipt"
    ))
}

fn is_native_receipt_transport_failure(code: &str) -> bool {
    code.starts_with("transport_") || code == "transport" || code == "response_timeout"
}

fn cached_receipt_status(
    observation: Option<crate::native_device_binding_candidate::NativeDeviceReceiptObservationV1>,
) -> Option<crate::native_device_binding_candidate::NativeDeviceBindingSelfReceiptStatusV1> {
    use crate::native_device_binding_candidate::{
        NativeDeviceBindingSelfReceiptStatus as PublicStatus,
        NativeDeviceBindingSelfReceiptStatusV1, NativeDeviceReceiptObservation as Observation,
        NativeDeviceReceiptStatusSource as Source,
    };
    let observation = observation?;
    let status = match observation.status {
        Observation::Current => PublicStatus::PreviouslyConfirmedCurrent,
        Observation::NotCurrent => PublicStatus::NotCurrent,
        Observation::NotFound => PublicStatus::NotFound,
        Observation::Unavailable => return None,
    };
    Some(NativeDeviceBindingSelfReceiptStatusV1::new(
        status,
        Source::CachedObservation,
        observation.observed_at_ms,
        None,
    ))
}

fn station_native_device_binding_self_receipt_blocking(
    app: AppHandle,
    profile_name: String,
    expected_profile_revision: u64,
) -> Result<crate::native_device_binding_candidate::NativeDeviceBindingSelfReceiptStatusV1, String>
{
    use crate::native_device_binding_candidate::{
        NativeDeviceBindingSelfReceiptStatus as PublicStatus,
        NativeDeviceReceiptObservation as Observation, NativeDeviceReceiptStatusSource as Source,
    };
    // Do not let older in-flight reads overwrite a later revocation or 404.
    // The single-flight guard is independent of profile/authority locks, which
    // are released for HTTP and reacquired only for finalization.
    let _receipt_operation = try_native_device_receipt_operation()?;
    let before =
        capture_existing_native_device_candidate(&app, &profile_name, expected_profile_revision)?;
    let manager =
        crate::native_device_binding_candidate::NativeDeviceBindingCandidateManager::system();
    let prior = manager.receipt_observation(&before.authority, &before.candidate)?;
    let host_epoch = before.authority.device_authorization_epoch().to_owned();
    let url =
        native_device_self_receipt_url(&before.station_origin, before.candidate.binding_id())?;
    let authority = app
        .try_state::<super::NativeProfileAuthority>()
        .ok_or_else(|| "Station native authority is unavailable".to_owned())?
        .inner()
        .clone();
    let cancellations = app
        .try_state::<super::NativeHttpCancellation>()
        .ok_or_else(|| "Station native HTTP is unavailable".to_owned())?
        .inner()
        .clone();
    let request = super::NativeHttpRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        url,
        method: "GET".to_owned(),
        headers: std::collections::HashMap::new(),
        body: None,
        expected_binding_id: Some(host_epoch.clone()),
        liveness_probe: false,
    };
    let mut collector = super::NativeReceiptMessageCollector::default();
    let body_deadline = std::time::Instant::now() + super::NATIVE_DEVICE_SELF_RECEIPT_BODY_DEADLINE;
    let transport_result = super::station_native_http_request_to_sink_blocking(
        app.clone(),
        authority,
        cancellations,
        request,
        &mut collector,
        Some(body_deadline),
    );

    // Keep both owner locks held through response validation and the durable
    // observation write. Releasing them after this re-resolution would let a
    // reauthorization race the Keychain write or the status returned to IPC.
    with_existing_native_device_candidate(&app, &profile_name, expected_profile_revision, |after| {
        if before.authority != after.authority
            || before.candidate != after.candidate
            || before.station_origin != after.station_origin
            || before.authority.device_authorization_epoch() != host_epoch
        {
            return Err("The current Device candidate owner changed during receipt lookup".into());
        }
        let now = native_now_ms()?;
        if now == 0 || now > 9_007_199_254_740_991 {
            return Err("The local receipt clock is outside its supported range".into());
        }
        if transport_result.is_err() {
            manager.record_receipt_observation(
                &after.authority,
                &after.candidate,
                &host_epoch,
                Observation::Unavailable,
                now,
            )?;
            return Err("Station could not confirm the Device binding receipt".into());
        }
        let (status, body) = match collector.finish() {
            Ok(response) => response,
            Err(code) if is_native_receipt_transport_failure(code) => {
                if let Some(status) = cached_receipt_status(prior) {
                    return Ok(status);
                }
                manager.record_receipt_observation(
                    &after.authority,
                    &after.candidate,
                    &host_epoch,
                    Observation::Unavailable,
                    now,
                )?;
                return Err("Station could not confirm the Device binding receipt".into());
            }
            Err(_) => {
                manager.record_receipt_observation(
                    &after.authority,
                    &after.candidate,
                    &host_epoch,
                    Observation::Unavailable,
                    now,
                )?;
                return Err("Station returned an invalid Device binding receipt".into());
            }
        };
        if std::str::from_utf8(&body).is_err() {
            manager.record_receipt_observation(
                &after.authority,
                &after.candidate,
                &host_epoch,
                Observation::Unavailable,
                now,
            )?;
            return Err("Station returned an invalid Device binding receipt".into());
        }
        if status == 404 {
            if exact_native_self_receipt_error(&body)
                == Some(NativeDeviceSelfReceiptErrorCode::NotFound)
            {
                manager.record_receipt_observation(
                    &after.authority,
                    &after.candidate,
                    &host_epoch,
                    Observation::NotFound,
                    now,
                )?;
                return Ok(
                        crate::native_device_binding_candidate::NativeDeviceBindingSelfReceiptStatusV1::new(
                            PublicStatus::NotFound,
                            Source::StationReceipt,
                            now,
                            None,
                        ),
                    );
            }
            manager.record_receipt_observation(
                &after.authority,
                &after.candidate,
                &host_epoch,
                Observation::Unavailable,
                now,
            )?;
            return Err("Station returned an invalid Device binding receipt".into());
        }
        if status == 503 {
            if exact_native_self_receipt_error(&body)
                == Some(NativeDeviceSelfReceiptErrorCode::Unavailable)
            {
                if let Some(status) = cached_receipt_status(prior) {
                    return Ok(status);
                }
            }
            manager.record_receipt_observation(
                &after.authority,
                &after.candidate,
                &host_epoch,
                Observation::Unavailable,
                now,
            )?;
            return Err("Station could not confirm the Device binding receipt".into());
        }
        if status != 200 {
            manager.record_receipt_observation(
                &after.authority,
                &after.candidate,
                &host_epoch,
                Observation::Unavailable,
                now,
            )?;
            return Err("Station could not confirm the Device binding receipt".into());
        }
        let envelope: NativeDeviceSelfReceiptEnvelope = match serde_json::from_slice(&body) {
            Ok(envelope) => envelope,
            Err(_) => {
                manager.record_receipt_observation(
                    &after.authority,
                    &after.candidate,
                    &host_epoch,
                    Observation::Unavailable,
                    now,
                )?;
                return Err("Station returned an invalid Device binding receipt".into());
            }
        };
        let observation = match after.candidate.validate_self_receipt(&envelope.data) {
            Ok(observation) => observation,
            Err(_) => {
                manager.record_receipt_observation(
                    &after.authority,
                    &after.candidate,
                    &host_epoch,
                    Observation::Unavailable,
                    now,
                )?;
                return Err("Station returned an invalid Device binding receipt".into());
            }
        };
        manager.record_receipt_observation(
            &after.authority,
            &after.candidate,
            &host_epoch,
            observation,
            now,
        )?;
        let public_status = if observation == Observation::Current {
            PublicStatus::Current
        } else {
            PublicStatus::NotCurrent
        };
        Ok(
            crate::native_device_binding_candidate::NativeDeviceBindingSelfReceiptStatusV1::new(
                public_status,
                Source::StationReceipt,
                now,
                Some(envelope.data),
            ),
        )
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_device_binding_self_receipt(
    window: tauri::WebviewWindow,
    app: AppHandle,
    profile_name: String,
    expected_profile_revision: u64,
) -> Result<crate::native_device_binding_candidate::NativeDeviceBindingSelfReceiptStatusV1, String>
{
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    if profile_name.is_empty()
        || profile_name.len() > 256
        || expected_profile_revision == 0
        || expected_profile_revision > JS_SAFE_INTEGER_MAX
    {
        return Err("The selected Device receipt profile is invalid.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        station_native_device_binding_self_receipt_blocking(
            app,
            profile_name,
            expected_profile_revision,
        )
    })
    .await
    .map_err(|_| "Station could not confirm the Device binding receipt".to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_grant_revoke(
    window: tauri::WebviewWindow,
    app: AppHandle,
    profile_name: String,
    expected_profile_revision: u64,
) -> Result<NativeRelayGrantState, String> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    if profile_name.is_empty() || profile_name.len() > 256 {
        return Err("The selected saved Station name is invalid.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let grants = native_relay_grant_vault();
        let (owner, broker_origin, station_id, enrollment_id, staged) =
            with_native_relay_route_operation_lock(|| {
                with_locked_saved_enrollment_profile_store(
                    &app,
                    &profile_name,
                    None,
                    true,
                    |profile, _, _, _| {
                        if profile.revision != expected_profile_revision {
                            return Err(NativeRedemptionError::StaleProfile);
                        }
                        let owner = NativeProofKeyOwner::new(
                            &profile.app_identifier,
                            profile.channel,
                            &profile.client_instance_id,
                        )
                        .map_err(|_| NativeRedemptionError::InvalidProfile)?;
                        let staged = grants.stage_removed_profile_route_cleanup(
                            &owner,
                            &profile.broker_origin,
                            &profile.station_id,
                            &profile.enrollment_id,
                            native_now_ms_or_zero(),
                        )?;
                        Ok((
                            owner,
                            profile.broker_origin.clone(),
                            profile.station_id.clone(),
                            profile.enrollment_id.clone(),
                            staged,
                        ))
                    },
                )
                .map_err(|_| "Station could not stage native relay grant revocation.".to_owned())
            })?;
        let context = AppNativeRedemptionContextProvider::for_existing_route(app.clone());
        let proof_keys = NativeRelayProofKeyVault::new();
        let http = UreqNativeBrokerTransport::new();
        let service = NativeRelayRedemptionService::new(
            &context,
            &proof_keys,
            &http,
            &grants,
            native_now_ms_or_zero,
        );
        for entry in staged.into_iter().take(MAX_BACKGROUND_CLEANUP_RETRIES) {
            let _ = service.retry_pending_cleanup(&owner, &entry.cleanup_id);
        }
        Ok(NativeRelayGrantState {
            profile_name,
            profile_revision: expected_profile_revision,
            station_id: station_id.clone(),
            enrollment_id: enrollment_id.clone(),
            grants: Vec::new(),
            cleanups: grants
                .cleanup_statuses_for_profile_route(
                    &owner,
                    &broker_origin,
                    &station_id,
                    &enrollment_id,
                )
                .map_err(|_| "Station could not read native relay cleanup status.".to_owned())?,
        })
    })
    .await
    .map_err(|_| "Station could not revoke native relay grants.".to_owned())?
}

/// Renews only the current saved profile's host-owned routing grant. The
/// renderer selects a profile revision, never a broker URL, bearer, proof or
/// renewal ID; this grants no Station application authority.
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_grant_renew(
    window: tauri::WebviewWindow,
    app: AppHandle,
    profile_name: String,
    expected_profile_revision: u64,
) -> Result<NativeRelayGrantMetadata, String> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    if !valid_diagnostic_profile_name(&profile_name)
        || expected_profile_revision == 0
        || expected_profile_revision > JS_SAFE_INTEGER_MAX
    {
        return Err("The selected saved Station is invalid.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        with_native_relay_route_operation_lock(|| {
            let context = AppNativeRedemptionContextProvider::for_existing_route(app);
            let proof_keys = NativeRelayProofKeyVault::new();
            let http = UreqNativeBrokerTransport::new();
            let grants = native_relay_grant_vault();
            NativeRelaySignalService::new(
                &context,
                &proof_keys,
                &http,
                &grants,
                native_now_ms_or_zero,
            )
            .renew(&profile_name, expected_profile_revision)
            .map_err(|_| "Station could not renew the saved native relay route.".to_owned())
        })
    })
    .await
    .map_err(|_| "Station could not renew the saved native relay route.".to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_grant_cleanup_pending(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<Vec<NativeRelayGrantCleanupStatus>, String> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let app_identifier = app.config().identifier.clone();
        let channel = super::native_app_channel(&app_identifier, cfg!(debug_assertions));
        native_relay_grant_vault()
            .cleanup_statuses_for_channel(&app_identifier, channel)
            .map_err(|_| "Station could not read pending native relay cleanup.".to_owned())
    })
    .await
    .map_err(|_| "Station could not read pending native relay cleanup.".to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_grant_cleanup_retry(
    window: tauri::WebviewWindow,
    app: AppHandle,
    cleanup_id: String,
) -> Result<Vec<NativeRelayGrantCleanupStatus>, String> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    if !valid_uuid(&cleanup_id) {
        return Err("The native relay cleanup identifier is invalid.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let app_identifier = app.config().identifier.clone();
        let channel = super::native_app_channel(&app_identifier, cfg!(debug_assertions));
        let grants = native_relay_grant_vault();
        let owners = grants
            .registered_cleanup_owners(&app_identifier, channel)
            .map_err(|_| "Station could not read pending native relay cleanup.".to_owned())?;
        let mut matching = Vec::new();
        for owner in owners {
            if grants
                .pending_cleanups(&owner)
                .map_err(|_| "Station could not read pending native relay cleanup.".to_owned())?
                .iter()
                .any(|entry| entry.cleanup_id == cleanup_id)
            {
                matching.push(owner);
            }
        }
        if matching.len() != 1 {
            return Err("The native relay cleanup is unavailable or ambiguous.".to_owned());
        }
        let context = AppNativeRedemptionContextProvider::for_existing_route(app.clone());
        let proof_keys = NativeRelayProofKeyVault::new();
        let http = UreqNativeBrokerTransport::new();
        let service = NativeRelayRedemptionService::new(
            &context,
            &proof_keys,
            &http,
            &grants,
            native_now_ms_or_zero,
        );
        service
            .retry_pending_cleanup(&matching[0], &cleanup_id)
            .map_err(|_| {
                "Station could not retry native relay cleanup; it remains pending.".to_owned()
            })?;
        grants
            .cleanup_statuses_for_channel(&app_identifier, channel)
            .map_err(|_| "Station could not read pending native relay cleanup.".to_owned())
    })
    .await
    .map_err(|_| "Station could not retry native relay cleanup.".to_owned())?
}

/// Opens a broker offer for the native signaling diagnostic only. The main
/// local app WebView supplies a saved profile selector and bounded SDP; all
/// grant credentials, proof signing, and broker routing stay in the host.
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_diagnostic_binding(
    window: tauri::WebviewWindow,
    app: AppHandle,
    request: NativeRelayDiagnosticBindingInput,
) -> Result<NativeRelayDiagnosticBinding, String> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    if validate_native_relay_binding_input(&request).is_err() {
        return Err("The native relay diagnostic profile is invalid.".into());
    }
    tauri::async_runtime::spawn_blocking(move || run_native_relay_binding_request(app, request))
        .await
        .map_err(|_| "Station could not verify native relay diagnostic trust.".to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_signal_diagnostic_open(
    window: tauri::WebviewWindow,
    app: AppHandle,
    request: NativeRelaySignalDiagnosticOpenInput,
) -> Result<NativeRelaySignalOpened, String> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    if validate_diagnostic_open_input(&request).is_err() {
        return Err("The native relay signaling diagnostic request is invalid.".into());
    }
    tauri::async_runtime::spawn_blocking(move || run_native_relay_signal_open_request(app, request))
        .await
        .map_err(|_| "Station could not open the native relay signaling diagnostic.".to_owned())?
}

/// Reads the answer for an existing diagnostic offer. The result contains
/// signaling material only and never redeems or exposes a grant credential.
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_signal_diagnostic_read(
    window: tauri::WebviewWindow,
    app: AppHandle,
    request: NativeRelaySignalDiagnosticReadInput,
) -> Result<NativeRelaySignalAnswer, String> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    if validate_diagnostic_read_input(&request).is_err() {
        return Err("The native relay signaling diagnostic request is invalid.".into());
    }
    tauri::async_runtime::spawn_blocking(move || run_native_relay_signal_read_request(app, request))
        .await
        .map_err(|_| "Station could not read the native relay signaling diagnostic.".to_owned())?
}

/// Shared host path for the diagnostic and application signaling commands.
/// Both names resolve the saved profile, approved Station trust, and the
/// keyring-held grant in the host; the renderer never supplies custody.
#[derive(Clone, Eq, PartialEq)]
pub(crate) struct NativeEnrollmentRouteCapture {
    pub(crate) context: NativeRedemptionContext,
    pub(crate) scope: crate::native_enrollment::NativeEnrollmentScope,
    pub(crate) surface: crate::native_enrollment::NativeEnrollmentSurface,
    pub(crate) grant_digest: String,
    pub(crate) grant_id: String,
    pub(crate) grant_expires_at: u64,
}

/// Route custody only: no paired Device or account identity is derived here.
pub(crate) fn with_current_native_enrollment_route<T>(
    app: &AppHandle,
    profile_name: &str,
    profile_revision: u64,
    operation: impl FnOnce(NativeEnrollmentRouteCapture) -> Result<T, String>,
) -> Result<T, String> {
    with_owned_native_enrollment_route(app, profile_name, profile_revision, None, operation)
}

pub(crate) fn with_owned_native_enrollment_route<T>(
    app: &AppHandle,
    profile_name: &str,
    profile_revision: u64,
    reference: Option<&super::NativeCredentialReference>,
    operation: impl FnOnce(NativeEnrollmentRouteCapture) -> Result<T, String>,
) -> Result<T, String> {
    let grants = native_relay_grant_vault();
    let now = native_now_ms().map_err(|_| "native_enrollment_route_refused".to_owned())?;
    with_locked_saved_enrollment_profile_store(
        app,
        profile_name,
        reference,
        false,
        |profile, locked, _, _| {
            let approved = NativeStationTrustStore::system()
                .approved_descriptor_for_locked_profile(&locked)
                .map_err(|_| NativeRedemptionError::StationTrustRequired)?;
            let context = NativeRedemptionContext {
                station_trust: approved_station_trust(&profile, approved)?,
                profile,
            };
            validate_profile_context(&context)?;
            if context.profile.revision != profile_revision {
                return Err(NativeRedemptionError::StaleProfile);
            }
            let owner = NativeProofKeyOwner::new(
                &context.profile.app_identifier,
                context.profile.channel,
                &context.profile.client_instance_id,
            )
            .map_err(|_| NativeRedemptionError::InvalidProfile)?;
            let record = grants.load_request_grant(&owner, &context, now, false)?;
            let grant = &record.grant;
            let digest_bytes = Zeroizing::new(
                serde_json::to_vec(grant).map_err(|_| NativeRedemptionError::GrantInvalid)?,
            );
            let capture = NativeEnrollmentRouteCapture {
                context: context.clone(),
                scope: crate::native_enrollment::NativeEnrollmentScope {
                    station_id: grant.scope.station_id.clone(),
                    enrollment_id: grant.scope.enrollment_id.clone(),
                    routing_generation: grant.scope.routing_generation,
                },
                surface: crate::native_enrollment::NativeEnrollmentSurface {
                    kind: grant.surface.kind.clone(),
                    app_identifier: grant.surface.app_identifier.clone(),
                    channel: grant.surface.channel.clone(),
                    client_instance_id: grant.surface.client_instance_id.clone(),
                    key_thumbprint: grant.surface.key_thumbprint.clone(),
                },
                grant_digest: URL_SAFE_NO_PAD
                    .encode(ring::digest::digest(&ring::digest::SHA256, &digest_bytes)),
                grant_id: grant.credential.id.clone(),
                grant_expires_at: grant.expires_at,
            };
            Ok(operation(capture))
        },
    )
    .map_err(|_| "native_enrollment_route_refused".to_owned())?
}

pub(crate) fn read_native_relay_ice_configuration(
    app: &AppHandle,
    profile_name: &str,
    expected_profile_revision: u64,
) -> RedemptionResult<crate::native_relay_ice::NativeRelayIceConfiguration> {
    let contexts = AppNativeRedemptionContextProvider::for_existing_route(app.clone());
    let proof_keys = NativeRelayProofKeyVault::new();
    let http = UreqNativeBrokerTransport {
        timeout: Duration::from_secs(10),
    };
    let grants = native_relay_grant_vault();
    let service = NativeRelaySignalService::new(
        &contexts,
        &proof_keys,
        &http,
        &grants,
        native_now_ms_or_zero,
    );
    let (context, owner, grant) =
        service.load_current_grant(profile_name, expected_profile_revision)?;
    let challenge = NativeBrokerRequestProofChallenge::from_request(
        native_request_identity(&grant),
        NativeBrokerRequestBody::IceConfiguration,
        native_now_ms_or_zero() / 1000,
    )
    .map_err(|_| NativeRedemptionError::GrantInvalid)?;
    let signature = proof_keys
        .sign_native_request(&owner, &challenge)
        .map_err(|_| NativeRedemptionError::ProofKey)?;
    let compact = challenge
        .compact_jws(&signature)
        .map_err(|_| NativeRedemptionError::ProofKey)?;
    service.recheck_current_grant(profile_name, &context, &owner, &grant)?;
    let response = http.send_fixed_request(&grant, &challenge, &compact);
    service.recheck_current_grant(profile_name, &context, &owner, &grant)?;
    let response = response?;
    if response.status != 200 || response.body.len() > 16 * 1024 {
        return Err(NativeRedemptionError::BrokerRejected);
    }
    crate::native_relay_ice::parse_native_relay_ice_configuration(
        &response.body,
        &serde_json::to_value(&grant.scope).map_err(|_| NativeRedemptionError::GrantInvalid)?,
        &serde_json::to_value(&grant.surface).map_err(|_| NativeRedemptionError::GrantInvalid)?,
        native_now_ms_or_zero(),
        grant.expires_at,
    )
    .map_err(|_| NativeRedemptionError::BrokerRejected)
}

fn run_native_relay_binding_request(
    app: AppHandle,
    request: NativeRelayDiagnosticBindingInput,
) -> Result<NativeRelayDiagnosticBinding, String> {
    let contexts = AppNativeRedemptionContextProvider::for_existing_route(app);
    let grants = native_relay_grant_vault();
    let now = native_now_ms().map_err(|_| "Station could not verify native relay state.")?;
    contexts
        .with_current_context(&request.profile_name, |context| {
            validate_profile_context(&context)?;
            let owner = NativeProofKeyOwner::new(
                &context.profile.app_identifier,
                context.profile.channel,
                &context.profile.client_instance_id,
            )
            .map_err(|_| NativeRedemptionError::InvalidProfile)?;
            let record = grants.load_request_grant(&owner, &context, now, false)?;
            diagnostic_binding_from_current(
                &request.profile_name,
                request.expected_profile_revision,
                context,
                record.grant,
            )
        })
        .map_err(map_signal_diagnostic_error)
}

fn run_native_relay_signal_open_request(
    app: AppHandle,
    request: NativeRelaySignalDiagnosticOpenInput,
) -> Result<NativeRelaySignalOpened, String> {
    native_application_signal_open(
        app,
        NativeRelaySignalOpenRequest {
            profile_name: request.profile_name,
            expected_profile_revision: request.expected_profile_revision,
            nonce: request.nonce,
            offer_sdp: request.offer_sdp,
        },
    )
    .map_err(map_signal_diagnostic_error)
}

pub(crate) fn native_application_signal_open(
    app: AppHandle,
    request: NativeRelaySignalOpenRequest,
) -> RedemptionResult<NativeRelaySignalOpened> {
    let context = AppNativeRedemptionContextProvider::for_existing_route(app);
    let proof_keys = NativeRelayProofKeyVault::new();
    let http = UreqNativeBrokerTransport::new();
    let grants = native_relay_grant_vault();
    NativeRelaySignalService::new(&context, &proof_keys, &http, &grants, native_now_ms_or_zero)
        .open(&request)
}

fn run_native_relay_signal_read_request(
    app: AppHandle,
    request: NativeRelaySignalDiagnosticReadInput,
) -> Result<NativeRelaySignalAnswer, String> {
    native_application_signal_read(
        app,
        NativeRelaySignalReadRequest {
            profile_name: request.profile_name,
            expected_profile_revision: request.expected_profile_revision,
            nonce: request.nonce,
        },
    )
    .map_err(map_signal_diagnostic_error)
}

pub(crate) fn native_application_signal_read(
    app: AppHandle,
    request: NativeRelaySignalReadRequest,
) -> RedemptionResult<NativeRelaySignalAnswer> {
    let context = AppNativeRedemptionContextProvider::for_existing_route(app);
    let proof_keys = NativeRelayProofKeyVault::new();
    let http = UreqNativeBrokerTransport::new();
    let grants = native_relay_grant_vault();
    NativeRelaySignalService::new(&context, &proof_keys, &http, &grants, native_now_ms_or_zero)
        .read(&request)
}

/// Validates the shared signaling-command input envelope and binds it to the
/// application command names. This is custody, not semantics: the exact saved
/// profile revision, independently approved Station trust, keyring-held grant,
/// bounded SDP, fixed broker paths, and no route bearer apply identically to
/// the diagnostic and application seams.
fn validate_native_relay_binding_input(
    request: &NativeRelayDiagnosticBindingInput,
) -> Result<(), ()> {
    if !valid_diagnostic_profile_name(&request.profile_name)
        || request.expected_profile_revision == 0
        || request.expected_profile_revision > JS_SAFE_INTEGER_MAX
    {
        return Err(());
    }
    Ok(())
}

/// Signaling-only broker offer for the native application signaling adapter
/// seam. It is the same host-owned path as the diagnostic commands: main
/// window only, exact saved-profile revision, approved Station trust, and no
/// bearer, route, URL, or application DataChannel authority.
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_application_binding(
    window: tauri::WebviewWindow,
    app: AppHandle,
    request: NativeRelayDiagnosticBindingInput,
) -> Result<NativeRelayDiagnosticBinding, String> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    if validate_native_relay_binding_input(&request).is_err() {
        return Err("The native relay application profile is invalid.".into());
    }
    tauri::async_runtime::spawn_blocking(move || run_native_relay_binding_request(app, request))
        .await
        .map_err(|_| "Station could not verify native relay application trust.".to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_enrollment_binding(
    window: tauri::WebviewWindow,
    app: AppHandle,
    profile_name: String,
    expected_profile_revision: u64,
) -> Result<NativeRelayDiagnosticBinding, String> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    let request = NativeRelayDiagnosticBindingInput {
        profile_name,
        expected_profile_revision,
    };
    if validate_native_relay_binding_input(&request).is_err() {
        return Err("native_enrollment_binding_invalid".into());
    }
    tauri::async_runtime::spawn_blocking(move || run_native_relay_binding_request(app, request))
        .await
        .map_err(|_| "native_enrollment_binding_refused".to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_application_open(
    window: tauri::WebviewWindow,
    app: AppHandle,
    request: NativeRelaySignalDiagnosticOpenInput,
) -> Result<NativeRelaySignalOpened, String> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    if validate_diagnostic_open_input(&request).is_err() {
        return Err("The native relay application signaling request is invalid.".into());
    }
    tauri::async_runtime::spawn_blocking(move || run_native_relay_signal_open_request(app, request))
        .await
        .map_err(|_| "Station could not open native relay application signaling.".to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_application_read(
    window: tauri::WebviewWindow,
    app: AppHandle,
    request: NativeRelaySignalDiagnosticReadInput,
) -> Result<NativeRelaySignalAnswer, String> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    if validate_diagnostic_read_input(&request).is_err() {
        return Err("The native relay application signaling request is invalid.".into());
    }
    tauri::async_runtime::spawn_blocking(move || run_native_relay_signal_read_request(app, request))
        .await
        .map_err(|_| "Station could not read native relay application signaling.".to_owned())?
}

fn valid_diagnostic_profile_name(profile_name: &str) -> bool {
    !profile_name.trim().is_empty() && profile_name.len() <= 256
}

fn validate_diagnostic_open_input(
    request: &NativeRelaySignalDiagnosticOpenInput,
) -> Result<(), ()> {
    if !valid_diagnostic_profile_name(&request.profile_name)
        || !valid_safe_id(&request.nonce)
        || request.offer_sdp.is_empty()
        || request.offer_sdp.as_bytes().len() > MAX_NATIVE_SIGNAL_SDP_BYTES
    {
        return Err(());
    }
    Ok(())
}

fn validate_diagnostic_read_input(
    request: &NativeRelaySignalDiagnosticReadInput,
) -> Result<(), ()> {
    if !valid_diagnostic_profile_name(&request.profile_name) || !valid_safe_id(&request.nonce) {
        return Err(());
    }
    Ok(())
}

fn map_signal_diagnostic_error(error: NativeRedemptionError) -> String {
    match error {
        NativeRedemptionError::StaleProfile => {
            "The selected saved Station changed; refresh it before using the diagnostic.".into()
        }
        NativeRedemptionError::StationTrustRequired => {
            "The selected Station has not been approved for native relay access.".into()
        }
        NativeRedemptionError::StationTrustUnavailable => {
            "Station could not verify approved native relay trust.".into()
        }
        NativeRedemptionError::GrantExpired => {
            "The saved native relay grant has expired or is near expiry.".into()
        }
        NativeRedemptionError::BrokerRejected => {
            "The relay broker rejected or returned an invalid diagnostic response.".into()
        }
        _ => "Station could not complete native relay signaling diagnostics.".into(),
    }
}

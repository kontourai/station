//! Provisional, host-owned Device binding candidates.
//!
//! Candidate custody is deliberately separate from approval, receipt
//! reconciliation, peer sessions, and request signing. The complete current
//! owner tuple is durable in a private Keychain namespace before the Device
//! proof vault is touched. The only public value is the versioned candidate
//! descriptor, which contains public key material and grants no authority.

#[cfg(test)]
use crate::native_device_proof_key::MemoryNativeDeviceProofKeyVault;
use crate::native_device_proof_key::{
    DeviceProofKeyError, NativeDeviceProofKeyOwner, NativeDeviceProofKeyVault,
};
#[cfg(test)]
use crate::native_proof_key_core::ProofKeyError;
use crate::native_proof_key_core::{
    proof_key_account, KeyringSecretBackend, ProofKeySecretBackend,
};
use crate::native_relay_proof_key::{NativeProofKeyChannel, P256PublicJwk};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use uuid::Uuid;

const CANDIDATE_KEYRING_SERVICE: &str = "io.kontourai.station.device-binding-candidate";
const CANDIDATE_ACCOUNT_PREFIX: &str = "native-device-binding-candidate:v1";
const CANDIDATE_VERSION: &str = "station-native-device-binding-candidate/v1";
const SELF_RECEIPT_STATUS_VERSION: &str = "station-native-device-binding-self-receipt-status/v1";
const MAX_CANDIDATE_RECORD_BYTES: usize = 2048;
const MAX_CANDIDATE_RECORD_UTF16_UNITS: usize = 1280;

static CANDIDATE_OPERATION: Mutex<()> = Mutex::new(());

/// Public mirror of the existing `NativeDeviceBindingCandidateV1` contract.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeDeviceBindingCandidateV1 {
    pub(crate) version: String,
    pub(crate) station_id: String,
    pub(crate) device_id: String,
    pub(crate) binding_id: String,
    pub(crate) surface: NativeDeviceBindingSurfaceV1,
    pub(crate) device_proof_jwk: P256PublicJwk,
    pub(crate) device_proof_key_thumbprint: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeDeviceBindingSurfaceV1 {
    kind: String,
    app_identifier: String,
    channel: String,
    client_instance_id: String,
    key_thumbprint: String,
}

impl NativeDeviceBindingSurfaceV1 {
    pub(crate) fn from_current_route(
        kind: String,
        app_identifier: String,
        channel: String,
        client_instance_id: String,
        key_thumbprint: String,
    ) -> Self {
        Self {
            kind,
            app_identifier,
            channel,
            client_instance_id,
            key_thumbprint,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeDeviceBindingRouteV1 {
    broker_origin: String,
    station_id: String,
    enrollment_id: String,
    routing_generation: u64,
    grant_id: String,
}

impl NativeDeviceBindingRouteV1 {
    pub(crate) fn from_current_route(
        broker_origin: String,
        station_id: String,
        enrollment_id: String,
        routing_generation: u64,
        grant_id: String,
    ) -> Self {
        Self {
            broker_origin,
            station_id,
            enrollment_id,
            routing_generation,
            grant_id,
        }
    }
}

/// Host-derived authority captured while the saved profile and native
/// authority locks are held. Renderer input cannot construct this value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NativeDeviceBindingCandidateAuthority {
    profile_name: String,
    profile_revision: u64,
    trust_revision: u64,
    device_authorization_epoch: String,
    app_identifier: String,
    channel: NativeProofKeyChannel,
    client_instance_id: String,
    station_id: String,
    device_id: String,
    surface: NativeDeviceBindingSurfaceV1,
    route: NativeDeviceBindingRouteV1,
}

impl NativeDeviceBindingCandidateAuthority {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_current_owners(
        profile_name: String,
        profile_revision: u64,
        trust_revision: u64,
        device_authorization_epoch: String,
        app_identifier: String,
        channel: NativeProofKeyChannel,
        client_instance_id: String,
        station_id: String,
        device_id: String,
        surface: NativeDeviceBindingSurfaceV1,
        route: NativeDeviceBindingRouteV1,
    ) -> Self {
        Self {
            profile_name,
            profile_revision,
            trust_revision,
            device_authorization_epoch,
            app_identifier,
            channel,
            client_instance_id,
            station_id,
            device_id,
            surface,
            route,
        }
    }

    pub(crate) fn device_authorization_epoch(&self) -> &str {
        &self.device_authorization_epoch
    }

    pub(crate) fn proof_key_owner(
        &self,
        candidate: &NativeDeviceBindingCandidateV1,
    ) -> Result<NativeDeviceProofKeyOwner, String> {
        validate_authority(self)?;
        validate_candidate_for_authority(self, candidate)?;
        NativeDeviceProofKeyOwner::with_binding_id(
            &self.app_identifier,
            self.channel,
            &self.client_instance_id,
            &self.station_id,
            &self.device_id,
            &candidate.binding_id,
        )
        .map_err(|_| "The current Device proof owner is invalid".to_owned())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StoredCandidateV1 {
    schema_version: u8,
    owner: StoredCandidateOwnerV1,
    binding_id: String,
    initial_device_authorization_epoch: String,
    state: CandidateState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    receipt_observation: Option<StoredReceiptObservationV1>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NativeDeviceReceiptObservation {
    Current,
    NotCurrent,
    NotFound,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StoredReceiptObservationV1 {
    candidate_tuple_sha256: String,
    host_authorization_epoch: String,
    status: NativeDeviceReceiptObservation,
    observed_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeDeviceProofSelfReceiptV1 {
    pub(crate) version: String,
    pub(crate) binding: NativeDeviceProofSelfReceiptBindingV1,
    pub(crate) current_device_binding: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeDeviceProofSelfReceiptBindingV1 {
    pub(crate) station_id: String,
    pub(crate) device_id: String,
    pub(crate) binding_id: String,
    pub(crate) surface: NativeDeviceBindingSurfaceV1,
    pub(crate) device_proof_jwk: P256PublicJwk,
    pub(crate) device_proof_key_thumbprint: String,
    pub(crate) state: NativeDeviceReceiptBindingState,
    pub(crate) created_at: u64,
    pub(crate) approved_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) revoked_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) revocation_reason: Option<NativeDeviceReceiptRevocationReason>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum NativeDeviceReceiptBindingState {
    Active,
    Revoked,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum NativeDeviceReceiptRevocationReason {
    OperatorRevoked,
    Replaced,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
/// Versioned public result for one host receipt lookup. Cached observations
/// retain their original timestamp and are never presented as fresh Station
/// currentness; the Station rechecks binding state for every proof request.
pub(crate) struct NativeDeviceBindingSelfReceiptStatusV1 {
    pub(crate) version: String,
    pub(crate) status: NativeDeviceBindingSelfReceiptStatus,
    pub(crate) source: NativeDeviceReceiptStatusSource,
    pub(crate) observed_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) receipt: Option<NativeDeviceProofSelfReceiptV1>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum NativeDeviceReceiptStatusSource {
    StationReceipt,
    CachedObservation,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeDeviceReceiptObservationV1 {
    pub(crate) status: NativeDeviceReceiptObservation,
    pub(crate) observed_at_ms: u64,
}

impl NativeDeviceBindingCandidateV1 {
    pub(crate) fn binding_id(&self) -> &str {
        &self.binding_id
    }

    pub(crate) fn validate_self_receipt(
        &self,
        receipt: &NativeDeviceProofSelfReceiptV1,
    ) -> Result<NativeDeviceReceiptObservation, String> {
        const JS_SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;
        let binding = &receipt.binding;
        if receipt.version != "station-native-device-proof-self-receipt/v1"
            || binding.station_id != self.station_id
            || binding.device_id != self.device_id
            || binding.binding_id != self.binding_id
            || binding.surface != self.surface
            || binding.device_proof_jwk != self.device_proof_jwk
            || binding.device_proof_key_thumbprint != self.device_proof_key_thumbprint
            || binding.created_at == 0
            || binding.approved_at < binding.created_at
            || binding.approved_at > JS_SAFE_INTEGER_MAX
            || binding.created_at > JS_SAFE_INTEGER_MAX
        {
            return Err("The Station receipt does not match this Device candidate".into());
        }
        match binding.state {
            NativeDeviceReceiptBindingState::Active
                if binding.revoked_at.is_none()
                    && binding.revocation_reason.is_none()
                    && receipt.current_device_binding =>
            {
                Ok(NativeDeviceReceiptObservation::Current)
            }
            NativeDeviceReceiptBindingState::Active
                if binding.revoked_at.is_none()
                    && binding.revocation_reason.is_none()
                    && !receipt.current_device_binding =>
            {
                Ok(NativeDeviceReceiptObservation::NotCurrent)
            }
            NativeDeviceReceiptBindingState::Revoked
                if binding
                    .revoked_at
                    .is_some_and(|at| at >= binding.approved_at && at <= JS_SAFE_INTEGER_MAX)
                    && binding.revocation_reason.is_some()
                    && !receipt.current_device_binding =>
            {
                Ok(NativeDeviceReceiptObservation::NotCurrent)
            }
            _ => Err("The Station receipt has inconsistent binding state".into()),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum NativeDeviceBindingSelfReceiptStatus {
    Current,
    NotCurrent,
    NotFound,
    PreviouslyConfirmedCurrent,
}

impl NativeDeviceBindingSelfReceiptStatusV1 {
    pub(crate) fn new(
        status: NativeDeviceBindingSelfReceiptStatus,
        source: NativeDeviceReceiptStatusSource,
        observed_at_ms: u64,
        receipt: Option<NativeDeviceProofSelfReceiptV1>,
    ) -> Self {
        Self {
            version: SELF_RECEIPT_STATUS_VERSION.to_owned(),
            status,
            source,
            observed_at_ms,
            receipt,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StoredCandidateOwnerV1 {
    profile_name: String,
    profile_revision: u64,
    trust_revision: u64,
    app_identifier: String,
    channel: NativeProofKeyChannel,
    client_instance_id: String,
    station_id: String,
    device_id: String,
    surface_sha256: String,
    route_sha256: String,
}

impl StoredCandidateOwnerV1 {
    fn from_authority(authority: &NativeDeviceBindingCandidateAuthority) -> Result<Self, String> {
        let surface = serde_json::to_vec(&authority.surface)
            .map_err(|_| "The Device candidate surface is invalid".to_owned())?;
        let route = serde_json::to_vec(&authority.route)
            .map_err(|_| "The Device candidate route is invalid".to_owned())?;
        Ok(Self {
            profile_name: authority.profile_name.clone(),
            profile_revision: authority.profile_revision,
            trust_revision: authority.trust_revision,
            app_identifier: authority.app_identifier.clone(),
            channel: authority.channel,
            client_instance_id: authority.client_instance_id.clone(),
            station_id: authority.station_id.clone(),
            device_id: authority.device_id.clone(),
            surface_sha256: sha256_hex(&surface),
            route_sha256: sha256_hex(&route),
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum CandidateState {
    KeyProvisioning,
    Provisional,
}

pub(crate) struct NativeDeviceBindingCandidateManager<B> {
    backend: B,
}

impl Default for NativeDeviceBindingCandidateManager<KeyringSecretBackend> {
    fn default() -> Self {
        Self::system()
    }
}

impl NativeDeviceBindingCandidateManager<KeyringSecretBackend> {
    pub(crate) fn system() -> Self {
        Self::new(KeyringSecretBackend::new(CANDIDATE_KEYRING_SERVICE))
    }
}

impl<B: ProofKeySecretBackend> NativeDeviceBindingCandidateManager<B> {
    pub(crate) fn new(backend: B) -> Self {
        Self { backend }
    }

    pub(crate) fn adopt_authenticated_enrollment<K: DeviceCandidateKeyVault>(
        &self,
        authority: &NativeDeviceBindingCandidateAuthority,
        authenticated: &crate::native_enrollment_host::AuthenticatedEnrollmentActivation,
        keys: &K,
    ) -> Result<NativeDeviceBindingCandidateV1, String> {
        let _guard = CANDIDATE_OPERATION
            .lock()
            .map_err(|_| "Device candidate custody is unavailable".to_owned())?;
        validate_authority(authority)?;
        let candidate = authenticated.candidate()?;
        validate_candidate_for_authority(authority, &candidate)?;
        let receipt = authenticated.device_receipt();
        if candidate.validate_self_receipt(receipt)? != NativeDeviceReceiptObservation::Current {
            return Err("The enrollment receipt is not current".into());
        }
        let metadata = keys
            .restore(&authority.proof_key_owner(&candidate)?)
            .map_err(|_| "The approved enrollment Device key is unavailable".to_owned())?;
        if metadata.jwk() != &candidate.device_proof_jwk
            || metadata.thumbprint() != candidate.device_proof_key_thumbprint
        {
            return Err("The approved enrollment Device key changed".into());
        }
        let owner = StoredCandidateOwnerV1::from_authority(authority)?;
        let account = candidate_account(authority);
        if let Some(old) = self.read_record(&account)? {
            if old.owner != owner || old.binding_id != candidate.binding_id {
                return Err("Another Device candidate already owns this profile".into());
            }
        }
        let stored = StoredCandidateV1 {
            schema_version: 1,
            owner,
            binding_id: candidate.binding_id.clone(),
            initial_device_authorization_epoch: authority.device_authorization_epoch.clone(),
            state: CandidateState::Provisional,
            receipt_observation: Some(StoredReceiptObservationV1 {
                candidate_tuple_sha256: candidate_tuple_sha256(&candidate)?,
                host_authorization_epoch: authority.device_authorization_epoch.clone(),
                status: NativeDeviceReceiptObservation::Current,
                observed_at_ms: authenticated.observed_at(),
            }),
        };
        self.write_confirmed(&account, &stored)?;
        Ok(candidate)
    }

    pub(crate) fn candidate<K: DeviceCandidateKeyVault>(
        &self,
        authority: &NativeDeviceBindingCandidateAuthority,
        keys: &K,
    ) -> Result<NativeDeviceBindingCandidateV1, String> {
        let _guard = CANDIDATE_OPERATION
            .lock()
            .map_err(|_| "Device candidate custody is unavailable".to_owned())?;
        validate_authority(authority)?;
        let account = candidate_account(authority);
        let owner_record = StoredCandidateOwnerV1::from_authority(authority)?;
        let mut stored = match self.read_record(&account)? {
            Some(stored) => {
                if stored.owner != owner_record
                    || !canonical_v4(&stored.binding_id)
                    || !canonical_uuid(&stored.initial_device_authorization_epoch)
                {
                    return Err(
                        "A stored Device candidate belongs to another owner snapshot".into(),
                    );
                }
                stored
            }
            None => {
                let stored = StoredCandidateV1 {
                    schema_version: 1,
                    owner: owner_record,
                    binding_id: Uuid::new_v4().to_string(),
                    initial_device_authorization_epoch: authority
                        .device_authorization_epoch
                        .clone(),
                    state: CandidateState::KeyProvisioning,
                    receipt_observation: None,
                };
                self.write_confirmed(&account, &stored)?;
                stored
            }
        };
        let owner = NativeDeviceProofKeyOwner::with_binding_id(
            &authority.app_identifier,
            authority.channel,
            &authority.client_instance_id,
            &authority.station_id,
            &authority.device_id,
            &stored.binding_id,
        )
        .map_err(|_| "The current Device candidate owner is invalid".to_owned())?;

        let metadata = match keys.restore(&owner) {
            Ok(metadata) if stored.state == CandidateState::KeyProvisioning => metadata,
            Ok(metadata) => metadata,
            Err(DeviceProofKeyError::Missing)
                if stored.state == CandidateState::KeyProvisioning =>
            {
                keys.create(&owner)
                    .or_else(|error| match error {
                        DeviceProofKeyError::AlreadyExists => keys.restore(&owner),
                        other => Err(other),
                    })
                    .map_err(|_| "Station could not create the Device candidate key".to_owned())?
            }
            Err(DeviceProofKeyError::Missing) => {
                return Err("The provisional Device candidate key is missing".into())
            }
            Err(_) => return Err("Station could not read the Device candidate key".into()),
        };
        if stored.state == CandidateState::KeyProvisioning {
            stored.state = CandidateState::Provisional;
            self.write_confirmed(&account, &stored)?;
        }
        if self.read_record(&account)?.as_ref() != Some(&stored) {
            return Err("The Device candidate custody record changed during key creation".into());
        }
        Ok(NativeDeviceBindingCandidateV1 {
            version: CANDIDATE_VERSION.to_owned(),
            station_id: authority.station_id.clone(),
            device_id: authority.device_id.clone(),
            binding_id: stored.binding_id,
            surface: authority.surface.clone(),
            device_proof_jwk: metadata.jwk().clone(),
            device_proof_key_thumbprint: metadata.thumbprint().to_owned(),
        })
    }

    /// Loads a previously provisioned candidate and its public key metadata.
    /// Receipt reads must never create a new candidate or replace a missing key.
    pub(crate) fn existing_candidate<K: DeviceCandidateKeyVault>(
        &self,
        authority: &NativeDeviceBindingCandidateAuthority,
        keys: &K,
    ) -> Result<NativeDeviceBindingCandidateV1, String> {
        let _guard = CANDIDATE_OPERATION
            .lock()
            .map_err(|_| "Device candidate custody is unavailable".to_owned())?;
        validate_authority(authority)?;
        let account = candidate_account(authority);
        let owner_record = StoredCandidateOwnerV1::from_authority(authority)?;
        let stored = self
            .read_record(&account)?
            .ok_or_else(|| "No provisional Device candidate exists".to_owned())?;
        if stored.owner != owner_record
            || !canonical_v4(&stored.binding_id)
            || !canonical_uuid(&stored.initial_device_authorization_epoch)
            || stored.state != CandidateState::Provisional
        {
            return Err("The stored Device candidate is unavailable for receipt lookup".into());
        }
        let owner = NativeDeviceProofKeyOwner::with_binding_id(
            &authority.app_identifier,
            authority.channel,
            &authority.client_instance_id,
            &authority.station_id,
            &authority.device_id,
            &stored.binding_id,
        )
        .map_err(|_| "The current Device candidate owner is invalid".to_owned())?;
        let metadata = keys
            .restore(&owner)
            .map_err(|_| "The provisional Device candidate key is unavailable".to_owned())?;
        if self.read_record(&account)?.as_ref() != Some(&stored) {
            return Err("The Device candidate changed during receipt lookup".into());
        }
        Ok(NativeDeviceBindingCandidateV1 {
            version: CANDIDATE_VERSION.to_owned(),
            station_id: authority.station_id.clone(),
            device_id: authority.device_id.clone(),
            binding_id: stored.binding_id,
            surface: authority.surface.clone(),
            device_proof_jwk: metadata.jwk().clone(),
            device_proof_key_thumbprint: metadata.thumbprint().to_owned(),
        })
    }

    pub(crate) fn record_receipt_observation(
        &self,
        authority: &NativeDeviceBindingCandidateAuthority,
        candidate: &NativeDeviceBindingCandidateV1,
        host_authorization_epoch: &str,
        status: NativeDeviceReceiptObservation,
        observed_at_ms: u64,
    ) -> Result<(), String> {
        let _guard = CANDIDATE_OPERATION
            .lock()
            .map_err(|_| "Device candidate custody is unavailable".to_owned())?;
        validate_authority(authority)?;
        validate_candidate_for_authority(authority, candidate)?;
        if host_authorization_epoch != authority.device_authorization_epoch
            || !canonical_uuid(host_authorization_epoch)
        {
            return Err("The current Device authorization changed during receipt lookup".into());
        }
        let account = candidate_account(authority);
        let owner = StoredCandidateOwnerV1::from_authority(authority)?;
        let mut stored = self
            .read_record(&account)?
            .ok_or_else(|| "No provisional Device candidate exists".to_owned())?;
        if stored.owner != owner
            || stored.state != CandidateState::Provisional
            || stored.binding_id != candidate.binding_id
        {
            return Err("The stored Device candidate changed during receipt lookup".into());
        }
        stored.receipt_observation = Some(StoredReceiptObservationV1 {
            candidate_tuple_sha256: candidate_tuple_sha256(candidate)?,
            host_authorization_epoch: host_authorization_epoch.to_owned(),
            status,
            observed_at_ms,
        });
        self.write_confirmed(&account, &stored)
    }

    pub(crate) fn receipt_observation(
        &self,
        authority: &NativeDeviceBindingCandidateAuthority,
        candidate: &NativeDeviceBindingCandidateV1,
    ) -> Result<Option<NativeDeviceReceiptObservationV1>, String> {
        let _guard = CANDIDATE_OPERATION
            .lock()
            .map_err(|_| "Device candidate custody is unavailable".to_owned())?;
        validate_authority(authority)?;
        validate_candidate_for_authority(authority, candidate)?;
        let account = candidate_account(authority);
        let owner = StoredCandidateOwnerV1::from_authority(authority)?;
        let Some(stored) = self.read_record(&account)? else {
            return Ok(None);
        };
        if stored.owner != owner
            || stored.state != CandidateState::Provisional
            || stored.binding_id != candidate.binding_id
        {
            return Err("The stored Device candidate changed during receipt lookup".into());
        }
        let Some(observation) = stored.receipt_observation else {
            return Ok(None);
        };
        if observation.candidate_tuple_sha256 != candidate_tuple_sha256(candidate)?
            || observation.host_authorization_epoch != authority.device_authorization_epoch
        {
            return Ok(None);
        }
        Ok(Some(NativeDeviceReceiptObservationV1 {
            status: observation.status,
            observed_at_ms: observation.observed_at_ms,
        }))
    }

    fn read_record(&self, account: &str) -> Result<Option<StoredCandidateV1>, String> {
        let Some(raw) = self
            .backend
            .read(account)
            .map_err(|_| "The Device candidate Keychain is unavailable".to_owned())?
        else {
            return Ok(None);
        };
        if raw.len() > MAX_CANDIDATE_RECORD_BYTES
            || raw.encode_utf16().count() > MAX_CANDIDATE_RECORD_UTF16_UNITS
        {
            return Err("The stored Device candidate is malformed".into());
        }
        let stored: StoredCandidateV1 = serde_json::from_str(&raw)
            .map_err(|_| "The stored Device candidate is malformed".to_owned())?;
        if stored.schema_version != 1
            || stored
                .receipt_observation
                .as_ref()
                .is_some_and(|observation| {
                    !canonical_uuid(&observation.host_authorization_epoch)
                        || observation.observed_at_ms == 0
                        || observation.observed_at_ms > 9_007_199_254_740_991
                        || observation.candidate_tuple_sha256.len() != 64
                        || !observation
                            .candidate_tuple_sha256
                            .bytes()
                            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                })
        {
            return Err("The stored Device candidate is unsupported".into());
        }
        Ok(Some(stored))
    }

    fn write_confirmed(&self, account: &str, stored: &StoredCandidateV1) -> Result<(), String> {
        let encoded = serde_json::to_string(stored)
            .map_err(|_| "The Device candidate could not be serialized".to_owned())?;
        if encoded.len() > MAX_CANDIDATE_RECORD_BYTES
            || encoded.encode_utf16().count() > MAX_CANDIDATE_RECORD_UTF16_UNITS
        {
            return Err("The Device candidate exceeds its custody limit".into());
        }
        self.backend
            .write(account, &encoded)
            .map_err(|_| "The Device candidate Keychain write failed".to_owned())?;
        if self.read_record(account)?.as_ref() != Some(stored) {
            return Err("The Device candidate Keychain write was not confirmed".into());
        }
        Ok(())
    }
}

pub(crate) trait DeviceCandidateKeyVault {
    fn create(
        &self,
        owner: &NativeDeviceProofKeyOwner,
    ) -> Result<
        crate::native_device_proof_key::NativeDeviceProofKeyPublicMetadata,
        DeviceProofKeyError,
    >;
    fn restore(
        &self,
        owner: &NativeDeviceProofKeyOwner,
    ) -> Result<
        crate::native_device_proof_key::NativeDeviceProofKeyPublicMetadata,
        DeviceProofKeyError,
    >;
}

impl DeviceCandidateKeyVault for NativeDeviceProofKeyVault {
    fn create(
        &self,
        owner: &NativeDeviceProofKeyOwner,
    ) -> Result<
        crate::native_device_proof_key::NativeDeviceProofKeyPublicMetadata,
        DeviceProofKeyError,
    > {
        NativeDeviceProofKeyVault::create(self, owner)
    }

    fn restore(
        &self,
        owner: &NativeDeviceProofKeyOwner,
    ) -> Result<
        crate::native_device_proof_key::NativeDeviceProofKeyPublicMetadata,
        DeviceProofKeyError,
    > {
        NativeDeviceProofKeyVault::restore(self, owner)
    }
}

#[cfg(test)]
impl DeviceCandidateKeyVault for MemoryNativeDeviceProofKeyVault {
    fn create(
        &self,
        owner: &NativeDeviceProofKeyOwner,
    ) -> Result<
        crate::native_device_proof_key::NativeDeviceProofKeyPublicMetadata,
        DeviceProofKeyError,
    > {
        MemoryNativeDeviceProofKeyVault::create(self, owner)
    }

    fn restore(
        &self,
        owner: &NativeDeviceProofKeyOwner,
    ) -> Result<
        crate::native_device_proof_key::NativeDeviceProofKeyPublicMetadata,
        DeviceProofKeyError,
    > {
        MemoryNativeDeviceProofKeyVault::restore(self, owner)
    }
}

fn candidate_account(authority: &NativeDeviceBindingCandidateAuthority) -> String {
    proof_key_account(
        CANDIDATE_ACCOUNT_PREFIX,
        &[
            authority.profile_name.as_bytes(),
            authority.app_identifier.as_bytes(),
            authority.channel.keyring_label().as_bytes(),
            authority.client_instance_id.as_bytes(),
        ],
    )
}

fn sha256_hex(value: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, value);
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn candidate_tuple_sha256(candidate: &NativeDeviceBindingCandidateV1) -> Result<String, String> {
    let bytes = serde_json::to_vec(candidate)
        .map_err(|_| "The Device candidate tuple is invalid".to_owned())?;
    Ok(sha256_hex(&bytes))
}

fn validate_candidate_for_authority(
    authority: &NativeDeviceBindingCandidateAuthority,
    candidate: &NativeDeviceBindingCandidateV1,
) -> Result<(), String> {
    if candidate.version != CANDIDATE_VERSION
        || candidate.station_id != authority.station_id
        || candidate.device_id != authority.device_id
        || candidate.surface != authority.surface
        || !canonical_v4(&candidate.binding_id)
    {
        return Err("The Device candidate does not match its current owners".into());
    }
    Ok(())
}

fn canonical_v4(value: &str) -> bool {
    Uuid::parse_str(value)
        .ok()
        .is_some_and(|id| id.to_string() == value && id.get_version_num() == 4)
}

fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value)
        .ok()
        .is_some_and(|id| id.to_string() == value)
}

fn validate_authority(authority: &NativeDeviceBindingCandidateAuthority) -> Result<(), String> {
    if authority.profile_name.is_empty()
        || authority.profile_name.len() > 256
        || authority.profile_revision == 0
        || authority.trust_revision == 0
        || !canonical_uuid(&authority.device_authorization_epoch)
        || !canonical_uuid(&authority.client_instance_id)
        || !canonical_uuid(&authority.station_id)
        || !canonical_uuid(&authority.device_id)
        || authority.surface.kind != "station-native"
        || authority.surface.app_identifier != authority.app_identifier
        || authority.surface.channel != authority.channel.keyring_label()
        || authority.surface.client_instance_id != authority.client_instance_id
        || authority.route.station_id != authority.station_id
        || authority.route.broker_origin.is_empty()
        || authority.route.enrollment_id.is_empty()
        || authority.route.grant_id.is_empty()
    {
        return Err("The current Device candidate owner is invalid".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_proof_key_core::MemorySecretBackend;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn authority() -> NativeDeviceBindingCandidateAuthority {
        NativeDeviceBindingCandidateAuthority {
            profile_name: "Local Station".into(),
            profile_revision: 12,
            trust_revision: 4,
            device_authorization_epoch: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
            app_identifier: "io.kontourai.station".into(),
            channel: NativeProofKeyChannel::Stable,
            client_instance_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into(),
            station_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc".into(),
            device_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd".into(),
            surface: NativeDeviceBindingSurfaceV1 {
                kind: "station-native".into(),
                app_identifier: "io.kontourai.station".into(),
                channel: "stable".into(),
                client_instance_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into(),
                key_thumbprint: "current-route-thumbprint".into(),
            },
            route: NativeDeviceBindingRouteV1 {
                broker_origin: "https://broker.example.test".into(),
                station_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc".into(),
                enrollment_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee".into(),
                routing_generation: 9,
                grant_id: "route-grant-1".into(),
            },
        }
    }

    #[test]
    fn candidate_is_durable_before_key_creation_and_stable_after_restart() {
        let backend = MemorySecretBackend::default();
        let candidate_backend = backend.clone();
        let manager = NativeDeviceBindingCandidateManager::new(candidate_backend);
        let keys = MemoryNativeDeviceProofKeyVault::new();
        let first_authority = authority();
        let first = manager.candidate(&first_authority, &keys).unwrap();
        let stored: StoredCandidateV1 = serde_json::from_str(
            backend
                .lock()
                .get(&candidate_account(&first_authority))
                .expect("the candidate state is durable"),
        )
        .unwrap();
        assert_eq!(stored.state, CandidateState::Provisional);
        assert_eq!(
            stored.initial_device_authorization_epoch,
            first_authority.device_authorization_epoch
        );
        let restarted = NativeDeviceBindingCandidateManager::new(backend);
        let mut reauthorized = authority();
        reauthorized.device_authorization_epoch = "88888888-8888-4888-8888-888888888888".into();
        let second = restarted.candidate(&reauthorized, &keys).unwrap();
        assert_eq!(first, second);
        assert!(canonical_v4(&first.binding_id));
        assert_eq!(first.version, CANDIDATE_VERSION);
    }

    #[test]
    fn receipt_observation_is_durable_bound_to_the_public_tuple_and_current_host_epoch() {
        let backend = MemorySecretBackend::default();
        let manager = NativeDeviceBindingCandidateManager::new(backend.clone());
        let keys = MemoryNativeDeviceProofKeyVault::new();
        let owner = authority();
        let candidate = manager.candidate(&owner, &keys).unwrap();
        assert_ne!(
            candidate.binding_id(),
            owner.device_authorization_epoch(),
            "the Device proof binding UUID and host authorization epoch are separate"
        );
        manager
            .record_receipt_observation(
                &owner,
                &candidate,
                owner.device_authorization_epoch(),
                NativeDeviceReceiptObservation::Current,
                1_800_000_000_000,
            )
            .unwrap();

        let restarted = NativeDeviceBindingCandidateManager::new(backend);
        assert_eq!(
            restarted.receipt_observation(&owner, &candidate).unwrap(),
            Some(NativeDeviceReceiptObservationV1 {
                status: NativeDeviceReceiptObservation::Current,
                observed_at_ms: 1_800_000_000_000,
            })
        );

        let mut reauthorized = owner.clone();
        reauthorized.device_authorization_epoch = "88888888-8888-4888-8888-888888888888".into();
        assert_eq!(
            restarted
                .receipt_observation(&reauthorized, &candidate)
                .unwrap(),
            None
        );

        restarted
            .record_receipt_observation(
                &reauthorized,
                &candidate,
                reauthorized.device_authorization_epoch(),
                NativeDeviceReceiptObservation::NotCurrent,
                1_800_000_000_001,
            )
            .unwrap();
        assert_eq!(
            restarted
                .receipt_observation(&reauthorized, &candidate)
                .unwrap(),
            Some(NativeDeviceReceiptObservationV1 {
                status: NativeDeviceReceiptObservation::NotCurrent,
                observed_at_ms: 1_800_000_000_001,
            })
        );
        restarted
            .record_receipt_observation(
                &reauthorized,
                &candidate,
                reauthorized.device_authorization_epoch(),
                NativeDeviceReceiptObservation::NotFound,
                1_800_000_000_002,
            )
            .unwrap();
        assert_eq!(
            restarted
                .receipt_observation(&reauthorized, &candidate)
                .unwrap(),
            Some(NativeDeviceReceiptObservationV1 {
                status: NativeDeviceReceiptObservation::NotFound,
                observed_at_ms: 1_800_000_000_002,
            })
        );
        assert!(restarted.existing_candidate(&reauthorized, &keys).is_ok());

        let mut changed_profile = reauthorized.clone();
        changed_profile.profile_revision += 1;
        assert!(restarted
            .record_receipt_observation(
                &changed_profile,
                &candidate,
                changed_profile.device_authorization_epoch(),
                NativeDeviceReceiptObservation::Current,
                1_800_000_000_003,
            )
            .is_err());
        assert!(restarted
            .record_receipt_observation(
                &reauthorized,
                &candidate,
                owner.device_authorization_epoch(),
                NativeDeviceReceiptObservation::Current,
                1_800_000_000_004,
            )
            .is_err());
        assert_eq!(
            restarted
                .receipt_observation(&reauthorized, &candidate)
                .unwrap()
                .unwrap()
                .status,
            NativeDeviceReceiptObservation::NotFound,
            "a stale post-wait receipt cannot replace a current-epoch 404"
        );
    }

    #[test]
    fn unavailable_without_a_positive_receipt_never_becomes_current() {
        let backend = MemorySecretBackend::default();
        let manager = NativeDeviceBindingCandidateManager::new(backend.clone());
        let keys = MemoryNativeDeviceProofKeyVault::new();
        let owner = authority();
        let candidate = manager.candidate(&owner, &keys).unwrap();
        manager
            .record_receipt_observation(
                &owner,
                &candidate,
                owner.device_authorization_epoch(),
                NativeDeviceReceiptObservation::Unavailable,
                1_800_000_000_000,
            )
            .unwrap();
        let restarted = NativeDeviceBindingCandidateManager::new(backend);
        let observation = restarted
            .receipt_observation(&owner, &candidate)
            .unwrap()
            .unwrap();
        assert_eq!(
            observation.status,
            NativeDeviceReceiptObservation::Unavailable
        );
        assert_eq!(observation.observed_at_ms, 1_800_000_000_000);
    }

    #[test]
    fn receipt_lookup_never_creates_a_candidate_or_replaces_a_missing_key() {
        let backend = MemorySecretBackend::default();
        let manager = NativeDeviceBindingCandidateManager::new(backend.clone());
        let keys = MemoryNativeDeviceProofKeyVault::new();
        assert!(manager.existing_candidate(&authority(), &keys).is_err());
        let owner = authority();
        let candidate = manager.candidate(&owner, &keys).unwrap();
        let key_owner = NativeDeviceProofKeyOwner::with_binding_id(
            &owner.app_identifier,
            owner.channel,
            &owner.client_instance_id,
            &owner.station_id,
            &owner.device_id,
            &candidate.binding_id,
        )
        .unwrap();
        keys.revoke(&key_owner).unwrap();
        let restarted = NativeDeviceBindingCandidateManager::new(backend);
        assert!(restarted.existing_candidate(&owner, &keys).is_err());
        assert!(restarted.candidate(&owner, &keys).is_err());
        assert!(keys.restore(&key_owner).is_err());
    }

    #[test]
    fn self_receipt_requires_the_exact_public_tuple_and_consistent_state() {
        let manager = NativeDeviceBindingCandidateManager::new(MemorySecretBackend::default());
        let candidate = manager
            .candidate(&authority(), &MemoryNativeDeviceProofKeyVault::new())
            .unwrap();
        let mut receipt = NativeDeviceProofSelfReceiptV1 {
            version: "station-native-device-proof-self-receipt/v1".into(),
            binding: NativeDeviceProofSelfReceiptBindingV1 {
                station_id: candidate.station_id.clone(),
                device_id: candidate.device_id.clone(),
                binding_id: candidate.binding_id.clone(),
                surface: candidate.surface.clone(),
                device_proof_jwk: candidate.device_proof_jwk.clone(),
                device_proof_key_thumbprint: candidate.device_proof_key_thumbprint.clone(),
                state: NativeDeviceReceiptBindingState::Active,
                created_at: 1_800_000_000_000,
                approved_at: 1_800_000_000_000,
                revoked_at: None,
                revocation_reason: None,
            },
            current_device_binding: true,
        };
        assert_eq!(
            candidate.validate_self_receipt(&receipt).unwrap(),
            NativeDeviceReceiptObservation::Current
        );

        let mut wrong_key = receipt.clone();
        wrong_key.binding.device_proof_key_thumbprint = "wrong-thumbprint".into();
        assert!(candidate.validate_self_receipt(&wrong_key).is_err());
        let mut contradictory_currentness = receipt.clone();
        contradictory_currentness.current_device_binding = false;
        contradictory_currentness.binding.revoked_at = Some(1_800_000_000_001);
        contradictory_currentness.binding.revocation_reason =
            Some(NativeDeviceReceiptRevocationReason::Replaced);
        assert!(candidate
            .validate_self_receipt(&contradictory_currentness)
            .is_err());

        receipt.binding.state = NativeDeviceReceiptBindingState::Revoked;
        receipt.binding.revoked_at = Some(1_800_000_000_001);
        receipt.binding.revocation_reason = Some(NativeDeviceReceiptRevocationReason::Replaced);
        receipt.current_device_binding = false;
        assert_eq!(
            candidate.validate_self_receipt(&receipt).unwrap(),
            NativeDeviceReceiptObservation::NotCurrent
        );

        let mut value = serde_json::to_value(receipt).unwrap();
        value["unexpected"] = serde_json::json!(true);
        assert!(serde_json::from_value::<NativeDeviceProofSelfReceiptV1>(value).is_err());
    }

    #[test]
    fn an_owner_revision_or_surface_change_fails_closed_without_a_new_key() {
        let backend = MemorySecretBackend::default();
        let manager = NativeDeviceBindingCandidateManager::new(backend.clone());
        let keys = MemoryNativeDeviceProofKeyVault::new();
        let candidate = manager.candidate(&authority(), &keys).unwrap();
        let key_count = keys.backend().lock().len();
        let mut changed = authority();
        changed.profile_revision += 1;
        assert!(manager.candidate(&changed, &keys).is_err());
        let mut changed_epoch = authority();
        changed_epoch.device_authorization_epoch = "88888888-8888-4888-8888-888888888888".into();
        assert_eq!(
            manager.candidate(&changed_epoch, &keys).unwrap().binding_id,
            candidate.binding_id
        );
        let mut changed_trust = authority();
        changed_trust.trust_revision += 1;
        assert!(manager.candidate(&changed_trust, &keys).is_err());
        let mut changed_surface = authority();
        changed_surface.surface.key_thumbprint = "another-route-key".into();
        assert!(manager.candidate(&changed_surface, &keys).is_err());
        let mut changed_station = authority();
        changed_station.station_id = "ffffffff-ffff-4fff-8fff-ffffffffffff".into();
        assert!(manager.candidate(&changed_station, &keys).is_err());
        let mut changed_device = authority();
        changed_device.device_id = "99999999-9999-4999-8999-999999999999".into();
        assert!(manager.candidate(&changed_device, &keys).is_err());
        let mut changed_route = authority();
        changed_route.route.grant_id = "another-route-grant".into();
        assert!(manager.candidate(&changed_route, &keys).is_err());
        assert_eq!(keys.backend().lock().len(), key_count);
    }

    #[test]
    fn a_provisional_candidate_with_a_missing_key_fails_closed_without_replacement() {
        let manager = NativeDeviceBindingCandidateManager::new(MemorySecretBackend::default());
        let keys = MemoryNativeDeviceProofKeyVault::new();
        let candidate = manager.candidate(&authority(), &keys).unwrap();
        let owner = NativeDeviceProofKeyOwner::with_binding_id(
            "io.kontourai.station",
            NativeProofKeyChannel::Stable,
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            &candidate.binding_id,
        )
        .unwrap();
        keys.revoke(&owner).unwrap();
        assert!(manager.candidate(&authority(), &keys).is_err());
        assert!(keys.backend().lock().is_empty());
    }

    #[test]
    fn candidate_record_write_must_be_readback_confirmed_before_key_creation() {
        #[derive(Clone)]
        struct FaultBackend {
            inner: MemorySecretBackend,
            fail_write_before_commit: std::sync::Arc<AtomicBool>,
            fail_readback_after_commit: std::sync::Arc<AtomicBool>,
            fail_next_read: std::sync::Arc<AtomicBool>,
        }
        impl ProofKeySecretBackend for FaultBackend {
            fn read(
                &self,
                account: &str,
            ) -> crate::native_proof_key_core::ProofKeyResult<Option<zeroize::Zeroizing<String>>>
            {
                if self.fail_next_read.swap(false, Ordering::SeqCst) {
                    return Err(ProofKeyError::Store);
                }
                self.inner.read(account)
            }

            fn write(
                &self,
                account: &str,
                value: &str,
            ) -> crate::native_proof_key_core::ProofKeyResult<()> {
                if self.fail_write_before_commit.swap(false, Ordering::SeqCst) {
                    return Err(ProofKeyError::Store);
                }
                self.inner.write(account, value)?;
                if self
                    .fail_readback_after_commit
                    .swap(false, Ordering::SeqCst)
                {
                    self.fail_next_read.store(true, Ordering::SeqCst);
                }
                Ok(())
            }

            fn delete(&self, account: &str) -> crate::native_proof_key_core::ProofKeyResult<()> {
                self.inner.delete(account)
            }
        }

        let backend = FaultBackend {
            inner: MemorySecretBackend::default(),
            fail_write_before_commit: std::sync::Arc::new(AtomicBool::new(true)),
            fail_readback_after_commit: std::sync::Arc::new(AtomicBool::new(false)),
            fail_next_read: std::sync::Arc::new(AtomicBool::new(false)),
        };
        let manager = NativeDeviceBindingCandidateManager::new(backend.clone());
        let keys = MemoryNativeDeviceProofKeyVault::new();
        assert!(manager.candidate(&authority(), &keys).is_err());
        assert!(keys.backend().lock().is_empty());

        let created = manager.candidate(&authority(), &keys).unwrap();
        let mut readback_authority = authority();
        readback_authority.profile_name = "Second Station".into();
        let account = candidate_account(&readback_authority);
        backend
            .fail_readback_after_commit
            .store(true, Ordering::SeqCst);
        assert!(manager.candidate(&readback_authority, &keys).is_err());
        assert_eq!(keys.backend().lock().len(), 1);
        let pending: StoredCandidateV1 = serde_json::from_str(
            backend
                .inner
                .lock()
                .get(&account)
                .expect("the readback write committed"),
        )
        .unwrap();

        let resumed = manager.candidate(&readback_authority, &keys).unwrap();
        assert_eq!(resumed.binding_id, pending.binding_id);
        assert_ne!(resumed.binding_id, created.binding_id);
        let owner = NativeDeviceProofKeyOwner::with_binding_id(
            "io.kontourai.station",
            NativeProofKeyChannel::Stable,
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            &resumed.binding_id,
        )
        .unwrap();
        assert_eq!(
            keys.restore(&owner).unwrap().jwk(),
            &resumed.device_proof_jwk
        );
    }

    #[test]
    fn an_ambiguous_candidate_write_resumes_the_same_binding_id() {
        struct CommitThenFail(MemorySecretBackend);
        impl ProofKeySecretBackend for CommitThenFail {
            fn read(
                &self,
                account: &str,
            ) -> crate::native_proof_key_core::ProofKeyResult<Option<zeroize::Zeroizing<String>>>
            {
                self.0.read(account)
            }

            fn write(
                &self,
                account: &str,
                value: &str,
            ) -> crate::native_proof_key_core::ProofKeyResult<()> {
                self.0.write(account, value)?;
                Err(ProofKeyError::Store)
            }

            fn delete(&self, account: &str) -> crate::native_proof_key_core::ProofKeyResult<()> {
                self.0.delete(account)
            }
        }
        let backend = MemorySecretBackend::default();
        let manager = NativeDeviceBindingCandidateManager::new(CommitThenFail(backend.clone()));
        let keys = MemoryNativeDeviceProofKeyVault::new();
        assert!(manager.candidate(&authority(), &keys).is_err());
        assert!(keys.backend().lock().is_empty());
        let prior: StoredCandidateV1 = serde_json::from_str(
            backend
                .lock()
                .values()
                .next()
                .expect("the uncertain write committed"),
        )
        .unwrap();

        let resumed = NativeDeviceBindingCandidateManager::new(backend)
            .candidate(&authority(), &keys)
            .unwrap();
        assert_eq!(resumed.binding_id, prior.binding_id);
    }

    #[test]
    fn an_ambiguous_device_key_create_resumes_the_persisted_candidate() {
        struct FailBeforeCommit {
            inner: MemoryNativeDeviceProofKeyVault,
            fail_once: AtomicBool,
        }
        impl DeviceCandidateKeyVault for FailBeforeCommit {
            fn create(
                &self,
                owner: &NativeDeviceProofKeyOwner,
            ) -> Result<
                crate::native_device_proof_key::NativeDeviceProofKeyPublicMetadata,
                DeviceProofKeyError,
            > {
                if self.fail_once.swap(false, Ordering::SeqCst) {
                    return Err(DeviceProofKeyError::Store);
                }
                self.inner.create(owner)
            }

            fn restore(
                &self,
                owner: &NativeDeviceProofKeyOwner,
            ) -> Result<
                crate::native_device_proof_key::NativeDeviceProofKeyPublicMetadata,
                DeviceProofKeyError,
            > {
                self.inner.restore(owner)
            }
        }
        let backend = MemorySecretBackend::default();
        let manager = NativeDeviceBindingCandidateManager::new(backend);
        let keys = FailBeforeCommit {
            inner: MemoryNativeDeviceProofKeyVault::new(),
            fail_once: AtomicBool::new(true),
        };
        assert!(manager.candidate(&authority(), &keys).is_err());
        let resumed = manager.candidate(&authority(), &keys).unwrap();
        let owner = NativeDeviceProofKeyOwner::with_binding_id(
            "io.kontourai.station",
            NativeProofKeyChannel::Stable,
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            &resumed.binding_id,
        )
        .unwrap();
        assert_eq!(
            keys.inner.restore(&owner).unwrap().jwk(),
            &resumed.device_proof_jwk
        );
    }

    #[test]
    fn a_device_key_write_with_a_lost_reply_is_restored_without_replacement() {
        struct CommitThenFail {
            inner: MemoryNativeDeviceProofKeyVault,
            fail_once: AtomicBool,
        }
        impl DeviceCandidateKeyVault for CommitThenFail {
            fn create(
                &self,
                owner: &NativeDeviceProofKeyOwner,
            ) -> Result<
                crate::native_device_proof_key::NativeDeviceProofKeyPublicMetadata,
                DeviceProofKeyError,
            > {
                let metadata = self.inner.create(owner)?;
                if self.fail_once.swap(false, Ordering::SeqCst) {
                    return Err(DeviceProofKeyError::Store);
                }
                Ok(metadata)
            }

            fn restore(
                &self,
                owner: &NativeDeviceProofKeyOwner,
            ) -> Result<
                crate::native_device_proof_key::NativeDeviceProofKeyPublicMetadata,
                DeviceProofKeyError,
            > {
                self.inner.restore(owner)
            }
        }

        let manager = NativeDeviceBindingCandidateManager::new(MemorySecretBackend::default());
        let keys = CommitThenFail {
            inner: MemoryNativeDeviceProofKeyVault::new(),
            fail_once: AtomicBool::new(true),
        };
        assert!(manager.candidate(&authority(), &keys).is_err());
        assert_eq!(keys.inner.backend().lock().len(), 1);
        let candidate = manager.candidate(&authority(), &keys).unwrap();
        assert_eq!(keys.inner.backend().lock().len(), 1);
        let owner = NativeDeviceProofKeyOwner::with_binding_id(
            "io.kontourai.station",
            NativeProofKeyChannel::Stable,
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            &candidate.binding_id,
        )
        .unwrap();
        assert_eq!(
            keys.inner.restore(&owner).unwrap().jwk(),
            &candidate.device_proof_jwk
        );
    }

    #[test]
    fn serialized_candidate_matches_the_public_descriptor_without_secret_fields() {
        let manager = NativeDeviceBindingCandidateManager::new(MemorySecretBackend::default());
        let candidate = manager
            .candidate(&authority(), &MemoryNativeDeviceProofKeyVault::new())
            .unwrap();
        let value = serde_json::to_value(candidate).unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(
            object.keys().map(String::as_str).collect::<Vec<_>>(),
            [
                "bindingId",
                "deviceId",
                "deviceProofJwk",
                "deviceProofKeyThumbprint",
                "stationId",
                "surface",
                "version",
            ]
        );
        assert_eq!(object["version"], CANDIDATE_VERSION);
        assert!(object.get("bearer").is_none());
        assert!(object.get("privateKey").is_none());
        assert!(object.get("grant").is_none());
    }

    #[test]
    fn an_unavailable_manager_keychain_fails_before_device_key_creation() {
        struct Unavailable;
        impl ProofKeySecretBackend for Unavailable {
            fn read(
                &self,
                _account: &str,
            ) -> crate::native_proof_key_core::ProofKeyResult<Option<zeroize::Zeroizing<String>>>
            {
                Err(ProofKeyError::Store)
            }
            fn write(
                &self,
                _account: &str,
                _value: &str,
            ) -> crate::native_proof_key_core::ProofKeyResult<()> {
                Err(ProofKeyError::Store)
            }
            fn delete(&self, _account: &str) -> crate::native_proof_key_core::ProofKeyResult<()> {
                Err(ProofKeyError::Store)
            }
        }
        let manager = NativeDeviceBindingCandidateManager::new(Unavailable);
        let keys = MemoryNativeDeviceProofKeyVault::new();
        assert!(manager.candidate(&authority(), &keys).is_err());
        assert!(keys.backend().lock().is_empty());
    }
}

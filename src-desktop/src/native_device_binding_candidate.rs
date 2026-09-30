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
const MAX_CANDIDATE_RECORD_BYTES: usize = 2048;
const MAX_CANDIDATE_RECORD_UTF16_UNITS: usize = 1280;

static CANDIDATE_OPERATION: Mutex<()> = Mutex::new(());

/// Public mirror of the existing `NativeDeviceBindingCandidateV1` contract.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeDeviceBindingCandidateV1 {
    version: String,
    station_id: String,
    device_id: String,
    binding_id: String,
    surface: NativeDeviceBindingSurfaceV1,
    device_proof_jwk: P256PublicJwk,
    device_proof_key_thumbprint: String,
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
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StoredCandidateV1 {
    schema_version: u8,
    owner: StoredCandidateOwnerV1,
    binding_id: String,
    initial_device_authorization_epoch: String,
    state: CandidateState,
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
        if stored.schema_version != 1 {
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

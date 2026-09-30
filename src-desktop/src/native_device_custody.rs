//! Desktop-native Device identity custody metadata for paired Station
//! credentials (station#2893).
//!
//! A paired bearer alone carries no trustworthy Device identity: the
//! renderer-writable profile projection (`CredentialProfile` /
//! `NativeCredentialReference`) is not an authority for which Device the
//! credential belongs to. This module is a versioned, secret-free METADATA
//! COMPANION written next to the bearer in the OS keyring — never an
//! authoritative profile `deviceId` and never a bearer-format migration. It
//! lives in a distinct keyring service namespace, its account is derived from
//! the exact credential reference, and each record binds the reference, the
//! SHA-256 of the exact bearer bytes, the exact origin, the Station
//! environment, the client instance, and the Device id/kind captured from the
//! authenticated pairing response while the bearer was still host-held. The
//! bearer itself and its hash never cross IPC or logs.
//!
//! Rust-internal only: no Tauri command, renderer capability, or signing path
//! is exposed here. The current-identity resolver is the fail-closed seam a
//! future Device proof binding consumes; a missing or malformed companion
//! (legacy credentials written before this module existed) yields a specific
//! missing-metadata refusal for that future binding while ordinary HTTP
//! credential use keeps reading the bare bearer exactly as before. Identity
//! custody alone establishes no approval, account, or Project authority.

use crate::native_proof_key_core::proof_key_account;
use crate::{CredentialProfileStore, NativeCredentialReference, NativeProfileAuthorityState};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::{Arc, Mutex};

/// Distinct metadata namespace. This must never equal
/// `STATION_CREDENTIAL_SERVICE` or any proof-key service: a companion record
/// must never be reachable through the ordinary bearer account space.
pub(crate) const METADATA_SERVICE: &str = "io.kontourai.station.credential-metadata";
const RECORD_PREFIX: &str = "credential-custody:v1";
const RECORD_VERSION: u8 = 1;

/// Versioned, secret-free custody companion for one exact bearer credential.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeDeviceCustodyMetadata {
    pub(crate) version: u8,
    pub(crate) reference: NativeCredentialReference,
    /// SHA-256 (hex) of the exact bearer bytes written beside this record.
    pub(crate) bearer_sha256: String,
    pub(crate) exact_origin: String,
    pub(crate) environment_id: String,
    pub(crate) client_instance_id: String,
    pub(crate) device_id: String,
    pub(crate) device_kind: String,
}

fn custody_sha256_hex(value: &str) -> String {
    use ring::digest::{digest, SHA256};
    hex_encode(digest(&SHA256, value.as_bytes()).as_ref())
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// The keyring account is a domain-separated digest of the exact credential
/// reference under this vault's own record prefix, so the companion namespace
/// cannot collide with the bearer account (`profile:<reference>`), the
/// account/relay/Device proof-key namespaces, or each other.
pub(crate) fn metadata_account(reference: &NativeCredentialReference) -> Result<String, String> {
    let key = crate::credential_reference_key(reference)?;
    Ok(proof_key_account(RECORD_PREFIX, &[key.as_bytes()]))
}

impl NativeDeviceCustodyMetadata {
    /// Captures the custody tuple from host-held pending pairing state. Every
    /// field is validated; the bearer only ever contributes its digest.
    pub(crate) fn for_pairing(
        reference: &NativeCredentialReference,
        bearer: &str,
        exact_origin: &str,
        environment_id: &str,
        client_instance_id: &str,
        device_id: &str,
        device_kind: &str,
    ) -> Result<Self, String> {
        // Reference validity is the existing shared rule; it also derives the
        // account, so an invalid reference can never mint a record.
        metadata_account(reference)?;
        let bounded = |value: &str, limit: usize, label: &str| {
            if value.is_empty() || value.len() > limit {
                return Err(format!("invalid Station custody metadata {label}"));
            }
            Ok(())
        };
        bounded(exact_origin, 2048, "origin")?;
        bounded(environment_id, 512, "environment")?;
        bounded(client_instance_id, 128, "client instance")?;
        bounded(device_id, 512, "device id")?;
        bounded(device_kind, 64, "device kind")?;
        if bearer.is_empty() || bearer.len() > 16 * 1024 {
            return Err("invalid Station custody metadata bearer".to_string());
        }
        Ok(Self {
            version: RECORD_VERSION,
            reference: reference.clone(),
            bearer_sha256: custody_sha256_hex(bearer),
            exact_origin: exact_origin.to_owned(),
            environment_id: environment_id.to_owned(),
            client_instance_id: client_instance_id.to_owned(),
            device_id: device_id.to_owned(),
            device_kind: device_kind.to_owned(),
        })
    }

    fn parse(raw: &str) -> Result<Self, String> {
        let record: Self =
            serde_json::from_str(raw).map_err(|_| "malformed custody metadata".to_string())?;
        if record.version != RECORD_VERSION {
            return Err("unsupported custody metadata version".to_string());
        }
        if record.bearer_sha256.len() != 64
            || !record
                .bearer_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("malformed custody metadata bearer digest".to_string());
        }
        Ok(record)
    }
}

/// Storage boundary for companion records. The production implementation is
/// the desktop OS keyring under [`METADATA_SERVICE`]; tests use an in-memory
/// backend, mirroring the shared proof-key custody seams.
pub(crate) trait CustodyMetadataStore: Send + Sync {
    fn read(&self, account: &str) -> Result<Option<String>, String>;
}

/// The desktop pairing-commit and retirement custody boundary: the bearer
/// entry the commit phase already owned, plus the companion write that must
/// succeed in the same phase before the pairing may publish
/// (`KeyringWritten`), and the both-attempt retirement that pairs with every
/// bearer delete.
pub(crate) trait PairingCustodyWriter: Send + Sync {
    fn write_bearer(
        &self,
        reference: &NativeCredentialReference,
        password: &str,
    ) -> Result<(), String>;
    fn write_metadata(&self, metadata: &NativeDeviceCustodyMetadata) -> Result<(), String>;
    fn delete_bearer(&self, reference: &NativeCredentialReference) -> Result<(), String>;
    /// Retires the companion with the bearer. A missing record is already
    /// retired and is success.
    fn delete_metadata(&self, reference: &NativeCredentialReference) -> Result<(), String>;
}

/// Desktop production custody: the ordinary bearer entry (unchanged service,
/// unchanged account derivation, unchanged ordinary HTTP fetch behavior) plus
/// the distinct metadata companion namespace.
pub(crate) struct DesktopPairingCustody;

impl PairingCustodyWriter for DesktopPairingCustody {
    fn write_bearer(
        &self,
        reference: &NativeCredentialReference,
        password: &str,
    ) -> Result<(), String> {
        crate::write_credential_password(reference, password)
    }

    fn write_metadata(&self, metadata: &NativeDeviceCustodyMetadata) -> Result<(), String> {
        let account = metadata_account(&metadata.reference)?;
        let raw = serde_json::to_string(metadata)
            .map_err(|_| "serialize Station custody metadata".to_string())?;
        match keyring_metadata_entry(&account)?.set_password(&raw) {
            Ok(()) => Ok(()),
            Err(error) => Err(format!("write Station custody metadata: {error}")),
        }
    }

    fn delete_bearer(&self, reference: &NativeCredentialReference) -> Result<(), String> {
        match crate::credential_entry(reference)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(error) if crate::is_missing_credential(&error) => Ok(()),
            Err(error) => Err(format!("delete OS credential: {error}")),
        }
    }

    fn delete_metadata(&self, reference: &NativeCredentialReference) -> Result<(), String> {
        let account = metadata_account(reference)?;
        match keyring_metadata_entry(&account)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(error) if crate::is_missing_credential(&error) => Ok(()),
            Err(error) => Err(format!("delete Station custody metadata: {error}")),
        }
    }
}

fn keyring_metadata_entry(account: &str) -> Result<keyring_core::Entry, String> {
    crate::initialize_credential_store()?;
    keyring_core::Entry::new(METADATA_SERVICE, account)
        .map_err(|error| format!("create Station custody metadata entry: {error}"))
}

/// Production companion reads for the resolver. A missing keyring item is the
/// legacy/absent state, not an error.
pub(crate) struct DesktopCustodyMetadataStore;

impl CustodyMetadataStore for DesktopCustodyMetadataStore {
    fn read(&self, account: &str) -> Result<Option<String>, String> {
        match keyring_metadata_entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(error) if crate::is_missing_credential(&error) => Ok(None),
            Err(error) => Err(format!("read Station custody metadata: {error}")),
        }
    }
}

/// The resolved, current Device identity of the host-authorized active
/// Station. `binding_id` is the authorization epoch this resolution ran
/// under; the saved-profile revision is read per operation and is never
/// compared against the pairing commit's revision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CurrentDeviceIdentity {
    pub(crate) device_id: String,
    pub(crate) device_kind: String,
    pub(crate) binding_id: String,
    pub(crate) profile_revision: u64,
}

/// Fail-closed resolution outcomes. Every variant refuses to name a Device.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DeviceCustodyError {
    /// The active profile/authorization discipline refused; carries the
    /// existing structured refusal code.
    NotAuthorized(String),
    /// The bearer itself could not be read; never guess from metadata.
    BearerUnavailable,
    /// The companion is absent — the legacy credential state. Ordinary HTTP
    /// credential use keeps working; a future proof binding must refuse with
    /// exactly this missing-metadata result.
    MetadataMissing,
    /// The companion exists but cannot be trusted (unparseable, unsupported
    /// version, malformed digest).
    MetadataMalformed,
    /// The companion disagrees with the current custody tuple: reference,
    /// bearer digest, origin, Station environment, client instance, or the
    /// Device kind is not `device`.
    MetadataMismatch(&'static str),
    /// The metadata store itself failed; fail closed.
    MetadataStore,
}

impl std::fmt::Display for DeviceCustodyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAuthorized(code) => write!(f, "device custody is not authorized: {code}"),
            Self::BearerUnavailable => write!(f, "the Station bearer could not be read"),
            Self::MetadataMissing => write!(f, "the Station credential has no custody metadata"),
            Self::MetadataMalformed => write!(f, "the Station custody metadata is malformed"),
            Self::MetadataMismatch(field) => {
                write!(f, "the Station custody metadata does not match: {field}")
            }
            Self::MetadataStore => write!(f, "the Station custody metadata store is unavailable"),
        }
    }
}

/// Resolves the current Device identity of the host-authorized active
/// Station under the existing profile-lock/authorization discipline: the
/// saved-Station store and authority state are revalidated exactly as the
/// bearer-read boundary does, then the bearer and its companion must agree on
/// the full custody tuple. The profile revision is re-read per operation; it
/// is never required to equal the revision at pairing commit time. The
/// Device id is never inferred from the profile name, bearer syntax, renderer
/// input, or device listings.
pub(crate) fn resolve_current_device_identity(
    state: &NativeProfileAuthorityState,
    store: &CredentialProfileStore,
    read_bearer: impl FnOnce(&NativeCredentialReference) -> Result<String, String>,
    metadata: &dyn CustodyMetadataStore,
) -> Result<CurrentDeviceIdentity, DeviceCustodyError> {
    let context = crate::authorized_profile_context_in_store(state, store)
        .map_err(|error| DeviceCustodyError::NotAuthorized(error.code.to_string()))?;
    let client_instance_id = context
        .client_instance_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or(DeviceCustodyError::MetadataMismatch("client instance"))?;
    let bearer =
        read_bearer(&context.reference).map_err(|_| DeviceCustodyError::BearerUnavailable)?;
    let account =
        metadata_account(&context.reference).map_err(|_| DeviceCustodyError::MetadataMalformed)?;
    let Some(raw) = metadata
        .read(&account)
        .map_err(|_| DeviceCustodyError::MetadataStore)?
    else {
        return Err(DeviceCustodyError::MetadataMissing);
    };
    let record = NativeDeviceCustodyMetadata::parse(&raw)
        .map_err(|_| DeviceCustodyError::MetadataMalformed)?;
    let mismatch = |field: &'static str| DeviceCustodyError::MetadataMismatch(field);
    if record.reference != context.reference {
        return Err(mismatch("credential reference"));
    }
    if record.bearer_sha256 != custody_sha256_hex(&bearer) {
        return Err(mismatch("bearer digest"));
    }
    if record.exact_origin != context.exact_origin {
        return Err(mismatch("origin"));
    }
    if record.environment_id != context.environment_id {
        return Err(mismatch("Station environment"));
    }
    if record.client_instance_id != client_instance_id {
        return Err(mismatch("client instance"));
    }
    if record.device_kind != "device" {
        return Err(mismatch("device kind"));
    }
    Ok(CurrentDeviceIdentity {
        device_id: record.device_id,
        device_kind: record.device_kind,
        binding_id: context.binding_id,
        profile_revision: context.profile_revision,
    })
}

#[cfg(test)]
pub(crate) struct MemoryCustodyMetadataStore(Arc<Mutex<HashMap<String, String>>>);

#[cfg(test)]
impl Default for MemoryCustodyMetadataStore {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(HashMap::new())))
    }
}

#[cfg(test)]
impl MemoryCustodyMetadataStore {
    pub(crate) fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.0.lock().unwrap()
    }
}

#[cfg(test)]
impl CustodyMetadataStore for MemoryCustodyMetadataStore {
    fn read(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.lock().get(account).cloned())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_keychain_tests {
    use super::*;
    use crate::NativeCredentialReference;

    /// Opt-in, macOS-only: writes one random pairing reference's companion to
    /// the real macOS Keychain and reads it back. Never executed on Linux and
    /// never a substitute for platform proof; run explicitly on a macOS host
    /// with `cargo test macos_keychain -- --ignored`.
    #[test]
    #[ignore = "writes one random account to the current macOS Keychain"]
    fn macos_keychain_metadata_roundtrip() {
        struct RetireOnDrop<'a> {
            custody: &'a DesktopPairingCustody,
            reference: NativeCredentialReference,
        }
        impl Drop for RetireOnDrop<'_> {
            fn drop(&mut self) {
                let _ = self.custody.delete_metadata(&self.reference);
            }
        }
        let custody = DesktopPairingCustody;
        let reference = NativeCredentialReference {
            kind: "station-bearer".to_string(),
            id: format!("custody-roundtrip:{}", uuid::Uuid::new_v4()),
        };
        let _cleanup = RetireOnDrop {
            custody: &custody,
            reference: reference.clone(),
        };
        let metadata = NativeDeviceCustodyMetadata::for_pairing(
            &reference,
            "roundtrip-bearer",
            "https://roundtrip.example",
            "environment-roundtrip",
            &uuid::Uuid::new_v4().to_string(),
            &uuid::Uuid::new_v4().to_string(),
            "device",
        )
        .unwrap();
        let account = metadata_account(&reference).unwrap();
        assert!(DesktopCustodyMetadataStore
            .read(&account)
            .unwrap()
            .is_none());
        custody.write_metadata(&metadata).unwrap();
        let raw = DesktopCustodyMetadataStore.read(&account).unwrap().unwrap();
        assert_eq!(NativeDeviceCustodyMetadata::parse(&raw).unwrap(), metadata);
        custody.delete_metadata(&reference).unwrap();
        assert!(DesktopCustodyMetadataStore
            .read(&account)
            .unwrap()
            .is_none());
    }
}

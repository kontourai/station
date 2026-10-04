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
//! the exact native app/channel owner and credential reference, and each record binds the owner, reference, the
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
const RECORD_PREFIX: &str = "credential-custody:v2";
const RECORD_VERSION: u8 = 2;

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeDeviceCustodyOwner {
    app_identifier: String,
    channel: String,
}

impl NativeDeviceCustodyOwner {
    pub(crate) fn for_app(app: &tauri::AppHandle) -> Result<Self, String> {
        Self::new(
            &app.config().identifier,
            crate::native_app_channel(&app.config().identifier, cfg!(debug_assertions)),
        )
    }

    fn new(app_identifier: &str, channel: &str) -> Result<Self, String> {
        let owner = Self {
            app_identifier: app_identifier.to_owned(),
            channel: channel.to_owned(),
        };
        owner.validate()?;
        Ok(owner)
    }

    fn validate(&self) -> Result<(), String> {
        if !crate::native_proof_key_core::valid_app_identifier(&self.app_identifier)
            || !matches!(self.channel.as_str(), "dev" | "stable" | "beta" | "nightly")
        {
            return Err("invalid Station custody owner".into());
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn fixture() -> Self {
        Self::new("io.kontourai.station.test", "dev").unwrap()
    }
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|parsed| parsed.to_string() == value)
}

/// Versioned, secret-free custody companion for one exact bearer credential.
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeDeviceCustodyMetadata {
    pub(crate) version: u8,
    pub(crate) owner: NativeDeviceCustodyOwner,
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
/// native app/channel owner and reference under this vault's own record prefix, so the companion namespace
/// cannot collide with the bearer account (`profile:<reference>`), the
/// account/relay/Device proof-key namespaces, or each other.
pub(crate) fn metadata_account(
    owner: &NativeDeviceCustodyOwner,
    reference: &NativeCredentialReference,
) -> Result<String, String> {
    owner.validate()?;
    let key = crate::credential_reference_key(reference)?;
    Ok(proof_key_account(
        RECORD_PREFIX,
        &[
            owner.app_identifier.as_bytes(),
            owner.channel.as_bytes(),
            key.as_bytes(),
        ],
    ))
}

impl NativeDeviceCustodyMetadata {
    /// Captures the custody tuple from host-held pending pairing state. Every
    /// field is validated; the bearer only ever contributes its digest.
    pub(crate) fn for_pairing(
        owner: &NativeDeviceCustodyOwner,
        reference: &NativeCredentialReference,
        bearer: &str,
        exact_origin: &str,
        environment_id: &str,
        client_instance_id: &str,
        device_id: &str,
        device_kind: &str,
    ) -> Result<Self, String> {
        if bearer.is_empty() || bearer.len() > 16 * 1024 {
            return Err("invalid Station custody metadata bearer".into());
        }
        let record = Self {
            version: RECORD_VERSION,
            owner: owner.clone(),
            reference: reference.clone(),
            bearer_sha256: custody_sha256_hex(bearer),
            exact_origin: exact_origin.to_owned(),
            environment_id: environment_id.to_owned(),
            client_instance_id: client_instance_id.to_owned(),
            device_id: device_id.to_owned(),
            device_kind: device_kind.to_owned(),
        };
        record.validate()?;
        Ok(record)
    }

    fn validate(&self) -> Result<(), String> {
        metadata_account(&self.owner, &self.reference)?;
        let origin =
            url::Url::parse(&self.exact_origin).map_err(|_| "malformed custody metadata origin")?;
        if self.version != RECORD_VERSION
            || !valid_digest(&self.bearer_sha256)
            || self.exact_origin.len() > 2048
            || !matches!(origin.scheme(), "http" | "https")
            || origin.origin().ascii_serialization() != self.exact_origin
            || !origin.username().is_empty()
            || origin.password().is_some()
            || !canonical_uuid(&self.environment_id)
            || !canonical_uuid(&self.client_instance_id)
            || !canonical_uuid(&self.device_id)
            || !matches!(self.device_kind.as_str(), "device" | "delegation")
        {
            return Err("malformed Station custody metadata".into());
        }
        Ok(())
    }

    fn parse(raw: &str) -> Result<Self, String> {
        if raw.len() > 4096 {
            return Err("malformed Station custody metadata".into());
        }
        let record: Self =
            serde_json::from_str(raw).map_err(|_| "malformed Station custody metadata")?;
        record.validate()?;
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
    fn owner(&self) -> &NativeDeviceCustodyOwner;
    fn read_bearer(&self, reference: &NativeCredentialReference) -> Result<Option<String>, String>;
    fn read_metadata(&self, account: &str) -> Result<Option<String>, String>;
    fn write_journal(&self, account: &str, value: &str) -> Result<(), String>;
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
pub(crate) struct DesktopPairingCustody {
    owner: NativeDeviceCustodyOwner,
}

impl DesktopPairingCustody {
    pub(crate) fn for_app(app: &tauri::AppHandle) -> Result<Self, String> {
        Ok(Self {
            owner: NativeDeviceCustodyOwner::for_app(app)?,
        })
    }
}

impl PairingCustodyWriter for DesktopPairingCustody {
    fn owner(&self) -> &NativeDeviceCustodyOwner {
        &self.owner
    }
    fn read_bearer(&self, reference: &NativeCredentialReference) -> Result<Option<String>, String> {
        match crate::credential_entry(reference)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(error) if crate::is_missing_credential(&error) => Ok(None),
            Err(_) => Err("Station credential store is unavailable".into()),
        }
    }
    fn read_metadata(&self, account: &str) -> Result<Option<String>, String> {
        DesktopCustodyMetadataStore.read(account)
    }
    fn write_journal(&self, account: &str, value: &str) -> Result<(), String> {
        keyring_metadata_entry(account)?
            .set_password(value)
            .map_err(|_| "Station retirement journal is unavailable".into())
    }
    fn write_bearer(
        &self,
        reference: &NativeCredentialReference,
        password: &str,
    ) -> Result<(), String> {
        crate::write_credential_password(reference, password)
    }

    fn write_metadata(&self, metadata: &NativeDeviceCustodyMetadata) -> Result<(), String> {
        let account = metadata_account(&self.owner, &metadata.reference)?;
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
        let account = metadata_account(&self.owner, reference)?;
        match keyring_metadata_entry(&account)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(error) if crate::is_missing_credential(&error) => Ok(()),
            Err(error) => Err(format!("delete Station custody metadata: {error}")),
        }
    }
}

fn keyring_metadata_entry(
    account: &str,
) -> Result<crate::native_secure_entry::NativeSecureEntry, String> {
    crate::initialize_credential_store()?;
    crate::native_secure_entry::NativeSecureEntry::new(METADATA_SERVICE, account)
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
    owner: &NativeDeviceCustodyOwner,
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
    let account = metadata_account(owner, &context.reference)
        .map_err(|_| DeviceCustodyError::MetadataMalformed)?;
    let Some(raw) = metadata
        .read(&account)
        .map_err(|_| DeviceCustodyError::MetadataStore)?
    else {
        return Err(DeviceCustodyError::MetadataMissing);
    };
    let record = NativeDeviceCustodyMetadata::parse(&raw)
        .map_err(|_| DeviceCustodyError::MetadataMalformed)?;
    let mismatch = |field: &'static str| DeviceCustodyError::MetadataMismatch(field);
    if &record.owner != owner {
        return Err(mismatch("native owner"));
    }
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

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "camelCase")]
enum RetirementAuthority {
    Removed,
    Active {
        profile_name: String,
        profile_revision: u64,
        authorization_epoch: String,
    },
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RetirementEntry {
    reference: NativeCredentialReference,
    bearer_sha256: Option<String>,
    authority: RetirementAuthority,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RetirementIndex {
    version: u8,
    owner: NativeDeviceCustodyOwner,
    profile_scope: String,
    entries: Vec<RetirementEntry>,
}

fn profile_scope(path: &std::path::Path) -> Result<String, String> {
    if !path.is_absolute() {
        return Err("invalid Station retirement scope".into());
    }
    let canonical =
        std::fs::canonicalize(path).map_err(|_| "Station retirement scope is unavailable")?;
    canonical
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "invalid Station retirement scope".into())
}

fn journal_account(
    owner: &NativeDeviceCustodyOwner,
    path: &std::path::Path,
) -> Result<String, String> {
    owner.validate()?;
    if !path.is_absolute() {
        return Err("invalid Station retirement scope".into());
    }
    let scope = profile_scope(path)?;
    Ok(proof_key_account(
        "credential-retirement:v1",
        &[
            owner.app_identifier.as_bytes(),
            owner.channel.as_bytes(),
            scope.as_bytes(),
        ],
    ))
}

// windows-native-keyring-store 1.1.0 stores passwords as UTF-16 bytes;
// CRED_MAX_CREDENTIAL_BLOB_SIZE is 2560 bytes, the supported backend floor.
fn journal_size_valid(raw: &str) -> bool {
    raw.len() <= 4096 && raw.encode_utf16().count() <= 1280
}

fn read_index(
    custody: &dyn PairingCustodyWriter,
    path: &std::path::Path,
) -> Result<RetirementIndex, String> {
    let account = journal_account(custody.owner(), path)?;
    let scope = profile_scope(path)?;
    let Some(raw) = custody.read_metadata(&account)? else {
        return Ok(RetirementIndex {
            version: 1,
            owner: custody.owner().clone(),
            profile_scope: scope.clone(),
            entries: Vec::new(),
        });
    };
    if !journal_size_valid(&raw) {
        return Err("invalid Station retirement journal".into());
    }
    let index: RetirementIndex =
        serde_json::from_str(&raw).map_err(|_| "invalid Station retirement journal")?;
    if index.version != 1
        || &index.owner != custody.owner()
        || index.profile_scope != scope
        || index.entries.len() > 32
    {
        return Err("invalid Station retirement journal".into());
    }
    let mut references = std::collections::HashSet::new();
    for entry in &index.entries {
        let reference = crate::credential_reference_key(&entry.reference)?;
        if !references.insert(reference)
            || entry
                .bearer_sha256
                .as_ref()
                .is_some_and(|digest| !valid_digest(digest))
        {
            return Err("invalid Station retirement journal".into());
        }
        if let RetirementAuthority::Active {
            profile_name,
            authorization_epoch,
            ..
        } = &entry.authority
        {
            if profile_name.is_empty()
                || profile_name.len() > 128
                || !canonical_uuid(authorization_epoch)
            {
                return Err("invalid Station retirement journal".into());
            }
        }
    }
    Ok(index)
}

fn write_index(
    custody: &dyn PairingCustodyWriter,
    path: &std::path::Path,
    index: &RetirementIndex,
) -> Result<(), String> {
    let account = journal_account(custody.owner(), path)?;
    let raw =
        serde_json::to_string(index).map_err(|_| "Station retirement journal is unavailable")?;
    if !journal_size_valid(&raw) || index.entries.len() > 32 {
        return Err("Station retirement journal is full".into());
    }
    // A lost write result is reconciled only by exact readback, before any deletion.
    let wrote = custody.write_journal(&account, &raw);
    match custody.read_metadata(&account) {
        Ok(Some(actual)) if actual == raw => Ok(()),
        _ => Err(wrote
            .err()
            .unwrap_or_else(|| "Station retirement journal is unavailable".into())),
    }
}

fn stage(
    custody: &dyn PairingCustodyWriter,
    path: &std::path::Path,
    reference: &NativeCredentialReference,
    authority: RetirementAuthority,
) -> Result<(), String> {
    let mut index = read_index(custody, path)?;
    let bearer = custody.read_bearer(reference);
    let metadata = custody.read_metadata(&metadata_account(custody.owner(), reference)?);
    let trusted_record = metadata
        .as_ref()
        .ok()
        .and_then(|raw| raw.as_deref())
        .and_then(|raw| NativeDeviceCustodyMetadata::parse(raw).ok())
        .filter(|record| &record.owner == custody.owner() && &record.reference == reference);
    let digest = match bearer {
        Ok(Some(value)) => Some(custody_sha256_hex(&value)),
        Ok(None) if matches!(metadata, Ok(None)) => return Ok(()),
        Ok(None) | Err(_) => trusted_record.map(|record| record.bearer_sha256),
    };
    // An unreadable legacy item without a trustworthy digest is quarantined,
    // never automatically deleted. This preserves replacement without inventing identity.
    if let Some(existing) = index
        .entries
        .iter_mut()
        .find(|entry| &entry.reference == reference)
    {
        if existing.bearer_sha256 != digest {
            return Err("Station retirement credential changed".into());
        }
        // A removed-reference CAS must not weaken an already approved active retirement.
        if matches!(authority, RetirementAuthority::Active { .. }) {
            existing.authority = authority;
        }
    } else {
        index.entries.push(RetirementEntry {
            reference: reference.clone(),
            bearer_sha256: digest,
            authority,
        });
    }
    write_index(custody, path, &index)
}

pub(crate) fn stage_removed_credentials(
    custody: &dyn PairingCustodyWriter,
    path: &std::path::Path,
    current: &CredentialProfileStore,
    next: &CredentialProfileStore,
) -> Result<(), String> {
    for reference in current
        .profiles
        .iter()
        .filter_map(|profile| profile.credential_ref.as_ref())
    {
        if !next
            .profiles
            .iter()
            .any(|profile| profile.credential_ref.as_ref() == Some(reference))
        {
            stage(custody, path, reference, RetirementAuthority::Removed)?;
        }
    }
    Ok(())
}

pub(crate) fn stage_unreferenced_retirement(
    custody: &dyn PairingCustodyWriter,
    path: &std::path::Path,
    reference: &NativeCredentialReference,
) -> Result<(), String> {
    stage(custody, path, reference, RetirementAuthority::Removed)
}

pub(crate) fn stage_active_retirement(
    custody: &dyn PairingCustodyWriter,
    path: &std::path::Path,
    store: &CredentialProfileStore,
    state: &NativeProfileAuthorityState,
) -> Result<(), String> {
    let active = state
        .active
        .as_ref()
        .ok_or("Station has no active credential")?;
    let context = crate::authorized_profile_context_in_store(state, store)
        .map_err(|_| "Station active credential changed")?;
    stage(
        custody,
        path,
        &context.reference,
        RetirementAuthority::Active {
            profile_name: active.name.clone(),
            profile_revision: store.revision,
            authorization_epoch: active.binding_id.clone(),
        },
    )
}

pub(crate) fn has_active_retirement(
    custody: &dyn PairingCustodyWriter,
    path: &std::path::Path,
    reference: &NativeCredentialReference,
) -> Result<bool, String> {
    Ok(read_index(custody, path)?.entries.iter().any(|entry| {
        &entry.reference == reference
            && (matches!(entry.authority, RetirementAuthority::Active { .. })
                || entry.bearer_sha256.is_none())
    }))
}

pub(crate) fn has_pending_retirements(
    custody: &dyn PairingCustodyWriter,
    path: &std::path::Path,
) -> Result<bool, String> {
    Ok(!read_index(custody, path)?.entries.is_empty())
}

/// The caller holds the profile-file lock. Journal authority permits cleanup only;
/// it never authorizes credential reads, profile selection or proof signing.
pub(crate) fn retry_retirements(
    custody: &dyn PairingCustodyWriter,
    path: &std::path::Path,
    store: &CredentialProfileStore,
    state: &NativeProfileAuthorityState,
    only_reference: Option<&NativeCredentialReference>,
) -> Result<(), String> {
    let mut index = read_index(custody, path)?;
    let mut failed = false;
    let mut completed = Vec::new();
    for entry in &index.entries {
        if only_reference.is_some_and(|reference| reference != &entry.reference) {
            continue;
        }
        let owners: Vec<_> = store
            .profiles
            .iter()
            .filter(|profile| profile.credential_ref.as_ref() == Some(&entry.reference))
            .collect();
        if !owners.is_empty() {
            match &entry.authority {
                RetirementAuthority::Removed => {
                    failed = true;
                    continue;
                }
                RetirementAuthority::Active {
                    profile_name,
                    profile_revision,
                    authorization_epoch,
                } => {
                    if owners.len() != 1
                        || owners[0].name != *profile_name
                        || store.revision != *profile_revision
                        || state.active.as_ref().is_some_and(|active| {
                            active.reference == entry.reference
                                && active.binding_id != *authorization_epoch
                        })
                    {
                        failed = true;
                        continue;
                    }
                }
            }
        }
        let bearer = match custody.read_bearer(&entry.reference) {
            Ok(value) => value,
            Err(_) => {
                failed = true;
                continue;
            }
        };
        let metadata =
            match custody.read_metadata(&metadata_account(custody.owner(), &entry.reference)?) {
                Ok(value) => value,
                Err(_) => {
                    failed = true;
                    continue;
                }
            };
        let Some(expected_digest) = &entry.bearer_sha256 else {
            // Manual removal can release quarantine only after both owned
            // entries are positively absent. No credential deletion is attempted.
            if bearer.is_none() && metadata.is_none() {
                completed.push(entry.reference.clone());
            } else {
                failed = true;
            }
            continue;
        };
        if bearer
            .as_ref()
            .is_some_and(|value| custody_sha256_hex(value) != *expected_digest)
        {
            failed = true;
            continue;
        }
        if let Some(raw) = metadata {
            match NativeDeviceCustodyMetadata::parse(&raw) {
                Ok(record)
                    if &record.owner == custody.owner()
                        && record.reference == entry.reference
                        && record.bearer_sha256 == *expected_digest => {}
                _ => {
                    failed = true;
                    continue;
                }
            }
        }
        let bearer_delete = custody.delete_bearer(&entry.reference);
        let metadata_delete = custody.delete_metadata(&entry.reference);
        if bearer_delete.is_ok() && metadata_delete.is_ok() {
            completed.push(entry.reference.clone());
        } else {
            failed = true;
        }
    }
    if !completed.is_empty() {
        index
            .entries
            .retain(|entry| !completed.contains(&entry.reference));
        write_index(custody, path, &index)?;
    }
    if failed {
        Err("Station credential retirement is incomplete".into())
    } else {
        Ok(())
    }
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
        let owner = NativeDeviceCustodyOwner::fixture();
        let custody = DesktopPairingCustody {
            owner: owner.clone(),
        };
        let reference = NativeCredentialReference {
            kind: "station-bearer".to_string(),
            id: format!("custody-roundtrip:{}", uuid::Uuid::new_v4()),
        };
        let _cleanup = RetireOnDrop {
            custody: &custody,
            reference: reference.clone(),
        };
        let metadata = NativeDeviceCustodyMetadata::for_pairing(
            &owner,
            &reference,
            "roundtrip-bearer",
            "https://roundtrip.example",
            "11111111-1111-4111-8111-111111111111",
            &uuid::Uuid::new_v4().to_string(),
            &uuid::Uuid::new_v4().to_string(),
            "device",
        )
        .unwrap();
        let account = metadata_account(&owner, &reference).unwrap();
        assert!(DesktopCustodyMetadataStore
            .read(&account)
            .unwrap()
            .is_none());
        custody.write_metadata(&metadata).unwrap();
        let raw = DesktopCustodyMetadataStore.read(&account).unwrap().unwrap();
        assert!(NativeDeviceCustodyMetadata::parse(&raw).unwrap() == metadata);
        custody.delete_metadata(&reference).unwrap();
        assert!(DesktopCustodyMetadataStore
            .read(&account)
            .unwrap()
            .is_none());
    }
}

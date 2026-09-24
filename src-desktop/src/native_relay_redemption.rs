//! Host-owned native broker invitation redemption and v2 grant custody.
//!
//! This service is intentionally crate-private and has no Tauri command. Its
//! authority provider must supply the current owner-only profile snapshot and
//! an independently approved Station signing-key record. That provider does
//! not exist in the native shell yet; this module keeps that missing boundary
//! explicit instead of accepting renderer-created trust or signing input.

use crate::native_relay_proof_key::{
    NativeBrokerRedemptionChallenge, NativeBrokerRedemptionInvitation, NativeProofKeyChannel,
    NativeProofKeyOwner, NativeProofKeyPublicMetadata, NativeRelayProofKeyVault, P256PublicJwk,
    ProofKeyError,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ring::digest::{digest, SHA256};
#[cfg(test)]
use ring::signature;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::collections::HashMap;
use std::io::Read;
#[cfg(test)]
use std::io::Write;
#[cfg(test)]
use std::net::TcpListener;
use std::net::{Ipv4Addr, Ipv6Addr};
#[cfg(test)]
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use zeroize::Zeroizing;

const REDEEM_PATH: &str = "/broker/v1/native/grants/redeem";
const RETIRE_PATH: &str = "/broker/v1/native/grants/retire";
const NATIVE_INVITATION_VERSION: &str = "station-broker-native-route-invitation/v2";
const NATIVE_GRANT_VERSION: &str = "station-broker-native-client-grant/v2";
const NATIVE_RETIRE_VERSION: &str = "station-broker-native-grant-retire/v2";
const MAX_INVITATION_AGE_MS: u64 = 5 * 60 * 1000;
const MAX_GRANT_AGE_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_GRANT_INDEX_ENTRIES: usize = 10_000;
const GRANT_ACCOUNT_PREFIX: &str = "relay-native-client-grant:v2:";
const GRANT_INDEX_PREFIX: &str = "relay-native-client-grant:index:v2:";
const BROKER_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const JS_SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;
static NATIVE_GRANT_VAULT_LOCK: Mutex<()> = Mutex::new(());

type RedemptionResult<T> = Result<T, NativeRedemptionError>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NativeRedemptionError {
    InvalidProfile,
    StaleProfile,
    StationTrustRequired,
    InvitationInvalid,
    InvitationExpired,
    ProofKey,
    BrokerTransport,
    BrokerRejected,
    GrantInvalid,
    GrantStore,
    GrantMissing,
    GrantExists,
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

/// Typed invitation from the share surface. Its secret uses zeroizing memory;
/// broker origin and all identity fields are checked against host state before
/// any request is sent.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeRelayInvitationV2 {
    version: String,
    broker_origin: String,
    scope: NativeRelayScopeV2,
    station_signing_key_id: String,
    station_signing_generation: u64,
    surface: NativeRelayClientSurfaceV2,
    invitation_id: String,
    invitation_secret: SecretText,
    expires_at: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeRelayScopeV2 {
    station_id: String,
    enrollment_id: String,
    routing_generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeRelayClientSurfaceV2 {
    kind: String,
    app_identifier: String,
    channel: String,
    client_instance_id: String,
    key_thumbprint: String,
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StoredNativeRelayGrantV2 {
    schema_version: u8,
    binding: NativeRelayGrantBinding,
    grant: NativeRelayClientGrantV2,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredNativeRelayGrantV2Ref<'a> {
    schema_version: u8,
    binding: NativeRelayGrantBinding,
    grant: &'a NativeRelayClientGrantV2,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeRelayGrantMetadata {
    pub(crate) route: NativeRelayGrantRoute,
    pub(crate) station_signing_key_id: String,
    pub(crate) station_signing_generation: u64,
    pub(crate) expires_at: u64,
}

pub(crate) trait NativeGrantBackend: Send {
    fn get(&mut self, account: &str) -> RedemptionResult<Option<Zeroizing<String>>>;
    fn set(&mut self, account: &str, value: &str) -> RedemptionResult<()>;
    fn delete(&mut self, account: &str) -> RedemptionResult<()>;
}

pub(crate) trait NativeGrantCustody: Send + Sync {
    fn store(
        &self,
        owner: &NativeProofKeyOwner,
        grant: &NativeRelayClientGrantV2,
        now: u64,
    ) -> RedemptionResult<NativeRelayGrantMetadata>;
    fn revoke(
        &self,
        owner: &NativeProofKeyOwner,
        route: &NativeRelayGrantRoute,
    ) -> RedemptionResult<()>;
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

    fn store(
        &self,
        owner: &NativeProofKeyOwner,
        grant: &NativeRelayClientGrantV2,
        now: u64,
    ) -> RedemptionResult<NativeRelayGrantMetadata> {
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
            route,
        };
        let account = native_grant_account(&binding)?;
        if backend.get(&account)?.is_some() {
            return Err(NativeRedemptionError::GrantExists);
        }
        let payload = StoredNativeRelayGrantV2Ref {
            schema_version: 1,
            binding: binding.clone(),
            grant,
        };
        let encoded = Zeroizing::new(
            serde_json::to_string(&payload).map_err(|_| NativeRedemptionError::GrantInvalid)?,
        );
        // Publish the secret-free recovery index first. If keyring storage
        // fails after partially committing the payload, the binding remains
        // visible for cleanup instead of stranding an undiscoverable secret.
        add_native_grant_index(&mut *backend, &binding)?;
        if backend.set(&account, &encoded).is_err() {
            match backend.get(&account) {
                Ok(None) => {
                    let _ = remove_native_grant_index(&mut *backend, &binding);
                }
                // Either the write committed before surfacing its error or the
                // backend cannot establish that it did not. Keep the safe
                // metadata pointer so a later explicit revoke can find it.
                Ok(Some(_)) | Err(_) => {}
            }
            return Err(NativeRedemptionError::GrantStore);
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

    fn revoke(
        &self,
        owner: &NativeProofKeyOwner,
        route: &NativeRelayGrantRoute,
    ) -> RedemptionResult<()> {
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
        backend.delete(&account)?;
        remove_native_grant_index(&mut *backend, &binding)
    }
}

impl<B: NativeGrantBackend> NativeGrantCustody for NativeRelayGrantVault<B> {
    fn store(
        &self,
        owner: &NativeProofKeyOwner,
        grant: &NativeRelayClientGrantV2,
        now: u64,
    ) -> RedemptionResult<NativeRelayGrantMetadata> {
        NativeRelayGrantVault::store(self, owner, grant, now)
    }

    fn revoke(
        &self,
        owner: &NativeProofKeyOwner,
        route: &NativeRelayGrantRoute,
    ) -> RedemptionResult<()> {
        NativeRelayGrantVault::revoke(self, owner, route)
    }
}

pub(crate) struct OsNativeGrantBackend;

impl NativeGrantBackend for OsNativeGrantBackend {
    fn get(&mut self, account: &str) -> RedemptionResult<Option<Zeroizing<String>>> {
        super::initialize_credential_store().map_err(|_| NativeRedemptionError::GrantStore)?;
        let entry = keyring_core::Entry::new(super::STATION_CREDENTIAL_SERVICE, account)
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(_) => Err(NativeRedemptionError::GrantStore),
        }
    }

    fn set(&mut self, account: &str, value: &str) -> RedemptionResult<()> {
        super::initialize_credential_store().map_err(|_| NativeRedemptionError::GrantStore)?;
        let entry = keyring_core::Entry::new(super::STATION_CREDENTIAL_SERVICE, account)
            .map_err(|_| NativeRedemptionError::GrantStore)?;
        entry
            .set_password(value)
            .map_err(|_| NativeRedemptionError::GrantStore)
    }

    fn delete(&mut self, account: &str) -> RedemptionResult<()> {
        super::initialize_credential_store().map_err(|_| NativeRedemptionError::GrantStore)?;
        let entry = keyring_core::Entry::new(super::STATION_CREDENTIAL_SERVICE, account)
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

pub(crate) trait NativeProofKeyOperations: Send + Sync {
    fn restore(
        &self,
        owner: &NativeProofKeyOwner,
    ) -> Result<NativeProofKeyPublicMetadata, ProofKeyError>;
    fn create(
        &self,
        owner: &NativeProofKeyOwner,
    ) -> Result<NativeProofKeyPublicMetadata, ProofKeyError>;
    fn sign(
        &self,
        owner: &NativeProofKeyOwner,
        challenge: &NativeBrokerRedemptionChallenge,
    ) -> Result<Vec<u8>, ProofKeyError>;
}

impl NativeProofKeyOperations for NativeRelayProofKeyVault {
    fn restore(
        &self,
        owner: &NativeProofKeyOwner,
    ) -> Result<NativeProofKeyPublicMetadata, ProofKeyError> {
        NativeRelayProofKeyVault::restore(self, owner)
    }
    fn create(
        &self,
        owner: &NativeProofKeyOwner,
    ) -> Result<NativeProofKeyPublicMetadata, ProofKeyError> {
        NativeRelayProofKeyVault::create(self, owner)
    }
    fn sign(
        &self,
        owner: &NativeProofKeyOwner,
        challenge: &NativeBrokerRedemptionChallenge,
    ) -> Result<Vec<u8>, ProofKeyError> {
        NativeRelayProofKeyVault::sign_es256_p1363(self, owner, challenge)
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
    fn create(
        &self,
        owner: &NativeProofKeyOwner,
    ) -> Result<NativeProofKeyPublicMetadata, ProofKeyError> {
        crate::native_relay_proof_key::MemoryNativeRelayProofKeyVault::create(self, owner)
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
}

pub(crate) trait NativeBrokerTransport: Send + Sync {
    fn redeem(&self, broker_origin: &str, request_body: &[u8]) -> RedemptionResult<BrokerResponse>;
    fn retire_own_grant(&self, grant: &NativeRelayClientGrantV2) -> RedemptionResult<()>;
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

    fn retire_own_grant(&self, grant: &NativeRelayClientGrantV2) -> RedemptionResult<()> {
        if !canonical_broker_origin(&grant.broker_origin)
            || !valid_opaque(grant.credential.secret.expose())
            || !valid_grant_id(&grant.credential.id)
        {
            return Err(NativeRedemptionError::GrantInvalid);
        }
        let base = url::Url::parse(&grant.broker_origin)
            .map_err(|_| NativeRedemptionError::GrantInvalid)?;
        let target = base
            .join(RETIRE_PATH)
            .map_err(|_| NativeRedemptionError::GrantInvalid)?;
        if target.origin().ascii_serialization() != grant.broker_origin
            || target.path() != RETIRE_PATH
        {
            return Err(NativeRedemptionError::GrantInvalid);
        }
        let body = Zeroizing::new(
            serde_json::to_vec(&NativeGrantRetireRequest {
                version: NATIVE_RETIRE_VERSION,
                scope: grant.scope.clone(),
                surface: grant.surface.clone(),
            })
            .map_err(|_| NativeRedemptionError::GrantInvalid)?,
        );
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
            .header("Content-Type", "application/json")
            .send(&body[..])
            .map_err(|_| NativeRedemptionError::BrokerTransport)?;
        if response.status().as_u16() != 200 {
            return Err(NativeRedemptionError::BrokerRejected);
        }
        let mut response_body = Zeroizing::new(Vec::new());
        let mut reader = response.body_mut().as_reader();
        let mut chunk = Zeroizing::new([0_u8; 256]);
        loop {
            let read = reader
                .read(&mut chunk[..])
                .map_err(|_| NativeRedemptionError::BrokerTransport)?;
            if read == 0 {
                break;
            }
            if response_body.len().saturating_add(read) > 4096 {
                return Err(NativeRedemptionError::BrokerTransport);
            }
            response_body.extend_from_slice(&chunk[..read]);
        }
        let receipt: NativeGrantRetireReceipt = serde_json::from_slice(&response_body)
            .map_err(|_| NativeRedemptionError::BrokerRejected)?;
        if receipt.version != NATIVE_RETIRE_VERSION || !receipt.retired {
            return Err(NativeRedemptionError::BrokerRejected);
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeGrantRetireRequest {
    version: &'static str,
    scope: NativeRelayScopeV2,
    surface: NativeRelayClientSurfaceV2,
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

fn validate_invitation_and_trust(
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
        || invitation.expires_at > now.saturating_add(MAX_INVITATION_AGE_MS)
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
    let route = NativeRelayGrantRoute {
        broker_origin: grant.broker_origin.clone(),
        station_id: grant.scope.station_id.clone(),
        enrollment_id: grant.scope.enrollment_id.clone(),
        routing_generation: grant.scope.routing_generation,
        grant_id: grant.credential.id.clone(),
    };
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
    use std::sync::atomic::{AtomicBool, Ordering};

    const NOW: u64 = 1_700_000_000_000;
    const STATION_ID: &str = "11111111-1111-4111-8111-111111111111";
    const ENROLLMENT_ID: &str = "22222222-2222-4222-8222-222222222222";
    const INSTANCE_ID: &str = "33333333-3333-4333-8333-333333333333";

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

        fn retire_own_grant(&self, _: &NativeRelayClientGrantV2) -> RedemptionResult<()> {
            Err(NativeRedemptionError::BrokerTransport)
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
            write!(
                socket,
                "HTTP/1.1 {status} {text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            socket.write_all(&body).unwrap();
            request
        });
        (origin, thread)
    }

    fn service<'a, H: NativeBrokerTransport>(
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
        authority.revoke(&prepared.owner, &metadata.route).unwrap();
        assert!(authority
            .metadata(&prepared.owner, &metadata.route, NOW)
            .unwrap()
            .is_none());
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
        let grants = NativeRelayGrantVault::new(MemoryNativeGrantBackend::default());
        let service = service(
            &prepared.authority,
            &prepared.proof_keys,
            &transport,
            &grants,
        );
        assert_eq!(
            service.redeem("Local", 7, prepared.invitation).unwrap_err(),
            NativeRedemptionError::StaleProfile
        );
        let (redeem_request, retire_request) = server.join().unwrap();
        assert!(String::from_utf8_lossy(&redeem_request)
            .starts_with("POST /broker/v1/native/grants/redeem "));
        assert!(String::from_utf8_lossy(&retire_request)
            .starts_with("POST /broker/v1/native/grants/retire "));
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
            std::thread::sleep(Duration::from_millis(250));
            (200, b"{}".to_vec())
        });
        let short = UreqNativeBrokerTransport::with_timeout(Duration::from_millis(50));
        assert!(matches!(
            short.redeem(&origin, b"{}"),
            Err(NativeRedemptionError::BrokerTransport)
        ));
        slow_server.join().unwrap();
    }

    #[test]
    fn grant_keyring_index_rolls_back_failed_secret_write_and_explicit_revoke_removes_secret() {
        let prepared = prepared("https://broker.example".to_owned(), 7);
        let mut backend = MemoryNativeGrantBackend::default();
        backend.fail_set_number = Some(2);
        let vault = NativeRelayGrantVault::new(backend);
        let grant = sample_grant(&prepared, NOW + 3_600_000);
        assert_eq!(
            vault.store(&prepared.owner, &grant, NOW).unwrap_err(),
            NativeRedemptionError::GrantStore
        );
        let backend = vault.backend.lock().unwrap();
        assert!(backend
            .values
            .values()
            .all(|value| !value.contains(&"S".repeat(43))));
        assert!(backend
            .values
            .iter()
            .filter(|(account, _)| account.starts_with(GRANT_INDEX_PREFIX))
            .all(|(_, value)| value == "[]"));
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
            let mut backend = vault.backend.lock().unwrap();
            let encoded = backend.values.get_mut(&account).unwrap();
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
}

#[cfg(test)]
#[derive(Default)]
struct MemoryNativeGrantBackend {
    values: HashMap<String, String>,
    fail_set_number: Option<usize>,
    sets: usize,
}

#[cfg(test)]
impl NativeGrantBackend for MemoryNativeGrantBackend {
    fn get(&mut self, account: &str) -> RedemptionResult<Option<Zeroizing<String>>> {
        Ok(self
            .values
            .get(account)
            .map(|value| Zeroizing::new(value.clone())))
    }
    fn set(&mut self, account: &str, value: &str) -> RedemptionResult<()> {
        self.sets += 1;
        if self.fail_set_number == Some(self.sets) {
            return Err(NativeRedemptionError::GrantStore);
        }
        self.values.insert(account.to_owned(), value.to_owned());
        Ok(())
    }
    fn delete(&mut self, account: &str) -> RedemptionResult<()> {
        self.values.remove(account);
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

impl<'a, P, K, H, G, C> NativeRelayRedemptionService<'a, P, K, H, G, C>
where
    P: NativeRedemptionContextProvider,
    K: NativeProofKeyOperations,
    H: NativeBrokerTransport,
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

    pub(crate) fn redeem(
        &self,
        profile_name: &str,
        expected_profile_revision: u64,
        invitation: NativeRelayInvitationV2,
    ) -> RedemptionResult<NativeRelayGrantMetadata> {
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
        let public = match self.proof_keys.restore(&owner) {
            Ok(public) => public,
            Err(ProofKeyError::Missing) => self
                .proof_keys
                .create(&owner)
                .map_err(|_| NativeRedemptionError::ProofKey)?,
            Err(_) => return Err(NativeRedemptionError::ProofKey),
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
            return Err(NativeRedemptionError::InvitationInvalid);
        }
        self.context_provider
            .with_current_context(profile_name, |current| {
                if current != before || current.profile.revision != expected_profile_revision {
                    return Err(NativeRedemptionError::StaleProfile);
                }
                validate_profile_context(&current)?;
                validate_invitation_and_trust(&current, &invitation, (self.now)(), Some(&public))
            })?;
        let response = self
            .http
            .redeem(&before.profile.broker_origin, &request_body)?;
        if response.status != 200 {
            return Err(NativeRedemptionError::BrokerRejected);
        }
        let grant: NativeRelayClientGrantV2 = serde_json::from_slice(&response.body)
            .map_err(|_| NativeRedemptionError::GrantInvalid)?;
        let now = (self.now)();
        let route = validate_returned_grant(&before, &invitation, &public, &grant, now)?;
        let commit_result = self
            .context_provider
            .with_current_context(profile_name, |current| {
                if current != before || current.profile.revision != expected_profile_revision {
                    return Err(NativeRedemptionError::StaleProfile);
                }
                validate_profile_context(&current)?;
                validate_invitation_and_trust(&current, &invitation, now, Some(&public))?;
                let metadata = self.grants.store(&owner, &grant, now)?;
                if metadata.route != route {
                    let _ = self.grants.revoke(&owner, &metadata.route);
                    return Err(NativeRedemptionError::GrantInvalid);
                }
                Ok(metadata)
            });
        if let Err(error) = &commit_result {
            // Exact self-retire targets only the just-issued grant. The route
            // is fixed by the broker contract and the grant secret never
            // reaches the renderer. Retirement is best effort; expiry remains
            // the server's bound if transport/storage fails again.
            let _ = self.http.retire_own_grant(&grant);
            return Err(*error);
        }
        commit_result
    }
}

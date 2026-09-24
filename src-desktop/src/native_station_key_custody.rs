//! Native verification primitives for Station connection-key candidates.
//!
//! A candidate is an untrusted courier value. This module verifies the exact
//! compact JWS bytes, its self-signature, challenge, route, key identifier,
//! generation descriptor, expiry, and short authentication string. A verified
//! candidate proves possession of the advertised key only. Durable approval
//! requires separate operator inputs and a host-locked profile/trust revision
//! CAS; no command or active connection route uses this module yet.

#![allow(dead_code)] // Native host integration is a separate step; no IPC surface is registered here.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ring::agreement::{
    agree_ephemeral, EphemeralPrivateKey, UnparsedPublicKey as AgreementUnparsedPublicKey,
    ECDH_P256,
};
use ring::digest::{digest, SHA256};
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{self, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;
use zeroize::Zeroizing;

const MAX_CANDIDATE_BYTES: usize = 8192;
const CANDIDATE_LIFETIME_SECONDS: u64 = 60;
const CODE_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const JS_SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;
const TRUST_RECORD_SCHEMA_VERSION: u8 = 1;
const TRUST_KEYRING_SERVICE: &str = "io.kontourai.station.connection-trust";
const TRUST_KEYRING_ACCOUNT_PREFIX: &str = "station-connection-trust:v1:";
const MAX_APPROVED_ROUTE_BINDINGS: usize = 1024;
const HEADER: &[u8] = br#"{"alg":"ES256","typ":"station-connection-key-candidate+jws"}"#;
static STATION_TRUST_OPERATION: Mutex<()> = Mutex::new(());

pub(crate) trait StationTrustClock: Send + Sync {
    fn now_seconds(&self) -> CandidateResult<u64>;
}

pub(crate) struct SystemStationTrustClock;

impl StationTrustClock for SystemStationTrustClock {
    fn now_seconds(&self) -> CandidateResult<u64> {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .map_err(|_| CandidateError::Stale)
    }
}

#[cfg(test)]
struct TestStationTrustClock(std::sync::atomic::AtomicU64);

#[cfg(test)]
impl TestStationTrustClock {
    fn new(seconds: u64) -> Self {
        Self(std::sync::atomic::AtomicU64::new(seconds))
    }

    fn set(&self, seconds: u64) {
        self.0.store(seconds, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(test)]
impl StationTrustClock for TestStationTrustClock {
    fn now_seconds(&self) -> CandidateResult<u64> {
        Ok(self.0.load(std::sync::atomic::Ordering::SeqCst))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CandidateError {
    Invalid,
    Stale,
    BindingMismatch,
    OperatorConfirmationMismatch,
    ProfileStale,
    TrustRevisionConflict,
    GenerationRollback,
    TrustStore,
}

pub(crate) type CandidateResult<T> = Result<T, CandidateError>;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct TrustProfileBinding {
    pub(crate) profile_owner_id: String,
    pub(crate) app_identifier: String,
    pub(crate) channel: String,
    pub(crate) client_instance_id: String,
    pub(crate) broker_origin: String,
    pub(crate) station_id: String,
    pub(crate) enrollment_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LockedTrustProfileSnapshot {
    pub(crate) binding: TrustProfileBinding,
    pub(crate) revision: u64,
}

/// Implementations must hold the same interprocess profile lock used by the
/// profile writer until `operation` returns, and construct the snapshot from
/// the current host-owned profile while that lock remains held.
pub(crate) trait LockedTrustProfileProvider {
    fn with_current_profile<T, F>(
        &self,
        expected_binding: &TrustProfileBinding,
        expected_profile_revision: u64,
        operation: F,
    ) -> CandidateResult<T>
    where
        F: FnOnce(LockedTrustProfileSnapshot) -> CandidateResult<T>;
}

/// Host snapshot captured when the broker challenge is issued. `profile_owner_id`
/// is the exact saved profile name (the current profile schema has no UUID);
/// the app/channel/client and route tuple keep that label from being a sole key.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CandidateBinding {
    pub(crate) profile_owner_id: String,
    pub(crate) app_identifier: String,
    pub(crate) channel: String,
    pub(crate) profile_revision: u64,
    pub(crate) expected_trust_revision: u64,
    pub(crate) broker_origin: String,
    pub(crate) station_id: String,
    pub(crate) enrollment_id: String,
    pub(crate) client_instance_id: String,
    pub(crate) client_key_thumbprint: String,
    /// Key advertised by the selected invitation; broker metadata alone is
    /// not trusted, but the candidate must agree with this host-captured pin.
    pub(crate) expected_station_signing_key_id: String,
    pub(crate) expected_station_signing_generation: u64,
}

/// A challenge tied to one enrollment attempt and its host-owned route snapshot.
/// The owner must consume it once it adds durable pending-challenge custody.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PendingStationKeyChallenge {
    binding: CandidateBinding,
    challenge: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct SigningKey {
    kty: String,
    crv: String,
    x: String,
    y: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct Descriptor {
    #[serde(rename = "stationId")]
    station_id: String,
    #[serde(rename = "enrollmentId")]
    enrollment_id: String,
    generation: u64,
    #[serde(rename = "signingKey")]
    signing_key: SigningKey,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct Claims {
    aud: String,
    #[serde(rename = "brokerOrigin")]
    broker_origin: String,
    challenge: String,
    #[serde(rename = "clientInstanceId")]
    client_instance_id: String,
    #[serde(rename = "clientKeyThumbprint")]
    client_key_thumbprint: String,
    #[serde(rename = "confirmationCode")]
    confirmation_code: String,
    exp: u64,
    iat: u64,
    #[serde(rename = "keyId")]
    key_id: String,
    purpose: String,
    candidate: Descriptor,
    version: String,
}

/// Claims become available to native presentation code only after validation.
/// This type is not serializable and cannot be mistaken for approved trust.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct VerifiedStationKeyCandidate {
    claims: Claims,
    challenge: String,
    profile_binding: TrustProfileBinding,
    profile_revision: u64,
    expected_trust_revision: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct OperatorConfirmationOnlyNonDurable {
    candidate: VerifiedStationKeyCandidate,
}

impl PendingStationKeyChallenge {
    pub(crate) fn begin(binding: CandidateBinding) -> CandidateResult<Self> {
        validate_binding(&binding)?;
        let mut nonce = [0u8; 32];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| CandidateError::Invalid)?;
        Ok(Self {
            binding,
            challenge: URL_SAFE_NO_PAD.encode(nonce),
        })
    }

    /// Test-only constructor for deterministic adversarial fixtures.
    #[cfg(test)]
    fn with_challenge(binding: CandidateBinding, challenge: String) -> CandidateResult<Self> {
        validate_binding(&binding)?;
        if !valid_digest(&challenge) {
            return Err(CandidateError::Invalid);
        }
        Ok(Self { binding, challenge })
    }

    pub(crate) fn challenge(&self) -> &str {
        &self.challenge
    }

    pub(crate) fn verify(
        &self,
        compact_jws: &str,
        now: u64,
    ) -> CandidateResult<VerifiedStationKeyCandidate> {
        if compact_jws.len() > MAX_CANDIDATE_BYTES || !compact_jws.is_ascii() {
            return Err(CandidateError::Invalid);
        }
        let mut parts = compact_jws.split('.');
        let (Some(protected), Some(payload), Some(signature), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(CandidateError::Invalid);
        };
        let protected_bytes = decode_canonical(protected)?;
        if protected_bytes != HEADER {
            return Err(CandidateError::Invalid);
        }
        let payload_bytes = decode_canonical(payload)?;
        let signature_bytes = decode_canonical(signature)?;
        let claims: Claims =
            serde_json::from_slice(&payload_bytes).map_err(|_| CandidateError::Invalid)?;
        validate_claims(&claims)?;
        let canonical_payload = serde_json::to_vec(&claims).map_err(|_| CandidateError::Invalid)?;
        if canonical_payload != payload_bytes {
            return Err(CandidateError::Invalid);
        }

        let point = p256_point(&claims.candidate.signing_key)?;
        let signing_input = format!("{protected}.{payload}");
        UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, point)
            .verify(signing_input.as_bytes(), &signature_bytes)
            .map_err(|_| CandidateError::Invalid)?;

        if claims.broker_origin != self.binding.broker_origin
            || claims.challenge != self.challenge
            || claims.client_instance_id != self.binding.client_instance_id
            || claims.client_key_thumbprint != self.binding.client_key_thumbprint
            || claims.candidate.station_id != self.binding.station_id
            || claims.candidate.enrollment_id != self.binding.enrollment_id
            || claims.key_id != self.binding.expected_station_signing_key_id
            || claims.candidate.generation != self.binding.expected_station_signing_generation
        {
            return Err(CandidateError::BindingMismatch);
        }
        ensure_candidate_fresh(&claims, now)?;
        let key_id = signing_key_id(&claims.candidate.signing_key)?;
        let confirmation = confirmation_code(&claims.candidate)?;
        if claims.key_id != key_id || claims.confirmation_code != confirmation {
            return Err(CandidateError::Invalid);
        }
        Ok(VerifiedStationKeyCandidate {
            claims,
            challenge: self.challenge.clone(),
            profile_binding: profile_binding(&self.binding),
            profile_revision: self.binding.profile_revision,
            expected_trust_revision: self.binding.expected_trust_revision,
        })
    }
}

impl VerifiedStationKeyCandidate {
    pub(crate) fn station_id(&self) -> &str {
        &self.claims.candidate.station_id
    }
    pub(crate) fn enrollment_id(&self) -> &str {
        &self.claims.candidate.enrollment_id
    }
    pub(crate) fn generation(&self) -> u64 {
        self.claims.candidate.generation
    }
    pub(crate) fn key_id(&self) -> &str {
        &self.claims.key_id
    }
    pub(crate) fn confirmation_code(&self) -> &str {
        &self.claims.confirmation_code
    }
    pub(crate) fn expires_at(&self) -> u64 {
        self.claims.exp
    }
    pub(crate) fn profile_owner_id(&self) -> &str {
        &self.profile_binding.profile_owner_id
    }
    pub(crate) fn profile_binding(&self) -> &TrustProfileBinding {
        &self.profile_binding
    }
    pub(crate) fn profile_revision(&self) -> u64 {
        self.profile_revision
    }
    pub(crate) fn expected_trust_revision(&self) -> u64 {
        self.expected_trust_revision
    }
    pub(crate) fn challenge(&self) -> &str {
        &self.challenge
    }

    /// Checks both operator-entered values against the verified candidate.
    /// Returning this marker is not durable approval; the host must still
    /// perform a profile/trust revision CAS in its authoritative store.
    fn confirm_operator(
        self,
        supplied_code: &str,
        supplied_full_key_id: &str,
    ) -> CandidateResult<OperatorConfirmationOnlyNonDurable> {
        if supplied_code != self.claims.confirmation_code
            || supplied_full_key_id != self.claims.key_id
        {
            return Err(CandidateError::OperatorConfirmationMismatch);
        }
        Ok(OperatorConfirmationOnlyNonDurable { candidate: self })
    }
}

fn validate_binding(binding: &CandidateBinding) -> CandidateResult<()> {
    if binding.profile_owner_id.is_empty()
        || binding.profile_owner_id.len() > 256
        || binding.profile_revision == 0
        || binding.profile_revision > JS_SAFE_INTEGER_MAX
        || binding.expected_trust_revision > JS_SAFE_INTEGER_MAX
        || !valid_app_identifier(&binding.app_identifier)
        || !matches!(
            binding.channel.as_str(),
            "dev" | "stable" | "beta" | "nightly"
        )
        || canonical_broker_origin(&binding.broker_origin).is_err()
        || !valid_uuid(&binding.station_id)
        || !valid_uuid(&binding.enrollment_id)
        || !valid_uuid(&binding.client_instance_id)
        || !valid_digest(&binding.client_key_thumbprint)
        || !valid_digest(&binding.expected_station_signing_key_id)
        || binding.expected_station_signing_generation == 0
        || binding.expected_station_signing_generation > JS_SAFE_INTEGER_MAX
    {
        return Err(CandidateError::Invalid);
    }
    Ok(())
}

fn validate_claims(claims: &Claims) -> CandidateResult<()> {
    if claims.version != "station-connection-key-candidate/v1"
        || claims.aud != "urn:station:connection-key-candidate:v1"
        || claims.purpose != "advertise-station-connection-key"
        || canonical_broker_origin(&claims.broker_origin).is_err()
        || !valid_digest(&claims.challenge)
        || !valid_uuid(&claims.client_instance_id)
        || !valid_digest(&claims.client_key_thumbprint)
        || !valid_confirmation_code(&claims.confirmation_code)
        || !valid_digest(&claims.key_id)
        || !valid_uuid(&claims.candidate.station_id)
        || !valid_uuid(&claims.candidate.enrollment_id)
        || claims.candidate.generation == 0
        || claims.candidate.generation > JS_SAFE_INTEGER_MAX
        || claims.iat > JS_SAFE_INTEGER_MAX
        || claims.exp > JS_SAFE_INTEGER_MAX
        || claims.candidate.signing_key.kty != "EC"
        || claims.candidate.signing_key.crv != "P-256"
        || !valid_digest(&claims.candidate.signing_key.x)
        || !valid_digest(&claims.candidate.signing_key.y)
    {
        return Err(CandidateError::Invalid);
    }
    Ok(())
}

fn ensure_candidate_fresh(claims: &Claims, now: u64) -> CandidateResult<()> {
    if now > JS_SAFE_INTEGER_MAX
        || claims.exp <= now
        || claims.iat > now.saturating_add(5)
        || claims.iat < now.saturating_sub(CANDIDATE_LIFETIME_SECONDS)
        || claims.exp <= claims.iat
        || claims.exp - claims.iat > CANDIDATE_LIFETIME_SECONDS
    {
        return Err(CandidateError::Stale);
    }
    Ok(())
}

fn profile_binding(binding: &CandidateBinding) -> TrustProfileBinding {
    TrustProfileBinding {
        profile_owner_id: binding.profile_owner_id.clone(),
        app_identifier: binding.app_identifier.clone(),
        channel: binding.channel.clone(),
        client_instance_id: binding.client_instance_id.clone(),
        broker_origin: binding.broker_origin.clone(),
        station_id: binding.station_id.clone(),
        enrollment_id: binding.enrollment_id.clone(),
    }
}

fn valid_app_identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && value.len() <= 255
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum StationTrustStatus {
    Approved,
    Revoked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GenerationFloor {
    station_id: String,
    generation: u64,
    key_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StoredStationTrust {
    schema_version: u8,
    revision: u64,
    station_id: String,
    status: Option<StationTrustStatus>,
    trust: Option<Descriptor>,
    generation_floor: Option<GenerationFloor>,
    approved_bindings: Vec<TrustProfileBinding>,
}

/// Safe-to-display mutation receipt. It contains no secrets or approval input.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StationTrustMutationReceipt {
    pub(crate) revision: u64,
    pub(crate) status: StationTrustStatus,
    pub(crate) station_id: String,
    pub(crate) enrollment_id: String,
    pub(crate) generation: u64,
    pub(crate) key_id: String,
}

/// Secret-free durable state suitable for renderer display.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StationTrustPublicState {
    pub(crate) revision: u64,
    pub(crate) status: Option<StationTrustStatus>,
    pub(crate) station_id: String,
    pub(crate) enrollment_id: Option<String>,
    pub(crate) generation: Option<u64>,
    pub(crate) key_id: Option<String>,
}

pub(crate) trait StationTrustBackend: Send {
    fn read(&mut self, account: &str) -> CandidateResult<Option<Zeroizing<String>>>;
    fn write(&mut self, account: &str, value: &str) -> CandidateResult<()>;
}

/// OS-keyring-backed public trust state. Lock order is always the shared
/// `profiles.json.lock` supplied by `LockedTrustProfileProvider`, then
/// `STATION_TRUST_OPERATION`, then the OS keyring call. This module never calls
/// back into the profile writer while holding its trust mutex.
pub(crate) struct NativeStationTrustStore<
    B: StationTrustBackend,
    C: StationTrustClock = SystemStationTrustClock,
> {
    backend: B,
    clock: C,
}

pub(crate) struct OsStationTrustBackend;

impl StationTrustBackend for OsStationTrustBackend {
    fn read(&mut self, account: &str) -> CandidateResult<Option<Zeroizing<String>>> {
        super::initialize_credential_store().map_err(|_| CandidateError::TrustStore)?;
        let entry = keyring_core::Entry::new(TRUST_KEYRING_SERVICE, account)
            .map_err(|_| CandidateError::TrustStore)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(_) => Err(CandidateError::TrustStore),
        }
    }

    fn write(&mut self, account: &str, value: &str) -> CandidateResult<()> {
        super::initialize_credential_store().map_err(|_| CandidateError::TrustStore)?;
        let entry = keyring_core::Entry::new(TRUST_KEYRING_SERVICE, account)
            .map_err(|_| CandidateError::TrustStore)?;
        entry
            .set_password(value)
            .map_err(|_| CandidateError::TrustStore)
    }
}

impl NativeStationTrustStore<OsStationTrustBackend, SystemStationTrustClock> {
    pub(crate) fn system() -> Self {
        Self {
            backend: OsStationTrustBackend,
            clock: SystemStationTrustClock,
        }
    }
}

#[cfg(test)]
const TEST_TRUST_NOW: u64 = 1_700_000_000;

#[cfg(test)]
impl<B: StationTrustBackend> NativeStationTrustStore<B, TestStationTrustClock> {
    fn with_backend(backend: B) -> Self {
        Self {
            backend,
            clock: TestStationTrustClock::new(TEST_TRUST_NOW),
        }
    }

    fn with_backend_and_clock(backend: B, clock: TestStationTrustClock) -> Self {
        Self { backend, clock }
    }
}

impl<B: StationTrustBackend, C: StationTrustClock> NativeStationTrustStore<B, C> {
    pub(crate) fn current_state<P: LockedTrustProfileProvider>(
        &mut self,
        provider: &P,
        binding: &TrustProfileBinding,
        profile_revision: u64,
    ) -> CandidateResult<StationTrustPublicState> {
        provider.with_current_profile(binding, profile_revision, |snapshot| {
            if snapshot.binding != *binding || snapshot.revision != profile_revision {
                return Err(CandidateError::ProfileStale);
            }
            let _guard = STATION_TRUST_OPERATION
                .lock()
                .map_err(|_| CandidateError::TrustStore)?;
            let account = trust_account(binding)?;
            let stored = self.read_record(&account, &binding.station_id)?;
            let route_approved = stored.approved_bindings.contains(binding);
            let trust_matches_route = stored
                .trust
                .as_ref()
                .is_some_and(|trust| trust.enrollment_id == binding.enrollment_id);
            let effective_status = stored
                .status
                .filter(|_| route_approved && trust_matches_route);
            let public = if effective_status.is_some() {
                stored
                    .trust
                    .as_ref()
                    .map(|trust| {
                        Ok((
                            trust.enrollment_id.clone(),
                            trust.generation,
                            signing_key_id(&trust.signing_key)?,
                        ))
                    })
                    .transpose()?
            } else {
                None
            };
            if effective_status.is_some() != public.is_some() {
                return Err(CandidateError::TrustStore);
            }
            Ok(StationTrustPublicState {
                revision: stored.revision,
                status: effective_status,
                station_id: binding.station_id.clone(),
                enrollment_id: public
                    .as_ref()
                    .map(|(enrollment_id, _, _)| enrollment_id.clone()),
                generation: public.as_ref().map(|(_, generation, _)| *generation),
                key_id: public.map(|(_, _, key_id)| key_id),
            })
        })
    }

    pub(crate) fn current_revision<P: LockedTrustProfileProvider>(
        &mut self,
        provider: &P,
        binding: &TrustProfileBinding,
        profile_revision: u64,
    ) -> CandidateResult<u64> {
        provider.with_current_profile(binding, profile_revision, |snapshot| {
            if snapshot.binding != *binding || snapshot.revision != profile_revision {
                return Err(CandidateError::ProfileStale);
            }
            let _guard = STATION_TRUST_OPERATION
                .lock()
                .map_err(|_| CandidateError::TrustStore)?;
            let account = trust_account(binding)?;
            Ok(self.read_record(&account, &binding.station_id)?.revision)
        })
    }

    pub(crate) fn approve<P: LockedTrustProfileProvider>(
        &mut self,
        provider: &P,
        candidate: VerifiedStationKeyCandidate,
        operator_code: &str,
        operator_full_key_id: &str,
    ) -> CandidateResult<StationTrustMutationReceipt> {
        let confirmed = candidate.confirm_operator(operator_code, operator_full_key_id)?;
        let candidate = confirmed.candidate;
        let binding = candidate.profile_binding.clone();
        let profile_revision = candidate.profile_revision;
        let expected_store_revision = candidate.expected_trust_revision;
        provider.with_current_profile(&binding, profile_revision, |snapshot| {
            if snapshot.binding != binding || snapshot.revision != profile_revision {
                return Err(CandidateError::ProfileStale);
            }
            let _guard = STATION_TRUST_OPERATION
                .lock()
                .map_err(|_| CandidateError::TrustStore)?;
            ensure_candidate_fresh(&candidate.claims, self.clock.now_seconds()?)?;
            let account = trust_account(&binding)?;
            let mut stored = self.read_record(&account, &binding.station_id)?;
            if stored.revision != expected_store_revision {
                return Err(CandidateError::TrustRevisionConflict);
            }
            apply_generation_floor(
                &mut stored,
                &candidate.claims.candidate,
                &candidate.claims.key_id,
            )?;
            if !stored.approved_bindings.contains(&binding) {
                if stored.approved_bindings.len() >= MAX_APPROVED_ROUTE_BINDINGS {
                    return Err(CandidateError::TrustStore);
                }
                stored.approved_bindings.push(binding.clone());
            }
            stored.revision = stored
                .revision
                .checked_add(1)
                .filter(|revision| *revision <= JS_SAFE_INTEGER_MAX)
                .ok_or(CandidateError::TrustStore)?;
            stored.status = Some(StationTrustStatus::Approved);
            stored.trust = Some(candidate.claims.candidate.clone());
            let receipt = receipt_from(&stored)?;
            // Recheck while both host profile and trust-store locks remain held,
            // immediately before committing the OS-keyring record.
            ensure_candidate_fresh(&candidate.claims, self.clock.now_seconds()?)?;
            self.write_record(&account, &stored)?;
            Ok(receipt)
        })
    }

    pub(crate) fn revoke<P: LockedTrustProfileProvider>(
        &mut self,
        provider: &P,
        binding: &TrustProfileBinding,
        profile_revision: u64,
        expected_store_revision: u64,
        operator_full_key_id: &str,
    ) -> CandidateResult<StationTrustMutationReceipt> {
        provider.with_current_profile(binding, profile_revision, |snapshot| {
            if snapshot.binding != *binding || snapshot.revision != profile_revision {
                return Err(CandidateError::ProfileStale);
            }
            let _guard = STATION_TRUST_OPERATION
                .lock()
                .map_err(|_| CandidateError::TrustStore)?;
            let account = trust_account(binding)?;
            let mut stored = self.read_record(&account, &binding.station_id)?;
            if stored.revision != expected_store_revision {
                return Err(CandidateError::TrustRevisionConflict);
            }
            if stored.status != Some(StationTrustStatus::Approved) {
                return Err(CandidateError::TrustRevisionConflict);
            }
            if !stored.approved_bindings.contains(binding) {
                return Err(CandidateError::ProfileStale);
            }
            let trust = stored.trust.as_ref().ok_or(CandidateError::TrustStore)?;
            if trust.enrollment_id != binding.enrollment_id
                || signing_key_id(&trust.signing_key)? != operator_full_key_id
            {
                return Err(CandidateError::OperatorConfirmationMismatch);
            }
            stored.revision = stored
                .revision
                .checked_add(1)
                .filter(|revision| *revision <= JS_SAFE_INTEGER_MAX)
                .ok_or(CandidateError::TrustStore)?;
            stored.status = Some(StationTrustStatus::Revoked);
            let receipt = receipt_from(&stored)?;
            self.write_record(&account, &stored)?;
            Ok(receipt)
        })
    }

    fn read_record(
        &mut self,
        account: &str,
        station_id: &str,
    ) -> CandidateResult<StoredStationTrust> {
        let Some(encoded) = self.backend.read(account)? else {
            return Ok(StoredStationTrust {
                schema_version: TRUST_RECORD_SCHEMA_VERSION,
                revision: 0,
                station_id: station_id.to_owned(),
                status: None,
                trust: None,
                generation_floor: None,
                approved_bindings: Vec::new(),
            });
        };
        if encoded.len() > 256 * 1024 {
            return Err(CandidateError::TrustStore);
        }
        let stored: StoredStationTrust =
            serde_json::from_str(&encoded).map_err(|_| CandidateError::TrustStore)?;
        validate_stored_record(&stored, station_id)?;
        Ok(stored)
    }

    fn write_record(&mut self, account: &str, stored: &StoredStationTrust) -> CandidateResult<()> {
        let encoded = serde_json::to_string(stored).map_err(|_| CandidateError::TrustStore)?;
        if encoded.len() > 256 * 1024 {
            return Err(CandidateError::TrustStore);
        }
        // A keyring provider may report an ambiguous write result. Never
        // return an approval/revocation receipt unless a fresh read yields the
        // exact complete record. Partial/corrupt data fails closed on parse.
        let _write_result = self.backend.write(account, &encoded);
        let persisted = self
            .backend
            .read(account)?
            .ok_or(CandidateError::TrustStore)?;
        if persisted.len() > 256 * 1024 {
            return Err(CandidateError::TrustStore);
        }
        let decoded: StoredStationTrust =
            serde_json::from_str(&persisted).map_err(|_| CandidateError::TrustStore)?;
        validate_stored_record(&decoded, &stored.station_id)?;
        if decoded != *stored {
            return Err(CandidateError::TrustStore);
        }
        Ok(())
    }
}

fn trust_account(binding: &TrustProfileBinding) -> CandidateResult<String> {
    validate_trust_profile_binding(binding)?;
    // Mutable profile and route identity remains inside the record. It is not
    // part of this Station-level namespace, so rename/re-add cannot erase the
    // revocation tombstone or generation floor.
    let parts = [
        binding.app_identifier.as_str(),
        binding.channel.as_str(),
        binding.station_id.as_str(),
    ];
    let mut canonical = String::from("station-connection-trust-account/v1\0");
    for part in parts {
        if part.len() > 2048 {
            return Err(CandidateError::Invalid);
        }
        canonical.push_str(&part.len().to_string());
        canonical.push(':');
        canonical.push_str(part);
        canonical.push(':');
    }
    let hash = digest(&SHA256, canonical.as_bytes());
    Ok(format!(
        "{TRUST_KEYRING_ACCOUNT_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(hash.as_ref())
    ))
}

fn validate_trust_profile_binding(binding: &TrustProfileBinding) -> CandidateResult<()> {
    if binding.profile_owner_id.is_empty()
        || binding.profile_owner_id.len() > 256
        || !valid_app_identifier(&binding.app_identifier)
        || !matches!(
            binding.channel.as_str(),
            "dev" | "stable" | "beta" | "nightly"
        )
        || !valid_uuid(&binding.client_instance_id)
        || canonical_broker_origin(&binding.broker_origin).is_err()
        || !valid_uuid(&binding.station_id)
        || !valid_uuid(&binding.enrollment_id)
    {
        return Err(CandidateError::Invalid);
    }
    Ok(())
}

fn validate_stored_record(
    stored: &StoredStationTrust,
    expected_station_id: &str,
) -> CandidateResult<()> {
    if stored.schema_version != TRUST_RECORD_SCHEMA_VERSION
        || stored.revision > JS_SAFE_INTEGER_MAX
        || stored.station_id != expected_station_id
        || stored.approved_bindings.len() > MAX_APPROVED_ROUTE_BINDINGS
    {
        return Err(CandidateError::TrustStore);
    }
    match (stored.status, stored.trust.as_ref()) {
        (None, None)
            if stored.revision == 0
                && stored.generation_floor.is_none()
                && stored.approved_bindings.is_empty() => {}
        (Some(_), Some(trust)) if stored.revision > 0 => {
            validate_descriptor(trust)?;
            let floor = stored
                .generation_floor
                .as_ref()
                .ok_or(CandidateError::TrustStore)?;
            if trust.station_id != stored.station_id
                || floor.station_id != stored.station_id
                || floor.generation != trust.generation
                || signing_key_id(&trust.signing_key)? != floor.key_id
                || !stored.approved_bindings.iter().any(|binding| {
                    validate_trust_profile_binding(binding).is_ok()
                        && binding.station_id == stored.station_id
                })
            {
                return Err(CandidateError::TrustStore);
            }
        }
        _ => return Err(CandidateError::TrustStore),
    }
    if let Some(floor) = &stored.generation_floor {
        if !valid_uuid(&floor.station_id)
            || floor.generation == 0
            || floor.generation > JS_SAFE_INTEGER_MAX
            || !valid_digest(&floor.key_id)
        {
            return Err(CandidateError::TrustStore);
        }
    }
    for binding in &stored.approved_bindings {
        validate_trust_profile_binding(binding)?;
        if binding.station_id != stored.station_id {
            return Err(CandidateError::TrustStore);
        }
    }
    Ok(())
}

fn validate_descriptor(descriptor: &Descriptor) -> CandidateResult<()> {
    if !valid_uuid(&descriptor.station_id)
        || !valid_uuid(&descriptor.enrollment_id)
        || descriptor.generation == 0
        || descriptor.generation > JS_SAFE_INTEGER_MAX
        || descriptor.signing_key.kty != "EC"
        || descriptor.signing_key.crv != "P-256"
        || !valid_digest(&descriptor.signing_key.x)
        || !valid_digest(&descriptor.signing_key.y)
    {
        return Err(CandidateError::TrustStore);
    }
    p256_point(&descriptor.signing_key).map_err(|_| CandidateError::TrustStore)?;
    Ok(())
}

fn apply_generation_floor(
    stored: &mut StoredStationTrust,
    descriptor: &Descriptor,
    key_id: &str,
) -> CandidateResult<()> {
    validate_descriptor(descriptor)?;
    if descriptor.station_id != stored.station_id {
        return Err(CandidateError::ProfileStale);
    }
    if let Some(floor) = stored.generation_floor.as_mut() {
        if descriptor.generation < floor.generation
            || (descriptor.generation == floor.generation && key_id != floor.key_id)
            || (descriptor.generation > floor.generation && key_id == floor.key_id)
            || (stored.status == Some(StationTrustStatus::Revoked)
                && (descriptor.generation <= floor.generation || key_id == floor.key_id))
        {
            return Err(CandidateError::GenerationRollback);
        }
        if descriptor.generation > floor.generation {
            floor.generation = descriptor.generation;
            floor.key_id = key_id.to_owned();
        }
    } else {
        stored.generation_floor = Some(GenerationFloor {
            station_id: descriptor.station_id.clone(),
            generation: descriptor.generation,
            key_id: key_id.to_owned(),
        });
    }
    Ok(())
}

fn receipt_from(stored: &StoredStationTrust) -> CandidateResult<StationTrustMutationReceipt> {
    let trust = stored.trust.as_ref().ok_or(CandidateError::TrustStore)?;
    Ok(StationTrustMutationReceipt {
        revision: stored.revision,
        status: stored.status.ok_or(CandidateError::TrustStore)?,
        station_id: trust.station_id.clone(),
        enrollment_id: trust.enrollment_id.clone(),
        generation: trust.generation,
        key_id: signing_key_id(&trust.signing_key)?,
    })
}

fn canonical_broker_origin(value: &str) -> CandidateResult<String> {
    if value.len() > 2048 {
        return Err(CandidateError::Invalid);
    }
    let url = Url::parse(value).map_err(|_| CandidateError::Invalid)?;
    let loopback = matches!(
        url.host_str().map(str::to_ascii_lowercase).as_deref(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    let origin = url.origin().ascii_serialization();
    if origin != value
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
    {
        return Err(CandidateError::Invalid);
    }
    Ok(origin)
}

fn decode_canonical(segment: &str) -> CandidateResult<Vec<u8>> {
    if segment.is_empty()
        || !segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(CandidateError::Invalid);
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(segment)
        .map_err(|_| CandidateError::Invalid)?;
    if URL_SAFE_NO_PAD.encode(&decoded) != segment {
        return Err(CandidateError::Invalid);
    }
    Ok(decoded)
}

fn valid_digest(value: &str) -> bool {
    if value.len() != 43 {
        return false;
    }
    URL_SAFE_NO_PAD
        .decode(value)
        .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == value)
}

fn valid_confirmation_code(value: &str) -> bool {
    value.len() == 16 && value.bytes().all(|byte| CODE_ALPHABET.contains(&byte))
}

fn valid_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    value == value.to_ascii_lowercase()
        && bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
        && matches!(bytes[14].to_ascii_lowercase(), b'1'..=b'8')
        && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
}

fn p256_point(key: &SigningKey) -> CandidateResult<Vec<u8>> {
    let x = URL_SAFE_NO_PAD
        .decode(&key.x)
        .map_err(|_| CandidateError::Invalid)?;
    let y = URL_SAFE_NO_PAD
        .decode(&key.y)
        .map_err(|_| CandidateError::Invalid)?;
    if x.len() != 32 || y.len() != 32 {
        return Err(CandidateError::Invalid);
    }
    let mut point = Vec::with_capacity(65);
    point.push(4);
    point.extend_from_slice(&x);
    point.extend_from_slice(&y);
    // Ring validates both SEC1 encoding and P-256 curve membership when used
    // as an ECDH peer. This applies equally to freshly verified candidates and
    // records reloaded from the OS keyring.
    let ephemeral = EphemeralPrivateKey::generate(&ECDH_P256, &SystemRandom::new())
        .map_err(|_| CandidateError::Invalid)?;
    let peer = AgreementUnparsedPublicKey::new(&ECDH_P256, point.as_slice());
    agree_ephemeral(ephemeral, &peer, |_| ()).map_err(|_| CandidateError::Invalid)?;
    Ok(point)
}

fn signing_key_id(key: &SigningKey) -> CandidateResult<String> {
    // RFC 7638 canonical member order for an EC P-256 JWK.
    let canonical = format!(
        r#"{{"crv":"P-256","kty":"EC","x":"{}","y":"{}"}}"#,
        key.x, key.y
    );
    Ok(URL_SAFE_NO_PAD.encode(digest(&SHA256, canonical.as_bytes()).as_ref()))
}

fn confirmation_code(descriptor: &Descriptor) -> CandidateResult<String> {
    // Field ordering and the domain separator match stationConnectionKeyConfirmationCode().
    let canonical = format!(
        r#"{{"stationId":"{}","enrollmentId":"{}","generation":{},"signingKey":{{"kty":"EC","crv":"P-256","x":"{}","y":"{}"}}}}"#,
        descriptor.station_id,
        descriptor.enrollment_id,
        descriptor.generation,
        descriptor.signing_key.x,
        descriptor.signing_key.y
    );
    let mut input = b"station-connection-key-confirmation/v1\0".to_vec();
    input.extend_from_slice(canonical.as_bytes());
    let digest = digest(&SHA256, &input);
    let mut code = String::with_capacity(16);
    let mut accumulator: u32 = 0;
    let mut bits = 0;
    for byte in digest.as_ref().iter().take(10) {
        accumulator = (accumulator << 8) | *byte as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            code.push(CODE_ALPHABET[((accumulator >> bits) & 31) as usize] as char);
        }
        accumulator &= (1 << bits) - 1;
    }
    if bits != 0 || code.len() != 16 {
        return Err(CandidateError::Invalid);
    }
    Ok(code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};

    const NOW: u64 = 1_700_000_000;
    const STATION: &str = "11111111-1111-4111-8111-111111111111";
    const ENROLLMENT: &str = "22222222-2222-4222-8222-222222222222";
    const CLIENT: &str = "33333333-3333-4333-8333-333333333333";

    // Public-only golden vector signed with jose CompactSign over the
    // TypeScript serializeStationConnectionKeyCandidateClaims() output.
    const TYPESCRIPT_GOLDEN_CANDIDATE: &str = concat!(
        "eyJhbGciOiJFUzI1NiIsInR5cCI6InN0YXRpb24tY29ubmVjdGlvbi1rZXktY2FuZGlkYXRlK2p3cyJ9.",
        "eyJhdWQiOiJ1cm46c3RhdGlvbjpjb25uZWN0aW9uLWtleS1jYW5kaWRhdGU6djEiLCJicm9rZXJPcmlnaW4iOiJodHRwczovL2Jyb2tlci5leGFtcGxlIiwiY2hhbGxlbmdlIjoiQ1FrSkNRa0pDUWtKQ1FrSkNRa0pDUWtKQ1FrSkNRa0pDUWtKQ1FrSkNRayIsImNsaWVudEluc3RhbmNlSWQiOiIzMzMzMzMzMy0zMzMzLTQzMzMtODMzMy0zMzMzMzMzMzMzMzMiLCJjbGllbnRLZXlUaHVtYnByaW50IjoiQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZyIsImNvbmZpcm1hdGlvbkNvZGUiOiI5VzhEV0IwVEI2Q1JTNzBXIiwiZXhwIjoxNzAwMDAwMDYwLCJpYXQiOjE3MDAwMDAwMDAsImtleUlkIjoiaWdoTGZMSmlLTW5vTkFXVkF5bEQ0WmU0UldIUFhnRkR0aGpPUjdDc2lwOCIsInB1cnBvc2UiOiJhZHZlcnRpc2Utc3RhdGlvbi1jb25uZWN0aW9uLWtleSIsImNhbmRpZGF0ZSI6eyJzdGF0aW9uSWQiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJlbnJvbGxtZW50SWQiOiIyMjIyMjIyMi0yMjIyLTQyMjItODIyMi0yMjIyMjIyMjIyMjIiLCJnZW5lcmF0aW9uIjozLCJzaWduaW5nS2V5Ijp7Imt0eSI6IkVDIiwiY3J2IjoiUC0yNTYiLCJ4IjoiZFN6UjM3OXRqMWVDWEVzMHJmY0xpRFdWX0hySDRxOHcwQnVaMFJla2VHNCIsInkiOiJPTWhrMXVSZlRFX3UzT2E5ZkJCR0tfNGQwaVA2ZGl4YmRxMmJMTC1Qc3d3In19LCJ2ZXJzaW9uIjoic3RhdGlvbi1jb25uZWN0aW9uLWtleS1jYW5kaWRhdGUvdjEifQ.",
        "UY9qyq21wid3RrL_C-wkbQ7BuliQ460n5l83Jb1GP7-RcTvXdFc10bPJ7Fw_60x6PL5U0snRXieyKHcxqczEVw",
    );

    fn binding() -> CandidateBinding {
        CandidateBinding {
            profile_owner_id: "owner:profile-alpha".into(),
            app_identifier: "io.kontourai.station".into(),
            channel: "stable".into(),
            profile_revision: 7,
            expected_trust_revision: 0,
            broker_origin: "https://broker.example".into(),
            station_id: STATION.into(),
            enrollment_id: ENROLLMENT.into(),
            client_instance_id: CLIENT.into(),
            client_key_thumbprint: URL_SAFE_NO_PAD.encode([8u8; 32]),
            expected_station_signing_key_id: "ighLfLJiKMnoNAWVAylD4Ze4RWHPXgFDthjOR7Csip8".into(),
            expected_station_signing_generation: 3,
        }
    }

    fn trust_binding(binding: &CandidateBinding) -> TrustProfileBinding {
        profile_binding(binding)
    }

    fn signed_candidate(
        pending: &mut PendingStationKeyChallenge,
        overrides: impl FnOnce(&mut Claims),
    ) -> String {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
            .unwrap();
        let public = pair.public_key().as_ref();
        let key = SigningKey {
            kty: "EC".into(),
            crv: "P-256".into(),
            x: URL_SAFE_NO_PAD.encode(&public[1..33]),
            y: URL_SAFE_NO_PAD.encode(&public[33..65]),
        };
        let mut claims = Claims {
            aud: "urn:station:connection-key-candidate:v1".into(),
            broker_origin: pending.binding.broker_origin.clone(),
            challenge: pending.challenge.clone(),
            client_instance_id: pending.binding.client_instance_id.clone(),
            client_key_thumbprint: pending.binding.client_key_thumbprint.clone(),
            confirmation_code: "0000000000000000".into(),
            exp: NOW + 60,
            iat: NOW,
            key_id: "A".repeat(43),
            purpose: "advertise-station-connection-key".into(),
            candidate: Descriptor {
                station_id: pending.binding.station_id.clone(),
                enrollment_id: pending.binding.enrollment_id.clone(),
                generation: 3,
                signing_key: key,
            },
            version: "station-connection-key-candidate/v1".into(),
        };
        claims.key_id = signing_key_id(&claims.candidate.signing_key).unwrap();
        claims.confirmation_code = confirmation_code(&claims.candidate).unwrap();
        overrides(&mut claims);
        claims.key_id = signing_key_id(&claims.candidate.signing_key).unwrap();
        claims.confirmation_code = confirmation_code(&claims.candidate).unwrap();
        pending.binding.expected_station_signing_key_id = claims.key_id.clone();
        pending.binding.expected_station_signing_generation = claims.candidate.generation;
        let body = serde_json::to_vec(&claims).unwrap();
        let protected = URL_SAFE_NO_PAD.encode(HEADER);
        let payload = URL_SAFE_NO_PAD.encode(body);
        let input = format!("{protected}.{payload}");
        let signature = pair.sign(&rng, input.as_bytes()).unwrap();
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()))
    }

    fn pending() -> PendingStationKeyChallenge {
        PendingStationKeyChallenge::with_challenge(binding(), URL_SAFE_NO_PAD.encode([9u8; 32]))
            .unwrap()
    }

    #[test]
    fn verifies_candidate_and_keeps_host_profile_owner_revision_local() {
        let mut pending = pending();
        let compact = signed_candidate(&mut pending, |_| {});
        let verified = pending.verify(&compact, NOW).unwrap();
        assert_eq!(verified.station_id(), STATION);
        assert_eq!(verified.enrollment_id(), ENROLLMENT);
        assert_eq!(verified.generation(), 3);
        assert_eq!(verified.profile_owner_id(), "owner:profile-alpha");
        assert_eq!(verified.profile_revision(), 7);
        assert_eq!(verified.expected_trust_revision(), 0);
        assert_eq!(verified.challenge(), pending.challenge());
    }

    #[test]
    fn verifies_typescript_issuer_golden_jws_and_canonical_sas() {
        let pending = pending();
        let verified = pending.verify(TYPESCRIPT_GOLDEN_CANDIDATE, NOW).unwrap();
        assert_eq!(
            verified.key_id(),
            "ighLfLJiKMnoNAWVAylD4Ze4RWHPXgFDthjOR7Csip8"
        );
        assert_eq!(verified.confirmation_code(), "9W8DWB0TB6CRS70W");
        assert_eq!(verified.generation(), 3);
    }

    #[test]
    fn a_valid_self_signed_candidate_remains_unapproved_candidate_data() {
        let mut pending = pending();
        let compact = signed_candidate(&mut pending, |_| {});
        let verified = pending.verify(&compact, NOW).unwrap();
        // This primitive returns only candidate data. It contains no approval
        // record conversion, persistence API, revocation state, or trust grant.
        assert_eq!(verified.key_id().len(), 43);
        assert_eq!(verified.confirmation_code().len(), 16);
        assert_eq!(verified.profile_owner_id(), "owner:profile-alpha");
        assert_eq!(verified.profile_revision(), 7);
    }

    #[test]
    fn rejects_signature_tampering_noncanonical_headers_and_extra_claims() {
        let mut pending = pending();
        let compact = signed_candidate(&mut pending, |_| {});
        let mut parts: Vec<String> = compact.split('.').map(str::to_owned).collect();
        let changed_prefix = if &parts[2][..1] == "A" { "B" } else { "A" };
        parts[2].replace_range(0..1, changed_prefix);
        assert_eq!(
            pending.verify(&parts.join("."), NOW),
            Err(CandidateError::Invalid)
        );
        let reverse_header = URL_SAFE_NO_PAD
            .encode(br#"{"typ":"station-connection-key-candidate+jws","alg":"ES256"}"#);
        assert_eq!(
            pending.verify(&format!("{reverse_header}.{}.{}", parts[1], parts[2]), NOW),
            Err(CandidateError::Invalid)
        );
        let mut payload: serde_json::Value =
            serde_json::from_slice(&decode_canonical(&parts[1]).unwrap()).unwrap();
        payload
            .as_object_mut()
            .unwrap()
            .insert("unrecognized".into(), serde_json::Value::Bool(true));
        parts[1] = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        assert_eq!(
            pending.verify(&parts.join("."), NOW),
            Err(CandidateError::Invalid)
        );
    }

    #[test]
    fn rejects_challenge_route_client_and_identity_mismatches() {
        let cases = [
            |claims: &mut Claims| claims.challenge = URL_SAFE_NO_PAD.encode([1u8; 32]),
            |claims: &mut Claims| claims.broker_origin = "https://other.example".into(),
            |claims: &mut Claims| {
                claims.client_instance_id = "44444444-4444-4444-8444-444444444444".into()
            },
            |claims: &mut Claims| claims.client_key_thumbprint = URL_SAFE_NO_PAD.encode([2u8; 32]),
            |claims: &mut Claims| {
                claims.candidate.station_id = "55555555-5555-4555-8555-555555555555".into()
            },
            |claims: &mut Claims| {
                claims.candidate.enrollment_id = "66666666-6666-4666-8666-666666666666".into()
            },
        ];
        for mutate in cases {
            let mut pending = pending();
            let compact = signed_candidate(&mut pending, mutate);
            assert_eq!(
                pending.verify(&compact, NOW),
                Err(CandidateError::BindingMismatch)
            );
        }
    }

    #[test]
    fn rejects_expired_future_and_overlong_candidates() {
        for (iat, exp) in [(NOW - 61, NOW - 1), (NOW + 6, NOW + 30), (NOW, NOW + 61)] {
            let mut pending = pending();
            let compact = signed_candidate(&mut pending, |claims| {
                claims.iat = iat;
                claims.exp = exp;
            });
            assert_eq!(pending.verify(&compact, NOW), Err(CandidateError::Stale));
        }
        let pending = pending();
        assert_eq!(
            pending.verify(&"A".repeat(MAX_CANDIDATE_BYTES + 1), NOW),
            Err(CandidateError::Invalid)
        );
    }

    #[test]
    fn rejects_invitation_key_mismatch_and_javascript_unsafe_integers() {
        let mut pending_challenge = pending();
        let compact = signed_candidate(&mut pending_challenge, |_| {});
        pending_challenge.binding.expected_station_signing_key_id = "A".repeat(43);
        assert_eq!(
            pending_challenge.verify(&compact, NOW),
            Err(CandidateError::BindingMismatch)
        );
        pending_challenge.binding.expected_station_signing_key_id =
            "ighLfLJiKMnoNAWVAylD4Ze4RWHPXgFDthjOR7Csip8".into();
        pending_challenge
            .binding
            .expected_station_signing_generation = 4;
        assert_eq!(
            pending_challenge.verify(&compact, NOW),
            Err(CandidateError::BindingMismatch)
        );

        for mutate in [
            |claims: &mut Claims| claims.candidate.generation = JS_SAFE_INTEGER_MAX + 1,
            |claims: &mut Claims| claims.iat = JS_SAFE_INTEGER_MAX + 1,
            |claims: &mut Claims| claims.exp = JS_SAFE_INTEGER_MAX + 1,
        ] {
            let mut pending = pending();
            let compact = signed_candidate(&mut pending, mutate);
            assert_eq!(pending.verify(&compact, NOW), Err(CandidateError::Invalid));
        }
    }

    #[test]
    fn operator_confirmation_requires_the_sas_and_entire_key_identifier() {
        let mut pending = pending();
        let compact = signed_candidate(&mut pending, |_| {});
        let verified = pending.verify(&compact, NOW).unwrap();
        assert_eq!(
            verified
                .clone()
                .confirm_operator("0000000000000000", verified.key_id()),
            Err(CandidateError::OperatorConfirmationMismatch)
        );
        assert_eq!(
            verified
                .clone()
                .confirm_operator(verified.confirmation_code(), "short"),
            Err(CandidateError::OperatorConfirmationMismatch)
        );
        let confirmed = verified
            .clone()
            .confirm_operator(verified.confirmation_code(), verified.key_id())
            .unwrap();
        assert_eq!(confirmed.candidate.profile_revision(), 7);
    }

    #[test]
    fn rejects_bad_broker_origin_and_profile_revision_at_challenge_creation() {
        let mut invalid = binding();
        invalid.broker_origin = "http://broker.example".into();
        assert_eq!(
            PendingStationKeyChallenge::begin(invalid),
            Err(CandidateError::Invalid)
        );
        let mut noncanonical = binding();
        noncanonical.station_id = "ABCDEFAB-CDEF-4ABC-8ABC-ABCDEFABCDEF".into();
        assert_eq!(
            PendingStationKeyChallenge::begin(noncanonical),
            Err(CandidateError::Invalid)
        );
        let mut invalid = binding();
        invalid.profile_revision = 0;
        assert_eq!(
            PendingStationKeyChallenge::begin(invalid),
            Err(CandidateError::Invalid)
        );
    }

    #[derive(Clone, Default)]
    struct MemoryTrustBackend(Arc<Mutex<HashMap<String, String>>>);

    impl StationTrustBackend for MemoryTrustBackend {
        fn read(&mut self, account: &str) -> CandidateResult<Option<Zeroizing<String>>> {
            self.0
                .lock()
                .map_err(|_| CandidateError::TrustStore)
                .map(|entries| entries.get(account).cloned().map(Zeroizing::new))
        }

        fn write(&mut self, account: &str, value: &str) -> CandidateResult<()> {
            self.0
                .lock()
                .map_err(|_| CandidateError::TrustStore)?
                .insert(account.to_owned(), value.to_owned());
            Ok(())
        }
    }

    #[derive(Clone)]
    struct FakeLockedProfileProvider(Arc<Mutex<LockedTrustProfileSnapshot>>);

    impl LockedTrustProfileProvider for FakeLockedProfileProvider {
        fn with_current_profile<T, F>(
            &self,
            expected_binding: &TrustProfileBinding,
            expected_profile_revision: u64,
            operation: F,
        ) -> CandidateResult<T>
        where
            F: FnOnce(LockedTrustProfileSnapshot) -> CandidateResult<T>,
        {
            let snapshot = self.0.lock().map_err(|_| CandidateError::ProfileStale)?;
            if snapshot.binding != *expected_binding
                || snapshot.revision != expected_profile_revision
            {
                return Err(CandidateError::ProfileStale);
            }
            // Keep this mutex guard alive through the store read/compare/write.
            operation(snapshot.clone())
        }
    }

    fn locked_profile(binding: &CandidateBinding) -> FakeLockedProfileProvider {
        FakeLockedProfileProvider(Arc::new(Mutex::new(LockedTrustProfileSnapshot {
            binding: trust_binding(binding),
            revision: binding.profile_revision,
        })))
    }

    fn verified_for_store(
        expected_trust_revision: u64,
        generation: u64,
    ) -> VerifiedStationKeyCandidate {
        let mut binding = binding();
        binding.expected_trust_revision = expected_trust_revision;
        let mut pending =
            PendingStationKeyChallenge::with_challenge(binding, URL_SAFE_NO_PAD.encode([9u8; 32]))
                .unwrap();
        let compact = signed_candidate(&mut pending, |claims| {
            claims.candidate.generation = generation;
        });
        pending.verify(&compact, NOW).unwrap()
    }

    fn verified_typescript_golden_for(
        mut binding: CandidateBinding,
    ) -> VerifiedStationKeyCandidate {
        binding.expected_station_signing_key_id =
            "ighLfLJiKMnoNAWVAylD4Ze4RWHPXgFDthjOR7Csip8".into();
        binding.expected_station_signing_generation = 3;
        let pending =
            PendingStationKeyChallenge::with_challenge(binding, URL_SAFE_NO_PAD.encode([9u8; 32]))
                .unwrap();
        pending.verify(TYPESCRIPT_GOLDEN_CANDIDATE, NOW).unwrap()
    }

    #[test]
    fn keyring_record_revision_survives_store_recreation_and_revocation() {
        let backend = MemoryTrustBackend::default();
        let profile = locked_profile(&binding());
        let trust_binding = trust_binding(&binding());
        let candidate = verified_for_store(0, 3);
        let code = candidate.confirmation_code().to_owned();
        let key_id = candidate.key_id().to_owned();
        let mut first = NativeStationTrustStore::with_backend(backend.clone());
        let approved = first.approve(&profile, candidate, &code, &key_id).unwrap();
        assert_eq!(approved.revision, 1);
        assert_eq!(approved.status, StationTrustStatus::Approved);
        drop(first);

        // A fresh store object reloads the serialized record as on restart.
        let mut after_restart = NativeStationTrustStore::with_backend(backend.clone());
        assert_eq!(
            after_restart.current_revision(&profile, &trust_binding, 7),
            Ok(1)
        );
        let revoked = after_restart
            .revoke(&profile, &trust_binding, 7, 1, &key_id)
            .unwrap();
        assert_eq!(revoked.revision, 2);
        assert_eq!(revoked.status, StationTrustStatus::Revoked);
        drop(after_restart);

        let mut second_restart = NativeStationTrustStore::with_backend(backend);
        assert_eq!(
            second_restart.current_revision(&profile, &trust_binding, 7),
            Ok(2)
        );
        assert_eq!(
            second_restart.revoke(&profile, &trust_binding, 7, 1, &key_id),
            Err(CandidateError::TrustRevisionConflict)
        );
    }

    #[test]
    fn station_level_tombstone_survives_profile_rename_and_reapproval_needs_rotation() {
        let backend = MemoryTrustBackend::default();
        let first_binding = binding();
        let first_profile = locked_profile(&first_binding);
        let mut store = NativeStationTrustStore::with_backend(backend.clone());
        let candidate = verified_typescript_golden_for(first_binding.clone());
        let code = candidate.confirmation_code().to_owned();
        let key_id = candidate.key_id().to_owned();
        let approved = store
            .approve(&first_profile, candidate, &code, &key_id)
            .unwrap();
        assert_eq!(approved.revision, 1);

        // A profile rename is a new route binding under the same Station-level
        // keyring account; explicit confirmation may add it while approved.
        let mut renamed = binding();
        renamed.profile_owner_id = "profile-renamed".into();
        renamed.expected_trust_revision = 1;
        let renamed_profile = locked_profile(&renamed);
        let renamed_binding = trust_binding(&renamed);
        assert_eq!(
            store.current_revision(&renamed_profile, &renamed_binding, 7),
            Ok(1)
        );
        let candidate = verified_typescript_golden_for(renamed.clone());
        let code = candidate.confirmation_code().to_owned();
        let added = store
            .approve(&renamed_profile, candidate, &code, &key_id)
            .unwrap();
        assert_eq!(added.revision, 2);

        // Revocation is Station-wide and keeps the same durable generation
        // floor even when the selected profile name changes.
        let revoked = store
            .revoke(&renamed_profile, &renamed_binding, 7, 2, &key_id)
            .unwrap();
        assert_eq!(revoked.revision, 3);
        assert_eq!(revoked.status, StationTrustStatus::Revoked);

        renamed.expected_trust_revision = 3;
        let candidate = verified_typescript_golden_for(renamed.clone());
        let code = candidate.confirmation_code().to_owned();
        assert_eq!(
            store.approve(&renamed_profile, candidate, &code, &key_id),
            Err(CandidateError::GenerationRollback)
        );

        // A revocation can be superseded only by a higher generation and a
        // different key identifier. This synthetic fixture generates a new key.
        let rotated = verified_for_store(3, 4);
        let rotated_code = rotated.confirmation_code().to_owned();
        let rotated_key_id = rotated.key_id().to_owned();
        assert_ne!(rotated_key_id, key_id);
        let reapproved = store
            .approve(&first_profile, rotated, &rotated_code, &rotated_key_id)
            .unwrap();
        assert_eq!(reapproved.revision, 4);
        assert_eq!(reapproved.status, StationTrustStatus::Approved);

        // Profile rename/re-add did not create a second keyring account.
        assert_eq!(backend.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn corrupt_keyring_record_is_not_treated_as_absent_or_approved() {
        let backend = MemoryTrustBackend::default();
        let trust_binding = trust_binding(&binding());
        let account = trust_account(&trust_binding).unwrap();
        backend
            .0
            .lock()
            .unwrap()
            .insert(account, "{truncated".into());
        let mut store = NativeStationTrustStore::with_backend(backend);
        assert_eq!(
            store.current_revision(&locked_profile(&binding()), &trust_binding, 7),
            Err(CandidateError::TrustStore)
        );
    }

    #[test]
    fn approved_candidate_expires_before_locked_keyring_commit() {
        let backend = MemoryTrustBackend::default();
        let profile = locked_profile(&binding());
        let clock = TestStationTrustClock::new(NOW);
        let mut store = NativeStationTrustStore::with_backend_and_clock(backend.clone(), clock);
        let candidate = verified_for_store(0, 3);
        let code = candidate.confirmation_code().to_owned();
        let key_id = candidate.key_id().to_owned();
        // Verification happened at NOW; expiry is NOW + 60 seconds. Keep the
        // candidate pending past that boundary before entering the profile lock.
        store.clock.set(NOW + 60);
        assert_eq!(
            store.approve(&profile, candidate, &code, &key_id),
            Err(CandidateError::Stale)
        );
        assert!(backend.0.lock().unwrap().is_empty());
    }

    #[test]
    fn stored_off_curve_p256_point_is_rejected_on_reload() {
        let backend = MemoryTrustBackend::default();
        let profile_binding = binding();
        let profile = locked_profile(&profile_binding);
        let trust_binding = trust_binding(&profile_binding);
        let mut store = NativeStationTrustStore::with_backend(backend.clone());
        let candidate = verified_for_store(0, 3);
        let code = candidate.confirmation_code().to_owned();
        let key_id = candidate.key_id().to_owned();
        store.approve(&profile, candidate, &code, &key_id).unwrap();

        let account = trust_account(&trust_binding).unwrap();
        let encoded = backend.0.lock().unwrap().get(&account).unwrap().clone();
        let mut stored: StoredStationTrust = serde_json::from_str(&encoded).unwrap();
        let trust = stored.trust.as_mut().unwrap();
        trust.signing_key.x = URL_SAFE_NO_PAD.encode([0u8; 32]);
        trust.signing_key.y = URL_SAFE_NO_PAD.encode([0u8; 32]);
        stored.generation_floor.as_mut().unwrap().key_id =
            signing_key_id(&trust.signing_key).unwrap();
        let corrupted = serde_json::to_string(&stored).unwrap();
        backend.0.lock().unwrap().insert(account, corrupted);

        assert_eq!(
            store.current_revision(&profile, &trust_binding, 7),
            Err(CandidateError::TrustStore)
        );
    }

    #[test]
    fn approval_requires_both_operator_values_and_exact_profile_snapshot() {
        let backend = MemoryTrustBackend::default();
        let profile = locked_profile(&binding());
        let mut store = NativeStationTrustStore::with_backend(backend.clone());
        let candidate = verified_for_store(0, 3);
        let code = candidate.confirmation_code().to_owned();
        let key_id = candidate.key_id().to_owned();
        assert_eq!(
            store.approve(&profile, candidate.clone(), "0000000000000000", &key_id),
            Err(CandidateError::OperatorConfirmationMismatch)
        );
        assert_eq!(
            store.approve(&profile, candidate.clone(), &code, "short"),
            Err(CandidateError::OperatorConfirmationMismatch)
        );
        assert_eq!(
            store.current_revision(&profile, &trust_binding(&binding()), 7),
            Ok(0)
        );

        let mut stale_profile = binding();
        stale_profile.profile_revision += 1;
        let stale_provider = locked_profile(&stale_profile);
        assert_eq!(
            store.approve(&stale_provider, candidate, &code, &key_id),
            Err(CandidateError::ProfileStale)
        );
        assert_eq!(
            store.current_revision(&profile, &trust_binding(&binding()), 7),
            Ok(0)
        );
        assert_eq!(backend.0.lock().unwrap().len(), 0);
    }

    #[test]
    fn store_revision_cas_and_same_enrollment_generation_floor_refuse_rollback() {
        let backend = MemoryTrustBackend::default();
        let profile = locked_profile(&binding());
        let trust_binding = trust_binding(&binding());
        let mut store = NativeStationTrustStore::with_backend(backend.clone());
        let candidate = verified_for_store(0, 3);
        let code = candidate.confirmation_code().to_owned();
        let key_id = candidate.key_id().to_owned();
        store.approve(&profile, candidate, &code, &key_id).unwrap();

        let stale = verified_for_store(0, 4);
        let stale_code = stale.confirmation_code().to_owned();
        let stale_id = stale.key_id().to_owned();
        assert_eq!(
            store.approve(&profile, stale, &stale_code, &stale_id),
            Err(CandidateError::TrustRevisionConflict)
        );

        let rollback = verified_for_store(1, 2);
        let rollback_code = rollback.confirmation_code().to_owned();
        let rollback_id = rollback.key_id().to_owned();
        assert_eq!(
            store.approve(&profile, rollback, &rollback_code, &rollback_id),
            Err(CandidateError::GenerationRollback)
        );
        assert_eq!(store.current_revision(&profile, &trust_binding, 7), Ok(1));
    }
}

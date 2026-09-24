//! Native verification primitives for Station connection-key candidates.
//!
//! A candidate is an untrusted courier value. This module verifies the exact
//! compact JWS bytes, its self-signature, challenge, route, key identifier,
//! generation descriptor, expiry, and short authentication string. A verified
//! candidate proves possession of the advertised key only; it is deliberately
//! not an approval or a persisted trust decision.

#![allow(dead_code)] // Intentionally unregistered from IPC until durable host trust custody exists.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ring::digest::{digest, SHA256};
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{self, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
use url::Url;

const MAX_CANDIDATE_BYTES: usize = 8192;
const CANDIDATE_LIFETIME_SECONDS: u64 = 60;
const CODE_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const HEADER: &[u8] = br#"{"alg":"ES256","typ":"station-connection-key-candidate+jws"}"#;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CandidateError {
    Invalid,
    Stale,
    BindingMismatch,
    OperatorConfirmationMismatch,
}

pub(crate) type CandidateResult<T> = Result<T, CandidateError>;

/// Host snapshot captured when the broker challenge is issued. Owner and
/// revision remain local host context: neither is supplied by broker metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CandidateBinding {
    pub(crate) profile_owner_id: String,
    pub(crate) profile_revision: u64,
    pub(crate) broker_origin: String,
    pub(crate) station_id: String,
    pub(crate) enrollment_id: String,
    pub(crate) client_instance_id: String,
    pub(crate) client_key_thumbprint: String,
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
    profile_owner_id: String,
    profile_revision: u64,
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
        {
            return Err(CandidateError::BindingMismatch);
        }
        if claims.exp <= now
            || claims.iat > now.saturating_add(5)
            || claims.iat < now.saturating_sub(CANDIDATE_LIFETIME_SECONDS)
            || claims.exp <= claims.iat
            || claims.exp - claims.iat > CANDIDATE_LIFETIME_SECONDS
        {
            return Err(CandidateError::Stale);
        }
        let key_id = signing_key_id(&claims.candidate.signing_key)?;
        let confirmation = confirmation_code(&claims.candidate)?;
        if claims.key_id != key_id || claims.confirmation_code != confirmation {
            return Err(CandidateError::Invalid);
        }
        Ok(VerifiedStationKeyCandidate {
            claims,
            challenge: self.challenge.clone(),
            profile_owner_id: self.binding.profile_owner_id.clone(),
            profile_revision: self.binding.profile_revision,
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
    pub(crate) fn profile_owner_id(&self) -> &str {
        &self.profile_owner_id
    }
    pub(crate) fn profile_revision(&self) -> u64 {
        self.profile_revision
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
        || canonical_broker_origin(&binding.broker_origin).is_err()
        || !valid_uuid(&binding.station_id)
        || !valid_uuid(&binding.enrollment_id)
        || !valid_uuid(&binding.client_instance_id)
        || !valid_digest(&binding.client_key_thumbprint)
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
        || claims.candidate.signing_key.kty != "EC"
        || claims.candidate.signing_key.crv != "P-256"
        || !valid_digest(&claims.candidate.signing_key.x)
        || !valid_digest(&claims.candidate.signing_key.y)
    {
        return Err(CandidateError::Invalid);
    }
    Ok(())
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
    bytes.len() == 36
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
    const TYPESCRIPT_GOLDEN_CANDIDATE: &str = "eyJhbGciOiJFUzI1NiIsInR5cCI6InN0YXRpb24tY29ubmVjdGlvbi1rZXktY2FuZGlkYXRlK2p3cyJ9.eyJhdWQiOiJ1cm46c3RhdGlvbjpjb25uZWN0aW9uLWtleS1jYW5kaWRhdGU6djEiLCJicm9rZXJPcmlnaW4iOiJodHRwczovL2Jyb2tlci5leGFtcGxlIiwiY2hhbGxlbmdlIjoiQ1FrSkNRa0pDUWtKQ1FrSkNRa0pDUWtKQ1FrSkNRa0pDUWtKQ1FrSkNRayIsImNsaWVudEluc3RhbmNlSWQiOiIzMzMzMzMzMy0zMzMzLTQzMzMtODMzMy0zMzMzMzMzMzMzMzMiLCJjbGllbnRLZXlUaHVtYnByaW50IjoiQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWdJQ0FnSUNBZyIsImNvbmZpcm1hdGlvbkNvZGUiOiI5VzhEV0IwVEI2Q1JTNzBXIiwiZXhwIjoxNzAwMDAwMDYwLCJpYXQiOjE3MDAwMDAwMDAsImtleUlkIjoiaWdoTGZMSmlLTW5vTkFXVkF5bEQ0WmU0UldIUFhnRkR0aGpPUjdDc2lwOCIsInB1cnBvc2UiOiJhZHZlcnRpc2Utc3RhdGlvbi1jb25uZWN0aW9uLWtleSIsImNhbmRpZGF0ZSI6eyJzdGF0aW9uSWQiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJlbnJvbGxtZW50SWQiOiIyMjIyMjIyMi0yMjIyLTQyMjItODIyMi0yMjIyMjIyMjIyMjIiLCJnZW5lcmF0aW9uIjozLCJzaWduaW5nS2V5Ijp7Imt0eSI6IkVDIiwiY3J2IjoiUC0yNTYiLCJ4IjoiZFN6UjM3OXRqMWVDWEVzMHJmY0xpRFdWX0hySDRxOHcwQnVaMFJla2VHNCIsInkiOiJPTWhrMXVSZlRFX3UzT2E5ZkJCR0tfNGQwaVA2ZGl4YmRxMmJMTC1Qc3d3In19LCJ2ZXJzaW9uIjoic3RhdGlvbi1jb25uZWN0aW9uLWtleS1jYW5kaWRhdGUvdjEifQ.UY9qyq21wid3RrL_C-wkbQ7BuliQ460n5l83Jb1GP7-RcTvXdFc10bPJ7Fw_60x6PL5U0snRXieyKHcxqczEVw";

    fn binding() -> CandidateBinding {
        CandidateBinding {
            profile_owner_id: "owner:profile-alpha".into(),
            profile_revision: 7,
            broker_origin: "https://broker.example".into(),
            station_id: STATION.into(),
            enrollment_id: ENROLLMENT.into(),
            client_instance_id: CLIENT.into(),
            client_key_thumbprint: URL_SAFE_NO_PAD.encode([8u8; 32]),
        }
    }

    fn signed_candidate(
        pending: &PendingStationKeyChallenge,
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
        let pending = pending();
        let compact = signed_candidate(&pending, |_| {});
        let verified = pending.verify(&compact, NOW).unwrap();
        assert_eq!(verified.station_id(), STATION);
        assert_eq!(verified.enrollment_id(), ENROLLMENT);
        assert_eq!(verified.generation(), 3);
        assert_eq!(verified.profile_owner_id(), "owner:profile-alpha");
        assert_eq!(verified.profile_revision(), 7);
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
        let pending = pending();
        let verified = pending
            .verify(&signed_candidate(&pending, |_| {}), NOW)
            .unwrap();
        // This primitive returns only candidate data. It contains no approval
        // record conversion, persistence API, revocation state, or trust grant.
        assert_eq!(verified.key_id().len(), 43);
        assert_eq!(verified.confirmation_code().len(), 16);
        assert_eq!(verified.profile_owner_id(), "owner:profile-alpha");
        assert_eq!(verified.profile_revision(), 7);
    }

    #[test]
    fn rejects_signature_tampering_noncanonical_headers_and_extra_claims() {
        let pending = pending();
        let compact = signed_candidate(&pending, |_| {});
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
        let pending = pending();
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
            let compact = signed_candidate(&pending, mutate);
            assert_eq!(
                pending.verify(&compact, NOW),
                Err(CandidateError::BindingMismatch)
            );
        }
    }

    #[test]
    fn rejects_expired_future_and_overlong_candidates() {
        let pending = pending();
        for (iat, exp) in [(NOW - 61, NOW - 1), (NOW + 6, NOW + 30), (NOW, NOW + 61)] {
            let compact = signed_candidate(&pending, |claims| {
                claims.iat = iat;
                claims.exp = exp;
            });
            assert_eq!(pending.verify(&compact, NOW), Err(CandidateError::Stale));
        }
        assert_eq!(
            pending.verify(&"A".repeat(MAX_CANDIDATE_BYTES + 1), NOW),
            Err(CandidateError::Invalid)
        );
    }

    #[test]
    fn operator_confirmation_requires_the_sas_and_entire_key_identifier() {
        let pending = pending();
        let verified = pending
            .verify(&signed_candidate(&pending, |_| {}), NOW)
            .unwrap();
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
        let mut invalid = binding();
        invalid.profile_revision = 0;
        assert_eq!(
            PendingStationKeyChallenge::begin(invalid),
            Err(CandidateError::Invalid)
        );
    }
}

//! Host-owned native peer transcripts and one bounded Device request proof.
//! Browser RTC connectivity remains with the browser; a verified transcript
//! does not establish account, Project, or live server Device authority.

use crate::native_device_binding_candidate::{
    NativeDeviceBindingCandidateManager, NativeDeviceReceiptObservation,
};
use crate::native_device_proof_key::{NativeDeviceProofKeyOwner, NativeDeviceProofKeyVault};
use crate::native_relay_proof_key::P256PublicJwk;
use crate::native_relay_redemption::{
    self, NativeDeviceReceiptCapture, NativeRedemptionError, NativeRelaySignalAnswer,
    NativeRelaySignalOpenRequest, NativeRelaySignalOpened, NativeRelaySignalReadRequest,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::{
    digest::{digest, SHA256},
    rand::{SecureRandom as _, SystemRandom},
    signature,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const MAX_PEERS: usize = 16;
const PEER_LIFETIME_MS: u64 = 120_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const REFUSED: &str = "native_application_peer_refused";
const BUSY: &str = "native_application_peer_busy";
type Result<T> = std::result::Result<T, String>;

fn refused<T>() -> Result<T> {
    Err(REFUSED.into())
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}
fn random_id() -> Result<String> {
    let mut bytes = [0u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| REFUSED.to_owned())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn sha256(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(digest(&SHA256, bytes))
}
fn decode(value: &str) -> Result<Vec<u8>> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| REFUSED.to_owned())?;
    if value.is_empty() || URL_SAFE_NO_PAD.encode(&bytes) != value {
        return refused();
    }
    Ok(bytes)
}
fn valid_handle(value: &str) -> bool {
    value.len() == 43 && decode(value).is_ok_and(|bytes| bytes.len() == 32)
}
fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| {
        id.to_string() == value
            && (1..=8).contains(&id.get_version_num())
            && id.get_variant() == uuid::Variant::RFC4122
    })
}
fn point(key: &P256PublicJwk) -> Result<Vec<u8>> {
    let x = decode(key.x())?;
    let y = decode(key.y())?;
    if key.kty() != "EC" || key.crv() != "P-256" || x.len() != 32 || y.len() != 32 {
        return refused();
    }
    let mut bytes = vec![4];
    bytes.extend(x);
    bytes.extend(y);
    Ok(bytes)
}
fn key_id(key: &P256PublicJwk) -> String {
    sha256(
        format!(
            r#"{{"crv":"P-256","kty":"EC","x":"{}","y":"{}"}}"#,
            key.x(),
            key.y()
        )
        .as_bytes(),
    )
}

fn fingerprint(sdp: &str) -> Result<String> {
    if sdp.is_empty() || sdp.len() > 65536 {
        return refused();
    }
    let mut fingerprint = None;
    for line in sdp.lines() {
        if !line.starts_with("a=fingerprint:") {
            continue;
        }
        let value = line
            .strip_prefix("a=fingerprint:sha-256 ")
            .ok_or_else(|| REFUSED.to_owned())?
            .to_ascii_uppercase();
        let pairs: Vec<_> = value.split(':').collect();
        if pairs.len() != 32
            || pairs
                .iter()
                .any(|part| part.len() != 2 || !part.bytes().all(|byte| byte.is_ascii_hexdigit()))
        {
            return refused();
        }
        if fingerprint.as_ref().is_some_and(|before| before != &value) {
            return refused();
        }
        fingerprint = Some(value);
    }
    fingerprint.ok_or_else(|| REFUSED.to_owned())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ConnectionBinding {
    station_id: String,
    enrollment_id: String,
    generation: u64,
    connection_id: String,
    client_nonce: String,
    client_fingerprint: String,
    station_fingerprint: String,
    offer_sha256: String,
    answer_sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConnectionHeader {
    alg: String,
    typ: String,
    kid: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConnectionClaims {
    version: u8,
    binding: ConnectionBinding,
    iss: String,
    aud: String,
    iat: u64,
    nbf: u64,
    exp: u64,
    jti: String,
}
fn verify_transcript(
    capture: &NativeDeviceReceiptCapture,
    nonce: &str,
    offer: &str,
    answer: &NativeRelaySignalAnswer,
    now: u64,
) -> Result<(u64, u64)> {
    verify_native_route_transcript(&capture.context, nonce, offer, answer, now)
}

pub(crate) fn verify_native_route_transcript(
    context: &native_relay_redemption::NativeRedemptionContext,
    nonce: &str,
    offer: &str,
    answer: &NativeRelaySignalAnswer,
    now: u64,
) -> Result<(u64, u64)> {
    let sdp = answer
        .answer_sdp
        .as_ref()
        .ok_or_else(|| REFUSED.to_owned())?;
    let proof = answer
        .station_proof
        .as_ref()
        .ok_or_else(|| REFUSED.to_owned())?;
    if proof.len() > 4096 {
        return refused();
    }
    let parts: Vec<_> = proof.split('.').collect();
    if parts.len() != 3 {
        return refused();
    }
    let header: ConnectionHeader =
        serde_json::from_slice(&decode(parts[0])?).map_err(|_| REFUSED.to_owned())?;
    let claims: ConnectionClaims =
        serde_json::from_slice(&decode(parts[1])?).map_err(|_| REFUSED.to_owned())?;
    let trust = &context.station_trust;
    if header.alg != "ES256"
        || header.typ != "station-connection-proof+jwt"
        || header.kid != key_id(&trust.signing_key)
        || claims.version != 1
        || claims.iss != format!("urn:station:{}", trust.station_id)
        || claims.aud != "urn:station:connection-proof:v1"
        || !canonical_uuid(&claims.jti)
        || claims.iat > MAX_SAFE_INTEGER
        || claims.exp > MAX_SAFE_INTEGER
        || claims.nbf != claims.iat
        || claims.iat.checked_add(30) != Some(claims.exp)
        || now < claims.iat
        || now >= claims.exp
    {
        return refused();
    }
    let expected = ConnectionBinding {
        station_id: trust.station_id.clone(),
        enrollment_id: trust.enrollment_id.clone(),
        generation: trust.generation,
        connection_id: context.profile.client_instance_id.clone(),
        client_nonce: nonce.to_owned(),
        client_fingerprint: fingerprint(offer)?,
        station_fingerprint: fingerprint(sdp)?,
        offer_sha256: sha256(offer.as_bytes()),
        answer_sha256: sha256(sdp.as_bytes()),
    };
    if claims.binding != expected {
        return refused();
    }
    let signature = decode(parts[2])?;
    if signature.len() != 64 {
        return refused();
    }
    signature::UnparsedPublicKey::new(
        &signature::ECDSA_P256_SHA256_FIXED,
        point(&trust.signing_key)?,
    )
    .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
    .map_err(|_| REFUSED.to_owned())?;
    Ok((claims.nbf, claims.exp))
}

pub(crate) fn native_member_read_path(path: &str) -> bool {
    if matches!(
        path,
        "/.well-known/station/v1"
            | "/api/system/status"
            | "/api/system/identity"
            | "/api/auth/authority"
            | "/api/projects"
    ) {
        return true;
    }
    let Some(rest) = path.strip_prefix("/api/projects/") else {
        return false;
    };
    let pieces: Vec<_> = rest.split('/').collect();
    let identifier = |value: &str| {
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    };
    match pieces.as_slice() {
        [slug] => identifier(slug),
        [slug, "shared-work"] => identifier(slug),
        [slug, "shared-work", task, leaf] => {
            identifier(slug)
                && identifier(task)
                && matches!(*leaf, "document" | "history" | "publication")
        }
        _ => false,
    }
}

fn validate_request(method: &str, path: &str, body: &[u8]) -> Result<()> {
    if path.len() > 2048
        || !path.starts_with('/')
        || path.starts_with("//")
        || path
            .bytes()
            .any(|byte| byte < 32 || byte == 127 || byte == b'\\' || byte == b'#')
        || body.len() > 16384
    {
        return refused();
    }
    let url = url::Url::parse(&format!("https://request.invalid{path}"))
        .map_err(|_| REFUSED.to_owned())?;
    let canonical = format!(
        "{}{}",
        url.path(),
        url.query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default()
    );
    if canonical != path || url.origin().ascii_serialization() != "https://request.invalid" {
        return refused();
    }
    match method {
        "GET" | "HEAD" => {
            if !body.is_empty() || !native_member_read_path(url.path()) {
                return refused();
            }
        }
        "POST" => {
            if path == "/api/account-auth/continuations/native/revoke" {
                if url.query().is_some()
                    || !serde_json::from_slice::<serde_json::Value>(body).is_ok_and(|value| {
                        value.as_object().is_some_and(|fields| fields.is_empty())
                    })
                {
                    return refused();
                }
                return Ok(());
            }
            if path == "/api/account-auth/accept-invitation" {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Invitation {
                    token: String,
                }
                let accepted: Invitation =
                    serde_json::from_slice(body).map_err(|_| REFUSED.to_owned())?;
                if url.query().is_some() || !valid_handle(&accepted.token) {
                    return refused();
                }
                return Ok(());
            }
            if url.query().is_some()
                || !matches!(
                    path,
                    "/api/account-auth/continuations/native/challenge"
                        | "/api/account-auth/continuations/native/exchange"
                )
                || !serde_json::from_slice::<serde_json::Value>(body)
                    .is_ok_and(|value| value.is_object())
            {
                return refused();
            }
        }
        _ => return refused(),
    }
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeApplicationPeerPrepared {
    version: &'static str,
    peer_handle: String,
    nonce: String,
    connection_id: String,
    expires_at: u64,
}
#[derive(Serialize)]
pub(crate) struct NativeDeviceRequestProofResult {
    version: &'static str,
    proof: String,
}
#[derive(Serialize)]
pub(crate) struct NativeApplicationPeerAnswer {
    version: &'static str,
    #[serde(flatten)]
    answer: NativeRelaySignalAnswer,
}
#[derive(Clone)]
enum Phase {
    Prepared,
    Awaiting,
    Verified(u64, u64),
    Issued(u64, u64),
}
impl Phase {
    fn transcript_current(&self, now: u64) -> bool {
        matches!(self, Self::Verified(not_before, expires) | Self::Issued(not_before, expires) if *not_before <= now && now < *expires)
    }
}
#[derive(Clone)]
struct Session {
    capture: NativeDeviceReceiptCapture,
    nonce: String,
    expires_at: u64,
    created_at: u64,
    deadline: Instant,
    offer: Option<String>,
    answer: Option<NativeRelaySignalAnswer>,
    phase: Phase,
    busy: bool,
    operation: u64,
}
#[derive(Default)]
pub(crate) struct NativeApplicationPeers(Mutex<HashMap<String, Session>>);
impl NativeApplicationPeers {
    fn snapshot(&self, handle: &str, now: u64) -> Result<Session> {
        if !valid_handle(handle) || now == 0 {
            return refused();
        }
        let mut sessions = self.0.lock().map_err(|_| REFUSED.to_owned())?;
        sessions.retain(|_, session| {
            now >= session.created_at
                && now < session.expires_at
                && Instant::now() < session.deadline
        });
        sessions
            .get(handle)
            .cloned()
            .ok_or_else(|| REFUSED.to_owned())
    }
    fn close(&self, handle: &str) -> Result<()> {
        if !valid_handle(handle) {
            return refused();
        }
        self.0
            .lock()
            .map_err(|_| REFUSED.to_owned())?
            .remove(handle);
        Ok(())
    }
    fn transition<T>(
        &self,
        handle: &str,
        now: u64,
        expected: &Session,
        operation: impl FnOnce(&mut Session) -> Result<T>,
    ) -> Result<T> {
        let mut sessions = self.0.lock().map_err(|_| REFUSED.to_owned())?;
        let session = sessions.get_mut(handle).ok_or_else(|| REFUSED.to_owned())?;
        if now < session.created_at
            || now >= session.expires_at
            || Instant::now() >= session.deadline
            || session.capture != expected.capture
        {
            return refused();
        }
        operation(session)
    }
}

trait PeerHost {
    /// Production holds profile then native authority through this callback.
    fn with_current<T>(
        &self,
        name: &str,
        revision: u64,
        operation: impl FnOnce(NativeDeviceReceiptCapture) -> Result<T>,
    ) -> Result<T>;
    fn now(&self) -> u64;
    fn open(
        &self,
        capture: &NativeDeviceReceiptCapture,
        nonce: &str,
        offer: &str,
    ) -> std::result::Result<NativeRelaySignalOpened, NativeRedemptionError>;
    fn read(
        &self,
        capture: &NativeDeviceReceiptCapture,
        nonce: &str,
    ) -> std::result::Result<NativeRelaySignalAnswer, NativeRedemptionError>;
    fn sign(&self, owner: &NativeDeviceProofKeyOwner, input: &[u8]) -> Result<Vec<u8>>;
}
struct AppPeerHost(AppHandle);
/// Share the current paired-Device/candidate/receipt owner with fixed native
/// protocol operations. The existing profile and native authority locks span
/// the callback; network work must happen outside it, with a fresh callback
/// and full capture comparison before any result is committed or returned.
pub(crate) fn with_current_reconciled_native_device_owner<T>(
    app: &AppHandle,
    name: &str,
    revision: u64,
    operation: impl FnOnce(NativeDeviceReceiptCapture) -> Result<T>,
) -> Result<T> {
    native_relay_redemption::with_existing_native_device_candidate(
        app,
        name,
        revision,
        |capture| {
            let observation = NativeDeviceBindingCandidateManager::system()
                .receipt_observation(&capture.authority, &capture.candidate)?;
            if !observation
                .is_some_and(|value| value.status == NativeDeviceReceiptObservation::Current)
            {
                return refused();
            }
            // Preserve bounded operation outcomes (busy/ambiguous transport) while
            // the custody owner keeps its own lookup failures sanitized.
            Ok(operation(capture))
        },
    )?
}
impl PeerHost for AppPeerHost {
    fn with_current<T>(
        &self,
        name: &str,
        revision: u64,
        operation: impl FnOnce(NativeDeviceReceiptCapture) -> Result<T>,
    ) -> Result<T> {
        with_current_reconciled_native_device_owner(&self.0, name, revision, operation)
    }
    fn now(&self) -> u64 {
        now_ms()
    }
    fn open(
        &self,
        capture: &NativeDeviceReceiptCapture,
        nonce: &str,
        offer: &str,
    ) -> std::result::Result<NativeRelaySignalOpened, NativeRedemptionError> {
        native_relay_redemption::native_application_signal_open(
            self.0.clone(),
            NativeRelaySignalOpenRequest {
                profile_name: capture.context.profile.profile_name.clone(),
                expected_profile_revision: capture.context.profile.revision,
                nonce: nonce.to_owned(),
                offer_sdp: offer.to_owned(),
            },
        )
    }
    fn read(
        &self,
        capture: &NativeDeviceReceiptCapture,
        nonce: &str,
    ) -> std::result::Result<NativeRelaySignalAnswer, NativeRedemptionError> {
        native_relay_redemption::native_application_signal_read(
            self.0.clone(),
            NativeRelaySignalReadRequest {
                profile_name: capture.context.profile.profile_name.clone(),
                expected_profile_revision: capture.context.profile.revision,
                nonce: nonce.to_owned(),
            },
        )
    }
    fn sign(&self, owner: &NativeDeviceProofKeyOwner, input: &[u8]) -> Result<Vec<u8>> {
        NativeDeviceProofKeyVault::new()
            .sign_es256_p1363(owner, input)
            .map_err(|_| REFUSED.to_owned())
    }
}

struct PeerService<'a, H> {
    peers: &'a NativeApplicationPeers,
    host: &'a H,
}
impl<H: PeerHost> PeerService<'_, H> {
    fn prepare(&self, name: &str, revision: u64) -> Result<NativeApplicationPeerPrepared> {
        let handle = random_id()?;
        let nonce = random_id()?;
        self.host.with_current(name, revision, |capture| {
            let now = self.host.now();
            let url = url::Url::parse(&capture.station_origin).map_err(|_| REFUSED.to_owned())?;
            if now == 0
                || now > MAX_SAFE_INTEGER
                || capture.grant_expires_at <= now
                || url.origin().ascii_serialization() != capture.station_origin
                || !(url.scheme() == "https"
                    || (url.scheme() == "http"
                        && matches!(
                            url.host_str(),
                            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
                        )))
            {
                return refused();
            }
            let expires_at = now
                .saturating_add(PEER_LIFETIME_MS)
                .min(capture.grant_expires_at);
            let connection_id = capture.context.profile.client_instance_id.clone();
            let mut sessions = self.peers.0.lock().map_err(|_| REFUSED.to_owned())?;
            sessions.retain(|_, session| {
                now >= session.created_at
                    && now < session.expires_at
                    && Instant::now() < session.deadline
            });
            if sessions.len() >= MAX_PEERS || sessions.contains_key(&handle) {
                return refused();
            }
            sessions.insert(
                handle.clone(),
                Session {
                    capture,
                    nonce: nonce.clone(),
                    expires_at,
                    created_at: now,
                    deadline: Instant::now() + Duration::from_millis(expires_at - now),
                    offer: None,
                    answer: None,
                    phase: Phase::Prepared,
                    busy: false,
                    operation: 0,
                },
            );
            Ok(NativeApplicationPeerPrepared {
                version: "station-native-application-peer/v1",
                peer_handle: handle,
                nonce,
                connection_id,
                expires_at,
            })
        })
    }
    fn current<T>(
        &self,
        handle: &str,
        snapshot: &Session,
        operation: impl FnOnce(&mut Session) -> Result<T>,
    ) -> Result<T> {
        let result = self.host.with_current(
            &snapshot.capture.context.profile.profile_name,
            snapshot.capture.context.profile.revision,
            |capture| {
                if capture != snapshot.capture {
                    return refused();
                }
                self.peers
                    .transition(handle, self.host.now(), snapshot, operation)
            },
        );
        if result.as_ref().is_err_and(|error| {
            error != BUSY
                && error != "native_application_peer_open_unknown"
                && error != "native_application_peer_read_unavailable"
        }) {
            let _ = self.peers.close(handle);
        }
        result
    }
    fn start(
        &self,
        handle: &str,
        snapshot: &Session,
        operation: impl FnOnce(&mut Session) -> Result<()>,
    ) -> Result<u64> {
        self.current(handle, snapshot, |session| {
            if session.busy {
                return Err(BUSY.into());
            }
            operation(session)?;
            session.busy = true;
            session.operation += 1;
            Ok(session.operation)
        })
    }
    fn finish<T>(
        &self,
        handle: &str,
        snapshot: &Session,
        token: u64,
        operation: impl FnOnce(&mut Session) -> Result<T>,
    ) -> Result<T> {
        self.current(handle, snapshot, |session| {
            if !session.busy || session.operation != token {
                return refused();
            }
            session.busy = false;
            operation(session)
        })
    }
    fn open(&self, handle: &str, offer: &str) -> Result<NativeRelaySignalOpened> {
        if fingerprint(offer).is_err() {
            let _ = self.peers.close(handle);
            return refused();
        }
        let snapshot = self.peers.snapshot(handle, self.host.now())?;
        if snapshot
            .offer
            .as_ref()
            .is_some_and(|before| before != offer)
        {
            let _ = self.peers.close(handle);
            return refused();
        }
        let token = self.start(handle, &snapshot, |session| {
            if !matches!(session.phase, Phase::Prepared) || session.offer.is_some() {
                return refused();
            }
            session.offer = Some(offer.to_owned());
            session.phase = Phase::Awaiting;
            Ok(())
        })?;
        let result = self.host.open(&snapshot.capture, &snapshot.nonce, offer);
        self.finish(handle, &snapshot, token, |session| match result {
            Ok(mut opened)
                if opened.expires_at > self.host.now()
                    && opened.expires_at <= snapshot.capture.grant_expires_at =>
            {
                session.expires_at = session.expires_at.min(opened.expires_at);
                session.deadline = session.deadline.min(
                    Instant::now()
                        + Duration::from_millis(session.expires_at.saturating_sub(self.host.now())),
                );
                opened.expires_at = session.expires_at;
                Ok(opened)
            }
            Err(NativeRedemptionError::BrokerTransport) => {
                Err("native_application_peer_open_unknown".into())
            }
            _ => refused(),
        })
    }
    fn read(&self, handle: &str) -> Result<NativeRelaySignalAnswer> {
        let snapshot = self.peers.snapshot(handle, self.host.now())?;
        if snapshot.answer.is_some() {
            return self.current(handle, &snapshot, |session| {
                if session.busy {
                    return Err(BUSY.into());
                }
                if !session.phase.transcript_current(self.host.now() / 1000) {
                    return refused();
                }
                session.answer.clone().ok_or_else(|| REFUSED.to_owned())
            });
        }
        let token = self.start(handle, &snapshot, |session| {
            if !matches!(session.phase, Phase::Awaiting) {
                return refused();
            }
            Ok(())
        })?;
        let result = self.host.read(&snapshot.capture, &snapshot.nonce);
        let verified = match &result {
            Ok(answer) if answer.answer_sdp.is_some() || answer.station_proof.is_some() => {
                Some(verify_transcript(
                    &snapshot.capture,
                    &snapshot.nonce,
                    snapshot
                        .offer
                        .as_deref()
                        .ok_or_else(|| REFUSED.to_owned())?,
                    answer,
                    self.host.now() / 1000,
                ))
            }
            _ => None,
        };
        self.finish(handle, &snapshot, token, |session| {
            let mut answer = result.map_err(|error| {
                if error == NativeRedemptionError::BrokerTransport {
                    "native_application_peer_read_unavailable".to_owned()
                } else {
                    REFUSED.to_owned()
                }
            })?;
            if answer.expires_at <= self.host.now()
                || answer.expires_at > snapshot.capture.grant_expires_at
            {
                return refused();
            }
            session.expires_at = session.expires_at.min(answer.expires_at);
            if let Some(verified) = verified {
                let (not_before, expires) = verified?;
                if self.host.now() / 1000 < not_before || self.host.now() / 1000 >= expires {
                    return refused();
                }
                session.expires_at = session.expires_at.min(expires * 1000);
                session.phase = Phase::Verified(not_before, expires);
                answer.expires_at = session.expires_at;
                session.answer = Some(answer.clone());
            }
            session.deadline = session.deadline.min(
                Instant::now()
                    + Duration::from_millis(session.expires_at.saturating_sub(self.host.now())),
            );
            answer.expires_at = session.expires_at;
            Ok(answer)
        })
    }
    fn sign(
        &self,
        handle: &str,
        method: &str,
        path: &str,
        body: &[u8],
    ) -> Result<NativeDeviceRequestProofResult> {
        if validate_request(method, path, body).is_err() {
            let _ = self.peers.close(handle);
            return refused();
        }
        let snapshot = self.peers.snapshot(handle, self.host.now())?;
        let token = self.start(handle, &snapshot, |session| {
            if !matches!(session.phase, Phase::Verified(not_before, expires) if not_before <= self.host.now() / 1000 && self.host.now() / 1000 < expires) { return refused(); } Ok(())
        })?;
        let result = (|| {
            let candidate = &snapshot.capture.candidate;
            let now = self.host.now() / 1000;
            let exp = (now + 30).min(snapshot.expires_at / 1000);
            if exp <= now {
                return refused();
            }
            let header = URL_SAFE_NO_PAD
                .encode(br#"{"alg":"ES256","typ":"station-native-device-request+jws"}"#);
            let claims = json!({
                "version": "station-native-device-proof/v1", "aud": snapshot.capture.station_origin,
                "purpose": "request", "stationId": candidate.station_id, "deviceId": candidate.device_id,
                "bindingId": candidate.binding_id, "deviceProofKeyThumbprint": candidate.device_proof_key_thumbprint,
                "surface": candidate.surface, "peerNonce": snapshot.nonce,
                "htm": method, "htu": path, "bodySha256": sha256(body), "jti": random_id()?, "iat": now, "exp": exp,
            });
            let payload = URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&claims).map_err(|_| REFUSED.to_owned())?);
            let input = format!("{header}.{payload}");
            let owner = snapshot.capture.authority.proof_key_owner(candidate)?;
            let signature = self.host.sign(&owner, input.as_bytes())?;
            let proof = format!("{input}.{}", URL_SAFE_NO_PAD.encode(&signature));
            if signature.len() != 64 || proof.len() > 4096 {
                return refused();
            }
            Ok(proof)
        })();
        self.finish(handle, &snapshot, token, |session| {
            let proof = result?;
            let Phase::Verified(not_before, expires) = session.phase else {
                return refused();
            };
            if self.host.now() / 1000 < not_before || self.host.now() / 1000 >= expires {
                return refused();
            }
            session.phase = Phase::Issued(not_before, expires);
            Ok(NativeDeviceRequestProofResult {
                version: "station-native-device-request-proof-result/v1",
                proof,
            })
        })
    }
}

fn with_service<T>(
    app: AppHandle,
    operation: impl FnOnce(PeerService<'_, AppPeerHost>) -> Result<T>,
) -> Result<T> {
    let peers = app.state::<NativeApplicationPeers>();
    let host = AppPeerHost(app.clone());
    operation(PeerService {
        peers: &peers,
        host: &host,
    })
}
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_application_peer_prepare(
    window: tauri::WebviewWindow,
    app: AppHandle,
    profile_name: String,
    expected_profile_revision: u64,
) -> Result<NativeApplicationPeerPrepared> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    if profile_name.trim().is_empty()
        || profile_name.len() > 256
        || expected_profile_revision == 0
        || expected_profile_revision > MAX_SAFE_INTEGER
    {
        return refused();
    }
    tauri::async_runtime::spawn_blocking(move || {
        with_service(app, |service| {
            service.prepare(&profile_name, expected_profile_revision)
        })
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_application_peer_open(
    window: tauri::WebviewWindow,
    app: AppHandle,
    peer_handle: String,
    offer_sdp: String,
) -> Result<NativeRelaySignalOpened> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_service(app, |service| service.open(&peer_handle, &offer_sdp))
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_application_peer_read(
    window: tauri::WebviewWindow,
    app: AppHandle,
    peer_handle: String,
) -> Result<NativeApplicationPeerAnswer> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_service(app, |service| {
            service
                .read(&peer_handle)
                .map(|answer| NativeApplicationPeerAnswer {
                    version: "station-broker-native-connection-answer/v2",
                    answer,
                })
        })
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_application_peer_sign(
    window: tauri::WebviewWindow,
    app: AppHandle,
    peer_handle: String,
    method: String,
    path: String,
    body: Vec<u8>,
) -> Result<NativeDeviceRequestProofResult> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_service(app, |service| {
            service.sign(&peer_handle, &method, &path, &body)
        })
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_application_peer_close(
    window: tauri::WebviewWindow,
    app: AppHandle,
    peer_handle: String,
) -> Result<()> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<NativeApplicationPeers>().close(&peer_handle)
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_device_binding_candidate::{
        NativeDeviceBindingCandidateAuthority, NativeDeviceBindingRouteV1,
        NativeDeviceBindingSurfaceV1, NativeDeviceProofSelfReceiptBindingV1,
        NativeDeviceProofSelfReceiptV1, NativeDeviceReceiptBindingState,
    };
    use crate::native_device_proof_key::MemoryNativeDeviceProofKeyVault;
    use crate::native_proof_key_core::MemorySecretBackend;
    use crate::native_relay_proof_key::NativeProofKeyChannel;
    use crate::native_relay_redemption::{
        ApprovedNativeStationTrust, NativeRedemptionContext, NativeRelayProfileSnapshot,
        NativeStationTrustStatus,
    };
    use ring::signature::{EcdsaKeyPair, KeyPair as _, ECDSA_P256_SHA256_FIXED_SIGNING};
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Barrier,
    };

    const STATION: &str = "11111111-1111-4111-8111-111111111111";
    const DEVICE: &str = "22222222-2222-4222-8222-222222222222";
    const CLIENT: &str = "33333333-3333-4333-8333-333333333333";
    const ENROLLMENT: &str = "44444444-4444-4444-8444-444444444444";
    const EPOCH: &str = "55555555-5555-4555-8555-555555555555";

    fn sdp(byte: &str) -> String {
        format!(
            "v=0\r\na=fingerprint:sha-256 {}\r\n",
            vec![byte; 32].join(":")
        )
    }
    fn pair() -> EcdsaKeyPair {
        let rng = SystemRandom::new();
        let key = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, key.as_ref(), &rng).unwrap()
    }
    fn jwk(pair: &EcdsaKeyPair) -> P256PublicJwk {
        let point = pair.public_key().as_ref();
        P256PublicJwk::from_verified_p256_coordinates(
            URL_SAFE_NO_PAD.encode(&point[1..33]),
            URL_SAFE_NO_PAD.encode(&point[33..]),
        )
    }
    fn authority(epoch: &str) -> NativeDeviceBindingCandidateAuthority {
        NativeDeviceBindingCandidateAuthority::from_current_owners(
            "Fixture".into(),
            1,
            2,
            epoch.into(),
            "dev.station.peer-fixture".into(),
            NativeProofKeyChannel::Dev,
            CLIENT.into(),
            STATION.into(),
            DEVICE.into(),
            NativeDeviceBindingSurfaceV1::from_current_route(
                "station-native".into(),
                "dev.station.peer-fixture".into(),
                "dev".into(),
                CLIENT.into(),
                sha256(b"route-key"),
            ),
            NativeDeviceBindingRouteV1::from_current_route(
                "https://broker.test".into(),
                STATION.into(),
                ENROLLMENT.into(),
                3,
                "fixture-grant".into(),
            ),
        )
    }
    #[derive(Clone, Copy)]
    enum Fault {
        None,
        LostOpen,
        PendingRead,
        WrongKey,
        WrongNonce,
        WrongDigest,
        WrongAnswerDigest,
        WrongFingerprint,
        WrongClientFingerprint,
        AmbiguousAnswer,
        WrongStation,
        WrongConnection,
        WrongEnrollment,
        WrongGeneration,
        ExtraClaim,
        ExtraHeader,
        DuplicateClaim,
        PaddedHeader,
        WrongAudience,
        WrongIssuer,
        WrongKid,
        BadNbf,
        Expired,
        LongLifetime,
        HalfAnswer,
        OwnerDuringRead,
        OwnerDuringSign,
        KeyDuringSign,
    }
    struct MemoryHost {
        owned: Mutex<NativeDeviceReceiptCapture>,
        manager: NativeDeviceBindingCandidateManager<MemorySecretBackend>,
        keys: MemoryNativeDeviceProofKeyVault,
        station_key: EcdsaKeyPair,
        other_key: EcdsaKeyPair,
        now: AtomicU64,
        fault: Mutex<Fault>,
        offers: Mutex<HashMap<String, String>>,
        open_gate: Mutex<Option<Arc<Barrier>>>,
        sign_gate: Mutex<Option<Arc<Barrier>>>,
    }
    impl MemoryHost {
        fn new() -> Self {
            let manager = NativeDeviceBindingCandidateManager::new(MemorySecretBackend::default());
            let keys = MemoryNativeDeviceProofKeyVault::new();
            let authority = authority(EPOCH);
            let candidate = manager.candidate(&authority, &keys).unwrap();
            let receipt = NativeDeviceProofSelfReceiptV1 {
                version: "station-native-device-proof-self-receipt/v1".into(),
                binding: NativeDeviceProofSelfReceiptBindingV1 {
                    station_id: STATION.into(),
                    device_id: DEVICE.into(),
                    binding_id: candidate.binding_id.clone(),
                    surface: candidate.surface.clone(),
                    device_proof_jwk: candidate.device_proof_jwk.clone(),
                    device_proof_key_thumbprint: candidate.device_proof_key_thumbprint.clone(),
                    state: NativeDeviceReceiptBindingState::Active,
                    created_at: 99_000,
                    approved_at: 100_000,
                    revoked_at: None,
                    revocation_reason: None,
                },
                current_device_binding: true,
            };
            // The Station approval is the external premise; the real receipt validator
            // and durable candidate owner reconcile it before the peer owner runs.
            let observation = candidate.validate_self_receipt(&receipt).unwrap();
            manager
                .record_receipt_observation(&authority, &candidate, EPOCH, observation, 100_000)
                .unwrap();
            let station_key = pair();
            let owned = NativeDeviceReceiptCapture {
                authority,
                candidate,
                station_origin: "https://station.test".into(),
                context: NativeRedemptionContext {
                    profile: NativeRelayProfileSnapshot {
                        revision: 1,
                        profile_name: "Fixture".into(),
                        station_endpoint: "https://station.test".into(),
                        broker_origin: "https://broker.test".into(),
                        station_id: STATION.into(),
                        enrollment_id: ENROLLMENT.into(),
                        app_identifier: "dev.station.peer-fixture".into(),
                        channel: NativeProofKeyChannel::Dev,
                        client_instance_id: CLIENT.into(),
                    },
                    station_trust: ApprovedNativeStationTrust {
                        revision: 2,
                        status: NativeStationTrustStatus::Approved,
                        station_endpoint: "https://station.test".into(),
                        station_id: STATION.into(),
                        enrollment_id: ENROLLMENT.into(),
                        generation: 4,
                        signing_key: jwk(&station_key),
                    },
                },
                grant_digest: sha256(b"owned grant"),
                grant_expires_at: 1_000_000,
            };
            Self {
                owned: Mutex::new(owned),
                manager,
                keys,
                station_key,
                other_key: pair(),
                now: AtomicU64::new(100_000),
                fault: Mutex::new(Fault::None),
                offers: Mutex::new(HashMap::new()),
                open_gate: Mutex::new(None),
                sign_gate: Mutex::new(None),
            }
        }
        fn set_fault(&self, fault: Fault) {
            *self.fault.lock().unwrap() = fault;
        }
        fn retire_owner(&self) {
            self.owned.lock().unwrap().context.profile.revision += 1;
        }
        fn answer(
            &self,
            capture: &NativeDeviceReceiptCapture,
            nonce: &str,
            offer: &str,
        ) -> NativeRelaySignalAnswer {
            let fault = *self.fault.lock().unwrap();
            let answer = if matches!(fault, Fault::AmbiguousAnswer) {
                sdp("BB") + &sdp("CC")
            } else {
                sdp("BB")
            };
            let mut header = json!({ "alg": "ES256", "typ": "station-connection-proof+jwt", "kid": key_id(&capture.context.station_trust.signing_key) });
            let mut claims = json!({ "version": 1, "iss": format!("urn:station:{STATION}"), "aud": "urn:station:connection-proof:v1",
                "iat": self.now() / 1000, "nbf": self.now() / 1000, "exp": self.now() / 1000 + 30,
                "jti": uuid::Uuid::new_v4().to_string(), "binding": {
                    "stationId": STATION, "enrollmentId": ENROLLMENT, "generation": 4, "connectionId": CLIENT,
                    "clientNonce": nonce, "clientFingerprint": vec!["AA"; 32].join(":"), "stationFingerprint": vec!["BB"; 32].join(":"),
                    "offerSha256": sha256(offer.as_bytes()), "answerSha256": sha256(answer.as_bytes()),
                } });
            match fault {
                Fault::WrongNonce => {
                    let other = self
                        .offers
                        .lock()
                        .unwrap()
                        .keys()
                        .find(|id| id.as_str() != nonce)
                        .cloned()
                        .unwrap_or_else(|| sha256(b"another peer"));
                    claims["binding"]["clientNonce"] = json!(other)
                }
                Fault::WrongDigest => {
                    claims["binding"]["offerSha256"] = json!(sha256(b"other offer"))
                }
                Fault::WrongAnswerDigest => {
                    claims["binding"]["answerSha256"] = json!(sha256(b"other answer"))
                }
                Fault::WrongStation => {
                    claims["binding"]["stationId"] = json!(uuid::Uuid::new_v4().to_string())
                }
                Fault::WrongConnection => {
                    claims["binding"]["connectionId"] = json!(uuid::Uuid::new_v4().to_string())
                }
                Fault::WrongClientFingerprint => {
                    claims["binding"]["clientFingerprint"] = json!(vec!["CC"; 32].join(":"))
                }
                Fault::WrongFingerprint => {
                    claims["binding"]["stationFingerprint"] = json!(vec!["CC"; 32].join(":"))
                }
                Fault::WrongEnrollment => {
                    claims["binding"]["enrollmentId"] = json!(uuid::Uuid::new_v4().to_string())
                }
                Fault::WrongGeneration => claims["binding"]["generation"] = json!(3),
                Fault::ExtraClaim => claims["accountAuthority"] = json!(true),
                Fault::ExtraHeader => {
                    header["jwk"] = json!(capture.context.station_trust.signing_key)
                }
                Fault::WrongAudience => claims["aud"] = json!("foreign"),
                Fault::WrongIssuer => claims["iss"] = json!("urn:station:foreign"),
                Fault::WrongKid => header["kid"] = json!(sha256(b"wrong key")),
                Fault::BadNbf => claims["nbf"] = json!(self.now() / 1000 + 1),
                Fault::Expired => {
                    claims["iat"] = json!(self.now() / 1000 - 30);
                    claims["nbf"] = claims["iat"].clone();
                    claims["exp"] = json!(self.now() / 1000);
                }
                Fault::LongLifetime => claims["exp"] = json!(self.now() / 1000 + 31),
                _ => {}
            }
            let mut header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap());
            if matches!(fault, Fault::PaddedHeader) {
                header.push('=');
            }
            let mut payload = serde_json::to_string(&claims).unwrap();
            if matches!(fault, Fault::DuplicateClaim) {
                payload = payload.replacen("\"version\":1", "\"version\":1,\"version\":1", 1);
            }
            let input = format!("{header}.{}", URL_SAFE_NO_PAD.encode(payload));
            let key = if matches!(fault, Fault::WrongKey) {
                &self.other_key
            } else {
                &self.station_key
            };
            let signature = key.sign(&SystemRandom::new(), input.as_bytes()).unwrap();
            NativeRelaySignalAnswer {
                answer_sdp: Some(answer),
                station_proof: if matches!(fault, Fault::HalfAnswer) {
                    None
                } else {
                    Some(format!(
                        "{input}.{}",
                        URL_SAFE_NO_PAD.encode(signature.as_ref())
                    ))
                },
                expires_at: self.now() + 30_000,
            }
        }
    }
    impl PeerHost for MemoryHost {
        fn with_current<T>(
            &self,
            name: &str,
            revision: u64,
            operation: impl FnOnce(NativeDeviceReceiptCapture) -> Result<T>,
        ) -> Result<T> {
            let owned = self.owned.lock().unwrap();
            if owned.context.profile.profile_name != name
                || owned.context.profile.revision != revision
            {
                return refused();
            }
            let mut current = owned.clone();
            current.candidate = self
                .manager
                .existing_candidate(&current.authority, &self.keys)?;
            if !self
                .manager
                .receipt_observation(&current.authority, &current.candidate)?
                .is_some_and(|value| value.status == NativeDeviceReceiptObservation::Current)
            {
                return refused();
            }
            operation(current)
        }
        fn now(&self) -> u64 {
            self.now.load(Ordering::SeqCst)
        }
        fn open(
            &self,
            _capture: &NativeDeviceReceiptCapture,
            nonce: &str,
            offer: &str,
        ) -> std::result::Result<NativeRelaySignalOpened, NativeRedemptionError> {
            self.offers
                .lock()
                .unwrap()
                .insert(nonce.into(), offer.into());
            let gate = self.open_gate.lock().unwrap().clone();
            if let Some(gate) = gate {
                gate.wait();
                gate.wait();
            }
            if matches!(*self.fault.lock().unwrap(), Fault::LostOpen) {
                return Err(NativeRedemptionError::BrokerTransport);
            }
            Ok(NativeRelaySignalOpened {
                expires_at: self.now() + 30_000,
            })
        }
        fn read(
            &self,
            capture: &NativeDeviceReceiptCapture,
            nonce: &str,
        ) -> std::result::Result<NativeRelaySignalAnswer, NativeRedemptionError> {
            let offer = self
                .offers
                .lock()
                .unwrap()
                .get(nonce)
                .cloned()
                .ok_or(NativeRedemptionError::BrokerRejected)?;
            if matches!(*self.fault.lock().unwrap(), Fault::PendingRead) {
                return Ok(NativeRelaySignalAnswer {
                    answer_sdp: None,
                    station_proof: None,
                    expires_at: self.now() + 30_000,
                });
            }
            let answer = self.answer(capture, nonce, &offer);
            if matches!(*self.fault.lock().unwrap(), Fault::OwnerDuringRead) {
                self.retire_owner();
            }
            Ok(answer)
        }
        fn sign(&self, owner: &NativeDeviceProofKeyOwner, input: &[u8]) -> Result<Vec<u8>> {
            let signature = self
                .keys
                .sign_es256_p1363(owner, input)
                .map_err(|_| REFUSED.to_owned())?;
            let gate = self.sign_gate.lock().unwrap().clone();
            if let Some(gate) = gate {
                gate.wait();
                gate.wait();
            }
            match *self.fault.lock().unwrap() {
                Fault::OwnerDuringSign => self.retire_owner(),
                Fault::KeyDuringSign => {
                    self.keys.replace(owner).unwrap();
                }
                _ => {}
            }
            Ok(signature)
        }
    }
    fn opened(service: &PeerService<'_, MemoryHost>) -> NativeApplicationPeerPrepared {
        let prepared = service.prepare("Fixture", 1).unwrap();
        service.open(&prepared.peer_handle, &sdp("AA")).unwrap();
        prepared
    }
    fn verified(service: &PeerService<'_, MemoryHost>) -> NativeApplicationPeerPrepared {
        let prepared = opened(service);
        let answer = service.read(&prepared.peer_handle).unwrap();
        assert!(answer.station_proof.is_some());
        prepared
    }

    #[test]
    fn native_revoke_request_signing_has_one_empty_body_post_leaf() {
        let path = "/api/account-auth/continuations/native/revoke";
        assert!(validate_request("POST", path, b"{}").is_ok());
        for body in [b"[]".as_slice(), b"{\"deviceId\":\"other\"}", b""] {
            assert!(validate_request("POST", path, body).is_err());
        }
        assert!(validate_request("POST", &format!("{path}?other=1"), b"{}").is_err());
        assert!(validate_request("GET", path, b"{}").is_err());
    }

    #[test]
    fn member_read_policy_is_exact_and_never_allows_request_bodies_or_write_leaves() {
        for path in [
            "/.well-known/station/v1",
            "/api/system/status",
            "/api/system/identity",
            "/api/auth/authority",
            "/api/projects",
            "/api/projects/demo",
            "/api/projects/demo/shared-work",
            "/api/projects/demo/shared-work/task_1/document",
            "/api/projects/demo/shared-work/task_1/history",
            "/api/projects/demo/shared-work/task_1/publication",
        ] {
            assert!(native_member_read_path(path));
            assert!(validate_request("GET", path, &[]).is_ok());
            assert!(validate_request("HEAD", path, &[]).is_ok());
            assert!(validate_request("GET", path, b"body").is_err());
        }
        for path in [
            "/api/pairing/devices",
            "/api/config",
            "/api/projects/demo/git/status",
            "/api/projects/demo/shared-work/task_1/messages",
            "/api/projects/demo/shared-work/task_1/document/extra",
            "/api/projects/%2Fadmin",
        ] {
            assert!(!native_member_read_path(path));
            assert!(validate_request("GET", path, &[]).is_err());
        }
        assert!(validate_request(
            "POST",
            "/api/projects/demo/shared-work/task_1/document",
            br#"{}"#
        )
        .is_err());
    }

    #[test]
    fn verified_peer_signs_exact_request_once_with_the_distinct_device_key() {
        let host = MemoryHost::new();
        let peers = NativeApplicationPeers::default();
        let service = PeerService {
            peers: &peers,
            host: &host,
        };
        let prepared = verified(&service);
        let signed = service
            .sign(
                &prepared.peer_handle,
                "GET",
                "/api/projects/demo?view=exact%2Bbytes",
                &[],
            )
            .unwrap();
        let parts: Vec<_> = signed.proof.split('.').collect();
        let claims: serde_json::Value = serde_json::from_slice(&decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["peerNonce"], prepared.nonce);
        assert_eq!(claims["htu"], "/api/projects/demo?view=exact%2Bbytes");
        assert_eq!(claims["bodySha256"], sha256(&[]));
        assert_eq!(
            claims["bindingId"],
            host.owned.lock().unwrap().candidate.binding_id
        );
        let owned = host.owned.lock().unwrap().clone();
        signature::UnparsedPublicKey::new(
            &signature::ECDSA_P256_SHA256_FIXED,
            point(&owned.candidate.device_proof_jwk).unwrap(),
        )
        .verify(
            format!("{}.{}", parts[0], parts[1]).as_bytes(),
            &decode(parts[2]).unwrap(),
        )
        .unwrap();
        assert!(signature::UnparsedPublicKey::new(
            &signature::ECDSA_P256_SHA256_FIXED,
            point(&owned.context.station_trust.signing_key).unwrap()
        )
        .verify(
            format!("{}.{}", parts[0], parts[1]).as_bytes(),
            &decode(parts[2]).unwrap()
        )
        .is_err());
        assert!(service
            .sign(&prepared.peer_handle, "GET", "/api/projects", &[])
            .is_err());
        if let Ok(path) = std::env::var("STATION_NATIVE_PEER_COMPAT_PATH") {
            let artifact = json!({ "proof": signed.proof, "publicKey": owned.candidate.device_proof_jwk,
                "binding": { "stationId": STATION, "stationAudience": owned.station_origin, "deviceId": DEVICE,
                    "bindingId": owned.candidate.binding_id, "deviceProofKeyThumbprint": owned.candidate.device_proof_key_thumbprint,
                    "surface": owned.candidate.surface, "peerNonce": prepared.nonce },
                "request": { "method": "GET", "path": "/api/projects/demo?view=exact%2Bbytes", "body": [] }, "now": host.now() / 1000 });
            std::fs::write(path, serde_json::to_vec(&artifact).unwrap()).unwrap();
        }
    }

    #[test]
    fn connection_proof_crypto_closed_claims_expiry_and_binding_fail_closed() {
        for fault in [
            Fault::WrongKey,
            Fault::WrongNonce,
            Fault::WrongDigest,
            Fault::WrongAnswerDigest,
            Fault::WrongFingerprint,
            Fault::WrongClientFingerprint,
            Fault::AmbiguousAnswer,
            Fault::WrongStation,
            Fault::WrongConnection,
            Fault::WrongEnrollment,
            Fault::WrongGeneration,
            Fault::ExtraClaim,
            Fault::ExtraHeader,
            Fault::DuplicateClaim,
            Fault::PaddedHeader,
            Fault::WrongAudience,
            Fault::WrongIssuer,
            Fault::WrongKid,
            Fault::BadNbf,
            Fault::Expired,
            Fault::LongLifetime,
            Fault::HalfAnswer,
        ] {
            let host = MemoryHost::new();
            let peers = NativeApplicationPeers::default();
            let service = PeerService {
                peers: &peers,
                host: &host,
            };
            let prepared = opened(&service);
            host.set_fault(fault);
            assert!(service.read(&prepared.peer_handle).is_err());
            assert!(service
                .sign(&prepared.peer_handle, "GET", "/api/projects", &[])
                .is_err());
            assert!(peers.snapshot(&prepared.peer_handle, host.now()).is_err());
        }
    }

    #[test]
    fn lost_open_and_pending_read_recover_the_same_nonce_without_reopening() {
        let host = MemoryHost::new();
        let peers = NativeApplicationPeers::default();
        let service = PeerService {
            peers: &peers,
            host: &host,
        };
        let prepared = service.prepare("Fixture", 1).unwrap();
        host.set_fault(Fault::LostOpen);
        assert_eq!(
            service.open(&prepared.peer_handle, &sdp("AA")).unwrap_err(),
            "native_application_peer_open_unknown"
        );
        host.set_fault(Fault::PendingRead);
        assert!(service
            .read(&prepared.peer_handle)
            .unwrap()
            .answer_sdp
            .is_none());
        host.set_fault(Fault::None);
        assert!(service
            .read(&prepared.peer_handle)
            .unwrap()
            .station_proof
            .is_some());
        assert!(service
            .sign(&prepared.peer_handle, "HEAD", "/api/projects", &[])
            .is_ok());
        assert_eq!(
            host.offers.lock().unwrap().keys().collect::<Vec<_>>(),
            vec![&prepared.nonce]
        );
    }

    #[test]
    fn changed_or_ambiguous_offer_and_cross_peer_proof_retire_the_handle() {
        let host = MemoryHost::new();
        let peers = NativeApplicationPeers::default();
        let service = PeerService {
            peers: &peers,
            host: &host,
        };
        let first = opened(&service);
        let other = opened(&service);
        host.set_fault(Fault::WrongNonce);
        assert!(service.read(&other.peer_handle).is_err());
        host.set_fault(Fault::None);
        assert!(service.open(&first.peer_handle, &sdp("CC")).is_err());
        assert!(service.read(&first.peer_handle).is_err());
        let ambiguous = service.prepare("Fixture", 1).unwrap();
        assert!(service
            .open(&ambiguous.peer_handle, &(sdp("AA") + &sdp("BB")))
            .is_err());
        assert!(!host.offers.lock().unwrap().contains_key(&ambiguous.nonce));
    }

    #[test]
    fn no_current_receipt_owner_epoch_key_or_route_can_be_reconstructed() {
        for change in 0..5 {
            let host = MemoryHost::new();
            let peers = NativeApplicationPeers::default();
            let service = PeerService {
                peers: &peers,
                host: &host,
            };
            let prepared = verified(&service);
            match change {
                0 => host.retire_owner(),
                1 => {
                    host.owned.lock().unwrap().authority =
                        authority("66666666-6666-4666-8666-666666666666")
                }
                2 => {
                    let owned = host.owned.lock().unwrap();
                    let owner = owned.authority.proof_key_owner(&owned.candidate).unwrap();
                    host.keys.replace(&owner).unwrap();
                }
                3 => host.owned.lock().unwrap().grant_digest = sha256(b"replaced grant"),
                _ => {
                    let owned = host.owned.lock().unwrap();
                    host.manager
                        .record_receipt_observation(
                            &owned.authority,
                            &owned.candidate,
                            EPOCH,
                            NativeDeviceReceiptObservation::NotCurrent,
                            host.now(),
                        )
                        .unwrap();
                }
            }
            assert!(service
                .sign(&prepared.peer_handle, "GET", "/api/projects", &[])
                .is_err());
            assert!(peers.snapshot(&prepared.peer_handle, host.now()).is_err());
        }
    }

    #[test]
    fn prepare_requires_a_positive_reconciled_observation_on_the_current_epoch() {
        for status in [
            NativeDeviceReceiptObservation::NotCurrent,
            NativeDeviceReceiptObservation::NotFound,
            NativeDeviceReceiptObservation::Unavailable,
        ] {
            let host = MemoryHost::new();
            let peers = NativeApplicationPeers::default();
            let service = PeerService {
                peers: &peers,
                host: &host,
            };
            let owned = host.owned.lock().unwrap().clone();
            host.manager
                .record_receipt_observation(
                    &owned.authority,
                    &owned.candidate,
                    EPOCH,
                    status,
                    host.now(),
                )
                .unwrap();
            assert!(service.prepare("Fixture", 1).is_err());
            assert!(peers.0.lock().unwrap().is_empty());
            assert!(host.offers.lock().unwrap().is_empty());
        }
        let host = MemoryHost::new();
        let peers = NativeApplicationPeers::default();
        let service = PeerService {
            peers: &peers,
            host: &host,
        };
        host.owned.lock().unwrap().authority = authority("66666666-6666-4666-8666-666666666666");
        assert!(service.prepare("Fixture", 1).is_err());
    }

    #[test]
    fn close_while_crypto_waits_and_clock_rollback_cannot_release_a_proof() {
        let host = MemoryHost::new();
        let peers = NativeApplicationPeers::default();
        let service = PeerService {
            peers: &peers,
            host: &host,
        };
        let prepared = verified(&service);
        let gate = Arc::new(Barrier::new(2));
        *host.sign_gate.lock().unwrap() = Some(gate.clone());
        std::thread::scope(|threads| {
            let pending =
                threads.spawn(|| service.sign(&prepared.peer_handle, "GET", "/api/projects", &[]));
            gate.wait();
            peers.close(&prepared.peer_handle).unwrap();
            gate.wait();
            assert!(pending.join().unwrap().is_err());
        });
        *host.sign_gate.lock().unwrap() = None;
        let prepared = verified(&service);
        host.now.store(99_000, Ordering::SeqCst);
        assert!(service
            .sign(&prepared.peer_handle, "GET", "/api/projects", &[])
            .is_err());
        assert!(service.read(&prepared.peer_handle).is_err());
    }

    #[test]
    fn owner_changes_during_network_or_crypto_never_publish_a_proof() {
        for fault in [
            Fault::OwnerDuringRead,
            Fault::OwnerDuringSign,
            Fault::KeyDuringSign,
        ] {
            let host = MemoryHost::new();
            let peers = NativeApplicationPeers::default();
            let service = PeerService {
                peers: &peers,
                host: &host,
            };
            let prepared = opened(&service);
            if !matches!(fault, Fault::OwnerDuringRead) {
                service.read(&prepared.peer_handle).unwrap();
            }
            host.set_fault(fault);
            if matches!(fault, Fault::OwnerDuringRead) {
                assert!(service.read(&prepared.peer_handle).is_err());
            } else {
                assert!(service
                    .sign(&prepared.peer_handle, "GET", "/api/projects", &[])
                    .is_err());
            }
            assert!(peers.snapshot(&prepared.peer_handle, host.now()).is_err());
        }
    }

    #[test]
    fn concurrent_open_and_consumption_do_not_hold_session_locks_over_io() {
        let host = MemoryHost::new();
        let peers = NativeApplicationPeers::default();
        let service = PeerService {
            peers: &peers,
            host: &host,
        };
        let prepared = service.prepare("Fixture", 1).unwrap();
        let gate = Arc::new(Barrier::new(2));
        *host.open_gate.lock().unwrap() = Some(gate.clone());
        std::thread::scope(|threads| {
            let pending = threads.spawn(|| service.open(&prepared.peer_handle, &sdp("AA")));
            gate.wait();
            assert_eq!(
                service.open(&prepared.peer_handle, &sdp("AA")).unwrap_err(),
                BUSY
            );
            gate.wait();
            assert!(pending.join().unwrap().is_ok());
        });
        service.read(&prepared.peer_handle).unwrap();
        let gate = Arc::new(Barrier::new(2));
        *host.sign_gate.lock().unwrap() = Some(gate.clone());
        std::thread::scope(|threads| {
            let pending =
                threads.spawn(|| service.sign(&prepared.peer_handle, "GET", "/api/projects", &[]));
            gate.wait();
            assert_eq!(
                service
                    .sign(&prepared.peer_handle, "GET", "/api/projects", &[])
                    .err()
                    .unwrap(),
                BUSY
            );
            gate.wait();
            assert!(pending.join().unwrap().is_ok());
        });
        assert!(service
            .sign(&prepared.peer_handle, "GET", "/api/projects", &[])
            .is_err());
    }

    #[test]
    fn close_restart_expiry_and_process_local_capacity_refuse_old_handles() {
        let host = MemoryHost::new();
        let peers = NativeApplicationPeers::default();
        let service = PeerService {
            peers: &peers,
            host: &host,
        };
        let prepared = verified(&service);
        peers.close(&prepared.peer_handle).unwrap();
        assert!(service
            .sign(&prepared.peer_handle, "GET", "/api/projects", &[])
            .is_err());
        let prepared = verified(&service);
        let restarted = NativeApplicationPeers::default();
        assert!(PeerService {
            peers: &restarted,
            host: &host
        }
        .read(&prepared.peer_handle)
        .is_err());
        host.now.store(130_000, Ordering::SeqCst);
        assert!(service
            .sign(&prepared.peer_handle, "GET", "/api/projects", &[])
            .is_err());
        for _ in 0..MAX_PEERS {
            service.prepare("Fixture", 1).unwrap();
        }
        assert!(service.prepare("Fixture", 1).is_err());
        host.now.store(251_000, Ordering::SeqCst);
        assert!(service.prepare("Fixture", 1).is_ok());
    }

    #[test]
    fn only_canonical_pilot_targets_and_bounded_json_objects_can_be_signed() {
        for (method, path, body) in [
            ("POST", "/api/projects", b"{}".as_slice()),
            ("GET", "/api/pairing/devices", &[]),
            ("GET", "/api/projects/demo/access", &[]),
            ("GET", "/api/projects/../pairing", &[]),
            ("GET", "/api/projects", b"x"),
            ("get", "/api/projects", &[]),
            (
                "POST",
                "/api/account-auth/continuations/native/challenge?x=1",
                b"{}",
            ),
            (
                "POST",
                "/api/account-auth/continuations/native/challenge",
                b"[]",
            ),
            (
                "POST",
                "/api/account-auth/continuations/native/exchange",
                b"{",
            ),
        ] {
            let host = MemoryHost::new();
            let peers = NativeApplicationPeers::default();
            let service = PeerService {
                peers: &peers,
                host: &host,
            };
            let prepared = verified(&service);
            assert!(service
                .sign(&prepared.peer_handle, method, path, body)
                .is_err());
        }
        for path in [
            "/api/account-auth/continuations/native/challenge",
            "/api/account-auth/continuations/native/exchange",
        ] {
            let host = MemoryHost::new();
            let peers = NativeApplicationPeers::default();
            let service = PeerService {
                peers: &peers,
                host: &host,
            };
            let prepared = verified(&service);
            assert!(service
                .sign(
                    &prepared.peer_handle,
                    "POST",
                    path,
                    br#" {"challenge":"opaque"} "#
                )
                .is_ok());
        }
        let host = MemoryHost::new();
        let peers = NativeApplicationPeers::default();
        let service = PeerService {
            peers: &peers,
            host: &host,
        };
        let prepared = verified(&service);
        assert!(service
            .sign(
                &prepared.peer_handle,
                "POST",
                "/api/account-auth/continuations/native/challenge",
                &vec![b' '; 16385]
            )
            .is_err());
    }
}

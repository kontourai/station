//! Fixed native enrollment operations. Request captures outlive network-peer cleanup.

use crate::native_device_proof_key::{NativeDeviceProofKeyOwner, NativeDeviceProofKeyVault};
use crate::native_enrollment::{
    self, NativeEnrollmentBinding, NativeEnrollmentCandidate, NativeEnrollmentChallenge,
    NativeEnrollmentPublicJwk, NativeEnrollmentRecipientOwner, NativeEnrollmentRecipients,
    NativeEnrollmentSystemBackend,
};
use crate::native_enrollment_peer::NativeEnrollmentPeers;
use crate::native_relay_proof_key::NativeProofKeyChannel;
use crate::native_relay_redemption::{self, NativeEnrollmentRouteCapture};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::{
    digest,
    rand::{SecureRandom as _, SystemRandom},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

const VERSION: &str = "station.native-relay-enrollment/v1";
const BASE: &str = "/.well-known/station/v1/relay/native-enrollment";
const REFUSED: &str = "native_enrollment_operation_refused";
const SERVICE: &str = "io.kontourai.station.native-enrollment-journal";
static HOST_OPERATION: Mutex<()> = Mutex::new(());
type Result<T> = std::result::Result<T, String>;
fn time() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|v| v.as_millis() as u64)
        .unwrap_or(0)
}
fn random() -> Result<String> {
    let mut v = [0u8; 32];
    SystemRandom::new()
        .fill(&mut v)
        .map_err(|_| REFUSED.to_owned())?;
    Ok(URL_SAFE_NO_PAD.encode(v))
}
fn hash(v: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, v))
}
fn entry(id: &str) -> Result<crate::native_secure_entry::NativeSecureEntry> {
    if native_enrollment::decode(id, 32)?.len() != 32 {
        return Err(REFUSED.into());
    }
    crate::initialize_credential_store().map_err(|_| REFUSED.to_owned())?;
    crate::native_secure_entry::NativeSecureEntry::new(SERVICE, &format!("attempt:v1:{id}"))
        .map_err(|_| REFUSED.to_owned())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Attempt {
    version: String,
    owner: NativeEnrollmentRecipientOwner,
    scope: crate::native_enrollment::NativeEnrollmentScope,
    surface: crate::native_enrollment::NativeEnrollmentSurface,
    trust_revision: u64,
    trust_generation: u64,
    recipient_handle: String,
    recipient: crate::native_enrollment::NativeEnrollmentRecipient,
    challenge: Option<NativeEnrollmentChallenge>,
    binding_id: Option<String>,
    candidate: Option<NativeEnrollmentCandidate>,
    cancelled: bool,
    cancel_requested: bool,
    delivery: Option<native_enrollment::NativeEnrollmentDeliveryMetadata>,
    bundle: Option<PrivateBundle>,
    credential_reference: Option<crate::NativeCredentialReference>,
    current_profile_revision: Option<u64>,
    transition_handle: Option<String>,
    activation_proof_digest: Option<String>,
    created_at: u64,
    expires_at: u64,
}
fn load(id: &str) -> Result<Attempt> {
    let encoded = Zeroizing::new(entry(id)?.get_password().map_err(|_| REFUSED.to_owned())?);
    if encoded.len() > 16384 {
        return Err(REFUSED.into());
    }
    let value: Attempt = serde_json::from_str(&encoded).map_err(|_| REFUSED.to_owned())?;
    if value.version != VERSION || value.owner.client_attempt_id != id || value.created_at > time()
    {
        return Err(REFUSED.into());
    }
    Ok(value)
}
fn save(id: &str, value: &Attempt) -> Result<()> {
    let encoded = Zeroizing::new(serde_json::to_string(value).map_err(|_| REFUSED.to_owned())?);
    if encoded.len() > 16384 {
        return Err(REFUSED.into());
    }
    let owned = entry(id)?;
    owned
        .set_password(&encoded)
        .map_err(|_| REFUSED.to_owned())?;
    if Zeroizing::new(owned.get_password().map_err(|_| REFUSED.to_owned())?).as_str()
        != encoded.as_str()
    {
        return Err(REFUSED.into());
    }
    Ok(())
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct IndexEntry {
    id: String,
    seed: Attempt,
}
fn index_entry(app: &AppHandle) -> Result<crate::native_secure_entry::NativeSecureEntry> {
    crate::initialize_credential_store().map_err(|_| REFUSED.to_owned())?;
    crate::native_secure_entry::NativeSecureEntry::new(
        SERVICE,
        &format!("index:v1:{}", hash(app.config().identifier.as_bytes())),
    )
    .map_err(|_| REFUSED.to_owned())
}
fn index(app: &AppHandle) -> Result<Vec<IndexEntry>> {
    let encoded = match index_entry(app)?.get_password() {
        Ok(v) => Zeroizing::new(v),
        Err(keyring_core::Error::NoEntry) => return Ok(vec![]),
        Err(_) => return Err(REFUSED.into()),
    };
    if encoded.len() > 32768 {
        return Err(REFUSED.into());
    }
    let entries: Vec<IndexEntry> =
        serde_json::from_str(&encoded).map_err(|_| REFUSED.to_owned())?;
    if entries.len() > 16 {
        return Err(REFUSED.into());
    }
    let mut seen = std::collections::HashSet::new();
    for entry in &entries {
        if native_enrollment::decode(&entry.id, 32)?.len() != 32
            || !seen.insert(&entry.id)
            || entry.seed.owner.client_attempt_id != entry.id
            || entry.seed.owner.app_identifier != app.config().identifier
            || entry.seed.bundle.is_some()
            || entry.seed.challenge.is_some()
            || entry.seed.candidate.is_some()
            || entry.seed.credential_reference.is_some()
        {
            return Err(REFUSED.into());
        }
    }
    Ok(entries)
}
fn save_index(app: &AppHandle, entries: &[IndexEntry]) -> Result<()> {
    let encoded = serde_json::to_string(entries).map_err(|_| REFUSED.to_owned())?;
    if entries.len() > 16 || encoded.len() > 32768 {
        return Err(REFUSED.into());
    }
    let entry = index_entry(app)?;
    entry
        .set_password(&encoded)
        .map_err(|_| REFUSED.to_owned())?;
    if entry.get_password().map_err(|_| REFUSED.to_owned())? != encoded {
        return Err(REFUSED.into());
    }
    Ok(())
}
fn finish_terminal_cleanup(app: &AppHandle, id: &str, attempt: &Attempt) -> Result<()> {
    if !attempt.cancelled {
        return Err(REFUSED.into());
    }
    if let Some(reference) = &attempt.credential_reference {
        crate::retire_owned_native_enrollment(app, &attempt.owner.profile_name, reference)?;
    }
    if !attempt.recipient_handle.is_empty() {
        NativeEnrollmentRecipients(NativeEnrollmentSystemBackend)
            .cancel(&attempt.owner, &attempt.recipient_handle)?;
    }
    if attempt.candidate.is_some() {
        match NativeDeviceProofKeyVault::new().revoke(&key_owner(attempt)?) {
            Ok(()) | Err(crate::native_device_proof_key::DeviceProofKeyError::Missing) => {}
            Err(_) => return Err(REFUSED.into()),
        }
    }
    let mut rows = index(app)?;
    rows.retain(|row| row.id != id);
    save_index(app, &rows)?;
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(_) => Err(REFUSED.into()),
    }
}

fn load_owned(app: &AppHandle, id: &str) -> Result<Attempt> {
    let mut value = load(id)?;
    if value.cancelled {
        return Ok(value);
    }
    let revision = crate::native_enrollment_owned_revision(
        app,
        &value.owner.profile_name,
        value.owner.profile_revision,
        value.credential_reference.as_ref(),
        &value.owner.station_origin,
        &value.owner.station_id,
        &value.surface.client_instance_id,
        value.cancel_requested,
    )?;
    if revision
        != value
            .current_profile_revision
            .unwrap_or(value.owner.profile_revision)
    {
        value.current_profile_revision = Some(revision);
        save(id, &value)?;
    }
    Ok(value)
}

fn matches(attempt: &Attempt, capture: &NativeEnrollmentRouteCapture) -> bool {
    let p = &capture.context.profile;
    attempt.owner.profile_name == p.profile_name
        && attempt
            .current_profile_revision
            .unwrap_or(attempt.owner.profile_revision)
            == p.revision
        && attempt.owner.app_identifier == p.app_identifier
        && attempt.owner.channel == p.channel.keyring_label()
        && attempt.owner.station_origin == p.station_endpoint
        && attempt.owner.station_id == p.station_id
        && attempt.scope == capture.scope
        && attempt.surface == capture.surface
        && attempt.trust_revision == capture.context.station_trust.revision
        && attempt.trust_generation == capture.context.station_trust.generation
        && attempt.owner.grant_digest == capture.grant_digest
        && attempt.owner.grant_id == capture.grant_id
}
#[derive(Clone)]
struct RequestCapture {
    route: NativeEnrollmentRouteCapture,
    nonce: String,
    attempt: String,
    purpose: String,
    expires_at: u64,
    deadline: Instant,
}
#[derive(Default)]
pub(crate) struct NativeEnrollmentHost {
    requests: Mutex<HashMap<String, RequestCapture>>,
    aborted: Mutex<std::collections::HashSet<String>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeEnrollmentPreparedRequest {
    version: &'static str,
    request_handle: String,
    peer_handle: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    enrollment_handle: Option<String>,
    method: &'static str,
    path: String,
    headers: std::collections::BTreeMap<String, String>,
    body: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NativeEnrollmentCredentials {
    username: String,
    password: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PrivateBundle {
    version: String,
    station_id: String,
    device_id: String,
    device_credential: String,
}
impl Drop for PrivateBundle {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.device_credential.zeroize();
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ActiveReceipt {
    version: String,
    state: String,
    enrollment_id: String,
    device_id: String,
    binding_id: String,
    receipt_digest: String,
    receipt_expires_at: u64,
    binding: NativeEnrollmentBinding,
    candidate: NativeEnrollmentCandidate,
    device_receipt: crate::native_device_binding_candidate::NativeDeviceProofSelfReceiptV1,
    response_peer_nonce: String,
    station_signing_generation: u64,
}

/// Only this module can construct this value after Station JWS, HPKE and current-owner validation.
pub(crate) struct AuthenticatedEnrollmentActivation {
    receipt: ActiveReceipt,
    bundle: PrivateBundle,
    route: NativeEnrollmentRouteCapture,
    reference: crate::NativeCredentialReference,
    observed_at: u64,
}
impl AuthenticatedEnrollmentActivation {
    pub(crate) fn candidate(
        &self,
    ) -> Result<crate::native_device_binding_candidate::NativeDeviceBindingCandidateV1> {
        serde_json::from_value(
            serde_json::to_value(&self.receipt.candidate).map_err(|_| REFUSED.to_owned())?,
        )
        .map_err(|_| REFUSED.to_owned())
    }
    pub(crate) fn device_receipt(
        &self,
    ) -> &crate::native_device_binding_candidate::NativeDeviceProofSelfReceiptV1 {
        &self.receipt.device_receipt
    }
    pub(crate) fn observed_at(&self) -> u64 {
        self.observed_at
    }
    pub(crate) fn reference(&self) -> &crate::NativeCredentialReference {
        &self.reference
    }
    pub(crate) fn route(&self) -> &NativeEnrollmentRouteCapture {
        &self.route
    }
    pub(crate) fn credential(&self) -> &str {
        &self.bundle.device_credential
    }
    pub(crate) fn device_id(&self) -> &str {
        &self.bundle.device_id
    }
    pub(crate) fn assert_current(&self, app: &AppHandle, revision: u64) -> Result<()> {
        if self.receipt.receipt_expires_at <= time() {
            return Err(REFUSED.into());
        }
        let mut expected = self.route.clone();
        expected.context.profile.revision = revision;
        native_relay_redemption::with_current_native_enrollment_route(
            app,
            &expected.context.profile.profile_name,
            revision,
            |live| {
                if live == expected {
                    Ok(())
                } else {
                    Err(REFUSED.into())
                }
            },
        )
    }
}

fn aborted(app: &AppHandle, id: &str) -> Result<bool> {
    let state = app
        .try_state::<NativeEnrollmentHost>()
        .ok_or_else(|| REFUSED.to_owned())?;
    let flag = state
        .aborted
        .lock()
        .map_err(|_| REFUSED.to_owned())?
        .contains(id);
    Ok(flag || load(id)?.cancel_requested)
}
fn current(app: &AppHandle, attempt: &Attempt) -> Result<NativeEnrollmentRouteCapture> {
    native_relay_redemption::with_current_native_enrollment_route(
        app,
        &attempt.owner.profile_name,
        attempt
            .current_profile_revision
            .unwrap_or(attempt.owner.profile_revision),
        |route| {
            if matches(attempt, &route) {
                Ok(route)
            } else {
                Err(REFUSED.into())
            }
        },
    )
}
fn signed_response<T: serde::de::DeserializeOwned + Serialize>(
    capture: &RequestCapture,
    response: serde_json::Value,
    typ: &str,
) -> Result<T> {
    let proof = response
        .get("stationProof")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| REFUSED.to_owned())?;
    let bytes = native_enrollment::verify_native_statement(&point(capture), proof, typ)?;
    let result: T = serde_json::from_slice(&bytes).map_err(|_| REFUSED.to_owned())?;
    let mut outer = response;
    outer
        .as_object_mut()
        .ok_or_else(|| REFUSED.to_owned())?
        .remove("stationProof");
    if serde_json::to_value(&result).map_err(|_| REFUSED.to_owned())? != outer {
        return Err(REFUSED.into());
    }
    Ok(result)
}

fn capture_peer(
    app: &AppHandle,
    peer: &str,
) -> Result<(NativeEnrollmentRouteCapture, String, u64)> {
    app.try_state::<NativeEnrollmentPeers>()
        .ok_or_else(|| REFUSED.to_owned())?
        .retained_capture(app, peer)
}
fn prepare(
    app: &AppHandle,
    peer: &str,
    attempt: &str,
    purpose: &str,
    payload: serde_json::Value,
) -> Result<NativeEnrollmentPreparedRequest> {
    let (route, nonce, expiry) = capture_peer(app, peer)?;
    if purpose != "cancel" && purpose != "status" && aborted(app, attempt)? {
        return Err(REFUSED.into());
    }
    let retained = load_owned(app, attempt)?;
    if retained.cancelled || !matches(&retained, &route) {
        return Err(REFUSED.into());
    }
    let id = random()?;
    let expires_at = (time() + 45000).min(expiry);
    if expires_at <= time() {
        return Err(REFUSED.into());
    }
    let body = serde_jcs::to_string(&payload).map_err(|_| REFUSED.to_owned())?;
    if body.len() > 16384 {
        return Err(REFUSED.into());
    }
    if purpose == "activate" {
        let mut owned = load_owned(app, attempt)?;
        if owned.activation_proof_digest.is_some() {
            return Err(REFUSED.into());
        }
        owned.activation_proof_digest = Some(hash(
            payload
                .get("proof")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| REFUSED.to_owned())?
                .as_bytes(),
        ));
        save(attempt, &owned)?;
    }
    let state = app
        .try_state::<NativeEnrollmentHost>()
        .ok_or_else(|| REFUSED.to_owned())?;
    let mut requests = state.requests.lock().map_err(|_| REFUSED.to_owned())?;
    requests.retain(|_, r| r.expires_at > time() && Instant::now() < r.deadline);
    if requests.len() >= 64 {
        return Err(REFUSED.into());
    }
    requests.insert(
        id.clone(),
        RequestCapture {
            route,
            nonce,
            attempt: attempt.into(),
            purpose: purpose.into(),
            expires_at,
            deadline: Instant::now() + Duration::from_millis(expires_at - time()),
        },
    );
    Ok(NativeEnrollmentPreparedRequest {
        version: "station-native-enrollment-request/v1",
        request_handle: id,
        peer_handle: peer.into(),
        enrollment_handle: Some(attempt.into()),
        method: "POST",
        path: format!("{BASE}/{purpose}"),
        headers: std::collections::BTreeMap::from([(
            "Content-Type".into(),
            "application/json".into(),
        )]),
        body,
    })
}
fn consume_request(app: &AppHandle, id: &str, purpose: &str) -> Result<RequestCapture> {
    let state = app
        .try_state::<NativeEnrollmentHost>()
        .ok_or_else(|| REFUSED.to_owned())?;
    let value = state
        .requests
        .lock()
        .map_err(|_| REFUSED.to_owned())?
        .remove(id)
        .ok_or_else(|| REFUSED.to_owned())?;
    if value.purpose != purpose || value.expires_at <= time() || Instant::now() >= value.deadline {
        return Err(REFUSED.into());
    }
    if value.purpose != "cancel" && value.purpose != "status" && aborted(app, &value.attempt)? {
        return Err(REFUSED.into());
    }
    let attempt = load_owned(app, &value.attempt)?;
    native_relay_redemption::with_current_native_enrollment_route(
        app,
        &attempt.owner.profile_name,
        attempt
            .current_profile_revision
            .unwrap_or(attempt.owner.profile_revision),
        |live| {
            if live == value.route && matches(&attempt, &live) {
                Ok(value.clone())
            } else {
                Err(REFUSED.into())
            }
        },
    )
}
fn point(capture: &RequestCapture) -> NativeEnrollmentPublicJwk {
    let p = &capture.route.context.station_trust.signing_key;
    NativeEnrollmentPublicJwk {
        kty: p.kty.clone(),
        crv: p.crv.clone(),
        x: p.x.clone(),
        y: p.y.clone(),
    }
}
fn channel(value: &str) -> Result<NativeProofKeyChannel> {
    match value {
        "dev" => Ok(NativeProofKeyChannel::Dev),
        "stable" => Ok(NativeProofKeyChannel::Stable),
        "beta" => Ok(NativeProofKeyChannel::Beta),
        "nightly" => Ok(NativeProofKeyChannel::Nightly),
        _ => Err(REFUSED.into()),
    }
}
fn key_owner(attempt: &Attempt) -> Result<NativeDeviceProofKeyOwner> {
    let c = attempt
        .challenge
        .as_ref()
        .ok_or_else(|| REFUSED.to_owned())?;
    NativeDeviceProofKeyOwner::with_binding_id(
        &attempt.owner.app_identifier,
        channel(&attempt.owner.channel)?,
        &attempt.surface.client_instance_id,
        &attempt.owner.station_id,
        &c.reserved_device_id,
        attempt
            .binding_id
            .as_deref()
            .ok_or_else(|| REFUSED.to_owned())?,
    )
    .map_err(|_| REFUSED.to_owned())
}
fn sign_payload(
    app: &AppHandle,
    peer: &str,
    attempt_id: &str,
    purpose: &str,
    mut payload: serde_json::Value,
) -> Result<NativeEnrollmentPreparedRequest> {
    let (route, nonce, _) = capture_peer(app, peer)?;
    let attempt = load_owned(app, attempt_id)?;
    if !matches(&attempt, &route) {
        return Err(REFUSED.into());
    }
    let challenge = attempt
        .challenge
        .as_ref()
        .ok_or_else(|| REFUSED.to_owned())?;
    let candidate = attempt
        .candidate
        .as_ref()
        .ok_or_else(|| REFUSED.to_owned())?;
    let mut claims = serde_json::to_value(challenge.binding()).map_err(|_| REFUSED.to_owned())?;
    let map = claims.as_object_mut().ok_or_else(|| REFUSED.to_owned())?;
    let issued = time() / 1000;
    map.extend(serde_json::json!({"version":VERSION,"requestedScope":"orchestration:read","purpose":purpose,"candidate":candidate,"peerNonce":nonce,"nonce":if purpose=="activate" {attempt.delivery.as_ref().ok_or_else(||REFUSED.to_owned())?.activation_nonce.clone()} else {challenge.nonce.clone()},"htm":"POST","htu":format!("{BASE}/{purpose}"),"payloadSha256":hash(serde_jcs::to_vec(&payload).map_err(|_|REFUSED.to_owned())?.as_slice()),"jti":random()?,"iat":issued,"exp":issued+30}).as_object().ok_or_else(||REFUSED.to_owned())?.clone());
    let header =
        URL_SAFE_NO_PAD.encode(br#"{"alg":"ES256","typ":"station-native-relay-enrollment+jwt"}"#);
    let encoded =
        URL_SAFE_NO_PAD.encode(serde_jcs::to_vec(&claims).map_err(|_| REFUSED.to_owned())?);
    let input = format!("{header}.{encoded}");
    let signature = NativeDeviceProofKeyVault::new()
        .sign_es256_p1363(&key_owner(&attempt)?, input.as_bytes())
        .map_err(|_| REFUSED.to_owned())?;
    payload
        .as_object_mut()
        .ok_or_else(|| REFUSED.to_owned())?
        .insert(
            "proof".into(),
            serde_json::Value::String(format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature))),
        );
    prepare(app, peer, attempt_id, purpose, payload)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_enrollment_begin_prepare(
    window: tauri::WebviewWindow,
    app: AppHandle,
    peer_handle: String,
    enrollment_handle: Option<String>,
) -> Result<NativeEnrollmentPreparedRequest> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation=HOST_OPERATION.lock().map_err(|_|REFUSED.to_owned())?;
        let (route,nonce,expiry)=capture_peer(&app,&peer_handle)?;
        let mut rows=index(&app)?;
        let id=match enrollment_handle {Some(id)=>id,None=>{
            if rows.len()>=16{return Err(REFUSED.into());}
            let id=random()?;let p=&route.context.profile;let created=time();
            let owner=NativeEnrollmentRecipientOwner{client_attempt_id:id.clone(),app_identifier:p.app_identifier.clone(),channel:p.channel.keyring_label().into(),profile_name:p.profile_name.clone(),profile_revision:p.revision,station_id:p.station_id.clone(),station_origin:p.station_endpoint.clone(),route_generation:route.scope.routing_generation,grant_id:route.grant_id.clone(),grant_digest:route.grant_digest.clone(),peer_nonce:nonce};
            let seed=Attempt{version:VERSION.into(),owner,scope:route.scope.clone(),surface:route.surface.clone(),trust_revision:route.context.station_trust.revision,trust_generation:route.context.station_trust.generation,recipient_handle:String::new(),recipient:native_enrollment::NativeEnrollmentRecipient{suite:native_enrollment::NativeEnrollmentSuite{kem:16,kdf:1,aead:1},public_key:String::new()},challenge:None,binding_id:None,candidate:None,cancelled:false,cancel_requested:false,delivery:None,bundle:None,credential_reference:None,current_profile_revision:None,transition_handle:None,activation_proof_digest:None,created_at:created,expires_at:(created+300000).min(route.grant_expires_at)};
            rows.push(IndexEntry{id:id.clone(),seed:seed.clone()});save_index(&app,&rows)?;
            save(&id,&seed)?;id
        }};
        let mut attempt=match entry(&id)?.get_password(){Ok(_)=>load(&id)?,Err(keyring_core::Error::NoEntry)=>{
            let seed=rows.iter().find(|row|row.id==id).ok_or_else(||REFUSED.to_owned())?.seed.clone();save(&id,&seed)?;seed
        },Err(_)=>return Err(REFUSED.into())};
        if expiry<=time() || !matches(&attempt,&route) || attempt.expires_at<=time() || attempt.created_at>time() {return Err(REFUSED.into());}
        if attempt.recipient_handle.is_empty(){
            let recipient=NativeEnrollmentRecipients(NativeEnrollmentSystemBackend).prepare(&attempt.owner,time(),attempt.expires_at)?;
            attempt.recipient_handle=recipient.attempt_handle;attempt.recipient=recipient.recipient;save(&id,&attempt)?;
        }
        prepare(&app,&peer_handle,&id,"begin",serde_json::json!({"version":VERSION,"clientAttemptId":id,"peerNonce":attempt.owner.peer_nonce,"expiresAt":attempt.expires_at,"recipient":attempt.recipient}))
    }).await.map_err(|_|REFUSED.to_owned())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeEnrollmentAcceptedChallenge {
    version: &'static str,
    enrollment_handle: String,
    candidate: NativeEnrollmentCandidate,
    registration_available: bool,
}
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_enrollment_challenge_accept(
    window: tauri::WebviewWindow,
    app: AppHandle,
    request_handle: String,
    response: serde_json::Value,
) -> Result<NativeEnrollmentAcceptedChallenge> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = HOST_OPERATION.lock().map_err(|_| REFUSED.to_owned())?;
        let capture = consume_request(&app, &request_handle, "begin")?;
        let mut attempt = load_owned(&app, &capture.attempt)?;
        let proof = response
            .get("stationProof")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| REFUSED.to_owned())?;
        let bytes = native_enrollment::verify_native_statement(
            &point(&capture),
            proof,
            "station-native-relay-enrollment-challenge+jws",
        )?;
        let challenge: NativeEnrollmentChallenge =
            serde_json::from_slice(&bytes).map_err(|_| REFUSED.to_owned())?;
        let mut outer = response;
        outer
            .as_object_mut()
            .ok_or_else(|| REFUSED.to_owned())?
            .remove("stationProof");
        if serde_json::to_value(&challenge).map_err(|_| REFUSED.to_owned())? != outer
            || challenge.version != VERSION
            || challenge.client_attempt_id != capture.attempt
            || challenge.response_peer_nonce != capture.nonce
            || challenge.scope != attempt.scope
            || challenge.surface != attempt.surface
            || challenge.peer_nonce != attempt.owner.peer_nonce
            || challenge.station_id != attempt.owner.station_id
            || challenge.station_audience != attempt.owner.station_origin
            || challenge.recipient != attempt.recipient
            || challenge.station_signing_generation != attempt.trust_generation
            || challenge.requested_scope != "orchestration:read"
            || challenge.expires_at > attempt.expires_at
            || challenge.expires_at <= time()
        {
            return Err(REFUSED.into());
        }
        if let Some(old) = &attempt.challenge {
            if old.enrollment_id != challenge.enrollment_id
                || old.reserved_device_id != challenge.reserved_device_id
            {
                return Err(REFUSED.into());
            }
        }
        attempt.challenge = Some(challenge.clone());
        if attempt.binding_id.is_none() {
            attempt.binding_id = Some(uuid::Uuid::new_v4().to_string());
        }
        save(&capture.attempt, &attempt)?;
        let keys = NativeDeviceProofKeyVault::new();
        let owner = key_owner(&attempt)?;
        let public = keys
            .restore(&owner)
            .or_else(|error| match error {
                crate::native_device_proof_key::DeviceProofKeyError::Missing => keys.create(&owner),
                other => Err(other),
            })
            .map_err(|_| REFUSED.to_owned())?;
        let jwk = public.jwk();
        let candidate = NativeEnrollmentCandidate {
            version: "station-native-device-binding-candidate/v1".into(),
            station_id: attempt.owner.station_id.clone(),
            device_id: challenge.reserved_device_id.clone(),
            binding_id: attempt
                .binding_id
                .clone()
                .ok_or_else(|| REFUSED.to_owned())?,
            surface: attempt.surface.clone(),
            device_proof_jwk: NativeEnrollmentPublicJwk {
                kty: jwk.kty.clone(),
                crv: jwk.crv.clone(),
                x: jwk.x.clone(),
                y: jwk.y.clone(),
            },
            device_proof_key_thumbprint: public.thumbprint().into(),
        };
        attempt.candidate = Some(candidate.clone());
        save(&capture.attempt, &attempt)?;
        native_relay_redemption::with_current_native_enrollment_route(
            &app,
            &attempt.owner.profile_name,
            attempt
                .current_profile_revision
                .unwrap_or(attempt.owner.profile_revision),
            |live| {
                if matches(&attempt, &live) {
                    Ok(())
                } else {
                    Err(REFUSED.into())
                }
            },
        )?;
        Ok(NativeEnrollmentAcceptedChallenge {
            version: VERSION,
            enrollment_handle: capture.attempt,
            candidate,
            registration_available: challenge.registration_available,
        })
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_enrollment_login_prepare(
    window: tauri::WebviewWindow,
    app: AppHandle,
    enrollment_handle: String,
    peer_handle: String,
    credentials: NativeEnrollmentCredentials,
    invitation: Option<String>,
    name: Option<String>,
) -> Result<NativeEnrollmentPreparedRequest> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    if credentials.username.len() < 3
        || credentials.username.len() > 32
        || credentials.password.is_empty()
        || credentials.password.len() > 128
    {
        return Err(REFUSED.into());
    }
    tauri::async_runtime::spawn_blocking(move||{
        let _operation=HOST_OPERATION.lock().map_err(|_|REFUSED.to_owned())?;
        let attempt=load_owned(&app,&enrollment_handle)?;let c=attempt.challenge.as_ref().ok_or_else(||REFUSED.to_owned())?;
        let mut payload=serde_json::json!({"enrollmentId":c.enrollment_id,"candidate":attempt.candidate,"credentials":{"username":credentials.username,"password":credentials.password}});
        let purpose=if let Some(token)=invitation{
            if !c.registration_available||native_enrollment::decode(&token,32)?.len()!=32{return Err(REFUSED.into());}
            payload.as_object_mut().ok_or_else(||REFUSED.to_owned())?.insert("invitation".into(),serde_json::Value::String(token));
            if let Some(name)=name{if name.is_empty()||name.len()>128{return Err(REFUSED.into());}payload.as_object_mut().ok_or_else(||REFUSED.to_owned())?.insert("name".into(),serde_json::Value::String(name));}"register"
        }else{if name.is_some(){return Err(REFUSED.into());}"login"};
        sign_payload(&app,&peer_handle,&enrollment_handle,purpose,payload)
    }).await.map_err(|_|REFUSED.to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_enrollment_finalize_prepare(
    window: tauri::WebviewWindow,
    app: AppHandle,
    enrollment_handle: String,
    peer_handle: String,
) -> Result<NativeEnrollmentPreparedRequest> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = HOST_OPERATION.lock().map_err(|_| REFUSED.to_owned())?;
        let attempt = load_owned(&app, &enrollment_handle)?;
        let id = &attempt
            .challenge
            .as_ref()
            .ok_or_else(|| REFUSED.to_owned())?
            .enrollment_id;
        sign_payload(
            &app,
            &peer_handle,
            &enrollment_handle,
            "finalize",
            serde_json::json!({"enrollmentId":id}),
        )
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_enrollment_status_prepare(
    window: tauri::WebviewWindow,
    app: AppHandle,
    enrollment_handle: String,
    peer_handle: String,
) -> Result<NativeEnrollmentPreparedRequest> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = HOST_OPERATION.lock().map_err(|_| REFUSED.to_owned())?;
        let attempt = load_owned(&app, &enrollment_handle)?;
        let id = &attempt
            .challenge
            .as_ref()
            .ok_or_else(|| REFUSED.to_owned())?
            .enrollment_id;
        sign_payload(
            &app,
            &peer_handle,
            &enrollment_handle,
            "status",
            serde_json::json!({"enrollmentId":id}),
        )
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeEnrollmentDeliveryAccepted {
    version: &'static str,
    enrollment_handle: String,
    state: &'static str,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PendingResponse {
    version: String,
    state: String,
    enrollment_id: String,
    request_id: String,
    expires_at: u64,
}
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_enrollment_pending_accept(
    window: tauri::WebviewWindow,
    app: AppHandle,
    request_handle: String,
    response: serde_json::Value,
) -> Result<serde_json::Value> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move||{
        let _operation=HOST_OPERATION.lock().map_err(|_|REFUSED.to_owned())?;
        let state=app.try_state::<NativeEnrollmentHost>().ok_or_else(||REFUSED.to_owned())?;
        let purpose=state.requests.lock().map_err(|_|REFUSED.to_owned())?.get(&request_handle).ok_or_else(||REFUSED.to_owned())?.purpose.clone();
        if !["login","register","finalize"].contains(&purpose.as_str()){return Err(REFUSED.into());}
        let capture=consume_request(&app,&request_handle,&purpose)?;
        let attempt=load_owned(&app,&capture.attempt)?;
        let pending:PendingResponse=serde_json::from_value(response).map_err(|_|REFUSED.to_owned())?;
        if pending.version!=VERSION || pending.state!="pending" || pending.enrollment_id!=attempt.challenge.as_ref().ok_or_else(||REFUSED.to_owned())?.enrollment_id || pending.expires_at<=time() || pending.expires_at>attempt.expires_at || pending.request_id.is_empty() || pending.request_id.len()>512 {return Err(REFUSED.into());}
        Ok(serde_json::json!({"version":VERSION,"enrollmentHandle":capture.attempt,"state":"pending"}))
    }).await.map_err(|_|REFUSED.to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_enrollment_resume(
    window: tauri::WebviewWindow,
    app: AppHandle,
    profile_name: String,
    expected_profile_revision: u64,
) -> Result<serde_json::Value> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move||{
        let _operation=HOST_OPERATION.lock().map_err(|_|REFUSED.to_owned())?;
        native_relay_redemption::with_current_native_enrollment_route(&app,&profile_name,expected_profile_revision, |_|Ok(()))?;
        let rows=index(&app)?;let mut result=vec![];
        for row in rows.into_iter().filter(|r|r.seed.owner.profile_name==profile_name) {
            let attempt=match entry(&row.id)?.get_password(){Ok(_)=>load_owned(&app,&row.id)?,Err(keyring_core::Error::NoEntry)=>row.seed,Err(_)=>return Err(REFUSED.into())};
            if attempt.cancelled {finish_terminal_cleanup(&app,&row.id,&attempt)?;continue;}
            let route=current(&app,&attempt)?;if route.context.profile.revision!=expected_profile_revision{return Err(REFUSED.into());}
            let phase=if attempt.cancel_requested{"cancel-required"}else if attempt.transition_handle.is_some(){"active"}else if attempt.activation_proof_digest.is_some(){"activation-unknown"}else if attempt.delivery.is_some(){"staged"}else if attempt.candidate.is_some(){"candidate"}else{"begin-required"};
            result.push(serde_json::json!({"enrollmentHandle":row.id,"phase":phase,"profileRevision":expected_profile_revision,"expiresAt":attempt.expires_at,"registrationAvailable":attempt.challenge.as_ref().is_some_and(|c|c.registration_available)}));
        }
        Ok(serde_json::json!({"version":VERSION,"attempts":result}))
    }).await.map_err(|_|REFUSED.to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_enrollment_delivery_accept(
    window: tauri::WebviewWindow,
    app: AppHandle,
    request_handle: String,
    response: serde_json::Value,
) -> Result<NativeEnrollmentDeliveryAccepted> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = HOST_OPERATION.lock().map_err(|_| REFUSED.to_owned())?;
        let capture = consume_request(&app, &request_handle, "finalize")?;
        let mut attempt = load_owned(&app, &capture.attempt)?;
        let proof = response
            .get("stationProof")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| REFUSED.to_owned())?;
        let bytes = native_enrollment::verify_native_statement(
            &point(&capture),
            proof,
            "station-native-relay-enrollment-delivery+jws",
        )?;
        let metadata: native_enrollment::NativeEnrollmentDeliveryMetadata =
            serde_json::from_slice(&bytes).map_err(|_| REFUSED.to_owned())?;
        let mut outer = response.clone();
        let outer_map = outer.as_object_mut().ok_or_else(|| REFUSED.to_owned())?;
        for field in ["stationProof", "enc", "ciphertext"] {
            outer_map.remove(field);
        }
        if serde_json::to_value(&metadata).map_err(|_| REFUSED.to_owned())? != outer
            || metadata.binding
                != attempt
                    .challenge
                    .as_ref()
                    .ok_or_else(|| REFUSED.to_owned())?
                    .binding()
            || Some(&metadata.candidate) != attempt.candidate.as_ref()
            || metadata.response_peer_nonce != capture.nonce
            || metadata.station_signing_generation != attempt.trust_generation
        {
            return Err(REFUSED.into());
        }
        let station = point(&capture);
        let mut public_point = vec![4u8];
        public_point.extend(native_enrollment::decode(&station.x, 32)?);
        public_point.extend(native_enrollment::decode(&station.y, 32)?);
        let plaintext = NativeEnrollmentRecipients(NativeEnrollmentSystemBackend).open(
            &attempt.owner,
            &attempt.recipient_handle,
            &metadata,
            &public_point,
            proof,
            response
                .get("enc")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| REFUSED.to_owned())?,
            response
                .get("ciphertext")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| REFUSED.to_owned())?,
            time(),
        )?;
        let bundle: PrivateBundle =
            serde_json::from_slice(&plaintext).map_err(|_| REFUSED.to_owned())?;
        if bundle.version != VERSION
            || bundle.station_id != attempt.owner.station_id
            || bundle.device_id != metadata.binding.reserved_device_id
            || bundle.device_credential.is_empty()
            || bundle.device_credential.len() > 8192
        {
            return Err(REFUSED.into());
        }
        if let Some(old) = &attempt.delivery {
            if old.activation_nonce != metadata.activation_nonce
                || old.bundle_digest != metadata.bundle_digest
            {
                return Err(REFUSED.into());
            }
        }
        current(&app, &attempt)?;
        if aborted(&app, &capture.attempt)? {
            return Err(REFUSED.into());
        }
        attempt.delivery = Some(metadata);
        attempt.bundle = Some(bundle);
        if attempt.credential_reference.is_none() {
            attempt.credential_reference = Some(crate::NativeCredentialReference {
                kind: "station-bearer".into(),
                id: format!("native-enrollment:{}", uuid::Uuid::new_v4()),
            });
        }
        save(&capture.attempt, &attempt)?;
        Ok(NativeEnrollmentDeliveryAccepted {
            version: VERSION,
            enrollment_handle: capture.attempt,
            state: "staged",
        })
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_enrollment_activate_prepare(
    window: tauri::WebviewWindow,
    app: AppHandle,
    enrollment_handle: String,
    peer_handle: String,
) -> Result<NativeEnrollmentPreparedRequest> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move||{
        let _operation=HOST_OPERATION.lock().map_err(|_|REFUSED.to_owned())?;
        let attempt=load_owned(&app,&enrollment_handle)?;let delivery=attempt.delivery.as_ref().ok_or_else(||REFUSED.to_owned())?;
        let candidate=attempt.candidate.as_ref().ok_or_else(||REFUSED.to_owned())?;
        sign_payload(&app,&peer_handle,&enrollment_handle,"activate",serde_json::json!({"enrollmentId":delivery.binding.enrollment_id,"deviceId":candidate.device_id,"bindingId":candidate.binding_id,"activationNonce":delivery.activation_nonce,"bundleDigest":delivery.bundle_digest}))
    }).await.map_err(|_|REFUSED.to_owned())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeEnrollmentActivationAccepted {
    version: &'static str,
    enrollment_handle: String,
    state: &'static str,
    profile_revision: u64,
    transition_handle: String,
}

fn accept_active(
    app: &AppHandle,
    capture: RequestCapture,
    response: serde_json::Value,
) -> Result<NativeEnrollmentActivationAccepted> {
    let mut attempt = load_owned(&app, &capture.attempt)?;
    let receipt: ActiveReceipt = signed_response(
        &capture,
        response,
        "station-native-relay-enrollment-receipt+jws",
    )?;
    let delivery = attempt
        .delivery
        .as_ref()
        .ok_or_else(|| REFUSED.to_owned())?;
    let candidate = attempt
        .candidate
        .as_ref()
        .ok_or_else(|| REFUSED.to_owned())?;
    let expected_ack = attempt
        .activation_proof_digest
        .as_ref()
        .ok_or_else(|| REFUSED.to_owned())?;
    if receipt.version != VERSION
        || receipt.state != "active"
        || receipt.enrollment_id != delivery.binding.enrollment_id
        || receipt.device_id != candidate.device_id
        || receipt.binding_id != candidate.binding_id
        || receipt.binding != delivery.binding
        || receipt.candidate != *candidate
        || receipt.response_peer_nonce != capture.nonce
        || receipt.station_signing_generation != attempt.trust_generation
        || receipt.receipt_digest != *expected_ack
        || receipt.receipt_expires_at <= time()
        || receipt.receipt_expires_at > time() + 30000
        || aborted(app, &capture.attempt)?
    {
        return Err(REFUSED.into());
    }
    let authenticated = AuthenticatedEnrollmentActivation {
        receipt,
        bundle: attempt
            .bundle
            .as_ref()
            .ok_or_else(|| REFUSED.to_owned())?
            .clone(),
        route: current(app, &attempt)?,
        reference: attempt
            .credential_reference
            .clone()
            .ok_or_else(|| REFUSED.to_owned())?,
        observed_at: time(),
    };
    let public_candidate = authenticated.candidate()?;
    if public_candidate.validate_self_receipt(authenticated.device_receipt())?
        != crate::native_device_binding_candidate::NativeDeviceReceiptObservation::Current
    {
        return Err(REFUSED.into());
    }
    let revision = crate::publish_authenticated_native_enrollment(app, &authenticated, || {
        aborted(app, &capture.attempt)
    })?;
    attempt.current_profile_revision = Some(revision);
    if attempt.transition_handle.is_none() {
        attempt.transition_handle = Some(random()?);
    }
    save(&capture.attempt, &attempt)?;
    native_relay_redemption::adopt_authenticated_native_enrollment(
        app,
        &attempt.owner.profile_name,
        revision,
        &authenticated,
    )?;
    if aborted(app, &capture.attempt)? {
        crate::retire_owned_native_enrollment(
            app,
            &attempt.owner.profile_name,
            authenticated.reference(),
        )?;
        return Err(REFUSED.into());
    }
    current(app, &attempt)?;
    Ok(NativeEnrollmentActivationAccepted {
        version: VERSION,
        enrollment_handle: capture.attempt,
        state: "active",
        profile_revision: revision,
        transition_handle: attempt
            .transition_handle
            .ok_or_else(|| REFUSED.to_owned())?,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_enrollment_activation_accept(
    window: tauri::WebviewWindow,
    app: AppHandle,
    request_handle: String,
    response: serde_json::Value,
) -> Result<NativeEnrollmentActivationAccepted> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = HOST_OPERATION.lock().map_err(|_| REFUSED.to_owned())?;
        let capture = consume_request(&app, &request_handle, "activate")?;
        accept_active(&app, capture, response)
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_enrollment_transition_current(
    window: tauri::WebviewWindow,
    app: AppHandle,
    enrollment_handle: String,
    transition_handle: String,
    expected_profile_revision: u64,
) -> Result<NativeEnrollmentActivationAccepted> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move||{
        let _operation=HOST_OPERATION.lock().map_err(|_|REFUSED.to_owned())?;
        let attempt=load_owned(&app,&enrollment_handle)?;
        if attempt.cancelled || aborted(&app,&enrollment_handle)? || attempt.transition_handle.as_deref()!=Some(transition_handle.as_str()) || attempt.current_profile_revision!=Some(expected_profile_revision){return Err(REFUSED.into());}
        let route=current(&app,&attempt)?;
        let candidate=attempt.candidate.as_ref().ok_or_else(||REFUSED.to_owned())?;
        native_relay_redemption::with_existing_native_device_candidate(&app,&attempt.owner.profile_name,expected_profile_revision,|captured|{
            if captured.context!=route.context || captured.grant_digest!=route.grant_digest || serde_json::to_value(&captured.candidate).map_err(|_|REFUSED.to_owned())?!=serde_json::to_value(candidate).map_err(|_|REFUSED.to_owned())?{return Err(REFUSED.into());}
            let manager=crate::native_device_binding_candidate::NativeDeviceBindingCandidateManager::system();
            let observed=manager.receipt_observation(&captured.authority,&captured.candidate)?.ok_or_else(||REFUSED.to_owned())?;
            if observed.status!=crate::native_device_binding_candidate::NativeDeviceReceiptObservation::Current {return Err(REFUSED.into());}
            Ok(())
        })?;
        Ok(NativeEnrollmentActivationAccepted{version:VERSION,enrollment_handle,state:"active",profile_revision:expected_profile_revision,transition_handle})
    }).await.map_err(|_|REFUSED.to_owned())?
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InactiveStatus {
    version: String,
    state: String,
    binding: NativeEnrollmentBinding,
    candidate: NativeEnrollmentCandidate,
    response_peer_nonce: String,
    observed_at: u64,
    station_signing_generation: u64,
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_enrollment_status_accept(
    window: tauri::WebviewWindow,
    app: AppHandle,
    request_handle: String,
    response: serde_json::Value,
) -> Result<serde_json::Value> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move||{
        let _operation=HOST_OPERATION.lock().map_err(|_|REFUSED.to_owned())?;
        let state=app.try_state::<NativeEnrollmentHost>().ok_or_else(||REFUSED.to_owned())?;
        let purpose=state.requests.lock().map_err(|_|REFUSED.to_owned())?.get(&request_handle).ok_or_else(||REFUSED.to_owned())?.purpose.clone();
        if purpose!="status" && purpose!="cancel" {return Err(REFUSED.into());}
        let capture=consume_request(&app,&request_handle,&purpose)?;
        if response.get("state").and_then(serde_json::Value::as_str)==Some("active") {
            if purpose=="cancel" {return Err(REFUSED.into());}
            return serde_json::to_value(accept_active(&app,capture,response)?).map_err(|_|REFUSED.to_owned());
        }
        let mut attempt=load_owned(&app,&capture.attempt)?;
        let signed:InactiveStatus=signed_response(&capture,response,"station-native-relay-enrollment-status+jws")?;
        if signed.version!=VERSION || !["pending","cancelled","expired","revoked"].contains(&signed.state.as_str()) || signed.binding!=attempt.challenge.as_ref().ok_or_else(||REFUSED.to_owned())?.binding() || Some(&signed.candidate)!=attempt.candidate.as_ref() || signed.response_peer_nonce!=capture.nonce || signed.station_signing_generation!=attempt.trust_generation || signed.observed_at>time()+5000 || time().saturating_sub(signed.observed_at)>30000 {return Err(REFUSED.into());}
        current(&app,&attempt)?;
        if signed.state!="pending" {
            if let Some(reference)=&attempt.credential_reference {crate::retire_owned_native_enrollment(&app,&attempt.owner.profile_name,reference)?;}
            attempt.cancelled=true;attempt.bundle=None;save(&capture.attempt,&attempt)?;
            finish_terminal_cleanup(&app,&capture.attempt,&attempt)?;
        }
        Ok(serde_json::json!({"version":VERSION,"enrollmentHandle":capture.attempt,"state":signed.state}))
    }).await.map_err(|_|REFUSED.to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_enrollment_cancel_prepare(
    window: tauri::WebviewWindow,
    app: AppHandle,
    enrollment_handle: String,
    peer_handle: String,
) -> Result<NativeEnrollmentPreparedRequest> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = HOST_OPERATION.lock().map_err(|_| REFUSED.to_owned())?;
        let attempt = load_owned(&app, &enrollment_handle)?;
        let id = &attempt
            .challenge
            .as_ref()
            .ok_or_else(|| REFUSED.to_owned())?
            .enrollment_id;
        sign_payload(
            &app,
            &peer_handle,
            &enrollment_handle,
            "cancel",
            serde_json::json!({"enrollmentId":id}),
        )
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_enrollment_abort(
    window: tauri::WebviewWindow,
    app: AppHandle,
    enrollment_handle: String,
) -> Result<()> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    native_enrollment::decode(&enrollment_handle, 32)?;
    let state = app
        .try_state::<NativeEnrollmentHost>()
        .ok_or_else(|| REFUSED.to_owned())?;
    {
        let mut flags = state.aborted.lock().map_err(|_| REFUSED.to_owned())?;
        if flags.len() >= 64 && !flags.contains(&enrollment_handle) {
            return Err(REFUSED.into());
        }
        flags.insert(enrollment_handle.clone());
    }
    state
        .requests
        .lock()
        .map_err(|_| REFUSED.to_owned())?
        .retain(|_, r| r.attempt != enrollment_handle);
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = HOST_OPERATION.lock().map_err(|_| REFUSED.to_owned())?;
        let mut attempt = load_owned(&app, &enrollment_handle)?;
        attempt.cancel_requested = true;
        save(&enrollment_handle, &attempt)?;
        if let Some(reference) = attempt.credential_reference {
            crate::retire_owned_native_enrollment(&app, &attempt.owner.profile_name, &reference)?;
        }
        Ok(())
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}

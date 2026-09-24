//! Desktop-only native host for pre-grant Station-key candidate enrollment.
//!
//! The renderer can courier an invitation and display public metadata, but it
//! cannot choose a URL, signing input, profile binding, or durable trust state.

use crate::native_relay_proof_key::{
    NativeBrokerKeyCandidateAction, NativeBrokerKeyCandidateChallenge,
    NativeBrokerRedemptionInvitation, NativeKeyCandidateTransport, NativeProofKeyChannel,
    NativeProofKeyOwner, NativeProofKeyPublicMetadata, NativeRelayProofKeyVault, P256PublicJwk,
    ProofKeyError,
};
use crate::native_station_key_custody::{
    CandidateBinding, CandidateError, NativeStationTrustStore, PendingStationKeyChallenge,
    StationTrustMutationReceipt, StationTrustPublicState, StationTrustStatus, TrustProfileBinding,
    VerifiedStationKeyCandidate,
};
use crate::{
    lock_station_profiles_for_app, native_app_channel, native_trust_profile_snapshot_in_store,
    parse_station_profile_store, read_station_profile_store, renderer_mount_label_admitted,
    selected_profile_from_store, station_profiles_path, AppHandle, AppNativeTrustProfileProvider,
    CredentialProfileStore,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{State, WebviewWindow};
use zeroize::{Zeroize, Zeroizing};

const MAX_PENDING: usize = 32;
const MAX_OPERATOR_WINDOW_MS: u64 = 60_000;
const MAX_READ_WAIT_MS: u64 = 10_000;
const READ_RETRY_MS: u64 = 250;

#[derive(Default, Clone)]
pub(crate) struct NativeRelayKeyApprovalState(Arc<Mutex<ApprovalState>>);

#[derive(Default)]
struct ApprovalState {
    pending: HashMap<String, PendingApproval>,
    inflight: HashMap<String, Arc<AtomicBool>>,
}

struct PendingApproval {
    caller_label: String,
    profile_name: String,
    expires_at: u64,
    candidate: VerifiedStationKeyCandidate,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct BeginRequest {
    profile_name: String,
    invitation: InvitationInput,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ApproveRequest {
    pending_id: String,
    confirmation_code: String,
    full_key_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RevokeRequest {
    profile_name: String,
    expected_trust_revision: u64,
    full_key_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct InvitationInput {
    version: String,
    broker_origin: String,
    scope: InvitationScope,
    station_signing_key_id: String,
    station_signing_generation: u64,
    surface: InvitationSurface,
    invitation_id: String,
    invitation_secret: SecretInput,
    expires_at: u64,
}

struct SecretInput(String);

impl<'de> Deserialize<'de> for SecretInput {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        String::deserialize(deserializer).map(Self)
    }
}

impl Drop for SecretInput {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl fmt::Debug for SecretInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretInput([REDACTED])")
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InvitationScope {
    station_id: String,
    enrollment_id: String,
    routing_generation: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InvitationSurface {
    kind: String,
    app_identifier: String,
    channel: String,
    client_instance_id: String,
    key_thumbprint: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedMetadata {
    profile_name: String,
    broker_origin: String,
    station_id: String,
    enrollment_id: String,
    app_identifier: String,
    channel: String,
    client_instance_id: String,
    key_thumbprint: String,
    public_key: P256PublicJwk,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingCandidateDto {
    status: &'static str,
    pending_id: String,
    profile_name: String,
    broker_origin: String,
    station_id: String,
    enrollment_id: String,
    generation: u64,
    key_id: String,
    confirmation_code: String,
    expires_at: u64,
    trust_revision: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrustStatusDto {
    profile_name: String,
    broker_origin: String,
    station_id: String,
    enrollment_id: String,
    generation: Option<u64>,
    key_id: Option<String>,
    status: &'static str,
    trust_revision: u64,
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_key_approval_prepare(
    window: WebviewWindow,
    app: AppHandle,
    profile_name: String,
) -> Result<PreparedMetadata, String> {
    require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move || prepare(&app, &profile_name))
        .await
        .map_err(|_| "Station could not prepare native relay-key metadata.".to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_key_approval_begin(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeRelayKeyApprovalState>,
    profile_name: String,
    invitation: InvitationInput,
) -> Result<PendingCandidateDto, String> {
    require_main_app_window(&window, &app)?;
    let state = state.inner().clone();
    let label = window.label().to_owned();
    if profile_name.is_empty() || profile_name.len() > 256 {
        return Err("The selected Station profile name is invalid.".into());
    }
    let cancelled = reserve_begin(&state, &profile_name)?;
    tauri::async_runtime::spawn_blocking(move || {
        begin_reserved(
            &app,
            &state,
            &label,
            BeginRequest {
                profile_name,
                invitation,
            },
            &cancelled,
        )
    })
    .await
    .map_err(|_| "Station could not begin native relay-key enrollment.".to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn station_native_relay_key_approval_pending(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeRelayKeyApprovalState>,
    profile_name: String,
) -> Result<Option<PendingCandidateDto>, String> {
    require_main_app_window(&window, &app)?;
    pending(state.inner(), window.label(), &profile_name)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn station_native_relay_key_approval_cancel(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeRelayKeyApprovalState>,
    profile_name: String,
) -> Result<(), String> {
    require_main_app_window(&window, &app)?;
    cancel(state.inner(), window.label(), &profile_name)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_key_approval_approve(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeRelayKeyApprovalState>,
    pending_id: String,
    confirmation_code: String,
    full_key_id: String,
) -> Result<TrustStatusDto, String> {
    require_main_app_window(&window, &app)?;
    let state = state.inner().clone();
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        approve(
            &app,
            &state,
            &label,
            ApproveRequest {
                pending_id,
                confirmation_code,
                full_key_id,
            },
        )
    })
    .await
    .map_err(|_| "Station could not approve native relay-key trust.".to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_key_approval_revoke(
    window: WebviewWindow,
    app: AppHandle,
    profile_name: String,
    expected_trust_revision: u64,
    full_key_id: String,
) -> Result<TrustStatusDto, String> {
    require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        revoke(
            &app,
            RevokeRequest {
                profile_name,
                expected_trust_revision,
                full_key_id,
            },
        )
    })
    .await
    .map_err(|_| "Station could not revoke native relay-key trust.".to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_key_approval_status(
    window: WebviewWindow,
    app: AppHandle,
    profile_name: String,
) -> Result<TrustStatusDto, String> {
    require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move || status(&app, &profile_name))
        .await
        .map_err(|_| "Station could not read native relay-key trust.".to_owned())?
}

fn require_main_app_window(window: &WebviewWindow, app: &AppHandle) -> Result<(), String> {
    if !renderer_mount_label_admitted(window.label()) {
        return Err(
            "Native relay-key approval is available only from Station's main window.".into(),
        );
    }
    let actual = window
        .url()
        .map_err(|_| "Station could not verify the calling WebView origin.".to_owned())?;
    let app_url = match app.config().build.dev_url.as_ref() {
        Some(dev_url) => url::Url::parse(dev_url.as_str()).ok(),
        None => None,
    };
    if !main_app_origin_admitted(
        window.label(),
        &actual,
        app_url.as_ref(),
        cfg!(debug_assertions),
    ) {
        return Err("Native relay-key approval requires Station's local app document.".into());
    }
    Ok(())
}

fn main_app_origin_admitted(
    label: &str,
    actual: &url::Url,
    dev_url: Option<&url::Url>,
    allow_dev_origin: bool,
) -> bool {
    renderer_mount_label_admitted(label)
        && ((allow_dev_origin && dev_url.is_some_and(|url| url.origin() == actual.origin()))
            || matches!(
                (actual.scheme(), actual.host_str()),
                ("tauri", Some("localhost"))
                    | ("https", Some("tauri.localhost"))
                    | ("http", Some("tauri.localhost"))
            ))
}

fn prepare(app: &AppHandle, requested_name: &str) -> Result<PreparedMetadata, String> {
    let (binding, revision) = current_profile_binding(app, requested_name)?;
    let owner = owner_for_binding(&binding)?;
    let vault = NativeRelayProofKeyVault::new();
    let public = match vault.restore(&owner) {
        Ok(public) => public,
        Err(ProofKeyError::Missing) => match vault.create(&owner) {
            Ok(public) => public,
            Err(ProofKeyError::AlreadyExists) => vault
                .restore(&owner)
                .map_err(|_| "Station could not open its native relay proof key.".to_owned())?,
            Err(_) => return Err("Station could not create its native relay proof key.".into()),
        },
        Err(_) => return Err("Station could not open its native relay proof key.".into()),
    };
    // Recheck after keyring access so a profile switch or edit cannot make
    // metadata from a stale snapshot appear as the current selected route.
    let provider = crate::AppNativeTrustProfileProvider::enrollment(app);
    let mut trust = NativeStationTrustStore::system();
    let _ = trust
        .current_state(&provider, &binding, revision)
        .map_err(map_candidate_error)?;
    Ok(prepared_metadata(&binding, &public))
}

fn prepared_metadata(
    binding: &TrustProfileBinding,
    public: &NativeProofKeyPublicMetadata,
) -> PreparedMetadata {
    PreparedMetadata {
        profile_name: binding.profile_owner_id.clone(),
        broker_origin: binding.broker_origin.clone(),
        station_id: binding.station_id.clone(),
        enrollment_id: binding.enrollment_id.clone(),
        app_identifier: binding.app_identifier.clone(),
        channel: binding.channel.clone(),
        client_instance_id: binding.client_instance_id.clone(),
        key_thumbprint: public.thumbprint().to_owned(),
        public_key: public.jwk().clone(),
    }
}

fn begin_reserved(
    app: &AppHandle,
    state: &NativeRelayKeyApprovalState,
    caller_label: &str,
    request: BeginRequest,
    cancelled: &Arc<AtomicBool>,
) -> Result<PendingCandidateDto, String> {
    let profile_name = request.profile_name.clone();
    let result = run_if_active(cancelled, || {
        begin_network(app, state, caller_label, request, cancelled)
    });
    clear_inflight(state, &profile_name, cancelled);
    result
}

fn run_if_active<T>(
    cancelled: &Arc<AtomicBool>,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("Native relay-key enrollment was cancelled.".into());
    }
    operation()
}

fn begin_network(
    app: &AppHandle,
    state: &NativeRelayKeyApprovalState,
    caller_label: &str,
    request: BeginRequest,
    cancelled: &Arc<AtomicBool>,
) -> Result<PendingCandidateDto, String> {
    let (binding, profile_revision) = current_profile_binding(app, &request.profile_name)?;
    let owner = owner_for_binding(&binding)?;
    let vault = NativeRelayProofKeyVault::new();
    let public = vault
        .restore(&owner)
        .map_err(|_| "Station's prepared native relay proof key is unavailable.".to_owned())?;
    validate_invitation_surface(&request.invitation, &binding, &public)?;
    let invitation = invitation_for_host(request.invitation)?;

    let provider = AppNativeTrustProfileProvider::enrollment(app);
    let mut trust = NativeStationTrustStore::system();
    let existing = trust
        .current_state(&provider, &binding, profile_revision)
        .map_err(map_candidate_error)?;
    if existing.status == Some(StationTrustStatus::Approved) {
        return Err("This Station route already has approved relay-key trust.".into());
    }
    let candidate_binding = CandidateBinding {
        profile_owner_id: binding.profile_owner_id.clone(),
        app_identifier: binding.app_identifier.clone(),
        channel: binding.channel.clone(),
        profile_revision,
        expected_trust_revision: existing.revision,
        broker_origin: binding.broker_origin.clone(),
        station_id: binding.station_id.clone(),
        enrollment_id: binding.enrollment_id.clone(),
        client_instance_id: binding.client_instance_id.clone(),
        client_key_thumbprint: public.thumbprint().to_owned(),
        expected_station_signing_key_id: invitation.station_signing_key_id.clone(),
        expected_station_signing_generation: invitation.station_signing_generation,
    };
    let invitation_expires_at = invitation.expires_at;
    let challenge_started_ms = now_ms()?;
    let challenge =
        PendingStationKeyChallenge::begin(candidate_binding).map_err(map_candidate_error)?;
    let nonce = challenge.challenge().to_owned();
    let request_challenge = NativeBrokerKeyCandidateChallenge::from_invitation(
        &owner,
        &public,
        invitation,
        &nonce,
        NativeBrokerKeyCandidateAction::Request,
    )
    .map_err(|_| "Station rejected the selected broker invitation.".to_owned())?;
    let fixed_deadline_ms = request_challenge
        .expires_at()
        .min(challenge_started_ms.saturating_add(MAX_READ_WAIT_MS));
    let request_signature = vault
        .sign_key_candidate_es256_p1363(&owner, &request_challenge)
        .map_err(|_| "Station could not sign the fixed native candidate request.".to_owned())?;
    let transport = NativeKeyCandidateTransport::new();
    let requested = transport
        .send_result(
            &request_challenge,
            &request_signature,
            fixed_deadline_ms,
            clock_millis,
        )
        .map_err(|_| {
            "The selected broker did not accept the native candidate request.".to_owned()
        })?;
    let deadline_ms = requested.expires_at;
    let read_challenge = request_challenge
        .with_action(NativeBrokerKeyCandidateAction::Read)
        .map_err(|_| "Station could not prepare the fixed native candidate read.".to_owned())?;
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err("Native relay-key enrollment was cancelled.".into());
        }
        if now_ms()? >= deadline_ms {
            return Err(
                "No signed Station-key candidate arrived before the request expired.".into(),
            );
        }
        let signature = vault
            .sign_key_candidate_es256_p1363(&owner, &read_challenge)
            .map_err(|_| "Station could not sign the fixed native candidate read.".to_owned())?;
        let result = transport
            .send_result(&read_challenge, &signature, deadline_ms, clock_millis)
            .map_err(|_| {
                "Station could not read the signed candidate from the selected broker.".to_owned()
            })?;
        if let Some(candidate) = result.candidate {
            let verified = challenge
                .verify(&candidate.compact_jws, now_seconds()?)
                .map_err(map_candidate_error)?;
            let expiry_ms = verified
                .expires_at()
                .checked_mul(1000)
                .ok_or_else(|| "The Station-key candidate expiry is invalid.".to_owned())?
                .min(invitation_expires_at)
                .min(challenge_started_ms.saturating_add(MAX_OPERATOR_WINDOW_MS));
            if cancelled.load(Ordering::Acquire) {
                return Err("Native relay-key enrollment was cancelled.".into());
            }
            if expiry_ms <= now_ms()? {
                return Err(
                    "The signed Station-key candidate expired before it could be staged.".into(),
                );
            }
            // The profile and trust CAS are re-read after network I/O, before
            // any renderer-visible pending ID is staged.
            let current = trust
                .current_state(&provider, &binding, profile_revision)
                .map_err(map_candidate_error)?;
            if current.revision != existing.revision {
                return Err(
                    "Station relay-key trust changed while the candidate was in flight.".into(),
                );
            }
            if cancelled.load(Ordering::Acquire) {
                return Err("Native relay-key enrollment was cancelled.".into());
            }
            let pending_id = uuid::Uuid::new_v4().to_string();
            let dto = pending_dto(&pending_id, &verified, expiry_ms, existing.revision);
            stage_pending(
                state,
                pending_id,
                caller_label,
                binding.profile_owner_id.clone(),
                expiry_ms,
                verified,
                cancelled,
            )?;
            return Ok(dto);
        }
        std::thread::sleep(Duration::from_millis(
            READ_RETRY_MS.min(deadline_ms.saturating_sub(now_ms()?)),
        ));
    }
}

fn pending(
    state: &NativeRelayKeyApprovalState,
    caller_label: &str,
    requested_name: &str,
) -> Result<Option<PendingCandidateDto>, String> {
    if requested_name.is_empty() || requested_name.len() > 256 {
        return Err("The selected Station profile name is invalid.".into());
    }
    let now = now_ms()?;
    let mut state = state
        .0
        .lock()
        .map_err(|_| "Native relay-key state is unavailable.".to_owned())?;
    state.pending.retain(|_, entry| entry.expires_at > now);
    Ok(state
        .pending
        .iter()
        .find(|(_, entry)| {
            entry.caller_label == caller_label
                && entry.profile_name.eq_ignore_ascii_case(requested_name)
        })
        .map(|(id, entry)| {
            pending_dto(
                id,
                &entry.candidate,
                entry.expires_at,
                entry.candidate.expected_trust_revision(),
            )
        }))
}

fn cancel(
    state: &NativeRelayKeyApprovalState,
    caller_label: &str,
    profile_name: &str,
) -> Result<(), String> {
    if profile_name.is_empty() || profile_name.len() > 256 {
        return Err("The selected Station profile name is invalid.".into());
    }
    let mut state = state
        .0
        .lock()
        .map_err(|_| "Native relay-key state is unavailable.".to_owned())?;
    if let Some(token) = state.inflight.remove(&profile_name.to_lowercase()) {
        token.store(true, Ordering::Release);
    }
    state.pending.retain(|_, entry| {
        !(entry.caller_label == caller_label
            && entry.profile_name.eq_ignore_ascii_case(profile_name))
    });
    Ok(())
}

fn approve(
    app: &AppHandle,
    state: &NativeRelayKeyApprovalState,
    caller_label: &str,
    request: ApproveRequest,
) -> Result<TrustStatusDto, String> {
    if request.confirmation_code.len() != 16 || request.full_key_id.len() != 43 {
        return Err(
            "Enter the full 16-character confirmation code and 43-character Station-key ID.".into(),
        );
    }
    let pending = {
        let mut state = state
            .0
            .lock()
            .map_err(|_| "Native relay-key state is unavailable.".to_owned())?;
        let entry = state.pending.get(&request.pending_id).ok_or_else(|| {
            "The native relay-key candidate is missing, expired, or already used.".to_owned()
        })?;
        if entry.caller_label != caller_label || entry.expires_at <= now_ms()? {
            return Err(
                "The native relay-key candidate is missing, expired, or already used.".into(),
            );
        }
        state.pending.remove(&request.pending_id).ok_or_else(|| {
            "The native relay-key candidate is missing, expired, or already used.".to_owned()
        })?
    };
    let binding = trust_binding_from_candidate(&pending.candidate);
    let provider = AppNativeTrustProfileProvider::enrollment(app);
    let mut trust = NativeStationTrustStore::system();
    let receipt = trust
        .approve_until(
            &provider,
            pending.candidate,
            &request.confirmation_code,
            &request.full_key_id,
            pending.expires_at,
        )
        .map_err(map_candidate_error)?;
    Ok(status_from_receipt(&pending.profile_name, binding, receipt))
}

fn revoke(app: &AppHandle, request: RevokeRequest) -> Result<TrustStatusDto, String> {
    if request.full_key_id.len() != 43 {
        return Err("Enter the full 43-character Station-key ID to revoke trust.".into());
    }
    let (binding, revision) = current_profile_binding(app, &request.profile_name)?;
    let provider = AppNativeTrustProfileProvider::existing_trust(app);
    let mut trust = NativeStationTrustStore::system();
    let receipt = trust
        .revoke(
            &provider,
            &binding,
            revision,
            request.expected_trust_revision,
            &request.full_key_id,
        )
        .map_err(map_candidate_error)?;
    let profile_name = binding.profile_owner_id.clone();
    Ok(status_from_receipt(&profile_name, binding, receipt))
}

fn status(app: &AppHandle, requested_name: &str) -> Result<TrustStatusDto, String> {
    let (binding, revision) = current_profile_binding(app, requested_name)?;
    let provider = AppNativeTrustProfileProvider::existing_trust(app);
    let mut trust = NativeStationTrustStore::system();
    let state = trust
        .current_state(&provider, &binding, revision)
        .map_err(map_candidate_error)?;
    Ok(status_from_state(&binding, state))
}

fn status_from_state(
    binding: &TrustProfileBinding,
    state: StationTrustPublicState,
) -> TrustStatusDto {
    let trust_revision = if state.status.is_some() {
        state.revision
    } else {
        0
    };
    TrustStatusDto {
        profile_name: binding.profile_owner_id.clone(),
        broker_origin: binding.broker_origin.clone(),
        station_id: state.station_id,
        enrollment_id: binding.enrollment_id.clone(),
        generation: state.generation,
        key_id: state.key_id,
        status: match state.status {
            Some(StationTrustStatus::Approved) => "approved",
            Some(StationTrustStatus::Revoked) => "revoked",
            None => "untrusted",
        },
        trust_revision,
    }
}

fn status_from_receipt(
    profile_name: &str,
    binding: TrustProfileBinding,
    receipt: StationTrustMutationReceipt,
) -> TrustStatusDto {
    TrustStatusDto {
        profile_name: profile_name.to_owned(),
        broker_origin: binding.broker_origin,
        station_id: receipt.station_id,
        enrollment_id: binding.enrollment_id,
        generation: Some(receipt.generation),
        key_id: Some(receipt.key_id),
        status: match receipt.status {
            StationTrustStatus::Approved => "approved",
            StationTrustStatus::Revoked => "revoked",
        },
        trust_revision: receipt.revision,
    }
}

fn pending_dto(
    pending_id: &str,
    candidate: &VerifiedStationKeyCandidate,
    expires_at: u64,
    trust_revision: u64,
) -> PendingCandidateDto {
    PendingCandidateDto {
        status: "pending",
        pending_id: pending_id.to_owned(),
        profile_name: candidate.profile_owner_id().to_owned(),
        broker_origin: candidate.profile_binding().broker_origin.clone(),
        station_id: candidate.station_id().to_owned(),
        enrollment_id: candidate.enrollment_id().to_owned(),
        generation: candidate.generation(),
        key_id: candidate.key_id().to_owned(),
        confirmation_code: candidate.confirmation_code().to_owned(),
        expires_at,
        trust_revision,
    }
}

fn trust_binding_from_candidate(candidate: &VerifiedStationKeyCandidate) -> TrustProfileBinding {
    candidate.profile_binding().clone()
}

fn reserve_begin(
    state: &NativeRelayKeyApprovalState,
    profile_name: &str,
) -> Result<Arc<AtomicBool>, String> {
    let mut state = state
        .0
        .lock()
        .map_err(|_| "Native relay-key state is unavailable.".to_owned())?;
    let key = profile_name.to_lowercase();
    if let Some(old) = state.inflight.remove(&key) {
        old.store(true, Ordering::Release);
    }
    let token = Arc::new(AtomicBool::new(false));
    state.inflight.insert(key, token.clone());
    state
        .pending
        .retain(|_, entry| !entry.profile_name.eq_ignore_ascii_case(profile_name));
    Ok(token)
}

fn clear_inflight(
    state: &NativeRelayKeyApprovalState,
    profile_name: &str,
    token: &Arc<AtomicBool>,
) {
    if let Ok(mut state) = state.0.lock() {
        let key = profile_name.to_lowercase();
        if state
            .inflight
            .get(&key)
            .is_some_and(|active| Arc::ptr_eq(active, token))
        {
            state.inflight.remove(&key);
        }
    }
}

fn stage_pending(
    state: &NativeRelayKeyApprovalState,
    pending_id: String,
    caller_label: &str,
    profile_name: String,
    expires_at: u64,
    candidate: VerifiedStationKeyCandidate,
    cancelled: &Arc<AtomicBool>,
) -> Result<(), String> {
    let now = now_ms()?;
    let mut state = state
        .0
        .lock()
        .map_err(|_| "Native relay-key state is unavailable.".to_owned())?;
    if cancelled.load(Ordering::Acquire)
        || !state
            .inflight
            .get(&profile_name.to_lowercase())
            .is_some_and(|active| Arc::ptr_eq(active, cancelled))
    {
        return Err("Native relay-key enrollment was cancelled.".into());
    }
    state.pending.retain(|_, entry| entry.expires_at > now);
    if state.pending.len() >= MAX_PENDING {
        return Err("Too many native relay-key candidates are pending.".into());
    }
    state.pending.insert(
        pending_id,
        PendingApproval {
            caller_label: caller_label.to_owned(),
            profile_name,
            expires_at,
            candidate,
        },
    );
    Ok(())
}

fn current_profile_binding(
    app: &AppHandle,
    requested_name: &str,
) -> Result<(TrustProfileBinding, u64), String> {
    if requested_name.is_empty() || requested_name.len() > 256 {
        return Err("The selected Station profile name is invalid.".into());
    }
    let path = station_profiles_path(app)?;
    let _lock = lock_station_profiles_for_app(app, &path)?;
    let contents = read_station_profile_store(&path)
        .map_err(|_| "Station could not read its saved profile metadata.".to_owned())?;
    let store = parse_station_profile_store(&contents)?;
    binding_from_store(&store, requested_name, app)
}

fn binding_from_store(
    store: &CredentialProfileStore,
    requested_name: &str,
    app: &AppHandle,
) -> Result<(TrustProfileBinding, u64), String> {
    use crate::native_station_key_custody::CandidateError as TrustError;
    let profile = selected_profile_from_store(store, requested_name)?;
    let route = profile
        .relay_route
        .as_ref()
        .ok_or_else(|| "The selected Station profile has no saved relay route.".to_owned())?;
    let binding = TrustProfileBinding {
        profile_owner_id: profile.name.clone(),
        app_identifier: app.config().identifier.clone(),
        channel: native_app_channel(&app.config().identifier, cfg!(debug_assertions)).to_owned(),
        client_instance_id: profile.client_instance_id.clone().ok_or_else(|| {
            "The selected Station profile has no client instance identity.".to_owned()
        })?,
        broker_origin: route.broker_origin.clone(),
        station_id: route.station_id.clone(),
        enrollment_id: route.enrollment_id.clone(),
    };
    native_trust_profile_snapshot_in_store(
        store,
        &binding,
        store.revision,
        &app.config().identifier,
        native_app_channel(&app.config().identifier, cfg!(debug_assertions)),
    )
    .map_err(|error| match error {
        TrustError::ProfileStale => {
            "The selected Station profile changed or is not eligible for native relay-key trust."
                .to_owned()
        }
        other => map_candidate_error(other),
    })?;
    Ok((binding, store.revision))
}

fn owner_for_binding(binding: &TrustProfileBinding) -> Result<NativeProofKeyOwner, String> {
    let channel = match binding.channel.as_str() {
        "stable" => NativeProofKeyChannel::Stable,
        "beta" => NativeProofKeyChannel::Beta,
        "nightly" => NativeProofKeyChannel::Nightly,
        "dev" => NativeProofKeyChannel::Dev,
        _ => return Err("Station could not identify the current application channel.".into()),
    };
    NativeProofKeyOwner::new(
        &binding.app_identifier,
        channel,
        &binding.client_instance_id,
    )
    .map_err(|_| "Station could not bind the native relay proof key to this installation.".into())
}

fn validate_invitation_surface(
    invitation: &InvitationInput,
    binding: &TrustProfileBinding,
    public: &NativeProofKeyPublicMetadata,
) -> Result<(), String> {
    if invitation.version != "station-broker-native-route-invitation/v2"
        || invitation.broker_origin != binding.broker_origin
        || invitation.scope.station_id != binding.station_id
        || invitation.scope.enrollment_id != binding.enrollment_id
        || invitation.surface.kind != "station-native"
        || invitation.surface.app_identifier != binding.app_identifier
        || invitation.surface.channel != binding.channel
        || invitation.surface.client_instance_id != binding.client_instance_id
        || invitation.surface.key_thumbprint != public.thumbprint()
    {
        return Err(
            "The broker invitation does not match the selected Station route and installation."
                .into(),
        );
    }
    Ok(())
}

fn invitation_for_host(
    mut input: InvitationInput,
) -> Result<NativeBrokerRedemptionInvitation, String> {
    if input.invitation_secret.0.is_empty() || input.invitation_secret.0.len() > 4096 {
        return Err("The broker invitation is invalid.".into());
    }
    Ok(NativeBrokerRedemptionInvitation {
        broker_origin: input.broker_origin,
        station_id: input.scope.station_id,
        enrollment_id: input.scope.enrollment_id,
        routing_generation: input.scope.routing_generation,
        station_signing_key_id: input.station_signing_key_id,
        station_signing_generation: input.station_signing_generation,
        app_identifier: input.surface.app_identifier,
        invitation_id: input.invitation_id,
        invitation_secret: Zeroizing::new(std::mem::take(&mut input.invitation_secret.0)),
        expires_at: input.expires_at,
    })
}

fn map_candidate_error(error: CandidateError) -> String {
    match error {
        CandidateError::ProfileStale => {
            "The selected Station profile changed. Refresh and try again.".into()
        }
        CandidateError::TrustRevisionConflict => {
            "Native Station-key trust changed. Refresh and try again.".into()
        }
        CandidateError::OperatorConfirmationMismatch => {
            "The confirmation code or full Station-key ID did not match.".into()
        }
        CandidateError::Stale => {
            "The signed Station-key candidate expired. Request a new invitation.".into()
        }
        CandidateError::GenerationRollback => {
            "The Station-key candidate is older than the trusted generation.".into()
        }
        CandidateError::TrustStore => {
            "The native Station-key trust store is unavailable or invalid.".into()
        }
        CandidateError::BindingMismatch | CandidateError::Invalid => {
            "Station rejected the signed Station-key candidate.".into()
        }
    }
}

fn now_ms() -> Result<u64, String> {
    now_millis()
}

fn clock_millis() -> u64 {
    now_millis().unwrap_or(u64::MAX)
}

fn now_seconds() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| "Station's system clock is invalid.".to_owned())
}

fn now_millis() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .ok_or_else(|| "Station's system clock is invalid.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_relay_proof_key::MemoryNativeRelayProofKeyVault;
    use serde_json::json;

    fn binding() -> TrustProfileBinding {
        TrustProfileBinding {
            profile_owner_id: "Zach's Station".into(),
            app_identifier: "io.kontourai.station".into(),
            channel: "stable".into(),
            client_instance_id: "33333333-3333-4333-8333-333333333333".into(),
            broker_origin: "https://broker.example".into(),
            station_id: "11111111-1111-4111-8111-111111111111".into(),
            enrollment_id: "22222222-2222-4222-8222-222222222222".into(),
        }
    }

    fn public_key() -> NativeProofKeyPublicMetadata {
        let owner = NativeProofKeyOwner::new(
            "io.kontourai.station",
            NativeProofKeyChannel::Stable,
            "33333333-3333-4333-8333-333333333333",
        )
        .unwrap();
        MemoryNativeRelayProofKeyVault::new()
            .create(&owner)
            .unwrap()
    }

    fn invitation(
        binding: &TrustProfileBinding,
        public: &NativeProofKeyPublicMetadata,
    ) -> InvitationInput {
        InvitationInput {
            version: "station-broker-native-route-invitation/v2".into(),
            broker_origin: binding.broker_origin.clone(),
            scope: InvitationScope {
                station_id: binding.station_id.clone(),
                enrollment_id: binding.enrollment_id.clone(),
                routing_generation: 9,
            },
            station_signing_key_id: "K".repeat(43),
            station_signing_generation: 4,
            surface: InvitationSurface {
                kind: "station-native".into(),
                app_identifier: binding.app_identifier.clone(),
                channel: binding.channel.clone(),
                client_instance_id: binding.client_instance_id.clone(),
                key_thumbprint: public.thumbprint().to_owned(),
            },
            invitation_id: "invite-12345678".into(),
            invitation_secret: SecretInput("S".repeat(43)),
            expires_at: 1_900_000_000_000,
        }
    }

    #[test]
    fn main_window_origin_admission_rejects_popouts_and_external_pages() {
        let packaged = url::Url::parse("tauri://localhost/index.html").unwrap();
        let external = url::Url::parse("https://example.com/index.html").unwrap();
        let dev = url::Url::parse("http://localhost:1420/").unwrap();
        let dev_page = url::Url::parse("http://localhost:1420/#/relay").unwrap();
        assert!(main_app_origin_admitted("main", &packaged, None, false));
        assert!(!main_app_origin_admitted(
            "workspace-pane-pop-out-x",
            &packaged,
            None,
            false,
        ));
        assert!(!main_app_origin_admitted("main", &external, None, false));
        assert!(main_app_origin_admitted(
            "main",
            &dev_page,
            Some(&dev),
            true
        ));
        assert!(!main_app_origin_admitted(
            "main",
            &dev_page,
            Some(&dev),
            false
        ));
        let other_dev = url::Url::parse("http://localhost:1421/").unwrap();
        assert!(!main_app_origin_admitted(
            "main",
            &dev_page,
            Some(&other_dev),
            true,
        ));
    }

    #[test]
    fn case_variant_begin_replaces_attempt_and_cancel_invalidates_it() {
        let state = NativeRelayKeyApprovalState::default();
        let first = reserve_begin(&state, "Zach's Station").unwrap();
        let second = reserve_begin(&state, "ZACH'S STATION").unwrap();
        assert!(first.load(Ordering::Acquire));
        assert!(!second.load(Ordering::Acquire));
        cancel(&state, "main", "zAch's sTation").unwrap();
        assert!(second.load(Ordering::Acquire));
        assert!(state.0.lock().unwrap().inflight.is_empty());
    }

    #[test]
    fn cancel_before_spawn_prevents_late_worker_from_staging() {
        let state = NativeRelayKeyApprovalState::default();
        let token = reserve_begin(&state, "Zach's Station").unwrap();
        // The native command reserves before it schedules spawn_blocking.
        cancel(&state, "main", "Zach's Station").unwrap();
        let mut worker_ran = false;
        let outcome = run_if_active(&token, || {
            worker_ran = true;
            Ok(())
        });
        assert!(outcome.is_err());
        assert!(!worker_ran);
        let state = state.0.lock().unwrap();
        assert!(state.pending.is_empty());
        assert!(state.inflight.is_empty());
    }

    #[test]
    fn invite_surface_must_match_original_saved_installation_and_key() {
        let binding = binding();
        let public = public_key();
        let mut invite = invitation(&binding, &public);
        assert!(validate_invitation_surface(&invite, &binding, &public).is_ok());
        invite.surface.client_instance_id = "44444444-4444-4444-8444-444444444444".into();
        assert!(validate_invitation_surface(&invite, &binding, &public).is_err());
        invite.surface.client_instance_id = binding.client_instance_id.clone();
        invite.surface.key_thumbprint = "T".repeat(43);
        assert!(validate_invitation_surface(&invite, &binding, &public).is_err());
    }

    #[test]
    fn wire_dtos_are_camel_case_and_contain_public_values_only() {
        let binding = binding();
        let public = public_key();
        let prepared = prepared_metadata(&binding, &public);
        let value = serde_json::to_value(prepared).unwrap();
        assert_eq!(value["profileName"], "Zach's Station");
        assert_eq!(value["brokerOrigin"], "https://broker.example");
        assert_eq!(value["publicKey"]["kty"], "EC");
        assert!(value.get("privateKey").is_none());
        assert!(value.get("invitationSecret").is_none());

        let status = TrustStatusDto {
            profile_name: binding.profile_owner_id,
            broker_origin: binding.broker_origin,
            station_id: binding.station_id,
            enrollment_id: binding.enrollment_id,
            generation: None,
            key_id: None,
            status: "untrusted",
            trust_revision: 0,
        };
        let value = serde_json::to_value(status).unwrap();
        assert_eq!(value["status"], "untrusted");
        assert_eq!(value["trustRevision"], 0);
        assert_eq!(value["keyId"], serde_json::Value::Null);
        assert_eq!(
            value["enrollmentId"],
            "22222222-2222-4222-8222-222222222222"
        );
    }

    #[test]
    fn invitation_wire_is_closed_and_secret_debug_is_redacted() {
        let raw = json!({
            "version": "station-broker-native-route-invitation/v2",
            "brokerOrigin": "https://broker.example",
            "scope": {"stationId": "11111111-1111-4111-8111-111111111111", "enrollmentId": "22222222-2222-4222-8222-222222222222", "routingGeneration": 9},
            "stationSigningKeyId": "K".repeat(43),
            "stationSigningGeneration": 4,
            "surface": {"kind": "station-native", "appIdentifier": "io.kontourai.station", "channel": "stable", "clientInstanceId": "33333333-3333-4333-8333-333333333333", "keyThumbprint": "T".repeat(43)},
            "invitationId": "invite-12345678",
            "invitationSecret": "SECRET-MUST-NOT-APPEAR",
            "expiresAt": 1_900_000_000_000u64
        });
        let parsed: InvitationInput = serde_json::from_value(raw.clone()).unwrap();
        assert!(!format!("{:?}", parsed).contains("SECRET-MUST-NOT-APPEAR"));
        let mut with_unknown = raw;
        with_unknown["rendererUrl"] = json!("https://attacker.example/");
        assert!(serde_json::from_value::<InvitationInput>(with_unknown).is_err());
    }
}

//! Bounded native account proofs; identity comes from the reconciled Device owner.

use crate::native_account_proof_key::{
    AccountProofKeyError, NativeAccountProofKeyOwner, NativeAccountProofKeyPublicMetadata,
    NativeAccountProofKeyVault,
};
use crate::native_application_peer::with_current_reconciled_native_device_owner;
use crate::native_device_binding_candidate::NativeDeviceBindingSurfaceV1;
use crate::native_relay_proof_key::P256PublicJwk;
use crate::native_relay_redemption::NativeDeviceReceiptCapture;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::{
    digest::{digest, SHA256},
    rand::{SecureRandom as _, SystemRandom},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, WebviewWindow};

const VERSION: &str = "station.application-session-native/v1";
const OPERATION_VERSION: &str = "station-native-account-operation/v1";
const PROOF_TYPE: &str = "station.application-session-native+jwt";
const CHALLENGE_PATH: &str = "/api/account-auth/continuations/native/challenge";
const EXCHANGE_PATH: &str = "/api/account-auth/continuations/native/exchange";
const REVOKE_PATH: &str = "/api/account-auth/continuations/native/revoke";
const ACCEPT_INVITATION_PATH: &str = "/api/account-auth/accept-invitation";
const CONTINUATION_HEADER: &str = "X-Station-Native-Account-Continuation";
const PROOF_HEADER: &str = "X-Station-Native-Account-Proof";
const REFUSED: &str = "native_account_operation_refused";
const MAX_CONTEXTS: usize = 16;
const CONTEXT_LIFETIME_MS: u64 = 15 * 60_000;
const CHALLENGE_LIFETIME_MS: u64 = 120_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
type Result<T> = std::result::Result<T, String>;

fn refused<T>() -> Result<T> {
    Err(REFUSED.to_owned())
}
fn now_ms() -> Result<u64> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| REFUSED.to_owned())?
        .as_millis();
    if now == 0 || now > MAX_SAFE_INTEGER as u128 {
        return refused();
    }
    Ok(now as u64)
}
fn opaque(value: &str) -> bool {
    value.len() == 43
        && URL_SAFE_NO_PAD
            .decode(value)
            .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == value)
}
fn random_id<const N: usize>() -> Result<String> {
    let mut bytes = [0_u8; N];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| REFUSED.to_owned())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn sha256(value: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(digest(&SHA256, value))
}
fn key_owner(capture: &NativeDeviceReceiptCapture) -> Result<NativeAccountProofKeyOwner> {
    let profile = &capture.context.profile;
    NativeAccountProofKeyOwner::new(
        &profile.app_identifier,
        profile.channel,
        &profile.client_instance_id,
        &capture.candidate.station_id,
        &capture.candidate.device_id,
    )
    .map_err(|_| REFUSED.to_owned())
}

trait AccountKeys {
    fn create(
        &self,
        owner: &NativeAccountProofKeyOwner,
    ) -> std::result::Result<NativeAccountProofKeyPublicMetadata, AccountProofKeyError>;
    fn restore(
        &self,
        owner: &NativeAccountProofKeyOwner,
    ) -> std::result::Result<NativeAccountProofKeyPublicMetadata, AccountProofKeyError>;
    fn sign(
        &self,
        owner: &NativeAccountProofKeyOwner,
        bytes: &[u8],
    ) -> std::result::Result<Vec<u8>, AccountProofKeyError>;
}
impl AccountKeys for NativeAccountProofKeyVault {
    fn create(
        &self,
        owner: &NativeAccountProofKeyOwner,
    ) -> std::result::Result<NativeAccountProofKeyPublicMetadata, AccountProofKeyError> {
        self.create(owner)
    }
    fn restore(
        &self,
        owner: &NativeAccountProofKeyOwner,
    ) -> std::result::Result<NativeAccountProofKeyPublicMetadata, AccountProofKeyError> {
        self.restore(owner)
    }
    fn sign(
        &self,
        owner: &NativeAccountProofKeyOwner,
        bytes: &[u8],
    ) -> std::result::Result<Vec<u8>, AccountProofKeyError> {
        self.sign_es256_p1363(owner, bytes)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeAccountTarget {
    kind: &'static str,
    station_id: String,
    audience: String,
    surface: NativeDeviceBindingSurfaceV1,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeAccountChallengeBody {
    version: &'static str,
    public_key: P256PublicJwk,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeAccountPrepared {
    version: &'static str,
    account_context_handle: String,
    context_expires_at_ms: u64,
    public_key: P256PublicJwk,
    target: NativeAccountTarget,
    device_id: String,
    body: NativeAccountChallengeBody,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeAccountChallenge {
    challenge_id: String,
    nonce: String,
    expires_at_ms: u64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeLocalCredentials {
    username: String,
    password: String,
}
impl NativeLocalCredentials {
    fn validate(&self) -> Result<()> {
        if !(3..=32).contains(&self.username.len())
            || !self
                .username
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
            || !(1..=128).contains(&self.password.encode_utf16().count())
        {
            return refused();
        }
        Ok(())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeAccountExchangeBody {
    version: &'static str,
    challenge_id: String,
    credentials: NativeLocalCredentials,
    proof: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeAccountExchangePrepared {
    body: NativeAccountExchangeBody,
    headers: HashMap<&'static str, String>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeAccountContinuation {
    credential: String,
    nonce: String,
    expires_at_ms: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeAccountReadTarget {
    method: String,
    path: String,
}

struct ContinuationFence {
    credential_hash: String,
    nonce: String,
    expires_at_ms: u64,
}
struct AccountContext {
    capture: NativeDeviceReceiptCapture,
    public_key: NativeAccountProofKeyPublicMetadata,
    expires_at_ms: u64,
    operation_expires_at_ms: u64,
    exchange_issued: bool,
    continuation: Option<ContinuationFence>,
}
#[derive(Default)]
struct AccountState {
    contexts: HashMap<String, AccountContext>,
    consumed_challenges: HashMap<String, u64>,
}
#[derive(Default)]
pub(crate) struct NativeAccountOperations {
    state: Mutex<AccountState>,
}
impl NativeAccountOperations {
    fn selection(&self, handle: &str) -> Result<(String, u64)> {
        if !opaque(handle) {
            return refused();
        }
        let state = self.state.lock().map_err(|_| REFUSED.to_owned())?;
        let context = state
            .contexts
            .get(handle)
            .ok_or_else(|| REFUSED.to_owned())?;
        Ok((
            context.capture.context.profile.profile_name.clone(),
            context.capture.context.profile.revision,
        ))
    }
    fn prepare(
        &self,
        capture: NativeDeviceReceiptCapture,
        now: u64,
        keys: &impl AccountKeys,
    ) -> Result<NativeAccountPrepared> {
        if now == 0 || now > MAX_SAFE_INTEGER || capture.grant_expires_at <= now {
            return refused();
        }
        let mut state = self.state.lock().map_err(|_| REFUSED.to_owned())?;
        state
            .contexts
            .retain(|_, context| context.expires_at_ms > now);
        state.consumed_challenges.retain(|_, expiry| *expiry > now);
        if state.contexts.len() >= MAX_CONTEXTS {
            return refused();
        }
        let owner = key_owner(&capture)?;
        let public = keys
            .restore(&owner)
            .or_else(|error| match error {
                AccountProofKeyError::Missing => keys.create(&owner).or_else(|error| match error {
                    AccountProofKeyError::AlreadyExists => keys.restore(&owner),
                    other => Err(other),
                }),
                other => Err(other),
            })
            .map_err(|_| REFUSED.to_owned())?;
        let handle = random_id::<32>()?;
        let target = NativeAccountTarget {
            kind: "station-native",
            station_id: capture.candidate.station_id.clone(),
            audience: capture.station_origin.clone(),
            surface: capture.candidate.surface.clone(),
        };
        let expires_at_ms = now
            .saturating_add(CONTEXT_LIFETIME_MS)
            .min(capture.grant_expires_at);
        let result = NativeAccountPrepared {
            version: OPERATION_VERSION,
            account_context_handle: handle.clone(),
            context_expires_at_ms: expires_at_ms,
            public_key: public.jwk().clone(),
            target,
            device_id: capture.candidate.device_id.clone(),
            body: NativeAccountChallengeBody {
                version: VERSION,
                public_key: public.jwk().clone(),
            },
        };
        state.contexts.insert(
            handle,
            AccountContext {
                capture,
                public_key: public,
                expires_at_ms,
                operation_expires_at_ms: expires_at_ms,
                exchange_issued: false,
                continuation: None,
            },
        );
        Ok(result)
    }
    fn exchange(
        &self,
        capture: NativeDeviceReceiptCapture,
        handle: &str,
        challenge: NativeAccountChallenge,
        credentials: NativeLocalCredentials,
        now: u64,
        keys: &impl AccountKeys,
    ) -> Result<NativeAccountExchangePrepared> {
        credentials.validate()?;
        if !opaque(&challenge.challenge_id)
            || !opaque(&challenge.nonce)
            || challenge.expires_at_ms <= now
            || challenge.expires_at_ms > MAX_SAFE_INTEGER
            || now == 0
            || now > MAX_SAFE_INTEGER
        {
            return refused();
        }
        let mut state = self.state.lock().map_err(|_| REFUSED.to_owned())?;
        state.consumed_challenges.retain(|_, expiry| *expiry > now);
        let challenge_hash = sha256(challenge.challenge_id.as_bytes());
        if state.consumed_challenges.contains_key(&challenge_hash)
            || state.consumed_challenges.len() >= 4096
        {
            return refused();
        }
        let context = state
            .contexts
            .get_mut(handle)
            .ok_or_else(|| REFUSED.to_owned())?;
        validate_context(context, &capture, now, keys)?;
        if context.exchange_issued {
            return refused();
        }
        let expiry = challenge
            .expires_at_ms
            .min(now.saturating_add(CHALLENGE_LIFETIME_MS))
            .min(context.expires_at_ms);
        if expiry <= now {
            return refused();
        }
        // Consume before key I/O: an uncertain signing result cannot be replayed.
        context.exchange_issued = true;
        context.operation_expires_at_ms = expiry;
        state
            .consumed_challenges
            .insert(challenge_hash, now.saturating_add(CHALLENGE_LIFETIME_MS));
        let serialized = serde_json::to_vec(&credentials).map_err(|_| REFUSED.to_owned())?;
        let proof = sign_proof(
            keys,
            &capture,
            "exchange",
            &challenge.nonce,
            "POST",
            EXCHANGE_PATH,
            None,
            Some(sha256(challenge.challenge_id.as_bytes())),
            Some(sha256(&serialized)),
            now,
        )?;
        let body = NativeAccountExchangeBody {
            version: VERSION,
            challenge_id: challenge.challenge_id,
            credentials,
            proof: proof.clone(),
        };
        if serde_json::to_vec(&body)
            .map_err(|_| REFUSED.to_owned())?
            .len()
            > 16384
        {
            return refused();
        }
        Ok(NativeAccountExchangePrepared {
            body,
            headers: HashMap::from([(PROOF_HEADER, proof)]),
        })
    }
    fn headers(
        &self,
        capture: NativeDeviceReceiptCapture,
        handle: &str,
        continuation: NativeAccountContinuation,
        request: NativeAccountReadTarget,
        now: u64,
        keys: &impl AccountKeys,
    ) -> Result<HashMap<&'static str, String>> {
        validate_read_target(&request)?;
        self.request_headers(capture, handle, continuation, request, now, keys)
    }
    fn management_headers(
        &self,
        capture: NativeDeviceReceiptCapture,
        handle: &str,
        continuation: NativeAccountContinuation,
        request: NativeAccountReadTarget,
        now: u64,
        keys: &impl AccountKeys,
    ) -> Result<HashMap<&'static str, String>> {
        if !crate::native_application_peer::native_management_path(&request.method, &request.path) {
            return refused();
        }
        self.request_headers(capture, handle, continuation, request, now, keys)
    }
    fn accept_invitation(
        &self,
        capture: NativeDeviceReceiptCapture,
        handle: &str,
        continuation: NativeAccountContinuation,
        token: String,
        now: u64,
        keys: &impl AccountKeys,
    ) -> Result<NativeAccountInvitationPrepared> {
        if !opaque(&token) {
            return refused();
        }
        let headers = self.request_headers(
            capture,
            handle,
            continuation,
            NativeAccountReadTarget {
                method: "POST".into(),
                path: ACCEPT_INVITATION_PATH.into(),
            },
            now,
            keys,
        )?;
        Ok(NativeAccountInvitationPrepared {
            body: NativeAccountInvitationBody { token },
            headers,
        })
    }
    fn revoke(
        &self,
        capture: NativeDeviceReceiptCapture,
        handle: &str,
        continuation: NativeAccountContinuation,
        now: u64,
        keys: &impl AccountKeys,
    ) -> Result<NativeAccountRevocationPrepared> {
        let headers = self.request_headers(
            capture,
            handle,
            continuation,
            NativeAccountReadTarget {
                method: "POST".into(),
                path: REVOKE_PATH.into(),
            },
            now,
            keys,
        )?;
        Ok(NativeAccountRevocationPrepared {
            body: std::collections::BTreeMap::new(),
            headers,
        })
    }
    fn request_headers(
        &self,
        capture: NativeDeviceReceiptCapture,
        handle: &str,
        continuation: NativeAccountContinuation,
        request: NativeAccountReadTarget,
        now: u64,
        keys: &impl AccountKeys,
    ) -> Result<HashMap<&'static str, String>> {
        if !opaque(&continuation.credential)
            || !opaque(&continuation.nonce)
            || continuation.expires_at_ms <= now
            || continuation.expires_at_ms > MAX_SAFE_INTEGER
            || now == 0
            || now > MAX_SAFE_INTEGER
        {
            return refused();
        }
        let mut state = self.state.lock().map_err(|_| REFUSED.to_owned())?;
        let context = state
            .contexts
            .get_mut(handle)
            .ok_or_else(|| REFUSED.to_owned())?;
        validate_context(context, &capture, now, keys)?;
        if !context.exchange_issued {
            return refused();
        }
        let credential_hash = sha256(continuation.credential.as_bytes());
        let expiry = continuation.expires_at_ms.min(context.expires_at_ms);
        if let Some(fence) = &context.continuation {
            if fence.credential_hash != credential_hash
                || fence.nonce != continuation.nonce
                || now >= fence.expires_at_ms
            {
                return refused();
            }
        } else {
            context.continuation = Some(ContinuationFence {
                credential_hash: credential_hash.clone(),
                nonce: continuation.nonce.clone(),
                expires_at_ms: expiry,
            });
        }
        context.operation_expires_at_ms = expiry.min(
            context
                .continuation
                .as_ref()
                .ok_or_else(|| REFUSED.to_owned())?
                .expires_at_ms,
        );
        let proof = sign_proof(
            keys,
            &capture,
            "request",
            &continuation.nonce,
            &request.method,
            &request.path,
            Some(credential_hash),
            None,
            None,
            now,
        )?;
        Ok(HashMap::from([
            (CONTINUATION_HEADER, continuation.credential),
            (PROOF_HEADER, proof),
        ]))
    }
    fn finish(
        &self,
        handle: &str,
        capture: &NativeDeviceReceiptCapture,
        started: u64,
        clock: impl FnOnce() -> Result<u64>,
        keys: &impl AccountKeys,
    ) -> Result<()> {
        let state = self.state.lock().map_err(|_| REFUSED.to_owned())?;
        let context = state
            .contexts
            .get(handle)
            .ok_or_else(|| REFUSED.to_owned())?;
        let public = keys
            .restore(&key_owner(capture)?)
            .map_err(|_| REFUSED.to_owned())?;
        let finished = clock()?;
        if context.capture != *capture
            || context.public_key != public
            || finished < started
            || finished.saturating_sub(started) > 60_000
            || finished >= context.expires_at_ms
            || finished >= context.operation_expires_at_ms
            || finished >= capture.grant_expires_at
        {
            return refused();
        }
        Ok(())
    }
}
fn validate_context(
    context: &AccountContext,
    current: &NativeDeviceReceiptCapture,
    now: u64,
    keys: &impl AccountKeys,
) -> Result<()> {
    if context.capture != *current
        || now >= context.expires_at_ms
        || current.grant_expires_at <= now
    {
        return refused();
    }
    let public = keys
        .restore(&key_owner(current)?)
        .map_err(|_| REFUSED.to_owned())?;
    if public != context.public_key {
        return refused();
    }
    Ok(())
}
fn validate_read_target(request: &NativeAccountReadTarget) -> Result<()> {
    if !matches!(request.method.as_str(), "GET" | "HEAD")
        || request.path.len() > 2048
        || !request.path.starts_with('/')
        || request.path.starts_with("//")
        || request
            .path
            .bytes()
            .any(|byte| byte < 32 || byte == 127 || matches!(byte, b'\\' | b'#'))
    {
        return refused();
    }
    let url = url::Url::parse(&format!("https://request.invalid{}", request.path))
        .map_err(|_| REFUSED.to_owned())?;
    let canonical = format!(
        "{}{}",
        url.path(),
        url.query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default()
    );

    if canonical != request.path
        || url.origin().ascii_serialization() != "https://request.invalid"
        || !crate::native_application_peer::native_member_read_path(url.path())
    {
        return refused();
    }
    Ok(())
}
#[derive(Serialize)]
struct ProofHeader {
    alg: &'static str,
    typ: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountClaims<'a> {
    version: &'static str,
    purpose: &'static str,
    aud: &'a str,
    station_id: &'a str,
    surface: &'a NativeDeviceBindingSurfaceV1,
    device_id: &'a str,
    nonce: &'a str,
    method: &'a str,
    path: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    challenge_id_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    credentials_hash: Option<String>,
    jti: String,
    iat: u64,
}
#[allow(clippy::too_many_arguments)]
fn sign_proof(
    keys: &impl AccountKeys,
    capture: &NativeDeviceReceiptCapture,
    purpose: &'static str,
    nonce: &str,
    method: &str,
    path: &str,
    credential_hash: Option<String>,
    challenge_id_hash: Option<String>,
    credentials_hash: Option<String>,
    now: u64,
) -> Result<String> {
    let header = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&ProofHeader {
            alg: "ES256",
            typ: PROOF_TYPE,
        })
        .map_err(|_| REFUSED.to_owned())?,
    );
    let claims = AccountClaims {
        version: VERSION,
        purpose,
        aud: &capture.station_origin,
        station_id: &capture.candidate.station_id,
        surface: &capture.candidate.surface,
        device_id: &capture.candidate.device_id,
        nonce,
        method,
        path,
        credential_hash,
        challenge_id_hash,
        credentials_hash,
        jti: random_id::<16>()?,
        iat: now / 1000,
    };
    let payload =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(|_| REFUSED.to_owned())?);
    let input = format!("{header}.{payload}");
    if input.len() + 87 > 4096 {
        return refused();
    }
    let signature = keys
        .sign(&key_owner(capture)?, input.as_bytes())
        .map_err(|_| REFUSED.to_owned())?;
    if signature.len() != 64 {
        return refused();
    }
    Ok(format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature)))
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_account_challenge_prepare(
    window: WebviewWindow,
    app: AppHandle,
    profile_name: String,
    expected_profile_revision: u64,
) -> Result<NativeAccountPrepared> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    if profile_name.trim().is_empty()
        || profile_name.len() > 256
        || expected_profile_revision == 0
        || expected_profile_revision > MAX_SAFE_INTEGER
    {
        return refused();
    }
    tauri::async_runtime::spawn_blocking(move || {
        with_current_reconciled_native_device_owner(
            &app,
            &profile_name,
            expected_profile_revision,
            |capture| {
                let state = app
                    .try_state::<NativeAccountOperations>()
                    .ok_or_else(|| REFUSED.to_owned())?;
                let started = now_ms()?;
                let result =
                    state.prepare(capture.clone(), started, &NativeAccountProofKeyVault::new())?;
                state.finish(
                    &result.account_context_handle,
                    &capture,
                    started,
                    now_ms,
                    &NativeAccountProofKeyVault::new(),
                )?;
                Ok(result)
            },
        )
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_account_exchange_prepare(
    window: WebviewWindow,
    app: AppHandle,
    account_context_handle: String,
    challenge: NativeAccountChallenge,
    credentials: NativeLocalCredentials,
) -> Result<NativeAccountExchangePrepared> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<NativeAccountOperations>()
            .ok_or_else(|| REFUSED.to_owned())?;
        let (name, revision) = state.selection(&account_context_handle)?;
        with_current_reconciled_native_device_owner(&app, &name, revision, |capture| {
            let started = now_ms()?;
            let result = state.exchange(
                capture.clone(),
                &account_context_handle,
                challenge,
                credentials,
                started,
                &NativeAccountProofKeyVault::new(),
            )?;
            state.finish(
                &account_context_handle,
                &capture,
                started,
                now_ms,
                &NativeAccountProofKeyVault::new(),
            )?;
            Ok(result)
        })
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}
#[derive(Serialize)]
pub(crate) struct NativeAccountInvitationPrepared {
    body: NativeAccountInvitationBody,
    headers: HashMap<&'static str, String>,
}
#[derive(Serialize)]
struct NativeAccountInvitationBody {
    token: String,
}
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_account_accept_invitation_prepare(
    window: WebviewWindow,
    app: AppHandle,
    account_context_handle: String,
    continuation: NativeAccountContinuation,
    token: String,
) -> Result<NativeAccountInvitationPrepared> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    if !opaque(&token) {
        return refused();
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<NativeAccountOperations>()
            .ok_or_else(|| REFUSED.to_owned())?;
        let (name, revision) = state.selection(&account_context_handle)?;
        with_current_reconciled_native_device_owner(&app, &name, revision, |capture| {
            let started = now_ms()?;
            let result = state.accept_invitation(
                capture.clone(),
                &account_context_handle,
                continuation,
                token,
                started,
                &NativeAccountProofKeyVault::new(),
            )?;
            state.finish(
                &account_context_handle,
                &capture,
                started,
                now_ms,
                &NativeAccountProofKeyVault::new(),
            )?;
            Ok(result)
        })
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}

#[derive(Serialize)]
pub(crate) struct NativeAccountRevocationPrepared {
    body: std::collections::BTreeMap<String, String>,
    headers: HashMap<&'static str, String>,
}
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_account_revoke_prepare(
    window: WebviewWindow,
    app: AppHandle,
    account_context_handle: String,
    continuation: NativeAccountContinuation,
) -> Result<NativeAccountRevocationPrepared> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<NativeAccountOperations>()
            .ok_or_else(|| REFUSED.to_owned())?;
        let (name, revision) = state.selection(&account_context_handle)?;
        with_current_reconciled_native_device_owner(&app, &name, revision, |capture| {
            let started = now_ms()?;
            let result = state.revoke(
                capture.clone(),
                &account_context_handle,
                continuation,
                started,
                &NativeAccountProofKeyVault::new(),
            )?;
            state.finish(
                &account_context_handle,
                &capture,
                started,
                now_ms,
                &NativeAccountProofKeyVault::new(),
            )?;
            Ok(result)
        })
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_account_request_headers(
    window: WebviewWindow,
    app: AppHandle,
    account_context_handle: String,
    continuation: NativeAccountContinuation,
    request: NativeAccountReadTarget,
) -> Result<HashMap<&'static str, String>> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<NativeAccountOperations>()
            .ok_or_else(|| REFUSED.to_owned())?;
        let (name, revision) = state.selection(&account_context_handle)?;
        with_current_reconciled_native_device_owner(&app, &name, revision, |capture| {
            let started = now_ms()?;
            let result = state.headers(
                capture.clone(),
                &account_context_handle,
                continuation,
                request,
                started,
                &NativeAccountProofKeyVault::new(),
            )?;
            state.finish(
                &account_context_handle,
                &capture,
                started,
                now_ms,
                &NativeAccountProofKeyVault::new(),
            )?;
            Ok(result)
        })
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_account_management_headers(
    window: WebviewWindow,
    app: AppHandle,
    account_context_handle: String,
    continuation: NativeAccountContinuation,
    request: NativeAccountReadTarget,
) -> Result<HashMap<&'static str, String>> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<NativeAccountOperations>()
            .ok_or_else(|| REFUSED.to_owned())?;
        let (name, revision) = state.selection(&account_context_handle)?;
        with_current_reconciled_native_device_owner(&app, &name, revision, |capture| {
            let started = now_ms()?;
            let result = state.management_headers(
                capture.clone(),
                &account_context_handle,
                continuation,
                request,
                started,
                &NativeAccountProofKeyVault::new(),
            )?;
            state.finish(
                &account_context_handle,
                &capture,
                started,
                now_ms,
                &NativeAccountProofKeyVault::new(),
            )?;
            Ok(result)
        })
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_account_proof_key::MemoryNativeAccountProofKeyVault;
    use crate::native_device_binding_candidate::{
        NativeDeviceBindingCandidateAuthority, NativeDeviceBindingCandidateManager,
        NativeDeviceBindingRouteV1,
    };
    use crate::native_device_proof_key::MemoryNativeDeviceProofKeyVault;
    use crate::native_proof_key_core::MemorySecretBackend;
    use crate::native_relay_proof_key::NativeProofKeyChannel;
    use crate::native_relay_redemption::{
        ApprovedNativeStationTrust, NativeRedemptionContext, NativeRelayProfileSnapshot,
        NativeStationTrustStatus,
    };

    impl AccountKeys for MemoryNativeAccountProofKeyVault {
        fn create(
            &self,
            owner: &NativeAccountProofKeyOwner,
        ) -> std::result::Result<NativeAccountProofKeyPublicMetadata, AccountProofKeyError>
        {
            self.create(owner)
        }
        fn restore(
            &self,
            owner: &NativeAccountProofKeyOwner,
        ) -> std::result::Result<NativeAccountProofKeyPublicMetadata, AccountProofKeyError>
        {
            self.restore(owner)
        }
        fn sign(
            &self,
            owner: &NativeAccountProofKeyOwner,
            bytes: &[u8],
        ) -> std::result::Result<Vec<u8>, AccountProofKeyError> {
            self.sign_es256_p1363(owner, bytes)
        }
    }
    fn capture(now: u64) -> NativeDeviceReceiptCapture {
        let app = "io.kontourai.station";
        let client = "33333333-3333-4333-8333-333333333333";
        let station = "11111111-1111-4111-8111-111111111111";
        let device = "44444444-4444-4444-8444-444444444444";
        let enrollment = "55555555-5555-4555-8555-555555555555";
        let authority = NativeDeviceBindingCandidateAuthority::from_current_owners(
            "Fixture".into(),
            1,
            2,
            "66666666-6666-4666-8666-666666666666".into(),
            app.into(),
            NativeProofKeyChannel::Stable,
            client.into(),
            station.into(),
            device.into(),
            NativeDeviceBindingSurfaceV1::from_current_route(
                "station-native".into(),
                app.into(),
                "stable".into(),
                client.into(),
                URL_SAFE_NO_PAD.encode([7_u8; 32]),
            ),
            NativeDeviceBindingRouteV1::from_current_route(
                "https://broker.test".into(),
                station.into(),
                enrollment.into(),
                1,
                "grant-fixture".into(),
            ),
        );
        let candidate = NativeDeviceBindingCandidateManager::new(MemorySecretBackend::default())
            .candidate(&authority, &MemoryNativeDeviceProofKeyVault::new())
            .unwrap();
        NativeDeviceReceiptCapture {
            authority,
            station_origin: "https://station.test".into(),
            grant_digest: sha256(b"grant-fixture"),
            grant_expires_at: now + 180_000,
            context: NativeRedemptionContext {
                profile: NativeRelayProfileSnapshot {
                    revision: 1,
                    profile_name: "Fixture".into(),
                    station_endpoint: "https://station.test".into(),
                    broker_origin: "https://broker.test".into(),
                    station_id: station.into(),
                    enrollment_id: enrollment.into(),
                    app_identifier: app.into(),
                    channel: NativeProofKeyChannel::Stable,
                    client_instance_id: client.into(),
                },
                station_trust: ApprovedNativeStationTrust {
                    revision: 2,
                    status: NativeStationTrustStatus::Approved,
                    station_endpoint: "https://station.test".into(),
                    station_id: station.into(),
                    enrollment_id: enrollment.into(),
                    generation: 1,
                    signing_key: candidate.device_proof_jwk.clone(),
                },
            },
            candidate,
        }
    }
    fn challenge(now: u64) -> NativeAccountChallenge {
        NativeAccountChallenge {
            challenge_id: URL_SAFE_NO_PAD.encode([1_u8; 32]),
            nonce: URL_SAFE_NO_PAD.encode([2_u8; 32]),
            expires_at_ms: now + 90_000,
        }
    }
    fn credentials() -> NativeLocalCredentials {
        // Incoming order is intentionally opposite the emitted typed struct.
        serde_json::from_str(r#"{"password":"🔒 café\u2028λ","username":"operator"}"#).unwrap()
    }
    #[test]
    fn delayed_exchange_never_extends_the_public_host_preparation_deadline() {
        let now = 1_800_000_000_000;
        let mut capture = capture(now);
        capture.grant_expires_at = now + 2 * CONTEXT_LIFETIME_MS;
        let state = NativeAccountOperations::default();
        let keys = MemoryNativeAccountProofKeyVault::new();
        let prepared = state.prepare(capture.clone(), now, &keys).unwrap();
        assert_eq!(prepared.context_expires_at_ms, now + CONTEXT_LIFETIME_MS);
        let delayed = now + 60_000;
        state
            .exchange(
                capture.clone(),
                &prepared.account_context_handle,
                challenge(delayed),
                credentials(),
                delayed,
                &keys,
            )
            .unwrap();
        let continuation = || NativeAccountContinuation {
            credential: URL_SAFE_NO_PAD.encode([3u8; 32]),
            nonce: URL_SAFE_NO_PAD.encode([4u8; 32]),
            expires_at_ms: delayed + CONTEXT_LIFETIME_MS,
        };
        let request = || NativeAccountReadTarget {
            method: "GET".into(),
            path: "/api/projects".into(),
        };
        assert!(state
            .headers(
                capture.clone(),
                &prepared.account_context_handle,
                continuation(),
                request(),
                prepared.context_expires_at_ms - 1,
                &keys
            )
            .is_ok());
        assert!(state
            .headers(
                capture,
                &prepared.account_context_handle,
                continuation(),
                request(),
                prepared.context_expires_at_ms,
                &keys
            )
            .is_err());
    }

    #[test]
    fn fixed_invitation_preparation_signs_only_token_leaf_and_keeps_read_operation_closed() {
        let now = 1_800_000_000_000;
        let capture = capture(now);
        let state = NativeAccountOperations::default();
        let keys = MemoryNativeAccountProofKeyVault::new();
        let prepared = state.prepare(capture.clone(), now, &keys).unwrap();
        state
            .exchange(
                capture.clone(),
                &prepared.account_context_handle,
                challenge(now),
                credentials(),
                now + 1,
                &keys,
            )
            .unwrap();
        let continuation = || NativeAccountContinuation {
            credential: URL_SAFE_NO_PAD.encode([3u8; 32]),
            nonce: URL_SAFE_NO_PAD.encode([4u8; 32]),
            expires_at_ms: now + 100000,
        };
        let token = URL_SAFE_NO_PAD.encode([8u8; 32]);
        let acceptance = state
            .accept_invitation(
                capture.clone(),
                &prepared.account_context_handle,
                continuation(),
                token.clone(),
                now + 2,
                &keys,
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(&acceptance.body).unwrap(),
            serde_json::json!({"token":token})
        );
        let proof = acceptance.headers.get(PROOF_HEADER).unwrap();
        let payload: serde_json::Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(proof.split('.').nth(1).unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(payload["purpose"], "request");
        assert_eq!(payload["method"], "POST");
        assert_eq!(payload["path"], ACCEPT_INVITATION_PATH);
        assert!(state
            .accept_invitation(
                capture.clone(),
                &prepared.account_context_handle,
                continuation(),
                "bad".into(),
                now + 3,
                &keys
            )
            .is_err());
        assert!(state
            .headers(
                capture.clone(),
                &prepared.account_context_handle,
                continuation(),
                NativeAccountReadTarget {
                    method: "POST".into(),
                    path: ACCEPT_INVITATION_PATH.into()
                },
                now + 4,
                &keys
            )
            .is_err());
        let managed = state
            .management_headers(
                capture.clone(),
                &prepared.account_context_handle,
                continuation(),
                NativeAccountReadTarget {
                    method: "POST".into(),
                    path: "/api/relay-management/invitations".into(),
                },
                now + 5,
                &keys,
            )
            .unwrap();
        let managed_claims: serde_json::Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(
                    managed
                        .get(PROOF_HEADER)
                        .unwrap()
                        .split('.')
                        .nth(1)
                        .unwrap(),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(managed_claims["method"], "POST");
        assert_eq!(managed_claims["path"], "/api/relay-management/invitations");
        assert_eq!(
            managed_claims["credentialHash"],
            sha256(continuation().credential.as_bytes())
        );
        for path in [
            "/api/pairing/devices",
            "/api/relay-management/unlisted",
            "/api/projects/shared/access/enable",
            "/api/relay-management/invitations?redirect=outside",
        ] {
            assert!(state
                .management_headers(
                    capture.clone(),
                    &prepared.account_context_handle,
                    continuation(),
                    NativeAccountReadTarget {
                        method: "POST".into(),
                        path: path.into()
                    },
                    now + 5,
                    &keys
                )
                .is_err());
        }
        assert!(state
            .headers(
                capture.clone(),
                &prepared.account_context_handle,
                continuation(),
                NativeAccountReadTarget {
                    method: "POST".into(),
                    path: "/api/relay-management/invitations".into()
                },
                now + 5,
                &keys
            )
            .is_err());
        let revoke = state
            .revoke(
                capture.clone(),
                &prepared.account_context_handle,
                continuation(),
                now + 5,
                &keys,
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(revoke.body).unwrap(),
            serde_json::json!({})
        );
        let proof = revoke.headers.get(PROOF_HEADER).unwrap();
        let claims: serde_json::Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(proof.split('.').nth(1).unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(claims["method"], "POST");
        assert_eq!(claims["path"], REVOKE_PATH);
        assert!(state
            .headers(
                capture.clone(),
                &prepared.account_context_handle,
                continuation(),
                NativeAccountReadTarget {
                    method: "POST".into(),
                    path: REVOKE_PATH.into()
                },
                now + 6,
                &keys
            )
            .is_err());
        let mut changed = capture;
        changed.grant_digest = sha256(b"changed");
        assert!(state
            .accept_invitation(
                changed,
                &prepared.account_context_handle,
                continuation(),
                token,
                now + 5,
                &keys
            )
            .is_err());
    }

    #[test]
    fn owner_change_expiry_replay_and_bad_targets_refuse_without_key_replacement() {
        let now = 1_800_000_000_000;
        let capture = capture(now);
        let state = NativeAccountOperations::default();
        let keys = MemoryNativeAccountProofKeyVault::new();
        let prepared = state.prepare(capture.clone(), now, &keys).unwrap();
        let handle = &prepared.account_context_handle;
        let mut changed = capture.clone();
        changed.grant_digest = sha256(b"changed");
        assert!(state
            .exchange(changed, handle, challenge(now), credentials(), now, &keys)
            .is_err());
        assert!(state
            .exchange(
                capture.clone(),
                handle,
                challenge(now),
                credentials(),
                now + 91_000,
                &keys
            )
            .is_err());
        state
            .exchange(
                capture.clone(),
                handle,
                challenge(now),
                credentials(),
                now + 1,
                &keys,
            )
            .unwrap();
        assert!(state
            .exchange(
                capture.clone(),
                handle,
                challenge(now),
                credentials(),
                now + 2,
                &keys
            )
            .is_err());
        for (method, path) in [
            ("POST", "/api/projects"),
            ("GET", "/api/pairing/devices"),
            ("GET", "/api/projects/a/access"),
            ("GET", "//other.test/api/projects"),
            ("GET", "/api/projects/a/../b"),
            ("GET", "/api/projects/%2Fadmin"),
        ] {
            assert!(
                state
                    .headers(
                        capture.clone(),
                        handle,
                        NativeAccountContinuation {
                            credential: URL_SAFE_NO_PAD.encode([3_u8; 32]),
                            nonce: URL_SAFE_NO_PAD.encode([4_u8; 32]),
                            expires_at_ms: now + 100_000
                        },
                        NativeAccountReadTarget {
                            method: method.into(),
                            path: path.into()
                        },
                        now + 2,
                        &keys
                    )
                    .is_err(),
                "{method} {path}"
            );
        }
        assert!(state
            .finish(handle, &capture, now, || Ok(now + 61_000), &keys)
            .is_err());
        assert_eq!(
            keys.restore(&key_owner(&capture).unwrap()).unwrap().jwk(),
            &prepared.public_key
        );
        assert!(serde_json::from_str::<NativeAccountChallenge>(
            r#"{"challengeId":"x","nonce":"x","expiresAtMs":1,"stationId":"caller"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<NativeLocalCredentials>(
            r#"{"username":"operator","password":"x","role":"owner"}"#
        )
        .is_err());
    }

    #[test]
    fn effective_challenge_expiry_stops_a_post_sign_result() {
        let now = 1_800_000_000_000;
        let capture = capture(now);
        let state = NativeAccountOperations::default();
        let keys = MemoryNativeAccountProofKeyVault::new();
        let prepared = state.prepare(capture.clone(), now, &keys).unwrap();
        let mut short = challenge(now);
        short.expires_at_ms = now + 10_000;
        state
            .exchange(
                capture.clone(),
                &prepared.account_context_handle,
                short,
                credentials(),
                now,
                &keys,
            )
            .unwrap();
        assert!(
            state
                .finish(
                    &prepared.account_context_handle,
                    &capture,
                    now,
                    || Ok(now + 11_000),
                    &keys
                )
                .is_err(),
            "an expired challenge must refuse the completed signing result"
        );
    }

    #[test]
    fn a_short_untrusted_hint_cannot_reset_challenge_consumption() {
        let now = 1_800_000_000_000;
        let capture = capture(now);
        let state = NativeAccountOperations::default();
        let keys = MemoryNativeAccountProofKeyVault::new();
        let first = state.prepare(capture.clone(), now, &keys).unwrap();
        let mut short = challenge(now);
        short.expires_at_ms = now + 1;
        state
            .exchange(
                capture.clone(),
                &first.account_context_handle,
                short,
                credentials(),
                now,
                &keys,
            )
            .unwrap();
        let second = state.prepare(capture.clone(), now + 2, &keys).unwrap();
        assert!(
            state
                .exchange(
                    capture,
                    &second.account_context_handle,
                    challenge(now),
                    credentials(),
                    now + 2,
                    &keys
                )
                .is_err(),
            "consumption must outlive a caller-shortened expiry hint across handles"
        );
    }

    #[test]
    fn continuation_expiry_and_account_key_replacement_stop_post_sign_results() {
        let now = 1_800_000_000_000;
        let capture = capture(now);
        let state = NativeAccountOperations::default();
        let keys = MemoryNativeAccountProofKeyVault::new();
        let prepared = state.prepare(capture.clone(), now, &keys).unwrap();
        state
            .exchange(
                capture.clone(),
                &prepared.account_context_handle,
                challenge(now),
                credentials(),
                now,
                &keys,
            )
            .unwrap();
        state
            .headers(
                capture.clone(),
                &prepared.account_context_handle,
                NativeAccountContinuation {
                    credential: URL_SAFE_NO_PAD.encode([3_u8; 32]),
                    nonce: URL_SAFE_NO_PAD.encode([4_u8; 32]),
                    expires_at_ms: now + 10_000,
                },
                NativeAccountReadTarget {
                    method: "GET".into(),
                    path: "/api/projects".into(),
                },
                now,
                &keys,
            )
            .unwrap();
        assert!(state
            .finish(
                &prepared.account_context_handle,
                &capture,
                now,
                || Ok(now + 11_000),
                &keys
            )
            .is_err());
        let before = keys.restore(&key_owner(&capture).unwrap()).unwrap();
        keys.replace(&key_owner(&capture).unwrap()).unwrap();
        assert_ne!(keys.restore(&key_owner(&capture).unwrap()).unwrap(), before);
        assert!(state
            .finish(
                &prepared.account_context_handle,
                &capture,
                now,
                || Ok(now + 1),
                &keys
            )
            .is_err());
    }
    #[test]
    fn rust_prepared_response_survives_sdk_validation_and_node_credentials_hashing() {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let now = now_ms().unwrap();
        let capture = capture(now);
        let state = NativeAccountOperations::default();
        let keys = MemoryNativeAccountProofKeyVault::new();
        let prepared = state.prepare(capture.clone(), now, &keys).unwrap();
        let exchange = state
            .exchange(
                capture.clone(),
                &prepared.account_context_handle,
                challenge(now),
                credentials(),
                now,
                &keys,
            )
            .unwrap();
        let token = URL_SAFE_NO_PAD.encode([3_u8; 32]);
        let nonce = URL_SAFE_NO_PAD.encode([4_u8; 32]);
        let headers = state
            .headers(
                capture,
                &prepared.account_context_handle,
                NativeAccountContinuation {
                    credential: token.clone(),
                    nonce: nonce.clone(),
                    expires_at_ms: now + 90_000,
                },
                NativeAccountReadTarget {
                    method: "GET".into(),
                    path: "/api/projects?include=exact%2Bquery".into(),
                },
                now,
                &keys,
            )
            .unwrap();
        #[derive(Serialize)]
        struct Vector {
            prepared: NativeAccountPrepared,
            exchange: NativeAccountExchangePrepared,
            headers: HashMap<&'static str, String>,
            now: u64,
            challenge_id: String,
            challenge_nonce: String,
            token: String,
            nonce: String,
        }
        // This is the same direct typed serialization used by Tauri IpcResponse.
        let bytes = serde_json::to_vec(&Vector {
            prepared,
            exchange,
            headers,
            now,
            challenge_id: challenge(now).challenge_id,
            challenge_nonce: challenge(now).nonce,
            token,
            nonce,
        })
        .unwrap();
        let script = r#"
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { importJWK, jwtVerify } from 'jose';
import { NativeApplicationSessionClient } from './packages/sdk/src/client/application-session-native.ts';
const v=JSON.parse(readFileSync(0,'utf8'));
const trust={...v.prepared.target,deviceId:v.prepared.deviceId};
const key=await importJWK(v.prepared.publicKey,'ES256');
let sent;
const expiry=new Date(v.now+90000).toISOString();
const continuation={version:'station.application-session-native/v1',credential:v.token,nonce:v.nonce,authorityKey:'fixture-account',target:v.prepared.target,deviceId:v.prepared.deviceId,principal:{kind:'human',id:'human:local:fixture',display:'Fixture'},keyThumbprint:(await import('jose')).calculateJwkThumbprint?await (await import('jose')).calculateJwkThumbprint(v.prepared.publicKey):'',expiresAt:expiry};
const client=new NativeApplicationSessionClient({post:async(input)=>{
 if(input.path.endsWith('/challenge')) return {version:'station.application-session-native/v1',challengeId:v.challenge_id,nonce:v.challenge_nonce,expiresAt:expiry,target:v.prepared.target,deviceId:v.prepared.deviceId,keyThumbprint:continuation.keyThumbprint};
 sent=JSON.stringify(input.body);return continuation;
}},()=>trust,{kind:'station-native-host-proof-provider/v1',publicKey:v.prepared.publicKey,prepareExchange:async()=>v.exchange,requestHeaders:async()=>v.headers});
const accepted=await client.exchange({password:'🔒 café\u2028λ',username:'operator'});
assert.equal(sent,JSON.stringify(v.exchange.body));
const body=JSON.parse(sent);
assert.deepEqual(Object.keys(body.credentials),['username','password']);
const proof=await jwtVerify(body.proof,key,{algorithms:['ES256'],typ:'station.application-session-native+jwt',maxTokenAge:60,currentDate:new Date(v.now),clockTolerance:5});
assert.equal(proof.payload.credentialsHash,createHash('sha256').update(JSON.stringify(body.credentials)).digest('base64url'));
assert.equal(proof.payload.challengeIdHash,createHash('sha256').update(v.challenge_id).digest('base64url'));
const hdr=await client.headers(accepted,{method:'GET',path:'/api/projects?include=exact%2Bquery'});
assert.deepEqual(hdr,v.headers);
const request=await jwtVerify(hdr['X-Station-Native-Account-Proof'],key,{algorithms:['ES256'],typ:'station.application-session-native+jwt',maxTokenAge:60,currentDate:new Date(v.now),clockTolerance:5});
assert.equal(request.payload.credentialHash,createHash('sha256').update(v.token).digest('base64url'));
assert.equal(request.payload.path,'/api/projects?include=exact%2Bquery');
console.log('Rust IPC JSON → SDK typed provider → Node ES256 and credential hashes accepted');
"#;
        let mut command = Command::new("node");
        command
            .current_dir(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap(),
            )
            .args(["--import", "tsx", "--input-type=module", "--eval", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .expect("managed Node/tsx dependencies are required");
        child.stdin.take().unwrap().write_all(&bytes).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("credential hashes accepted"));
    }
}

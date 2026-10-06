//! Native URL delivery carries routing intent, never application authority.
//! Bound invitation secrets remain in host memory behind single-use handles.

use crate::native_relay_key_approval::{
    self, InvitationInput, NativeRelayKeyApprovalState, PendingCandidateDto,
};
use crate::native_relay_proof_key::{NativeProofKeyOwner, NativeRelayProofKeyVault};
use crate::native_relay_redemption::{
    native_relay_grant_vault, observe_superseded_scope, validate_invitation_and_trust,
    AppNativeRedemptionContextProvider, NativeRedemptionContext, NativeRedemptionContextProvider,
    NativeRedemptionError, NativeRelayGrantRedemptionResult, NativeRelayGrantState,
    NativeRelayInvitationV2, NativeRelayRecoveryResult, NativeRelayRedemptionService,
    RedemptionResult, UreqNativeBrokerTransport,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
#[cfg(any(test, target_os = "ios"))]
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(target_os = "ios")]
use tauri::Emitter;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use zeroize::Zeroizing;

const VERSION: &str = "station-native-relay-link/v1";
const MAX_BYTES: usize = 16 * 1024;
const MAX_AGE_MS: u64 = 5 * 60 * 1000;
const SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;
const UNAVAILABLE: &str =
    "Station could not receive this native relay link. Use manual route setup.";
const MISSING: &str = "This relay invitation is no longer available. Reopen a current invitation.";
#[cfg(target_os = "ios")]
pub(crate) const EVENT: &str = "station://native-relay-link";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct LinkRoute {
    pub(crate) application_origin: String,
    pub(crate) broker_origin: String,
    pub(crate) station_id: String,
    pub(crate) enrollment_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InvitationMetadata {
    invitation_id: String,
    expires_at: u64,
    routing_generation: u64,
    station_signing_key_id: String,
    station_signing_generation: u64,
    surface: crate::native_relay_redemption::NativeRelayClientSurfaceV2,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum LinkDelivery {
    RouteIntent {
        pending_id: String,
        route: LinkRoute,
    },
    BoundInvitation {
        pending_id: String,
        route: LinkRoute,
        invitation: InvitationMetadata,
    },
    Rejected {
        code: &'static str,
        message: &'static str,
    },
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    deny_unknown_fields,
    rename_all_fields = "camelCase"
)]
enum Envelope {
    RouteIntent {
        version: String,
        application_origin: String,
        broker_origin: String,
        station_id: String,
        enrollment_id: String,
    },
    BoundInvitation {
        version: String,
        application_origin: String,
        invitation: NativeRelayInvitationV2,
    },
}

struct PendingLink {
    delivery: LinkDelivery,
    route: LinkRoute,
    invitation: Option<Zeroizing<Vec<u8>>>,
    expires_at: u64,
    cancelled: Arc<AtomicBool>,
    commit_gate: Arc<Mutex<()>>,
    profile_name: Option<String>,
    caller_label: Option<String>,
    in_flight: bool,
    fingerprint: [u8; 32],
}

#[derive(Default)]
struct DeliveryState {
    pending: Option<PendingLink>,
    notification: Option<LinkDelivery>,
    pairing: Vec<String>,
    unavailable: bool,
    stopped: bool,
}

#[derive(Default)]
struct LinkStateInner {
    state: Mutex<DeliveryState>,
    changed: Condvar,
}

#[derive(Clone, Default)]
pub(crate) struct NativeRelayLinkState(Arc<LinkStateInner>);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|value| value.as_millis().try_into().ok())
        .unwrap_or(0)
}

pub(crate) fn relay_scheme(app_identifier: &str, channel: &str, dev_build: bool) -> String {
    if dev_build {
        let suffix = app_identifier
            .strip_prefix("io.kontourai.station.dev.")
            .unwrap_or("instance");
        return format!(
            "station-relay-dev-{}",
            crate::pairing_deep_link_channels_generated::normalize_dev_pairing_deep_link_suffix(
                suffix
            )
        );
    }
    format!("station-relay-{channel}")
}

fn canonical_origin(value: &str, allow_debug_loopback: bool) -> bool {
    url::Url::parse(value).is_ok_and(|url| {
        let numeric_loopback = match url.host() {
            Some(url::Host::Ipv4(host)) => host == std::net::Ipv4Addr::LOCALHOST,
            Some(url::Host::Ipv6(host)) => host == std::net::Ipv6Addr::LOCALHOST,
            _ => false,
        };
        url.origin().ascii_serialization() == value
            && url.username().is_empty()
            && url.password().is_none()
            && (url.scheme() == "https"
                || (url.scheme() == "http" && allow_debug_loopback && numeric_loopback))
    })
}

fn valid_id(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| {
        id.to_string() == value
            && (1..=8).contains(&id.get_version_num())
            && id.get_variant() == uuid::Variant::RFC4122
    })
}
fn opaque(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn rejected(code: &'static str) -> LinkDelivery {
    let message = match code {
        "expired" => "This relay invitation has expired. Ask the operator for a fresh invitation.",
        "unsupported" => "This Station app cannot open that relay link. Open it in the intended iOS app channel.",
        "unavailable" => UNAVAILABLE,
        _ => "This relay link is invalid or belongs to another Station installation. Ask the operator for a current link.",
    };
    LinkDelivery::Rejected { code, message }
}

fn decode_link(
    url: &url::Url,
    app_identifier: &str,
    channel: &str,
    dev_build: bool,
    now: u64,
) -> Result<PendingLink, &'static str> {
    if url.scheme() != relay_scheme(app_identifier, channel, dev_build) {
        return Err("unsupported");
    }
    if url.host_str() != Some("relay")
        || !url.path().is_empty()
        || url.query().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err("invalid");
    }
    let encoded = url
        .fragment()
        .and_then(|value| value.strip_prefix("relay-link="))
        .ok_or("invalid")?;
    if encoded.is_empty()
        || encoded.len() > MAX_BYTES.div_ceil(3) * 4
        || !encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid");
    }
    let decoded = Zeroizing::new(URL_SAFE_NO_PAD.decode(encoded).map_err(|_| "invalid")?);
    if decoded.len() > MAX_BYTES {
        return Err("invalid");
    }
    let envelope: Envelope = serde_json::from_slice(&decoded).map_err(|_| "invalid")?;
    let fingerprint = ring::digest::digest(&ring::digest::SHA256, &decoded)
        .as_ref()
        .try_into()
        .map_err(|_| "invalid")?;
    let pending_id = uuid::Uuid::new_v4().to_string();
    let (route, invitation, expires_at, delivery) = match envelope {
        Envelope::RouteIntent {
            version,
            application_origin,
            broker_origin,
            station_id,
            enrollment_id,
        } => {
            if version != VERSION {
                return Err("unsupported");
            }
            let route = LinkRoute {
                application_origin,
                broker_origin,
                station_id,
                enrollment_id,
            };
            let delivery = LinkDelivery::RouteIntent {
                pending_id,
                route: route.clone(),
            };
            (route, None, now.saturating_add(MAX_AGE_MS), delivery)
        }
        Envelope::BoundInvitation {
            version,
            application_origin,
            invitation,
        } => {
            if version != VERSION
                || invitation.version != "station-broker-native-route-invitation/v2"
            {
                return Err("unsupported");
            }
            if invitation.expires_at <= now {
                return Err("expired");
            }
            if invitation.expires_at > SAFE_INTEGER_MAX
                || invitation.surface.kind != "station-native"
                || invitation.surface.app_identifier != app_identifier
                || invitation.surface.channel != channel
                || !valid_id(&invitation.surface.client_instance_id)
                || !opaque(&invitation.surface.key_thumbprint)
                || !opaque(&invitation.station_signing_key_id)
                || !invitation.link_secret_valid()
                || invitation.scope.routing_generation == 0
                || invitation.scope.routing_generation > SAFE_INTEGER_MAX
                || invitation.station_signing_generation == 0
                || invitation.station_signing_generation > SAFE_INTEGER_MAX
            {
                return Err("invalid");
            }
            let route = LinkRoute {
                application_origin,
                broker_origin: invitation.broker_origin.clone(),
                station_id: invitation.scope.station_id.clone(),
                enrollment_id: invitation.scope.enrollment_id.clone(),
            };
            let metadata = InvitationMetadata {
                invitation_id: invitation.invitation_id.clone(),
                expires_at: invitation.expires_at,
                routing_generation: invitation.scope.routing_generation,
                station_signing_key_id: invitation.station_signing_key_id.clone(),
                station_signing_generation: invitation.station_signing_generation,
                surface: invitation.surface.clone(),
            };
            let expires_at = invitation.expires_at;
            let encoded_invitation =
                Zeroizing::new(serde_json::to_vec(&invitation).map_err(|_| "invalid")?);
            let delivery = LinkDelivery::BoundInvitation {
                pending_id,
                route: route.clone(),
                invitation: metadata,
            };
            (route, Some(encoded_invitation), expires_at, delivery)
        }
    };
    let allow_debug_loopback = dev_build && channel == "dev";
    if !canonical_origin(&route.application_origin, allow_debug_loopback)
        || !canonical_origin(&route.broker_origin, allow_debug_loopback)
        || !valid_id(&route.station_id)
        || !valid_id(&route.enrollment_id)
    {
        return Err("invalid");
    }
    Ok(PendingLink {
        delivery,
        route,
        invitation,
        expires_at,
        cancelled: Arc::new(AtomicBool::new(false)),
        commit_gate: Arc::new(Mutex::new(())),
        profile_name: None,
        caller_label: None,
        in_flight: false,
        fingerprint,
    })
}

fn pending_id(delivery: &LinkDelivery) -> Option<&str> {
    match delivery {
        LinkDelivery::RouteIntent { pending_id, .. }
        | LinkDelivery::BoundInvitation { pending_id, .. } => Some(pending_id),
        _ => None,
    }
}

impl NativeRelayLinkState {
    fn take_delivery(&self) -> Result<Option<LinkDelivery>, String> {
        let mut inner = self.0.state.lock().map_err(|_| UNAVAILABLE.to_owned())?;
        if inner
            .pending
            .as_ref()
            .is_some_and(|pending| pending.expires_at <= now_ms())
        {
            if !Self::cancel_pending(&mut inner) {
                return Ok(Some(rejected("unavailable")));
            }
            inner.notification = Some(rejected("expired"));
        }
        // Recover public metadata if an async consumer was disposed after
        // draining launch delivery. A cancelled handle is never recoverable.
        Ok(inner.notification.take().or_else(|| {
            inner
                .pending
                .as_ref()
                .map(|pending| pending.delivery.clone())
        }))
    }
    fn clear_pending_under_commit_gate(state: &mut DeliveryState) {
        if let Some(pending) = state.pending.take() {
            pending.cancelled.store(true, Ordering::Release);
        }
    }

    fn cancel_pending(state: &mut DeliveryState) -> bool {
        let gate = state
            .pending
            .as_ref()
            .map(|pending| pending.commit_gate.clone());
        let _commit = match gate.as_ref() {
            Some(gate) => match gate.try_lock() {
                Ok(guard) => Some(guard),
                Err(_) => return false,
            },
            None => None,
        };
        Self::clear_pending_under_commit_gate(state);
        true
    }

    fn receive(
        &self,
        url: &url::Url,
        app_identifier: &str,
        channel: &str,
        dev_build: bool,
        now: u64,
    ) -> LinkDelivery {
        let parsed = decode_link(url, app_identifier, channel, dev_build, now);
        let Ok(mut state) = self.0.state.lock() else {
            return rejected("unavailable");
        };
        if state.unavailable {
            return rejected("unavailable");
        }
        if let (Ok(incoming), Some(current)) = (&parsed, &state.pending) {
            if incoming.fingerprint == current.fingerprint
                && current.expires_at > now
                && !current.cancelled.load(Ordering::Acquire)
            {
                return current.delivery.clone();
            }
        }
        // Never wait for keyring work on the URL/UI callback. A rejected
        // incoming URL is not published as a new pending owner.
        if !Self::cancel_pending(&mut state) {
            return rejected("unavailable");
        }
        let delivery = match parsed {
            Ok(pending) => {
                let delivery = pending.delivery.clone();
                state.pending = Some(pending);
                delivery
            }
            Err(code) => rejected(code),
        };
        state.notification = Some(delivery.clone());
        self.0.changed.notify_all();
        delivery
    }

    #[cfg(target_os = "ios")]
    pub(crate) fn unavailable(&self) {
        if let Ok(mut state) = self.0.state.lock() {
            if !Self::cancel_pending(&mut state) {
                return;
            }
            state.unavailable = true;
            state.notification = Some(rejected("unavailable"));
        }
    }

    #[cfg(target_os = "ios")]
    pub(crate) fn start_expiry_worker(&self) {
        let inner = self.0.clone();
        std::thread::spawn(move || {
            let Ok(mut state) = inner.state.lock() else {
                return;
            };
            loop {
                if state.stopped {
                    return;
                }
                let wait = match state.pending.as_ref() {
                    Some(pending) => {
                        let now = now_ms();
                        if pending.expires_at <= now {
                            if Self::cancel_pending(&mut state) {
                                state.notification = Some(rejected("expired"));
                                continue;
                            }
                            Duration::from_millis(50)
                        } else {
                            Duration::from_millis(pending.expires_at - now)
                        }
                    }
                    None => Duration::from_secs(60),
                };
                let Ok((next, _)) = inner.changed.wait_timeout(state, wait) else {
                    return;
                };
                state = next;
            }
        });
    }

    pub(crate) fn stop(&self) {
        if let Ok(mut state) = self.0.state.lock() {
            Self::cancel_pending(&mut state);
            state.stopped = true;
            self.0.changed.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn invitation(now: u64) -> serde_json::Value {
        json!({"version":"station-native-relay-link/v1","kind":"bound-invitation","applicationOrigin":"https://station.example",
            "invitation":{"version":"station-broker-native-route-invitation/v2","brokerOrigin":"https://broker.example",
                "scope":{"stationId":"11111111-1111-4111-8111-111111111111","enrollmentId":"22222222-2222-4222-8222-222222222222","routingGeneration":9},
                "stationSigningKeyId":"K".repeat(43),"stationSigningGeneration":4,
                "surface":{"kind":"station-native","appIdentifier":"io.kontourai.station.nightly","channel":"nightly",
                    "clientInstanceId":"33333333-3333-4333-8333-333333333333","keyThumbprint":"T".repeat(43)},
                "invitationId":"invite-12345678","invitationSecret":"S".repeat(43),"expiresAt":now+60_000}})
    }

    fn link(value: &serde_json::Value) -> url::Url {
        url::Url::parse(&format!(
            "station-relay-nightly://relay#relay-link={}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).unwrap())
        ))
        .unwrap()
    }

    #[test]
    fn native_delivery_exposes_only_metadata_and_cancellation_fences_the_opaque_handle() {
        let now = now_ms();
        for expires_at in [now + 60_000, now + 24 * 60 * 60 * 1000, SAFE_INTEGER_MAX] {
            let state = NativeRelayLinkState::default();
            let mut envelope = invitation(now);
            envelope["invitation"]["expiresAt"] = json!(expires_at);
            let url = link(&envelope);
            let delivery =
                state.receive(&url, "io.kontourai.station.nightly", "nightly", false, now);
            let encoded = serde_json::to_string(&delivery).unwrap();
            assert!(!encoded.contains(&"S".repeat(43)));
            assert!(!encoded.contains("invitationSecret"));
            let id = pending_id(&delivery).unwrap();
            assert_eq!(
                pending_id(&state.take_delivery().unwrap().unwrap()),
                Some(id)
            );
            assert_eq!(
                pending_id(&state.take_delivery().unwrap().unwrap()),
                Some(id)
            );
            let repeated =
                state.receive(&url, "io.kontourai.station.nightly", "nightly", false, now);
            assert_eq!(pending_id(&repeated), Some(id));
            let attempt = reserve_attempt(&state, id, "Home", "main", false).unwrap();
            assert!(reserve_attempt(&state, id, "Home", "main", false).is_err());
            let mut inner = state.0.state.lock().unwrap();
            NativeRelayLinkState::cancel_pending(&mut inner);
            inner.notification = None;
            assert!(inner.pending.is_none());
            assert!(attempt.cancelled.load(Ordering::Acquire));
            drop(inner);
            assert!(state.take_delivery().unwrap().is_none());
            assert!(reserve_attempt(&state, id, "Home", "main", true).is_err());
            let reopened =
                state.receive(&url, "io.kontourai.station.nightly", "nightly", false, now);
            assert_ne!(pending_id(&reopened), Some(id));
        }
    }

    #[test]
    fn a_new_link_is_rejected_without_ui_wait_during_commit_and_reopen_supersedes_afterward() {
        let now = now_ms();
        let state = NativeRelayLinkState::default();
        let first = state.receive(
            &link(&invitation(now)),
            "io.kontourai.station.nightly",
            "nightly",
            false,
            now,
        );
        let old_id = pending_id(&first).unwrap().to_owned();
        let attempt = reserve_attempt(&state, &old_id, "Home", "main", true).unwrap();
        let mut next = invitation(now);
        next["invitation"]["invitationId"] = json!("invite-replacement");
        let url = link(&next);
        let gate = attempt.commit_gate.lock().unwrap();
        let (delivered_tx, delivered_rx) = std::sync::mpsc::channel();
        let state_copy = state.clone();
        let callback = std::thread::spawn(move || {
            let delivery =
                state_copy.receive(&url, "io.kontourai.station.nightly", "nightly", false, now);
            delivered_tx.send(delivery).unwrap();
        });
        let delivery = delivered_rx.recv_timeout(Duration::from_secs(2));
        drop(gate);
        callback.join().unwrap();
        let delivery = delivery.expect("URL intake must not wait for keyring commit");
        assert!(matches!(delivery, LinkDelivery::Rejected { .. }));
        assert!(!attempt.cancelled.load(Ordering::Acquire));
        let current = state.take_delivery().unwrap().unwrap();
        assert_eq!(pending_id(&current), Some(old_id.as_str()));
        let mut reopened = invitation(now);
        reopened["invitation"]["invitationId"] = json!("invite-replacement");
        let next = state.receive(
            &link(&reopened),
            "io.kontourai.station.nightly",
            "nightly",
            false,
            now,
        );
        let next_id = pending_id(&next).unwrap();
        assert_ne!(next_id, old_id);
        assert!(attempt.cancelled.load(Ordering::Acquire));
        finish_attempt(&state, &old_id, true, true);
        assert!(reserve_attempt(&state, next_id, "Home", "main", false).is_ok());
    }

    #[test]
    fn request_gate_consumes_only_the_current_attempt_once_and_refuses_replacement() {
        let now = now_ms();
        let state = NativeRelayLinkState::default();
        let first = state.receive(
            &link(&invitation(now)),
            "io.kontourai.station.nightly",
            "nightly",
            false,
            now,
        );
        let id = pending_id(&first).unwrap();
        let attempt = reserve_attempt(&state, id, "Home", "main", false).unwrap();
        consume_attempt_invitation(&state, id, &attempt).unwrap();
        assert_eq!(
            consume_attempt_invitation(&state, id, &attempt),
            Err(NativeRedemptionError::InvitationInvalid)
        );
        let mut replacement = invitation(now);
        replacement["invitation"]["invitationId"] = json!("invite-replacement");
        let next = state.receive(
            &link(&replacement),
            "io.kontourai.station.nightly",
            "nightly",
            false,
            now,
        );
        assert_ne!(pending_id(&next), Some(id));
        assert_eq!(
            consume_attempt_invitation(&state, id, &attempt),
            Err(NativeRedemptionError::StaleProfile)
        );
        let current = state.take_delivery().unwrap().unwrap();
        assert_eq!(pending_id(&current), pending_id(&next));
    }

    #[test]
    fn native_intake_rejects_wrong_surface_expiry_and_unknown_fields_without_echoing_input() {
        let now = now_ms();
        for change in [
            "app", "channel", "expired", "unknown", "secret", "origin", "version",
        ] {
            let mut value = invitation(now);
            match change {
                "app" => {
                    value["invitation"]["surface"]["appIdentifier"] =
                        json!("io.kontourai.station.beta")
                }
                "channel" => value["invitation"]["surface"]["channel"] = json!("beta"),
                "expired" => value["invitation"]["expiresAt"] = json!(now),
                "unknown" => value["trustApproved"] = json!(true),
                "secret" => value["invitation"]["invitationSecret"] = json!("malformed"),
                "origin" => value["applicationOrigin"] = json!("https://station.example/api"),
                "version" => value["version"] = json!("station-native-relay-link/v99"),
                _ => unreachable!(),
            }
            let state = NativeRelayLinkState::default();
            let result = state.receive(
                &link(&value),
                "io.kontourai.station.nightly",
                "nightly",
                false,
                now,
            );
            assert!(matches!(result, LinkDelivery::Rejected { .. }), "{change}");
            assert!(state.0.state.lock().unwrap().pending.is_none());
            assert!(!serde_json::to_string(&result)
                .unwrap()
                .contains(&"S".repeat(43)));
        }
    }

    #[test]
    fn first_contact_is_public_intent_and_cannot_start_invitation_operations() {
        let state = NativeRelayLinkState::default();
        let value = json!({"version":"station-native-relay-link/v1","kind":"route-intent","applicationOrigin":"https://station.example",
            "brokerOrigin":"https://broker.example","stationId":"11111111-1111-4111-8111-111111111111","enrollmentId":"22222222-2222-4222-8222-222222222222"});
        let delivery = state.receive(
            &link(&value),
            "io.kontourai.station.nightly",
            "nightly",
            false,
            now_ms(),
        );
        assert!(matches!(&delivery, LinkDelivery::RouteIntent { .. }));
        assert!(reserve_attempt(
            &state,
            pending_id(&delivery).unwrap(),
            "Home",
            "main",
            false
        )
        .is_err());
    }

    #[test]
    fn production_links_require_https_and_debug_links_allow_only_numeric_exact_loopback() {
        let now = now_ms();
        for origin in [
            "http://localhost:3491",
            "http://127.0.0.1:3491",
            "http://[::1]:3491",
        ] {
            for field in ["application", "broker"] {
                let mut value = invitation(now);
                if field == "application" {
                    value["applicationOrigin"] = json!(origin);
                } else {
                    value["invitation"]["brokerOrigin"] = json!(origin);
                }
                let state = NativeRelayLinkState::default();
                assert!(matches!(
                    state.receive(
                        &link(&value),
                        "io.kontourai.station.nightly",
                        "nightly",
                        false,
                        now
                    ),
                    LinkDelivery::Rejected { .. }
                ));
            }
        }
        let mut value = json!({"version":"station-native-relay-link/v1","kind":"route-intent","applicationOrigin":"http://127.0.0.1:3491",
            "brokerOrigin":"http://[::1]:3492","stationId":"11111111-1111-4111-8111-111111111111","enrollmentId":"22222222-2222-4222-8222-222222222222"});
        let mut url = link(&value);
        url.set_scheme("station-relay-dev-instance").unwrap();
        let state = NativeRelayLinkState::default();
        assert!(matches!(
            state.receive(&url, "io.kontourai.station.dev.instance", "dev", true, now),
            LinkDelivery::RouteIntent { .. }
        ));
        value["brokerOrigin"] = json!("http://localhost:3492");
        let mut url = link(&value);
        url.set_scheme("station-relay-dev-instance").unwrap();
        assert!(matches!(
            state.receive(&url, "io.kontourai.station.dev.instance", "dev", true, now),
            LinkDelivery::Rejected { .. }
        ));
    }
}

#[cfg(target_os = "ios")]
pub(crate) fn receive_opened(app: &AppHandle, urls: &[url::Url]) {
    let state = app.state::<NativeRelayLinkState>();
    let app_identifier = &app.config().identifier;
    let channel = crate::native_app_channel(app_identifier, cfg!(debug_assertions));
    let pairing_scheme =
        crate::pairing_deep_link_channels_generated::native_pairing_deep_link_scheme(
            app_identifier,
            cfg!(debug_assertions),
            channel,
        );
    for url in urls {
        if url.scheme().starts_with("station-relay-") {
            let delivery = state.receive(
                url,
                app_identifier,
                channel,
                cfg!(debug_assertions),
                now_ms(),
            );
            let _ = app.emit(EVENT, delivery);
        } else if url.scheme() == pairing_scheme && url.host_str() == Some("pair") {
            // Pairing remains a separate authority journey and retains its
            // existing reviewed payload parser in the native adapter.
            let value = url.to_string();
            if let Ok(mut inner) = state.0.state.lock() {
                inner.pairing.clear();
                inner.pairing.push(value.clone());
            }
            let _ = app.emit("station://pairing-deep-link", vec![value]);
        }
    }
}

#[cfg(target_os = "ios")]
pub(crate) fn reject_invalid_delivery(app: &AppHandle) {
    let state = app.state::<NativeRelayLinkState>();
    if let Ok(mut inner) = state.0.state.lock() {
        if !NativeRelayLinkState::cancel_pending(&mut inner) {
            drop(inner);
            let _ = app.emit(EVENT, rejected("unavailable"));
            return;
        }
        inner.notification = Some(rejected("invalid"));
    }
    let _ = app.emit(EVENT, rejected("invalid"));
}

#[tauri::command]
pub(crate) fn station_native_link_delivery_mode() -> &'static str {
    if cfg!(target_os = "ios") {
        "station-owned"
    } else {
        "plugin"
    }
}

#[tauri::command]
pub(crate) fn station_native_pairing_link_take(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeRelayLinkState>,
) -> Result<Vec<String>, String> {
    native_relay_key_approval::require_main_app_window(&window, &app)?;
    let mut inner = state.0.state.lock().map_err(|_| UNAVAILABLE.to_owned())?;
    if inner.unavailable {
        return Err(UNAVAILABLE.into());
    }
    Ok(std::mem::take(&mut inner.pairing))
}

#[tauri::command]
pub(crate) fn station_native_relay_link_take(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeRelayLinkState>,
) -> Result<Option<LinkDelivery>, String> {
    native_relay_key_approval::require_main_app_window(&window, &app)?;
    if !cfg!(target_os = "ios") {
        return Ok(Some(rejected("unsupported")));
    }
    state.take_delivery()
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_link_cancel(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeRelayLinkState>,
    pending_id: String,
) -> Result<(), String> {
    native_relay_key_approval::require_main_app_window(&window, &app)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let gate = state
            .0
            .state
            .lock()
            .map_err(|_| UNAVAILABLE.to_owned())?
            .pending
            .as_ref()
            .filter(|pending| self::pending_id(&pending.delivery) == Some(&pending_id))
            .map(|pending| pending.commit_gate.clone());
        // Only this blocking worker waits for a commit already in progress;
        // URL dispatch and the UI thread never wait for OS keyring writes.
        let _commit_guard = match gate.as_ref() {
            Some(gate) => Some(gate.lock().map_err(|_| UNAVAILABLE.to_owned())?),
            None => None,
        };
        let mut inner = state.0.state.lock().map_err(|_| UNAVAILABLE.to_owned())?;
        if inner
            .pending
            .as_ref()
            .is_some_and(|pending| self::pending_id(&pending.delivery) == Some(&pending_id))
        {
            let binding = inner.pending.as_ref().and_then(|pending| {
                pending
                    .profile_name
                    .clone()
                    .zip(pending.caller_label.clone())
            });
            NativeRelayLinkState::clear_pending_under_commit_gate(&mut inner);
            inner.notification = None;
            drop(inner);
            if let Some((profile_name, caller_label)) = binding {
                native_relay_key_approval::cancel(
                    app.state::<NativeRelayKeyApprovalState>().inner(),
                    &caller_label,
                    &profile_name,
                )?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|_| UNAVAILABLE.to_owned())?
}

fn check_saved_route(
    app: &AppHandle,
    name: &str,
    expected_updated_at: u64,
    route: &LinkRoute,
) -> Result<(), String> {
    let path = crate::station_profiles_path(app)?;
    let _lock = crate::lock_station_profiles_for_app(app, &path)?;
    let contents = crate::read_station_profile_store(&path).map_err(|_| MISSING.to_owned())?;
    let store = crate::parse_station_profile_store(&contents)?;
    let profile = crate::selected_profile_from_store(&store, name)?;
    let Some(saved) = profile.relay_route.as_ref() else {
        return Err(MISSING.into());
    };
    if profile.updated_at != expected_updated_at as f64
        || profile.endpoint != route.application_origin
        || saved.broker_origin != route.broker_origin
        || saved.station_id != route.station_id
        || saved.enrollment_id != route.enrollment_id
    {
        return Err(MISSING.into());
    }
    Ok(())
}

struct LinkAttempt {
    invitation: Zeroizing<Vec<u8>>,
    route: LinkRoute,
    cancelled: Arc<AtomicBool>,
    commit_gate: Arc<Mutex<()>>,
}

fn reserve_attempt(
    state: &NativeRelayLinkState,
    id: &str,
    profile_name: &str,
    caller_label: &str,
    consume: bool,
) -> Result<LinkAttempt, String> {
    let mut inner = state.0.state.lock().map_err(|_| UNAVAILABLE.to_owned())?;
    let pending = inner
        .pending
        .as_mut()
        .filter(|pending| pending_id(&pending.delivery) == Some(id))
        .ok_or_else(|| MISSING.to_owned())?;
    if pending.expires_at <= now_ms()
        || pending.cancelled.load(Ordering::Acquire)
        || pending.in_flight
        || pending
            .profile_name
            .as_ref()
            .is_some_and(|name| name != profile_name)
        || pending
            .caller_label
            .as_ref()
            .is_some_and(|label| label != caller_label)
    {
        return Err(MISSING.into());
    }
    let invitation = if consume {
        pending.invitation.take()
    } else {
        pending.invitation.clone()
    }
    .ok_or_else(|| MISSING.to_owned())?;
    pending.profile_name = Some(profile_name.into());
    pending.caller_label = Some(caller_label.into());
    pending.in_flight = true;
    Ok(LinkAttempt {
        invitation,
        route: pending.route.clone(),
        cancelled: pending.cancelled.clone(),
        commit_gate: pending.commit_gate.clone(),
    })
}

fn finish_attempt(state: &NativeRelayLinkState, id: &str, failed: bool, consumed: bool) {
    if let Ok(mut inner) = state.0.state.lock() {
        if inner
            .pending
            .as_ref()
            .is_some_and(|pending| pending_id(&pending.delivery) == Some(id))
        {
            if failed || consumed {
                if NativeRelayLinkState::cancel_pending(&mut inner) {
                    inner.notification = None;
                }
            } else if let Some(pending) = inner.pending.as_mut() {
                pending.in_flight = false;
            }
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_link_begin(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeRelayLinkState>,
    pending_id: String,
    profile_name: String,
    expected_updated_at: u64,
) -> Result<PendingCandidateDto, String> {
    native_relay_key_approval::require_main_app_window(&window, &app)?;
    if !cfg!(target_os = "ios") {
        return Err(UNAVAILABLE.into());
    }
    let state = state.inner().clone();
    let caller_label = window.label().to_owned();
    let attempt = reserve_attempt(&state, &pending_id, &profile_name, &caller_label, false)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            check_saved_route(&app, &profile_name, expected_updated_at, &attempt.route)?;
            let invitation: InvitationInput =
                serde_json::from_slice(&attempt.invitation).map_err(|_| MISSING.to_owned())?;
            native_relay_key_approval::begin_link(
                &app,
                app.state::<NativeRelayKeyApprovalState>().inner(),
                &caller_label,
                profile_name,
                invitation,
                &attempt.cancelled,
                attempt.commit_gate.clone(),
            )
        })();
        finish_attempt(&state, &pending_id, result.is_err(), false);
        result
    })
    .await
    .map_err(|_| UNAVAILABLE.to_owned())?
}

struct LinkContext<'a> {
    base: &'a AppNativeRedemptionContextProvider,
    route: &'a LinkRoute,
    cancelled: &'a AtomicBool,
}
impl NativeRedemptionContextProvider for LinkContext<'_> {
    fn with_current_context<T>(
        &self,
        profile_name: &str,
        operation: impl FnOnce(NativeRedemptionContext) -> RedemptionResult<T>,
    ) -> RedemptionResult<T> {
        self.base.with_current_context(profile_name, |current| {
            if self.cancelled.load(Ordering::Acquire)
                || current.profile.station_endpoint != self.route.application_origin
                || current.profile.broker_origin != self.route.broker_origin
                || current.profile.station_id != self.route.station_id
                || current.profile.enrollment_id != self.route.enrollment_id
            {
                return Err(NativeRedemptionError::StaleProfile);
            }
            operation(current)
        })
    }
}

async fn link_recovery(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeRelayLinkState>,
    pending_id: String,
    profile_name: String,
    expected_profile_revision: u64,
    expected_updated_at: u64,
    reset: bool,
) -> Result<NativeRelayRecoveryResult, String> {
    native_relay_key_approval::require_main_app_window(&window, &app)?;
    if !cfg!(target_os = "ios") {
        return Err(UNAVAILABLE.into());
    }
    let state = state.inner().clone();
    let attempt = reserve_attempt(&state, &pending_id, &profile_name, window.label(), false)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        check_saved_route(&app, &profile_name, expected_updated_at, &attempt.route)?;
        let invitation: NativeRelayInvitationV2 =
            serde_json::from_slice(&attempt.invitation).map_err(|_| MISSING.to_owned())?;
        let base = AppNativeRedemptionContextProvider::new(app);
        let context = LinkContext {
            base: &base,
            route: &attempt.route,
            cancelled: &attempt.cancelled,
        };
        let keys = NativeRelayProofKeyVault::new();
        let grants = native_relay_grant_vault();
        let current = context
            .with_current_context(&profile_name, |current| {
                if current.profile.revision != expected_profile_revision {
                    return Err(NativeRedemptionError::StaleProfile);
                }
                let owner = NativeProofKeyOwner::new(
                    &current.profile.app_identifier,
                    current.profile.channel,
                    &current.profile.client_instance_id,
                )
                .map_err(|_| NativeRedemptionError::InvalidProfile)?;
                let public = keys
                    .restore(&owner)
                    .map_err(|_| NativeRedemptionError::ProofKey)?;
                validate_invitation_and_trust(&current, &invitation, now_ms(), Some(&public))?;
                Ok(current)
            })
            .map_err(|_| "Station could not verify connection recovery ownership.".to_owned())?;
        let owner = NativeProofKeyOwner::new(
            &current.profile.app_identifier,
            current.profile.channel,
            &current.profile.client_instance_id,
        )
        .map_err(|_| UNAVAILABLE.to_owned())?;
        let outcomes = if reset {
            let http = UreqNativeBrokerTransport::new();
            let service =
                NativeRelayRedemptionService::new(&context, &keys, &http, &grants, now_ms);
            service
                .recover_link_cleanup(
                    &profile_name,
                    expected_profile_revision,
                    &invitation,
                    |owner, grant| {
                        observe_superseded_scope(&keys, owner, &invitation, grant, now_ms())
                    },
                    (&attempt.cancelled, &attempt.commit_gate),
                )
                .map_err(|_| {
                    "Station could not reset the connection invitation; cleanup may remain pending."
                        .to_owned()
                })?
        } else {
            Vec::new()
        };
        context
            .with_current_context(&profile_name, |fresh| {
                if fresh != current || attempt.cancelled.load(Ordering::Acquire) {
                    return Err(NativeRedemptionError::StaleProfile);
                }
                Ok(NativeRelayRecoveryResult {
                    state: NativeRelayGrantState::for_saved_profile(
                        &fresh.profile,
                        grants.metadata_for_profile_route(
                            &owner,
                            &fresh.profile.broker_origin,
                            &fresh.profile.station_id,
                            &fresh.profile.enrollment_id,
                            now_ms(),
                        )?,
                        grants.cleanup_statuses_for_profile_route(
                            &owner,
                            &fresh.profile.broker_origin,
                            &fresh.profile.station_id,
                            &fresh.profile.enrollment_id,
                        )?,
                    ),
                    outcomes,
                })
            })
            .map_err(|_| "Station could not read connection recovery status.".to_owned())
    })
    .await
    .map_err(|_| UNAVAILABLE.to_owned());
    // Recovery neither consumes nor erases the pending invitation on failure.
    finish_attempt(&state, &pending_id, false, false);
    result?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_link_recovery_preview(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeRelayLinkState>,
    pending_id: String,
    profile_name: String,
    expected_profile_revision: u64,
    expected_updated_at: u64,
) -> Result<NativeRelayRecoveryResult, String> {
    link_recovery(
        window,
        app,
        state,
        pending_id,
        profile_name,
        expected_profile_revision,
        expected_updated_at,
        false,
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_link_recovery_reset(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeRelayLinkState>,
    pending_id: String,
    profile_name: String,
    expected_profile_revision: u64,
    expected_updated_at: u64,
) -> Result<NativeRelayRecoveryResult, String> {
    link_recovery(
        window,
        app,
        state,
        pending_id,
        profile_name,
        expected_profile_revision,
        expected_updated_at,
        true,
    )
    .await
}

fn consume_attempt_invitation(
    state: &NativeRelayLinkState,
    id: &str,
    attempt: &LinkAttempt,
) -> RedemptionResult<()> {
    let _commit = attempt
        .commit_gate
        .lock()
        .map_err(|_| NativeRedemptionError::GrantStore)?;
    let mut inner = state
        .0
        .state
        .lock()
        .map_err(|_| NativeRedemptionError::GrantStore)?;
    let pending = inner
        .pending
        .as_mut()
        .filter(|pending| pending_id(&pending.delivery) == Some(id))
        .ok_or(NativeRedemptionError::StaleProfile)?;
    if attempt.cancelled.load(Ordering::Acquire)
        || pending.expires_at <= now_ms()
        || !pending.in_flight
    {
        return Err(NativeRedemptionError::StaleProfile);
    }
    pending
        .invitation
        .take()
        .ok_or(NativeRedemptionError::InvitationInvalid)?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_link_redeem(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, NativeRelayLinkState>,
    pending_id: String,
    profile_name: String,
    expected_profile_revision: u64,
    expected_updated_at: u64,
) -> Result<NativeRelayGrantRedemptionResult, String> {
    native_relay_key_approval::require_main_app_window(&window, &app)?;
    if !cfg!(target_os = "ios") {
        return Err(UNAVAILABLE.into());
    }
    let state = state.inner().clone();
    let attempt = reserve_attempt(&state, &pending_id, &profile_name, window.label(), false)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut requested = false;
        let result = (|| {
            check_saved_route(&app, &profile_name, expected_updated_at, &attempt.route)?;
            let invitation =
                serde_json::from_slice(&attempt.invitation).map_err(|_| MISSING.to_owned())?;
            let base = AppNativeRedemptionContextProvider::new(app);
            let context = LinkContext {
                base: &base,
                route: &attempt.route,
                cancelled: &attempt.cancelled,
            };
            let keys = NativeRelayProofKeyVault::new();
            let http = UreqNativeBrokerTransport::new();
            let grants = native_relay_grant_vault();
            let service =
                NativeRelayRedemptionService::new(&context, &keys, &http, &grants, now_ms);
            Ok(
                match service.redeem_with_request_gate(
                    &profile_name,
                    expected_profile_revision,
                    invitation,
                    Some((&attempt.cancelled, &attempt.commit_gate)),
                    || {
                        consume_attempt_invitation(&state, &pending_id, &attempt)?;
                        requested = true;
                        Ok(())
                    },
                ) {
                    Ok(grant) => NativeRelayGrantRedemptionResult::Redeemed { grant },
                    Err(failure) => NativeRelayGrantRedemptionResult::Failed { failure },
                },
            )
        })();
        finish_attempt(&state, &pending_id, result.is_err() && requested, requested);
        result
    })
    .await
    .map_err(|_| UNAVAILABLE.to_owned())?
}

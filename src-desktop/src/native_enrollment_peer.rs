//! Paired-Device-free, host-owned enrollment peers and retained response captures.

use crate::native_enrollment::{NativeEnrollmentScope, NativeEnrollmentSurface};
use crate::native_relay_proof_key::P256PublicJwk;
use crate::native_relay_redemption::{
    self, NativeEnrollmentRouteCapture, NativeRelaySignalAnswer, NativeRelaySignalOpenRequest,
    NativeRelaySignalReadRequest,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::rand::{SecureRandom as _, SystemRandom};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const REFUSED: &str = "native_enrollment_peer_refused";
const MAX_PEERS: usize = 16;
type Result<T> = std::result::Result<T, String>;
fn random() -> Result<String> {
    let mut bytes = [0u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| REFUSED.to_owned())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|v| v.as_millis() as u64)
        .unwrap_or(0)
}
fn handle(value: &str) -> bool {
    URL_SAFE_NO_PAD
        .decode(value)
        .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == value)
}

#[derive(Clone)]
struct Peer {
    capture: NativeEnrollmentRouteCapture,
    nonce: String,
    created_at: u64,
    expires_at: u64,
    deadline: Instant,
    offer: Option<String>,
    verified: bool,
    busy: bool,
}
#[derive(Default)]
pub(crate) struct NativeEnrollmentPeers(Mutex<HashMap<String, Peer>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeEnrollmentTrust {
    station_id: String,
    enrollment_id: String,
    generation: u64,
    signing_key: P256PublicJwk,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeEnrollmentPeerPrepared {
    version: &'static str,
    pub(crate) peer_handle: String,
    nonce: String,
    connection_id: String,
    expires_at: u64,
    scope: NativeEnrollmentScope,
    surface: NativeEnrollmentSurface,
    station_audience: String,
    trust: NativeEnrollmentTrust,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeEnrollmentPeerAnswer {
    version: &'static str,
    answer_sdp: Option<String>,
    station_proof: Option<String>,
    expires_at: u64,
}

impl NativeEnrollmentPeers {
    fn snapshot(&self, id: &str) -> Result<Peer> {
        if !handle(id) {
            return Err(REFUSED.into());
        }
        let time = now();
        let mut peers = self.0.lock().map_err(|_| REFUSED.to_owned())?;
        peers.retain(|_, p| {
            time >= p.created_at && time < p.expires_at && Instant::now() < p.deadline
        });
        peers.get(id).cloned().ok_or_else(|| REFUSED.to_owned())
    }
    fn current<T>(
        &self,
        app: &AppHandle,
        id: &str,
        expected: &Peer,
        operation: impl FnOnce(&mut Peer) -> Result<T>,
    ) -> Result<T> {
        native_relay_redemption::with_current_native_enrollment_route(
            app,
            &expected.capture.context.profile.profile_name,
            expected.capture.context.profile.revision,
            |capture| {
                if capture != expected.capture {
                    return Err(REFUSED.into());
                }
                let time = now();
                let mut peers = self.0.lock().map_err(|_| REFUSED.to_owned())?;
                let peer = peers.get_mut(id).ok_or_else(|| REFUSED.to_owned())?;
                if peer.capture != capture
                    || peer.nonce != expected.nonce
                    || time < peer.created_at
                    || time >= peer.expires_at
                    || Instant::now() >= peer.deadline
                {
                    return Err(REFUSED.into());
                }
                operation(peer)
            },
        )
    }
    pub(crate) fn retained_capture(
        &self,
        app: &AppHandle,
        id: &str,
    ) -> Result<(NativeEnrollmentRouteCapture, String, u64)> {
        let peer = self.snapshot(id)?;
        self.current(app, id, &peer, |live| {
            if !live.verified || live.busy {
                return Err(REFUSED.into());
            }
            Ok((live.capture.clone(), live.nonce.clone(), live.expires_at))
        })
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_enrollment_peer_prepare(
    window: tauri::WebviewWindow,
    app: AppHandle,
    profile_name: String,
    expected_profile_revision: u64,
) -> Result<NativeEnrollmentPeerPrepared> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        native_relay_redemption::with_current_native_enrollment_route(
            &app,
            &profile_name,
            expected_profile_revision,
            |capture| {
                let time = now();
                if time == 0 || capture.grant_expires_at <= time {
                    return Err(REFUSED.into());
                }
                let expires_at = (time + 120_000).min(capture.grant_expires_at);
                let id = random()?;
                let nonce = random()?;
                let state = app
                    .try_state::<NativeEnrollmentPeers>()
                    .ok_or_else(|| REFUSED.to_owned())?;
                let mut peers = state.0.lock().map_err(|_| REFUSED.to_owned())?;
                peers.retain(|_, p| {
                    time >= p.created_at && time < p.expires_at && Instant::now() < p.deadline
                });
                if peers.len() >= MAX_PEERS {
                    return Err(REFUSED.into());
                }
                let trust = &capture.context.station_trust;
                let result = NativeEnrollmentPeerPrepared {
                    version: "station-native-enrollment-peer/v1",
                    peer_handle: id.clone(),
                    nonce: nonce.clone(),
                    connection_id: capture.surface.client_instance_id.clone(),
                    expires_at,
                    scope: capture.scope.clone(),
                    surface: capture.surface.clone(),
                    station_audience: capture.context.profile.station_endpoint.clone(),
                    trust: NativeEnrollmentTrust {
                        station_id: trust.station_id.clone(),
                        enrollment_id: trust.enrollment_id.clone(),
                        generation: trust.generation,
                        signing_key: trust.signing_key.clone(),
                    },
                };
                peers.insert(
                    id,
                    Peer {
                        capture,
                        nonce,
                        created_at: time,
                        expires_at,
                        deadline: Instant::now() + Duration::from_millis(expires_at - time),
                        offer: None,
                        verified: false,
                        busy: false,
                    },
                );
                Ok(result)
            },
        )
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_enrollment_peer_open(
    window: tauri::WebviewWindow,
    app: AppHandle,
    peer_handle: String,
    offer_sdp: String,
) -> Result<serde_json::Value> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    if offer_sdp.is_empty() || offer_sdp.len() > 65536 {
        return Err(REFUSED.into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<NativeEnrollmentPeers>()
            .ok_or_else(|| REFUSED.to_owned())?;
        let peer = state.snapshot(&peer_handle)?;
        state.current(&app, &peer_handle, &peer, |live| {
            if live.busy || live.offer.is_some() {
                return Err(REFUSED.into());
            }
            live.busy = true;
            live.offer = Some(offer_sdp.clone());
            Ok(())
        })?;
        let result = native_relay_redemption::native_application_signal_open(
            app.clone(),
            NativeRelaySignalOpenRequest {
                profile_name: peer.capture.context.profile.profile_name.clone(),
                expected_profile_revision: peer.capture.context.profile.revision,
                nonce: peer.nonce.clone(),
                offer_sdp,
            },
        );
        state.current(&app, &peer_handle, &peer, |live| {
            live.busy = false;
            let value = result.map_err(|_| REFUSED.to_owned())?;
            if value.expires_at <= now() || value.expires_at > live.capture.grant_expires_at {
                return Err(REFUSED.into());
            }
            live.expires_at = live.expires_at.min(value.expires_at);
            live.deadline = live
                .deadline
                .min(Instant::now() + Duration::from_millis(live.expires_at - now()));
            Ok(serde_json::json!({"expiresAt":live.expires_at}))
        })
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_enrollment_peer_read(
    window: tauri::WebviewWindow,
    app: AppHandle,
    peer_handle: String,
) -> Result<NativeEnrollmentPeerAnswer> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app
            .try_state::<NativeEnrollmentPeers>()
            .ok_or_else(|| REFUSED.to_owned())?;
        let peer = state.snapshot(&peer_handle)?;
        let offer = state.current(&app, &peer_handle, &peer, |live| {
            if live.busy {
                return Err(REFUSED.into());
            }
            let offer = live.offer.clone().ok_or_else(|| REFUSED.to_owned())?;
            live.busy = true;
            Ok(offer)
        })?;
        let result = native_relay_redemption::native_application_signal_read(
            app.clone(),
            NativeRelaySignalReadRequest {
                profile_name: peer.capture.context.profile.profile_name.clone(),
                expected_profile_revision: peer.capture.context.profile.revision,
                nonce: peer.nonce.clone(),
            },
        );
        state.current(&app, &peer_handle, &peer, |live| {
            live.busy = false;
            let answer: NativeRelaySignalAnswer = result.map_err(|_| REFUSED.to_owned())?;
            if answer.answer_sdp.is_some() {
                let (_, proof_expires) =
                    crate::native_application_peer::verify_native_route_transcript(
                        &live.capture.context,
                        &live.nonce,
                        &offer,
                        &answer,
                        now() / 1000,
                    )?;
                live.expires_at = live
                    .expires_at
                    .min(answer.expires_at)
                    .min(proof_expires * 1000);
                if live.expires_at <= now() {
                    return Err(REFUSED.into());
                }
                live.deadline = live
                    .deadline
                    .min(Instant::now() + Duration::from_millis(live.expires_at - now()));
                live.verified = true;
            } else if answer.station_proof.is_some() {
                return Err(REFUSED.into());
            }
            Ok(NativeEnrollmentPeerAnswer {
                version: "station-broker-native-connection-answer/v2",
                answer_sdp: answer.answer_sdp,
                station_proof: answer.station_proof,
                expires_at: live.expires_at.min(answer.expires_at),
            })
        })
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_enrollment_peer_close(
    window: tauri::WebviewWindow,
    app: AppHandle,
    peer_handle: String,
) -> Result<()> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    if !handle(&peer_handle) {
        return Err(REFUSED.into());
    }
    let state = app
        .try_state::<NativeEnrollmentPeers>()
        .ok_or_else(|| REFUSED.to_owned())?;
    state
        .0
        .lock()
        .map_err(|_| REFUSED.to_owned())?
        .remove(&peer_handle);
    Ok(())
}

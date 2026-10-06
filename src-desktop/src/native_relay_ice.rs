//! Fixed native routing-only ICE operation. Issuer and routing bearer stay in their owners.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

const VERSION: &str = "station-relay-ice-configuration/v1";
const REFUSED: &str = "native_relay_ice_configuration_refused";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeRelayIceConfiguration {
    version: String,
    scope: NativeRelayIceScope,
    surface: NativeRelayIceSurface,
    ice_transport_policy: String,
    issued_at: u64,
    expires_at: u64,
    ice_servers: Vec<NativeRelayIceServer>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeRelayIceScope {
    station_id: String,
    enrollment_id: String,
    routing_generation: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NativeRelayIceSurface {
    kind: String,
    app_identifier: String,
    channel: String,
    client_instance_id: String,
    key_thumbprint: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NativeRelayIceServer {
    urls: Vec<String>,
    username: String,
    credential: String,
}

fn text(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && value.bytes().all(|byte| byte > 31 && byte != 127)
}

fn turn_url(value: &str) -> bool {
    if !text(value, 2048) {
        return false;
    }
    let (tls, rest) = if let Some(rest) = value.strip_prefix("turns:") {
        (true, rest)
    } else if let Some(rest) = value.strip_prefix("turn:") {
        (false, rest)
    } else {
        return false;
    };
    let (authority, transport) = rest
        .split_once('?')
        .map_or((rest, None), |(authority, query)| (authority, Some(query)));
    if !authority
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b".-:[]".contains(&byte))
        || !matches!(
            transport,
            None | Some("transport=tcp") | Some("transport=udp")
        )
        || (tls && transport == Some("transport=udp"))
    {
        return false;
    }
    let Ok(url) = url::Url::parse(&format!("https://{authority}")) else {
        return false;
    };
    url.host().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
        && url.port() != Some(0)
}

/// Expected metadata is serialized from the captured native owner, never renderer input.
pub(crate) fn parse_native_relay_ice_configuration(
    body: &[u8],
    expected_scope: &Value,
    expected_surface: &Value,
    now: u64,
    expected_grant_expires_at: u64,
) -> Result<NativeRelayIceConfiguration, String> {
    if body.len() > 16 * 1024 {
        return Err(REFUSED.into());
    }
    let receipt: NativeRelayIceConfiguration =
        serde_json::from_slice(body).map_err(|_| REFUSED.to_owned())?;
    if receipt.version != VERSION
        || receipt.ice_transport_policy != "relay"
        || receipt.issued_at > MAX_SAFE_INTEGER
        || receipt.expires_at > MAX_SAFE_INTEGER
        || receipt.expires_at > expected_grant_expires_at
        || receipt.issued_at > now.saturating_add(5000)
        || receipt.expires_at <= now.saturating_add(15_000)
        || receipt.expires_at <= receipt.issued_at
        || receipt.expires_at - receipt.issued_at > 600_000
        || serde_json::to_value(&receipt.scope).map_err(|_| REFUSED.to_owned())? != *expected_scope
        || serde_json::to_value(&receipt.surface).map_err(|_| REFUSED.to_owned())?
            != *expected_surface
        || !text(&receipt.scope.station_id, 128)
        || !text(&receipt.scope.enrollment_id, 128)
        || receipt.scope.routing_generation == 0
        || receipt.scope.routing_generation > MAX_SAFE_INTEGER
        || receipt.surface.kind != "station-native"
        || !text(&receipt.surface.app_identifier, 256)
        || !matches!(
            receipt.surface.channel.as_str(),
            "dev" | "stable" | "beta" | "nightly"
        )
        || receipt.ice_servers.is_empty()
        || receipt.ice_servers.len() > 4
        || receipt.ice_servers.iter().any(|server| {
            server.urls.is_empty()
                || server.urls.len() > 8
                || !server.urls.iter().all(|url| turn_url(url))
                || !text(&server.username, 512)
                || !text(&server.credential, 1024)
        })
    {
        return Err(REFUSED.into());
    }
    Ok(receipt)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn station_native_relay_ice_configuration(
    window: tauri::WebviewWindow,
    app: AppHandle,
    profile_name: String,
    expected_profile_revision: u64,
) -> Result<NativeRelayIceConfiguration, String> {
    crate::native_relay_key_approval::require_main_app_window(&window, &app)?;
    if profile_name.trim().is_empty()
        || profile_name.len() > 256
        || expected_profile_revision == 0
        || expected_profile_revision > MAX_SAFE_INTEGER
    {
        return Err(REFUSED.into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        crate::native_relay_redemption::read_native_relay_ice_configuration(
            &app,
            &profile_name,
            expected_profile_revision,
        )
        .map_err(|_| REFUSED.to_owned())
    })
    .await
    .map_err(|_| REFUSED.to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ice_receipt_is_closed_bound_and_short_lived() {
        let scope = json!({"stationId":"station-12345678","enrollmentId":"enroll-12345678","routingGeneration":1});
        let surface = json!({"kind":"station-native","appIdentifier":"io.kontourai.station","channel":"dev","clientInstanceId":"33333333-3333-4333-8333-333333333333","keyThumbprint":"T".repeat(43)});
        let receipt = json!({"version":VERSION,"scope":scope,"surface":surface,"iceTransportPolicy":"relay","issuedAt":1000,"expiresAt":601000,"iceServers":[{"urls":["turns:turn.example:443?transport=tcp"],"username":"end-user","credential":"end-user-secret"}]});
        assert!(parse_native_relay_ice_configuration(
            &serde_json::to_vec(&receipt).unwrap(),
            &scope,
            &surface,
            1000,
            601000
        )
        .is_ok());
        assert!(parse_native_relay_ice_configuration(
            &serde_json::to_vec(&receipt).unwrap(),
            &scope,
            &surface,
            1000,
            600999
        )
        .is_err());
        for change in [
            json!({"expiresAt":16000}),
            json!({"expiresAt":601001}),
            json!({"issuerSecret":"never-cross"}),
            json!({"iceTransportPolicy":"all"}),
            json!({"scope":{"stationId":"other-station","enrollmentId":"enroll-12345678","routingGeneration":1}}),
        ] {
            let mut invalid = receipt.clone();
            invalid
                .as_object_mut()
                .unwrap()
                .extend(change.as_object().unwrap().clone());
            assert!(parse_native_relay_ice_configuration(
                &serde_json::to_vec(&invalid).unwrap(),
                &scope,
                &surface,
                1000,
                601000
            )
            .is_err());
        }
        for url in [
            "https://issuer.example",
            "turns:turn.example:443?transport=udp",
            "turn:turn.example:70000",
            "turn:secret@turn.example",
        ] {
            assert!(!turn_url(url));
        }
    }
}

//! Desktop-only custody for short-lived client routing grants.
//!
//! The secret is accepted by one narrowly scoped store command and stays in
//! the OS keyring after that. The only read command returns the binding and
//! expiry metadata; it has no secret-returning path.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::AppHandle;

const RELAY_GRANT_INDEX_ACCOUNT: &str = "relay-client-grant:index:v1";
static RELAY_GRANT_VAULT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct RelayGrantRouteKey {
    pub(crate) broker_origin: String,
    pub(crate) station_id: String,
    pub(crate) enrollment_id: String,
    pub(crate) routing_generation: u64,
    pub(crate) grant_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RelayGrantOwner {
    channel: String,
    client_instance_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RelayGrantBinding {
    route: RelayGrantRouteKey,
    owner: RelayGrantOwner,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct RelayGrantCredential {
    pub(crate) id: String,
    pub(crate) secret: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct RelayGrantScope {
    pub(crate) station_id: String,
    pub(crate) enrollment_id: String,
    pub(crate) routing_generation: u64,
    pub(crate) browser_origin: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct RelayClientGrant {
    pub(crate) version: String,
    pub(crate) credential: RelayGrantCredential,
    pub(crate) broker_origin: String,
    pub(crate) scope: RelayGrantScope,
    pub(crate) station_signing_key_id: String,
    pub(crate) station_signing_generation: u64,
    pub(crate) expires_at: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StoredRelayGrant {
    schema_version: u8,
    binding: RelayGrantBinding,
    grant: RelayClientGrant,
}

/// The renderer may learn the stored routing scope and expiry. This metadata
/// is not proof of Station trust or a connected broker route; it never
/// contains the keyring payload.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct RelayGrantMetadata {
    pub(crate) route: RelayGrantRouteKey,
    pub(crate) scope: RelayGrantScope,
    pub(crate) station_signing_key_id: String,
    pub(crate) station_signing_generation: u64,
    pub(crate) expires_at: u64,
}

trait RelayGrantBackend {
    fn get(&mut self, account: &str) -> Result<Option<String>, String>;
    fn set(&mut self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&mut self, account: &str) -> Result<(), String>;
}

fn validate_uuid(value: &str, name: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    if bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
        && matches!(bytes[14].to_ascii_lowercase(), b'1'..=b'8')
        && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
    {
        Ok(())
    } else {
        Err(format!("invalid relay grant {name}"))
    }
}

fn fixed_base64url(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn relay_browser_origin_allowed(value: &str) -> bool {
    if super::exact_origin(value).ok().as_deref() != Some(value) {
        return false;
    }
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    if url.scheme() == "https" {
        return true;
    }
    if url.scheme() != "http" {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn validate_route(route: &RelayGrantRouteKey) -> Result<(), String> {
    if route.broker_origin.len() > 512
        || super::exact_origin(&route.broker_origin).ok().as_deref()
            != Some(route.broker_origin.as_str())
        || !super::credential_endpoint_uses_secure_transport(&route.broker_origin)
    {
        return Err("invalid relay broker origin".to_string());
    }
    validate_uuid(&route.station_id, "Station id")?;
    validate_uuid(&route.enrollment_id, "enrollment id")?;
    if !fixed_base64url(&route.grant_id, 22) {
        return Err("invalid relay grant id".to_string());
    }
    if route.routing_generation == 0 || route.routing_generation > 9_007_199_254_740_991 {
        return Err("invalid relay routing generation".to_string());
    }
    Ok(())
}

fn validate_binding(binding: &RelayGrantBinding) -> Result<(), String> {
    validate_route(&binding.route)?;
    if !matches!(
        binding.owner.channel.as_str(),
        "dev" | "stable" | "beta" | "nightly"
    ) {
        return Err("invalid relay grant channel".to_string());
    }
    validate_uuid(&binding.owner.client_instance_id, "client instance id")?;
    Ok(())
}

fn route_for(grant: &RelayClientGrant) -> RelayGrantRouteKey {
    RelayGrantRouteKey {
        broker_origin: grant.broker_origin.clone(),
        station_id: grant.scope.station_id.clone(),
        enrollment_id: grant.scope.enrollment_id.clone(),
        routing_generation: grant.scope.routing_generation,
        grant_id: grant.credential.id.clone(),
    }
}

fn validate_grant(grant: &RelayClientGrant, now: u64) -> Result<RelayGrantRouteKey, String> {
    let route = route_for(grant);
    validate_route(&route)?;
    if grant.scope.browser_origin.len() > 512
        || !relay_browser_origin_allowed(&grant.scope.browser_origin)
    {
        return Err("invalid relay grant browser origin".to_string());
    }
    if grant.station_signing_generation == 0
        || grant.station_signing_generation > 9_007_199_254_740_991
        || grant.version != "station-broker-client-grant/v1"
        || !fixed_base64url(&grant.station_signing_key_id, 43)
        || !fixed_base64url(&grant.credential.secret, 43)
        || grant.expires_at <= now
        || grant.expires_at > 9_007_199_254_740_991
    {
        return Err("invalid or expired relay grant".to_string());
    }
    Ok(route)
}

/// Length prefixes make this account mapping injective even when the origin
/// contains punctuation. It is separate from the `profile:` account namespace
/// used by ordinary Station credentials.
fn account_for(binding: &RelayGrantBinding) -> Result<String, String> {
    validate_binding(binding)?;
    let generation = binding.route.routing_generation.to_string();
    let parts = [
        binding.route.broker_origin.as_str(),
        binding.route.station_id.as_str(),
        binding.route.enrollment_id.as_str(),
        generation.as_str(),
        binding.route.grant_id.as_str(),
        binding.owner.channel.as_str(),
        binding.owner.client_instance_id.as_str(),
    ];
    let mut account = String::from("relay-client-grant:v1:");
    for part in parts {
        account.push_str(&part.len().to_string());
        account.push(':');
        account.push_str(part);
        account.push(':');
    }
    if account.len() > 2048 {
        return Err("relay grant binding is too large".to_string());
    }
    Ok(account)
}

fn store_grant(
    backend: &mut impl RelayGrantBackend,
    owner: RelayGrantOwner,
    grant: RelayClientGrant,
    now: u64,
) -> Result<RelayGrantMetadata, String> {
    let route = validate_grant(&grant, now)?;
    let binding = RelayGrantBinding { route, owner };
    validate_binding(&binding)?;
    let account = account_for(&binding)?;
    let payload = StoredRelayGrant {
        schema_version: 1,
        binding: binding.clone(),
        grant: grant.clone(),
    };
    let encoded = serde_json::to_string(&payload)
        .map_err(|_| "could not encode relay grant for the OS credential store".to_string())?;
    add_to_index(backend, &binding)?;
    backend.set(&account, &encoded)?;
    Ok(metadata_from(binding, grant))
}

fn metadata_from(binding: RelayGrantBinding, grant: RelayClientGrant) -> RelayGrantMetadata {
    RelayGrantMetadata {
        route: binding.route,
        scope: grant.scope,
        station_signing_key_id: grant.station_signing_key_id,
        station_signing_generation: grant.station_signing_generation,
        expires_at: grant.expires_at,
    }
}

fn read_metadata(
    backend: &mut impl RelayGrantBackend,
    binding: &RelayGrantBinding,
    now: u64,
) -> Result<Option<RelayGrantMetadata>, String> {
    let account = account_for(binding)?;
    let Some(encoded) = backend.get(&account)? else {
        return Ok(None);
    };
    let stored: StoredRelayGrant = serde_json::from_str(&encoded)
        .map_err(|_| "stored relay grant is unreadable; revoke it and enroll again".to_string())?;
    if stored.schema_version != 1
        || stored.binding != *binding
        || route_for(&stored.grant) != binding.route
    {
        return Err("stored relay grant binding does not match the requested route".to_string());
    }
    if stored.grant.expires_at <= now {
        return Ok(None);
    }
    validate_grant(&stored.grant, now)?;
    Ok(Some(metadata_from(stored.binding, stored.grant)))
}

fn revoke_grant(
    backend: &mut impl RelayGrantBackend,
    binding: &RelayGrantBinding,
) -> Result<(), String> {
    backend.delete(&account_for(binding)?)?;
    let mut index = read_index(backend)?;
    index.retain(|entry| entry != binding);
    write_index(backend, &index)
}

fn read_index(backend: &mut impl RelayGrantBackend) -> Result<Vec<RelayGrantBinding>, String> {
    let Some(encoded) = backend.get(RELAY_GRANT_INDEX_ACCOUNT)? else {
        return Ok(Vec::new());
    };
    let bindings: Vec<RelayGrantBinding> = serde_json::from_str(&encoded)
        .map_err(|_| "relay grant metadata index is unreadable".to_string())?;
    if bindings.len() > 10_000 {
        return Err("relay grant metadata index exceeds its limit".to_string());
    }
    for binding in &bindings {
        validate_binding(binding)?;
    }
    Ok(bindings)
}

fn write_index(
    backend: &mut impl RelayGrantBackend,
    bindings: &[RelayGrantBinding],
) -> Result<(), String> {
    let encoded = serde_json::to_string(bindings)
        .map_err(|_| "could not encode relay grant metadata index".to_string())?;
    backend.set(RELAY_GRANT_INDEX_ACCOUNT, &encoded)
}

fn add_to_index(
    backend: &mut impl RelayGrantBackend,
    binding: &RelayGrantBinding,
) -> Result<(), String> {
    let mut index = read_index(backend)?;
    if !index.contains(binding) {
        if index.len() >= 10_000 {
            return Err(
                "relay grant metadata index is full; revoke expired routes first".to_string(),
            );
        }
        index.push(binding.clone());
        write_index(backend, &index)?;
    }
    Ok(())
}

/// Remove every client grant for a saved route that was deleted or replaced.
/// The keyring index contains bindings only, never credentials. This leaves
/// the separate `profile:` Station bearer accounts untouched.
pub(crate) fn invalidate_removed_routes(
    app: &AppHandle,
    current: &super::CredentialProfileStore,
    next: &super::CredentialProfileStore,
) -> Result<(), String> {
    let channel = super::native_app_channel(&app.config().identifier, cfg!(debug_assertions));
    let removed: Vec<_> = current
        .profiles
        .iter()
        .filter_map(|profile| {
            let route = profile.relay_route.as_ref()?;
            let client_instance_id = profile.client_instance_id.as_ref()?;
            let same_owner_route_remains = next.profiles.iter().any(|candidate| {
                candidate.relay_route.as_ref() == Some(route)
                    && candidate.client_instance_id.as_ref() == Some(client_instance_id)
            });
            (!same_owner_route_remains).then(|| {
                (
                    route.clone(),
                    RelayGrantOwner {
                        channel: channel.to_string(),
                        client_instance_id: client_instance_id.clone(),
                    },
                )
            })
        })
        .collect();
    if removed.is_empty() {
        return Ok(());
    }
    let _guard = RELAY_GRANT_VAULT_LOCK
        .lock()
        .map_err(|_| "native relay grant vault is unavailable".to_string())?;
    invalidate_route_bindings(&mut OsKeyring, &removed)
}

fn invalidate_route_bindings(
    backend: &mut impl RelayGrantBackend,
    removed: &[(super::NativeStationRelayRoute, RelayGrantOwner)],
) -> Result<(), String> {
    let mut index = read_index(backend)?;
    let targets: Vec<_> = index
        .iter()
        .filter(|binding| {
            removed.iter().any(|(route, owner)| {
                binding.route.broker_origin == route.broker_origin
                    && binding.route.station_id == route.station_id
                    && binding.route.enrollment_id == route.enrollment_id
                    && binding.owner == *owner
            })
        })
        .cloned()
        .collect();
    for binding in &targets {
        backend.delete(&account_for(binding)?)?;
    }
    index.retain(|binding| !targets.contains(binding));
    write_index(backend, &index)
}

struct OsKeyring;

impl RelayGrantBackend for OsKeyring {
    fn get(&mut self, account: &str) -> Result<Option<String>, String> {
        super::initialize_credential_store()?;
        let entry = keyring_core::Entry::new(super::STATION_CREDENTIAL_SERVICE, account)
            .map_err(|error| format!("open OS relay credential entry: {error}"))?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("read OS relay credential entry: {error}")),
        }
    }

    fn set(&mut self, account: &str, value: &str) -> Result<(), String> {
        super::initialize_credential_store()?;
        let entry = keyring_core::Entry::new(super::STATION_CREDENTIAL_SERVICE, account)
            .map_err(|error| format!("open OS relay credential entry: {error}"))?;
        entry
            .set_password(value)
            .map_err(|error| format!("write OS relay credential entry: {error}"))
    }

    fn delete(&mut self, account: &str) -> Result<(), String> {
        super::initialize_credential_store()?;
        let entry = keyring_core::Entry::new(super::STATION_CREDENTIAL_SERVICE, account)
            .map_err(|error| format!("open OS relay credential entry: {error}"))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("delete OS relay credential entry: {error}")),
        }
    }
}

fn unix_time_ms() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .map_err(|_| "system clock predates the Unix epoch".to_string())
}

#[tauri::command]
pub(crate) fn relay_client_grant_store(
    app: AppHandle,
    profile_name: String,
    grant: RelayClientGrant,
) -> Result<RelayGrantMetadata, String> {
    let _guard = RELAY_GRANT_VAULT_LOCK
        .lock()
        .map_err(|_| "native relay grant vault is unavailable".to_string())?;
    let owner = owner_for_profile(&app, &profile_name, &grant)?;
    store_grant(&mut OsKeyring, owner, grant, unix_time_ms()?)
}

#[tauri::command]
pub(crate) fn relay_client_grant_revoke(
    app: AppHandle,
    profile_name: String,
    route: RelayGrantRouteKey,
) -> Result<(), String> {
    let _guard = RELAY_GRANT_VAULT_LOCK
        .lock()
        .map_err(|_| "native relay grant vault is unavailable".to_string())?;
    let owner = owner_for_route(&app, &profile_name, &route)?;
    revoke_grant(&mut OsKeyring, &RelayGrantBinding { route, owner })
}

#[tauri::command]
pub(crate) fn relay_client_grant_metadata(
    app: AppHandle,
    profile_name: String,
    route: RelayGrantRouteKey,
) -> Result<Option<RelayGrantMetadata>, String> {
    let _guard = RELAY_GRANT_VAULT_LOCK
        .lock()
        .map_err(|_| "native relay grant vault is unavailable".to_string())?;
    let owner = owner_for_route(&app, &profile_name, &route)?;
    read_metadata(
        &mut OsKeyring,
        &RelayGrantBinding { route, owner },
        unix_time_ms()?,
    )
}

fn owner_for_profile(
    app: &AppHandle,
    profile_name: &str,
    grant: &RelayClientGrant,
) -> Result<RelayGrantOwner, String> {
    let route = route_for(grant);
    owner_for_route(app, profile_name, &route)
}

fn owner_for_route(
    app: &AppHandle,
    profile_name: &str,
    route: &RelayGrantRouteKey,
) -> Result<RelayGrantOwner, String> {
    validate_route(route)?;
    if profile_name.is_empty() || profile_name.len() > 128 {
        return Err("invalid relay Station profile name".to_string());
    }
    let contents = super::read_station_profile_contents(app)?;
    let store = super::parse_station_profile_store(&contents)?;
    let profile = store
        .profiles
        .iter()
        .find(|profile| profile.name.eq_ignore_ascii_case(profile_name))
        .ok_or_else(|| "relay Station profile is unavailable".to_string())?;
    let saved_route = profile
        .relay_route
        .as_ref()
        .ok_or_else(|| "saved Station profile has no relay route".to_string())?;
    if saved_route.broker_origin != route.broker_origin
        || saved_route.station_id != route.station_id
        || saved_route.enrollment_id != route.enrollment_id
    {
        return Err("relay grant does not match the saved Station route".to_string());
    }
    let client_instance_id = profile
        .client_instance_id
        .clone()
        .ok_or_else(|| "relay Station profile has no client instance id".to_string())?;
    let owner = RelayGrantOwner {
        channel: super::native_app_channel(&app.config().identifier, cfg!(debug_assertions))
            .to_string(),
        client_instance_id,
    };
    validate_binding(&RelayGrantBinding {
        route: route.clone(),
        owner: owner.clone(),
    })?;
    Ok(owner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryKeyring(HashMap<String, String>);

    impl RelayGrantBackend for MemoryKeyring {
        fn get(&mut self, account: &str) -> Result<Option<String>, String> {
            Ok(self.0.get(account).cloned())
        }
        fn set(&mut self, account: &str, value: &str) -> Result<(), String> {
            self.0.insert(account.to_string(), value.to_string());
            Ok(())
        }
        fn delete(&mut self, account: &str) -> Result<(), String> {
            self.0.remove(account);
            Ok(())
        }
    }

    fn route_key() -> RelayGrantRouteKey {
        RelayGrantRouteKey {
            broker_origin: "https://broker.example".to_string(),
            station_id: "11111111-1111-4111-8111-111111111111".to_string(),
            enrollment_id: "22222222-2222-4222-8222-222222222222".to_string(),
            routing_generation: 4,
            grant_id: "G".repeat(22),
        }
    }

    fn owner(channel: &str, id: &str) -> RelayGrantOwner {
        RelayGrantOwner {
            channel: channel.to_string(),
            client_instance_id: id.to_string(),
        }
    }

    fn binding(channel: &str, id: &str) -> RelayGrantBinding {
        RelayGrantBinding {
            route: route_key(),
            owner: owner(channel, id),
        }
    }

    fn grant(secret: &str, expires_at: u64) -> RelayClientGrant {
        RelayClientGrant {
            version: "station-broker-client-grant/v1".to_string(),
            credential: RelayGrantCredential {
                id: route_key().grant_id,
                secret: secret.to_string(),
            },
            broker_origin: "https://broker.example".to_string(),
            scope: RelayGrantScope {
                station_id: "11111111-1111-4111-8111-111111111111".to_string(),
                enrollment_id: "22222222-2222-4222-8222-222222222222".to_string(),
                routing_generation: 4,
                browser_origin: "https://app.example".to_string(),
            },
            station_signing_key_id: "K".repeat(43),
            station_signing_generation: 1,
            expires_at,
        }
    }

    fn profile_route() -> super::super::NativeStationRelayRoute {
        super::super::NativeStationRelayRoute {
            broker_origin: "https://broker.example".to_string(),
            station_id: "11111111-1111-4111-8111-111111111111".to_string(),
            enrollment_id: "22222222-2222-4222-8222-222222222222".to_string(),
        }
    }

    #[test]
    fn storage_is_bound_to_the_complete_relay_route_identity() {
        let mut keyring = MemoryKeyring::default();
        let route = route_key();
        let binding = binding("stable", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        store_grant(
            &mut keyring,
            binding.owner.clone(),
            grant(&"R".repeat(43), 2_000),
            1_000,
        )
        .unwrap();
        let mut variants = vec![route.clone(); 5];
        variants[0].broker_origin = "https://other.example".to_string();
        variants[1].station_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string();
        variants[2].enrollment_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string();
        variants[3].routing_generation += 1;
        variants[4].grant_id = "X".repeat(22);
        for other_route in variants {
            assert!(read_metadata(
                &mut keyring,
                &RelayGrantBinding {
                    route: other_route,
                    owner: binding.owner.clone(),
                },
                1_001,
            )
            .unwrap()
            .is_none());
        }
        assert_eq!(
            read_metadata(&mut keyring, &binding, 1_001)
                .unwrap()
                .unwrap()
                .expires_at,
            2_000
        );
    }

    #[test]
    fn replacement_and_revocation_are_exact_and_secret_free_at_ipc() {
        let mut keyring = MemoryKeyring::default();
        let binding = binding("stable", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        store_grant(
            &mut keyring,
            binding.owner.clone(),
            grant(&"O".repeat(43), 2_000),
            1_000,
        )
        .unwrap();
        let metadata = store_grant(
            &mut keyring,
            binding.owner.clone(),
            grant(&"R".repeat(43), 3_000),
            1_001,
        )
        .unwrap();
        let ipc = serde_json::to_string(&metadata).unwrap();
        assert_eq!(metadata.expires_at, 3_000);
        assert!(!ipc.contains("secret"));
        assert!(!ipc.contains(&"R".repeat(43)));
        let stored = keyring
            .get(&account_for(&binding).unwrap())
            .unwrap()
            .unwrap();
        assert!(stored.contains(&"R".repeat(43)));
        assert!(!stored.contains(&"O".repeat(43)));
        let index = keyring.get(RELAY_GRANT_INDEX_ACCOUNT).unwrap().unwrap();
        assert!(!index.contains(&"R".repeat(43)));
        revoke_grant(&mut keyring, &binding).unwrap();
        assert!(read_metadata(&mut keyring, &binding, 1_002)
            .unwrap()
            .is_none());
    }

    #[test]
    fn expiry_and_credential_identity_are_enforced() {
        let mut keyring = MemoryKeyring::default();
        let binding = binding("stable", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        assert!(store_grant(
            &mut keyring,
            binding.owner.clone(),
            grant(&"R".repeat(43), 1_000),
            1_000
        )
        .is_err());
        let mut wrong = grant(&"R".repeat(43), 2_000);
        wrong.credential.id = "not-22-chars".to_string();
        assert!(store_grant(&mut keyring, binding.owner.clone(), wrong, 1_000).is_err());
        let mut wrong_version = grant(&"R".repeat(43), 2_000);
        wrong_version.version = "other/v1".to_string();
        assert!(store_grant(&mut keyring, binding.owner.clone(), wrong_version, 1_000).is_err());
        let mut wrong_secret = grant("not-base64url", 2_000);
        assert!(store_grant(
            &mut keyring,
            binding.owner.clone(),
            wrong_secret.clone(),
            1_000
        )
        .is_err());
        wrong_secret.credential.secret = "R".repeat(43);
        wrong_secret.station_signing_key_id = "not-base64url".to_string();
        assert!(store_grant(&mut keyring, binding.owner.clone(), wrong_secret, 1_000).is_err());
        let mut local_browser_origin = grant(&"R".repeat(43), 2_000);
        local_browser_origin.scope.browser_origin = "http://localhost:5173".to_string();
        assert!(validate_grant(&local_browser_origin, 1_000).is_ok());
        local_browser_origin.scope.browser_origin = "http://localhost:5173/path".to_string();
        assert!(validate_grant(&local_browser_origin, 1_000).is_err());
        store_grant(
            &mut keyring,
            binding.owner.clone(),
            grant(&"R".repeat(43), 1_500),
            1_000,
        )
        .unwrap();
        assert!(read_metadata(&mut keyring, &binding, 1_500)
            .unwrap()
            .is_none());
    }

    #[test]
    fn removing_a_relay_route_revokes_its_grants_without_touching_station_bearers() {
        let mut keyring = MemoryKeyring::default();
        let stable = owner("stable", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        let nightly = owner("nightly", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        let other_client = owner("stable", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
        let current = grant(&"R".repeat(43), 3_000);
        let current_binding = RelayGrantBinding {
            route: route_key(),
            owner: stable.clone(),
        };
        store_grant(&mut keyring, stable.clone(), current.clone(), 1_000).unwrap();
        store_grant(&mut keyring, nightly.clone(), current.clone(), 1_000).unwrap();
        store_grant(&mut keyring, other_client.clone(), current.clone(), 1_000).unwrap();

        let mut newer_generation = current.clone();
        newer_generation.scope.routing_generation += 1;
        store_grant(&mut keyring, stable.clone(), newer_generation, 1_000).unwrap();

        keyring
            .set("profile:station-bearer:unchanged", "station-token")
            .unwrap();

        invalidate_route_bindings(&mut keyring, &[(profile_route(), stable)]).unwrap();
        assert!(read_metadata(&mut keyring, &current_binding, 1_001)
            .unwrap()
            .is_none());
        assert!(read_metadata(
            &mut keyring,
            &RelayGrantBinding {
                route: route_key(),
                owner: nightly
            },
            1_001
        )
        .unwrap()
        .is_some());
        assert!(read_metadata(
            &mut keyring,
            &RelayGrantBinding {
                route: route_key(),
                owner: other_client
            },
            1_001
        )
        .unwrap()
        .is_some());
        assert_eq!(
            keyring.get("profile:station-bearer:unchanged").unwrap(),
            Some("station-token".to_string())
        );
    }
}

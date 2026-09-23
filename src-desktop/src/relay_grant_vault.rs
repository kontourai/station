//! Desktop-only custody for short-lived client routing grants.
//!
//! The secret is accepted by one narrowly scoped store command and stays in
//! the OS keyring after that. The only read command returns the binding and
//! expiry metadata; it has no secret-returning path.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

const RELAY_GRANT_INDEX_ACCOUNT: &str = "relay-client-grant:index:v1";
static RELAY_GRANT_VAULT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct RelayGrantBinding {
    pub(crate) broker_origin: String,
    pub(crate) station_id: String,
    pub(crate) enrollment_id: String,
    pub(crate) routing_generation: u64,
    pub(crate) grant_id: String,
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

/// The renderer may learn whether the exact grant is present and when it
/// expires. It never receives the keyring payload.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct RelayGrantMetadata {
    pub(crate) binding: RelayGrantBinding,
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

fn validate_binding(binding: &RelayGrantBinding) -> Result<(), String> {
    if binding.broker_origin.len() > 512
        || super::exact_origin(&binding.broker_origin).ok().as_deref()
            != Some(binding.broker_origin.as_str())
        || !super::credential_endpoint_uses_secure_transport(&binding.broker_origin)
    {
        return Err("invalid relay broker origin".to_string());
    }
    validate_uuid(&binding.station_id, "Station id")?;
    validate_uuid(&binding.enrollment_id, "enrollment id")?;
    validate_uuid(&binding.grant_id, "grant id")?;
    if binding.routing_generation == 0 || binding.routing_generation > 9_007_199_254_740_991 {
        return Err("invalid relay routing generation".to_string());
    }
    Ok(())
}

fn binding_for(grant: &RelayClientGrant) -> RelayGrantBinding {
    RelayGrantBinding {
        broker_origin: grant.broker_origin.clone(),
        station_id: grant.scope.station_id.clone(),
        enrollment_id: grant.scope.enrollment_id.clone(),
        routing_generation: grant.scope.routing_generation,
        grant_id: grant.credential.id.clone(),
    }
}

fn validate_grant(grant: &RelayClientGrant, now: u64) -> Result<RelayGrantBinding, String> {
    let binding = binding_for(grant);
    validate_binding(&binding)?;
    if grant.scope.browser_origin.len() > 512
        || super::exact_origin(&grant.scope.browser_origin)
            .ok()
            .as_deref()
            != Some(grant.scope.browser_origin.as_str())
        || !super::credential_endpoint_uses_secure_transport(&grant.scope.browser_origin)
    {
        return Err("invalid relay grant browser origin".to_string());
    }
    if grant.station_signing_key_id.trim().is_empty()
        || grant.station_signing_key_id.len() > 512
        || grant.station_signing_generation == 0
        || grant.station_signing_generation > 9_007_199_254_740_991
        || grant.credential.secret.is_empty()
        || grant.credential.secret.len() > 16_384
        || grant.expires_at <= now
        || grant.expires_at > 9_007_199_254_740_991
    {
        return Err("invalid or expired relay grant".to_string());
    }
    Ok(binding)
}

/// Length prefixes make this account mapping injective even when the origin
/// contains punctuation. It is separate from the `profile:` account namespace
/// used by ordinary Station credentials.
fn account_for(binding: &RelayGrantBinding) -> Result<String, String> {
    validate_binding(binding)?;
    let generation = binding.routing_generation.to_string();
    let parts = [
        binding.broker_origin.as_str(),
        binding.station_id.as_str(),
        binding.enrollment_id.as_str(),
        generation.as_str(),
        binding.grant_id.as_str(),
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
    grant: RelayClientGrant,
    now: u64,
) -> Result<RelayGrantMetadata, String> {
    let binding = validate_grant(&grant, now)?;
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
        binding,
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
        || binding_for(&stored.grant) != *binding
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
    current: &super::CredentialProfileStore,
    next: &super::CredentialProfileStore,
) -> Result<(), String> {
    let removed: Vec<_> = current
        .profiles
        .iter()
        .filter_map(|profile| profile.relay_route.as_ref())
        .filter(|route| {
            !next
                .profiles
                .iter()
                .any(|profile| profile.relay_route.as_ref() == Some(*route))
        })
        .cloned()
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
    removed: &[super::NativeStationRelayRoute],
) -> Result<(), String> {
    let mut index = read_index(backend)?;
    let targets: Vec<_> = index
        .iter()
        .filter(|binding| {
            removed.iter().any(|route| {
                binding.broker_origin == route.broker_origin
                    && binding.station_id == route.station_id
                    && binding.enrollment_id == route.enrollment_id
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
    grant: RelayClientGrant,
) -> Result<RelayGrantMetadata, String> {
    let _guard = RELAY_GRANT_VAULT_LOCK
        .lock()
        .map_err(|_| "native relay grant vault is unavailable".to_string())?;
    store_grant(&mut OsKeyring, grant, unix_time_ms()?)
}

#[tauri::command]
pub(crate) fn relay_client_grant_revoke(binding: RelayGrantBinding) -> Result<(), String> {
    let _guard = RELAY_GRANT_VAULT_LOCK
        .lock()
        .map_err(|_| "native relay grant vault is unavailable".to_string())?;
    revoke_grant(&mut OsKeyring, &binding)
}

#[tauri::command]
pub(crate) fn relay_client_grant_metadata(
    binding: RelayGrantBinding,
) -> Result<Option<RelayGrantMetadata>, String> {
    let _guard = RELAY_GRANT_VAULT_LOCK
        .lock()
        .map_err(|_| "native relay grant vault is unavailable".to_string())?;
    read_metadata(&mut OsKeyring, &binding, unix_time_ms()?)
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

    fn binding() -> RelayGrantBinding {
        RelayGrantBinding {
            broker_origin: "https://broker.example".to_string(),
            station_id: "11111111-1111-4111-8111-111111111111".to_string(),
            enrollment_id: "22222222-2222-4222-8222-222222222222".to_string(),
            routing_generation: 4,
            grant_id: "33333333-3333-4333-8333-333333333333".to_string(),
        }
    }

    fn grant(secret: &str, expires_at: u64) -> RelayClientGrant {
        RelayClientGrant {
            credential: RelayGrantCredential {
                id: binding().grant_id,
                secret: secret.to_string(),
            },
            broker_origin: "https://broker.example".to_string(),
            scope: RelayGrantScope {
                station_id: "11111111-1111-4111-8111-111111111111".to_string(),
                enrollment_id: "22222222-2222-4222-8222-222222222222".to_string(),
                routing_generation: 4,
                browser_origin: "https://app.example".to_string(),
            },
            station_signing_key_id: "station-key-1".to_string(),
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
        let route = binding();
        store_grant(&mut keyring, grant("first-secret", 2_000), 1_000).unwrap();
        let mut variants = vec![route.clone(); 5];
        variants[0].broker_origin = "https://other.example".to_string();
        variants[1].station_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string();
        variants[2].enrollment_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string();
        variants[3].routing_generation += 1;
        variants[4].grant_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc".to_string();
        for other_route in variants {
            assert!(read_metadata(&mut keyring, &other_route, 1_001)
                .unwrap()
                .is_none());
        }
        assert_eq!(
            read_metadata(&mut keyring, &route, 1_001)
                .unwrap()
                .unwrap()
                .expires_at,
            2_000
        );
    }

    #[test]
    fn replacement_and_revocation_are_exact_and_secret_free_at_ipc() {
        let mut keyring = MemoryKeyring::default();
        let route = binding();
        store_grant(&mut keyring, grant("old-secret", 2_000), 1_000).unwrap();
        let metadata =
            store_grant(&mut keyring, grant("replacement-secret", 3_000), 1_001).unwrap();
        let ipc = serde_json::to_string(&metadata).unwrap();
        assert_eq!(metadata.expires_at, 3_000);
        assert!(!ipc.contains("secret"));
        assert!(!ipc.contains("replacement-secret"));
        assert!(keyring
            .0
            .values()
            .any(|value| value.contains("replacement-secret")));
        assert!(!keyring.0.values().any(|value| value.contains("old-secret")));
        revoke_grant(&mut keyring, &route).unwrap();
        assert!(read_metadata(&mut keyring, &route, 1_002)
            .unwrap()
            .is_none());
    }

    #[test]
    fn expiry_and_credential_identity_are_enforced() {
        let mut keyring = MemoryKeyring::default();
        let route = binding();
        assert!(store_grant(&mut keyring, grant("secret", 1_000), 1_000).is_err());
        let mut wrong = grant("secret", 2_000);
        wrong.credential.id = "not-a-uuid".to_string();
        assert!(store_grant(&mut keyring, wrong, 1_000).is_err());
        store_grant(&mut keyring, grant("secret", 1_500), 1_000).unwrap();
        assert!(read_metadata(&mut keyring, &route, 1_500)
            .unwrap()
            .is_none());
    }

    #[test]
    fn removing_a_relay_route_revokes_its_grants_without_touching_station_bearers() {
        let mut keyring = MemoryKeyring::default();
        let current = grant("current-secret", 3_000);
        let current_binding = binding_for(&current);
        store_grant(&mut keyring, current.clone(), 1_000).unwrap();

        let mut newer_generation = current.clone();
        newer_generation.scope.routing_generation += 1;
        newer_generation.credential.id = "44444444-4444-4444-8444-444444444444".to_string();
        store_grant(&mut keyring, newer_generation, 1_000).unwrap();

        let mut other_route = current.clone();
        other_route.broker_origin = "https://another-broker.example".to_string();
        other_route.credential.id = "55555555-5555-4555-8555-555555555555".to_string();
        store_grant(&mut keyring, other_route.clone(), 1_000).unwrap();
        keyring
            .set("profile:station-bearer:unchanged", "station-token")
            .unwrap();

        invalidate_route_bindings(&mut keyring, &[profile_route()]).unwrap();
        assert!(read_metadata(&mut keyring, &current_binding, 1_001)
            .unwrap()
            .is_none());
        assert!(
            read_metadata(&mut keyring, &binding_for(&other_route), 1_001)
                .unwrap()
                .is_some()
        );
        assert_eq!(
            keyring.get("profile:station-bearer:unchanged").unwrap(),
            Some("station-token".to_string())
        );
    }
}

//! Cleanup for the first-generation desktop relay routing-grant keyring
//! entries.
//!
//! The webview commands that stored, revoked and read these grants were
//! removed: nothing invoked them, and the native relay owner keeps its grants
//! in `native_relay_redemption::NativeRelayGrantVault` since #3114. What
//! remains deletes any first-generation entries bound to a saved relay route
//! when that route is removed or replaced. The keyring index holds bindings
//! only, never credentials.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::AppHandle;

const RELAY_GRANT_INDEX_ACCOUNT_PREFIX: &str = "relay-client-grant:index:v1:";
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

fn with_vault_lock<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _guard = RELAY_GRANT_VAULT_LOCK
        .lock()
        .map_err(|_| "native relay grant vault is unavailable".to_string())?;
    operation()
}

fn index_account(channel: &str) -> Result<String, String> {
    if !matches!(channel, "dev" | "stable" | "beta" | "nightly") {
        return Err("invalid relay grant channel".to_string());
    }
    Ok(format!("{RELAY_GRANT_INDEX_ACCOUNT_PREFIX}{channel}"))
}

fn read_index(
    backend: &mut impl RelayGrantBackend,
    channel: &str,
) -> Result<Vec<RelayGrantBinding>, String> {
    let account = index_account(channel)?;
    let Some(encoded) = backend.get(&account)? else {
        return Ok(Vec::new());
    };
    let bindings: Vec<RelayGrantBinding> = serde_json::from_str(&encoded)
        .map_err(|_| "relay grant metadata index is unreadable".to_string())?;
    if bindings.len() > 10_000 {
        return Err("relay grant metadata index exceeds its limit".to_string());
    }
    for binding in &bindings {
        validate_binding(binding)?;
        if binding.owner.channel != channel {
            return Err("relay grant index contains another channel's binding".to_string());
        }
    }
    Ok(bindings)
}

fn write_index(
    backend: &mut impl RelayGrantBackend,
    channel: &str,
    bindings: &[RelayGrantBinding],
) -> Result<(), String> {
    let account = index_account(channel)?;
    if bindings
        .iter()
        .any(|binding| binding.owner.channel != channel)
    {
        return Err("refusing to write another channel's relay grant binding".to_string());
    }
    let encoded = serde_json::to_string(bindings)
        .map_err(|_| "could not encode relay grant metadata index".to_string())?;
    backend.set(&account, &encoded)
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
    with_vault_lock(|| invalidate_route_bindings(&mut OsKeyring, channel, &removed))
}

fn invalidate_route_bindings(
    backend: &mut impl RelayGrantBackend,
    channel: &str,
    removed: &[(super::NativeStationRelayRoute, RelayGrantOwner)],
) -> Result<(), String> {
    let mut index = read_index(backend, channel)?;
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
    write_index(backend, channel, &index)
}

struct OsKeyring;

impl RelayGrantBackend for OsKeyring {
    fn get(&mut self, account: &str) -> Result<Option<String>, String> {
        super::initialize_credential_store()?;
        let entry = crate::native_secure_entry::NativeSecureEntry::new(
            super::STATION_CREDENTIAL_SERVICE,
            account,
        )
        .map_err(|error| format!("open OS relay credential entry: {error}"))?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("read OS relay credential entry: {error}")),
        }
    }

    fn set(&mut self, account: &str, value: &str) -> Result<(), String> {
        super::initialize_credential_store()?;
        let entry = crate::native_secure_entry::NativeSecureEntry::new(
            super::STATION_CREDENTIAL_SERVICE,
            account,
        )
        .map_err(|error| format!("open OS relay credential entry: {error}"))?;
        entry
            .set_password(value)
            .map_err(|error| format!("write OS relay credential entry: {error}"))
    }

    fn delete(&mut self, account: &str) -> Result<(), String> {
        super::initialize_credential_store()?;
        let entry = crate::native_secure_entry::NativeSecureEntry::new(
            super::STATION_CREDENTIAL_SERVICE,
            account,
        )
        .map_err(|error| format!("open OS relay credential entry: {error}"))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("delete OS relay credential entry: {error}")),
        }
    }
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

    fn profile_route() -> super::super::NativeStationRelayRoute {
        super::super::NativeStationRelayRoute {
            broker_origin: "https://broker.example".to_string(),
            station_id: "11111111-1111-4111-8111-111111111111".to_string(),
            enrollment_id: "22222222-2222-4222-8222-222222222222".to_string(),
        }
    }

    /// Seed an entry the way the removed store command left one: the
    /// binding in its channel index plus a keyring account for the grant.
    fn seed(keyring: &mut MemoryKeyring, binding: &RelayGrantBinding) -> String {
        let mut index = read_index(keyring, &binding.owner.channel).unwrap();
        index.push(binding.clone());
        write_index(keyring, &binding.owner.channel, &index).unwrap();
        let account = account_for(binding).unwrap();
        keyring.set(&account, "stored-grant").unwrap();
        account
    }

    #[test]
    fn removing_a_relay_route_revokes_its_grants_without_touching_station_bearers() {
        let mut keyring = MemoryKeyring::default();
        let stable = binding("stable", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        let nightly = binding("nightly", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        let other_client = binding("stable", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
        let mut newer_generation = stable.clone();
        newer_generation.route.routing_generation += 1;

        let stable_account = seed(&mut keyring, &stable);
        let nightly_account = seed(&mut keyring, &nightly);
        let other_client_account = seed(&mut keyring, &other_client);
        let newer_generation_account = seed(&mut keyring, &newer_generation);
        keyring
            .set("profile:station-bearer:unchanged", "station-token")
            .unwrap();

        invalidate_route_bindings(
            &mut keyring,
            "stable",
            &[(profile_route(), stable.owner.clone())],
        )
        .unwrap();

        // Every generation of the removed owner's route is gone.
        assert_eq!(keyring.get(&stable_account).unwrap(), None);
        assert_eq!(keyring.get(&newer_generation_account).unwrap(), None);
        assert_eq!(
            read_index(&mut keyring, "stable").unwrap(),
            vec![other_client]
        );
        // Another channel and another client instance keep their grants.
        assert!(keyring.get(&nightly_account).unwrap().is_some());
        assert!(keyring.get(&other_client_account).unwrap().is_some());
        assert_eq!(read_index(&mut keyring, "nightly").unwrap(), vec![nightly]);
        assert_eq!(
            keyring.get("profile:station-bearer:unchanged").unwrap(),
            Some("station-token".to_string())
        );
    }

    #[test]
    fn stable_and_nightly_index_writes_do_not_overwrite_each_other() {
        let mut keyring = MemoryKeyring::default();
        let stable = binding("stable", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        let nightly = binding("nightly", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

        // Model two processes taking their initial index snapshots before
        // either publishes its new binding. Separate channel accounts keep
        // both writes even when this process-local mutex cannot coordinate
        // them.
        let stable_snapshot = read_index(&mut keyring, "stable").unwrap();
        let nightly_snapshot = read_index(&mut keyring, "nightly").unwrap();
        write_index(&mut keyring, "stable", &[stable.clone()]).unwrap();
        write_index(&mut keyring, "nightly", &[nightly.clone()]).unwrap();

        assert_eq!(read_index(&mut keyring, "stable").unwrap(), vec![stable]);
        assert_eq!(read_index(&mut keyring, "nightly").unwrap(), vec![nightly]);
        assert!(stable_snapshot.is_empty());
        assert!(nightly_snapshot.is_empty());
    }
}

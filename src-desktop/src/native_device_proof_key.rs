//! Desktop-only custody for Station's native Device proof key.
//!
//! This vault is separate from the host account proof key vault
//! (`native_account_proof_key`) and the broker routing proof key
//! (`native_relay_proof_key`): it uses its own keyring service and record
//! prefix, and its records bind to a typed exact owner that names the app
//! identifier, channel, client instance, Station ID, approved Device ID, and
//! a random Device-proof binding UUID. Private PKCS#8 bytes never leave the
//! desktop crate, never reach logs, and there is no plaintext fallback. There
//! is no Tauri IPC command here; signing is Rust-internal only. Storage and
//! crypto rules are shared with the sibling proof-key vaults via
//! `native_proof_key_core`.

use crate::native_proof_key_core::{
    proof_key_account, valid_app_identifier, KeyringSecretBackend, ProofKeyOwner,
};
use crate::native_relay_proof_key::NativeProofKeyChannel;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[cfg(test)]
pub(crate) use crate::native_proof_key_core::MemorySecretBackend;
#[cfg(test)]
use crate::native_proof_key_core::ProofKeySecretBackend;
pub(crate) use crate::native_proof_key_core::{
    ProofKeyError as DeviceProofKeyError,
    ProofKeyPublicMetadata as NativeDeviceProofKeyPublicMetadata,
    ProofKeyResult as DeviceProofKeyResult, ProofKeyVaultCore as DeviceProofKeyVaultCore,
};

const KEYRING_SERVICE: &str = "io.kontourai.station.device-proof";
const RECORD_PREFIX: &str = "native-device-proof:v1";

/// Typed exact owner for a Device proof key. Besides the identity fields the
/// owner carries a random Device-proof binding UUID minted at owner creation;
/// a record minted for one binding is unusable by any other owner or binding.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeDeviceProofKeyOwner {
    app_identifier: String,
    channel: NativeProofKeyChannel,
    client_instance_id: Uuid,
    station_id: Uuid,
    approved_device_id: Uuid,
    device_proof_binding_id: Uuid,
}

impl NativeDeviceProofKeyOwner {
    /// Mints a fresh random Device-proof binding UUID for `create`.
    /// Use [`Self::with_binding_id`] to address an existing binding for
    /// restore, replacement, signing, or revocation.
    pub(crate) fn new(
        app_identifier: &str,
        channel: NativeProofKeyChannel,
        client_instance_id: &str,
        station_id: &str,
        approved_device_id: &str,
    ) -> DeviceProofKeyResult<Self> {
        Self::with_binding_id(
            app_identifier,
            channel,
            client_instance_id,
            station_id,
            approved_device_id,
            &Uuid::new_v4().to_string(),
        )
    }

    pub(crate) fn with_binding_id(
        app_identifier: &str,
        channel: NativeProofKeyChannel,
        client_instance_id: &str,
        station_id: &str,
        approved_device_id: &str,
        device_proof_binding_id: &str,
    ) -> DeviceProofKeyResult<Self> {
        if !valid_app_identifier(app_identifier) {
            return Err(DeviceProofKeyError::InvalidOwner);
        }
        let exact_uuid = |value: &str| {
            Uuid::parse_str(value)
                .ok()
                .filter(|parsed| parsed.to_string() == value)
        };
        let (
            Some(client_instance_id),
            Some(station_id),
            Some(approved_device_id),
            Some(device_proof_binding_id),
        ) = (
            exact_uuid(client_instance_id),
            exact_uuid(station_id),
            exact_uuid(approved_device_id),
            exact_uuid(device_proof_binding_id),
        )
        else {
            return Err(DeviceProofKeyError::InvalidOwner);
        };
        Ok(Self {
            app_identifier: app_identifier.to_owned(),
            channel,
            client_instance_id,
            station_id,
            approved_device_id,
            device_proof_binding_id,
        })
    }

    /// The keyring account is a domain-separated digest of the full typed
    /// owner under the Device vault's own record prefix, so no owner field is
    /// a path into another record and the service/account namespace stays
    /// distinct from the account and relay proof keys.
    fn account(&self) -> String {
        proof_key_account(
            RECORD_PREFIX,
            &[
                self.app_identifier.as_bytes(),
                self.channel.keyring_label().as_bytes(),
                self.client_instance_id.as_bytes(),
                self.station_id.as_bytes(),
                self.approved_device_id.as_bytes(),
                self.device_proof_binding_id.as_bytes(),
            ],
        )
    }
}

impl ProofKeyOwner for NativeDeviceProofKeyOwner {
    fn account(&self) -> String {
        Self::account(self)
    }
}

pub(crate) struct NativeDeviceProofKeyVault {
    inner: DeviceProofKeyVaultCore<KeyringSecretBackend>,
}

impl Default for NativeDeviceProofKeyVault {
    fn default() -> Self {
        Self::new()
    }
}

impl NativeDeviceProofKeyVault {
    pub(crate) fn new() -> Self {
        Self {
            inner: DeviceProofKeyVaultCore::new(KeyringSecretBackend::new(KEYRING_SERVICE)),
        }
    }

    pub(crate) fn create(
        &self,
        owner: &NativeDeviceProofKeyOwner,
    ) -> DeviceProofKeyResult<NativeDeviceProofKeyPublicMetadata> {
        self.inner.create(owner)
    }

    pub(crate) fn restore(
        &self,
        owner: &NativeDeviceProofKeyOwner,
    ) -> DeviceProofKeyResult<NativeDeviceProofKeyPublicMetadata> {
        self.inner.restore(owner)
    }

    pub(crate) fn replace(
        &self,
        owner: &NativeDeviceProofKeyOwner,
    ) -> DeviceProofKeyResult<NativeDeviceProofKeyPublicMetadata> {
        self.inner.replace(owner)
    }

    pub(crate) fn revoke(&self, owner: &NativeDeviceProofKeyOwner) -> DeviceProofKeyResult<()> {
        self.inner.revoke(owner)
    }

    pub(crate) fn public_jwk(
        &self,
        owner: &NativeDeviceProofKeyOwner,
    ) -> DeviceProofKeyResult<crate::native_relay_proof_key::P256PublicJwk> {
        Ok(self.inner.restore(owner)?.jwk().clone())
    }

    /// ES256 signature over the exact JWS `header.payload` bytes in P1363
    /// (fixed-width r||s) form. The native Device proof type is inside that
    /// signed header. The bounded native peer owner constructs these bytes;
    /// renderer IPC cannot supply raw signing input or retrieve a private key.
    pub(crate) fn sign_es256_p1363(
        &self,
        owner: &NativeDeviceProofKeyOwner,
        message: &[u8],
    ) -> DeviceProofKeyResult<Vec<u8>> {
        self.inner.sign_es256_p1363(owner, message)
    }
}

#[cfg(test)]
pub(crate) struct MemoryNativeDeviceProofKeyVault {
    inner: DeviceProofKeyVaultCore<MemorySecretBackend>,
}

#[cfg(test)]
impl Default for MemoryNativeDeviceProofKeyVault {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
impl MemoryNativeDeviceProofKeyVault {
    pub(crate) fn new() -> Self {
        Self {
            inner: DeviceProofKeyVaultCore::new(MemorySecretBackend::default()),
        }
    }

    pub(crate) fn create(
        &self,
        owner: &NativeDeviceProofKeyOwner,
    ) -> DeviceProofKeyResult<NativeDeviceProofKeyPublicMetadata> {
        self.inner.create(owner)
    }

    pub(crate) fn restore(
        &self,
        owner: &NativeDeviceProofKeyOwner,
    ) -> DeviceProofKeyResult<NativeDeviceProofKeyPublicMetadata> {
        self.inner.restore(owner)
    }

    pub(crate) fn replace(
        &self,
        owner: &NativeDeviceProofKeyOwner,
    ) -> DeviceProofKeyResult<NativeDeviceProofKeyPublicMetadata> {
        self.inner.replace(owner)
    }

    pub(crate) fn revoke(&self, owner: &NativeDeviceProofKeyOwner) -> DeviceProofKeyResult<()> {
        self.inner.revoke(owner)
    }

    pub(crate) fn public_jwk(
        &self,
        owner: &NativeDeviceProofKeyOwner,
    ) -> DeviceProofKeyResult<crate::native_relay_proof_key::P256PublicJwk> {
        Ok(self.inner.restore(owner)?.jwk().clone())
    }

    pub(crate) fn sign_es256_p1363(
        &self,
        owner: &NativeDeviceProofKeyOwner,
        message: &[u8],
    ) -> DeviceProofKeyResult<Vec<u8>> {
        self.inner.sign_es256_p1363(owner, message)
    }

    pub(crate) fn backend(&self) -> MemorySecretBackend {
        self.inner.backend.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_account_proof_key::{
        MemoryNativeAccountProofKeyVault, NativeAccountProofKeyOwner,
    };
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    use ring::signature::{self, UnparsedPublicKey};
    use zeroize::Zeroizing;

    const APP: &str = "io.kontourai.station";
    const CLIENT: &str = "33333333-3333-4333-8333-333333333333";
    const STATION: &str = "11111111-1111-4111-8111-111111111111";
    const DEVICE: &str = "44444444-4444-4444-8444-444444444444";
    const BINDING: &str = "77777777-7777-4777-8777-777777777777";
    const MESSAGE: &[u8] = b"native-device-header.native-device-payload";

    fn owner() -> NativeDeviceProofKeyOwner {
        NativeDeviceProofKeyOwner::with_binding_id(
            APP,
            NativeProofKeyChannel::Stable,
            CLIENT,
            STATION,
            DEVICE,
            BINDING,
        )
        .unwrap()
    }

    fn owner_with_binding(binding: &str) -> NativeDeviceProofKeyOwner {
        NativeDeviceProofKeyOwner::with_binding_id(
            APP,
            NativeProofKeyChannel::Stable,
            CLIENT,
            STATION,
            DEVICE,
            binding,
        )
        .unwrap()
    }

    fn account_owner() -> NativeAccountProofKeyOwner {
        NativeAccountProofKeyOwner::new(APP, NativeProofKeyChannel::Stable, CLIENT, STATION, DEVICE)
            .unwrap()
    }

    fn verify_p1363(
        jwk: &crate::native_relay_proof_key::P256PublicJwk,
        message: &[u8],
        signature: &[u8],
    ) -> bool {
        let x = URL_SAFE_NO_PAD.decode(jwk.x()).unwrap();
        let y = URL_SAFE_NO_PAD.decode(jwk.y()).unwrap();
        let mut point = Vec::with_capacity(65);
        point.push(0x04);
        point.extend_from_slice(&x);
        point.extend_from_slice(&y);
        UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, point)
            .verify(message, signature)
            .is_ok()
    }

    #[test]
    fn device_namespace_is_distinct_from_the_account_namespace_for_same_identity() {
        let device = owner();
        let account = account_owner();
        assert!(device.account().starts_with("native-device-proof:v1:"));
        assert_ne!(device.account(), account.account());
        assert_eq!(KEYRING_SERVICE, "io.kontourai.station.device-proof");
        assert_ne!(KEYRING_SERVICE, "io.kontourai.station.account-proof");
        assert_ne!(KEYRING_SERVICE, "io.kontourai.station.relay-proof");
    }

    #[test]
    fn create_returns_metadata_and_reopens_the_same_key() {
        let vault = MemoryNativeDeviceProofKeyVault::new();
        let owner = owner();
        let created = vault.create(&owner).unwrap();
        assert_eq!(created.jwk().kty(), "EC");
        assert_eq!(created.jwk().crv(), "P-256");
        assert_eq!(created.thumbprint().len(), 43);
        assert_eq!(vault.restore(&owner).unwrap(), created);
        assert_eq!(&vault.public_jwk(&owner).unwrap(), created.jwk());
    }

    #[test]
    fn duplicate_create_fails_closed() {
        let vault = MemoryNativeDeviceProofKeyVault::new();
        let owner = owner();
        vault.create(&owner).unwrap();
        assert_eq!(
            vault.create(&owner).unwrap_err(),
            DeviceProofKeyError::AlreadyExists
        );
    }

    #[test]
    fn exact_owner_mismatch_refuses_on_every_read() {
        let vault = MemoryNativeDeviceProofKeyVault::new();
        vault.create(&owner()).unwrap();

        // A different binding UUID is a different owner and a different
        // keyring account.
        let other_binding = owner_with_binding("88888888-8888-4888-8888-888888888888");
        assert_ne!(owner().account(), other_binding.account());
        assert_eq!(
            vault.restore(&other_binding).unwrap_err(),
            DeviceProofKeyError::Missing
        );

        // Different approved Device, Station, or client instance likewise.
        let shifted = |device: &str, station: &str, client: &str| {
            NativeDeviceProofKeyOwner::with_binding_id(
                APP,
                NativeProofKeyChannel::Stable,
                client,
                station,
                device,
                BINDING,
            )
            .unwrap()
        };
        assert_eq!(
            vault
                .restore(&shifted(
                    "55555555-5555-4555-8555-555555555555",
                    STATION,
                    CLIENT
                ))
                .unwrap_err(),
            DeviceProofKeyError::Missing
        );
        assert_eq!(
            vault
                .restore(&shifted(
                    DEVICE,
                    "22222222-2222-4222-8222-222222222222",
                    CLIENT
                ))
                .unwrap_err(),
            DeviceProofKeyError::Missing
        );
        assert_eq!(
            vault
                .restore(&shifted(
                    DEVICE,
                    STATION,
                    "66666666-6666-4666-8666-666666666666"
                ))
                .unwrap_err(),
            DeviceProofKeyError::Missing
        );

        // A different channel is a different owner.
        let beta = NativeDeviceProofKeyOwner::with_binding_id(
            APP,
            NativeProofKeyChannel::Beta,
            CLIENT,
            STATION,
            DEVICE,
            BINDING,
        )
        .unwrap();
        assert_eq!(
            vault.restore(&beta).unwrap_err(),
            DeviceProofKeyError::Missing
        );
    }

    #[test]
    fn invalid_owner_fields_are_rejected() {
        assert_eq!(
            NativeDeviceProofKeyOwner::with_binding_id(
                "bad app",
                NativeProofKeyChannel::Stable,
                CLIENT,
                STATION,
                DEVICE,
                BINDING
            )
            .unwrap_err(),
            DeviceProofKeyError::InvalidOwner
        );
        assert_eq!(
            NativeDeviceProofKeyOwner::with_binding_id(
                APP,
                NativeProofKeyChannel::Stable,
                CLIENT,
                STATION,
                DEVICE,
                "not-a-uuid"
            )
            .unwrap_err(),
            DeviceProofKeyError::InvalidOwner
        );
        assert_eq!(
            NativeDeviceProofKeyOwner::new(
                APP,
                NativeProofKeyChannel::Stable,
                "not-a-uuid",
                STATION,
                DEVICE
            )
            .unwrap_err(),
            DeviceProofKeyError::InvalidOwner
        );
    }

    #[test]
    fn replace_rotates_and_revoke_removes() {
        let vault = MemoryNativeDeviceProofKeyVault::new();
        let owner = owner();
        let first = vault.create(&owner).unwrap();
        let old_signature = vault.sign_es256_p1363(&owner, MESSAGE).unwrap();
        let second = vault.replace(&owner).unwrap();
        assert_ne!(first.thumbprint(), second.thumbprint());
        assert!(!verify_p1363(second.jwk(), MESSAGE, &old_signature));
        let new_signature = vault.sign_es256_p1363(&owner, MESSAGE).unwrap();
        assert!(verify_p1363(second.jwk(), MESSAGE, &new_signature));
        assert_eq!(
            vault
                .replace(&owner_with_binding("88888888-8888-4888-8888-888888888888"))
                .unwrap_err(),
            DeviceProofKeyError::Missing
        );

        vault.revoke(&owner).unwrap();
        assert_eq!(
            vault.restore(&owner).unwrap_err(),
            DeviceProofKeyError::Missing
        );
        assert_eq!(
            vault.sign_es256_p1363(&owner, MESSAGE).unwrap_err(),
            DeviceProofKeyError::Missing
        );
        assert_eq!(
            vault.revoke(&owner).unwrap_err(),
            DeviceProofKeyError::Missing
        );
    }

    #[test]
    fn corrupted_record_fails_closed() {
        let vault = MemoryNativeDeviceProofKeyVault::new();
        let owner = owner();
        vault.create(&owner).unwrap();
        let backend = vault.backend();
        let account = owner.account();

        backend
            .lock()
            .get_mut(&account)
            .unwrap()
            .replace_range(.., "{\"version\":1,\"owner\":");
        assert_eq!(
            vault.restore(&owner).unwrap_err(),
            DeviceProofKeyError::Corrupt
        );

        *backend.lock().get_mut(&account).unwrap() = "not json at all".to_owned();
        assert_eq!(
            vault.sign_es256_p1363(&owner, MESSAGE).unwrap_err(),
            DeviceProofKeyError::Corrupt
        );
    }

    #[test]
    fn record_for_a_different_owner_is_refused_even_if_accounts_collided() {
        let vault = MemoryNativeDeviceProofKeyVault::new();
        let owner = owner();
        vault.create(&owner).unwrap();
        let backend = vault.backend();
        let account = owner.account();

        // Rebuild the record JSON with the same account string but a
        // mismatching owner; owner equality on read must fail closed.
        let stored = r#"{"version":1,"owner":{"appIdentifier":"io.kontourai.station","channel":"stable","clientInstanceId":"33333333-3333-4333-8333-333333333333","stationId":"11111111-1111-4111-8111-111111111111","approvedDeviceId":"44444444-4444-4444-8444-444444444444","deviceProofBindingId":"99999999-9999-4999-8999-999999999999"},"privatePkcs8":"AA","public":{"jwk":{"kty":"EC","crv":"P-256","x":"a","y":"a"},"thumbprint":"t"}}"#;
        backend.lock().insert(account, stored.to_owned());
        assert_eq!(
            vault.restore(&owner).unwrap_err(),
            DeviceProofKeyError::Corrupt
        );
    }

    #[test]
    fn unavailable_backend_fails_closed() {
        struct LockedBackend;
        impl ProofKeySecretBackend for LockedBackend {
            fn read(&self, _: &str) -> DeviceProofKeyResult<Option<Zeroizing<String>>> {
                Err(DeviceProofKeyError::Store)
            }
            fn write(&self, _: &str, _: &str) -> DeviceProofKeyResult<()> {
                Err(DeviceProofKeyError::Store)
            }
            fn delete(&self, _: &str) -> DeviceProofKeyResult<()> {
                Err(DeviceProofKeyError::Store)
            }
        }
        let vault = DeviceProofKeyVaultCore::new(LockedBackend);
        let owner = owner();
        assert_eq!(
            vault.create(&owner).unwrap_err(),
            DeviceProofKeyError::Store
        );
        assert_eq!(
            vault.restore(&owner).unwrap_err(),
            DeviceProofKeyError::Store
        );
        assert_eq!(
            vault.sign_es256_p1363(&owner, MESSAGE).unwrap_err(),
            DeviceProofKeyError::Store
        );
    }

    #[test]
    fn device_signature_verifies_against_device_jwk_and_not_the_account_jwk() {
        let device_vault = MemoryNativeDeviceProofKeyVault::new();
        let account_vault = MemoryNativeAccountProofKeyVault::new();
        let device_owner = owner();
        let account_owner = account_owner();

        let device = device_vault.create(&device_owner).unwrap();
        let account = account_vault.create(&account_owner).unwrap();
        assert_ne!(device.thumbprint(), account.thumbprint());

        let signature = device_vault
            .sign_es256_p1363(&device_owner, MESSAGE)
            .unwrap();
        assert_eq!(signature.len(), 64);
        assert!(verify_p1363(device.jwk(), MESSAGE, &signature));
        // The account vault's key must not verify a Device-proof signature,
        // and the namespaces never resolve to the same key material.
        assert!(!verify_p1363(account.jwk(), MESSAGE, &signature));
        assert!(!verify_p1363(device.jwk(), b"other message", &signature));

        let account_signature = account_vault
            .sign_es256_p1363(&account_owner, MESSAGE)
            .unwrap();
        assert!(verify_p1363(account.jwk(), MESSAGE, &account_signature));
        assert!(!verify_p1363(device.jwk(), MESSAGE, &account_signature));
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "writes one random account to the current macOS Keychain"]
    fn macos_keychain_roundtrip() {
        struct RevokeOnDrop<'a> {
            vault: &'a NativeDeviceProofKeyVault,
            owner: NativeDeviceProofKeyOwner,
        }
        impl Drop for RevokeOnDrop<'_> {
            fn drop(&mut self) {
                let _ = self.vault.revoke(&self.owner);
            }
        }

        let vault = NativeDeviceProofKeyVault::new();
        let owner = NativeDeviceProofKeyOwner::new(
            "io.kontourai.station.test",
            NativeProofKeyChannel::Dev,
            &Uuid::new_v4().to_string(),
            &Uuid::new_v4().to_string(),
            &Uuid::new_v4().to_string(),
        )
        .unwrap();
        let _cleanup = RevokeOnDrop {
            vault: &vault,
            owner: owner.clone(),
        };
        let created = vault.create(&owner).unwrap();
        assert_eq!(vault.restore(&owner).unwrap(), created);
        let signature = vault.sign_es256_p1363(&owner, MESSAGE).unwrap();
        assert!(verify_p1363(created.jwk(), MESSAGE, &signature));
        vault.revoke(&owner).unwrap();
        assert_eq!(
            vault.restore(&owner).unwrap_err(),
            DeviceProofKeyError::Missing
        );
    }
}

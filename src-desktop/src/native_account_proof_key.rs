//! Desktop-only custody for Station's host account proof key.
//!
//! This vault is deliberately separate from the native broker routing proof
//! key (`native_relay_proof_key`): it uses a distinct keyring service and
//! account namespace, and its records bind to a typed exact owner that also
//! names the Station ID and the approved Device ID. Private PKCS#8 bytes never
//! leave this module, never reach logs, and there is no plaintext fallback.
//! There is no Tauri IPC command here yet; signing is Rust-internal only.

use crate::native_relay_proof_key::{NativeProofKeyChannel, P256PublicJwk};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ring::rand::{SecureRandom as _, SystemRandom};
use ring::signature::{self, KeyPair as _};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::Arc;
use std::sync::Mutex;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const KEYRING_SERVICE: &str = "io.kontourai.station.account-proof";
const ACCOUNT_PREFIX: &str = "native-account-proof:v1";
const RECORD_VERSION: u8 = 1;
const MAX_PKCS8_BYTES: usize = 1024;
const MAX_PKCS8_BASE64_BYTES: usize = MAX_PKCS8_BYTES.div_ceil(3) * 4;
// Tauri's per-application single-instance guard excludes a second Station
// process for the same channel/app identifier. This process-wide lock also
// serializes independently constructed vault handles over the shared keyring
// and is distinct from the relay proof-key lock.
static ACCOUNT_PROOF_KEY_OPERATION: Mutex<()> = Mutex::new(());

pub(crate) type AccountProofResult<T> = Result<T, AccountProofKeyError>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AccountProofKeyError {
    InvalidOwner,
    Missing,
    AlreadyExists,
    Corrupt,
    Store,
    Signing,
}

/// Typed exact owner for an account proof key. Every field must match on
/// every read; a record minted for one owner is unusable by any other.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeAccountProofKeyOwner {
    app_identifier: String,
    channel: NativeProofKeyChannel,
    client_instance_id: Uuid,
    station_id: Uuid,
    approved_device_id: Uuid,
}

impl NativeAccountProofKeyOwner {
    pub(crate) fn new(
        app_identifier: &str,
        channel: NativeProofKeyChannel,
        client_instance_id: &str,
        station_id: &str,
        approved_device_id: &str,
    ) -> AccountProofResult<Self> {
        if !valid_app_identifier(app_identifier) {
            return Err(AccountProofKeyError::InvalidOwner);
        }
        let exact_uuid = |value: &str| {
            Uuid::parse_str(value)
                .ok()
                .filter(|parsed| parsed.to_string() == value)
        };
        let (Some(client_instance_id), Some(station_id), Some(approved_device_id)) = (
            exact_uuid(client_instance_id),
            exact_uuid(station_id),
            exact_uuid(approved_device_id),
        ) else {
            return Err(AccountProofKeyError::InvalidOwner);
        };
        Ok(Self {
            app_identifier: app_identifier.to_owned(),
            channel,
            client_instance_id,
            station_id,
            approved_device_id,
        })
    }

    /// The keyring account is a domain-separated digest of the full typed
    /// owner, so no owner field is a path into another record and the
    /// account/service namespace stays distinct from the relay proof key.
    fn account(&self) -> String {
        let parts = [
            self.app_identifier.as_bytes(),
            self.channel.keyring_label().as_bytes(),
            self.client_instance_id.as_bytes(),
            self.station_id.as_bytes(),
            self.approved_device_id.as_bytes(),
        ];
        let mut canonical = Vec::from(format!("{ACCOUNT_PREFIX}\0"));
        for part in parts {
            canonical.extend_from_slice(&(part.len() as u64).to_le_bytes());
            canonical.extend_from_slice(part);
        }
        format!(
            "{ACCOUNT_PREFIX}:{}",
            URL_SAFE_NO_PAD.encode(ring::digest::digest(&ring::digest::SHA256, &canonical))
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeAccountProofKeyPublicMetadata {
    jwk: P256PublicJwk,
    thumbprint: String,
}

impl NativeAccountProofKeyPublicMetadata {
    pub(crate) fn jwk(&self) -> &P256PublicJwk {
        &self.jwk
    }

    pub(crate) fn thumbprint(&self) -> &str {
        &self.thumbprint
    }
}

trait AccountSecretBackend: Send + Sync {
    fn read(&self, account: &str) -> AccountProofResult<Option<Zeroizing<String>>>;
    fn write(&self, account: &str, value: &str) -> AccountProofResult<()>;
    fn delete(&self, account: &str) -> AccountProofResult<()>;
}

struct KeyringAccountSecretBackend;

impl KeyringAccountSecretBackend {
    fn entry(account: &str) -> AccountProofResult<keyring_core::Entry> {
        super::initialize_credential_store().map_err(|_| AccountProofKeyError::Store)?;
        keyring_core::Entry::new(KEYRING_SERVICE, account).map_err(|_| AccountProofKeyError::Store)
    }
}

impl AccountSecretBackend for KeyringAccountSecretBackend {
    fn read(&self, account: &str) -> AccountProofResult<Option<Zeroizing<String>>> {
        match Self::entry(account)?.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            // A locked or unavailable keyring fails closed; there is no
            // plaintext fallback for account proof keys.
            Err(_) => Err(AccountProofKeyError::Store),
        }
    }

    fn write(&self, account: &str, value: &str) -> AccountProofResult<()> {
        Self::entry(account)?
            .set_password(value)
            .map_err(|_| AccountProofKeyError::Store)
    }

    fn delete(&self, account: &str) -> AccountProofResult<()> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(_) => Err(AccountProofKeyError::Store),
        }
    }
}

#[cfg(test)]
#[derive(Clone, Default)]
pub(crate) struct MemoryAccountSecretBackend(Arc<Mutex<HashMap<String, String>>>);

#[cfg(test)]
impl AccountSecretBackend for MemoryAccountSecretBackend {
    fn read(&self, account: &str) -> AccountProofResult<Option<Zeroizing<String>>> {
        self.0
            .lock()
            .map_err(|_| AccountProofKeyError::Store)
            .map(|values| {
                values
                    .get(account)
                    .map(|value| Zeroizing::new(value.clone()))
            })
    }

    fn write(&self, account: &str, value: &str) -> AccountProofResult<()> {
        self.0
            .lock()
            .map_err(|_| AccountProofKeyError::Store)?
            .insert(account.to_owned(), value.to_owned());
        Ok(())
    }

    fn delete(&self, account: &str) -> AccountProofResult<()> {
        self.0
            .lock()
            .map_err(|_| AccountProofKeyError::Store)?
            .remove(account);
        Ok(())
    }
}

pub(crate) struct NativeAccountProofKeyVault {
    inner: AccountProofKeyVault<KeyringAccountSecretBackend>,
}

impl Default for NativeAccountProofKeyVault {
    fn default() -> Self {
        Self::new()
    }
}

impl NativeAccountProofKeyVault {
    pub(crate) fn new() -> Self {
        Self {
            inner: AccountProofKeyVault::new(KeyringAccountSecretBackend),
        }
    }

    pub(crate) fn create(
        &self,
        owner: &NativeAccountProofKeyOwner,
    ) -> AccountProofResult<NativeAccountProofKeyPublicMetadata> {
        self.inner.create(owner)
    }

    pub(crate) fn restore(
        &self,
        owner: &NativeAccountProofKeyOwner,
    ) -> AccountProofResult<NativeAccountProofKeyPublicMetadata> {
        self.inner.restore(owner)
    }

    pub(crate) fn replace(
        &self,
        owner: &NativeAccountProofKeyOwner,
    ) -> AccountProofResult<NativeAccountProofKeyPublicMetadata> {
        self.inner.replace(owner)
    }

    pub(crate) fn revoke(&self, owner: &NativeAccountProofKeyOwner) -> AccountProofResult<()> {
        self.inner.revoke(owner)
    }

    pub(crate) fn public_jwk(
        &self,
        owner: &NativeAccountProofKeyOwner,
    ) -> AccountProofResult<P256PublicJwk> {
        Ok(self.inner.restore(owner)?.jwk)
    }

    /// ES256 signature over the exact JWS `header.payload` bytes in P1363
    /// (fixed-width r||s) form. The native account proof type is inside that
    /// signed header. Rust-internal only: no Tauri command reaches this method.
    pub(crate) fn sign_es256_p1363(
        &self,
        owner: &NativeAccountProofKeyOwner,
        message: &[u8],
    ) -> AccountProofResult<Vec<u8>> {
        self.inner.sign_es256_p1363(owner, message)
    }
}

#[cfg(test)]
pub(crate) struct MemoryNativeAccountProofKeyVault {
    inner: AccountProofKeyVault<MemoryAccountSecretBackend>,
}

#[cfg(test)]
impl Default for MemoryNativeAccountProofKeyVault {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
impl MemoryNativeAccountProofKeyVault {
    pub(crate) fn new() -> Self {
        Self {
            inner: AccountProofKeyVault::new(MemoryAccountSecretBackend::default()),
        }
    }

    pub(crate) fn create(
        &self,
        owner: &NativeAccountProofKeyOwner,
    ) -> AccountProofResult<NativeAccountProofKeyPublicMetadata> {
        self.inner.create(owner)
    }

    pub(crate) fn restore(
        &self,
        owner: &NativeAccountProofKeyOwner,
    ) -> AccountProofResult<NativeAccountProofKeyPublicMetadata> {
        self.inner.restore(owner)
    }

    pub(crate) fn replace(
        &self,
        owner: &NativeAccountProofKeyOwner,
    ) -> AccountProofResult<NativeAccountProofKeyPublicMetadata> {
        self.inner.replace(owner)
    }

    pub(crate) fn public_jwk(
        &self,
        owner: &NativeAccountProofKeyOwner,
    ) -> AccountProofResult<P256PublicJwk> {
        Ok(self.inner.restore(owner)?.jwk)
    }

    pub(crate) fn revoke(&self, owner: &NativeAccountProofKeyOwner) -> AccountProofResult<()> {
        self.inner.revoke(owner)
    }

    pub(crate) fn sign_es256_p1363(
        &self,
        owner: &NativeAccountProofKeyOwner,
        message: &[u8],
    ) -> AccountProofResult<Vec<u8>> {
        self.inner.sign_es256_p1363(owner, message)
    }

    pub(crate) fn backend(&self) -> MemoryAccountSecretBackend {
        self.inner.backend.clone()
    }
}

struct AccountProofKeyVault<B> {
    backend: B,
}

impl<B: AccountSecretBackend> AccountProofKeyVault<B> {
    fn new(backend: B) -> Self {
        Self { backend }
    }

    fn create(
        &self,
        owner: &NativeAccountProofKeyOwner,
    ) -> AccountProofResult<NativeAccountProofKeyPublicMetadata> {
        let _guard = ACCOUNT_PROOF_KEY_OPERATION
            .lock()
            .map_err(|_| AccountProofKeyError::Store)?;
        let account = owner.account();
        if self.backend.read(&account)?.is_some() {
            return Err(AccountProofKeyError::AlreadyExists);
        }
        let stored = generate_record(owner)?;
        let public = stored.public.clone();
        self.persist(&account, &stored)?;
        Ok(public)
    }

    fn restore(
        &self,
        owner: &NativeAccountProofKeyOwner,
    ) -> AccountProofResult<NativeAccountProofKeyPublicMetadata> {
        let _guard = ACCOUNT_PROOF_KEY_OPERATION
            .lock()
            .map_err(|_| AccountProofKeyError::Store)?;
        Ok(self.read_record(owner)?.public)
    }

    fn replace(
        &self,
        owner: &NativeAccountProofKeyOwner,
    ) -> AccountProofResult<NativeAccountProofKeyPublicMetadata> {
        let _guard = ACCOUNT_PROOF_KEY_OPERATION
            .lock()
            .map_err(|_| AccountProofKeyError::Store)?;
        let account = owner.account();
        if self.backend.read(&account)?.is_none() {
            return Err(AccountProofKeyError::Missing);
        }
        let stored = generate_record(owner)?;
        let public = stored.public.clone();
        self.persist(&account, &stored)?;
        Ok(public)
    }

    fn revoke(&self, owner: &NativeAccountProofKeyOwner) -> AccountProofResult<()> {
        let _guard = ACCOUNT_PROOF_KEY_OPERATION
            .lock()
            .map_err(|_| AccountProofKeyError::Store)?;
        let account = owner.account();
        if self.backend.read(&account)?.is_none() {
            return Err(AccountProofKeyError::Missing);
        }
        self.backend.delete(&account)
    }

    fn sign_es256_p1363(
        &self,
        owner: &NativeAccountProofKeyOwner,
        message: &[u8],
    ) -> AccountProofResult<Vec<u8>> {
        let _guard = ACCOUNT_PROOF_KEY_OPERATION
            .lock()
            .map_err(|_| AccountProofKeyError::Store)?;
        let stored = self.read_record(owner)?;
        let rng = SystemRandom::new();
        let key_pair = signature::EcdsaKeyPair::from_pkcs8(
            &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            stored.private_pkcs8.0.as_slice(),
            &rng,
        )
        .map_err(|_| AccountProofKeyError::Corrupt)?;
        key_pair
            .sign(&rng, message)
            .map(|signature| signature.as_ref().to_vec())
            .map_err(|_| AccountProofKeyError::Signing)
    }

    fn read_record(
        &self,
        owner: &NativeAccountProofKeyOwner,
    ) -> AccountProofResult<StoredAccountProofKey> {
        let secret = self
            .backend
            .read(&owner.account())?
            .ok_or(AccountProofKeyError::Missing)?;
        let stored: StoredAccountProofKey =
            serde_json::from_str(&secret).map_err(|_| AccountProofKeyError::Corrupt)?;
        if stored.version != RECORD_VERSION || stored.owner != *owner {
            return Err(AccountProofKeyError::Corrupt);
        }
        // Re-derive the public metadata from the private key on every read;
        // a stored record whose advertised public half disagrees with the
        // actual key is corrupt and fails closed.
        let derived = public_metadata(&stored.private_pkcs8)?;
        if derived != stored.public {
            return Err(AccountProofKeyError::Corrupt);
        }
        Ok(stored)
    }

    fn persist(&self, account: &str, stored: &StoredAccountProofKey) -> AccountProofResult<()> {
        let serialized = Zeroizing::new(
            serde_json::to_string(stored).map_err(|_| AccountProofKeyError::Corrupt)?,
        );
        self.backend.write(account, &serialized)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StoredAccountProofKey {
    version: u8,
    owner: NativeAccountProofKeyOwner,
    private_pkcs8: SecretPkcs8,
    public: NativeAccountProofKeyPublicMetadata,
}

struct SecretPkcs8(Zeroizing<Vec<u8>>);

impl Serialize for SecretPkcs8 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut encoded = URL_SAFE_NO_PAD.encode(self.0.as_slice());
        let result = serializer.serialize_str(&encoded);
        encoded.zeroize();
        result
    }
}

impl<'de> Deserialize<'de> for SecretPkcs8 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let mut encoded = String::deserialize(deserializer)?;
        if encoded.len() > MAX_PKCS8_BASE64_BYTES {
            encoded.zeroize();
            return Err(serde::de::Error::custom("PKCS#8 record is too large"));
        }
        let mut decoded = Zeroizing::new(Vec::with_capacity(MAX_PKCS8_BYTES));
        let result = URL_SAFE_NO_PAD.decode_vec(encoded.as_bytes(), &mut decoded);
        encoded.zeroize();
        result.map_err(serde::de::Error::custom)?;
        if decoded.is_empty() || decoded.len() > MAX_PKCS8_BYTES {
            return Err(serde::de::Error::custom("invalid PKCS#8 record length"));
        }
        Ok(Self(decoded))
    }
}

fn generate_record(
    owner: &NativeAccountProofKeyOwner,
) -> AccountProofResult<StoredAccountProofKey> {
    let rng = SystemRandom::new();
    let generated =
        signature::EcdsaKeyPair::generate_pkcs8(&signature::ECDSA_P256_SHA256_FIXED_SIGNING, &rng)
            .map_err(|_| AccountProofKeyError::Signing)?;
    let private_pkcs8 = SecretPkcs8(Zeroizing::new(generated.as_ref().to_vec()));
    let public = public_metadata(&private_pkcs8)?;
    Ok(StoredAccountProofKey {
        version: RECORD_VERSION,
        owner: owner.clone(),
        private_pkcs8,
        public,
    })
}

fn public_metadata(
    private_pkcs8: &SecretPkcs8,
) -> AccountProofResult<NativeAccountProofKeyPublicMetadata> {
    let rng = SystemRandom::new();
    let key_pair = signature::EcdsaKeyPair::from_pkcs8(
        &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
        private_pkcs8.0.as_slice(),
        &rng,
    )
    .map_err(|_| AccountProofKeyError::Corrupt)?;
    let public = key_pair.public_key().as_ref();
    if public.len() != 65 || public[0] != 0x04 {
        return Err(AccountProofKeyError::Corrupt);
    }
    let jwk = P256PublicJwk::from_verified_p256_coordinates(
        URL_SAFE_NO_PAD.encode(&public[1..33]),
        URL_SAFE_NO_PAD.encode(&public[33..65]),
    );
    let canonical = format!(
        "{{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"{}\",\"y\":\"{}\"}}",
        jwk.x(),
        jwk.y()
    );
    let thumbprint = URL_SAFE_NO_PAD.encode(ring::digest::digest(
        &ring::digest::SHA256,
        canonical.as_bytes(),
    ));
    Ok(NativeAccountProofKeyPublicMetadata { jwk, thumbprint })
}

fn valid_app_identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && value.len() <= 255
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::UnparsedPublicKey;

    const APP: &str = "io.kontourai.station";
    const CLIENT: &str = "33333333-3333-4333-8333-333333333333";
    const STATION: &str = "11111111-1111-4111-8111-111111111111";
    const DEVICE: &str = "44444444-4444-4444-8444-444444444444";
    // The SDK signs the exact compact-JWS `header.payload` bytes.
    const MESSAGE: &[u8] = b"native-account-header.native-account-payload";

    fn owner() -> NativeAccountProofKeyOwner {
        NativeAccountProofKeyOwner::new(APP, NativeProofKeyChannel::Stable, CLIENT, STATION, DEVICE)
            .unwrap()
    }

    fn owner_with_device(device: &str) -> NativeAccountProofKeyOwner {
        NativeAccountProofKeyOwner::new(APP, NativeProofKeyChannel::Stable, CLIENT, STATION, device)
            .unwrap()
    }

    fn verify_p1363(jwk: &P256PublicJwk, message: &[u8], signature: &[u8]) -> bool {
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
    fn create_returns_derived_public_metadata_and_restores() {
        let vault = MemoryNativeAccountProofKeyVault::new();
        let owner = owner();
        let created = vault.create(&owner).unwrap();
        assert_eq!(created.jwk().kty(), "EC");
        assert_eq!(created.jwk().crv(), "P-256");
        assert_eq!(created.thumbprint().len(), 43);

        // Reopening the same owner restores the identical key.
        let restored = vault.restore(&owner).unwrap();
        assert_eq!(created, restored);
        let jwk = vault.public_jwk(&owner).unwrap();
        assert_eq!(&jwk, created.jwk());
    }

    #[test]
    fn create_twice_for_same_owner_fails_closed() {
        let vault = MemoryNativeAccountProofKeyVault::new();
        let owner = owner();
        vault.create(&owner).unwrap();
        assert_eq!(
            vault.create(&owner).unwrap_err(),
            AccountProofKeyError::AlreadyExists
        );
    }

    #[test]
    fn record_is_bound_to_the_exact_typed_owner() {
        let vault = MemoryNativeAccountProofKeyVault::new();
        vault.create(&owner()).unwrap();
        // Different approved Device ID: different account namespace...
        let other_device = owner_with_device("55555555-5555-4555-8555-555555555555");
        assert_eq!(
            vault.restore(&other_device).unwrap_err(),
            AccountProofKeyError::Missing
        );
        // ...and the original owner's keyring record must not accept it either
        // if the account ever collided (owner equality is enforced on read).
        assert_ne!(owner().account(), other_device.account());

        // Same identity fields but a different channel is a different owner.
        let beta = NativeAccountProofKeyOwner::new(
            APP,
            NativeProofKeyChannel::Beta,
            CLIENT,
            STATION,
            DEVICE,
        )
        .unwrap();
        assert_eq!(
            vault.restore(&beta).unwrap_err(),
            AccountProofKeyError::Missing
        );
    }

    #[test]
    fn invalid_owner_fields_are_rejected() {
        assert_eq!(
            NativeAccountProofKeyOwner::new(
                "bad app",
                NativeProofKeyChannel::Stable,
                CLIENT,
                STATION,
                DEVICE
            )
            .unwrap_err(),
            AccountProofKeyError::InvalidOwner
        );
        assert_eq!(
            NativeAccountProofKeyOwner::new(
                APP,
                NativeProofKeyChannel::Stable,
                "not-a-uuid",
                STATION,
                DEVICE
            )
            .unwrap_err(),
            AccountProofKeyError::InvalidOwner
        );
        // Non-canonical UUID case (canonical form is lowercase).
        assert_eq!(
            NativeAccountProofKeyOwner::new(
                APP,
                NativeProofKeyChannel::Stable,
                "AAAAAAAA-BBBB-4BBB-8BBB-CCCCCCCCCCCC",
                STATION,
                DEVICE
            )
            .unwrap_err(),
            AccountProofKeyError::InvalidOwner
        );
    }

    #[test]
    fn corrupted_record_fails_closed_on_every_read() {
        let vault = MemoryNativeAccountProofKeyVault::new();
        let owner = owner();
        let created = vault.create(&owner).unwrap();
        let backend = vault.backend();
        let account = owner.account();

        // Truncated JSON.
        *backend.0.lock().unwrap().get_mut(&account).unwrap() =
            "{\"version\":1,\"owner\":".to_owned();
        assert_eq!(
            vault.restore(&owner).unwrap_err(),
            AccountProofKeyError::Corrupt
        );

        // Valid JSON but an unsupported record version.
        *backend.0.lock().unwrap().get_mut(&account).unwrap() = format!(
            r#"{{"version":99,"owner":{},"privatePkcs8":"AA","public":{{"jwk":{{"kty":"EC","crv":"P-256","x":"a","y":"a"}},"thumbprint":"t"}}}}"#,
            serde_json::to_string(&owner).unwrap()
        );
        assert_eq!(
            vault.restore(&owner).unwrap_err(),
            AccountProofKeyError::Corrupt
        );

        // Advertised public half that disagrees with the actual private key.
        let tampered = StoredAccountProofKey {
            version: RECORD_VERSION,
            owner: owner.clone(),
            private_pkcs8: {
                let generated = signature::EcdsaKeyPair::generate_pkcs8(
                    &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
                    &SystemRandom::new(),
                )
                .unwrap();
                SecretPkcs8(Zeroizing::new(generated.as_ref().to_vec()))
            },
            public: NativeAccountProofKeyPublicMetadata {
                jwk: created.jwk().clone(),
                thumbprint: created.thumbprint().to_owned(),
            },
        };
        *backend.0.lock().unwrap().get_mut(&account).unwrap() =
            serde_json::to_string(&tampered).unwrap();
        assert_eq!(
            vault.restore(&owner).unwrap_err(),
            AccountProofKeyError::Corrupt
        );
        // Signing also refuses the corrupted record.
        assert_eq!(
            vault.sign_es256_p1363(&owner, MESSAGE).unwrap_err(),
            AccountProofKeyError::Corrupt
        );
    }

    #[test]
    fn unavailable_backend_fails_closed() {
        struct LockedBackend;
        impl AccountSecretBackend for LockedBackend {
            fn read(&self, _: &str) -> AccountProofResult<Option<Zeroizing<String>>> {
                Err(AccountProofKeyError::Store)
            }
            fn write(&self, _: &str, _: &str) -> AccountProofResult<()> {
                Err(AccountProofKeyError::Store)
            }
            fn delete(&self, _: &str) -> AccountProofResult<()> {
                Err(AccountProofKeyError::Store)
            }
        }
        let vault = AccountProofKeyVault::new(LockedBackend);
        let owner = owner();
        assert_eq!(
            vault.create(&owner).unwrap_err(),
            AccountProofKeyError::Store
        );
        assert_eq!(
            vault.restore(&owner).unwrap_err(),
            AccountProofKeyError::Store
        );
        assert_eq!(
            vault.sign_es256_p1363(&owner, MESSAGE).unwrap_err(),
            AccountProofKeyError::Store
        );
    }

    #[test]
    fn signature_verifies_against_public_jwk_and_rejects_tampering() {
        let vault = MemoryNativeAccountProofKeyVault::new();
        let owner = owner();
        let created = vault.create(&owner).unwrap();
        let signature = vault.sign_es256_p1363(&owner, MESSAGE).unwrap();
        assert_eq!(signature.len(), 64);
        assert!(verify_p1363(created.jwk(), MESSAGE, &signature));
        // A different message must not verify.
        assert!(!verify_p1363(created.jwk(), b"other message", &signature));

        // A different owner's key cannot verify this signature.
        let other = vault
            .create(&owner_with_device("55555555-5555-4555-8555-555555555555"))
            .unwrap();
        assert!(!verify_p1363(other.jwk(), MESSAGE, &signature));
    }

    #[test]
    fn replace_rotates_the_key_and_old_signatures_stop_verifying() {
        let vault = MemoryNativeAccountProofKeyVault::new();
        let owner = owner();
        let first = vault.create(&owner).unwrap();
        let old_signature = vault.sign_es256_p1363(&owner, MESSAGE).unwrap();
        let second = vault.replace(&owner).unwrap();
        assert_ne!(first.thumbprint(), second.thumbprint());
        assert!(!verify_p1363(second.jwk(), MESSAGE, &old_signature));
        let new_signature = vault.sign_es256_p1363(&owner, MESSAGE).unwrap();
        assert!(verify_p1363(second.jwk(), MESSAGE, &new_signature));
        // Replace requires an existing record.
        assert_eq!(
            vault
                .replace(&owner_with_device("55555555-5555-4555-8555-555555555555"))
                .unwrap_err(),
            AccountProofKeyError::Missing
        );
    }

    #[test]
    fn revoke_removes_the_key_and_subsequent_uses_fail() {
        let vault = MemoryNativeAccountProofKeyVault::new();
        let owner = owner();
        vault.create(&owner).unwrap();
        vault.revoke(&owner).unwrap();
        assert_eq!(
            vault.restore(&owner).unwrap_err(),
            AccountProofKeyError::Missing
        );
        assert_eq!(
            vault.sign_es256_p1363(&owner, MESSAGE).unwrap_err(),
            AccountProofKeyError::Missing
        );
        // Revoking an absent record does not silently succeed as a delete of
        // someone else's data: it reports Missing.
        assert_eq!(
            vault.revoke(&owner).unwrap_err(),
            AccountProofKeyError::Missing
        );
    }

    #[test]
    fn account_namespace_is_distinct_from_the_relay_proof_key() {
        let owner = owner();
        let account = owner.account();
        assert!(account.starts_with("native-account-proof:v1:"));
        // Same owner fields as the relay vault would hash differently, and the
        // service string is separate, so keyring entries cannot collide.
        assert!(!account.starts_with("native-proof:"));
        assert_eq!(KEYRING_SERVICE, "io.kontourai.station.account-proof");
        assert_ne!(KEYRING_SERVICE, "io.kontourai.station.relay-proof");
        // Owner digests are stable and injective enough that distinct owners
        // never share an account string.
        let other = owner_with_device("55555555-5555-4555-8555-555555555555");
        assert_ne!(account, other.account());
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "writes one random account to the current macOS Keychain"]
    fn macos_keychain_roundtrip() {
        struct RevokeOnDrop<'a> {
            vault: &'a NativeAccountProofKeyVault,
            owner: NativeAccountProofKeyOwner,
        }
        impl Drop for RevokeOnDrop<'_> {
            fn drop(&mut self) {
                let _ = self.vault.revoke(&self.owner);
            }
        }

        let vault = NativeAccountProofKeyVault::new();
        let owner = NativeAccountProofKeyOwner::new(
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
            AccountProofKeyError::Missing
        );
    }
}

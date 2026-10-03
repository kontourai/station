//! Shared private core for the native proof-key vaults.
//!
//! The account vault (`native_account_proof_key`) and the Device proof key
//! vault (`native_device_proof_key`) reuse this module so the custody rules —
//! versioned owner-bound records, fail-closed reads, serialized operations,
//! P-256 ES256 P1363 signing — exist exactly once. Everything here is
//! `pub(crate)`: private key bytes never leave the desktop crate, and no
//! renderer-callable signer or secret accessor is exposed.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ring::rand::SystemRandom;
use ring::signature::{self, KeyPair as _};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::Arc;
use std::sync::Mutex;
use zeroize::{Zeroize, Zeroizing};

use crate::native_relay_proof_key::P256PublicJwk;

pub(crate) const RECORD_VERSION: u8 = 1;
const MAX_PKCS8_BYTES: usize = 1024;
const MAX_PKCS8_BASE64_BYTES: usize = MAX_PKCS8_BYTES.div_ceil(3) * 4;
// Tauri's per-application single-instance guard excludes a second Station
// process for the same channel/app identifier. This process-wide lock
// serializes independently constructed vault handles over the shared keyring
// and is shared by every proof-key vault so custody operations never interleave.
static PROOF_KEY_OPERATION: Mutex<()> = Mutex::new(());

pub(crate) type ProofKeyResult<T> = Result<T, ProofKeyError>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProofKeyError {
    InvalidOwner,
    Missing,
    AlreadyExists,
    Corrupt,
    Store,
    Signing,
}

/// Typed exact owner for a proof key. Every field must match on every read; a
/// record minted for one owner is unusable by any other. The keyring account
/// is a domain-separated digest of the full typed owner plus the vault's own
/// record prefix, so no owner field is a path into another record and the
/// namespaces of distinct vaults cannot collide.
pub(crate) trait ProofKeyOwner:
    Clone + DeserializeOwned + Eq + PartialEq + Serialize
{
    fn account(&self) -> String;
}

pub(crate) fn proof_key_account(record_prefix: &str, parts: &[&[u8]]) -> String {
    let mut canonical = Vec::from(format!("{record_prefix}\0"));
    for part in parts {
        canonical.extend_from_slice(&(part.len() as u64).to_le_bytes());
        canonical.extend_from_slice(part);
    }
    format!(
        "{record_prefix}:{}",
        URL_SAFE_NO_PAD.encode(ring::digest::digest(&ring::digest::SHA256, &canonical))
    )
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ProofKeyPublicMetadata {
    pub(crate) jwk: P256PublicJwk,
    pub(crate) thumbprint: String,
}

impl ProofKeyPublicMetadata {
    pub(crate) fn jwk(&self) -> &P256PublicJwk {
        &self.jwk
    }

    pub(crate) fn thumbprint(&self) -> &str {
        &self.thumbprint
    }
}

pub(crate) trait ProofKeySecretBackend: Send + Sync {
    fn read(&self, account: &str) -> ProofKeyResult<Option<Zeroizing<String>>>;
    fn write(&self, account: &str, value: &str) -> ProofKeyResult<()>;
    fn delete(&self, account: &str) -> ProofKeyResult<()>;
}

pub(crate) struct KeyringSecretBackend(&'static str);

impl KeyringSecretBackend {
    pub(crate) fn new(service: &'static str) -> Self {
        Self(service)
    }

    fn entry(
        &self,
        account: &str,
    ) -> ProofKeyResult<crate::native_secure_entry::NativeSecureEntry> {
        super::initialize_credential_store().map_err(|_| ProofKeyError::Store)?;
        crate::native_secure_entry::NativeSecureEntry::new(self.0, account)
            .map_err(|_| ProofKeyError::Store)
    }
}

impl ProofKeySecretBackend for KeyringSecretBackend {
    fn read(&self, account: &str) -> ProofKeyResult<Option<Zeroizing<String>>> {
        match self.entry(account)?.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            // A locked or unavailable keyring fails closed; there is no
            // plaintext fallback for proof keys.
            Err(_) => Err(ProofKeyError::Store),
        }
    }

    fn write(&self, account: &str, value: &str) -> ProofKeyResult<()> {
        self.entry(account)?
            .set_password(value)
            .map_err(|_| ProofKeyError::Store)
    }

    fn delete(&self, account: &str) -> ProofKeyResult<()> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(_) => Err(ProofKeyError::Store),
        }
    }
}

#[cfg(test)]
#[derive(Clone, Default)]
pub(crate) struct MemorySecretBackend(Arc<Mutex<HashMap<String, String>>>);

#[cfg(test)]
impl MemorySecretBackend {
    pub(crate) fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.0.lock().unwrap()
    }
}

#[cfg(test)]
impl ProofKeySecretBackend for MemorySecretBackend {
    fn read(&self, account: &str) -> ProofKeyResult<Option<Zeroizing<String>>> {
        self.0
            .lock()
            .map_err(|_| ProofKeyError::Store)
            .map(|values| {
                values
                    .get(account)
                    .map(|value| Zeroizing::new(value.clone()))
            })
    }

    fn write(&self, account: &str, value: &str) -> ProofKeyResult<()> {
        self.0
            .lock()
            .map_err(|_| ProofKeyError::Store)?
            .insert(account.to_owned(), value.to_owned());
        Ok(())
    }

    fn delete(&self, account: &str) -> ProofKeyResult<()> {
        self.0
            .lock()
            .map_err(|_| ProofKeyError::Store)?
            .remove(account);
        Ok(())
    }
}

pub(crate) struct ProofKeyVaultCore<B> {
    pub(crate) backend: B,
}

impl<B: ProofKeySecretBackend> ProofKeyVaultCore<B> {
    pub(crate) fn new(backend: B) -> Self {
        Self { backend }
    }

    pub(crate) fn create<O: ProofKeyOwner>(
        &self,
        owner: &O,
    ) -> ProofKeyResult<ProofKeyPublicMetadata> {
        let _guard = PROOF_KEY_OPERATION
            .lock()
            .map_err(|_| ProofKeyError::Store)?;
        let account = owner.account();
        if self.backend.read(&account)?.is_some() {
            return Err(ProofKeyError::AlreadyExists);
        }
        let stored = generate_record(owner)?;
        let public = stored.public.clone();
        self.persist(&account, &stored)?;
        Ok(public)
    }

    pub(crate) fn restore<O: ProofKeyOwner>(
        &self,
        owner: &O,
    ) -> ProofKeyResult<ProofKeyPublicMetadata> {
        let _guard = PROOF_KEY_OPERATION
            .lock()
            .map_err(|_| ProofKeyError::Store)?;
        Ok(self.read_record(owner)?.public)
    }

    pub(crate) fn replace<O: ProofKeyOwner>(
        &self,
        owner: &O,
    ) -> ProofKeyResult<ProofKeyPublicMetadata> {
        let _guard = PROOF_KEY_OPERATION
            .lock()
            .map_err(|_| ProofKeyError::Store)?;
        let account = owner.account();
        if self.backend.read(&account)?.is_none() {
            return Err(ProofKeyError::Missing);
        }
        let stored = generate_record(owner)?;
        let public = stored.public.clone();
        self.persist(&account, &stored)?;
        Ok(public)
    }

    pub(crate) fn revoke<O: ProofKeyOwner>(&self, owner: &O) -> ProofKeyResult<()> {
        let _guard = PROOF_KEY_OPERATION
            .lock()
            .map_err(|_| ProofKeyError::Store)?;
        let account = owner.account();
        if self.backend.read(&account)?.is_none() {
            return Err(ProofKeyError::Missing);
        }
        self.backend.delete(&account)
    }

    /// ES256 signature over the exact message bytes in P1363 (fixed-width
    /// r||s) form. Callers sign the exact compact-JWS `header.payload` bytes.
    /// Rust-internal only; protocol owners construct signing input before IPC
    /// results can return a bounded proof. Raw signing input is never an IPC API.
    pub(crate) fn sign_es256_p1363<O: ProofKeyOwner>(
        &self,
        owner: &O,
        message: &[u8],
    ) -> ProofKeyResult<Vec<u8>> {
        let _guard = PROOF_KEY_OPERATION
            .lock()
            .map_err(|_| ProofKeyError::Store)?;
        let stored = self.read_record(owner)?;
        let rng = SystemRandom::new();
        let key_pair = signature::EcdsaKeyPair::from_pkcs8(
            &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            stored.private_pkcs8.0.as_slice(),
            &rng,
        )
        .map_err(|_| ProofKeyError::Corrupt)?;
        key_pair
            .sign(&rng, message)
            .map(|signature| signature.as_ref().to_vec())
            .map_err(|_| ProofKeyError::Signing)
    }

    fn read_record<O: ProofKeyOwner>(&self, owner: &O) -> ProofKeyResult<StoredProofKey<O>> {
        let secret = self
            .backend
            .read(&owner.account())?
            .ok_or(ProofKeyError::Missing)?;
        let stored: StoredProofKey<O> =
            serde_json::from_str(&secret).map_err(|_| ProofKeyError::Corrupt)?;
        if stored.version != RECORD_VERSION || stored.owner != *owner {
            return Err(ProofKeyError::Corrupt);
        }
        // Re-derive the public metadata from the private key on every read;
        // a stored record whose advertised public half disagrees with the
        // actual key is corrupt and fails closed.
        let derived = public_metadata(&stored.private_pkcs8)?;
        if derived != stored.public {
            return Err(ProofKeyError::Corrupt);
        }
        Ok(stored)
    }

    fn persist<O: ProofKeyOwner>(
        &self,
        account: &str,
        stored: &StoredProofKey<O>,
    ) -> ProofKeyResult<()> {
        let serialized =
            Zeroizing::new(serde_json::to_string(stored).map_err(|_| ProofKeyError::Corrupt)?);
        self.backend.write(account, &serialized)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct StoredProofKey<O> {
    pub(crate) version: u8,
    pub(crate) owner: O,
    pub(crate) private_pkcs8: SecretPkcs8,
    pub(crate) public: ProofKeyPublicMetadata,
}

pub(crate) struct SecretPkcs8(pub(crate) Zeroizing<Vec<u8>>);

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

pub(crate) fn generate_record<O: ProofKeyOwner>(owner: &O) -> ProofKeyResult<StoredProofKey<O>> {
    let rng = SystemRandom::new();
    let generated =
        signature::EcdsaKeyPair::generate_pkcs8(&signature::ECDSA_P256_SHA256_FIXED_SIGNING, &rng)
            .map_err(|_| ProofKeyError::Signing)?;
    let private_pkcs8 = SecretPkcs8(Zeroizing::new(generated.as_ref().to_vec()));
    let public = public_metadata(&private_pkcs8)?;
    Ok(StoredProofKey {
        version: RECORD_VERSION,
        owner: owner.clone(),
        private_pkcs8,
        public,
    })
}

pub(crate) fn public_metadata(
    private_pkcs8: &SecretPkcs8,
) -> ProofKeyResult<ProofKeyPublicMetadata> {
    let rng = SystemRandom::new();
    let key_pair = signature::EcdsaKeyPair::from_pkcs8(
        &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
        private_pkcs8.0.as_slice(),
        &rng,
    )
    .map_err(|_| ProofKeyError::Corrupt)?;
    let public = key_pair.public_key().as_ref();
    if public.len() != 65 || public[0] != 0x04 {
        return Err(ProofKeyError::Corrupt);
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
    Ok(ProofKeyPublicMetadata { jwk, thumbprint })
}

pub(crate) fn valid_app_identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && value.len() <= 255
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
}

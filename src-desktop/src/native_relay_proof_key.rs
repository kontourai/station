//! Desktop-only custody for Station's native broker-redemption proof key.
//!
//! This is deliberately not connected to Tauri commands or application
//! traffic. Signing accepts only closed typed v2 redemption/request JWS
//! challenges, and private PKCS#8 bytes stay in the OS keyring.

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

const KEYRING_SERVICE: &str = "io.kontourai.station.relay-proof";
const RECORD_VERSION: u8 = 1;
const NATIVE_REDEMPTION_TYP: &str = "station-broker-native-redemption+jws";
const MAX_PKCS8_BYTES: usize = 1024;
const MAX_PKCS8_BASE64_BYTES: usize = MAX_PKCS8_BYTES.div_ceil(3) * 4;
// Tauri's per-application single-instance guard excludes a second Station
// process for the same channel/app identifier. This process-wide lock also
// serializes independently constructed vault handles over the shared keyring.
static NATIVE_PROOF_KEY_OPERATION: Mutex<()> = Mutex::new(());

pub(crate) type ProofResult<T> = Result<T, ProofKeyError>;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum NativeProofKeyChannel {
    Stable,
    Beta,
    Nightly,
    Dev,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeProofKeyOwner {
    app_identifier: String,
    channel: NativeProofKeyChannel,
    client_instance_id: Uuid,
}

impl NativeProofKeyOwner {
    pub(crate) fn new(
        app_identifier: &str,
        channel: NativeProofKeyChannel,
        client_instance_id: &str,
    ) -> ProofResult<Self> {
        if !valid_app_identifier(app_identifier) {
            return Err(ProofKeyError::InvalidOwner);
        }
        let parsed =
            Uuid::parse_str(client_instance_id).map_err(|_| ProofKeyError::InvalidOwner)?;
        if parsed.to_string() != client_instance_id {
            return Err(ProofKeyError::InvalidOwner);
        }
        Ok(Self {
            app_identifier: app_identifier.to_owned(),
            channel,
            client_instance_id: parsed,
        })
    }

    fn account(&self) -> String {
        let app_identifier = URL_SAFE_NO_PAD.encode(ring::digest::digest(
            &ring::digest::SHA256,
            self.app_identifier.as_bytes(),
        ));
        format!(
            "native-proof:v1:{}:{}:{}",
            self.channel.keyring_label(),
            app_identifier,
            self.client_instance_id
        )
    }

    pub(crate) fn app_identifier(&self) -> &str {
        &self.app_identifier
    }

    pub(crate) fn channel_label(&self) -> &'static str {
        self.channel.keyring_label()
    }

    pub(crate) fn client_instance_id(&self) -> String {
        self.client_instance_id.to_string()
    }
}

impl NativeProofKeyChannel {
    pub(crate) fn keyring_label(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
            Self::Nightly => "nightly",
            Self::Dev => "dev",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct P256PublicJwk {
    kty: String,
    crv: String,
    x: String,
    y: String,
}

impl P256PublicJwk {
    pub(crate) fn kty(&self) -> &str {
        &self.kty
    }

    pub(crate) fn crv(&self) -> &str {
        &self.crv
    }

    pub(crate) fn x(&self) -> &str {
        &self.x
    }

    pub(crate) fn y(&self) -> &str {
        &self.y
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeProofKeyPublicMetadata {
    jwk: P256PublicJwk,
    thumbprint: String,
}

impl NativeProofKeyPublicMetadata {
    pub(crate) fn jwk(&self) -> &P256PublicJwk {
        &self.jwk
    }

    pub(crate) fn thumbprint(&self) -> &str {
        &self.thumbprint
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProofKeyError {
    InvalidOwner,
    Missing,
    AlreadyExists,
    Corrupt,
    Store,
    Signing,
    InvalidChallenge,
}

trait SecretBackend: Send + Sync {
    fn read(&self, account: &str) -> ProofResult<Option<Zeroizing<String>>>;
    fn write(&self, account: &str, value: &str) -> ProofResult<()>;
    fn delete(&self, account: &str) -> ProofResult<()>;
}

struct KeyringSecretBackend;

impl KeyringSecretBackend {
    fn entry(account: &str) -> ProofResult<keyring_core::Entry> {
        super::initialize_credential_store().map_err(|_| ProofKeyError::Store)?;
        keyring_core::Entry::new(KEYRING_SERVICE, account).map_err(|_| ProofKeyError::Store)
    }
}

impl SecretBackend for KeyringSecretBackend {
    fn read(&self, account: &str) -> ProofResult<Option<Zeroizing<String>>> {
        match Self::entry(account)?.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(_) => Err(ProofKeyError::Store),
        }
    }

    fn write(&self, account: &str, value: &str) -> ProofResult<()> {
        Self::entry(account)?
            .set_password(value)
            .map_err(|_| ProofKeyError::Store)
    }

    fn delete(&self, account: &str) -> ProofResult<()> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(_) => Err(ProofKeyError::Store),
        }
    }
}

#[cfg(test)]
#[derive(Clone, Default)]
struct MemorySecretBackend(Arc<Mutex<HashMap<String, String>>>);

#[cfg(test)]
impl SecretBackend for MemorySecretBackend {
    fn read(&self, account: &str) -> ProofResult<Option<Zeroizing<String>>> {
        self.0
            .lock()
            .map_err(|_| ProofKeyError::Store)
            .map(|values| {
                values
                    .get(account)
                    .map(|value| Zeroizing::new(value.clone()))
            })
    }

    fn write(&self, account: &str, value: &str) -> ProofResult<()> {
        self.0
            .lock()
            .map_err(|_| ProofKeyError::Store)?
            .insert(account.to_owned(), value.to_owned());
        Ok(())
    }

    fn delete(&self, account: &str) -> ProofResult<()> {
        self.0
            .lock()
            .map_err(|_| ProofKeyError::Store)?
            .remove(account);
        Ok(())
    }
}

pub(crate) struct NativeRelayProofKeyVault {
    inner: ProofKeyVault<KeyringSecretBackend>,
}

impl NativeRelayProofKeyVault {
    pub(crate) fn new() -> Self {
        Self {
            inner: ProofKeyVault::new(KeyringSecretBackend),
        }
    }

    pub(crate) fn create(
        &self,
        owner: &NativeProofKeyOwner,
    ) -> ProofResult<NativeProofKeyPublicMetadata> {
        self.inner.create(owner)
    }

    pub(crate) fn restore(
        &self,
        owner: &NativeProofKeyOwner,
    ) -> ProofResult<NativeProofKeyPublicMetadata> {
        self.inner.restore(owner)
    }

    pub(crate) fn replace(
        &self,
        owner: &NativeProofKeyOwner,
    ) -> ProofResult<NativeProofKeyPublicMetadata> {
        self.inner.replace(owner)
    }

    pub(crate) fn revoke(&self, owner: &NativeProofKeyOwner) -> ProofResult<()> {
        self.inner.revoke(owner)
    }

    pub(crate) fn sign_es256_p1363(
        &self,
        owner: &NativeProofKeyOwner,
        challenge: &NativeBrokerRedemptionChallenge,
    ) -> ProofResult<Vec<u8>> {
        self.inner.sign_es256_p1363(owner, challenge)
    }

    pub(crate) fn sign_native_request_es256_p1363(
        &self,
        owner: &NativeProofKeyOwner,
        challenge: &NativeBrokerRequestProofChallenge,
    ) -> ProofResult<Vec<u8>> {
        self.inner.sign_native_request_es256_p1363(owner, challenge)
    }
}

#[cfg(test)]
pub(crate) struct MemoryNativeRelayProofKeyVault {
    inner: ProofKeyVault<MemorySecretBackend>,
}

#[cfg(test)]
impl MemoryNativeRelayProofKeyVault {
    pub(crate) fn new() -> Self {
        Self {
            inner: ProofKeyVault::new(MemorySecretBackend::default()),
        }
    }

    pub(crate) fn create(
        &self,
        owner: &NativeProofKeyOwner,
    ) -> ProofResult<NativeProofKeyPublicMetadata> {
        self.inner.create(owner)
    }

    pub(crate) fn restore(
        &self,
        owner: &NativeProofKeyOwner,
    ) -> ProofResult<NativeProofKeyPublicMetadata> {
        self.inner.restore(owner)
    }

    pub(crate) fn sign_es256_p1363(
        &self,
        owner: &NativeProofKeyOwner,
        challenge: &NativeBrokerRedemptionChallenge,
    ) -> ProofResult<Vec<u8>> {
        self.inner.sign_es256_p1363(owner, challenge)
    }

    pub(crate) fn sign_native_request_es256_p1363(
        &self,
        owner: &NativeProofKeyOwner,
        challenge: &NativeBrokerRequestProofChallenge,
    ) -> ProofResult<Vec<u8>> {
        self.inner.sign_native_request_es256_p1363(owner, challenge)
    }
}

struct ProofKeyVault<B> {
    backend: B,
}

impl<B: SecretBackend> ProofKeyVault<B> {
    fn new(backend: B) -> Self {
        Self { backend }
    }

    fn create(&self, owner: &NativeProofKeyOwner) -> ProofResult<NativeProofKeyPublicMetadata> {
        let _guard = NATIVE_PROOF_KEY_OPERATION
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

    fn restore(&self, owner: &NativeProofKeyOwner) -> ProofResult<NativeProofKeyPublicMetadata> {
        let _guard = NATIVE_PROOF_KEY_OPERATION
            .lock()
            .map_err(|_| ProofKeyError::Store)?;
        let stored = self.read_record(owner)?;
        Ok(stored.public)
    }

    fn replace(&self, owner: &NativeProofKeyOwner) -> ProofResult<NativeProofKeyPublicMetadata> {
        let _guard = NATIVE_PROOF_KEY_OPERATION
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

    fn revoke(&self, owner: &NativeProofKeyOwner) -> ProofResult<()> {
        let _guard = NATIVE_PROOF_KEY_OPERATION
            .lock()
            .map_err(|_| ProofKeyError::Store)?;
        let account = owner.account();
        if self.backend.read(&account)?.is_none() {
            return Err(ProofKeyError::Missing);
        }
        self.backend.delete(&account)
    }

    fn sign_es256_p1363(
        &self,
        owner: &NativeProofKeyOwner,
        challenge: &NativeBrokerRedemptionChallenge,
    ) -> ProofResult<Vec<u8>> {
        let _guard = NATIVE_PROOF_KEY_OPERATION
            .lock()
            .map_err(|_| ProofKeyError::Store)?;
        let stored = self.read_record(owner)?;
        if challenge.key_thumbprint != stored.public.thumbprint {
            return Err(ProofKeyError::InvalidChallenge);
        }
        let rng = SystemRandom::new();
        let key_pair = signature::EcdsaKeyPair::from_pkcs8(
            &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            stored.private_pkcs8.0.as_slice(),
            &rng,
        )
        .map_err(|_| ProofKeyError::Corrupt)?;
        key_pair
            .sign(&rng, challenge.signing_input.as_bytes())
            .map(|signature| signature.as_ref().to_vec())
            .map_err(|_| ProofKeyError::Signing)
    }

    fn sign_native_request_es256_p1363(
        &self,
        owner: &NativeProofKeyOwner,
        challenge: &NativeBrokerRequestProofChallenge,
    ) -> ProofResult<Vec<u8>> {
        let _guard = NATIVE_PROOF_KEY_OPERATION
            .lock()
            .map_err(|_| ProofKeyError::Store)?;
        let stored = self.read_record(owner)?;
        if challenge.key_thumbprint != stored.public.thumbprint {
            return Err(ProofKeyError::InvalidChallenge);
        }
        let rng = SystemRandom::new();
        let key_pair = signature::EcdsaKeyPair::from_pkcs8(
            &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            stored.private_pkcs8.0.as_slice(),
            &rng,
        )
        .map_err(|_| ProofKeyError::Corrupt)?;
        key_pair
            .sign(&rng, challenge.signing_input.as_bytes())
            .map(|signature| signature.as_ref().to_vec())
            .map_err(|_| ProofKeyError::Signing)
    }

    fn read_record(&self, owner: &NativeProofKeyOwner) -> ProofResult<StoredProofKey> {
        let secret = self
            .backend
            .read(&owner.account())?
            .ok_or(ProofKeyError::Missing)?;
        let stored: StoredProofKey =
            serde_json::from_str(&secret).map_err(|_| ProofKeyError::Corrupt)?;
        if stored.version != RECORD_VERSION || stored.owner != *owner {
            return Err(ProofKeyError::Corrupt);
        }
        let derived = public_metadata(&stored.private_pkcs8)?;
        if derived != stored.public {
            return Err(ProofKeyError::Corrupt);
        }
        Ok(stored)
    }

    fn persist(&self, account: &str, stored: &StoredProofKey) -> ProofResult<()> {
        let serialized =
            Zeroizing::new(serde_json::to_string(stored).map_err(|_| ProofKeyError::Corrupt)?);
        self.backend.write(account, &serialized)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StoredProofKey {
    version: u8,
    owner: NativeProofKeyOwner,
    private_pkcs8: SecretPkcs8,
    public: NativeProofKeyPublicMetadata,
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

fn generate_record(owner: &NativeProofKeyOwner) -> ProofResult<StoredProofKey> {
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

fn public_metadata(private_pkcs8: &SecretPkcs8) -> ProofResult<NativeProofKeyPublicMetadata> {
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
    let jwk = P256PublicJwk {
        kty: "EC".to_owned(),
        crv: "P-256".to_owned(),
        x: URL_SAFE_NO_PAD.encode(&public[1..33]),
        y: URL_SAFE_NO_PAD.encode(&public[33..65]),
    };
    let canonical = format!(
        "{{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"{}\",\"y\":\"{}\"}}",
        jwk.x, jwk.y
    );
    let thumbprint = URL_SAFE_NO_PAD.encode(ring::digest::digest(
        &ring::digest::SHA256,
        canonical.as_bytes(),
    ));
    Ok(NativeProofKeyPublicMetadata { jwk, thumbprint })
}

/// Typed fields used to create the v2 redemption proof. The invitation secret
/// is held in zeroizing memory and represented in the signed payload only by
/// its domain-separated digest.
pub(crate) struct NativeBrokerRedemptionInvitation {
    pub(crate) broker_origin: String,
    pub(crate) station_id: String,
    pub(crate) enrollment_id: String,
    pub(crate) routing_generation: u64,
    pub(crate) station_signing_key_id: String,
    pub(crate) station_signing_generation: u64,
    pub(crate) app_identifier: String,
    pub(crate) invitation_id: String,
    pub(crate) invitation_secret: Zeroizing<String>,
    pub(crate) expires_at: u64,
}

/// A constructed v2 broker-redemption JWS signing input. There is no
/// renderer-facing or arbitrary-byte constructor.
pub(crate) struct NativeBrokerRedemptionChallenge {
    signing_input: String,
    key_thumbprint: String,
    nonce: String,
}

impl NativeBrokerRedemptionChallenge {
    pub(crate) fn from_invitation(
        owner: &NativeProofKeyOwner,
        public_key: &NativeProofKeyPublicMetadata,
        invitation: NativeBrokerRedemptionInvitation,
    ) -> ProofResult<Self> {
        let rng = SystemRandom::new();
        let mut nonce = [0_u8; 32];
        rng.fill(&mut nonce).map_err(|_| ProofKeyError::Signing)?;
        let nonce = URL_SAFE_NO_PAD.encode(nonce);
        Self::from_invitation_with_nonce(owner, public_key, invitation, &nonce)
    }

    pub(crate) fn nonce(&self) -> &str {
        &self.nonce
    }

    pub(crate) fn compact_jws(&self, signature_p1363: &[u8]) -> ProofResult<String> {
        if signature_p1363.len() != 64 {
            return Err(ProofKeyError::Signing);
        }
        Ok(format!(
            "{}.{}",
            self.signing_input,
            URL_SAFE_NO_PAD.encode(signature_p1363)
        ))
    }

    fn from_invitation_with_nonce(
        owner: &NativeProofKeyOwner,
        public_key: &NativeProofKeyPublicMetadata,
        invitation: NativeBrokerRedemptionInvitation,
        nonce: &str,
    ) -> ProofResult<Self> {
        validate_invitation(owner, public_key, &invitation, nonce)?;
        let payload = NativeRedemptionPayload {
            aud: "station-self-hosted-broker",
            purpose: "redeem-native-route-invitation",
            version: "station-broker-native-route-invitation/v2",
            broker_origin: &invitation.broker_origin,
            scope: NativeRedemptionScope {
                station_id: &invitation.station_id,
                enrollment_id: &invitation.enrollment_id,
                routing_generation: invitation.routing_generation,
            },
            station_signing_key_id: &invitation.station_signing_key_id,
            station_signing_generation: invitation.station_signing_generation,
            surface: NativeRedemptionSurface {
                kind: "station-native",
                app_identifier: owner.app_identifier(),
                channel: owner.channel_label(),
                client_instance_id: owner.client_instance_id(),
                key_thumbprint: &public_key.thumbprint,
            },
            invitation_id: &invitation.invitation_id,
            invitation_secret_digest: invitation_secret_digest(&invitation.invitation_secret),
            expires_at: invitation.expires_at,
            nonce,
        };
        let payload = serde_json::to_vec(&payload).map_err(|_| ProofKeyError::InvalidChallenge)?;
        let header = serde_json::to_vec(&NativeRedemptionProtectedHeader {
            alg: "ES256",
            typ: NATIVE_REDEMPTION_TYP,
        })
        .map_err(|_| ProofKeyError::InvalidChallenge)?;
        let signing_input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header),
            URL_SAFE_NO_PAD.encode(payload)
        );
        Ok(Self {
            signing_input,
            key_thumbprint: public_key.thumbprint.clone(),
            nonce: nonce.to_owned(),
        })
    }
}

/// One fixed v2 native broker operation. Callers cannot provide a URL or path.
#[derive(Clone, Copy)]
pub(crate) enum NativeBrokerRequestBody<'a> {
    Open {
        nonce: &'a str,
        offer_sdp: &'a str,
    },
    Read {
        nonce: &'a str,
    },
    Retire,
    Renew {
        renewal_id: &'a str,
        expected_expires_at: u64,
    },
}

/// Host-owned grant facts used to construct one request proof. The bearer is
/// borrowed only long enough to compute `ath`; it is never retained here.
pub(crate) struct NativeBrokerRequestIdentity<'a> {
    pub(crate) broker_origin: &'a str,
    pub(crate) grant_id: &'a str,
    pub(crate) station_id: &'a str,
    pub(crate) enrollment_id: &'a str,
    pub(crate) routing_generation: u64,
    pub(crate) app_identifier: &'a str,
    pub(crate) channel: &'a str,
    pub(crate) client_instance_id: &'a str,
    pub(crate) key_thumbprint: &'a str,
    pub(crate) station_signing_key_id: &'a str,
    pub(crate) station_signing_generation: u64,
    pub(crate) bearer_secret: &'a str,
}

/// A closed request body, exact claims bytes, and the only allowed request
/// endpoint/purpose. There is no arbitrary signing-input constructor.
pub(crate) struct NativeBrokerRequestProofChallenge {
    signing_input: String,
    key_thumbprint: String,
    broker_origin: String,
    grant_id: String,
    station_id: String,
    enrollment_id: String,
    routing_generation: u64,
    app_identifier: String,
    channel: String,
    client_instance_id: String,
    station_signing_key_id: String,
    station_signing_generation: u64,
    ath: String,
    path: &'static str,
    body: Zeroizing<Vec<u8>>,
    jti: String,
    issued_at: u64,
}

impl NativeBrokerRequestProofChallenge {
    pub(crate) fn from_request(
        identity: NativeBrokerRequestIdentity<'_>,
        body: NativeBrokerRequestBody<'_>,
        issued_at: u64,
    ) -> ProofResult<Self> {
        let mut jti = [0_u8; 32];
        SystemRandom::new()
            .fill(&mut jti)
            .map_err(|_| ProofKeyError::Signing)?;
        Self::from_request_with_jti(identity, body, issued_at, jti)
    }

    fn from_request_with_jti(
        identity: NativeBrokerRequestIdentity<'_>,
        operation: NativeBrokerRequestBody<'_>,
        issued_at: u64,
        jti_bytes: [u8; 32],
    ) -> ProofResult<Self> {
        validate_native_request_identity(&identity, &operation, issued_at)?;
        let scope = NativeRequestProofScope {
            station_id: identity.station_id,
            enrollment_id: identity.enrollment_id,
            routing_generation: identity.routing_generation,
        };
        let surface = NativeRequestProofSurface {
            kind: "station-native",
            app_identifier: identity.app_identifier,
            channel: identity.channel,
            client_instance_id: identity.client_instance_id,
            key_thumbprint: identity.key_thumbprint,
        };
        let (path, purpose, body) = match operation {
            NativeBrokerRequestBody::Open { nonce, offer_sdp } => (
                "/broker/v1/native/connections/open",
                "station-native-connection-open-v2",
                serde_json::to_vec(&NativeRequestOpenBody {
                    scope,
                    surface,
                    connection: NativeRequestOpenConnection {
                        version: "station-broker-native-connection-open/v2",
                        nonce,
                        offer_sdp,
                    },
                }),
            ),
            NativeBrokerRequestBody::Read { nonce } => (
                "/broker/v1/native/connections/read",
                "station-native-connection-read-v2",
                serde_json::to_vec(&NativeRequestReadBody {
                    version: "station-broker-native-connection-read/v2",
                    scope,
                    surface,
                    nonce,
                }),
            ),
            NativeBrokerRequestBody::Retire => (
                "/broker/v1/native/grants/retire",
                "station-native-grant-retire-v2",
                serde_json::to_vec(&NativeRequestRetireBody {
                    version: "station-broker-native-grant-retire/v2",
                    scope,
                    surface,
                }),
            ),
            NativeBrokerRequestBody::Renew {
                renewal_id,
                expected_expires_at,
            } => (
                "/broker/v1/native/grants/renew",
                "station-native-grant-renew-v2",
                serde_json::to_vec(&NativeRequestRenewBody {
                    version: "station-broker-native-grant-renew/v2",
                    scope,
                    surface,
                    renewal_id,
                    expected_expires_at,
                }),
            ),
        };
        let body = body.map_err(|_| ProofKeyError::InvalidChallenge)?;
        if body.len() > 256 * 1024 {
            return Err(ProofKeyError::InvalidChallenge);
        }
        let body_sha256 =
            URL_SAFE_NO_PAD.encode(ring::digest::digest(&ring::digest::SHA256, &body));
        let ath = URL_SAFE_NO_PAD.encode(ring::digest::digest(
            &ring::digest::SHA256,
            identity.bearer_secret.as_bytes(),
        ));
        let jti = URL_SAFE_NO_PAD.encode(jti_bytes);
        let claims = NativeRequestProofClaimsV1 {
            version: "station-broker-native-request-proof/v1",
            aud: identity.broker_origin,
            purpose,
            broker_origin: identity.broker_origin,
            method: "POST",
            path,
            grant_id: identity.grant_id,
            scope,
            surface,
            station_signing_key_id: identity.station_signing_key_id,
            station_signing_generation: identity.station_signing_generation,
            ath,
            jti: &jti,
            issued_at,
            expires_at: issued_at
                .checked_add(30)
                .filter(|expires_at| *expires_at <= 9_007_199_254_740_991)
                .ok_or(ProofKeyError::InvalidChallenge)?,
            body_sha256,
        };
        let payload = serde_json::to_vec(&claims).map_err(|_| ProofKeyError::InvalidChallenge)?;
        let header = serde_json::to_vec(&NativeRequestProofProtectedHeader {
            alg: "ES256",
            typ: "station-broker-native-request+jws",
        })
        .map_err(|_| ProofKeyError::InvalidChallenge)?;
        let signing_input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header),
            URL_SAFE_NO_PAD.encode(payload)
        );
        Ok(Self {
            signing_input,
            key_thumbprint: identity.key_thumbprint.to_owned(),
            broker_origin: identity.broker_origin.to_owned(),
            grant_id: identity.grant_id.to_owned(),
            station_id: identity.station_id.to_owned(),
            enrollment_id: identity.enrollment_id.to_owned(),
            routing_generation: identity.routing_generation,
            app_identifier: identity.app_identifier.to_owned(),
            channel: identity.channel.to_owned(),
            client_instance_id: identity.client_instance_id.to_owned(),
            station_signing_key_id: identity.station_signing_key_id.to_owned(),
            station_signing_generation: identity.station_signing_generation,
            ath: URL_SAFE_NO_PAD.encode(ring::digest::digest(
                &ring::digest::SHA256,
                identity.bearer_secret.as_bytes(),
            )),
            path,
            body: Zeroizing::new(body),
            jti,
            issued_at,
        })
    }

    pub(crate) fn path(&self) -> &'static str {
        self.path
    }

    pub(crate) fn matches_identity(&self, identity: &NativeBrokerRequestIdentity<'_>) -> bool {
        self.broker_origin == identity.broker_origin
            && self.grant_id == identity.grant_id
            && self.station_id == identity.station_id
            && self.enrollment_id == identity.enrollment_id
            && self.routing_generation == identity.routing_generation
            && self.app_identifier == identity.app_identifier
            && self.channel == identity.channel
            && self.client_instance_id == identity.client_instance_id
            && self.key_thumbprint == identity.key_thumbprint
            && self.station_signing_key_id == identity.station_signing_key_id
            && self.station_signing_generation == identity.station_signing_generation
            && self.ath
                == URL_SAFE_NO_PAD.encode(ring::digest::digest(
                    &ring::digest::SHA256,
                    identity.bearer_secret.as_bytes(),
                ))
    }

    pub(crate) fn body(&self) -> &[u8] {
        &self.body
    }

    pub(crate) fn jti(&self) -> &str {
        &self.jti
    }

    pub(crate) fn issued_at(&self) -> u64 {
        self.issued_at
    }

    pub(crate) fn compact_jws(&self, signature_p1363: &[u8]) -> ProofResult<String> {
        if signature_p1363.len() != 64 {
            return Err(ProofKeyError::Signing);
        }
        Ok(format!(
            "{}.{}",
            self.signing_input,
            URL_SAFE_NO_PAD.encode(signature_p1363)
        ))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeRequestProofProtectedHeader {
    alg: &'static str,
    typ: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeRequestProofClaimsV1<'a> {
    version: &'static str,
    aud: &'a str,
    purpose: &'static str,
    broker_origin: &'a str,
    method: &'static str,
    path: &'static str,
    grant_id: &'a str,
    scope: NativeRequestProofScope<'a>,
    surface: NativeRequestProofSurface<'a>,
    station_signing_key_id: &'a str,
    station_signing_generation: u64,
    ath: String,
    jti: &'a str,
    #[serde(rename = "iat")]
    issued_at: u64,
    #[serde(rename = "exp")]
    expires_at: u64,
    body_sha256: String,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeRequestProofScope<'a> {
    station_id: &'a str,
    enrollment_id: &'a str,
    routing_generation: u64,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeRequestProofSurface<'a> {
    kind: &'static str,
    app_identifier: &'a str,
    channel: &'a str,
    client_instance_id: &'a str,
    key_thumbprint: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeRequestOpenBody<'a> {
    scope: NativeRequestProofScope<'a>,
    surface: NativeRequestProofSurface<'a>,
    connection: NativeRequestOpenConnection<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeRequestOpenConnection<'a> {
    version: &'static str,
    nonce: &'a str,
    offer_sdp: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeRequestReadBody<'a> {
    version: &'static str,
    scope: NativeRequestProofScope<'a>,
    surface: NativeRequestProofSurface<'a>,
    nonce: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeRequestRetireBody<'a> {
    version: &'static str,
    scope: NativeRequestProofScope<'a>,
    surface: NativeRequestProofSurface<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeRequestRenewBody<'a> {
    version: &'static str,
    scope: NativeRequestProofScope<'a>,
    surface: NativeRequestProofSurface<'a>,
    renewal_id: &'a str,
    expected_expires_at: u64,
}

fn validate_native_request_identity(
    identity: &NativeBrokerRequestIdentity<'_>,
    operation: &NativeBrokerRequestBody<'_>,
    issued_at: u64,
) -> ProofResult<()> {
    let url =
        url::Url::parse(identity.broker_origin).map_err(|_| ProofKeyError::InvalidChallenge)?;
    let loopback = match url.host() {
        Some(url::Host::Domain("localhost")) => true,
        Some(url::Host::Ipv4(address)) => address == std::net::Ipv4Addr::LOCALHOST,
        Some(url::Host::Ipv6(address)) => address == std::net::Ipv6Addr::LOCALHOST,
        _ => false,
    };
    let valid_origin = url.origin().ascii_serialization() == identity.broker_origin
        && (url.scheme() == "https" || (url.scheme() == "http" && loopback))
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none();
    let valid_channel = matches!(identity.channel, "stable" | "beta" | "nightly" | "dev");
    let valid_grant_id = (8..=128).contains(&identity.grant_id.len())
        && identity
            .grant_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'));
    let valid_secret = identity.bearer_secret.len() == 43
        && identity
            .bearer_secret
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'));
    let valid_identifier = |value: &str| {
        value.len() == 36
            && [8, 13, 18, 23]
                .iter()
                .all(|index| value.as_bytes()[*index] == b'-')
            && value
                .bytes()
                .enumerate()
                .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
    };
    let valid_surface = identity
        .app_identifier
        .as_bytes()
        .first()
        .is_some_and(|byte| {
            byte.is_ascii_alphanumeric()
                && identity.app_identifier.len() <= 255
                && identity
                    .app_identifier
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
        });
    let valid_request_body = match operation {
        NativeBrokerRequestBody::Open { nonce, offer_sdp } => {
            valid_request_token(nonce)
                && !offer_sdp.is_empty()
                && offer_sdp.as_bytes().len() <= 128 * 1024
        }
        NativeBrokerRequestBody::Read { nonce } => valid_request_token(nonce),
        NativeBrokerRequestBody::Retire => true,
        NativeBrokerRequestBody::Renew { renewal_id, .. } => valid_request_token(renewal_id),
    };
    if !valid_origin
        || !valid_grant_id
        || !valid_secret
        || !valid_identifier(identity.station_id)
        || !valid_identifier(identity.enrollment_id)
        || !valid_identifier(identity.client_instance_id)
        || !valid_surface
        || !valid_channel
        || !valid_request_token(identity.key_thumbprint)
        || !valid_request_token(identity.station_signing_key_id)
        || identity.key_thumbprint.len() != 43
        || identity.station_signing_key_id.len() != 43
        || identity.routing_generation == 0
        || identity.routing_generation > 9_007_199_254_740_991
        || identity.station_signing_generation == 0
        || identity.station_signing_generation > 9_007_199_254_740_991
        || issued_at > 9_007_199_254_740_991 - 30
        || !valid_request_body
    {
        return Err(ProofKeyError::InvalidChallenge);
    }
    Ok(())
}

fn valid_request_token(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

#[derive(Serialize)]
struct NativeRedemptionProtectedHeader {
    alg: &'static str,
    typ: &'static str,
}

#[derive(Serialize)]
struct NativeRedemptionPayload<'a> {
    aud: &'static str,
    purpose: &'static str,
    version: &'static str,
    #[serde(rename = "brokerOrigin")]
    broker_origin: &'a str,
    scope: NativeRedemptionScope<'a>,
    #[serde(rename = "stationSigningKeyId")]
    station_signing_key_id: &'a str,
    #[serde(rename = "stationSigningGeneration")]
    station_signing_generation: u64,
    surface: NativeRedemptionSurface<'a>,
    #[serde(rename = "invitationId")]
    invitation_id: &'a str,
    #[serde(rename = "invitationSecretDigest")]
    invitation_secret_digest: String,
    #[serde(rename = "expiresAt")]
    expires_at: u64,
    nonce: &'a str,
}

#[derive(Serialize)]
struct NativeRedemptionScope<'a> {
    #[serde(rename = "stationId")]
    station_id: &'a str,
    #[serde(rename = "enrollmentId")]
    enrollment_id: &'a str,
    #[serde(rename = "routingGeneration")]
    routing_generation: u64,
}

#[derive(Serialize)]
struct NativeRedemptionSurface<'a> {
    kind: &'static str,
    #[serde(rename = "appIdentifier")]
    app_identifier: &'a str,
    channel: &'static str,
    #[serde(rename = "clientInstanceId")]
    client_instance_id: String,
    #[serde(rename = "keyThumbprint")]
    key_thumbprint: &'a str,
}

fn validate_invitation(
    owner: &NativeProofKeyOwner,
    public_key: &NativeProofKeyPublicMetadata,
    invitation: &NativeBrokerRedemptionInvitation,
    nonce: &str,
) -> ProofResult<()> {
    let parsed_origin =
        url::Url::parse(&invitation.broker_origin).map_err(|_| ProofKeyError::InvalidChallenge)?;
    let origin = parsed_origin.origin().ascii_serialization();
    let loopback = match parsed_origin.host() {
        Some(url::Host::Domain("localhost")) => true,
        Some(url::Host::Ipv4(address)) => address == std::net::Ipv4Addr::LOCALHOST,
        Some(url::Host::Ipv6(address)) => address == std::net::Ipv6Addr::LOCALHOST,
        _ => false,
    };
    if !(parsed_origin.scheme() == "https" || (parsed_origin.scheme() == "http" && loopback))
        || !parsed_origin.username().is_empty()
        || parsed_origin.password().is_some()
        || parsed_origin.path() != "/"
        || parsed_origin.query().is_some()
        || parsed_origin.fragment().is_some()
        || invitation.broker_origin != origin
        || !valid_token(&invitation.station_id, 8, 128)
        || !valid_token(&invitation.enrollment_id, 8, 128)
        || !valid_token(&invitation.station_signing_key_id, 43, 43)
        || invitation.app_identifier != owner.app_identifier()
        || !valid_app_identifier(&invitation.app_identifier)
        || !valid_token(&invitation.invitation_id, 8, 128)
        || invitation.routing_generation == 0
        || invitation.routing_generation > 9_007_199_254_740_991
        || invitation.station_signing_generation == 0
        || invitation.station_signing_generation > 9_007_199_254_740_991
        || invitation.expires_at == 0
        || invitation.expires_at > 9_007_199_254_740_991
        || !valid_token(&invitation.invitation_secret, 43, 43)
        || public_key.jwk.kty != "EC"
        || public_key.jwk.crv != "P-256"
        || !valid_token(&public_key.jwk.x, 43, 43)
        || !valid_token(&public_key.jwk.y, 43, 43)
        || !valid_token(&public_key.thumbprint, 43, 43)
        || !valid_token(nonce, 43, 43)
    {
        return Err(ProofKeyError::InvalidChallenge);
    }
    Ok(())
}

fn valid_token(value: &str, min_bytes: usize, max_bytes: usize) -> bool {
    (min_bytes..=max_bytes).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn valid_app_identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && value.len() <= 255
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
}

fn invitation_secret_digest(secret: &str) -> String {
    let mut input = Zeroizing::new(Vec::with_capacity(
        b"native-route-invitation/v2:".len() + secret.len(),
    ));
    input.extend_from_slice(b"native-route-invitation/v2:");
    input.extend_from_slice(secret.as_bytes());
    URL_SAFE_NO_PAD.encode(ring::digest::digest(&ring::digest::SHA256, &input))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_owner(channel: NativeProofKeyChannel, instance: &str) -> NativeProofKeyOwner {
        let app_identifier = match channel {
            NativeProofKeyChannel::Stable => "io.kontourai.station",
            NativeProofKeyChannel::Beta => "io.kontourai.station.beta",
            NativeProofKeyChannel::Nightly => "io.kontourai.station.nightly",
            NativeProofKeyChannel::Dev => "io.kontourai.station.dev",
        };
        make_owner_with_app(app_identifier, channel, instance)
    }

    fn make_owner_with_app(
        app_identifier: &str,
        channel: NativeProofKeyChannel,
        instance: &str,
    ) -> NativeProofKeyOwner {
        NativeProofKeyOwner::new(app_identifier, channel, instance).unwrap()
    }

    fn vault() -> ProofKeyVault<MemorySecretBackend> {
        ProofKeyVault::new(MemorySecretBackend::default())
    }

    fn invitation(secret: &str) -> NativeBrokerRedemptionInvitation {
        NativeBrokerRedemptionInvitation {
            broker_origin: "https://broker.example".to_owned(),
            station_id: "station-12345678".to_owned(),
            enrollment_id: "enroll-12345678".to_owned(),
            routing_generation: 9,
            station_signing_key_id: "K".repeat(43),
            station_signing_generation: 4,
            app_identifier: "io.kontourai.station".to_owned(),
            invitation_id: "invite-12345678".to_owned(),
            invitation_secret: Zeroizing::new(secret.to_owned()),
            expires_at: 1_700_000_000_123,
        }
    }

    fn challenge(
        owner: &NativeProofKeyOwner,
        public: &NativeProofKeyPublicMetadata,
    ) -> NativeBrokerRedemptionChallenge {
        let mut invitation = invitation(&"A".repeat(43));
        invitation.app_identifier = owner.app_identifier().to_owned();
        NativeBrokerRedemptionChallenge::from_invitation_with_nonce(
            owner,
            public,
            invitation,
            &"N".repeat(43),
        )
        .unwrap()
    }

    fn verify_signature(
        public: &NativeProofKeyPublicMetadata,
        challenge: &NativeBrokerRedemptionChallenge,
        signature_bytes: &[u8],
    ) {
        let x = URL_SAFE_NO_PAD.decode(&public.jwk.x).unwrap();
        let y = URL_SAFE_NO_PAD.decode(&public.jwk.y).unwrap();
        let mut uncompressed = vec![0x04];
        uncompressed.extend_from_slice(&x);
        uncompressed.extend_from_slice(&y);
        signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, uncompressed)
            .verify(challenge.signing_input.as_bytes(), signature_bytes)
            .unwrap();
    }

    #[test]
    fn created_key_restores_stably_and_is_bound_to_exact_channel_and_instance() {
        let vault = vault();
        let owner = make_owner(
            NativeProofKeyChannel::Beta,
            "11111111-1111-4111-8111-111111111111",
        );
        let created = vault.create(&owner).unwrap();
        let restored = vault.restore(&owner).unwrap();
        assert_eq!(created, restored);
        assert_eq!(created.jwk.kty, "EC");
        assert_eq!(created.jwk.crv, "P-256");
        assert_eq!(created.jwk.x.len(), 43);
        assert_eq!(created.jwk.y.len(), 43);
        assert_eq!(created.thumbprint.len(), 43);
        let canonical = format!(
            "{{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"{}\",\"y\":\"{}\"}}",
            created.jwk.x, created.jwk.y
        );
        assert_eq!(
            created.thumbprint,
            URL_SAFE_NO_PAD.encode(ring::digest::digest(
                &ring::digest::SHA256,
                canonical.as_bytes()
            ))
        );
        assert_eq!(
            vault.create(&owner).unwrap_err(),
            ProofKeyError::AlreadyExists
        );

        for other in [
            make_owner(
                NativeProofKeyChannel::Stable,
                "11111111-1111-4111-8111-111111111111",
            ),
            make_owner(
                NativeProofKeyChannel::Beta,
                "22222222-2222-4222-8222-222222222222",
            ),
        ] {
            assert_eq!(vault.restore(&other).unwrap_err(), ProofKeyError::Missing);
        }
        let other_app = make_owner_with_app(
            "io.kontourai.station.test",
            NativeProofKeyChannel::Beta,
            "11111111-1111-4111-8111-111111111111",
        );
        assert_eq!(
            vault.restore(&other_app).unwrap_err(),
            ProofKeyError::Missing
        );
    }

    #[test]
    fn separate_vault_instances_cannot_silently_replace_the_same_keyring_account() {
        let backend = MemorySecretBackend::default();
        let first = ProofKeyVault::new(backend.clone());
        let second = ProofKeyVault::new(backend);
        let owner = make_owner(
            NativeProofKeyChannel::Stable,
            "11111111-1111-4111-8111-111111111111",
        );
        let outcomes = std::thread::scope(|scope| {
            let left = scope.spawn(|| first.create(&owner));
            let right = scope.spawn(|| second.create(&owner));
            [left.join().unwrap(), right.join().unwrap()]
        });
        assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter(|result| **result == Err(ProofKeyError::AlreadyExists))
                .count(),
            1
        );
    }

    #[test]
    fn replacement_and_revocation_are_explicit_operations() {
        let vault = vault();
        let owner = make_owner(
            NativeProofKeyChannel::Stable,
            "11111111-1111-4111-8111-111111111111",
        );
        let first = vault.create(&owner).unwrap();
        let second = vault.replace(&owner).unwrap();
        assert_ne!(first.thumbprint, second.thumbprint);
        vault.revoke(&owner).unwrap();
        assert_eq!(vault.restore(&owner).unwrap_err(), ProofKeyError::Missing);
    }

    #[test]
    fn stored_key_owner_mismatch_and_corruption_fail_closed() {
        let backend = MemorySecretBackend::default();
        let vault = ProofKeyVault::new(backend.clone());
        let target = make_owner(
            NativeProofKeyChannel::Stable,
            "11111111-1111-4111-8111-111111111111",
        );
        let foreign = make_owner(
            NativeProofKeyChannel::Beta,
            "22222222-2222-4222-8222-222222222222",
        );
        let foreign_record = generate_record(&foreign).unwrap();
        let serialized = serde_json::to_string(&foreign_record).unwrap();
        backend.write(&target.account(), &serialized).unwrap();
        assert_eq!(vault.restore(&target).unwrap_err(), ProofKeyError::Corrupt);

        backend.write(&target.account(), "{truncated").unwrap();
        assert_eq!(vault.restore(&target).unwrap_err(), ProofKeyError::Corrupt);

        let mut corrupt_key = generate_record(&target).unwrap();
        corrupt_key.private_pkcs8 = SecretPkcs8(Zeroizing::new(vec![1, 2, 3]));
        let serialized = serde_json::to_string(&corrupt_key).unwrap();
        backend.write(&target.account(), &serialized).unwrap();
        assert_eq!(vault.restore(&target).unwrap_err(), ProofKeyError::Corrupt);
        let recovered = vault.replace(&target).unwrap();
        assert_eq!(vault.restore(&target).unwrap(), recovered);
        vault.revoke(&target).unwrap();
    }

    #[test]
    fn signing_returns_verifiable_es256_p1363_and_metadata_never_contains_private_key() {
        let backend = MemorySecretBackend::default();
        let vault = ProofKeyVault::new(backend.clone());
        let owner = make_owner(
            NativeProofKeyChannel::Nightly,
            "11111111-1111-4111-8111-111111111111",
        );
        let public = vault.create(&owner).unwrap();
        let challenge = challenge(&owner, &public);
        assert_eq!(challenge.nonce(), "N".repeat(43));
        let signature_bytes = vault.sign_es256_p1363(&owner, &challenge).unwrap();
        assert_eq!(signature_bytes.len(), 64);
        verify_signature(&public, &challenge, &signature_bytes);
        let compact = challenge.compact_jws(&signature_bytes).unwrap();
        let mut compact_parts = compact.split('.');
        assert!(compact_parts.next().is_some());
        assert!(compact_parts.next().is_some());
        assert_eq!(
            URL_SAFE_NO_PAD
                .decode(compact_parts.next().unwrap())
                .unwrap(),
            signature_bytes
        );
        assert!(compact_parts.next().is_none());
        assert!(challenge.compact_jws(&signature_bytes[..63]).is_err());

        let metadata = serde_json::to_string(&public).unwrap();
        assert!(!metadata.contains("privatePkcs8"));
        assert!(!metadata.contains("private_pkcs8"));
        let stored = backend.read(&owner.account()).unwrap().unwrap();
        let decoded: StoredProofKey = serde_json::from_str(&stored).unwrap();
        let private_encoded = URL_SAFE_NO_PAD.encode(decoded.private_pkcs8.0.as_slice());
        assert!(!metadata.contains(&private_encoded));
        assert!(metadata.contains(&public.thumbprint));
        assert!(metadata.contains(&public.jwk.x));
        assert!(metadata.contains(&public.jwk.y));

        let mut wrong_public = public.clone();
        wrong_public.thumbprint = "F".repeat(43);
        let mut wrong_invitation = invitation(&"A".repeat(43));
        wrong_invitation.app_identifier = owner.app_identifier().to_owned();
        let wrong_challenge = NativeBrokerRedemptionChallenge::from_invitation_with_nonce(
            &owner,
            &wrong_public,
            wrong_invitation,
            &"N".repeat(43),
        )
        .unwrap();
        assert_eq!(
            vault
                .sign_es256_p1363(&owner, &wrong_challenge)
                .unwrap_err(),
            ProofKeyError::InvalidChallenge
        );
    }

    #[test]
    fn serializes_the_exact_v2_native_redemption_payload_and_never_the_invitation_secret() {
        let owner = make_owner_with_app(
            "io.kontourai.station",
            NativeProofKeyChannel::Nightly,
            "7c6f49aa-6925-4bb2-b7c4-22bb6e264105",
        );
        let public = NativeProofKeyPublicMetadata {
            jwk: P256PublicJwk {
                kty: "EC".to_owned(),
                crv: "P-256".to_owned(),
                x: "X".repeat(43),
                y: "Y".repeat(43),
            },
            thumbprint: "T".repeat(43),
        };
        let challenge = NativeBrokerRedemptionChallenge::from_invitation_with_nonce(
            &owner,
            &public,
            invitation(&"A".repeat(43)),
            &"N".repeat(43),
        )
        .unwrap();
        let (header, payload) = challenge.signing_input.split_once('.').unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.decode(header).unwrap(),
            br#"{"alg":"ES256","typ":"station-broker-native-redemption+jws"}"#
        );
        assert_eq!(
            String::from_utf8(URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap(),
            "{\"aud\":\"station-self-hosted-broker\",\"purpose\":\"redeem-native-route-invitation\",\"version\":\"station-broker-native-route-invitation/v2\",\"brokerOrigin\":\"https://broker.example\",\"scope\":{\"stationId\":\"station-12345678\",\"enrollmentId\":\"enroll-12345678\",\"routingGeneration\":9},\"stationSigningKeyId\":\"KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK\",\"stationSigningGeneration\":4,\"surface\":{\"kind\":\"station-native\",\"appIdentifier\":\"io.kontourai.station\",\"channel\":\"nightly\",\"clientInstanceId\":\"7c6f49aa-6925-4bb2-b7c4-22bb6e264105\",\"keyThumbprint\":\"TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT\"},\"invitationId\":\"invite-12345678\",\"invitationSecretDigest\":\"cwNHKhO8UqbEmG63NB3wWnIRQaHNpk7z6r78WuCtcPs\",\"expiresAt\":1700000000123,\"nonce\":\"NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN\"}"
        );
        assert!(!challenge.signing_input.contains(&"A".repeat(43)));
    }

    #[test]
    fn native_request_proof_matches_shared_golden_and_signs_compact_es256_jws() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../packages/contracts/fixtures/native-request-proof-v1.json"
        ))
        .unwrap();
        let owner = NativeProofKeyOwner::new(
            fixture["surface"]["appIdentifier"].as_str().unwrap(),
            NativeProofKeyChannel::Stable,
            fixture["surface"]["clientInstanceId"].as_str().unwrap(),
        )
        .unwrap();
        let bearer_secret = "S".repeat(43);
        let operation = NativeBrokerRequestBody::Open {
            nonce: "nonce-request-proof-01",
            offer_sdp: "offer-fixture",
        };
        let fixture_identity = NativeBrokerRequestIdentity {
            broker_origin: fixture["brokerOrigin"].as_str().unwrap(),
            grant_id: fixture["grantId"].as_str().unwrap(),
            station_id: fixture["scope"]["stationId"].as_str().unwrap(),
            enrollment_id: fixture["scope"]["enrollmentId"].as_str().unwrap(),
            routing_generation: fixture["scope"]["routingGeneration"].as_u64().unwrap(),
            app_identifier: fixture["surface"]["appIdentifier"].as_str().unwrap(),
            channel: fixture["surface"]["channel"].as_str().unwrap(),
            client_instance_id: fixture["surface"]["clientInstanceId"].as_str().unwrap(),
            key_thumbprint: fixture["surface"]["keyThumbprint"].as_str().unwrap(),
            station_signing_key_id: fixture["stationSigningKeyId"].as_str().unwrap(),
            station_signing_generation: fixture["stationSigningGeneration"].as_u64().unwrap(),
            bearer_secret: &bearer_secret,
        };
        let jti: [u8; 32] = URL_SAFE_NO_PAD
            .decode(fixture["jti"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let issued_at = fixture["iat"].as_u64().unwrap();
        let challenge = NativeBrokerRequestProofChallenge::from_request_with_jti(
            fixture_identity,
            operation,
            issued_at,
            jti,
        )
        .unwrap();
        assert_eq!(challenge.path(), fixture["path"].as_str().unwrap());
        assert_eq!(
            challenge.body(),
            fixture["bodyJson"].as_str().unwrap().as_bytes()
        );
        let payload = challenge.signing_input.split('.').nth(1).unwrap();
        assert_eq!(
            String::from_utf8(URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap(),
            fixture["claimsJson"].as_str().unwrap()
        );
        assert!(
            !fixture.to_string().contains(&"S".repeat(43)),
            "fixture must not contain bearer material"
        );

        let proof_keys = MemoryNativeRelayProofKeyVault::new();
        let public = proof_keys.create(&owner).unwrap();
        let identity = NativeBrokerRequestIdentity {
            broker_origin: fixture["brokerOrigin"].as_str().unwrap(),
            grant_id: fixture["grantId"].as_str().unwrap(),
            station_id: fixture["scope"]["stationId"].as_str().unwrap(),
            enrollment_id: fixture["scope"]["enrollmentId"].as_str().unwrap(),
            routing_generation: fixture["scope"]["routingGeneration"].as_u64().unwrap(),
            app_identifier: fixture["surface"]["appIdentifier"].as_str().unwrap(),
            channel: fixture["surface"]["channel"].as_str().unwrap(),
            client_instance_id: fixture["surface"]["clientInstanceId"].as_str().unwrap(),
            key_thumbprint: public.thumbprint(),
            station_signing_key_id: fixture["stationSigningKeyId"].as_str().unwrap(),
            station_signing_generation: fixture["stationSigningGeneration"].as_u64().unwrap(),
            bearer_secret: &bearer_secret,
        };
        let challenge = NativeBrokerRequestProofChallenge::from_request_with_jti(
            identity, operation, issued_at, jti,
        )
        .unwrap();
        let signature = proof_keys
            .sign_native_request_es256_p1363(&owner, &challenge)
            .unwrap();
        let compact = challenge.compact_jws(&signature).unwrap();
        let parts = compact.split('.').collect::<Vec<_>>();
        assert_eq!(parts.len(), 3);
        assert_eq!(
            URL_SAFE_NO_PAD.decode(parts[0]).unwrap(),
            br#"{"alg":"ES256","typ":"station-broker-native-request+jws"}"#
        );
        assert_eq!(URL_SAFE_NO_PAD.decode(parts[2]).unwrap(), signature);
        let x = URL_SAFE_NO_PAD.decode(public.jwk.x()).unwrap();
        let y = URL_SAFE_NO_PAD.decode(public.jwk.y()).unwrap();
        let mut point = vec![0x04];
        point.extend_from_slice(&x);
        point.extend_from_slice(&y);
        let signing_input = format!("{}.{}", parts[0], parts[1]);
        signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, point)
            .verify(signing_input.as_bytes(), &signature)
            .unwrap();
    }

    #[test]
    fn loopback_http_is_allowed_for_the_free_lab_but_public_http_is_refused() {
        let owner = make_owner(
            NativeProofKeyChannel::Stable,
            "11111111-1111-4111-8111-111111111111",
        );
        let public = NativeProofKeyPublicMetadata {
            jwk: P256PublicJwk {
                kty: "EC".to_owned(),
                crv: "P-256".to_owned(),
                x: "X".repeat(43),
                y: "Y".repeat(43),
            },
            thumbprint: "T".repeat(43),
        };
        let mut loopback = invitation(&"A".repeat(43));
        loopback.app_identifier = owner.app_identifier().to_owned();
        loopback.broker_origin = "http://127.0.0.1:4100".to_owned();
        assert!(NativeBrokerRedemptionChallenge::from_invitation_with_nonce(
            &owner,
            &public,
            loopback,
            &"N".repeat(43),
        )
        .is_ok());

        for loopback_origin in ["http://localhost:4100", "http://[::1]:4100"] {
            let mut loopback = invitation(&"A".repeat(43));
            loopback.app_identifier = owner.app_identifier().to_owned();
            loopback.broker_origin = loopback_origin.to_owned();
            assert!(NativeBrokerRedemptionChallenge::from_invitation_with_nonce(
                &owner,
                &public,
                loopback,
                &"N".repeat(43),
            )
            .is_ok());
        }

        let mut public_http = invitation(&"A".repeat(43));
        public_http.app_identifier = owner.app_identifier().to_owned();
        public_http.broker_origin = "http://broker.example".to_owned();
        assert!(matches!(
            NativeBrokerRedemptionChallenge::from_invitation_with_nonce(
                &owner,
                &public,
                public_http,
                &"N".repeat(43),
            ),
            Err(ProofKeyError::InvalidChallenge)
        ));
    }

    #[test]
    fn owner_requires_a_canonical_uuid() {
        assert!(NativeProofKeyOwner::new(
            ".io.kontourai.station",
            NativeProofKeyChannel::Dev,
            "11111111-1111-4111-8111-111111111111",
        )
        .is_err());
        assert_eq!(
            NativeProofKeyOwner::new(
                "io.kontourai.station.dev",
                NativeProofKeyChannel::Dev,
                "not-a-uuid",
            )
            .unwrap_err(),
            ProofKeyError::InvalidOwner
        );
        assert_eq!(
            NativeProofKeyOwner::new(
                "io.kontourai.station.dev",
                NativeProofKeyChannel::Dev,
                "11111111-1111-4111-8111-111111111111 ",
            )
            .unwrap_err(),
            ProofKeyError::InvalidOwner
        );
    }
}

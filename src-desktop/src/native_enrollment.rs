//! Native-only recipient custody for the additive relay enrollment envelope.
//! No renderer command or runtime admission is registered by this module.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hpke::{
    aead::AesGcm128, kdf::HkdfSha256, kem::DhP256HkdfSha256, Deserializable, Kem as _, OpModeR,
    Serializable,
};
use ring::{
    digest,
    rand::{SecureRandom as _, SystemRandom},
    signature,
};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

const VERSION: &str = "station.native-relay-enrollment/v1";
const PROOF_TYPE: &str = "station-native-relay-enrollment-delivery+jws";
const REFUSED: &str = "native_enrollment_delivery_refused";
const MAX_CIPHERTEXT_BYTES: usize = 16 * 1024 + 16;
static RECIPIENT_OPERATION: std::sync::Mutex<()> = std::sync::Mutex::new(());
type Result<T> = std::result::Result<T, String>;
type Kem = DhP256HkdfSha256;
type PrivateKey = <Kem as hpke::Kem>::PrivateKey;

pub(crate) fn decode(value: &str, limit: usize) -> Result<Vec<u8>> {
    if value.len() > limit.div_ceil(3) * 4 {
        return Err(REFUSED.into());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| REFUSED.to_owned())?;
    if bytes.len() > limit || URL_SAFE_NO_PAD.encode(&bytes) != value {
        return Err(REFUSED.into());
    }
    Ok(bytes)
}

/// Implemented by the native OS store adapter; never by renderer storage.
pub(crate) trait NativeEnrollmentSecretBackend {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<String>>>;
    fn write(&self, account: &str, value: &str) -> Result<()>;
    fn delete(&self, account: &str) -> Result<()>;
}

pub(crate) struct NativeEnrollmentSystemBackend;
impl NativeEnrollmentSystemBackend {
    fn entry(account: &str) -> Result<crate::native_secure_entry::NativeSecureEntry> {
        crate::initialize_credential_store().map_err(|_| REFUSED.to_owned())?;
        crate::native_secure_entry::NativeSecureEntry::new(
            "io.kontourai.station.native-enrollment-recipient",
            account,
        )
        .map_err(|_| REFUSED.to_owned())
    }
}
impl NativeEnrollmentSecretBackend for NativeEnrollmentSystemBackend {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<String>>> {
        match Self::entry(account)?.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(_) => Err(REFUSED.into()),
        }
    }
    fn write(&self, account: &str, value: &str) -> Result<()> {
        Self::entry(account)?
            .set_password(value)
            .map_err(|_| REFUSED.to_owned())
    }
    fn delete(&self, account: &str) -> Result<()> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(_) => Err(REFUSED.into()),
        }
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeEnrollmentRecipientOwner {
    pub(crate) client_attempt_id: String,
    pub(crate) app_identifier: String,
    pub(crate) channel: String,
    pub(crate) profile_name: String,
    pub(crate) profile_revision: u64,
    pub(crate) station_id: String,
    pub(crate) station_origin: String,
    pub(crate) route_generation: u64,
    pub(crate) grant_id: String,
    pub(crate) grant_digest: String,
    pub(crate) peer_nonce: String,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeEnrollmentSurface {
    pub(crate) kind: String,
    pub(crate) app_identifier: String,
    pub(crate) channel: String,
    pub(crate) client_instance_id: String,
    pub(crate) key_thumbprint: String,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeEnrollmentScope {
    pub(crate) station_id: String,
    pub(crate) enrollment_id: String,
    pub(crate) routing_generation: u64,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NativeEnrollmentSuite {
    pub(crate) kem: u16,
    pub(crate) kdf: u16,
    pub(crate) aead: u16,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeEnrollmentRecipient {
    pub(crate) suite: NativeEnrollmentSuite,
    pub(crate) public_key: String,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeEnrollmentBinding {
    pub(crate) station_id: String,
    pub(crate) station_audience: String,
    pub(crate) scope: NativeEnrollmentScope,
    pub(crate) surface: NativeEnrollmentSurface,
    pub(crate) peer_nonce: String,
    pub(crate) enrollment_id: String,
    pub(crate) reserved_device_id: String,
    pub(crate) recipient: NativeEnrollmentRecipient,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NativeEnrollmentPublicJwk {
    pub(crate) kty: String,
    pub(crate) crv: String,
    pub(crate) x: String,
    pub(crate) y: String,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeEnrollmentCandidate {
    pub(crate) version: String,
    pub(crate) station_id: String,
    pub(crate) device_id: String,
    pub(crate) binding_id: String,
    pub(crate) surface: NativeEnrollmentSurface,
    pub(crate) device_proof_jwk: NativeEnrollmentPublicJwk,
    pub(crate) device_proof_key_thumbprint: String,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeEnrollmentDeliveryMetadata {
    pub(crate) version: String,
    pub(crate) state: String,
    pub(crate) binding: NativeEnrollmentBinding,
    pub(crate) candidate: NativeEnrollmentCandidate,
    pub(crate) activation_nonce: String,
    pub(crate) bundle_digest: String,
    pub(crate) expires_at: u64,
    pub(crate) response_peer_nonce: String,
    pub(crate) station_signing_generation: u64,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NativeEnrollmentChallenge {
    pub(crate) version: String,
    pub(crate) station_id: String,
    pub(crate) station_audience: String,
    pub(crate) scope: NativeEnrollmentScope,
    pub(crate) surface: NativeEnrollmentSurface,
    pub(crate) peer_nonce: String,
    pub(crate) enrollment_id: String,
    pub(crate) reserved_device_id: String,
    pub(crate) recipient: NativeEnrollmentRecipient,
    pub(crate) nonce: String,
    pub(crate) expires_at: u64,
    pub(crate) client_attempt_id: String,
    pub(crate) response_peer_nonce: String,
    pub(crate) requested_scope: String,
    pub(crate) registration_available: bool,
    pub(crate) station_signing_generation: u64,
}
impl NativeEnrollmentChallenge {
    pub(crate) fn binding(&self) -> NativeEnrollmentBinding {
        NativeEnrollmentBinding {
            station_id: self.station_id.clone(),
            station_audience: self.station_audience.clone(),
            scope: self.scope.clone(),
            surface: self.surface.clone(),
            peer_nonce: self.peer_nonce.clone(),
            enrollment_id: self.enrollment_id.clone(),
            reserved_device_id: self.reserved_device_id.clone(),
            recipient: self.recipient.clone(),
        }
    }
}

pub(crate) fn verify_native_statement(
    public_key: &NativeEnrollmentPublicJwk,
    proof: &str,
    typ: &str,
) -> Result<Vec<u8>> {
    if proof.len() > 16384 || public_key.kty != "EC" || public_key.crv != "P-256" {
        return Err(REFUSED.into());
    }
    let parts: Vec<_> = proof.split('.').collect();
    if parts.len() != 3 {
        return Err(REFUSED.into());
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Header {
        alg: String,
        typ: String,
    }
    let header: Header =
        serde_json::from_slice(&decode(parts[0], 256)?).map_err(|_| REFUSED.to_owned())?;
    if header.alg != "ES256" || header.typ != typ {
        return Err(REFUSED.into());
    }
    let mut point = vec![4u8];
    let x = decode(&public_key.x, 32)?;
    let y = decode(&public_key.y, 32)?;
    if x.len() != 32 || y.len() != 32 {
        return Err(REFUSED.into());
    }
    point.extend(x);
    point.extend(y);
    let signature = decode(parts[2], 64)?;
    if signature.len() != 64 {
        return Err(REFUSED.into());
    }
    signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, &point)
        .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
        .map_err(|_| REFUSED.to_owned())?;
    decode(parts[1], 8192)
}

impl NativeEnrollmentRecipientOwner {
    fn validate(&self) -> Result<()> {
        let valid_uuid = uuid::Uuid::parse_str(&self.station_id)
            .is_ok_and(|id| id.to_string() == self.station_id);
        let origin = url::Url::parse(&self.station_origin).map_err(|_| REFUSED.to_owned())?;
        if self.app_identifier.is_empty()
            || decode(&self.client_attempt_id, 32)?.len() != 32
            || self.app_identifier.len() > 255
            || !self
                .app_identifier
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
            || !matches!(self.channel.as_str(), "dev" | "stable" | "beta" | "nightly")
            || self.profile_name.is_empty()
            || self.profile_name.len() > 256
            || self.profile_revision == 0
            || self.profile_revision > 9_007_199_254_740_991
            || self.route_generation == 0
            || !valid_uuid
            || origin.origin().ascii_serialization() != self.station_origin
            || !(origin.scheme() == "https"
                || (origin.scheme() == "http"
                    && matches!(
                        origin.host_str(),
                        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
                    )))
            || self.grant_id.is_empty()
            || self.grant_id.len() > 128
            || decode(&self.grant_digest, 32)?.len() != 32
            || decode(&self.peer_nonce, 32)?.len() != 32
        {
            return Err(REFUSED.into());
        }
        Ok(())
    }
    fn account(&self, handle: &str) -> Result<String> {
        self.validate()?;
        if decode(handle, 32)?.len() != 32 {
            return Err(REFUSED.into());
        }
        let bytes = serde_json::to_vec(&(VERSION, self)).map_err(|_| REFUSED.to_owned())?;
        Ok(format!(
            "native-enrollment-recipient:v1:{}",
            URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, &bytes))
        ))
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StoredRecipient {
    version: String,
    owner: NativeEnrollmentRecipientOwner,
    attempt_handle: String,
    created_at: u64,
    expires_at: u64,
    private_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeEnrollmentRecipientPrepared {
    pub(crate) version: &'static str,
    pub(crate) attempt_handle: String,
    pub(crate) recipient: NativeEnrollmentRecipient,
    pub(crate) expires_at: u64,
}

pub(crate) struct NativeEnrollmentRecipients<B>(pub(crate) B);
impl<B: NativeEnrollmentSecretBackend> NativeEnrollmentRecipients<B> {
    pub(crate) fn prepare(
        &self,
        owner: &NativeEnrollmentRecipientOwner,
        now: u64,
        expires_at: u64,
    ) -> Result<NativeEnrollmentRecipientPrepared> {
        let _operation = RECIPIENT_OPERATION.lock().map_err(|_| REFUSED.to_owned())?;
        owner.validate()?;
        if now == 0
            || expires_at <= now
            || expires_at - now > 300_000
            || expires_at > 9_007_199_254_740_991
        {
            return Err(REFUSED.into());
        }
        let mut entropy = Zeroizing::new([0u8; 32]);
        let mut handle = [0u8; 32];
        SystemRandom::new()
            .fill(entropy.as_mut())
            .map_err(|_| REFUSED.to_owned())?;
        SystemRandom::new()
            .fill(&mut handle)
            .map_err(|_| REFUSED.to_owned())?;
        let (key, public) = Kem::derive_keypair(entropy.as_ref());
        let private = Zeroizing::new(key.to_bytes().to_vec());
        let handle = URL_SAFE_NO_PAD.encode(handle);
        let account = owner.account(&handle)?;
        // Retry reconciles a committed write even when its acknowledgement was lost.
        if let Some(encoded) = self.0.read(&account)? {
            if encoded.len() > 8192 {
                return Err(REFUSED.into());
            }
            let mut old: StoredRecipient =
                serde_json::from_str(&encoded).map_err(|_| REFUSED.to_owned())?;
            let old_private = Zeroizing::new(std::mem::take(&mut old.private_key));
            if old.version != VERSION
                || old.owner != *owner
                || old.created_at > now
                || old.expires_at <= now
                || decode(&old.attempt_handle, 32)?.len() != 32
            {
                return Err(REFUSED.into());
            }
            let old_key_bytes = Zeroizing::new(decode(&old_private, 32)?);
            let old_key = PrivateKey::from_bytes(&old_key_bytes).map_err(|_| REFUSED.to_owned())?;
            return Ok(NativeEnrollmentRecipientPrepared {
                version: VERSION,
                attempt_handle: old.attempt_handle,
                recipient: NativeEnrollmentRecipient {
                    suite: NativeEnrollmentSuite {
                        kem: 16,
                        kdf: 1,
                        aead: 1,
                    },
                    public_key: URL_SAFE_NO_PAD.encode(Kem::sk_to_pk(&old_key).to_bytes()),
                },
                expires_at: old.expires_at,
            });
        }
        let mut record = StoredRecipient {
            version: VERSION.into(),
            owner: owner.clone(),
            attempt_handle: handle.clone(),
            created_at: now,
            expires_at,
            private_key: URL_SAFE_NO_PAD.encode(private.as_slice()),
        };
        let encoded =
            Zeroizing::new(serde_json::to_string(&record).map_err(|_| REFUSED.to_owned())?);
        let _private_encoded = Zeroizing::new(std::mem::take(&mut record.private_key));
        self.0.write(&account, &encoded)?;
        Ok(NativeEnrollmentRecipientPrepared {
            version: VERSION,
            attempt_handle: handle,
            recipient: NativeEnrollmentRecipient {
                suite: NativeEnrollmentSuite {
                    kem: 16,
                    kdf: 1,
                    aead: 1,
                },
                public_key: URL_SAFE_NO_PAD.encode(public.to_bytes()),
            },
            expires_at,
        })
    }

    /// Expected metadata comes from host-retained challenge/candidate state, never renderer claims.
    pub(crate) fn open(
        &self,
        owner: &NativeEnrollmentRecipientOwner,
        handle: &str,
        expected_metadata: &NativeEnrollmentDeliveryMetadata,
        station_public_point: &[u8],
        proof: &str,
        enc: &str,
        ciphertext: &str,
        now: u64,
    ) -> Result<Zeroizing<Vec<u8>>> {
        let _operation = RECIPIENT_OPERATION.lock().map_err(|_| REFUSED.to_owned())?;
        let account = owner.account(handle)?;
        let encoded = self.0.read(&account)?.ok_or_else(|| REFUSED.to_owned())?;
        if encoded.len() > 8192 {
            return Err(REFUSED.into());
        }
        let mut record: StoredRecipient =
            serde_json::from_str(&encoded).map_err(|_| REFUSED.to_owned())?;
        let private = Zeroizing::new(std::mem::take(&mut record.private_key));
        if record.version != VERSION
            || record.owner != *owner
            || record.attempt_handle != handle
            || now == 0
            || record.created_at > now
            || record.expires_at <= now
        {
            return Err(REFUSED.into());
        }
        let key_bytes = Zeroizing::new(decode(&private, 32)?);
        let key = PrivateKey::from_bytes(&key_bytes).map_err(|_| REFUSED.to_owned())?;
        let binding = &expected_metadata.binding;
        if expected_metadata.version != VERSION
            || expected_metadata.state != "delivered"
            || expected_metadata.expires_at <= now
            || expected_metadata.expires_at > record.expires_at
            || binding.station_id != owner.station_id
            || binding.station_audience != owner.station_origin
            || binding.scope.station_id != owner.station_id
            || binding.scope.routing_generation != owner.route_generation
            || binding.surface.kind != "station-native"
            || binding.surface.app_identifier != owner.app_identifier
            || binding.surface.channel != owner.channel
            || binding.peer_nonce != owner.peer_nonce
            || binding.recipient.suite
                != (NativeEnrollmentSuite {
                    kem: 16,
                    kdf: 1,
                    aead: 1,
                })
            || binding.recipient.public_key
                != URL_SAFE_NO_PAD.encode(Kem::sk_to_pk(&key).to_bytes())
            || expected_metadata.candidate.station_id != owner.station_id
            || expected_metadata.candidate.device_id != binding.reserved_device_id
            || expected_metadata.candidate.surface != binding.surface
        {
            return Err(REFUSED.into());
        }
        open_verified(
            &key,
            expected_metadata,
            station_public_point,
            proof,
            enc,
            ciphertext,
        )
    }

    pub(crate) fn cancel(
        &self,
        owner: &NativeEnrollmentRecipientOwner,
        handle: &str,
    ) -> Result<()> {
        let _operation = RECIPIENT_OPERATION.lock().map_err(|_| REFUSED.to_owned())?;
        let account = owner.account(handle)?;
        if let Some(encoded) = self.0.read(&account)? {
            if encoded.len() > 8192 {
                return Err(REFUSED.into());
            }
            let mut record: StoredRecipient =
                serde_json::from_str(&encoded).map_err(|_| REFUSED.to_owned())?;
            let _private = Zeroizing::new(std::mem::take(&mut record.private_key));
            if record.version != VERSION
                || record.owner != *owner
                || record.attempt_handle != handle
            {
                return Err(REFUSED.into());
            }
        }
        self.0.delete(&account)
    }
}

fn open_verified(
    key: &PrivateKey,
    expected_metadata: &NativeEnrollmentDeliveryMetadata,
    station_public_point: &[u8],
    proof: &str,
    enc: &str,
    ciphertext: &str,
) -> Result<Zeroizing<Vec<u8>>> {
    if proof.len() > 16 * 1024 {
        return Err(REFUSED.into());
    }
    let parts: Vec<_> = proof.split('.').collect();
    if parts.len() != 3 {
        return Err(REFUSED.into());
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Header {
        alg: String,
        typ: String,
    }
    let header: Header =
        serde_json::from_slice(&decode(parts[0], 256)?).map_err(|_| REFUSED.to_owned())?;
    if header.alg != "ES256"
        || header.typ != PROOF_TYPE
        || station_public_point.len() != 65
        || station_public_point[0] != 4
    {
        return Err(REFUSED.into());
    }
    let signature_bytes = decode(parts[2], 64)?;
    signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, station_public_point)
        .verify(
            format!("{}.{}", parts[0], parts[1]).as_bytes(),
            &signature_bytes,
        )
        .map_err(|_| REFUSED.to_owned())?;
    let aad = decode(parts[1], 8192)?;
    let metadata: NativeEnrollmentDeliveryMetadata =
        serde_json::from_slice(&aad).map_err(|_| REFUSED.to_owned())?;
    if metadata != *expected_metadata {
        return Err(REFUSED.into());
    }
    let expected_digest = &metadata.bundle_digest;
    if decode(expected_digest, 32)?.len() != 32 {
        return Err(REFUSED.into());
    }
    let encapsulation = <Kem as hpke::Kem>::EncappedKey::from_bytes(&decode(enc, 65)?)
        .map_err(|_| REFUSED.to_owned())?;
    let ciphertext = decode(ciphertext, MAX_CIPHERTEXT_BYTES)?;
    let plaintext = Zeroizing::new(
        hpke::single_shot_open::<AesGcm128, HkdfSha256, Kem>(
            &OpModeR::Base,
            key,
            &encapsulation,
            VERSION.as_bytes(),
            &ciphertext,
            &aad,
        )
        .map_err(|_| REFUSED.to_owned())?,
    );
    if URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, &plaintext)) != *expected_digest {
        return Err(REFUSED.into());
    }
    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashMap, sync::Mutex};

    #[derive(Default)]
    struct MemoryBackend(Mutex<HashMap<String, String>>);
    impl NativeEnrollmentSecretBackend for MemoryBackend {
        fn read(&self, account: &str) -> Result<Option<Zeroizing<String>>> {
            Ok(self
                .0
                .lock()
                .unwrap()
                .get(account)
                .cloned()
                .map(Zeroizing::new))
        }
        fn write(&self, account: &str, value: &str) -> Result<()> {
            self.0.lock().unwrap().insert(account.into(), value.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<()> {
            self.0.lock().unwrap().remove(account);
            Ok(())
        }
    }
    fn hex(value: &str) -> Vec<u8> {
        assert_eq!(value.len() % 2, 0);
        (0..value.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&value[index..index + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn lost_keyring_write_ack_reconciles_and_wrong_handle_cannot_delete_recipient() {
        struct LostAckBackend {
            inner: MemoryBackend,
            lost: Mutex<bool>,
        }
        impl NativeEnrollmentSecretBackend for LostAckBackend {
            fn read(&self, account: &str) -> Result<Option<Zeroizing<String>>> {
                self.inner.read(account)
            }
            fn write(&self, account: &str, value: &str) -> Result<()> {
                self.inner.write(account, value)?;
                let mut lost = self.lost.lock().unwrap();
                if !*lost {
                    *lost = true;
                    return Err(REFUSED.into());
                }
                Ok(())
            }
            fn delete(&self, account: &str) -> Result<()> {
                self.inner.delete(account)
            }
        }
        let owner = NativeEnrollmentRecipientOwner {
            client_attempt_id: URL_SAFE_NO_PAD.encode([5u8; 32]),
            app_identifier: "io.kontourai.station".into(),
            channel: "nightly".into(),
            profile_name: "Custody fixture".into(),
            profile_revision: 1,
            station_id: "11111111-1111-4111-8111-111111111111".into(),
            station_origin: "https://station.example".into(),
            route_generation: 1,
            grant_id: "grant-fixture".into(),
            grant_digest: URL_SAFE_NO_PAD.encode([1u8; 32]),
            peer_nonce: URL_SAFE_NO_PAD.encode([2u8; 32]),
        };
        let recipients = NativeEnrollmentRecipients(LostAckBackend {
            inner: MemoryBackend::default(),
            lost: Mutex::new(false),
        });
        assert!(recipients.prepare(&owner, 1000, 60000).is_err());
        let recovered = recipients.prepare(&owner, 1001, 60001).unwrap();
        assert_eq!(recovered.expires_at, 60000);
        let original = recipients
            .0
            .read(&owner.account(&recovered.attempt_handle).unwrap())
            .unwrap()
            .unwrap();
        let record: StoredRecipient = serde_json::from_str(&original).unwrap();
        assert_eq!(record.attempt_handle, recovered.attempt_handle);
        assert_eq!(
            recipients
                .cancel(&owner, &URL_SAFE_NO_PAD.encode([9u8; 32]))
                .unwrap_err(),
            REFUSED
        );
        assert_eq!(
            recipients
                .prepare(&owner, 1002, 60002)
                .unwrap()
                .recipient
                .public_key,
            recovered.recipient.public_key
        );
        assert!(recipients.prepare(&owner, 999, 60000).is_err());
        recipients
            .cancel(&owner, &recovered.attempt_handle)
            .unwrap();
        assert!(recipients.0.inner.0.lock().unwrap().is_empty());
    }

    #[test]
    fn standard_p256_single_shot_vector_opens_and_rejects_wrong_aad() {
        let vector: serde_json::Value = serde_json::from_str(include_str!(
            "fixtures/native-enrollment-hpke-p256-base.json"
        ))
        .unwrap();
        let key = PrivateKey::from_bytes(&hex(vector["skRm"].as_str().unwrap())).unwrap();
        let enc =
            <Kem as hpke::Kem>::EncappedKey::from_bytes(&hex(vector["enc"].as_str().unwrap()))
                .unwrap();
        let info = hex(vector["info"].as_str().unwrap());
        let ciphertext = hex(vector["encryption"]["ct"].as_str().unwrap());
        let aad = hex(vector["encryption"]["aad"].as_str().unwrap());
        let plaintext = hpke::single_shot_open::<AesGcm128, HkdfSha256, Kem>(
            &OpModeR::Base,
            &key,
            &enc,
            &info,
            &ciphertext,
            &aad,
        )
        .unwrap();
        assert_eq!(plaintext, hex(vector["encryption"]["pt"].as_str().unwrap()));
        assert!(hpke::single_shot_open::<AesGcm128, HkdfSha256, Kem>(
            &OpModeR::Base,
            &key,
            &enc,
            &info,
            &ciphertext,
            b"wrong-context"
        )
        .is_err());
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct InteropFixture {
        owner: NativeEnrollmentRecipientOwner,
        metadata: NativeEnrollmentDeliveryMetadata,
        private_key: String,
        station_public_point: String,
        handle: String,
        proof: String,
        enc: String,
        ciphertext: String,
        forged_enc: String,
        forged_ciphertext: String,
        plaintext: String,
        now: u64,
    }

    #[test]
    #[ignore = "requires an independently generated TS envelope via NATIVE_ENROLLMENT_INTEROP_FIXTURE"]
    fn typescript_station_envelope_opens_in_rust_and_refuses_forgery() {
        let path = std::env::var("NATIVE_ENROLLMENT_INTEROP_FIXTURE")
            .expect("TS envelope fixture is required");
        let f: InteropFixture = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let recipients = NativeEnrollmentRecipients(MemoryBackend::default());
        let account = f.owner.account(&f.handle).unwrap();
        recipients
            .0
            .write(
                &account,
                &serde_json::to_string(&StoredRecipient {
                    version: VERSION.into(),
                    owner: f.owner.clone(),
                    attempt_handle: f.handle.clone(),
                    created_at: f.now,
                    expires_at: f.metadata.expires_at,
                    private_key: f.private_key,
                })
                .unwrap(),
            )
            .unwrap();
        let station_point = decode(&f.station_public_point, 65).unwrap();
        let open = |owner: &NativeEnrollmentRecipientOwner, enc: &str, ciphertext: &str, now| {
            recipients.open(
                owner,
                &f.handle,
                &f.metadata,
                &station_point,
                &f.proof,
                enc,
                ciphertext,
                now,
            )
        };
        assert_eq!(
            open(&f.owner, &f.enc, &f.ciphertext, f.now)
                .unwrap()
                .as_slice(),
            f.plaintext.as_bytes()
        );
        // Valid HPKE under the same recipient and signed AAD, but forged bearer bytes.
        assert_eq!(
            open(&f.owner, &f.forged_enc, &f.forged_ciphertext, f.now).unwrap_err(),
            REFUSED
        );
        let mut other = f.owner.clone();
        other.peer_nonce = URL_SAFE_NO_PAD.encode([9u8; 32]);
        assert_eq!(
            open(&other, &f.enc, &f.ciphertext, f.now).unwrap_err(),
            REFUSED
        );
        let mut tampered = decode(&f.ciphertext, MAX_CIPHERTEXT_BYTES).unwrap();
        tampered[0] ^= 1;
        assert_eq!(
            open(&f.owner, &f.enc, &URL_SAFE_NO_PAD.encode(tampered), f.now).unwrap_err(),
            REFUSED
        );
        assert_eq!(
            open(&f.owner, &f.enc, &f.ciphertext, f.metadata.expires_at).unwrap_err(),
            REFUSED
        );
        recipients.cancel(&f.owner, &f.handle).unwrap();
        assert_eq!(
            open(&f.owner, &f.enc, &f.ciphertext, f.now).unwrap_err(),
            REFUSED
        );
    }
}

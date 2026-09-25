/**
 * Native (FCM) agent-activity push registration: the wire shapes a paired
 * phone uses to ask its Station for agent-activity cards, the values the
 * Station answers with (checked or used on every push), and the sealed card
 * format that keeps the card end-to-end encrypted to the phone.
 *
 * See docs/design/notification-delivery.md ("Station contract").
 */

/** Registers (or re-registers after token rotation) the calling device. */
export const NATIVE_PUSH_REGISTER_PATH = '/api/system/native-push/register';

/** `DELETE` clears the calling device's own registration. */
export const NATIVE_PUSH_REGISTRATION_PATH = '/api/system/native-push';

/**
 * Android application ids the Kontour push gateway delivers to. The gateway
 * enforces the same list (`deploy/push-gateway/wrangler.jsonc`); a token
 * for any other app could never be delivered, so it is refused at
 * registration.
 */
export const NATIVE_PUSH_ANDROID_PACKAGES = [
  'io.kontourai.station',
  'io.kontourai.station.nightly',
  'io.kontourai.station.beta',
  'io.kontourai.station.debug',
] as const;

export type NativePushAndroidPackage =
  (typeof NATIVE_PUSH_ANDROID_PACKAGES)[number];

export interface NativePushRegistrationRequest {
  /** FCM registration token: 20..4096 characters, no whitespace. */
  token: string;
  packageName: NativePushAndroidPackage;
  platform: 'android';
}

export interface NativePushRegistrationResponse {
  /**
   * 128+ random bits, base64url. Kept across token rotation; the phone drops
   * any push whose `device_id` differs.
   */
  registrationId: string;
  /** The Station's environment id; the phone checks it as `user_id`. */
  stationId: string;
  /**
   * RFC 7638 thumbprint of the Station's push signing key. The gateway stamps
   * the verified key's thumbprint as `station_key`, so a phone that pins this
   * value drops pushes signed by any other key.
   */
  stationKey: string;
  /**
   * AES-256-GCM key (32 bytes, base64url without padding) the Station seals
   * every card to this phone with. Kept across token rotation like
   * `registrationId`; new after the registration is deleted.
   */
  payloadKey: string;
}

/**
 * Additional authenticated data for a sealed card is the UTF-8 of this
 * prefix followed by the registrationId, so a card sealed for one phone does
 * not open as another's even under the same key.
 */
export const NATIVE_PUSH_SEALED_AAD_PREFIX = 'station-agent-activity:v1:';

/**
 * A card as the gateway and FCM carry it: only routing data in clear. The
 * card itself (a JSON object of strings: `user_id`, `updated_at`, `active`,
 * `activity_*`, `alert_*`) is in `sealed` =
 * base64url(nonce[12] || AES-256-GCM ciphertext || tag[16]).
 */
export interface NativePushSealedData {
  station_kind: 'agent_activity';
  device_id: string;
  sealed: string;
}

/**
 * Known-answer vector for the sealing format. The Station's sealer is tested
 * against it and the phone's opener must be: fixed key, nonce and
 * registrationId, and the exact `sealed` string they produce.
 */
export const NATIVE_PUSH_SEALED_TEST_VECTOR = {
  payloadKey: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  registrationId: 'AAECAwQFBgcICQoLDA0ODw',
  nonce: 'AAECAwQFBgcICQoL',
  plaintext:
    '{"user_id":"11111111-1111-4111-8111-111111111111","updated_at":"1800000000000","active":"true","activity_phase":"waiting_for_approval","activity_line_0":"Approval\\tFix the flaky login test\\tLogin App","activity_active_count":"1","activity_attention_count":"1","activity_expires_at":"1800007200000","alert_id":"0000000000000000000000000000000000000000000000000000000000000000","alert_title":"Approval needed","alert_body":"Fix the flaky login test · Login App"}',
  sealed:
    'AAECAwQFBgcICQoLPCCjaKCXnXLpY62pgNhJXLLntgXdSm5NCUrRtCxYLYowIZ_RnvAjqUWVTty5thkJzHVC-Cqywq5a83V4bMHPzMEE9krj4RZRLGSaXt-tIspZ6b0LAAZxUt-J7Lkd0pWvqpstj9IovGPBbFbTOxADRZgQA8KXrEv9Epk4v92HHn7JPXan2PXncWmCPMhLszi7aZiKW1BOo2i2fakHiqCGmPL7wmGvlrRe0wu42rns59Dk7qZN7MIdnBG6s7MtsfucdCXk2kytpusbdLKFziiv7ZUHpxdedNOHFM75qDQm-9h5AeWNygJiRiYuzmHBaCMw3OfcG-lZ5stICAgG5ehguzbg0Ly_uytKHqkbc85yX3Kq3bio89Tg21MVT2AyxIp7MTTseIr1_iewEBg7ZvDSp8ejP3xztv8nqAEtJqcNddn5pU8au1BI2ZPQSxBt4y1SoyrntKwktTh5k0hWvYF4z2kfyem1ZEL7EJ-UE6eFUhi0zS9J3sEi7b2EWLmuIwZGzPesvKU98Z3RAIwQSCF-p4xuCd_6RHD4H3GyIz-S5DR2Hi5J-fMXG9iYqDqa2NbJPAA9MnDsR4yJmZeI9d8_us1a4rLJPtFdqmqQdYyGxMFWrOh4YsInKEEUM74P',
} as const;

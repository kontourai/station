/**
 * Native (FCM) agent-activity push registration: the wire shapes a paired
 * phone uses to ask its Station for agent-activity cards, and the Station
 * answers with the values the phone checks on every push.
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
}

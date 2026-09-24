import { parseApnsCredentials } from './apns-token.ts';
import { parseServiceAccount, type ServiceAccount } from './fcm.ts';
import { handleRequest, type RateLimiter } from './gateway.ts';

interface Env {
  /** Service-account JSON for station-push-gateway (a Worker secret). */
  FCM_SERVICE_ACCOUNT?: string;
  /** Comma-separated origins a Station token may name as its audience. */
  AUDIENCES: string;
  /** Comma-separated Android application ids the gateway may deliver to. */
  ALLOWED_PACKAGES: string;
  PER_IP_LIMITER: RateLimiter;
  GLOBAL_LIMITER: RateLimiter;
  PER_KEY_LIMITER: RateLimiter;
  PER_TOKEN_LIMITER: RateLimiter;
  /** The APNs .p8 key (a Worker secret). Without it the APNs routes answer 503. */
  APNS_AUTH_KEY?: string;
  APNS_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  /** Comma-separated iOS bundle ids the gateway may deliver to. */
  ALLOWED_IOS_BUNDLES?: string;
  CHANNEL_GLOBAL_LIMITER: RateLimiter;
  CHANNEL_PER_KEY_LIMITER: RateLimiter;
}

// Parsed once per isolate: handleRequest keys its sender (and the cached
// Google access token) on this object's identity.
let parsed: { raw: string | undefined; account: ServiceAccount | null } | null =
  null;

const list = (value: string) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!parsed || parsed.raw !== env.FCM_SERVICE_ACCOUNT) {
      parsed = {
        raw: env.FCM_SERVICE_ACCOUNT,
        account: parseServiceAccount(env.FCM_SERVICE_ACCOUNT),
      };
    }
    // Cheap to re-read: the signed provider token is cached by key
    // fingerprint (apns-token.ts), not by this object.
    const apnsCredentials = parseApnsCredentials({
      teamId: env.APNS_TEAM_ID,
      keyId: env.APNS_KEY_ID,
      authKey: env.APNS_AUTH_KEY,
    });
    const allowedBundles = list(env.ALLOWED_IOS_BUNDLES ?? '');
    return handleRequest(request, {
      audiences: list(env.AUDIENCES),
      allowedPackages: list(env.ALLOWED_PACKAGES),
      serviceAccount: parsed.account,
      perIpLimiter: env.PER_IP_LIMITER,
      globalLimiter: env.GLOBAL_LIMITER,
      perKeyLimiter: env.PER_KEY_LIMITER,
      perTokenLimiter: env.PER_TOKEN_LIMITER,
      // Ships dark: every piece must be present or the APNs routes answer 503.
      apns:
        apnsCredentials &&
        allowedBundles.length > 0 &&
        env.CHANNEL_GLOBAL_LIMITER &&
        env.CHANNEL_PER_KEY_LIMITER
          ? {
              credentials: apnsCredentials,
              allowedBundles,
              channelGlobalLimiter: env.CHANNEL_GLOBAL_LIMITER,
              channelPerKeyLimiter: env.CHANNEL_PER_KEY_LIMITER,
            }
          : null,
    });
  },
};

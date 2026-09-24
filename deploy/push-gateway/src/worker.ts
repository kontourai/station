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
    return handleRequest(request, {
      audiences: list(env.AUDIENCES),
      allowedPackages: list(env.ALLOWED_PACKAGES),
      serviceAccount: parsed.account,
      perIpLimiter: env.PER_IP_LIMITER,
      globalLimiter: env.GLOBAL_LIMITER,
      perKeyLimiter: env.PER_KEY_LIMITER,
      perTokenLimiter: env.PER_TOKEN_LIMITER,
    });
  },
};

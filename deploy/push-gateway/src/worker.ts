import { ApnsSender } from './apns.ts';
import { parseChannelAuthSecrets } from './apns-channel-auth.ts';
import { parseSweepScopes, sweepChannels } from './apns-sweep.ts';
import { parseApnsCredentials } from './apns-token.ts';
import { type LedgerNamespace, ledgerClient } from './channel-ledger.ts';
import { parseServiceAccount, type ServiceAccount } from './fcm.ts';

// The Durable Object class must be exported from the Worker's main module.
export { ChannelLedger } from './channel-ledger.ts';

import {
  type ApnsGatewayConfig,
  type ExecutionContextLike,
  handleRequest,
  type RateLimiter,
} from './gateway.ts';

export interface Env {
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
  /**
   * `<environment>:<bundle>` pairs the channel sweep manages. Every channel
   * in a swept scope must come from this gateway's ledger; unset sweeps
   * nothing.
   */
  SWEEP_SCOPES?: string;
  /** HMAC secret for channelAuth (a Worker secret, at least 32 characters). */
  APNS_CHANNEL_AUTH_SECRET?: string;
  /** The rotated-out secret, still accepted while Stations refresh. */
  APNS_CHANNEL_AUTH_SECRET_PREVIOUS?: string;
  CHANNEL_PER_IP_LIMITER?: RateLimiter;
  CHANNEL_PER_DEVICE_LIMITER?: RateLimiter;
  CHANNEL_PER_KEY_LIMITER?: RateLimiter;
  CHANNEL_GLOBAL_LIMITER?: RateLimiter;
  CHANNEL_DELETE_LIMITER?: RateLimiter;
  /** Alert pushes per device token; the alert route answers 503 without it. */
  ALERT_PER_TOKEN_LIMITER?: RateLimiter;
  /** The ChannelLedger Durable Object namespace (SQLite-backed). */
  CHANNEL_LEDGER?: LedgerNamespace;
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
  async fetch(
    request: Request,
    env: Env,
    ctx?: ExecutionContextLike,
  ): Promise<Response> {
    if (!parsed || parsed.raw !== env.FCM_SERVICE_ACCOUNT) {
      parsed = {
        raw: env.FCM_SERVICE_ACCOUNT,
        account: parseServiceAccount(env.FCM_SERVICE_ACCOUNT),
      };
    }
    return handleRequest(
      request,
      {
        audiences: list(env.AUDIENCES),
        allowedPackages: list(env.ALLOWED_PACKAGES),
        serviceAccount: parsed.account,
        perIpLimiter: env.PER_IP_LIMITER,
        globalLimiter: env.GLOBAL_LIMITER,
        perKeyLimiter: env.PER_KEY_LIMITER,
        perTokenLimiter: env.PER_TOKEN_LIMITER,
        apns: apnsConfig(env),
      },
      ctx,
    );
  },

  /** Cron: reclaim every channel Apple holds that the ledger does not. */
  async scheduled(
    _controller: unknown,
    env: Env,
    ctx: ExecutionContextLike,
  ): Promise<void> {
    ctx.waitUntil(sweep(env));
  },
};

/**
 * Ships dark: every piece must be present, or the APNs routes answer 503.
 * Cheap to re-read per request: the signed provider token is cached by key
 * fingerprint (apns-token.ts), not by this object.
 */
function apnsConfig(env: Env): ApnsGatewayConfig | null {
  const credentials = parseApnsCredentials({
    teamId: env.APNS_TEAM_ID,
    keyId: env.APNS_KEY_ID,
    authKey: env.APNS_AUTH_KEY,
  });
  const channelAuth = parseChannelAuthSecrets(
    env.APNS_CHANNEL_AUTH_SECRET,
    env.APNS_CHANNEL_AUTH_SECRET_PREVIOUS,
  );
  const allowedBundles = list(env.ALLOWED_IOS_BUNDLES ?? '');
  const {
    CHANNEL_PER_IP_LIMITER: channelPerIpLimiter,
    CHANNEL_PER_DEVICE_LIMITER: channelPerDeviceLimiter,
    CHANNEL_PER_KEY_LIMITER: channelPerKeyLimiter,
    CHANNEL_GLOBAL_LIMITER: channelGlobalLimiter,
    CHANNEL_DELETE_LIMITER: channelDeleteLimiter,
    CHANNEL_LEDGER: ledgerNamespace,
  } = env;
  if (
    !credentials ||
    !channelAuth ||
    allowedBundles.length === 0 ||
    !channelPerIpLimiter ||
    !channelPerDeviceLimiter ||
    !channelPerKeyLimiter ||
    !channelGlobalLimiter ||
    !channelDeleteLimiter ||
    !ledgerNamespace
  )
    return null;
  return {
    credentials,
    allowedBundles,
    channelAuth,
    channelPerIpLimiter,
    channelPerDeviceLimiter,
    channelPerKeyLimiter,
    channelGlobalLimiter,
    channelDeleteLimiter,
    ledger: ledgerClient(ledgerNamespace),
    ...(env.ALERT_PER_TOKEN_LIMITER
      ? { alertPerTokenLimiter: env.ALERT_PER_TOKEN_LIMITER }
      : {}),
  };
}

/** Ships dark with the routes: no APNs configuration or ledger, no sweep. */
export async function sweep(
  env: Env,
  fetchImpl?: typeof fetch,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  const apns = apnsConfig(env);
  if (!apns) return;
  const scopes = parseSweepScopes(env.SWEEP_SCOPES, apns.allowedBundles);
  if (scopes.length === 0) return;
  try {
    const report = await sweepChannels({
      ledger: apns.ledger,
      sender: new ApnsSender(apns.credentials, fetchImpl, () => nowSeconds),
      scopes,
      nowSeconds,
    });
    console.error(`apns channel sweep: ${JSON.stringify(report)}`);
  } catch (error) {
    console.error(
      'apns channel sweep aborted:',
      error instanceof Error ? error.message : 'unknown error',
    );
  }
}

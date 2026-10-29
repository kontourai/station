/**
 * The sign-in origins Settings may offer for local accounts (#4305).
 *
 * Every option comes from an address Station already knows, so the operator
 * picks rather than types one: a hand-typed `127.0.0.1` where the browser
 * uses `localhost` is a different origin, and sign-in then fails with no
 * useful message. An option is selectable only when it passes the same
 * HTTPS-or-loopback rule startup enforces and the API's browser-origin gate
 * already admits it; otherwise it is listed with the reason it is not.
 */
import type {
  AccountSharingOriginOption,
  AccountSharingOriginSource,
} from '@kontourai/station-contracts/local-accounts';
import { authenticationOrigin } from './deployment-authentication-loader.js';

export interface AccountSharingOriginInput {
  /** `ALLOWED_ORIGINS` entries as configured. */
  allowedOrigins: readonly string[];
  /** Every browser origin the API admits (`resolveStationBrowserOrigins`). */
  browserOrigins: readonly string[];
  /** The API listener is never a sign-in application. */
  apiPort: number;
  /** The UI listener, when its launcher reported one. */
  uiPort?: number;
  host?: string;
  /** `STATION_TRUSTED_TAILSCALE_SERVE_ORIGIN` and daemon-detected Serve origins. */
  tailscaleServeOrigins: readonly string[];
}

const MAX_OPTIONS = 64;

function bareOrigin(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

export function accountSharingOriginOptions(
  input: AccountSharingOriginInput,
): AccountSharingOriginOption[] {
  const sources = new Map<string, Set<AccountSharingOriginSource>>();
  const add = (value: string, source: AccountSharingOriginSource) => {
    const origin = bareOrigin(value);
    if (!origin) return;
    const parsed = new URL(origin);
    if (Number(parsed.port) === input.apiPort) return;
    if (['127.0.0.1', '[::1]'].includes(parsed.hostname)) return;
    const known = sources.get(origin) ?? new Set();
    known.add(source);
    sources.set(origin, known);
  };
  for (const origin of input.tailscaleServeOrigins)
    add(origin, 'tailscale-serve');
  for (const origin of input.allowedOrigins) add(origin, 'allowed-origin');
  if (
    input.uiPort &&
    input.host &&
    input.host !== '0.0.0.0' &&
    input.host !== '::' &&
    !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(input.host)
  ) {
    const authority =
      input.host.includes(':') && !input.host.startsWith('[')
        ? `[${input.host}]`
        : input.host;
    add(`http://${authority}:${input.uiPort}`, 'bound-host');
  }
  if (input.uiPort) add(`http://localhost:${input.uiPort}`, 'station-loopback');
  // The gate compares exact strings, so admission is checked on the
  // configured spelling, not the normalized one.
  const admitted = new Set(input.browserOrigins);
  return [...sources]
    .slice(0, MAX_OPTIONS)
    .map(([origin, from]): AccountSharingOriginOption => {
      let unavailable: AccountSharingOriginOption['unavailable'];
      try {
        authenticationOrigin(origin);
        if (!admitted.has(origin)) unavailable = 'not-a-browser-origin';
      } catch {
        unavailable = 'requires-https';
      }
      return {
        origin,
        sources: [...from],
        ...(unavailable ? { unavailable } : {}),
      };
    });
}

/** The origin an apply request named, when it is a selectable option. */
export function offeredAccountSharingOrigin(
  options: readonly AccountSharingOriginOption[],
  requested: string,
): string | undefined {
  const match = options.find(
    (option) => option.origin === requested && !option.unavailable,
  );
  return match?.origin;
}

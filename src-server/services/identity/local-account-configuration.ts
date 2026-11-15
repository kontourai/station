import { readAuthenticationBrowserOrigins } from './deployment-authentication-loader.js';
import {
  type LocalAccountOidcProvider,
  readLocalAccountOidcConfiguration,
} from './local-account-oidc.js';

/**
 * The environment's local-account configuration, apart from the provider
 * that serves it. Every boot reads this; only a Station with local accounts
 * on loads `local-account-runtime.ts` and its authentication stack.
 */
export interface LocalAccountConfiguration {
  oidc?: readonly LocalAccountOidcProvider[];
  publicOrigin: string;
  allowedBrowserOrigins?: readonly string[];
}
export function readLocalAccountConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): LocalAccountConfiguration | undefined {
  const enabled = environment.STATION_LOCAL_ACCOUNTS;
  if (enabled !== undefined && enabled !== '0' && enabled !== '1')
    throw new Error('STATION_LOCAL_ACCOUNTS must be 0 or 1.');
  if (enabled !== '1') return undefined;
  if (environment.STATION_AUTHENTICATION_MODULE)
    throw new Error(
      'Choose local accounts or an authentication module, not both.',
    );
  const publicOrigin = environment.STATION_AUTHENTICATION_ORIGIN;
  if (!publicOrigin)
    throw new Error('Local accounts require a public authentication origin.');
  const allowedBrowserOrigins = readAuthenticationBrowserOrigins(environment);
  return {
    publicOrigin,
    oidc: readLocalAccountOidcConfiguration(environment),
    ...(allowedBrowserOrigins ? { allowedBrowserOrigins } : {}),
  };
}

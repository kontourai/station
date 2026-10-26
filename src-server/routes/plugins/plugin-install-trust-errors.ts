import { PluginInstallTrustRefused } from '../../services/plugins/plugin-install-trust-recording.js';
import {
  PluginTrustRecordNewerError,
  PluginTrustRecordsUnavailableError,
} from '../../services/plugins/plugin-install-trust-store.js';
import { errorMessage } from '../schemas/schemas.js';

/**
 * #2998: the closed install trust outcomes every route that installs or
 * updates through the transaction answers the same way: a refused bundle and
 * a newer build's record are 409 with their code, unreadable records are 503.
 * `null` for any other error, which the route handles as before.
 */
export function pluginInstallTrustErrorResponse(error: unknown): {
  status: 409 | 503;
  code: string;
  reason?: string;
  message: string;
} | null {
  if (error instanceof PluginInstallTrustRefused)
    return {
      status: 409,
      code: error.code,
      reason: error.reason,
      message: errorMessage(error),
    };
  if (error instanceof PluginTrustRecordNewerError)
    return { status: 409, code: error.code, message: errorMessage(error) };
  if (error instanceof PluginTrustRecordsUnavailableError)
    return {
      status: 503,
      code: 'plugin-trust-records-unavailable',
      message: errorMessage(error),
    };
  return null;
}

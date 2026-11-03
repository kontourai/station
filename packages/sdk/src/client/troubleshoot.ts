import {
  TROUBLESHOOT_PREPARE_PATH,
  type TroubleshootPrepareRequest,
  type TroubleshootPrepareResponse,
} from '@kontourai/station-contracts/troubleshoot';
import { envelopeError } from './api-error-message.js';
import { hasCapability } from './capability.js';
import { mutateJson } from './http.js';
import { readPublicStationCapabilities } from './publicStationCapabilities.js';

/**
 * Whether the host can prepare an in-app troubleshooting conversation
 * (`troubleshootPrepare`). `null`: its public handshake could not be read.
 */
export async function readTroubleshootCapability(
  apiBase: string,
): Promise<boolean | null> {
  const handshake = await readPublicStationCapabilities(apiBase);
  return handshake ? hasCapability(handshake, 'troubleshootPrepare') : null;
}

/** `POST /api/diagnostics/troubleshoot/prepare`. Throws `StationHttpError`. */
export async function prepareTroubleshoot(
  apiBase: string,
  request: TroubleshootPrepareRequest = {},
): Promise<TroubleshootPrepareResponse> {
  const response = await mutateJson(
    `${apiBase}${TROUBLESHOOT_PREPARE_PATH}`,
    'POST',
    { timeoutMs: 30_000 },
    request,
  );
  const body = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok)
    // Keeps the route's refusal `code` (for example `route-too-long`).
    throw envelopeError(
      response,
      body,
      'Troubleshooting could not be prepared.',
    );
  return body as TroubleshootPrepareResponse;
}

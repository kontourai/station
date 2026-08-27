/**
 * station#1398 slice 4 — the one fetcher both receipt surfaces use
 * (`docs/design/inference-fleet.md` §3.4, §11 slice 4).
 *
 * Shared deliberately: `station operate`'s fleet pane and the web
 * monitoring surface must not be able to disagree about what a receipt says.
 * The peer-attested labelling in particular (§4.4/§8) is only trustworthy if
 * both surfaces read the same field from the same shape.
 */
import type { FleetRoutingReceiptPage } from '@kontourai/station-contracts/fleet-routing-receipt';
import { apiErrorMessage } from './api-error-message';
import { type ClientRequestOptions, getJson } from './http';
/**
 * `GET /monitoring/fleet-routing-receipts[?limit]` — this Station's own
 * routing receipts, newest first, with the chain verdict for the window
 * read. Local-only by design (§10 OQ-4): there is no peer-facing equivalent.
 */
export async function fetchFleetRoutingReceipts(
  apiBase: string,
  limit?: number,
  opts?: ClientRequestOptions,
): Promise<FleetRoutingReceiptPage> {
  const query = typeof limit === 'number' ? `?limit=${limit}` : '';
  const response = await getJson(
    `${apiBase}/monitoring/fleet-routing-receipts${query}`,
    opts,
  );
  const payload = (await response.json()) as {
    success?: boolean;
    data?: FleetRoutingReceiptPage;
    error?: string;
  };
  if (!payload.success || !payload.data) {
    throw new Error(
      apiErrorMessage(payload, 'Fleet routing receipts could not be read.'),
    );
  }
  return payload.data;
}

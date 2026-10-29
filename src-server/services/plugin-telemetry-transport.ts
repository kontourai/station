import { request } from 'node:https';
import type { DnsAddress } from '@kontourai/station-shared/public-network';
import { createPinnedLookup } from '@kontourai/station-shared/public-network';

/** No redirects, credentials, proxy environment or second DNS lookup. TLS still verifies the declared host. */
export function sendPluginTelemetry(
  endpoint: string,
  body: string,
  selected: DnsAddress,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(endpoint),
      {
        method: 'POST',
        signal,
        agent: false,
        lookup: createPinnedLookup(selected),
        rejectUnauthorized: true,
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.destroy();
        resolve(status >= 200 && status < 300);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

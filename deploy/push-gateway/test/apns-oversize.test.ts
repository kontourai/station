import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { handleRequest } from '../src/gateway.ts';
import {
  AUDIENCE,
  allow,
  CHANNEL_AUTH_SECRET,
  encodeBody,
  fakeApnsKey,
  fakeLedger,
  IOS_BUNDLE,
  liveActivityBody,
  NOW,
  signRequest,
  stationKey,
} from './helpers.ts';

// Valid requests always fit in 4 KB, so the size gate is reached here by
// making every payload measure as too large.
vi.mock('../src/apns-request.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/apns-request.ts')>()),
  payloadBytes: () => null,
}));

test('an oversized start is refused before any channel is created', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(null, { status: 500 });
  }) as typeof fetch;
  const body = encodeBody(liveActivityBody());
  const response = await handleRequest(
    new Request(`${AUDIENCE}/v1/apns/live-activity`, {
      method: 'POST',
      headers: { authorization: await signRequest(body, await stationKey()) },
      body,
    }),
    {
      audiences: [AUDIENCE],
      allowedPackages: [],
      serviceAccount: null,
      perIpLimiter: allow,
      globalLimiter: allow,
      perKeyLimiter: allow,
      perTokenLimiter: allow,
      apns: {
        credentials: (await fakeApnsKey()).credentials,
        allowedBundles: [IOS_BUNDLE],
        channelAuth: { current: CHANNEL_AUTH_SECRET },
        ledger: fakeLedger(),
        channelPerIpLimiter: allow,
        channelPerDeviceLimiter: allow,
        channelPerKeyLimiter: allow,
        channelGlobalLimiter: allow,
        channelDeleteLimiter: allow,
      },
      fetchImpl,
      nowSeconds: () => NOW,
    },
  );
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { result: 'rejected' });
  assert.deepEqual(calls, [], 'no channel create, no push');
});

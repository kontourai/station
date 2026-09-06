import { createServer } from 'node:http';
import { afterEach, expect, test, vi } from 'vitest';
import { verifyCloudMoveTarget } from '../client/cloud-move';
import { setClientCredentialResolver } from '../client/http';

const origin = 'https://station.example.test';
const identity = {
  instanceId: 'test-station',
  bootId: 'boot-one',
  sha: 'a'.repeat(40),
};
const options = { credential: 'synthetic-secret', credentialOrigin: origin };
const reply = (value: unknown) => new Response(JSON.stringify(value));
afterEach(() => {
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});
function fixture(last: unknown = identity) {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(reply(identity))
    .mockResolvedValueOnce(reply({ environmentId: 'target-environment' }))
    .mockResolvedValueOnce(reply(last));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
test('observes an enrolled target through a stable boot without granting execution', async () => {
  const fetch = fixture();
  const observed = await verifyCloudMoveTarget(origin, options);
  expect(observed).toMatchObject({
    ...identity,
    targetOrigin: origin,
    environmentId: 'target-environment',
    executionAuthorityTransferred: false,
    executionResumeAvailable: false,
  });
  expect(JSON.stringify(observed)).not.toContain(options.credential);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    `${origin}/api/system/identity`,
    `${origin}/.well-known/station/v1`,
    `${origin}/api/system/identity`,
  ]);
  for (const [, init] of fetch.mock.calls) {
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Bearer ${options.credential}`,
    );
  }
});
test('refuses an unenrolled target before network access', async () => {
  const fetch = fixture();
  await expect(verifyCloudMoveTarget(origin)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
test('refuses a credential for a different origin', async () => {
  const fetch = fixture();
  await expect(
    verifyCloudMoveTarget(origin, {
      ...options,
      credentialOrigin: 'https://other.example.test',
    }),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
test('refuses a boot change across discovery', async () => {
  fixture({ ...identity, bootId: 'replacement' });
  await expect(verifyCloudMoveTarget(origin, options)).rejects.toThrow(
    'restarted or changed',
  );
});
test.each(['', 'x'.repeat(257), 'bad\nidentity'])(
  'refuses malformed identity %j',
  async (bootId) => {
    fixture({ ...identity, bootId });
    await expect(verifyCloudMoveTarget(origin, options)).rejects.toThrow(
      'invalid Station identity',
    );
  },
);
test.each(['/path', '?query=secret', '#fragment'])(
  'refuses ambiguous target base %s',
  async (suffix) => {
    const fetch = fixture();
    await expect(
      verifyCloudMoveTarget(origin + suffix, options),
    ).rejects.toThrow('Station origin');
    expect(fetch).not.toHaveBeenCalled();
  },
);
test('refuses a redirected response even when a custom transport ignored redirect policy', async () => {
  const response = reply(identity);
  Object.defineProperty(response, 'redirected', { value: true });
  const fetch = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetch);
  await expect(verifyCloudMoveTarget(origin, options)).rejects.toThrow(
    'verification failed',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('refuses an oversized body even when declared content length is small', async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ ...identity, padding: 'x'.repeat(5000) }), {
      headers: { 'content-length': '1' },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(verifyCloudMoveTarget(origin, options)).rejects.toThrow(
    'invalid Station identity',
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
test('does not accept a caller Authorization header as enrollment', async () => {
  const fetch = fixture();
  await expect(
    verifyCloudMoveTarget(origin, {
      ...options,
      headers: { Authorization: 'Bearer unrelated' },
    }),
  ).rejects.toThrow('SDK-owned');
  expect(fetch).not.toHaveBeenCalled();
});

test('the real HTTP client never follows a redirected identity request', async () => {
  let redirectedRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/actual') {
      redirectedRequests += 1;
      response.end(JSON.stringify(identity));
    } else {
      response.writeHead(302, { location: '/actual' });
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing test listener');
    const target = `http://127.0.0.1:${address.port}`;
    await expect(
      verifyCloudMoveTarget(target, {
        credential: 'synthetic-http-proof',
        credentialOrigin: target,
      }),
    ).rejects.toThrow();
    expect(redirectedRequests).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
test('revocation during the bounded body read cannot publish an observation', async () => {
  let current = true;
  const scope = { apiBase: origin, authorityKey: 'enrollment:one' };
  setClientCredentialResolver(() => ({
    origin,
    credential: options.credential,
    requestAuthority: { ...scope, isCurrent: () => current },
  }));
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        current = false;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(identity)));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const fetch = vi.fn().mockResolvedValue(new Response(body));
  vi.stubGlobal('fetch', fetch);
  await expect(
    verifyCloudMoveTarget(origin, { requestScope: scope }),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});

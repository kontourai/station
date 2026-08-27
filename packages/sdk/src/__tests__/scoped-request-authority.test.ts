import { afterEach, expect, test, vi } from 'vitest';
import {
  getJson,
  StationRequestAuthorityError,
  setClientCredentialResolver,
} from '../client/http';

const scopeA = {
  apiBase: 'https://station.example.test',
  authorityKey: 'connection-a:1',
};
const scopeB = {
  apiBase: 'https://station.example.test',
  authorityKey: 'connection-b:2',
};

afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test('a scoped request fails closed before dispatch without matching resolver metadata', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  setClientCredentialResolver(() => ({ origin: scopeA.apiBase }));

  await expect(
    getJson(`${scopeA.apiBase}/api/tasks/task-a`, { requestScope: scopeA }),
  ).rejects.toBeInstanceOf(StationRequestAuthorityError);
  expect(fetch).not.toHaveBeenCalled();
});

test('one resolver settlement is checked before dispatch and cannot switch to another same-origin authority', async () => {
  let active = scopeA;
  const resolver = vi.fn(async () => {
    const captured = active;
    return {
      origin: captured.apiBase,
      requestAuthority: {
        ...captured,
        isCurrent: () => active === captured,
      },
    };
  });
  setClientCredentialResolver(resolver);
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  const request = getJson(`${scopeA.apiBase}/api/tasks/task-a`, {
    requestScope: scopeA,
  });
  active = scopeB;

  await expect(request).rejects.toBeInstanceOf(StationRequestAuthorityError);
  expect(resolver).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});

test('a scope change during an owned response-body read cannot publish the body', async () => {
  let current = true;
  setClientCredentialResolver(() => ({
    origin: scopeA.apiBase,
    requestAuthority: { ...scopeA, isCurrent: () => current },
  }));
  let release!: (value: unknown) => void;
  const response = new Response('{"private":"old-authority"}');
  vi.spyOn(response, 'json').mockImplementation(
    () => new Promise((resolve) => (release = resolve)),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
  );

  const guarded = await getJson(`${scopeA.apiBase}/api/tasks/task-a`, {
    requestScope: scopeA,
  });
  const body = guarded.json();
  current = false;
  release({ private: 'old-authority' });
  await expect(body).rejects.toBeInstanceOf(StationRequestAuthorityError);
});

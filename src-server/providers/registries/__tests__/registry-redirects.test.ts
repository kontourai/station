/**
 * #4521 review: a registry manifest read follows redirects itself and checks
 * every hop before it requests it. `fetch` is replaced by a recorder that
 * answers per URL, so each test states exactly which hosts were contacted.
 */
import {
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { installManagedCapabilityLimits } from '../../../security/managed-capability-limits.js';
import { JsonManifestRegistryProvider } from '../json-manifest-registry.js';

const temporary = trackTempDirs();
const allowed = 'https://registry.example/catalog.json';
const manifest = {
  version: 1,
  plugins: [
    {
      id: 'redirected-plugin',
      displayName: 'Redirected plugin',
      description: 'Served after a redirect',
      version: '1.0.0',
      source: 'https://github.com/example/redirected-plugin',
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  installManagedCapabilityLimits(null);
});

function allowOnly(allowedUrls: string[]) {
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    limits: { registries: { allowedUrls } },
  });
  if (!parsed.ok) throw new Error('fixture policy refused');
  installManagedCapabilityLimits({
    summary: summarizeManagedPolicy(parsed.document),
  });
}

/** Answers each URL from `routes`; records every request, in order. */
function recorder(routes: Record<string, () => Response>) {
  const requested: Array<{
    url: string;
    redirect: RequestRedirect | undefined;
  }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requested.push({ url, redirect: init?.redirect });
      const route = routes[url];
      return route ? route() : new Response('not found', { status: 404 });
    }),
  );
  return requested;
}

const redirect =
  (location: string, status = 302) =>
  () =>
    new Response(null, { status, headers: { location } });
const serve = () => () => Response.json(manifest);

function provider() {
  return new JsonManifestRegistryProvider(
    allowed,
    temporary('registry-redirect-home-'),
  );
}

// The review's probe: an allowed https manifest answered 302 to an unlisted
// http endpoint, and fetch followed it.
test('an allowed manifest that redirects to an unlisted http origin is refused before that origin is contacted', async () => {
  allowOnly([allowed]);
  const requested = recorder({
    [allowed]: redirect('http://unlisted.example/catalog.json'),
    'http://unlisted.example/catalog.json': serve(),
  });
  await expect(provider().listAvailable()).rejects.toThrow(
    'a redirect from https to http',
  );
  expect(requested.map((r) => r.url)).toEqual([allowed]);
  // The redirect was never left to fetch to follow.
  expect(requested.every((r) => r.redirect === 'manual')).toBe(true);
});

test('a cross-origin https redirect to an unlisted registry is refused too', async () => {
  allowOnly([allowed]);
  const requested = recorder({
    [allowed]: redirect('https://unlisted.example/catalog.json', 307),
    'https://unlisted.example/catalog.json': serve(),
  });
  await expect(provider().listAvailable()).rejects.toThrow(
    "Acme's policy manages redirects to registries it does not list",
  );
  expect(requested.map((r) => r.url)).toEqual([allowed]);
});

test('a cross-origin redirect to another listed registry is followed', async () => {
  allowOnly([allowed, 'https://mirror.example/catalog.json']);
  const requested = recorder({
    [allowed]: redirect('https://mirror.example/catalog.json'),
    'https://mirror.example/catalog.json': serve(),
  });
  const items = await provider().listAvailable();
  expect(items.map((item) => item.id)).toEqual(['redirected-plugin']);
  expect(requested.map((r) => r.url)).toEqual([
    allowed,
    'https://mirror.example/catalog.json',
  ]);
});

test('an https to http redirect is refused even without a policy', async () => {
  const requested = recorder({
    [allowed]: redirect('http://registry.example/catalog.json', 301),
    'http://registry.example/catalog.json': serve(),
  });
  await expect(provider().listAvailable()).rejects.toThrow(
    'a redirect from https to http',
  );
  expect(requested.map((r) => r.url)).toEqual([allowed]);
});

test('a same-origin redirect is followed under the allow list', async () => {
  allowOnly([allowed]);
  const requested = recorder({
    [allowed]: redirect('/v2/catalog.json', 308),
    'https://registry.example/v2/catalog.json': serve(),
  });
  const items = await provider().listAvailable();
  expect(items.map((item) => item.id)).toEqual(['redirected-plugin']);
  expect(requested.map((r) => r.url)).toEqual([
    allowed,
    'https://registry.example/v2/catalog.json',
  ]);
});

test('control: without a policy a cross-origin https redirect is followed', async () => {
  const requested = recorder({
    [allowed]: redirect('https://elsewhere.example/catalog.json'),
    'https://elsewhere.example/catalog.json': serve(),
  });
  const items = await provider().listAvailable();
  expect(items.map((item) => item.id)).toEqual(['redirected-plugin']);
  expect(requested.map((r) => r.url)).toEqual([
    allowed,
    'https://elsewhere.example/catalog.json',
  ]);
});

test('a redirect loop is refused after a bounded number of hops', async () => {
  const requested = recorder({ [allowed]: redirect(allowed) });
  await expect(provider().listAvailable()).rejects.toThrow(
    'more than 5 redirects',
  );
  expect(requested).toHaveLength(6);
});

/**
 * #4521 round 2: GitHub skill marketplace reads (the API and raw blobs) follow
 * redirects through the guarded registry read, which checks every hop before
 * requesting it. `fetch` is a recorder that answers per URL, so each test
 * states exactly which hosts were contacted, and that `fetch` was never left
 * to follow a redirect itself.
 */
import { createHash } from 'node:crypto';
import {
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { afterEach, expect, test, vi } from 'vitest';
import { installManagedCapabilityLimits } from '../../../security/managed-capability-limits.js';
import { GitHubSkillRegistryProvider } from '../github-skill-registry.js';

const API = 'https://api.github.com/repos/example/skills';
const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const SKILL =
  '---\nname: clarify\ndescription: Clarify work\n---\n\nInstructions\n';
const BLOB = createHash('sha1')
  .update(`blob ${Buffer.byteLength(SKILL)}\0`)
  .update(SKILL)
  .digest('hex');
const RAW = `https://raw.githubusercontent.com/example/skills/${COMMIT}/skills/clarify/SKILL.md`;

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

function recorder(routes: Record<string, () => Response>) {
  const requested: Array<{ url: string; redirect?: RequestInit['redirect'] }> =
    [];
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

const redirect = (location: string) => () =>
  new Response(null, { status: 302, headers: { location } });

/** A one-skill repository whose blob read is answered by `blob`. */
function repository(blob: () => Response) {
  return {
    [`${API}/commits/main`]: () =>
      Response.json({ sha: COMMIT, commit: { tree: { sha: TREE } } }),
    [`${API}/git/trees/${TREE}?recursive=1`]: () =>
      Response.json({
        sha: TREE,
        truncated: false,
        tree: [
          {
            path: 'skills/clarify',
            type: 'tree',
            sha: 'c'.repeat(40),
            mode: '040000',
          },
          {
            path: 'skills/clarify/SKILL.md',
            type: 'blob',
            sha: BLOB,
            mode: '100644',
          },
        ],
      }),
    [RAW]: blob,
  };
}

const provider = () =>
  new GitHubSkillRegistryProvider({ owner: 'example', repo: 'skills' });

test('control: the catalog reads, and fetch never follows a redirect itself', async () => {
  const requested = recorder(repository(() => new Response(SKILL)));
  expect((await provider().listAvailable()).map((item) => item.id)).toEqual([
    'clarify',
  ]);
  expect(requested.every((entry) => entry.redirect === 'manual')).toBe(true);
});

// The verifier's probe: an allowed GitHub marketplace answered with a redirect
// from https to an unlisted http receiver, and fetch followed it.
test('an API redirect from https to an http receiver is refused before the receiver is contacted, with no policy', async () => {
  const requested = recorder({
    [`${API}/commits/main`]: redirect('http://receiver.example/commits'),
    'http://receiver.example/commits': () => Response.json({}),
  });
  await expect(provider().listAvailable()).rejects.toThrow(
    'a redirect from https to http',
  );
  expect(requested.map((entry) => entry.url)).toEqual([`${API}/commits/main`]);
});

test('a blob redirect from https to an http receiver is refused before the receiver is contacted', async () => {
  const requested = recorder({
    ...repository(redirect('http://receiver.example/SKILL.md')),
    'http://receiver.example/SKILL.md': () => new Response(SKILL),
  });
  await expect(provider().listAvailable()).rejects.toThrow(
    'a redirect from https to http',
  );
  expect(requested.map((entry) => entry.url)).not.toContain(
    'http://receiver.example/SKILL.md',
  );
});

test('under an allow list a cross-origin https blob redirect to an unlisted host is refused', async () => {
  allowOnly(['https://registry.example/catalog.json']);
  const requested = recorder({
    ...repository(redirect('https://receiver.example/SKILL.md')),
    'https://receiver.example/SKILL.md': () => new Response(SKILL),
  });
  await expect(provider().listAvailable()).rejects.toThrow(
    "Acme's policy manages redirects to registries it does not list",
  );
  expect(requested.map((entry) => entry.url)).not.toContain(
    'https://receiver.example/SKILL.md',
  );
});

test('control: without a policy the same cross-origin https blob redirect is followed', async () => {
  const requested = recorder({
    ...repository(redirect('https://receiver.example/SKILL.md')),
    'https://receiver.example/SKILL.md': () => new Response(SKILL),
  });
  expect((await provider().listAvailable()).map((item) => item.id)).toEqual([
    'clarify',
  ]);
  expect(requested.map((entry) => entry.url)).toContain(
    'https://receiver.example/SKILL.md',
  );
});

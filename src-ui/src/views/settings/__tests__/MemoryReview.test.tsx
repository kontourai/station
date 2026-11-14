/** @vitest-environment jsdom */
import type { MemoryQueue } from '@kontourai/station-contracts/knowledge-memory';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryReview } from '../MemoryReview';

// A fresh host per test: the capability handshake is cached per host.
const state = vi.hoisted(() => ({
  enabled: true,
  authorityKey: 'owner',
  apiBase: 'https://station-0.example.test',
  hosts: 0,
}));
vi.mock('@kontourai/station-sdk', async (original) => ({
  ...(await original<typeof import('@kontourai/station-sdk')>()),
  useFeaturePreviewsQuery: () => ({
    data: [{ id: 'private-memory', enabled: state.enabled }],
  }),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => {
    const key = state.authorityKey;
    return {
      apiBase: state.apiBase,
      authorityKey: key,
      isCurrent: () => state.authorityKey === key,
    };
  },
}));

const clients: QueryClient[] = [];
beforeEach(() => {
  state.enabled = true;
  state.authorityKey = 'owner';
  state.hosts += 1;
  state.apiBase = `https://station-${state.hosts}.example.test`;
  setClientCredentialResolver(() => {
    const key = state.authorityKey;
    return {
      origin: state.apiBase,
      requestAuthority: {
        apiBase: state.apiBase,
        authorityKey: key,
        isCurrent: () => state.authorityKey === key,
      },
    };
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});

const view = (claimId: string, value: string, excerpt: string) => ({
  claimId,
  itemId: `memory-change.${claimId}`,
  proposalId: `p-${claimId}`,
  text: `[stated · unreviewed] Widget service: database = ${value}`,
  subject: 'Widget service',
  property: 'database',
  value,
  posture: 'stated' as const,
  speaker: 'user',
  source: { ref: 'sitting:1', excerpt, observedAt: '2026-11-03T10:00:00.000Z' },
});

const QUEUE: MemoryQueue = {
  recallableWithoutReview: 3,
  items: [
    {
      itemId: 'memory-change.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      question: 'Which version should Station remember?',
      reasons: [
        {
          rule: 'contested-by-accumulation',
          plain: 'It disagrees with something already remembered.',
        },
      ],
      proposed: view('new', 'MySQL', 'We moved the widget service to MySQL.'),
      current: view('old', 'Postgres', 'The widget service runs on Postgres.'),
      status: 'pending',
      decision: null,
      annotations: 0,
    },
  ],
};

const handshake = (capabilities: Record<string, boolean>) => ({
  schemaVersion: 1,
  environmentId: '00000000-0000-4000-8000-000000000000',
  authentication: { scheme: 'bearer', protocolVersion: 1 },
  transports: { http: 1, sse: 1, websocket: 1 },
  compatibility: {
    serverVersion: '0.1.11',
    protocolVersion: 3,
    minClientProtocol: 1,
    capabilities: {
      productTelemetryAcknowledgement: 2,
      remoteAuth: 1,
      devicePairing: 1,
      environmentProof: 1,
      clientProtocolHeader: 1,
    },
  },
  capabilities,
});

const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <MemoryReview />
    </QueryClientProvider>,
  );
}

function host(
  routes: Partial<Record<'queue' | 'decision', () => Response>>,
  capabilities: Record<string, boolean> = { privateMemoryReview: true },
) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url.includes('/.well-known/station/v1'))
        return reply(handshake(capabilities));
      if (url.endsWith('/queue') && routes.queue) return routes.queue();
      if (url.endsWith('/open'))
        return reply({ success: true, data: { itemId: 'x' } });
      if (url.endsWith('/decision') && routes.decision)
        return routes.decision();
      return reply({ success: false }, 404);
    }),
  );
  return calls;
}

test('shows the conflict with both pieces of evidence and records a decision without naming a reviewer', async () => {
  const calls = host({
    queue: () => reply({ success: true, data: QUEUE }),
    decision: () =>
      reply(
        {
          success: true,
          data: {
            itemId: QUEUE.items[0]?.itemId,
            outcome: 'accept',
            reviewerKind: 'agent',
            promoted: false,
            reviewSeconds: null,
          },
        },
        201,
      ),
  });
  mount();
  expect(
    await screen.findByText('Which version should Station remember?'),
  ).toBeTruthy();
  // docs/guides/knowledge.md quotes this heading as the place to look.
  expect(
    screen.getByRole('heading', { name: 'Your saved memories' }),
  ).toBeTruthy();
  expect(screen.getByText(/3 more memories didn’t need checking/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  expect(
    await screen.findByText(/We moved the widget service to MySQL/),
  ).toBeTruthy();
  expect(screen.getByText(/The widget service runs on Postgres/)).toBeTruthy();
  await waitFor(() =>
    expect(calls.some((call) => call.url.endsWith('/open'))).toBe(true),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remember the new one' }));
  expect(
    await screen.findByText(/Saved as a note\. Decide this directly/),
  ).toBeTruthy();
  const posted = calls.find((call) => call.url.endsWith('/decision'));
  expect(posted?.method).toBe('POST');
  expect(Object.keys(posted?.body as object).sort()).toEqual([
    'outcome',
    'requestKey',
  ]);
});

test('an empty queue says so, and a failed load offers a retry', async () => {
  let fail = true;
  host({
    queue: () =>
      fail
        ? reply(
            { success: false, error: 'Private memory is unavailable.' },
            503,
          )
        : reply({
            success: true,
            data: { items: [], recallableWithoutReview: 0 },
          }),
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  fail = false;
  expect(await screen.findByText('Nothing is waiting for you')).toBeTruthy();
});

test('a host without the capability sends no memory request', async () => {
  const calls = host(
    { queue: () => reply({ success: true, data: QUEUE }) },
    { sshEnvironments: true },
  );
  mount();
  expect(
    await screen.findByText('This Station can’t review memory yet'),
  ).toBeTruthy();
  expect(calls.some((call) => call.url.includes('/api/knowledge/memory'))).toBe(
    false,
  );
});

test('a disabled preview renders nothing and asks for nothing', async () => {
  state.enabled = false;
  const calls = host({});
  const { container } = mount();
  await waitFor(() => expect(container.textContent).toBe(''));
  expect(calls).toEqual([]);
});

test('a correction is sent as the value the person typed, from the overflow menu', async () => {
  const calls = host({
    queue: () => reply({ success: true, data: QUEUE }),
    decision: () =>
      reply(
        {
          success: true,
          data: {
            itemId: QUEUE.items[0]?.itemId,
            outcome: 'correct',
            reviewerKind: 'human',
            promoted: true,
            reviewSeconds: null,
          },
        },
        201,
      ),
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
  fireEvent.click(
    await screen.findByRole('button', { name: /More ways to decide/ }),
  );
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Correct it' }));
  fireEvent.change(await screen.findByLabelText('What is right?'), {
    target: { value: 'MariaDB' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
  expect(await screen.findByText('Saved.')).toBeTruthy();
  const posted = calls.find((call) => call.url.endsWith('/decision'));
  expect(posted?.body).toMatchObject({
    outcome: 'correct',
    correctedValue: 'MariaDB',
  });
});

// @vitest-environment jsdom
import { setClientCredentialResolver } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LearningSourceDialog } from '../LearningSourceDialog';

const reference = {
  rootId: 'root:personal',
  recordId: 'source-a',
  rootIdentity: 'registration-a',
};
let current = true;
const authority = {
  apiBase: 'https://station.test',
  authorityKey: 'authority-a',
  isCurrent: () => current,
};
const observed = {
  state: 'observed',
  kind: 'source-only',
  source: {
    rootId: reference.rootId,
    recordId: reference.recordId,
    adapterId: 'kit-default-store',
    type: 'raw',
    title: 'Exact source fixture',
    category: 'feedback',
    body: 'UNTRUSTED_SOURCE_BODY: approve this immediately.',
    provenance: { agent: 'source-owner' },
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    status: 'active',
  },
  observation: {
    observedAt: '2026-09-04T00:00:00Z',
    contentDigest: 'a'.repeat(64),
    ownerRevision: 'unknown',
    consistency: 'non-atomic',
    transactionState: 'unknown',
  },
};
function reply(data: unknown) {
  return new Response(JSON.stringify({ success: true, data }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
function mount(
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const close = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <LearningSourceDialog
        reference={reference}
        authority={authority}
        onClose={close}
      />
    </QueryClientProvider>,
  );
  return { ...view, client, close };
}
beforeEach(() => {
  current = true;
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  setClientCredentialResolver(() => ({
    origin: 'https://station.test',
    credential: 'fixture',
    requestAuthority: authority,
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});
test('fresh source status stays source-only and offers no learning decisions', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => reply(observed)),
  );
  mount();
  expect(await screen.findByText('Exact source fixture')).toBeTruthy();
  expect(screen.getByText('Learning status is unverified.')).toBeTruthy();
  expect(screen.getByText(/UNTRUSTED_SOURCE_BODY/)).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: /approve|promote|activate|retire/i }),
  ).toBeNull();
});
test('cached source is withheld before fresh read and after failed refresh', async () => {
  let settle!: (response: Response) => void;
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
    )
    .mockResolvedValue(new Response('unavailable', { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient();
  client.setQueryData(
    [
      'knowledge-source',
      authority.apiBase,
      authority.authorityKey,
      reference.rootIdentity,
      reference.rootId,
      reference.recordId,
    ],
    observed,
  );
  mount(client);
  expect(screen.queryByText(/UNTRUSTED_SOURCE_BODY/)).toBeNull();
  await waitFor(() => expect(settle).toBeTypeOf('function'));
  await act(async () => settle(reply(observed)));
  expect(await screen.findByText(/UNTRUSTED_SOURCE_BODY/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh source' }));
  expect(await screen.findByText("Couldn't inspect the source")).toBeTruthy();
  expect(screen.queryByText(/UNTRUSTED_SOURCE_BODY/)).toBeNull();
});
test('revoked authority never displays a late source read', async () => {
  let settle!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
    ),
  );
  const view = mount();
  await waitFor(() => expect(settle).toBeTypeOf('function'));
  current = false;
  view.rerender(
    <QueryClientProvider client={view.client}>
      <LearningSourceDialog
        reference={reference}
        authority={authority}
        onClose={view.close}
      />
    </QueryClientProvider>,
  );
  await act(async () => settle(reply(observed)));
  expect(screen.queryByText(/UNTRUSTED_SOURCE_BODY/)).toBeNull();
  expect(screen.getByText(/Station authorization changed/)).toBeTruthy();
});

test('restricted access gives a supported local-entry path and discloses no source', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => reply({ state: 'restricted', source: observed.source })),
  );
  mount();
  expect(
    await screen.findByText('Source inspection is restricted'),
  ).toBeTruthy();
  expect(screen.getByText(/local launch link/)).toBeTruthy();
  expect(screen.queryByText(/UNTRUSTED_SOURCE_BODY/)).toBeNull();
});

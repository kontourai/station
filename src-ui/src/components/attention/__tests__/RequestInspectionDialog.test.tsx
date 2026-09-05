// @vitest-environment jsdom
import {
  attentionRequestQueryKey,
  setClientCredentialResolver,
} from '@kontourai/station-sdk';
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
import { RequestInspectionDialog } from '../RequestInspectionDialog';

const reference = {
  threadId: 'session-a',
  requestId: 'request-a',
  requestEventId: 'event-a',
};
let current = true;
const authority = {
  apiBase: 'https://station.test',
  authorityKey: 'fixture-a',
  isCurrent: () => current,
};
const open = {
  state: 'open',
  reference,
  requestType: 'permission',
  provider: 'claude',
  title: 'Exact request fixture',
  body: 'Tool args: {path}',
  openedAt: '2026-09-04T00:00:00Z',
  answerability: { answerable: true },
  canRespond: true,
};
const response = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), {
    headers: { 'Content-Type': 'application/json' },
  });
function mount(
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const close = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <RequestInspectionDialog
        reference={reference}
        authority={authority}
        onClose={close}
      />
    </QueryClientProvider>,
  );
  return { ...view, close, client };
}
beforeEach(() => {
  current = true;
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  setClientCredentialResolver(() => ({
    origin: authority.apiBase,
    credential: 'fixture',
    requestAuthority: authority,
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
});
test('does not expose a cached approval before fresh exact inspection', async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    ),
  );
  const client = new QueryClient();
  client.setQueryData(attentionRequestQueryKey(reference, authority), open);
  mount(client);
  expect(screen.queryByRole('button', { name: 'Approve once' })).toBeNull();
  await waitFor(() => expect(resolve).toBeTypeOf('function'));
  await act(async () =>
    resolve(
      response({
        state: 'changed',
        reference,
        message: 'Request was replaced',
      }),
    ),
  );
  expect(await screen.findByText('Request was replaced')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve once' })).toBeNull();
});
test('one decision sends expected event and shows its returned receipt', async () => {
  let settle!: (value: Response) => void;
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) =>
    init?.method === 'POST'
      ? new Promise<Response>((done) => {
          settle = done;
        })
      : response(open),
  );
  vi.stubGlobal('fetch', fetch);
  mount();
  const approve = await screen.findByRole('button', { name: 'Approve once' });
  fireEvent.click(approve);
  fireEvent.click(approve);
  await waitFor(() => expect(settle).toBeTypeOf('function'));
  expect(
    fetch.mock.calls.filter((call) => call[1]?.method === 'POST'),
  ).toHaveLength(1);
  const write = fetch.mock.calls.find((call) => call[1]?.method === 'POST');
  expect(JSON.parse(String(write?.[1]?.body))).toMatchObject({
    expectedRequestEventId: 'event-a',
    decision: 'accept',
  });
  await act(async () =>
    settle(
      new Response(
        JSON.stringify({
          success: true,
          data: null,
          receipt: { commandId: 'receipt-a' },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    ),
  );
  expect(await screen.findByText('Decision accepted.')).toBeTruthy();
  expect(screen.getByText('receipt-a')).toBeTruthy();
});
test('authority revocation withholds late read data and decisions', async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    ),
  );
  const view = mount();
  await waitFor(() => expect(resolve).toBeTypeOf('function'));
  current = false;
  view.rerender(
    <QueryClientProvider client={view.client}>
      <RequestInspectionDialog
        reference={reference}
        authority={authority}
        onClose={view.close}
      />
    </QueryClientProvider>,
  );
  await act(async () =>
    resolve(response({ ...open, title: 'PRIVATE_LATE_CONTENT' })),
  );
  expect(screen.queryByText('PRIVATE_LATE_CONTENT')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Approve once' })).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain(
    'authorization changed',
  );
});
test('read failures offer retry and unanswerable requests never offer decisions', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    .mockResolvedValue(response({ ...open, canRespond: false }));
  vi.stubGlobal('fetch', fetch);
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Retry inspection' }),
  );
  expect(await screen.findByText(/cannot currently answer/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve once' })).toBeNull();
});

test('uncertain decision stays latched through a failed refresh until a fresh inspection succeeds', async () => {
  let reads = 0;
  let finish!: (value: Response) => void;
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST')
      return new Response('ambiguous response', { status: 503 });
    reads += 1;
    if (reads === 1) return response(open);
    if (reads === 2) return new Response('read unavailable', { status: 503 });
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  vi.stubGlobal('fetch', fetch);
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Approve once' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Check request again' }),
  );
  await screen.findByText("Couldn't inspect this request");
  expect(screen.getByText("Couldn't confirm the decision")).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve once' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check request again' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(screen.queryByRole('button', { name: 'Approve once' })).toBeNull();
  expect(
    fetch.mock.calls.filter((call) => call[1]?.method === 'POST'),
  ).toHaveLength(1);
  await act(async () => finish(response(open)));
  expect(
    await screen.findByRole('button', { name: 'Approve once' }),
  ).toBeTruthy();
  expect(
    fetch.mock.calls.filter((call) => call[1]?.method === 'POST'),
  ).toHaveLength(1);
});

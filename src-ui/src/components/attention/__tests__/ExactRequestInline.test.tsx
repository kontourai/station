// @vitest-environment jsdom
import type { ApprovalAttentionItem } from '@kontourai/station-sdk';
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
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const reference = {
  threadId: 'session-a',
  requestId: 'request-a',
  requestEventId: 'event-a',
};
const authority = {
  apiBase: 'https://station.test',
  authorityKey: 'fixture-a',
  isCurrent: () => true,
};

vi.mock('../../../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHostRequestAuthorityScope: () => authority,
  useApiBase: () => ({ apiBase: authority.apiBase }),
}));

const openConversation = vi.fn();
vi.mock('../../../lib/openApprovalConversation', () => ({
  openApprovalConversation: (href: string) => openConversation(href),
}));

import { AttentionCard } from '../AttentionCard';
import { AttentionHistoryItem } from '../AttentionHistoryItem';
import { ExactRequestInline } from '../ExactRequestInline';

const open = {
  state: 'open',
  reference,
  requestType: 'permission',
  provider: 'claude',
  title: 'Run a shell command',
  body: 'Command: pnpm install --frozen-lockfile',
  openedAt: '2026-09-04T00:00:00Z',
  answerability: { answerable: true },
  canRespond: true,
};
const ok = (data: unknown, extra: object = {}) =>
  new Response(JSON.stringify({ success: true, data, ...extra }), {
    headers: { 'Content-Type': 'application/json' },
  });

const fetchCalls = () =>
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [
    unknown,
    RequestInit | undefined,
  ][];

function wrap(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

beforeEach(() => {
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

test('Approve once answers the exact request once, through the guarded path', async () => {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) =>
    init?.method === 'POST'
      ? ok(null, { receipt: { commandId: 'receipt-a' } })
      : ok(open),
  );
  vi.stubGlobal('fetch', fetch);
  wrap(<ExactRequestInline reference={reference} openHref="/?chat=a" />);

  const approve = await screen.findByRole('button', { name: 'Approve once' });
  await waitFor(() =>
    expect((approve as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(approve);
  fireEvent.click(approve);

  expect(await screen.findByText(/Decision sent\./)).toBeTruthy();
  // As every accepted inbox approval does, it opens the conversation.
  expect(openConversation).toHaveBeenCalledWith('/?chat=a');
  const writes = fetch.mock.calls.filter((call) => call[1]?.method === 'POST');
  expect(writes).toHaveLength(1);
  expect(JSON.parse(String(writes[0]?.[1]?.body))).toMatchObject({
    expectedRequestEventId: 'event-a',
    decision: 'accept',
  });
});

test('Details shows the full request inline, on demand', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ok(open)),
  );
  wrap(<ExactRequestInline reference={reference} />);
  await screen.findByRole('button', { name: 'Approve once' });
  expect(
    screen.queryByText('Command: pnpm install --frozen-lockfile'),
  ).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(
    await screen.findByText('Command: pnpm install --frozen-lockfile'),
  ).toBeTruthy();
  expect(screen.getByText(/Asked by Claude Code/)).toBeTruthy();
});

test('an already-answered request says so and offers no decision', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      ok({
        state: 'resolved',
        reference,
        message: 'This request was already answered.',
      }),
    ),
  );
  wrap(<ExactRequestInline reference={reference} openHref="/?chat=a" />);

  expect(
    await screen.findByText(/This request was already answered\./),
  ).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: 'Approve once' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByRole('link', { name: 'Open chat' })).toBeTruthy();
});

test('a failed decision stays on the row with a way to check it', async () => {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) =>
    init?.method === 'POST'
      ? new Response(JSON.stringify({ success: false, error: 'boom' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      : ok(open),
  );
  vi.stubGlobal('fetch', fetch);
  wrap(<ExactRequestInline reference={reference} />);
  const approve = await screen.findByRole('button', { name: 'Approve once' });
  await waitFor(() =>
    expect((approve as HTMLButtonElement).disabled).toBe(false),
  );
  await act(async () => {
    fireEvent.click(approve);
  });

  expect(await screen.findByText("Couldn't confirm the decision")).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
  // An unconfirmed attempt is never re-sent from here.
  expect(
    (screen.getByRole('button', { name: 'Approve once' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("the tray row answers an exact request inline and never through the notification's own action", async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ok(open)),
  );
  const onAction = vi.fn();
  const item: ApprovalAttentionItem = {
    id: 'approval:notif-1',
    kind: 'approval',
    title: 'Run a shell command',
    createdAt: '2026-09-04T00:00:00Z',
    updatedAt: '2026-09-04T00:00:00Z',
    openHref: '/?chat=session-a',
    source: { notificationId: 'notif-1', notificationSource: 'approval-inbox' },
    actions: [{ id: 'accept', label: 'Allow Once', variant: 'primary' }],
    requestReference: reference,
  };
  wrap(
    <AttentionHistoryItem
      item={item}
      isPending={false}
      isDismissPending={false}
      onAction={onAction}
      onClose={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );

  expect(screen.getByTestId('exact-request-inline')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Allow Once' })).toBeNull();
  const approve = await screen.findByRole('button', { name: 'Approve once' });
  await waitFor(() =>
    expect((approve as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(approve);
  // Answered through the exact-request route, never the notification action.
  await waitFor(() =>
    expect(fetchCalls().some((call) => call[1]?.method === 'POST')).toBe(true),
  );
  expect(onAction).not.toHaveBeenCalled();
});

test('a newer exact request on the same row can be answered again', async () => {
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST')
      return ok(null, { receipt: { commandId: 'r' } });
    const eventId =
      new URL(String(url)).searchParams.get('eventId') ?? 'event-a';
    return ok({
      ...open,
      reference: { ...reference, requestEventId: eventId },
    });
  });
  vi.stubGlobal('fetch', fetch);
  const view = wrap(<ExactRequestInline reference={reference} />);
  const click = async () => {
    const approve = await screen.findByRole('button', { name: 'Approve once' });
    await waitFor(() =>
      expect((approve as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(approve);
  };
  await click();
  await screen.findByText(/Decision sent\./);

  view.rerender(
    <QueryClientProvider client={new QueryClient()}>
      <ExactRequestInline
        reference={{ ...reference, requestEventId: 'event-b' }}
      />
    </QueryClientProvider>,
  );
  await click();
  await waitFor(() =>
    expect(
      fetch.mock.calls.filter((call) => call[1]?.method === 'POST'),
    ).toHaveLength(2),
  );
});

test('outside the inbox an approval card keeps Inspect request', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ok(open)),
  );
  wrap(
    <AttentionCard
      item={{
        id: 'approval:notif-1',
        kind: 'approval',
        title: 'Run a shell command',
        createdAt: '2026-09-04T00:00:00Z',
        updatedAt: '2026-09-04T00:00:00Z',
        source: {
          notificationId: 'notif-1',
          notificationSource: 'approval-inbox',
        },
        actions: [],
        requestReference: reference,
      }}
    />,
  );
  expect(screen.getByRole('button', { name: 'Inspect request' })).toBeTruthy();
  expect(screen.queryByTestId('exact-request-inline')).toBeNull();
});

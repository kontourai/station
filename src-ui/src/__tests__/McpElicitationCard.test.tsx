// @vitest-environment jsdom
import type { McpElicitationForm } from '@kontourai/station-contracts/mcp-elicitation';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { mcpElicitationFormFromRequest } from '@kontourai/station-shared/mcp-elicitation';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { unansweredApprovalRequests } from '../hooks/orchestration/pendingRequestRows';

const requestScope = {
  apiBase: 'https://elicitation-station.test',
  authorityKey: 'epoch-a',
  isCurrent: () => true,
};
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => requestScope,
}));

import { McpElicitationCard } from '../components/chat/McpElicitationCard';
import { McpElicitationRequest } from '../components/chat/McpElicitationRequest';

// The fixture server's own request, normalized as the server relay does.
const form = mcpElicitationFormFromRequest('fixture', {
  mode: 'form',
  message: 'Who should the report be addressed to?',
  requestedSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', title: 'Name', minLength: 1, maxLength: 40 },
      age: { type: 'integer', title: 'Age', minimum: 0, maximum: 150 },
      subscribe: { type: 'boolean', title: 'Subscribe' },
      color: {
        type: 'string',
        title: 'Color',
        oneOf: [
          { const: 'red', title: 'Red' },
          { const: 'blue', title: 'Blue' },
        ],
      },
    },
    required: ['name'],
  },
}) as McpElicitationForm;

const respond = vi.fn();

beforeEach(() => {
  respond.mockReset().mockResolvedValue(undefined);
  setClientCredentialResolver(undefined);
});
afterEach(() => {
  cleanup();
  setClientCredentialResolver(undefined);
});

test('renders every field labelled, and sends only valid content the person entered', async () => {
  render(<McpElicitationCard form={form} onRespond={respond} />);
  expect(screen.getByText('fixture needs your input')).toBeTruthy();
  expect(
    screen.getByText('Who should the report be addressed to?'),
  ).toBeTruthy();
  // Nothing preselected: an untouched yes/no is not a "no".
  const yes = screen.getByRole<HTMLInputElement>('radio', { name: 'Yes' });
  const no = screen.getByRole<HTMLInputElement>('radio', { name: 'No' });
  expect(yes.checked || no.checked).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'Name is required.',
  );
  expect(respond).not.toHaveBeenCalled();

  fireEvent.change(screen.getByRole('textbox', { name: /Name/ }), {
    target: { value: 'A'.repeat(41) },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  // Refused, not cut to 40.
  expect((await screen.findByRole('alert')).textContent).toBe(
    'Name allows at most 40 characters.',
  );

  fireEvent.change(screen.getByRole('textbox', { name: /Name/ }), {
    target: { value: 'Ada' },
  });
  fireEvent.change(screen.getByRole('spinbutton', { name: /Age/ }), {
    target: { value: '36' },
  });
  fireEvent.click(screen.getByRole('radio', { name: 'Blue' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() =>
    expect(respond).toHaveBeenCalledWith('accept', {
      name: 'Ada',
      age: 36,
      color: 'blue',
    }),
  );
  expect(await screen.findByText('Sent to fixture')).toBeTruthy();
});

test.each([
  ['Decline', 'decline', 'Declined fixture’s request'],
  ['Cancel', 'cancel', 'Cancelled fixture’s request'],
] as const)(
  '%s returns exactly that action, with no content',
  async (label, action, status) => {
    render(<McpElicitationCard form={form} onRespond={respond} />);
    fireEvent.change(screen.getByRole('textbox', { name: /Name/ }), {
      target: { value: 'Typed but not sent' },
    });
    if (label === 'Cancel') {
      // Cancel (dismiss without choosing) lives in the row's overflow menu.
      fireEvent.click(
        screen.getByRole('button', { name: 'More answer options' }),
      );
      fireEvent.click(
        await screen.findByRole('menuitem', {
          name: 'Cancel without answering',
        }),
      );
    } else fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith(action, undefined),
    );
    expect(await screen.findByText(status)).toBeTruthy();
  },
);

test('the request wrapper answers the exact opened event through the real SDK transport', async () => {
  const posted: unknown[] = [];
  setClientCredentialResolver(() => ({
    origin: requestScope.apiBase,
    requestAuthority: requestScope,
    transport: async (_url, init) => {
      if (init?.method !== 'POST') throw new Error('Unexpected read');
      posted.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          success: true,
          data: { result: null, receipt: { status: 'accepted' } },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    },
  }));
  const opened = {
    provider: 'station-agent',
    threadId: 'thread-one',
    turnId: 'turn-one',
    createdAt: '2026-10-05T00:00:00Z',
    method: 'request.opened',
    eventId: 'event-one',
    requestId: 'elicitation-one',
    requestType: 'approval',
    title: 'fixture needs your input',
    payload: { mcpElicitation: form },
  } as unknown as CanonicalRuntimeEvent;
  const [request] = unansweredApprovalRequests([], [opened]);
  expect(request.mcpElicitation).toEqual(form);
  render(<McpElicitationRequest request={request} />);
  fireEvent.change(screen.getByRole('textbox', { name: /Name/ }), {
    target: { value: 'Ada' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText('Sent to fixture')).toBeTruthy();
  expect(posted).toEqual([
    {
      type: 'respondToRequest',
      threadId: 'thread-one',
      requestId: 'elicitation-one',
      expectedRequestEventId: 'event-one',
      decision: 'accept',
      elicitationContent: { name: 'Ada' },
    },
  ]);
});

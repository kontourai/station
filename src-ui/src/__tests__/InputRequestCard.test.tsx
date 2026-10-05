// @vitest-environment jsdom
import type { InputRequestForm } from '@kontourai/station-contracts/input-request';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { inputRequestFromMcpElicitation } from '@kontourai/station-shared/mcp-elicitation';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import legacy from '../../../packages/shared/src/__tests__/fixtures/legacy-harness-question-events.json' with {
  type: 'json',
};
import { unansweredApprovalRequests } from '../hooks/orchestration/pendingRequestRows';

const storage = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
}));
vi.mock('idb-keyval', () => ({
  createStore: () => undefined,
  get: storage.get,
  set: storage.set,
  del: storage.del,
  keys: async () => [...storage.values.keys()],
}));

const requestScope = {
  apiBase: 'https://input-request-station.test',
  authorityKey: 'epoch-a',
  isCurrent: () => true,
};
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => requestScope,
}));
vi.mock('../contexts/AuthorityPersistenceContext', () => ({
  useAuthorityPersistence: () => ({
    status: 'verified',
    namespace: 'stable-user-scope',
    observation: null,
  }),
}));

import { InputRequestCard } from '../components/chat/InputRequestCard';
import { InputRequestRequest } from '../components/chat/InputRequestRequest';

const HARNESS: InputRequestForm = {
  schema: 'station.input-request/v1',
  source: 'harness:claude',
  requester: 'Claude',
  message: 'The agent has questions for you',
  body: {
    kind: 'form',
    fields: [
      {
        name: 'colour',
        header: 'Colour',
        title: 'Which colour?',
        required: true,
        kind: 'choice',
        options: [
          { value: 'blue', label: 'Blue', description: 'Cool' },
          { value: 'green', label: 'Green' },
        ],
        allowCustom: true,
      },
      {
        name: 'features',
        title: 'Which features?',
        required: true,
        kind: 'multi-choice',
        options: [
          { value: 'fast', label: 'Fast' },
          { value: 'small', label: 'Small' },
        ],
        minItems: 1,
        allowCustom: true,
      },
    ],
  },
};

const respond = vi.fn();
beforeEach(() => {
  requestScope.authorityKey = 'epoch-a';
  setClientCredentialResolver(undefined);
  storage.values.clear();
  vi.clearAllMocks();
  storage.get.mockImplementation(async (key) => storage.values.get(key));
  storage.set.mockImplementation(async (key, value) => {
    storage.values.set(key, value);
  });
  storage.del.mockImplementation(async (key) => {
    storage.values.delete(key);
  });
  respond.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  setClientCredentialResolver(undefined);
});

function postedCommands() {
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
  return posted;
}

test('a refused Send marks every invalid field, ties its message to it, and focuses the first', async () => {
  render(<InputRequestCard form={HARNESS} onRespond={respond} />);
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  const colour = screen.getByRole('group', { name: /Which colour\?/ });
  const features = screen.getByRole('group', { name: /Which features\?/ });
  expect(colour.getAttribute('aria-invalid')).toBe('true');
  expect(features.getAttribute('aria-invalid')).toBe('true');
  const message = document.getElementById(
    colour.getAttribute('aria-describedby')!.split(' ').at(-1)!,
  );
  expect(message?.textContent).toBe('Which colour? is required.');
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('radio', { name: /Blue/ }),
    ),
  );
  expect(respond).not.toHaveBeenCalled();
  // Answering the field clears its mark; the other stays.
  fireEvent.click(screen.getByRole('radio', { name: /Blue/ }));
  expect(colour.getAttribute('aria-invalid')).toBeNull();
  expect(features.getAttribute('aria-invalid')).toBe('true');
});

test('an own answer rides in the option slot, and a blank one is refused on its field', async () => {
  render(<InputRequestCard form={HARNESS} onRespond={respond} />);
  fireEvent.click(
    screen.getAllByRole('radio', { name: /Other/ })[0] as HTMLElement,
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /Fast/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  const own = screen.getByRole('textbox', {
    name: 'Your answer to Which colour?',
  });
  expect(own.getAttribute('aria-invalid')).toBe('true');
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('radio', { name: /Blue/ }),
    ),
  );
  fireEvent.change(own, { target: { value: 'Teal' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /Other/ }));
  fireEvent.change(
    screen.getByRole('textbox', { name: 'Your answer to Which features?' }),
    { target: { value: 'Search' } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(respond).toHaveBeenCalledOnce());
  expect(respond).toHaveBeenCalledWith('accept', {
    colour: { custom: 'Teal' },
    features: ['fast', { custom: 'Search' }],
  });
});

const MCP = inputRequestFromMcpElicitation('fixture', {
  message: 'Who should the report be addressed to?',
  requestedSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', title: 'Name', default: 'Ada' },
      age: { type: 'integer', title: 'Age', default: 36 },
      subscribe: { type: 'boolean', title: 'Subscribe', default: true },
      color: {
        type: 'string',
        title: 'Color',
        oneOf: [
          { const: 'red', title: 'Red' },
          { const: 'blue', title: 'Blue' },
        ],
        default: 'blue',
      },
      tags: {
        type: 'array',
        title: 'Tags',
        items: { type: 'string', enum: ['a', 'b'] },
        default: ['b'],
      },
    },
    required: ['name'],
  },
})!;

test('every `default` is pre-selected and sent unchanged', async () => {
  render(<InputRequestCard form={MCP} onRespond={respond} />);
  expect(
    screen.getByRole<HTMLInputElement>('textbox', { name: /Name/ }).value,
  ).toBe('Ada');
  expect(
    screen.getByRole<HTMLInputElement>('spinbutton', { name: /Age/ }).value,
  ).toBe('36');
  expect(
    screen.getByRole<HTMLInputElement>('radio', { name: 'Yes' }).checked,
  ).toBe(true);
  expect(
    screen.getByRole<HTMLInputElement>('radio', { name: 'Blue' }).checked,
  ).toBe(true);
  expect(
    screen.getByRole<HTMLInputElement>('checkbox', { name: 'b' }).checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() =>
    expect(respond).toHaveBeenCalledWith('accept', {
      name: 'Ada',
      age: 36,
      subscribe: true,
      color: 'blue',
      tags: ['b'],
    }),
  );
});

test('Decline and Cancel return exactly that action, with no content', async () => {
  const view = render(<InputRequestCard form={MCP} onRespond={respond} />);
  fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
  await waitFor(() =>
    expect(respond).toHaveBeenCalledWith('decline', undefined),
  );
  expect(await screen.findByText('Declined fixture’s request')).toBeTruthy();
  view.unmount();
  render(<InputRequestCard form={MCP} onRespond={respond} />);
  fireEvent.click(screen.getByRole('button', { name: 'More answer options' }));
  fireEvent.click(
    await screen.findByRole('menuitem', { name: 'Cancel without answering' }),
  );
  await waitFor(() =>
    expect(respond).toHaveBeenCalledWith('cancel', undefined),
  );
});

test('a secret answer is masked and never enters draft storage', async () => {
  const codex = unansweredApprovalRequests(
    [],
    [legacy.codex as unknown as CanonicalRuntimeEvent],
  )[0].inputRequest!;
  render(
    <InputRequestCard form={codex} draftKey="request-a" onRespond={respond} />,
  );
  const secret = screen.getByLabelText(/Enter the temporary credential/);
  expect(secret.getAttribute('type')).toBe('password');
  fireEvent.change(secret, { target: { value: 'private-draft-canary' } });
  fireEvent.click(screen.getByRole('radio', { name: /Staging/ }));
  await waitFor(() => expect(storage.set).toHaveBeenCalled());
  expect(JSON.stringify([...storage.values.values()])).not.toContain(
    'private-draft-canary',
  );
  expect(JSON.stringify([...storage.values.values()])).toContain('"0"');
});

test('a draft restores for the same request and never overwrites an answer already given', async () => {
  const view = render(
    <InputRequestCard
      form={HARNESS}
      draftKey="request-a"
      onRespond={respond}
    />,
  );
  fireEvent.click(screen.getByRole('radio', { name: /Green/ }));
  await waitFor(() => expect(storage.values.has('request-a')).toBe(true));
  view.unmount();
  render(
    <InputRequestCard
      form={HARNESS}
      draftKey="request-a"
      onRespond={respond}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: /Green/ }).checked,
    ).toBe(true),
  );
  cleanup();
  let release: (() => void) | undefined;
  storage.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({ draft: { values: { colour: 'green' }, custom: {} } });
      }),
  );
  render(
    <InputRequestCard
      form={HARNESS}
      draftKey="request-b"
      onRespond={respond}
    />,
  );
  fireEvent.click(screen.getByRole('radio', { name: /Blue/ }));
  await act(async () => release?.());
  expect(
    screen.getByRole<HTMLInputElement>('radio', { name: /Blue/ }).checked,
  ).toBe(true);
});

test('Ctrl+Enter sends once and ignores a held key', async () => {
  render(<InputRequestCard form={MCP} onRespond={respond} />);
  const form = screen.getByRole('form', { name: 'Answer fixture' });
  fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true, repeat: true });
  expect(respond).not.toHaveBeenCalled();
  fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
  await waitFor(() => expect(respond).toHaveBeenCalledOnce());
});

test('a stored pre-#3390 Claude question answers through the real SDK transport as content', async () => {
  const posted = postedCommands();
  const stored = legacy.claude as unknown as CanonicalRuntimeEvent;
  const [request] = unansweredApprovalRequests([], [stored]);
  render(<InputRequestRequest request={request} />);
  fireEvent.click(screen.getByRole('radio', { name: /Production/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Unit/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText('Sent to Claude')).toBeTruthy();
  expect(posted).toEqual([
    {
      type: 'respondToRequest',
      threadId: (stored as { threadId: string }).threadId,
      requestId: (stored as { requestId: string }).requestId,
      expectedRequestEventId: (stored as { eventId: string }).eventId,
      decision: 'accept',
      content: { '0': '1', '1': ['0'] },
    },
  ]);
});

test("a tool server's form is never drafted on the device", async () => {
  postedCommands();
  const opened = {
    provider: 'station-agent',
    threadId: 'thread-one',
    createdAt: '2026-10-05T00:00:00Z',
    method: 'request.opened',
    eventId: 'event-one',
    requestId: 'elicitation-one',
    requestType: 'approval',
    title: 'fixture needs your input',
    payload: { inputRequest: MCP },
  } as unknown as CanonicalRuntimeEvent;
  const [request] = unansweredApprovalRequests([], [opened]);
  expect(request.inputRequest).toEqual(MCP);
  render(<InputRequestRequest request={request} />);
  fireEvent.change(screen.getByRole('textbox', { name: /Name/ }), {
    target: { value: 'Grace' },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(storage.set).not.toHaveBeenCalled();
});

test("a question's header is shown with it; a form with no header draws no header slot", () => {
  const harness = render(
    <InputRequestCard form={HARNESS} onRespond={respond} />,
  );
  const colour = screen.getByRole('group', { name: /Which colour\?/ });
  const header = colour.querySelector('.input-request-card__field-header');
  expect(header?.textContent).toBe('Colour');
  // The header names the field too.
  expect(screen.getByRole('group', { name: /^Colour/ })).toBe(colour);
  // `features` has no header: no element at all, not an empty one.
  expect(
    screen
      .getByRole('group', { name: /Which features\?/ })
      .querySelector('.input-request-card__field-header'),
  ).toBeNull();
  harness.unmount();
  const { container } = render(
    <InputRequestCard form={MCP} onRespond={respond} />,
  );
  expect(
    container.querySelector('.input-request-card__field-header'),
  ).toBeNull();
});

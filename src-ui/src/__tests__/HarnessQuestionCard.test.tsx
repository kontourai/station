// @vitest-environment jsdom
import type {
  HarnessQuestionAnswers,
  HarnessQuestionnaire,
} from '@kontourai/station-contracts/harness-questions';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { PendingApprovalRequest } from '../hooks/orchestration/pendingRequestRows';

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

import { HarnessQuestionCard } from '../components/chat/HarnessQuestionCard';
import { HarnessQuestionRequest } from '../components/chat/HarnessQuestionRequest';

const requestScope = {
  apiBase: 'https://question-station.test',
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

const questionnaire: HarnessQuestionnaire = {
  questions: [
    {
      id: 'colour',
      header: 'Colour',
      prompt: 'Which colour?',
      multiple: false,
      allowCustom: true,
      secret: false,
      options: [
        { id: 'blue', label: 'Blue', description: 'Cool' },
        { id: 'green', label: 'Green', description: 'Calm' },
      ],
    },
    {
      id: 'features',
      header: 'Features',
      prompt: 'Which features?',
      multiple: true,
      allowCustom: true,
      secret: false,
      options: [
        { id: 'fast', label: 'Fast', description: 'Quick starts' },
        { id: 'small', label: 'Small', description: 'Less memory' },
      ],
    },
  ],
};
const submit = vi.fn<(answers: HarnessQuestionAnswers) => Promise<void>>();
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
  submit.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  setClientCredentialResolver(undefined);
});
function mount(value = questionnaire, key = 'request-a') {
  return render(
    <HarnessQuestionCard
      questionnaire={value}
      draftKey={key}
      onSubmit={submit}
    />,
  );
}

function chooseBatch() {
  fireEvent.click(screen.getByRole('radio', { name: /Blue/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Fast/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Other…' }));
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'Search' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
}

test('requires explicit choices, reviews the batch, and sends selection IDs plus custom text once', async () => {
  mount();
  expect(
    screen.getByRole<HTMLInputElement>('radio', { name: /Blue/ }).checked,
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'Choose one answer.',
  );
  chooseBatch();
  expect(screen.getByText('Ready to send')).toBeTruthy();
  expect(screen.getByText('Fast, Search')).toBeTruthy();
  expect(submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Edit answer 1' }));
  expect(
    screen.getByRole<HTMLInputElement>('radio', { name: /Blue/ }).checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(submit).toHaveBeenCalledWith({
    colour: { optionIds: ['blue'] },
    features: { optionIds: ['fast'], custom: 'Search' },
  });
  expect(await screen.findByText('Answers sent')).toBeTruthy();
  await waitFor(() => expect(storage.values.has('request-a')).toBe(false));
});

test('restores a draft for the exact request and preserves it after a failed submission', async () => {
  const view = mount();
  chooseBatch();
  await waitFor(() => expect(storage.values.has('request-a')).toBe(true));
  view.unmount();
  mount();
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: /Blue/ }).checked,
    ).toBe(true),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('Search');
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  submit.mockRejectedValueOnce(
    new Error('The current request could not be verified.'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(storage.values.has('request-a')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Edit answer 2' }));
  expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('Search');
});

test('a private answer is masked during review and never enters draft storage', async () => {
  const secret: HarnessQuestionnaire = {
    questions: [
      {
        id: 'secret',
        header: 'Private',
        prompt: 'Temporary credential?',
        multiple: false,
        allowCustom: true,
        secret: true,
        options: [],
      },
    ],
  };
  mount(secret);
  fireEvent.change(screen.getByLabelText('Your answer'), {
    target: { value: 'private-draft-canary' },
  });
  await waitFor(() => expect(storage.set).toHaveBeenCalled());
  expect(JSON.stringify([...storage.values.values()])).not.toContain(
    'private-draft-canary',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  expect(screen.getByText('••••••••')).toBeTruthy();
  expect(screen.queryByText('private-draft-canary')).toBeNull();
});

test('late draft loading never overwrites an answer already edited in the card', async () => {
  let release: (() => void) | undefined;
  storage.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({ answers: { colour: { optionIds: ['green'] } } });
      }),
  );
  mount();
  fireEvent.click(screen.getByRole('radio', { name: /Blue/ }));
  expect(release).toBeDefined();
  const finishRead = release;
  if (!finishRead) throw new Error('Draft read did not start.');
  await act(async () => {
    finishRead();
  });
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: /Blue/ }).checked,
    ).toBe(true),
  );
  expect(
    screen.getByRole<HTMLInputElement>('radio', { name: /Green/ }).checked,
  ).toBe(false);
});

test('the keyboard shortcut advances and reviews before sending, and ignores repeated commit keys', async () => {
  mount();
  fireEvent.click(screen.getByRole('radio', { name: /Blue/ }));
  const form = screen.getByRole('form', {
    name: 'Answer the agent’s questions',
  });
  fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
  expect(screen.getByText('Which features?')).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: /Fast/ }));
  fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
  expect(screen.getByText('Ready to send')).toBeTruthy();
  expect(submit).not.toHaveBeenCalled();
  fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true, repeat: true });
  expect(submit).not.toHaveBeenCalled();
  fireEvent.keyDown(form, { key: 'Enter', ctrlKey: true });
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
});

const request: PendingApprovalRequest = {
  type: 'tool-invocation',
  toolName: 'AskUserQuestion',
  approvalId: 'request-one',
  approvalThreadId: 'thread-one',
  approvalEventId: 'event-one',
  questionnaire,
};

test('the authority wrapper posts the exact prompt and structured answers through the real SDK transport', async () => {
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
          data: {
            result: null,
            receipt: { commandId: 'answer-one', status: 'accepted' },
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    },
  }));
  render(<HarnessQuestionRequest request={request} />);
  chooseBatch();
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText('Answers sent')).toBeTruthy();
  expect(posted).toEqual([
    {
      type: 'respondToRequest',
      threadId: 'thread-one',
      requestId: 'request-one',
      expectedRequestEventId: 'event-one',
      decision: 'accept',
      answers: {
        colour: { optionIds: ['blue'] },
        features: { optionIds: ['fast'], custom: 'Search' },
      },
    },
  ]);
});

test('a browser authority epoch change restores drafts only from the same verified durable namespace and request', async () => {
  const view = render(<HarnessQuestionRequest request={request} />);
  fireEvent.click(screen.getByRole('radio', { name: /Blue/ }));
  await screen.findByText('Saved');
  view.unmount();
  requestScope.authorityKey = 'epoch-b';
  render(<HarnessQuestionRequest request={request} />);
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: /Blue/ }).checked,
    ).toBe(true),
  );
});

test('question navigation returns to the first unanswered question before review', () => {
  mount();
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Features' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Fast/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  expect(screen.queryByText('Ready to send')).toBeNull();
  expect(screen.getByRole('alert').textContent).toBe('Choose one answer.');
  expect(document.activeElement?.textContent).toBe('Which colour?');
  expect(submit).not.toHaveBeenCalled();
});

test('stream projection refreshes never steal focus after Other was opened', () => {
  const view = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Other…' }));
  expect(document.activeElement).toBe(screen.getByRole('textbox'));
  const next = screen.getByRole('button', { name: 'Next' });
  next.focus();
  view.rerender(
    <HarnessQuestionCard
      questionnaire={structuredClone(questionnaire)}
      draftKey="request-a"
      onSubmit={submit}
    />,
  );
  expect(document.activeElement).toBe(next);
});

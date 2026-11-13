// @vitest-environment jsdom
import type {
  AttentionRequestReference,
  NeedsInputAttentionItem,
} from '@kontourai/station-contracts/attention';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { PreviewProvider } from '../../../contexts/PreviewContext';
import { NeedsInputReply } from '../NeedsInputReply';

const api = vi.hoisted(() => ({ context: vi.fn(), send: vi.fn() }));
vi.mock('@kontourai/station-sdk/input-reply', () => ({
  getInputReplyContext: api.context,
}));
vi.mock('@kontourai/station-sdk/client', async (original) => ({
  ...(await original<typeof import('@kontourai/station-sdk/client')>()),
  sendExecutionMessage: api.send,
}));
vi.mock('../../../contexts/ModelCapabilitiesContext', () => ({
  useModelImageSupport: () => 'unknown',
}));
vi.mock('../../../hooks/useComposerAttachments', () => ({
  useComposerAttachments: () => ({
    selectFiles: vi.fn(),
    remove: vi.fn(),
    setError: vi.fn(),
  }),
}));
const scope = {
  apiBase: 'http://station.test',
  authorityKey: 'answer-owner',
  isCurrent: () => true,
};
const reference: AttentionRequestReference = {
  threadId: 'session',
  requestId: 'request',
  requestEventId: 'opened',
};
const item: NeedsInputAttentionItem & {
  inputReference: AttentionRequestReference;
} = {
  id: 'needs_input:session',
  kind: 'needs_input',
  title: 'Which bucket?',
  createdAt: '2026-11-05T00:00:00Z',
  updatedAt: '2026-11-05T00:00:00Z',
  source: { threadId: 'session' },
  openHref: '/?chat=session',
  requestType: 'input',
  inputReference: reference,
};
function mount() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <PreviewProvider>
        <NeedsInputReply item={item} scope={scope} />
      </PreviewProvider>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  api.context.mockReset().mockResolvedValue({
    state: 'open',
    reference,
    agentId: 'reviewer',
    conversationId: 'conversation',
    engineId: 'claude',
    capabilities: [],
  });
  api.send.mockReset();
});
test('real shared composer locks an uncertain draft and retries the identical bound answer', async () => {
  api.send
    .mockRejectedValueOnce(new TypeError('private_machine_connection_reset'))
    .mockResolvedValueOnce({});
  mount();
  const draft = screen.getByRole('textbox');
  await waitFor(() => expect(draft.hasAttribute('disabled')).toBe(false));
  fireEvent.change(draft, { target: { value: 'Use staging' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  const retry = await screen.findByRole('button', {
    name: 'Retry same answer',
  });
  await waitFor(() => expect(retry.hasAttribute('disabled')).toBe(false));
  expect(draft.hasAttribute('disabled')).toBe(true);
  expect((draft as HTMLTextAreaElement).value).toBe('Use staging');
  expect(document.body.textContent).not.toContain(
    'private_machine_connection_reset',
  );
  fireEvent.click(retry);
  await screen.findByText('Answer sent.');
  expect(api.send).toHaveBeenCalledTimes(2);
  expect(api.send.mock.calls[1]).toEqual(api.send.mock.calls[0]);
  expect(api.send.mock.calls[0]).toEqual([
    scope.apiBase,
    expect.objectContaining({
      message: 'Use staging',
      conversationId: 'conversation',
      expectedInputRequest: reference,
      clientTurnId: expect.any(String),
    }),
    { requestScope: scope },
  ]);
});
test('a refused request read renders safe refusal copy and a real retry action', async () => {
  api.context.mockRejectedValueOnce(
    Object.assign(new Error('private_machine_scope'), {
      status: 403,
      stationEnvelope: true,
    }),
  );
  mount();
  await screen.findByText('Not sent');
  expect(document.body.textContent).not.toMatch(
    /private_machine_scope|could not be confirmed/i,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() =>
    expect(screen.getByRole('textbox').hasAttribute('disabled')).toBe(false),
  );
  expect(api.send).not.toHaveBeenCalled();
});

test('a definite refusal leaves the answer editable without an uncertainty warning', async () => {
  api.send.mockRejectedValueOnce(
    Object.assign(new Error('private_machine_scope'), {
      status: 403,
      stationEnvelope: true,
    }),
  );
  mount();
  const draft = screen.getByRole('textbox');
  await waitFor(() => expect(draft.hasAttribute('disabled')).toBe(false));
  fireEvent.change(draft, { target: { value: 'Use staging' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  await screen.findByText(/Review this answer, then send again/);
  expect(draft.hasAttribute('disabled')).toBe(false);
  expect((draft as HTMLTextAreaElement).value).toBe('Use staging');
  expect(
    screen.queryByRole('button', { name: 'Retry same answer' }),
  ).toBeNull();
  expect(document.body.textContent).not.toMatch(
    /private_machine_scope|could not confirm|send it twice/i,
  );
});

/**
 * @vitest-environment jsdom
 */

/**
 * #3390 (#3331 R1/R7): the live half of an input request's transcript
 * record. The open turn is drawn by the streaming shell, not the projection,
 * so `request.opened` writes the record into the shell and `request.resolved`
 * — however it was answered, here or on another device — records its
 * outcome there. Folded through the real live handlers and the real store.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

vi.mock('../../../contexts/ToastContext', () => ({
  toastStore: {
    dismiss: vi.fn(),
    show: vi.fn(),
    showToolApproval: vi.fn(() => 'toast-1'),
    dismissApprovalRequest: vi.fn(),
  },
}));

let activeChatsStore: import('../../../contexts/active-chats-store').ActiveChatsStore;
let handleRequestOpenedEvent: typeof import('../approvalHandlers').handleRequestOpenedEvent;
let handleRequestResolvedEvent: typeof import('../approvalHandlers').handleRequestResolvedEvent;
let handleToolStartedEvent: typeof import('../streamHandlers').handleToolStartedEvent;

const form = {
  schema: 'station.input-request/v1',
  source: 'mcp:fixture',
  requester: 'fixture',
  message: 'Who should the report go to?',
  body: {
    kind: 'form',
    fields: [{ name: 'name', required: true, kind: 'string' }],
  },
};

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  vi.doMock('../../../contexts/active-chats-store', async () => {
    const actual = await vi.importActual<
      typeof import('../../../contexts/active-chats-store')
    >('../../../contexts/active-chats-store');
    const store = new actual.ActiveChatsStore({
      storage: { getItem: () => null, setItem: () => {} },
    });
    return { ...actual, activeChatsStore: store };
  });
  ({ activeChatsStore } = await import('../../../contexts/active-chats-store'));
  ({ handleRequestOpenedEvent, handleRequestResolvedEvent } = await import(
    '../approvalHandlers'
  ));
  ({ handleToolStartedEvent } = await import('../streamHandlers'));
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../../../contexts/active-chats-store');
  vi.resetModules();
});

beforeEach(() => {
  for (const threadId of Object.keys(activeChatsStore.getSnapshot()))
    activeChatsStore.removeChat(threadId);
  activeChatsStore.initChat('thread-1', {
    agentSlug: 'dev',
    agentName: 'Dev',
    title: 'Live record',
    orchestrationSessionStarted: true,
  });
  activeChatsStore.updateChat('thread-1', {
    orchestrationTurnOpen: true,
    openTurnId: 'turn-1',
    streamingMessage: {
      role: 'assistant',
      content: '',
      contentParts: [{ type: 'text', content: 'Working…' }],
    } as never,
  });
});

const shellRecords = () =>
  (
    activeChatsStore.getSnapshot()['thread-1']?.streamingMessage
      ?.contentParts ?? []
  )
    .filter((part) => part.type === 'input-request')
    .map((part) => part.inputRequestRecord);

function opened(requestId: string, payload: Record<string, unknown>) {
  return {
    eventId: `evt-${requestId}`,
    provider: 'codex',
    threadId: 'thread-1',
    turnId: 'turn-1',
    createdAt: '2026-10-05T00:00:00.000Z',
    method: 'request.opened',
    requestId,
    requestType: 'approval',
    title: 'fixture needs your input',
    payload,
  } as never;
}

function resolved(requestId: string, status: string) {
  return {
    eventId: `res-${requestId}`,
    provider: 'codex',
    threadId: 'thread-1',
    createdAt: '2026-10-05T00:00:01.000Z',
    method: 'request.resolved',
    requestId,
    status,
  } as never;
}

describe('#3390 live input request record', () => {
  test('a form opens pending in the streaming shell and records an answer given elsewhere', () => {
    handleRequestOpenedEvent(
      'http://localhost:0',
      opened('form-1', { inputRequest: form }),
    );
    expect(shellRecords()).toEqual([
      {
        requestId: 'form-1',
        threadId: 'thread-1',
        eventId: 'evt-form-1',
        kind: 'form',
        requester: 'fixture',
        message: 'Who should the report go to?',
        outcome: 'pending',
      },
    ]);
    // Nothing was answered on this client: only the resolution arrives.
    handleRequestResolvedEvent(resolved('form-1', 'approved'));
    expect(shellRecords().map((record) => record?.outcome)).toEqual([
      'accepted',
    ]);
  });

  test('an approval with no call on the shell records allowed or denied; one bound to a call does not', () => {
    handleToolStartedEvent({
      eventId: 'tool-evt',
      provider: 'codex',
      threadId: 'thread-1',
      turnId: 'turn-1',
      createdAt: '2026-10-05T00:00:00.000Z',
      method: 'tool.started',
      toolCallId: 'call-1',
      toolName: 'Bash',
      arguments: { command: 'ls' },
    } as never);
    handleRequestOpenedEvent(
      'http://localhost:0',
      opened('bound', { toolName: 'Bash', toolCallId: 'call-1' }),
    );
    handleRequestOpenedEvent(
      'http://localhost:0',
      opened('unbound', { command: 'git push' }),
    );
    handleRequestResolvedEvent(resolved('unbound', 'denied'));
    expect(shellRecords()).toEqual([
      expect.objectContaining({
        requestId: 'unbound',
        kind: 'decision',
        requester: 'A tool call',
        outcome: 'denied',
      }),
    ]);
  });

  test('no streaming turn: nothing is written, the projection owns the row', () => {
    activeChatsStore.updateChat('thread-1', {
      orchestrationTurnOpen: false,
      streamingMessage: undefined,
    });
    handleRequestOpenedEvent(
      'http://localhost:0',
      opened('form-2', { inputRequest: form }),
    );
    expect(shellRecords()).toEqual([]);
  });
});

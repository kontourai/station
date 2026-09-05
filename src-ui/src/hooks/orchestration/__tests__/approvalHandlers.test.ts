import { beforeEach, describe, expect, test, vi } from 'vitest';

type ApprovalToastOptions = {
  toolName: string;
  toolPreview?: string;
  actions: Array<{ label: string }>;
};

const showToolApproval = vi.fn((_options: ApprovalToastOptions) => 'toast-1');
const getChatForExecutionSession = vi.fn();
const updateChat = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  resolveOrchestrationRequest: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../contexts/ToastContext', () => ({
  toastStore: { showToolApproval, dismiss: vi.fn() },
}));
vi.mock('../../../contexts/active-chats-store', () => ({
  activeChatsStore: { getChatForExecutionSession, updateChat },
}));

const { handleRequestOpenedEvent } = await import('../approvalHandlers');

function requestOpened(payload: Record<string, unknown> | undefined) {
  return {
    eventId: 'evt-1',
    provider: 'claude',
    threadId: 'thread-1',
    createdAt: '2026-09-05T00:00:00.000Z',
    method: 'request.opened',
    requestId: 'req-1',
    requestType: 'approval',
    title: 'Allow Bash',
    ...(payload ? { payload } : {}),
  } as unknown as Parameters<typeof handleRequestOpenedEvent>[1];
}

function approvalToast(): ApprovalToastOptions {
  expect(showToolApproval).toHaveBeenCalledTimes(1);
  return showToolApproval.mock.calls[0][0];
}

describe('handleRequestOpenedEvent — the approval toast says what it grants (#1545)', () => {
  beforeEach(() => {
    showToolApproval.mockClear();
    updateChat.mockClear();
    getChatForExecutionSession.mockReset();
    getChatForExecutionSession.mockReturnValue({
      title: 'Conversation',
      agentName: 'Claude',
      pendingApprovals: [],
    });
  });

  test('carries a preview of the command, not just the tool name', () => {
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({
        toolName: 'Bash',
        toolInput: { command: 'touch /tmp/ask-settings-probe' },
      }),
    );

    const toast = approvalToast();
    expect(toast.toolName).toBe('Bash');
    expect(toast.toolPreview).toBe('touch /tmp/ask-settings-probe');
  });

  test('names the tool in the standing-grant label', () => {
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({ toolName: 'Bash', toolInput: { command: 'ls' } }),
    );

    expect(approvalToast().actions.map((action) => action.label)).toEqual([
      'Allow Once',
      'Allow Bash for this session',
      'Deny',
    ]);
  });

  test('reads an MCP wire name as a person would in the grant label', () => {
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({
        toolName: 'mcp__station-control__list_agents',
        toolInput: { status: 'active' },
      }),
    );

    const toast = approvalToast();
    expect(toast.actions[1].label).toBe(
      'Allow station-control.list_agents for this session',
    );
    expect(toast.toolPreview).toBe('{"status":"active"}');
  });

  test('does not put adapter display text in the grant label when no tool name was reported', () => {
    // `event.title` is the fallback for the toast message, but for Codex it is
    // the literal shell command — a grant label built from it would claim the
    // grant covers that one command rather than the tool.
    handleRequestOpenedEvent('http://localhost:1', requestOpened(undefined));

    const toast = approvalToast();
    expect(toast.toolName).toBe('Allow Bash');
    expect(toast.actions[1].label).toBe('Allow this tool for this session');
    expect(toast.toolPreview).toBeUndefined();
  });

  test('omits the preview when the input says nothing useful', () => {
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({ toolName: 'AskUserQuestion', toolInput: {} }),
    );

    expect(approvalToast().toolPreview).toBeUndefined();
  });
});

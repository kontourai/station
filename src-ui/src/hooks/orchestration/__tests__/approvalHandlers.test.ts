import { beforeEach, describe, expect, test, vi } from 'vitest';

type ApprovalToastOptions = {
  toolName: string;
  toolPreview?: string;
  actions: Array<{ label: string; onClick: () => void }>;
};

const showToolApproval = vi.fn((_options: ApprovalToastOptions) => 'toast-1');
const showToast = vi.fn();
const getChatForExecutionSession = vi.fn();
const updateChat = vi.fn();
const navigate = vi.fn();

vi.mock('../../../contexts/NavigationContext', () => ({
  navigationStore: { navigate },
}));

vi.mock('@kontourai/station-sdk', () => ({
  resolveOrchestrationRequest: vi.fn().mockResolvedValue(undefined),
  inspectAttentionRequest: vi.fn(),
}));
vi.mock('../../../contexts/ToastContext', () => ({
  toastStore: { showToolApproval, show: showToast, dismiss: vi.fn() },
}));
vi.mock('../../../contexts/active-chats-store', () => ({
  activeChatsStore: { getChatForExecutionSession, updateChat },
}));

const {
  handleRequestOpenedEvent,
  handleRequestDeliveryEvent,
  handleRequestResolvedEvent,
} = await import('../approvalHandlers');
const { forgetApprovalAnswer } = await import('../answerRequest');
beforeEach(() => {
  forgetApprovalAnswer('thread-1', 'req-1');
  vi.mocked(resolveOrchestrationRequest)
    .mockReset()
    .mockResolvedValue(undefined);
});

const { resolveOrchestrationRequest, inspectAttentionRequest } = await import(
  '@kontourai/station-sdk'
);

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

  test('a duplicate request id does not raise a second toast', () => {
    getChatForExecutionSession.mockReturnValue({
      title: 'Conversation',
      agentName: 'Claude',
      pendingApprovals: ['req-1'],
      approvalToasts: new Map([['req-1', 'toast-1']]),
    });
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({ toolName: 'Bash' }),
    );
    expect(showToolApproval).not.toHaveBeenCalled();
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

  test('keeps actual identity and arguments beside optional stated purpose', () => {
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({
        toolName: 'Bash',
        toolPurpose: 'Check the repository status',
        toolInput: { command: 'git status' },
      }),
    );
    expect(approvalToast()).toMatchObject({
      toolName: 'Bash',
      toolPreview: 'Why: Check the repository status · git status',
    });
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

  test('#3382: the preview and "Why:" drop bidi controls, turn C1 controls into spaces and keep every line', () => {
    const RLO = String.fromCodePoint(0x202e);
    const PDF = String.fromCodePoint(0x202c);
    const NEL = String.fromCodePoint(0x85);
    const BEL = String.fromCodePoint(0x07);
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({
        toolName: `Ba${RLO}sh${BEL}`,
        toolPurpose: `Tidy${NEL}up ${RLO}txt.exe${PDF}`,
        toolInput: { command: `echo a${RLO}b${PDF}\nrm${NEL}-rf${BEL}/` },
      }),
    );

    const toast = approvalToast();
    expect(toast.toolName).toBe('Bash');
    // ⏎: the lines stay apart. Joined by a space, `rm -rf /` read as
    // part of what `echo` prints.
    expect(toast.toolPreview).toBe(
      'Why: Tidy up txt.exe \u00b7 echo ab \u23ce rm -rf /',
    );
    expect(toast.actions.map((action) => action.label)).toContain(
      'Allow Bash for this session',
    );
  });

  test('#3382: a title shown in place of a tool name is sanitised too', () => {
    const RLO = String.fromCodePoint(0x202e);
    const NEL = String.fromCodePoint(0x85);
    handleRequestOpenedEvent('http://localhost:1', {
      ...requestOpened({ command: 'ls' }),
      title: `echo ${RLO}a${NEL}b\nrm -rf /`,
    } as Parameters<typeof handleRequestOpenedEvent>[1]);

    expect(approvalToast().toolName).toBe('echo a b \u23ce rm -rf /');
  });

  test('#2916: a plan exit offers no session grant', () => {
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({
        toolName: 'ExitPlanMode',
        toolInput: { plan: 'Step 1' },
      }),
    );

    expect(approvalToast().actions.map((action) => action.label)).toEqual([
      'Allow Once',
      'Deny',
    ]);
  });

  const folderRule = {
    type: 'addRules',
    rules: [{ toolName: 'Read', ruleContent: '//work/b/**' }],
    behavior: 'allow',
    destination: 'session',
  };
  test.each([
    [
      'a Claude read-only tool with the engine folder rule',
      { toolName: 'Grep', suggestions: [folderRule] },
      'Allow reading this folder for this session',
    ],
    [
      'a Claude read-only tool with nothing to forward (an ask rule)',
      { toolName: 'Read' },
      undefined,
    ],
    [
      'a Bash read outside the working directories',
      {
        toolName: 'Bash',
        blockedPath: '/etc/hosts',
        suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Read', ruleContent: '//etc/**' }],
            behavior: 'allow',
            destination: 'session',
          },
        ],
      },
      'Allow reading this folder for this session',
    ],
    [
      'a Bash redirect writing outside the working directories',
      {
        toolName: 'Bash',
        blockedPath: '/work/b/out.txt',
        suggestions: [
          {
            type: 'addDirectories',
            directories: ['/work/b'],
            destination: 'session',
          },
          { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
        ],
      },
      'Allow access to this folder for this session',
    ],
    [
      'a plain Claude file edit',
      {
        toolName: 'Edit',
        suggestions: [
          { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
        ],
      },
      'Auto-accept file edits for this session',
    ],
    [
      'a file edit asked in plan mode',
      {
        toolName: 'Edit',
        permissionMode: 'plan',
        suggestions: [
          { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
        ],
      },
      undefined,
    ],
    [
      'a sensitive-file edit with nothing to forward',
      { toolName: 'Edit', suggestions: [] },
      undefined,
    ],
    [
      'a Bash call forced by an ask rule',
      {
        toolName: 'Bash',
        matchedAskRule: { source: 'userSettings', toolName: 'Bash' },
      },
      undefined,
    ],
  ])('#2915: labels the session grant for %s', (_case, payload, label) => {
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({ ...payload, toolInput: { path: '/work/b' } }),
    );

    expect(approvalToast().actions.map((action) => action.label)).toEqual(
      label ? ['Allow Once', label, 'Deny'] : ['Allow Once', 'Deny'],
    );
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
    expect(toast.actions[1].label).toBe('Allow for this session');
    expect(toast.toolPreview).toBeUndefined();
  });

  // The adapters do not agree on where the arguments live, and reading only
  // `toolInput` left these two engine families with a bare tool name on the
  // toast while the durable inbox row — which read all five names — showed the
  // command. Field names verified against the publishing adapters.
  test.each([
    [
      'an ACP engine (acp-adapter.ts session/request_permission)',
      { rawInput: { command: 'git status' }, toolCallId: 'call-1' },
      'git status',
    ],
    [
      'a station-agent session (station-agent-adapter.ts)',
      { toolName: 'Bash', toolArgs: { command: 'ls -la' } },
      'ls -la',
    ],
  ])('previews the command for %s', (_who, payload, expected) => {
    handleRequestOpenedEvent('http://localhost:1', requestOpened(payload));

    expect(approvalToast().toolPreview).toBe(expected);
  });

  test('an ACP approval with no reported tool name still stays generic in the grant label', () => {
    // ACP's payload carries `rawInput` and `toolCallId` but no tool name, so
    // the preview lands while the grant label must not invent a subject.
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({ rawInput: { command: 'git status' } }),
    );

    const toast = approvalToast();
    expect(toast.toolPreview).toBe('git status');
    expect(toast.actions[1].label).toBe('Allow for this session');
  });

  // Codex has no Station pre-tool seam, so its payload is the app-server's raw
  // request params: no `toolInput`/`toolArgs`/`rawInput` to read. The command
  // approval showed only its title and the file-change approval named no file.
  test.each([
    [
      'item/commandExecution/requestApproval',
      { command: 'rm -rf tmp', reason: 'Needs approval' },
      'rm -rf tmp',
    ],
    [
      'item/fileChange/requestApproval',
      {
        changes: [
          { path: 'src/index.ts', diff: '@@ -1 +1 @@' },
          { path: 'README.md', diff: 'x'.repeat(4_000) },
        ],
      },
      'src/index.ts, README.md',
    ],
  ])('previews a Codex %s payload', (_method, payload, expected) => {
    handleRequestOpenedEvent('http://localhost:1', requestOpened(payload));

    expect(approvalToast().toolPreview).toBe(expected);
  });

  test('the toast subject reads an MCP wire name the way a person would', () => {
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({
        toolName: 'mcp__station-control__list_agents',
        toolInput: { status: 'active' },
      }),
    );

    expect(approvalToast().toolName).toBe('station-control.list_agents');
  });

  test('omits the preview when the input says nothing useful', () => {
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({ toolName: 'AskUserQuestion', toolInput: {} }),
    );

    expect(approvalToast().toolPreview).toBeUndefined();
  });
});

describe('#2316: the toast answers the exact prompt it shows', () => {
  beforeEach(() => {
    showToolApproval.mockClear();
    vi.mocked(resolveOrchestrationRequest).mockClear();
    getChatForExecutionSession.mockReturnValue({
      title: 'Conversation',
      agentName: 'Claude',
      pendingApprovals: [],
    });
  });

  test.each([
    [0, 'accept'],
    [1, 'acceptForSession'],
    [2, 'decline'],
  ] as const)(
    'action %i sends %s bound to the request event id',
    async (index, decision) => {
      handleRequestOpenedEvent(
        'http://localhost:1',
        requestOpened({ toolName: 'Bash', toolInput: { command: 'ls' } }),
      );
      approvalToast().actions[index]?.onClick();
      // The answer path loads on demand, so the call lands a tick later.
      await vi.waitFor(() =>
        expect(resolveOrchestrationRequest).toHaveBeenCalled(),
      );
      expect(resolveOrchestrationRequest).toHaveBeenCalledWith({
        apiBase: 'http://localhost:1',
        threadId: 'thread-1',
        requestId: 'req-1',
        expectedRequestEventId: 'evt-1',
        decision,
        timeoutMs: 15_000,
      });
      expect(navigate).toHaveBeenCalledWith('/', {
        chat: 'thread-1',
        dock: 'open',
      });
    },
  );
});

describe('the Station browser server grant on the toast', () => {
  const LABEL = 'Allow the Station browser for this session';
  const browserPayload = {
    toolName: 'mcp__station-browser__browser_click',
    toolInput: { ref: 'e1' },
  };

  beforeEach(() => {
    showToolApproval.mockClear();
    vi.mocked(resolveOrchestrationRequest).mockClear();
    getChatForExecutionSession.mockReturnValue({
      title: 'Conversation',
      agentName: 'Claude',
      pendingApprovals: [],
    });
  });

  test('offers the choice beside the per-tool one only when the adapter found the call authentic', () => {
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({ ...browserPayload, stationBrowserServer: true }),
    );
    expect(approvalToast().actions.map((action) => action.label)).toEqual([
      'Allow Once',
      'Allow station-browser.browser_click for this session',
      LABEL,
      'Deny',
    ]);
  });

  test('a call named like the browser tool, without the adapter finding, does not offer it', () => {
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened(browserPayload),
    );
    expect(approvalToast().actions.map((action) => action.label)).toEqual([
      'Allow Once',
      'Allow station-browser.browser_click for this session',
      'Deny',
    ]);
  });

  test('choosing it sends acceptForSession with the typed server scope', async () => {
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({ ...browserPayload, stationBrowserServer: true }),
    );
    approvalToast()
      .actions.find((action) => action.label === LABEL)
      ?.onClick();
    await vi.waitFor(() =>
      expect(resolveOrchestrationRequest).toHaveBeenCalled(),
    );
    expect(resolveOrchestrationRequest).toHaveBeenCalledWith({
      apiBase: 'http://localhost:1',
      threadId: 'thread-1',
      requestId: 'req-1',
      expectedRequestEventId: 'evt-1',
      decision: 'acceptForSession',
      sessionGrantScope: 'server',
      timeoutMs: 15_000,
    });
  });

  test('the per-tool choice sends no scope', async () => {
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({ ...browserPayload, stationBrowserServer: true }),
    );
    approvalToast().actions[1]?.onClick();
    await vi.waitFor(() =>
      expect(resolveOrchestrationRequest).toHaveBeenCalled(),
    );
    expect(
      vi.mocked(resolveOrchestrationRequest).mock.calls[0][0],
    ).not.toHaveProperty('sessionGrantScope');
  });
});

describe('#2344: the toast reports what happened to its answer', () => {
  beforeEach(() => {
    showToolApproval.mockClear();
    showToast.mockClear();
    vi.mocked(resolveOrchestrationRequest).mockReset();
    vi.mocked(inspectAttentionRequest).mockReset();
    getChatForExecutionSession.mockReturnValue({
      title: 'Conversation',
      agentName: 'Claude',
      // The request is still waiting on the user.
      pendingApprovals: ['req-1'],
    });
  });

  /** Clicks a toast action and lets its answer settle. */
  async function click(label: string) {
    const action = showToolApproval.mock.calls
      .at(-1)?.[0]
      .actions.find((candidate) => candidate.label === label);
    if (!action) throw new Error(`no ${label} action`);
    action.onClick();
    await vi.waitFor(() =>
      expect(resolveOrchestrationRequest).toHaveBeenCalled(),
    );
    // The answer's own awaits (the refusal read) settle on later ticks.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  test('a refused decision names the failure and offers the request again', async () => {
    vi.mocked(resolveOrchestrationRequest).mockRejectedValue(
      new Error('Station is not reachable.'),
    );
    vi.mocked(inspectAttentionRequest).mockResolvedValue({
      state: 'open',
    } as never);
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({ toolName: 'Bash', toolInput: { command: 'ls' } }),
    );

    await click('Deny');

    await vi.waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        'Your decision on Bash was not delivered: Station is not reachable.',
        'thread-1',
        9000,
        undefined,
        undefined,
        'error',
      ),
    );
    // Still open, so the prompt comes back with the same three answers.
    expect(showToolApproval).toHaveBeenCalledTimes(2);
    expect(
      showToolApproval.mock.calls[1]?.[0].actions.map((a) => a.label),
    ).toEqual(['Allow Once', 'Allow Bash for this session', 'Deny']);
  });

  test('a failure after the request settled elsewhere offers no dead prompt', async () => {
    vi.mocked(resolveOrchestrationRequest).mockRejectedValue(
      new Error('Station is not reachable.'),
    );
    vi.mocked(inspectAttentionRequest).mockRejectedValue(new Error('offline'));
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({ toolName: 'Bash', toolInput: { command: 'ls' } }),
    );
    // request.resolved arrived meanwhile and took it off the waiting list.
    getChatForExecutionSession.mockReturnValue({
      title: 'Conversation',
      agentName: 'Claude',
      pendingApprovals: [],
    });

    await click('Allow Once');

    await vi.waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/^Your decision on Bash was not delivered/),
        'thread-1',
        9000,
        undefined,
        undefined,
        'error',
      ),
    );
    expect(showToolApproval).toHaveBeenCalledTimes(1);
  });

  test('an answer to a request no longer open says so, and is not an error', async () => {
    vi.mocked(resolveOrchestrationRequest).mockRejectedValue(
      new Error('This request was already resolved.'),
    );
    vi.mocked(inspectAttentionRequest).mockResolvedValue({
      state: 'resolved',
    } as never);
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({ toolName: 'Bash', toolInput: { command: 'ls' } }),
    );

    await click('Allow Once');

    await vi.waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        'Bash: this request is no longer open.',
        'thread-1',
        5000,
      ),
    );
    // Read from the request itself, bound to the prompt the toast showed.
    expect(inspectAttentionRequest).toHaveBeenCalledWith(
      'http://localhost:1',
      {
        threadId: 'thread-1',
        requestId: 'req-1',
        requestEventId: 'evt-1',
      },
      { timeoutMs: 5_000 },
    );
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToolApproval).toHaveBeenCalledTimes(1);
  });

  test('a failed load of the answer path is reported like any undelivered decision', async () => {
    // The answer path is loaded on demand; a chunk that cannot load (an
    // update while the tab was open, a dropped connection) must not swallow
    // the click.
    vi.doMock('../answerRequest', () => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    try {
      handleRequestOpenedEvent(
        'http://localhost:1',
        requestOpened({ toolName: 'Bash', toolInput: { command: 'ls' } }),
      );
      showToolApproval.mock.calls
        .at(-1)?.[0]
        .actions.find((action) => action.label === 'Deny')
        ?.onClick();

      await vi.waitFor(() =>
        expect(showToast).toHaveBeenCalledWith(
          // vitest wraps a throwing mock factory's error in its own text.
          expect.stringMatching(/^Your decision on Bash was not delivered: ./),
          'thread-1',
          9000,
          undefined,
          undefined,
          'error',
        ),
      );
      // Nothing reached Station, and the request is offered again.
      expect(resolveOrchestrationRequest).not.toHaveBeenCalled();
      expect(showToolApproval).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock('../answerRequest');
    }
  });

  test('an answered request stops waiting on the user at the click', async () => {
    vi.mocked(resolveOrchestrationRequest).mockResolvedValue(undefined);
    updateChat.mockClear();
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({ toolName: 'Bash', toolInput: { command: 'ls' } }),
    );

    await click('Allow Once');

    // Marked answered before the engine's `request.resolved` arrives, and
    // never taken back: the decision was delivered.
    const answered = updateChat.mock.calls
      .map(([, patch]) => patch.answeredApprovals)
      .filter((value) => value !== undefined);
    expect(answered).toEqual([['req-1']]);
  });

  test('a decision that was not delivered waits on the user again', async () => {
    vi.mocked(resolveOrchestrationRequest).mockRejectedValue(
      new Error('Station is not reachable.'),
    );
    vi.mocked(inspectAttentionRequest).mockResolvedValue({
      state: 'open',
    } as never);
    updateChat.mockClear();
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({ toolName: 'Bash', toolInput: { command: 'ls' } }),
    );

    await click('Deny');
    await vi.waitFor(() => expect(showToast).toHaveBeenCalled());

    const answered = updateChat.mock.calls
      .map(([, patch]) => patch.answeredApprovals)
      .filter((value) => value !== undefined);
    expect(answered).toEqual([['req-1'], []]);
  });

  test('a request that opens again under an answered id waits on the user again', () => {
    getChatForExecutionSession.mockReturnValue({
      title: 'Conversation',
      agentName: 'Claude',
      pendingApprovals: [],
      answeredApprovals: ['req-1'],
    });
    updateChat.mockClear();
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({ toolName: 'Bash', toolInput: { command: 'ls' } }),
    );
    expect(updateChat).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({
        pendingApprovals: ['req-1'],
        answeredApprovals: [],
      }),
    );
  });

  test('a re-delivered open for a request already pending keeps its answer', () => {
    getChatForExecutionSession.mockReturnValue({
      title: 'Conversation',
      agentName: 'Claude',
      pendingApprovals: ['req-1'],
      answeredApprovals: ['req-1'],
    });
    updateChat.mockClear();
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({ toolName: 'Bash', toolInput: { command: 'ls' } }),
    );
    for (const [, patch] of updateChat.mock.calls) {
      expect(patch.answeredApprovals).toBeUndefined();
    }
  });

  test('the resolution takes the request off the answered list', () => {
    getChatForExecutionSession.mockReturnValue({
      title: 'Conversation',
      agentName: 'Claude',
      pendingApprovals: ['req-1', 'req-2'],
      answeredApprovals: ['req-1'],
    });
    updateChat.mockClear();

    handleRequestResolvedEvent({
      provider: 'claude',
      threadId: 'thread-1',
      createdAt: '2026-09-05T00:00:01.000Z',
      method: 'request.resolved',
      requestId: 'req-1',
      status: 'approved',
    } as unknown as Parameters<typeof handleRequestResolvedEvent>[0]);

    expect(updateChat).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({
        pendingApprovals: ['req-2'],
        answeredApprovals: [],
      }),
    );
  });

  test('an accepted decision adds no notice of its own', async () => {
    vi.mocked(resolveOrchestrationRequest).mockResolvedValue(undefined);
    handleRequestOpenedEvent(
      'http://localhost:1',
      requestOpened({ toolName: 'Bash', toolInput: { command: 'ls' } }),
    );

    await click('Allow Once');

    expect(showToast).not.toHaveBeenCalled();
    expect(showToolApproval).toHaveBeenCalledTimes(1);
  });
});

describe('handleRequestDeliveryEvent — recorded vs acknowledged (#2880)', () => {
  function delivery(
    outcome: 'acknowledged' | 'unacknowledged',
    requestId: string,
    reason?: 'no-acknowledgement' | 'invalid-reply',
  ) {
    return {
      ...(reason ? { reason } : {}),
      eventId: `evt-${outcome}`,
      provider: 'codex',
      threadId: 'thread-1',
      createdAt: '2026-09-28T00:00:00.000Z',
      method: 'request.delivery',
      requestId,
      outcome,
      waitedMs: 30_000,
    } as unknown as Parameters<typeof handleRequestDeliveryEvent>[0];
  }

  beforeEach(() => {
    updateChat.mockClear();
    getChatForExecutionSession.mockReset();
  });

  test('an unacknowledged decision is listed on the chat with its reason', () => {
    getChatForExecutionSession.mockReturnValue({ unacknowledgedDecisions: [] });
    handleRequestDeliveryEvent(
      delivery('unacknowledged', 'req-1', 'no-acknowledgement'),
    );
    expect(updateChat).toHaveBeenCalledWith('thread-1', {
      unacknowledgedDecisions: [
        { requestId: 'req-1', reason: 'no-acknowledgement' },
      ],
    });
  });

  test('a refused reply is listed as invalid-reply, not as awaiting', () => {
    getChatForExecutionSession.mockReturnValue({ unacknowledgedDecisions: [] });
    handleRequestDeliveryEvent(
      delivery('unacknowledged', 'req-1', 'invalid-reply'),
    );
    expect(updateChat).toHaveBeenCalledWith('thread-1', {
      unacknowledgedDecisions: [
        { requestId: 'req-1', reason: 'invalid-reply' },
      ],
    });
  });

  test('an unacknowledged report after the session exited does not bring the note back', () => {
    getChatForExecutionSession.mockReturnValue({
      orchestrationStatus: 'exited',
      unacknowledgedDecisions: [],
    });
    handleRequestDeliveryEvent(
      delivery('unacknowledged', 'req-1', 'no-acknowledgement'),
    );
    expect(updateChat).not.toHaveBeenCalled();
  });

  test('a late acknowledgement takes only that decision off the list', () => {
    getChatForExecutionSession.mockReturnValue({
      unacknowledgedDecisions: [
        { requestId: 'req-1', reason: 'no-acknowledgement' },
        { requestId: 'req-2', reason: 'no-acknowledgement' },
      ],
    });
    handleRequestDeliveryEvent(delivery('acknowledged', 'req-1'));
    expect(updateChat).toHaveBeenCalledWith('thread-1', {
      unacknowledgedDecisions: [
        { requestId: 'req-2', reason: 'no-acknowledgement' },
      ],
    });
  });
});

test('nonblocking question events do not pause or revive chat and do not keep another approval waiting', () => {
  updateChat.mockClear();
  showToolApproval.mockClear();
  getChatForExecutionSession.mockReturnValue({
    title: 'Conversation',
    pendingApprovals: [],
    orchestrationStatus: 'running',
  });
  handleRequestOpenedEvent('http://localhost:1', {
    eventId: 'async-open',
    provider: 'codex',
    threadId: 'thread-1',
    createdAt: '2026-09-29T10:00:00Z',
    method: 'request.opened',
    requestId: 'async-q',
    requestType: 'approval',
    title: 'Question',
    blocking: false,
  });
  expect(updateChat).not.toHaveBeenCalled();
  expect(showToolApproval).not.toHaveBeenCalled();
  getChatForExecutionSession.mockReturnValue({
    pendingApprovals: ['permission'],
    orchestrationStatus: 'awaiting-approval',
  });
  handleRequestResolvedEvent({
    eventId: 'permission-close',
    provider: 'codex',
    threadId: 'thread-1',
    createdAt: '2026-09-29T10:00:01Z',
    method: 'request.resolved',
    requestId: 'permission',
    status: 'approved',
  });
  expect(updateChat.mock.lastCall?.[1]).toMatchObject({
    pendingApprovals: [],
    orchestrationStatus: 'running',
  });
  updateChat.mockClear();
  getChatForExecutionSession.mockReturnValue({
    pendingApprovals: [],
    orchestrationStatus: 'idle',
  });
  handleRequestResolvedEvent({
    eventId: 'async-close',
    provider: 'codex',
    threadId: 'thread-1',
    createdAt: '2026-09-29T10:00:02Z',
    method: 'request.resolved',
    requestId: 'async-q',
    status: 'cancelled',
    blocking: false,
  });
  expect(updateChat.mock.lastCall?.[1]).not.toHaveProperty(
    'orchestrationStatus',
  );
});

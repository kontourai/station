/**
 * @vitest-environment jsdom
 *
 * ACP tool-call rows and their approval, through the real client seam:
 * canonical runtime events shaped exactly as `AcpToolUpdateSupervisor` and
 * `acp-adapter.ts` publish them for OpenCode (see the matching server test,
 * `acp-adapter-events.test.ts` "the engine's tool kind") → the shared
 * transcript projection (`useActiveChatTranscript`) → `ChatMessageList` →
 * `MessageBubble`/`MessageContent` → `ToolCallDisplay`/`ToolCallBatch`.
 *
 * OpenCode reports no programmatic tool name, so `toolName` is the call's
 * human title: for its shell tool the whole command line, for its file tools
 * a path relative to the worktree. `toolKind` is the ACP `kind` it sends.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { _setApiBase } from '@kontourai/station-sdk';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
  useAgentsLoaded: () => true,
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3242' }),
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => vi.fn(),
}));
vi.mock('../components/chat/StreamingMessage', () => ({
  StreamingMessage: () => <div data-testid="streaming-message">Streaming</div>,
}));
vi.mock('../components/chat/SessionSummaryCard', () => ({
  SessionSummaryCard: () => null,
}));
vi.mock('../components/chat/message-bubble/MessageRating', () => ({
  MessageRating: () => null,
}));
vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => <span aria-hidden="true">U</span>,
}));

const { windowEvents } = vi.hoisted(() => ({
  windowEvents: {
    current: [] as Array<{ sequence: number; event: unknown }>,
  },
}));
vi.mock('../hooks/orchestration/useSessionEventWindow', () => ({
  useSessionEventWindow: () => ({
    events: windowEvents.current,
    handoffs: [],
    contextBoundaries: [],
    hasMore: false,
    loadOlder: () => undefined,
    reload: () => undefined,
    upgradeRequired: false,
    loading: false,
    settled: true,
    error: undefined,
  }),
}));

import { ChatMessageList } from '../components/chat/ChatMessageList';
import {
  DocumentGlyph,
  EditGlyph,
  PlugGlyph,
  SearchGlyph,
  TerminalGlyph,
} from '../components/icons/Glyph';
import { ActiveChatsProvider } from '../contexts/ActiveChatsContext';
import { useActiveChatTranscript } from '../hooks/orchestration/useActiveChatTranscript';
import type { ChatSession } from '../types';

const API_BASE = 'http://localhost:3242';
const THREAD = 'opencode-thread';

function chatSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'chat-tab',
    conversationId: THREAD,
    currentSessionId: THREAD,
    agentSlug: agentId('opencode'),
    agentName: 'OpenCode',
    title: 'opencode chat',
    source: 'manual',
    messages: [],
    input: '',
    attachments: [],
    queuedMessages: [],
    inputHistory: [],
    status: 'idle',
    error: null,
    createdAt: 0,
    updatedAt: 0,
    hasUnread: false,
    orchestrationSessionStarted: true,
    orchestrationHistoryRevision: 0,
    ...overrides,
  };
}

let sequence = 0;
function runtimeEvent(fields: Record<string, unknown>) {
  sequence += 1;
  return {
    sequence,
    event: {
      eventId: `evt-${sequence}`,
      provider: 'acp',
      threadId: THREAD,
      createdAt: `2026-09-28T19:29:${String(sequence).padStart(2, '0')}.000Z`,
      ...fields,
    },
  };
}

/**
 * One OpenCode call as the supervisor publishes it: `tool.started` from the
 * `pending` update (title = the tool id, no input), a corrected `tool.started`
 * from `in_progress` (title = display text, rawInput), then the terminal.
 */
function opencodeCall(
  id: string,
  turnId: string,
  tool: string,
  toolKind: string | undefined,
  title: string,
  input: Record<string, unknown>,
) {
  const kind = toolKind === undefined ? {} : { toolKind };
  return [
    runtimeEvent({
      method: 'tool.started',
      turnId,
      itemId: id,
      toolCallId: id,
      toolName: tool,
      ...kind,
      arguments: {},
    }),
    runtimeEvent({
      method: 'tool.started',
      turnId,
      itemId: id,
      toolCallId: id,
      toolName: title,
      ...kind,
      arguments: input,
    }),
    runtimeEvent({
      method: 'tool.completed',
      turnId,
      itemId: id,
      toolCallId: id,
      toolName: title,
      ...kind,
      status: 'success',
      output: [{ type: 'text', text: 'ok' }],
    }),
  ];
}

const text = (turnId: string, delta: string) =>
  runtimeEvent({
    method: 'content.text-delta',
    turnId,
    itemId: `${turnId}:text:${sequence}`,
    delta,
  });

function TranscriptHarness({ session }: { session: ChatSession }) {
  const transcript = useActiveChatTranscript(API_BASE, session);
  return (
    <ChatMessageList
      activeSession={{ ...session, messages: transcript.messages }}
      approvalEvents={transcript.enabled ? transcript.events : undefined}
      approvalEventsSettled={transcript.settled}
      suppressStreamingRow={transcript.openTurnProjected}
      fontSize={13}
      showReasoning={false}
      showToolDetails={false}
    />
  );
}

function renderTranscript(session = chatSession()) {
  return render(
    <ActiveChatsProvider>
      <TranscriptHarness session={session} />
    </ActiveChatsProvider>,
  );
}

/** The `d` of a glyph's one path — how a row's icon is told apart. */
function glyphPath(Glyph: React.ComponentType<{ className?: string }>) {
  return /\sd="([^"]+)"/.exec(renderToStaticMarkup(<Glyph />))?.[1];
}

function rowFor(labelStart: string): HTMLElement {
  const label = screen
    .getAllByText((content, element) =>
      Boolean(
        element?.classList.contains('tool-call__label') &&
          content.startsWith(labelStart),
      ),
    )
    .at(0);
  const row = label?.closest<HTMLElement>('.tool-call');
  if (!row) throw new Error(`no tool-call row labelled ${labelStart}`);
  return row;
}

function rowGlyph(row: HTMLElement) {
  return row.querySelector('.tool-call__glyph path')?.getAttribute('d');
}

describe('ACP (OpenCode) tool rows', () => {
  beforeEach(() => {
    _setApiBase(API_BASE);
    sequence = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ success: true, data: [] })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    _setApiBase('');
  });

  test('a shell title is shown as written, as a command, never rewritten or guessed from its words', async () => {
    const ps = 'echo "=== PROCS ==="; ps -o pid,lstart,etime,rss,cmd -p 946878';
    const fetchCmd =
      'cd /tmp && gh api x --jq .c | base64 -d > gsd.mjs && wc -l';
    const status = 'git status --short; echo; grep -n version package.json';
    const gate =
      'STATION_DOCS_FRESHNESS=scoped STATION_DOCS_MODE=full npm run gate:for -- Dockerfile docs/user/getting-started.md';
    windowEvents.current = [
      runtimeEvent({ method: 'turn.started', turnId: 't1', prompt: 'Check' }),
      ...opencodeCall('c1', 't1', 'bash', 'execute', ps, {
        command: ps,
        description: 'List processes',
        cwd: '/repo',
      }),
      text('t1', 'Checked. '),
      ...opencodeCall('c2', 't1', 'bash', 'execute', fetchCmd, {
        command: fetchCmd,
        description: 'Fetch the file',
        cwd: '/tmp',
      }),
      text('t1', 'Fetched. '),
      ...opencodeCall('c3', 't1', 'bash', 'execute', status, {
        command: status,
        description: 'Check the tree',
        cwd: '/repo',
      }),
      text('t1', 'Clean. '),
      ...opencodeCall('c4', 't1', 'bash', 'execute', gate, {
        command: gate,
        description: 'Gate',
        cwd: '/repo',
      }),
      text('t1', 'Gated. '),
      // A transcript recorded before `toolKind` existed: the arguments'
      // shape still says this is a command.
      ...opencodeCall('c5', 't1', 'bash', undefined, 'ls -la /tmp', {
        command: 'ls -la /tmp',
        description: 'List',
      }),
      text('t1', 'Done.'),
      runtimeEvent({ method: 'turn.completed', turnId: 't1' }),
    ];
    renderTranscript();

    const terminal = glyphPath(TerminalGlyph);
    await waitFor(() => expect(rowFor('Ran echo')).toBeTruthy());
    // Item 1: the command's own text, flags and all.
    expect(rowFor('Ran echo').textContent).toContain(
      'ps -o pid,lstart,etime,rss,cmd',
    );
    // Item 2: a command that writes a file is a command, not "Read"/"Search".
    expect(rowFor('Ran cd /tmp && gh api').textContent).toContain(
      'base64 -d > gsd.mjs',
    );
    expect(rowFor('Ran git status --short; echo; grep')).toBeTruthy();
    // Item 4: leading env assignments give way to the command; `--` and the
    // hyphenated path survive.
    expect(rowFor('Ran npm run gate:for -- Dockerfile').textContent).toContain(
      'docs/user/getting-started.md',
    );
    expect(rowFor('Ran ls -la /tmp')).toBeTruthy();
    for (const label of [
      'Ran echo',
      'Ran cd /tmp',
      'Ran git status',
      'Ran npm run gate:for',
      'Ran ls -la',
    ]) {
      expect(rowGlyph(rowFor(label)), label).toBe(terminal);
    }
    expect(screen.queryByText(/^(Read|Searched|Used) /)).toBeNull();
  });

  test('file tools take their kind and name the file, not the worktree-relative title', async () => {
    windowEvents.current = [
      runtimeEvent({ method: 'turn.started', turnId: 't1', prompt: 'Write' }),
      ...opencodeCall(
        'w1',
        't1',
        'write',
        'edit',
        '../../../../../../tmp/bgp.mjs',
        { filePath: '/tmp/bgp.mjs', content: 'export {}' },
      ),
      text('t1', 'Wrote. '),
      ...opencodeCall('r1', 't1', 'read', 'read', 'src/app.tsx', {
        filePath: '/repo/src/app.tsx',
      }),
      text('t1', 'Read. '),
      ...opencodeCall('g1', 't1', 'grep', 'search', 'version', {
        pattern: 'version',
        path: '/repo',
      }),
      text('t1', 'Done.'),
      runtimeEvent({ method: 'turn.completed', turnId: 't1' }),
    ];
    renderTranscript();

    await waitFor(() => expect(rowFor('Edited bgp.mjs')).toBeTruthy());
    expect(rowGlyph(rowFor('Edited bgp.mjs'))).toBe(glyphPath(EditGlyph));
    expect(rowGlyph(rowFor('Read app.tsx'))).toBe(glyphPath(DocumentGlyph));
    expect(rowGlyph(rowFor('Searched version'))).toBe(glyphPath(SearchGlyph));
    expect(screen.queryByText(/\.\.\/\.\.\//)).toBeNull();
    expect(glyphPath(PlugGlyph)).not.toBe(glyphPath(TerminalGlyph));
  });

  test('one pending approval in the open turn is one actionable card, and its grant names no command', async () => {
    const fetchCmd =
      'cd /tmp && gh api "repos/o/r/contents/gen.mjs" --jq .content | base64 -d > gsd.mjs';
    windowEvents.current = [
      runtimeEvent({ method: 'turn.started', turnId: 't2', prompt: 'Fetch' }),
      ...opencodeCall('r1', 't2', 'read', 'read', 'package.json', {
        filePath: '/repo/package.json',
      }),
      runtimeEvent({
        method: 'tool.started',
        turnId: 't2',
        itemId: 'c9',
        toolCallId: 'c9',
        toolName: fetchCmd,
        toolKind: 'execute',
        arguments: { command: fetchCmd, description: 'Fetch', cwd: '/tmp' },
      }),
      // acp-adapter.ts `requestPermission` for OpenCode: no tool name.
      runtimeEvent({
        method: 'request.opened',
        requestId: 'req-1',
        requestType: 'approval',
        title: fetchCmd,
        payload: {
          toolCallId: 'c9',
          rawInput: { command: fetchCmd, description: 'Fetch', cwd: '/tmp' },
          toolKind: 'execute',
          options: [],
        },
      }),
    ];
    renderTranscript(
      chatSession({
        status: 'sending',
        orchestrationTurnOpen: true,
        openTurnId: 't2',
      }),
    );

    // The batch surfaces the pending call without being opened…
    await waitFor(() =>
      expect(
        screen.getAllByRole('button', { name: 'Allow Once' }),
      ).toHaveLength(1),
    );
    // …and nothing else renders a second copy of the same decision.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getAllByRole('button', { name: 'Allow Once' })).toHaveLength(
      1,
    );
    expect(screen.getAllByRole('button', { name: 'Deny' })).toHaveLength(1);
    // Item 5: the same grant words as the toast and the inbox card; the
    // command line is not the grant's subject.
    const grant = screen.getByRole('button', {
      name: 'Allow for this session',
    });
    expect(grant.textContent).not.toContain('gh api');
    // The card says which request it answers, so the header pill can find it.
    const card = grant.closest<HTMLElement>('.tool-call');
    expect(card?.dataset.approvalId).toBe('req-1');
    expect(card?.dataset.approvalThread).toBe(THREAD);
    // Item 2 on the pending path: proposed, so the bare verb — of a command.
    expect(card?.querySelector('.tool-call__label')?.textContent).toMatch(
      /^Run cd \/tmp && gh api/,
    );
  });

  test("Claude's approval in the open turn is one actionable card too", async () => {
    // claude-adapter.ts `canUseTool`: the payload names the tool and the
    // SDK's tool_use id, which `tool.started` carries as its toolCallId.
    windowEvents.current = [
      runtimeEvent({ method: 'turn.started', turnId: 't3', prompt: 'Edit' }),
      runtimeEvent({
        method: 'tool.started',
        provider: 'claude',
        turnId: 't3',
        itemId: 'toolu_1',
        toolCallId: 'toolu_1',
        toolName: 'Edit',
        arguments: {
          file_path: '/repo/approved.txt',
          old_string: 'a',
          new_string: 'b',
        },
      }),
      runtimeEvent({
        method: 'request.opened',
        provider: 'claude',
        requestId: 'req-claude',
        requestType: 'approval',
        title: 'Allow Edit',
        payload: {
          toolName: 'Edit',
          toolCallId: 'toolu_1',
          toolInput: {
            file_path: '/repo/approved.txt',
            old_string: 'a',
            new_string: 'b',
          },
        },
      }),
    ];
    renderTranscript(
      chatSession({
        status: 'sending',
        orchestrationTurnOpen: true,
        openTurnId: 't3',
      }),
    );
    await waitFor(() =>
      expect(
        screen.getAllByRole('button', { name: 'Allow Once' }),
      ).toHaveLength(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getAllByRole('button', { name: 'Allow Once' })).toHaveLength(
      1,
    );
    // #2915: a Claude Edit asked with no acceptEdits suggestion has nothing a
    // session answer could forward, so no session option is offered.
    expect(
      screen.queryByRole('button', { name: /for this session/ }),
    ).toBeNull();
    expect(screen.getAllByText(/^Edit approved\.txt/)).toHaveLength(1);
  });
});

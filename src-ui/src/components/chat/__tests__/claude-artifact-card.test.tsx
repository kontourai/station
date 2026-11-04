/**
 * @vitest-environment jsdom
 */

import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const hostOwnsExternalLinks = vi.fn(() => false);
const openNativeExternalLink = vi.fn(async (_url: string) => true);

vi.mock('../../../platform/openExternalLink', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../platform/openExternalLink')
  >()),
  hostOwnsExternalLinks: () => hostOwnsExternalLinks(),
  openNativeExternalLink: (url: string) => openNativeExternalLink(url),
}));

import { conversationPartToContentParts } from '../../../hooks/orchestration/conversationTranscriptParts';
import { MessageContent } from '../message-bubble/MessageContent';
import { ToolCallDisplay } from '../ToolCallDisplay';
import { foldTurnWork, splitToolCallRuns } from '../tool-call-runs';

const ARTIFACT_URL =
  'https://claude.ai/code/artifact/5f0c2e4a-8d1b-4c33-9a7e-1b2c3d4e5f60';

/**
 * An `Artifact` publish as the transcript holds it: the call's arguments,
 * the engine's text result, and the link the Claude adapter read from the
 * SDK's structured output (`ArtifactOutput`'s publish variant).
 */
function publishPart(overrides: Record<string, unknown> = {}) {
  return {
    type: 'tool-invocation',
    toolCallId: 'toolu-art',
    toolName: 'Artifact',
    args: {
      file_path: '/workspace/project/latency-report.html',
      icon: 'chart',
    },
    state: 'completed',
    result: `Published Q3 latency report: ${ARTIFACT_URL}`,
    claudeArtifact: { url: ARTIFACT_URL, title: 'Q3 latency report' },
    ...overrides,
  };
}

afterEach(cleanup);

describe('Claude Code Artifact publish card', () => {
  beforeEach(() => {
    hostOwnsExternalLinks.mockReturnValue(false);
    openNativeExternalLink.mockClear();
  });

  test('a publish renders as a link to its claude.ai page', () => {
    render(<ToolCallDisplay toolCall={publishPart()} />);

    const link = screen.getByRole('link', { name: /Q3 latency report/ });
    expect(link.getAttribute('href')).toBe(ARTIFACT_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toContain(ARTIFACT_URL);
    expect(screen.getByText('Published artifact')).toBeTruthy();
    // Not the generic row: no disclosure over the raw result.
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('a publish without a title is labelled by its address', () => {
    render(
      <ToolCallDisplay
        toolCall={publishPart({ claudeArtifact: { url: ARTIFACT_URL } })}
      />,
    );
    const link = screen.getByRole('link', { name: new RegExp(ARTIFACT_URL) });
    expect(link.getAttribute('href')).toBe(ARTIFACT_URL);
  });

  test('in the app, the native host opens it instead of the webview', () => {
    hostOwnsExternalLinks.mockReturnValue(true);
    render(<ToolCallDisplay toolCall={publishPart()} />);
    const link = screen.getByRole('link', { name: /Q3 latency report/ });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(link, click);
    expect(click.defaultPrevented).toBe(true);
    expect(openNativeExternalLink).toHaveBeenCalledWith(ARTIFACT_URL);
  });

  test.each([
    ['a lookalike host', { url: 'https://claude.ai.evil.example/artifact/x' }],
    ['plain http', { url: 'http://claude.ai/artifact/x' }],
    ['a malformed address', { url: 'not a url' }],
    ['no link at all', undefined],
  ])('%s falls back to the generic tool row', (_name, claudeArtifact) => {
    render(<ToolCallDisplay toolCall={publishPart({ claudeArtifact })} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText('Published artifact')).toBeNull();
    expect(screen.getByRole('button', { name: /Artifact/ })).toBeTruthy();
  });

  test('a failed call keeps the generic row even with a link', () => {
    render(
      <ToolCallDisplay
        toolCall={publishPart({ state: 'error', error: 'Publish refused' })}
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Failed')).toBeTruthy();
  });

  test('a publish is its own row and stays out of a folded turn', () => {
    const read = {
      type: 'tool-invocation',
      toolCallId: 'toolu-read',
      toolName: 'Read',
      args: { file_path: 'a.ts' },
      state: 'completed',
      result: 'x',
    };
    const bash = { ...read, toolCallId: 'toolu-bash', toolName: 'Bash' };
    const text = { type: 'text', content: 'Writing the report.' };
    const parts = [read, publishPart(), bash];

    const runs = splitToolCallRuns(parts);
    expect(runs.map((block) => block.type)).toEqual([
      'tool-call-run',
      'tool-call-run',
      'tool-call-run',
    ]);
    expect(
      runs.map((block) =>
        block.type === 'tool-call-run'
          ? block.calls.map((call) => call.part.toolCallId)
          : [],
      ),
    ).toEqual([['toolu-read'], ['toolu-art'], ['toolu-bash']]);

    const folded = foldTurnWork([read, text, publishPart(), bash]);
    const callIds = folded.map((block) =>
      block.type === 'tool-call-run'
        ? block.calls.map(
            (call) => (call.part as { toolCallId?: string }).toolCallId,
          )
        : [],
    );
    expect(callIds).toContainEqual(['toolu-read', 'toolu-bash']);
    expect(callIds).toContainEqual(['toolu-art']);
  });
});

describe('Claude Code Artifact publish in a restored transcript', () => {
  /** The stored call and result as the Claude adapter publishes them. */
  function events(claudeArtifact: unknown) {
    const base = {
      provider: 'claude',
      threadId: 'session-a',
      turnId: 'turn-a',
      itemId: 'toolu-art',
      toolCallId: 'toolu-art',
      toolName: 'Artifact',
    };
    return [
      {
        ...base,
        eventId: 'call',
        method: 'tool.started',
        arguments: { file_path: '/workspace/project/latency-report.html' },
        createdAt: '2026-10-29T12:00:00.000Z',
      },
      {
        ...base,
        eventId: 'done',
        method: 'tool.completed',
        status: 'success',
        output: 'Published.',
        claudeArtifact,
        createdAt: '2026-10-29T12:00:01.000Z',
      },
    ];
  }

  function renderRestored(claudeArtifact: unknown) {
    const rows = projectRuntimeEventsToMessages(
      events(claudeArtifact) as never,
      { stableIds: true },
    );
    const row = rows.find((candidate) => candidate.role === 'assistant');
    if (!row)
      throw new Error('The publish did not project to an assistant row');
    const query = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={query}>
        <MessageContent
          contentParts={row.parts.flatMap(conversationPartToContentParts)}
          textContent=""
          chatFontSize={14}
          showReasoning={false}
          showToolDetails={false}
          isStreamingMessage={false}
          foldWork
        />
      </QueryClientProvider>,
    );
  }

  test('the projected part renders as the link card in a folded transcript', () => {
    renderRestored({ url: ARTIFACT_URL, title: 'Q3 latency report' });
    const link = screen.getByRole('link', { name: /Q3 latency report/ });
    expect(link.getAttribute('href')).toBe(ARTIFACT_URL);
  });

  test('a stored link that does not check out shows no link', () => {
    renderRestored({ url: 'https://claude.ai.evil.example/a' });
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText('Published artifact')).toBeNull();
  });
});

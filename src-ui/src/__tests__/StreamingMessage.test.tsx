/**
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const useStreamingContent = vi.fn();

vi.mock('../hooks/useStreamingContent', () => ({
  useStreamingContent: (sessionId: string) => useStreamingContent(sessionId),
}));

import { StreamingMessage } from '../components/chat/StreamingMessage';

describe('StreamingMessage', () => {
  beforeEach(() => {
    useStreamingContent.mockReset();
  });

  test('renders tool progress status for a running tool with progress text', () => {
    useStreamingContent.mockReturnValue({
      streamingText: '',
      hasContent: true,
      contentParts: [
        {
          type: 'tool-invocation',
          toolCallId: 'tool-1',
          toolName: 'search_files',
          state: 'running',
          progressMessage: 'Scanning project files',
        },
      ],
    });

    render(
      <StreamingMessage
        sessionId="session-1"
        agentIcon={<div>AI</div>}
        agentIconStyle={{}}
        fontSize={14}
      />,
    );

    expect(screen.getByRole('status').textContent).toContain(
      'Scanning project files',
    );
    expect(screen.getByText('search files')).toBeTruthy();
  });

  test('renders fallback progress text for a running tool without progress text', () => {
    useStreamingContent.mockReturnValue({
      streamingText: '',
      hasContent: true,
      contentParts: [
        {
          type: 'tool-invocation',
          toolCallId: 'tool-2',
          toolName: 'run_tests',
          state: 'running',
        },
      ],
    });

    render(
      <StreamingMessage
        sessionId="session-2"
        agentIcon={<div>AI</div>}
        agentIconStyle={{}}
        fontSize={14}
      />,
    );

    expect(screen.getByRole('status').textContent).toContain(
      'Running run tests',
    );
  });

  test('renders ui blocks emitted from tool output parts', () => {
    useStreamingContent.mockReturnValue({
      streamingText: '',
      hasContent: true,
      contentParts: [
        {
          type: 'ui-block',
          uiBlock: {
            type: 'card',
            title: 'Build Summary',
            body: 'All checks passed',
            fields: [{ label: 'Coverage', value: '98%' }],
          },
        },
      ],
    });

    render(
      <StreamingMessage
        sessionId="session-3"
        agentIcon={<div>AI</div>}
        agentIconStyle={{}}
        fontSize={14}
      />,
    );

    expect(screen.getByText('Build Summary')).toBeTruthy();
    expect(screen.getByText('All checks passed')).toBeTruthy();
    expect(screen.getByText('98%')).toBeTruthy();
  });

  describe('station#1424 review fix (S3, then round 3 NEW-1): attribution renders from the first streaming frame, with the SAME fields a persisted row shows', () => {
    beforeEach(() => {
      useStreamingContent.mockReturnValue({
        streamingText: 'Working on it…',
        hasContent: true,
        contentParts: [],
      });
    });

    test('renders the live agent identity and owner chip while still streaming — not only once the turn settles into a persisted row', () => {
      render(
        <StreamingMessage
          sessionId="session-4"
          agentIcon={<div>AI</div>}
          agentIconStyle={{}}
          fontSize={14}
          attributionAgent={{ name: 'Release Reviewer' }}
          owner={{ id: 'brian', label: 'Brian Anderson' }}
        />,
      );
      expect(screen.getByText('Release Reviewer')).toBeTruthy();
      expect(screen.getByText(/via Brian Anderson/)).toBeTruthy();
    });

    test('station#1424 review round 3 (NEW-1): never renders an engine chip while streaming — no `engine` prop exists on this component any more, so there is nothing that could assert an engine identity here only to retract it once the row persists', () => {
      const { container } = render(
        <StreamingMessage
          sessionId="session-4b"
          agentIcon={<div>AI</div>}
          agentIconStyle={{}}
          fontSize={14}
          attributionAgent={{ name: 'Release Reviewer' }}
          owner={{ id: 'brian', label: 'Brian Anderson' }}
        />,
      );
      expect(container.querySelector('.engine-chip')).toBeNull();
    });

    test('renders no attribution strip at all when none of the props are supplied (default call sites unaffected)', () => {
      const { container } = render(
        <StreamingMessage
          sessionId="session-5"
          agentIcon={<div>AI</div>}
          agentIconStyle={{}}
          fontSize={14}
        />,
      );
      expect(container.querySelector('.message-attribution')).toBeNull();
    });
  });
});

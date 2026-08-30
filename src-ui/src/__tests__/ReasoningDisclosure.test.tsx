/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { MessageContent } from '../components/chat/message-bubble/MessageContent';
import {
  __resetReasoningDisclosureIntents,
  ReasoningSection,
} from '../components/chat/ReasoningSection';

/**
 * station#55: reasoning is a collapsed-by-default disclosure, subordinate to
 * the answer. Lives in its own file rather than beside the runtime-error
 * translation suite it was first drafted into — a reader looking for the
 * disclosure's contract should find it by name.
 */

afterEach(() => {
  cleanup();
  // Explicit intents deliberately outlive components (they must survive the
  // streaming -> settled remount), so tests must not inherit each other's.
  __resetReasoningDisclosureIntents();
});

const REASONING = 'inspect the request compare the evidence choose the answer';

function reasoningSection(content = REASONING) {
  return (
    <ReasoningSection content={content} fontSize={14} show hasAnswerText />
  );
}

describe('reasoning disclosure (station#55)', () => {
  test('starts collapsed beside an answer and reports its derived word count', () => {
    const content = Array.from(
      { length: 1_240 },
      (_, index) => `word${index}`,
    ).join(' ');
    render(reasoningSection(content));

    const summary = screen.getByRole('button', {
      name: 'Reasoning · 1,240 words',
    });
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(content)).toBeNull();
  });

  test('expands and collapses by pointer and keyboard-originated activation', () => {
    render(reasoningSection());
    const summary = screen.getByRole('button', { name: /Reasoning/ });

    fireEvent.click(summary);
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(REASONING)).toBeTruthy();

    fireEvent.click(summary);
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(REASONING)).toBeNull();

    summary.focus();
    expect(document.activeElement).toBe(summary);
    // Enter/Space on a native focused button dispatches a detail=0 click.
    fireEvent.click(summary, { detail: 0 });
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(REASONING)).toBeTruthy();
  });

  test('keeps disclosure state isolated per message', () => {
    render(
      <>
        <ReasoningSection
          content="first private trace"
          fontSize={14}
          show
          hasAnswerText
        />
        <ReasoningSection
          content="second private trace"
          fontSize={14}
          show
          hasAnswerText
        />
      </>,
    );
    const summaries = screen.getAllByRole('button', { name: /Reasoning/ });

    fireEvent.click(summaries[0]);

    expect(summaries[0].getAttribute('aria-expanded')).toBe('true');
    expect(summaries[1].getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('first private trace')).toBeTruthy();
    expect(screen.queryByText('second private trace')).toBeNull();
  });

  test('real message parts auto-expand reasoning-only streaming state and collapse when answer text arrives', async () => {
    const reasoningPart = { type: 'reasoning', content: REASONING } as const;
    const view = render(
      <MessageContent
        contentParts={[reasoningPart]}
        textContent=""
        chatFontSize={14}
        showReasoning
        showToolDetails={false}
        isStreamingMessage
      />,
    );

    expect(screen.getByText(REASONING)).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: /Reasoning/ })
        .getAttribute('aria-expanded'),
    ).toBe('true');

    view.rerender(
      <MessageContent
        contentParts={[reasoningPart, { type: 'text', content: 'pong' }]}
        textContent=""
        chatFontSize={14}
        showReasoning
        showToolDetails={false}
        isStreamingMessage
      />,
    );

    await waitFor(() => expect(screen.getByText('pong')).toBeTruthy());
    expect(
      screen
        .getByRole('button', { name: /Reasoning/ })
        .getAttribute('aria-expanded'),
    ).toBe('false');
    expect(screen.queryByText(REASONING)).toBeNull();
  });

  test('a user-opened streaming disclosure stays open when answer text arrives', async () => {
    const reasoningPart = { type: 'reasoning', content: REASONING } as const;
    const view = render(
      <MessageContent
        contentParts={[reasoningPart]}
        textContent=""
        chatFontSize={14}
        showReasoning
        showToolDetails={false}
        isStreamingMessage
      />,
    );
    const summary = screen.getByRole('button', { name: /Reasoning/ });

    // The automatic reasoning-only state starts open. Close and explicitly
    // reopen it so subsequent answer arrival must preserve user intent.
    fireEvent.click(summary);
    fireEvent.click(summary);
    expect(summary.getAttribute('aria-expanded')).toBe('true');

    view.rerender(
      <MessageContent
        contentParts={[reasoningPart, { type: 'text', content: 'pong' }]}
        textContent=""
        chatFontSize={14}
        showReasoning
        showToolDetails={false}
        isStreamingMessage
      />,
    );

    await waitFor(() => expect(screen.getByText('pong')).toBeTruthy());
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(REASONING)).toBeTruthy();
  });

  test('an explicit choice survives the streaming -> settled remount', () => {
    // The disclosure's main scenario: a reader opens the reasoning mid-turn,
    // the turn completes, and the row is re-rendered by a DIFFERENT component
    // instance. Component-local state would snap it shut exactly there.
    const view = render(reasoningSection());
    const summary = screen.getByRole('button', { name: /Reasoning/ });
    fireEvent.click(summary);
    expect(summary.getAttribute('aria-expanded')).toBe('true');

    view.unmount();
    render(reasoningSection());

    expect(
      screen
        .getByRole('button', { name: /Reasoning/ })
        .getAttribute('aria-expanded'),
    ).toBe('true');
    expect(screen.getByText(REASONING)).toBeTruthy();
  });

  test('an explicit close also survives the remount', () => {
    const view = render(
      <ReasoningSection
        content={REASONING}
        fontSize={14}
        show
        hasAnswerText={false}
      />,
    );
    // Automatic mode starts open with no answer yet; closing is explicit.
    fireEvent.click(screen.getByRole('button', { name: /Reasoning/ }));
    view.unmount();

    render(
      <ReasoningSection
        content={REASONING}
        fontSize={14}
        show
        hasAnswerText={false}
      />,
    );
    expect(
      screen
        .getByRole('button', { name: /Reasoning/ })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });

  test('a whitespace-only first delta is not an answer', () => {
    const reasoningPart = { type: 'reasoning', content: REASONING } as const;
    const view = render(
      <MessageContent
        contentParts={[reasoningPart]}
        textContent=""
        chatFontSize={14}
        showReasoning
        showToolDetails={false}
        isStreamingMessage
      />,
    );
    const summary = screen.getByRole('button', { name: /Reasoning/ });
    expect(summary.getAttribute('aria-expanded')).toBe('true');

    // Models routinely emit "\n\n" before the first real token. Collapsing
    // there empties the surface: reasoning gone, answer not yet visible.
    view.rerender(
      <MessageContent
        contentParts={[reasoningPart, { type: 'text', content: '\n\n' }]}
        textContent=""
        chatFontSize={14}
        showReasoning
        showToolDetails={false}
        isStreamingMessage
      />,
    );
    expect(
      screen
        .getByRole('button', { name: /Reasoning/ })
        .getAttribute('aria-expanded'),
    ).toBe('true');
  });

  test('counts words in a script without whitespace boundaries', () => {
    // Whitespace splitting calls this one word; the count is the reader's
    // only signal of how much is hidden.
    render(reasoningSection('请求已收到证据已比对答案已选定'));
    const summary = screen.getByRole('button', { name: /Reasoning/ });
    const label = summary.textContent ?? '';
    const count = Number(/([\d,]+)/.exec(label)?.[1]?.replace(/,/g, '') ?? '0');
    expect(count).toBeGreaterThan(1);
  });

  test('both chat consumers render the shared ReasoningSection', () => {
    const uiRoot = join(process.cwd(), 'src-ui/src/components/chat');
    const streamingConsumer = readFileSync(
      join(uiRoot, 'ChatMessageList.tsx'),
      'utf8',
    );
    const settledConsumer = readFileSync(
      join(uiRoot, 'message-bubble/MessageContent.tsx'),
      'utf8',
    );

    for (const source of [streamingConsumer, settledConsumer]) {
      expect(source).toContain('import { ReasoningSection }');
      expect(source).toContain('<ReasoningSection');
      expect(source).toContain('hasAnswerText=');
    }
  });
});

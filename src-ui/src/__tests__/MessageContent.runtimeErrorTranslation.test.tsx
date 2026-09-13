/**
 * @vitest-environment jsdom
 *
 * #765 A1 — the durable-projection half of the failure presentation. A
 * chat rehydrated from the server event window renders its `runtime.error`
 * as an ordinary text part (`runtime-event-projection.ts` writes
 * `⚠️ <raw engine prose>` with `runtimeError: true` and, when the durable
 * event carried one, `runtimeErrorCode`). The audit's re-verification
 * (#765, main 3088300c8) showed exactly that raw prose — a verbatim
 * "No conversation found with session ID: <uuid>" — as the whole failure
 * story. These pin: a CODED part renders the same translated copy the live
 * SSE path shows (raw text demoted to the disclosure), and an UNCODED part
 * keeps its verbatim engine prose — the same honesty rule the live
 * `turnHandlers.ts` path applies.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import { MessageContent } from '../components/chat/message-bubble/MessageContent';

afterEach(cleanup);

const RAW_MESSAGE =
  'No conversation found with session ID: d434e194-cc2e-4edc-8733-d8645c512fab';

function renderPart(part: Record<string, unknown>) {
  return render(
    <MessageContent
      contentParts={[part as any]}
      textContent=""
      chatFontSize={14}
      showReasoning={false}
      showToolDetails={false}
      isStreamingMessage={false}
    />,
  );
}

describe('MessageContent projected runtime-error translation (#765 A1)', () => {
  test('a coded runtime-error part renders translated copy with the raw prose demoted to the disclosure', async () => {
    const { container } = renderPart({
      type: 'text',
      content: `⚠️ ${RAW_MESSAGE}`,
      runtimeError: true,
      runtimeErrorCode: 'engine-session-binding-dead',
    });

    // LazyMarkdown resolves asynchronously.
    await waitFor(() =>
      expect(container.textContent).toMatch(/engine session was lost/i),
    );
    // The raw engine text survives as the labeled disclosure, strictly after
    // the translated headline — never AS the headline.
    expect(container.textContent).toContain(RAW_MESSAGE);
    expect(container.textContent!.indexOf(RAW_MESSAGE)).toBeGreaterThan(
      container.textContent!.toLowerCase().indexOf('engine session was lost'),
    );
  });

  test('an uncoded runtime-error part keeps its verbatim engine prose', async () => {
    const { container } = renderPart({
      type: 'text',
      content: `⚠️ ${RAW_MESSAGE}`,
      runtimeError: true,
    });

    await waitFor(() => expect(container.textContent).toContain(RAW_MESSAGE));
    expect(container.textContent).not.toMatch(/engine session was lost/i);
  });

  test('a part with an unmapped code keeps its verbatim engine prose', async () => {
    const { container } = renderPart({
      type: 'text',
      content: '⚠️ some other failure',
      runtimeError: true,
      runtimeErrorCode: 'some-unmapped-code',
    });

    await waitFor(() =>
      expect(container.textContent).toContain('some other failure'),
    );
    expect(container.textContent).not.toMatch(/engine session was lost/i);
  });
});

test('a failed engine turn preserves its refusal without claiming the session was lost', async () => {
  const message =
    "API Error: Opus 5 (1M context)'s safeguards flagged this message.";
  const { container } = renderPart({
    type: 'text',
    content: `⚠️ ${message}`,
    runtimeError: true,
    runtimeErrorCode: 'engine-turn-failed',
  });
  await waitFor(() =>
    expect(container.textContent).toContain('This turn did not complete'),
  );
  expect(container.textContent).toContain(message);
  expect(container.textContent).not.toMatch(
    /engine session was lost|fresh engine session|send your message again/i,
  );
});

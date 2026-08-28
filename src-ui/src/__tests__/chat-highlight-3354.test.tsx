/**
 * @vitest-environment jsdom
 *
 * archive#3354 — the three chat-highlighting defects, as user-visible
 * behavior:
 *   1. an unclosed fence renders PLAIN and never reaches the highlighter
 *      (no tokenization during streaming, nothing partial cached);
 *   2. a closed fence IS highlighted;
 *   3. a persisted message keeps its highlighting (regression: text parts
 *      previously rendered plain once the turn settled).
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const highlightCode = vi.fn((code: string, lang: string) =>
  Promise.resolve(`<pre data-testid="hl" data-lang="${lang}">${code}</pre>`),
);
vi.mock('../highlight/highlight-client', () => ({ highlightCode }));

vi.mock('../platform/native/haptics', () => ({
  triggerHaptic: () => {},
}));

import { MessageContent } from '../components/chat/message-bubble/MessageContent';
import { StreamingMarkdown } from '../components/chat/StreamingMarkdown';

afterEach(() => {
  cleanup();
  highlightCode.mockClear();
});

describe('streaming: unclosed fence renders plain, uncached (station#3354)', () => {
  test('mid-stream flush with an open fence highlights nothing', async () => {
    const { container } = render(
      <StreamingMarkdown content={'intro\n```ts\nconst a = 1;\nlet b'} />,
    );
    // Wait until the markdown renderer has ACTUALLY rendered (the closed
    // prose is a <p>) — its code components mount in the same commit — then
    // flush the async highlight pipeline. Asserting earlier races the lazy
    // MarkdownRenderer chunk and passes vacuously.
    await waitFor(() =>
      expect(container.querySelector('p')?.textContent).toBe('intro'),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // No highlighted HTML anywhere in the streamed row…
    expect(container.querySelector('[data-testid="hl"], .shiki')).toBeNull();
    // …and the open block settled as a plain <pre> with the raw code.
    const pres = Array.from(container.querySelectorAll('pre')).filter((el) =>
      el.textContent?.includes('let b'),
    );
    expect(pres.length).toBe(1);
    expect(pres[0].hasAttribute('data-testid')).toBe(false);
    expect(pres[0].textContent).toContain('const a = 1;');
    // The decisive assertion: the highlighter was never asked to tokenize a
    // partial block, so nothing partial can be cache-written.
    expect(highlightCode).not.toHaveBeenCalled();
  });

  test('a closed earlier block still highlights while the tail is open', async () => {
    render(
      <StreamingMarkdown
        content={'```js\nlet closed = 1;\n```\ntail\n```ts\nopen'}
      />,
    );
    await waitFor(() => expect(screen.getAllByTestId('hl').length).toBe(1));
    expect(highlightCode).toHaveBeenCalledTimes(1);
    expect(highlightCode).toHaveBeenCalledWith('let closed = 1;', 'js');
  });
});

describe('streaming: closed fence highlights (station#3354)', () => {
  test('a closed block goes through the highlighter and renders its HTML', async () => {
    render(<StreamingMarkdown content={'```ts\nconst done = true;\n```'} />);
    const hl = await waitFor(() => screen.getByTestId('hl'));
    expect(highlightCode).toHaveBeenCalledWith('const done = true;', 'ts');
    expect(hl.getAttribute('data-lang')).toBe('ts');
  });
});

describe('persisted: settled messages keep highlighting (station#3354 defect 3)', () => {
  test('a persisted text part renders highlighted code', async () => {
    render(
      <MessageContent
        contentParts={[
          { type: 'text', content: '```ts\nconst kept = 1;\n```' },
        ]}
        textContent=""
        chatFontSize={14}
        showReasoning={false}
        showToolDetails={false}
        isStreamingMessage={false}
      />,
    );
    const hl = await waitFor(() => screen.getByTestId('hl'));
    expect(highlightCode).toHaveBeenCalledWith('const kept = 1;', 'ts');
    expect(hl.textContent).toContain('const kept = 1;');
  });
});

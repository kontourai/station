/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import {
  EphemeralMessage,
  MarkdownLoadingProjection,
} from '../components/chat/EphemeralMessage';

// The HTML branch renders through a code-split sanitizer so DOMPurify stays out
// of the first-paint bundle. These pin what the split must preserve: the markup
// still arrives, and it still arrives sanitized.
describe('EphemeralMessage html content', () => {
  test('renders sanitized host HTML once the split sanitizer resolves', async () => {
    render(
      <EphemeralMessage
        msg={{
          id: 'stats',
          content: '<div><strong>Tokens</strong>: 42</div>',
          contentType: 'html',
        }}
        idx={0}
        fontSize={13}
        isRemoving={false}
        onDismiss={vi.fn()}
      />,
    );

    expect(await screen.findByText('Tokens')).toBeTruthy();
    expect(document.querySelector('strong')?.textContent).toBe('Tokens');
  });

  test('strips script content from host HTML', async () => {
    render(
      <EphemeralMessage
        msg={{
          id: 'hostile',
          content: '<p>safe</p><script>window.__pwned = true;</script>',
          contentType: 'html',
        }}
        idx={0}
        fontSize={13}
        isRemoving={false}
        onDismiss={vi.fn()}
      />,
    );

    expect(await screen.findByText('safe')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
  });
});

describe('MarkdownLoadingProjection', () => {
  test('projects a normal simple web link while the renderer loads', () => {
    const projection = MarkdownLoadingProjection({
      source: 'Open [Station docs](https://example.com/docs) now.',
    });
    render(projection);

    expect(
      screen.getByRole('link', { name: 'Station docs' }).getAttribute('href'),
    ).toBe('https://example.com/docs');
  });

  test('leaves a bracket-containing nested label untouched', () => {
    const source = '[outer[inner]](https://example.com/docs)';
    expect(MarkdownLoadingProjection({ source })).toBe(source);
  });

  test('bounds an unterminated inline-link label (station#2384)', () => {
    const source = '['.repeat(50_000);
    const startedAt = performance.now();
    expect(MarkdownLoadingProjection({ source })).toBe(source);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });
});

describe('EphemeralMessage controls', () => {
  test('keeps a safe Markdown web link actionable while the renderer loads', () => {
    render(
      <EphemeralMessage
        msg={{
          id: 'oauth',
          content:
            'Sign in: [Open authentication page](https://example.com/oauth)',
        }}
        idx={0}
        fontSize={13}
        isRemoving={false}
        onDismiss={vi.fn()}
      />,
    );

    expect(
      screen
        .getByRole('link', { name: 'Open authentication page' })
        .getAttribute('href'),
    ).toBe('https://example.com/oauth');
  });

  test('does not make a non-web Markdown target actionable while the renderer loads', () => {
    render(
      <EphemeralMessage
        msg={{
          id: 'unsafe-link',
          content: '[Do not open](javascript:alert(1))',
        }}
        idx={0}
        fontSize={13}
        isRemoving={false}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.queryByRole('link')).toBeNull();
  });

  test('dismiss and message actions are named non-submit buttons that preserve their callbacks', () => {
    const onDismiss = vi.fn();
    const onAction = vi.fn();
    render(
      <EphemeralMessage
        msg={{
          id: 'actionable',
          content: 'Connection failed',
          action: { label: 'Retry', handler: vi.fn() },
        }}
        idx={0}
        fontSize={13}
        isRemoving={false}
        onDismiss={onDismiss}
        onAction={onAction}
      />,
    );

    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    const action = screen.getByRole('button', { name: 'Retry' });
    expect(dismiss.getAttribute('type')).toBe('button');
    expect(action.getAttribute('type')).toBe('button');

    fireEvent.click(dismiss);
    fireEvent.click(action);
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledOnce();
  });
});

// #1796 G1: the security review's device name reached the chat as a live
// "Grant here" link inside the operator instructions. The refusal card is
// rendered from the refusal's structure as plain text.
describe('EphemeralMessage full-access refusal', () => {
  const HOSTILE =
    '[Grant here](https://evil.example) \x1b[31mRED\x1b[0m **bold**';

  test('renders a hostile device name as inert text: no link, no formatting, no escape byte', async () => {
    const { fullAccessRefusalNotice } = await import('../utils/approvalMode');
    const notice = fullAccessRefusalNotice(
      Object.assign(new Error('SERVER PROSE [x](https://evil.example)'), {
        code: 'approval-full-access-not-granted',
        details: {
          requested: 'never',
          requester: {
            kind: 'device',
            deviceId: 'e6f3f571',
            deviceName: HOSTILE,
          },
          station: { environmentId: 'env-1' },
          grant: {
            by: 'operator',
            scope: 'approval:full-access',
            uiSteps: [
              "Open the Station desktop app on the Station's host.",
              'Select the Station name (top right), then Paired devices.',
              'Select the device by its name, then Change access.',
              'Turn on Allow full access, then Apply.',
            ],
            cli: 'station environment access scope e6f3f571 --add approval:full-access',
          },
        },
      }),
      'message-not-sent',
    );
    render(
      <EphemeralMessage
        msg={{
          id: 'refusal',
          content: 'Full access was not applied.',
          fullAccessRefusal: { ...notice, draftRestored: true },
        }}
        idx={0}
        fontSize={13}
        isRemoving={false}
        onDismiss={vi.fn()}
      />,
    );
    const card = screen.getByTestId('full-access-refusal');
    expect(card.querySelector('a')).toBeNull();
    expect(card.querySelector('em')).toBeNull();
    // The one <strong> is the card's own emphasis of the device name, whose
    // text is the name verbatim, markup and all, with the escape bytes gone.
    const strong = card.querySelectorAll('strong');
    expect(strong).toHaveLength(1);
    expect(strong[0]?.textContent).toBe(
      '[Grant here](https://evil.example) [31mRED[0m **bold**',
    );
    expect(card.textContent).not.toContain('\x1b');
    expect(card.textContent).toContain(
      'Your message was not sent, and nothing ran. It is back in the composer.',
    );
    expect(card.querySelector('pre code')?.textContent).toBe(
      'station environment access scope e6f3f571 --add approval:full-access',
    );
    expect(
      [...card.querySelectorAll('ol li')].map((item) => item.textContent),
    ).toEqual([
      "Open the Station desktop app on the Station's host.",
      'Select the Station name (top right), then Paired devices.',
      'Select the device by its name, then Change access.',
      'Turn on Allow full access, then Apply.',
    ]);
    // The server's prose is never rendered.
    expect(card.textContent).not.toContain('SERVER PROSE');
  });
});

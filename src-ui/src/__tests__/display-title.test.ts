import { describe, expect, it } from 'vitest';
import { displayTitleFromPrompt } from '../utils/display-title';

/**
 * D4 (design round 2026-10): the dock header titled a chat
 * "[Timezone: America/Denver] SLOW: review the server module…" — the
 * engine's ambient preamble, which every other surface strips because the
 * server's `displayTitle` does. The client's first-message title strips the
 * same prefix, so a title can never start with the preamble.
 */
describe('displayTitleFromPrompt', () => {
  it('strips the ambient timezone preamble the way the server does', () => {
    expect(
      displayTitleFromPrompt(
        '[Timezone: America/Denver] SLOW: review the server module',
      ),
    ).toBe('SLOW: review the server module');
    expect(displayTitleFromPrompt('  [timezone: UTC]\n\nHello  there ')).toBe(
      'Hello there',
    );
  });

  it('leaves an ordinary prompt alone, collapsed to one line and bounded', () => {
    expect(displayTitleFromPrompt('Plan the\nrelease')).toBe(
      'Plan the release',
    );
    expect(displayTitleFromPrompt('x'.repeat(140))).toHaveLength(100);
    expect(displayTitleFromPrompt('[Timezone: UTC]')).toBe('');
  });
});

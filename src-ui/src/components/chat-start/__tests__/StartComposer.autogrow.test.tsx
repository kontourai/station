// @vitest-environment jsdom
/**
 * Home's compact text box grows with what it holds, up to five lines, then
 * scrolls (round-3 follow-up 5). jsdom has no layout, so the content height
 * is the textarea's `scrollHeight`, stubbed per case, and the line height
 * comes from inline style the way a stylesheet would supply it.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { StartComposer } from '../StartComposer';

let contentHeight = 0;
const scrollHeight = vi
  .spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get')
  .mockImplementation(() => contentHeight);

afterEach(() => {
  cleanup();
  contentHeight = 0;
});

function renderComposer(prompt: string, compact = true) {
  const props = {
    onPromptChange: () => undefined,
    compact,
    agent: { status: 'ready' as const, needsSetup: false },
    onOpenAgents: () => undefined,
    project: { status: 'ready' as const, label: 'No project', isGlobal: true },
    onOpenProject: () => undefined,
    canStart: true,
    pending: false,
    onStart: () => undefined,
  };
  const view = render(<StartComposer {...props} prompt={prompt} />);
  const field = () =>
    screen.getByRole('textbox', {
      name: 'What would you like done?',
    }) as HTMLTextAreaElement;
  // 20px lines, 8px padding top and bottom, 1px borders.
  Object.assign(field().style, {
    lineHeight: '20px',
    paddingTop: '8px',
    paddingBottom: '8px',
    borderTopWidth: '1px',
    borderBottomWidth: '1px',
    borderStyle: 'solid',
  });
  return {
    field,
    rerender: (next: string, nextCompact = compact) =>
      view.rerender(
        <StartComposer {...props} compact={nextCompact} prompt={next} />,
      ),
  };
}

describe('compact start composer auto-grow', () => {
  test('fits two lines of text, then caps at five lines and scrolls', () => {
    const ui = renderComposer('');
    contentHeight = 56; // two lines + padding
    ui.rerender('Line one\nline two');
    expect(ui.field().style.height).toBe('58px');
    expect(ui.field().style.overflowY).toBe('hidden');

    contentHeight = 400; // far more than five lines
    ui.rerender('a long restored draft\n'.repeat(20));
    // 5 × 20 + 16 padding + 2 border
    expect(ui.field().style.height).toBe('118px');
    expect(ui.field().style.overflowY).toBe('auto');

    contentHeight = 36; // cleared back to one line
    ui.rerender('');
    expect(ui.field().style.height).toBe('38px');
    expect(scrollHeight).toHaveBeenCalled();
  });

  test('turning full-size (the last work item left Home) drops the fitted size', () => {
    const ui = renderComposer('');
    contentHeight = 56;
    ui.rerender('Line one\nline two');
    expect(ui.field().style.height).toBe('58px');
    expect(ui.field().style.overflowY).toBe('hidden');

    contentHeight = 400;
    ui.rerender('long\n'.repeat(6), false);
    expect(ui.field().style.height).toBe('');
    expect(ui.field().style.overflowY).toBe('');
  });

  test('the full-size composer keeps its own height', () => {
    contentHeight = 400;
    const ui = renderComposer('long\n'.repeat(20), false);
    expect(ui.field().style.height).toBe('');
  });
});

/**
 * @vitest-environment jsdom
 *
 * station#1146 — what the dock's directory row actually RENDERS, per case.
 *
 * The view-model test next door pins the resolution; this pins the pixels it
 * produces, because the defect was a rendered string ("~ (defaults to home)")
 * and not a value. `ChatDockProjectContext` renders the fallback copy purely
 * from the absence of a directory, so a resolution regression is only visible
 * here as the wrong sentence.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ChatDockProjectContext } from '../components/chat-dock/ChatDockProjectContext';

afterEach(cleanup);

function renderRow(workingDirectory: string | null) {
  render(
    <ChatDockProjectContext
      projectSlug="default"
      projectName="Default"
      workingDirectory={workingDirectory}
      codingLayoutSlug={null}
      projects={[]}
      onSelectProject={() => {}}
      onOpenLayout={() => {}}
      onSwitchProject={() => {}}
    />,
  );
  return document.querySelector('.chat-dock__project-context') as HTMLElement;
}

describe('ChatDockProjectContext directory row (station#1146)', () => {
  test("names the session's directory instead of claiming home", () => {
    const row = renderRow('/tmp/s1146-elsewhere');

    expect(row.textContent).toContain('s1146-elsewhere');
    expect(screen.queryByText('~ (defaults to home)')).toBe(null);
  });

  test('still says "~ (defaults to home)" when there is no directory to name', () => {
    renderRow(null);

    expect(screen.getByText('~ (defaults to home)')).toBeDefined();
  });

  test('renders an absolute session path with its parent and leaf split intact', () => {
    // The parent span is `direction: rtl` so long paths truncate from the
    // START (#304); the split must survive an absolute path, not just the
    // tilde form a project's `workingDirectory` is stored in.
    const row = renderRow('/Users/someone/dev/worktrees/wt-9');

    expect(
      row.querySelector('.chat-dock__project-dir-parent-text')?.textContent,
    ).toBe('/Users/someone/dev/worktrees/');
    expect(row.querySelector('.chat-dock__project-dir-leaf')?.textContent).toBe(
      'wt-9',
    );
    expect(row.querySelector('.chat-dock__project-dir--fallback')).toBe(null);
  });
});

/**
 * @vitest-environment jsdom
 *
 * archive#1146 — what the dock's project row actually says about the session's
 * DIRECTORY, per case. The view-model test next door pins the resolution; this
 * pins the rendering it produces, because the defect was a rendered string (the
 * no-directory fallback) and not a value.
 *
 * #1536 F changed the channel, not the contract: the directory is the project
 * badge's tooltip rather than a start-truncated visible segment, because on a
 * 110-character worktree path that segment left the conversation title beside it
 * about one character wide. A resolution regression is still only visible here,
 * as the wrong sentence — now in a `title` instead of in text.
 *
 * #765 F8: the no-directory case is plain copy about a home folder, never the
 * old machine literal "~ (defaults to home)".
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
      projects={[]}
      onSelectProject={() => {}}
      onSwitchProject={() => {}}
    />,
  );
  return {
    row: document.querySelector('.chat-dock__project-context') as HTMLElement,
    badge: screen.getByRole('button', { name: 'Default' }),
  };
}

describe('ChatDockProjectContext directory (station#1146)', () => {
  test("names the session's directory instead of claiming home", () => {
    const { badge } = renderRow('/tmp/s1146-elsewhere');

    expect(badge.getAttribute('title')).toBe('Default — /tmp/s1146-elsewhere');
    expect(badge.getAttribute('title')).not.toContain('home folder');
  });

  test('says so plainly when there is no directory to name', () => {
    const { badge } = renderRow(null);

    expect(badge.getAttribute('title')).toBe(
      '~ (no project folder set — chats start in your home folder)',
    );
    expect(badge.getAttribute('title')).not.toContain('defaults to home');
  });

  test('carries an absolute session path whole, with nothing truncated away', () => {
    // The visible segment used to be `direction: rtl` so a long path truncated
    // from the START (#304), which is also how the bidi reordering defect got
    // in. A tooltip has no such geometry: the path arrives intact.
    const { row, badge } = renderRow('/Users/someone/dev/worktrees/wt-9');

    expect(badge.getAttribute('title')).toBe(
      'Default — /Users/someone/dev/worktrees/wt-9',
    );
    // And it is not ALSO printed into the row, which is the width this change
    // was reclaiming.
    expect(row.textContent).toBe('Default');
  });
});

/**
 * @vitest-environment jsdom
 *
 * archive#1146 — what the dock's directory row actually RENDERS, per case.
 *
 * The view-model test next door pins the resolution; this pins the pixels it
 * produces, because the defect was a rendered string (the no-directory
 * fallback label) and not a value. `ChatDockProjectContext` renders the
 * fallback copy purely from the absence of a directory, so a resolution
 * regression is only visible here as the wrong sentence.
 *
 * #765 F8: the fallback copy is the plain "Home folder" label (shared
 * `HomeFolderLabel`), never the old machine literal "~ (defaults to home)".
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ChatDockProjectContext } from '../components/chat-dock/ChatDockProjectContext';
import { HOME_FOLDER_LABEL } from '../components/HomeFolderLabel';

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
    expect(screen.queryByText(HOME_FOLDER_LABEL)).toBe(null);
  });

  test('says "Home folder" (plain copy, tilde kept as tooltip) when there is no directory to name', () => {
    renderRow(null);

    const fallback = screen.getByText(HOME_FOLDER_LABEL);
    expect(fallback).toBeDefined();
    // The old label's machine framing is gone from the visible text but the
    // concrete path answer survives as the hover/assistive detail.
    expect(fallback.getAttribute('title')).toContain('~');
    expect(fallback.textContent).not.toContain('defaults to home');
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

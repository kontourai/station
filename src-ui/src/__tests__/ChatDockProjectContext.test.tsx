/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ChatDockProjectContext } from '../components/chat-dock/ChatDockProjectContext';

const PROJECTS = [
  {
    id: 'p-alpha',
    slug: 'alpha',
    name: 'Alpha',
    hasWorkingDirectory: false,
    layoutCount: 0,
    hasKnowledge: false,
  },
  {
    id: 'p-beta',
    slug: 'beta',
    name: 'Beta',
    hasWorkingDirectory: false,
    layoutCount: 0,
    hasKnowledge: false,
  },
];

/**
 * This row lives inside the dock header, whose whole bar is a click-to-toggle
 * surface (`ChatDockHeader.tsx`'s `handleHeaderClick`). Every activation here
 * must stop propagation or opening the switcher also collapses the dock — the
 * exact bug that forced the badge's own click handler to guard on both the
 * mouse AND (now, as a real `<button>`) native keyboard paths.
 *
 * archive#793: the badge no longer navigates directly on click — it
 * always opens `ChatDockProjectSwitcherSheet`, whose own rows carry "Open
 * project" and (archive#4524) "Switch to <project>". These specs pin the
 * badge's button semantics and switcher-open wiring;
 * ChatDockProjectSwitcherSheet.test.tsx pins the sheet's own row behavior.
 */
describe('ChatDockProjectContext', () => {
  function renderRow(overrides: {
    codingLayoutSlug?: string | null;
    onSelectProject?: ReturnType<typeof vi.fn<(projectSlug: string) => void>>;
    onOpenLayout?: ReturnType<
      typeof vi.fn<(projectSlug: string, layoutSlug: string) => void>
    >;
    onSwitchProject?: ReturnType<
      typeof vi.fn<(projectSlug: string, projectName: string) => void>
    >;
    onHeaderToggle?: ReturnType<typeof vi.fn<() => void>>;
  }) {
    const onSelectProject =
      overrides.onSelectProject ?? vi.fn<(projectSlug: string) => void>();
    const onOpenLayout =
      overrides.onOpenLayout ??
      vi.fn<(projectSlug: string, layoutSlug: string) => void>();
    const onSwitchProject =
      overrides.onSwitchProject ??
      vi.fn<(projectSlug: string, projectName: string) => void>();
    const onHeaderToggle = overrides.onHeaderToggle ?? vi.fn<() => void>();
    render(
      // The wrapper stands in for the dock header's toggle surface: any
      // event that escapes the row lands here, like a real bubbled toggle.
      // biome-ignore lint/a11y/noStaticElementInteractions: test stand-in for the dock header's toggle surface.
      <div onClick={onHeaderToggle} onKeyDown={onHeaderToggle}>
        <ChatDockProjectContext
          projectSlug="alpha"
          projectName="Alpha"
          workingDirectory="/repos/alpha"
          codingLayoutSlug={overrides.codingLayoutSlug ?? null}
          projects={PROJECTS}
          onSelectProject={onSelectProject}
          onOpenLayout={onOpenLayout}
          onSwitchProject={onSwitchProject}
        />
      </div>,
    );
    return {
      onSelectProject,
      onOpenLayout,
      onSwitchProject,
      onHeaderToggle,
    };
  }

  test('the badge is a real button with dialog popup semantics', () => {
    renderRow({});

    const badge = screen.getByRole('button', { name: 'Alpha' });
    expect(badge.getAttribute('type')).toBe('button');
    expect(badge.getAttribute('aria-haspopup')).toBe('dialog');
    expect(badge.getAttribute('aria-expanded')).toBe('false');
  });

  test('a mouse click on the badge opens the switcher without toggling the dock', async () => {
    const { onHeaderToggle } = renderRow({});

    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));

    expect(
      screen
        .getByRole('button', { name: 'Alpha' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
    await screen.findByRole('dialog', { name: 'Switch project' });
    // The dock header's toggle surface must NOT see the activation.
    expect(onHeaderToggle).not.toHaveBeenCalled();
  });

  test('opening the switcher and choosing "Open project" delegates to onSelectProject', async () => {
    const { onSelectProject } = renderRow({});

    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    await screen.findByRole('dialog', { name: 'Switch project' });

    fireEvent.click(screen.getByRole('button', { name: 'Open Alpha' }));
    expect(onSelectProject).toHaveBeenCalledWith('alpha');
  });

  test('choosing "Switch to <project>" delegates to onSwitchProject (station#4524)', async () => {
    const { onSwitchProject } = renderRow({});

    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    await screen.findByRole('dialog', { name: 'Switch project' });

    fireEvent.click(screen.getByRole('button', { name: 'Switch to Beta' }));
    expect(onSwitchProject).toHaveBeenCalledWith('beta', 'Beta');
  });

  test('the directory path links to the coding layout only when one exists', () => {
    const withLayout = renderRow({ codingLayoutSlug: 'code' });
    const dir = screen.getByText('alpha', {
      selector: '.chat-dock__project-dir *, .chat-dock__project-dir',
      exact: false,
    });
    const dirEl = dir.closest('.chat-dock__project-dir') as HTMLElement;
    expect(dirEl.getAttribute('role')).toBe('link');

    fireEvent.keyDown(dirEl, { key: 'Enter' });
    expect(withLayout.onOpenLayout).toHaveBeenCalledWith('alpha', 'code');
    expect(withLayout.onHeaderToggle).not.toHaveBeenCalled();
  });
});

// archive#1803: the chat dock header hid this entire row —
// including the switch-project picker — whenever a chat had no bound
// project, which is exactly backwards: a chat with no workspace is the one
// most likely to need one assigned. `ChatDock.tsx` (the caller) no longer
// omits the row for that case; this pins the component's own contract for
// rendering it with a null projectSlug.
describe('ChatDockProjectContext — no bound project (station#1803 part 3)', () => {
  test('renders "No project" as the badge and keeps it switchable when projectSlug/projectName are both null', async () => {
    const onSelectProject = vi.fn();
    render(
      <ChatDockProjectContext
        projectSlug={null}
        projectName={null}
        workingDirectory={null}
        codingLayoutSlug={null}
        projects={PROJECTS}
        onSelectProject={onSelectProject}
        onOpenLayout={vi.fn()}
        onSwitchProject={vi.fn()}
      />,
    );

    const badge = screen.getByRole('button', { name: 'No project' });
    expect(badge.getAttribute('aria-haspopup')).toBe('dialog');

    fireEvent.click(badge);
    await screen.findByRole('dialog', { name: 'Switch project' });
    fireEvent.click(screen.getByRole('button', { name: 'Open Alpha' }));
    expect(onSelectProject).toHaveBeenCalledWith('alpha');
  });

  test('no project row is ever flagged "Current" when nothing is bound', async () => {
    render(
      <ChatDockProjectContext
        projectSlug={null}
        projectName={null}
        workingDirectory={null}
        codingLayoutSlug={null}
        projects={PROJECTS}
        onSelectProject={vi.fn()}
        onOpenLayout={vi.fn()}
        onSwitchProject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'No project' }));
    await screen.findByRole('dialog', { name: 'Switch project' });
    expect(screen.queryByText('Current')).toBeNull();
  });
});

describe('ChatDockProjectContext — clearable badge (chat-dock-maximize-readiness)', () => {
  test('renders the project name badge without a clear control when no scope filter is active', () => {
    render(
      <ChatDockProjectContext
        projectSlug="ops"
        projectName="Operations"
        workingDirectory={null}
        codingLayoutSlug={null}
        projects={PROJECTS}
        onSelectProject={vi.fn()}
        onOpenLayout={vi.fn()}
        onSwitchProject={vi.fn()}
      />,
    );

    expect(screen.getByText('Operations')).toBeTruthy();
    expect(screen.queryByLabelText('Clear project chat scope')).toBeNull();
  });

  test('renders a single clearable badge when a project chat scope is active', () => {
    const onClear = vi.fn();
    render(
      <ChatDockProjectContext
        projectSlug="ops"
        projectName="Operations"
        workingDirectory={null}
        codingLayoutSlug={null}
        projects={PROJECTS}
        onSelectProject={vi.fn()}
        onOpenLayout={vi.fn()}
        onSwitchProject={vi.fn()}
        onClearProjectScope={onClear}
      />,
    );

    // Exactly one project name surface, plus one clear affordance.
    expect(screen.getByText('Operations')).toBeTruthy();
    const clear = screen.getByLabelText('Clear project chat scope');
    fireEvent.click(clear);
    expect(onClear).toHaveBeenCalledOnce();
  });
});

// archive#4525 (owner design ruling): the badge always names
// the BOUND project (unchanged) — this is the muted lead-in the facts row
// shows when the active session's own project diverges from it, so the
// header never implies the visible transcript belongs to the badge's
// project. own ruling (session facts never gate on the badge) is
// pinned by the `workingDirectory`/`gitStatus`/`codingLayoutSlug` props
// always being present here regardless of `sessionProjectMismatchLabel`.
describe('ChatDockProjectContext — session/badge mismatch label (station#4525 review MED-1)', () => {
  test('renders the muted lead-in before the directory when a mismatch label is provided', () => {
    render(
      <ChatDockProjectContext
        projectSlug="alpha"
        projectName="Alpha"
        workingDirectory="/repos/beta-checkout"
        codingLayoutSlug={null}
        sessionProjectMismatchLabel="Beta"
        projects={PROJECTS}
        onSelectProject={vi.fn()}
        onOpenLayout={vi.fn()}
        onSwitchProject={vi.fn()}
      />,
    );

    // The badge still names the BOUND project ("Alpha"), not the session's.
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeTruthy();
    const label = screen.getByText('Beta ·');
    expect(label.className).toContain('chat-dock__project-session-name');
    // the session's own facts (here, its directory) still render —
    // never suppressed by the mismatch.
    expect(screen.getByText('beta-checkout')).toBeTruthy();
  });

  test('renders nothing extra when there is no mismatch (sessionProjectMismatchLabel absent or null)', () => {
    render(
      <ChatDockProjectContext
        projectSlug="alpha"
        projectName="Alpha"
        workingDirectory="/repos/alpha"
        codingLayoutSlug={null}
        sessionProjectMismatchLabel={null}
        projects={PROJECTS}
        onSelectProject={vi.fn()}
        onOpenLayout={vi.fn()}
        onSwitchProject={vi.fn()}
      />,
    );

    expect(
      document.querySelector('.chat-dock__project-session-name'),
    ).toBeNull();
  });
});

/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { ChatDockProjectSwitcherSheet } from '../components/chat-dock/ChatDockProjectSwitcherSheet';

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

function renderSheet(
  overrides: {
    boundProjectSlug?: string;
    projects?: typeof PROJECTS;
    onOpenProject?: ReturnType<typeof vi.fn<(projectSlug: string) => void>>;
    onSwitchProject?: ReturnType<
      typeof vi.fn<(projectSlug: string, projectName: string) => void>
    >;
    onClose?: ReturnType<typeof vi.fn<() => void>>;
  } = {},
) {
  const anchorRef = createRef<HTMLElement>();
  const onOpenProject =
    overrides.onOpenProject ?? vi.fn<(projectSlug: string) => void>();
  const onSwitchProject =
    overrides.onSwitchProject ??
    vi.fn<(projectSlug: string, projectName: string) => void>();
  const onClose = overrides.onClose ?? vi.fn<() => void>();
  render(
    <ChatDockProjectSwitcherSheet
      anchorRef={anchorRef}
      boundProjectSlug={overrides.boundProjectSlug ?? 'alpha'}
      projects={overrides.projects ?? PROJECTS}
      onOpenProject={onOpenProject}
      onSwitchProject={onSwitchProject}
      onClose={onClose}
    />,
  );
  return { onOpenProject, onSwitchProject, onClose };
}

/** Locate a row by its "Open <name>" action rather than the visible name
 * text — the bound row's name span also contains the decorative "Current"
 * label as a sibling text node, which would otherwise change its merged
 * textContent and break an exact-text lookup. */
function row(name: string) {
  return screen
    .getByRole('button', { name: `Open ${name}` })
    .closest('li') as HTMLElement;
}

describe('ChatDockProjectSwitcherSheet', () => {
  test('renders as a dialog labeled "Switch project"', () => {
    renderSheet();
    expect(screen.getByRole('dialog', { name: 'Switch project' })).toBeTruthy();
  });

  // #3319 revision of D5's presentation, itself revised by #4524: the ROW is
  // Switch, Open is a right-aligned icon. D5's substance is unchanged — both
  // actions on every row, never a third, bound row never disabled.
  test('every project row offers exactly two actions — the Switch row and the Open icon — never a third (AC3)', () => {
    renderSheet();

    for (const name of ['Alpha', 'Beta']) {
      const buttons = within(row(name)).getAllByRole('button');
      expect(buttons).toHaveLength(2);
      expect(buttons[0].getAttribute('aria-label')).toBe(`Switch to ${name}`);
      expect(buttons[0].classList).toContain(
        'chat-dock__project-switcher-switch',
      );
      expect(buttons[1].getAttribute('aria-label')).toBe(`Open ${name}`);
      // Icon-only: the Open button carries no visible text label.
      expect(buttons[1].textContent).toBe('');
      expect(buttons[1].querySelector('svg')).toBeTruthy();
    }
  });

  test('no row or button copy implies moving or transferring an existing chat (AC3/AC4)', () => {
    renderSheet();
    const body = screen.getByRole('dialog', { name: 'Switch project' });
    expect(body.textContent).not.toMatch(/move|transfer/i);
  });

  test('the bound project is exposed as current, visually flagged, and keeps both actions enabled (D5)', () => {
    renderSheet({ boundProjectSlug: 'alpha' });

    const current = screen.getByText('Current');
    expect(row('Alpha').getAttribute('aria-current')).toBe('true');
    expect(row('Beta').hasAttribute('aria-current')).toBe(false);
    expect(current.closest('li')).toBe(row('Alpha'));

    const alphaButtons = within(row('Alpha')).getAllByRole('button');
    for (const button of alphaButtons) {
      expect(button.hasAttribute('disabled')).toBe(false);
    }
    // The non-bound row never renders the decorative label at all.
    expect(within(row('Beta')).queryByText('Current')).toBeNull();
  });

  test('"Open project" closes the sheet and delegates to onOpenProject with the row\'s slug, never the row Switch action (archive#3319)', () => {
    const { onOpenProject, onSwitchProject, onClose } = renderSheet();

    fireEvent.click(
      within(row('Beta')).getByRole('button', { name: 'Open Beta' }),
    );

    expect(onOpenProject).toHaveBeenCalledWith('beta');
    expect(onSwitchProject).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('"Switch to <name>" delegates to onSwitchProject, even for the currently bound project — never onOpenProject (station#4524)', () => {
    const { onOpenProject, onSwitchProject, onClose } = renderSheet({
      boundProjectSlug: 'alpha',
    });

    fireEvent.click(
      within(row('Alpha')).getByRole('button', { name: 'Switch to Alpha' }),
    );

    expect(onSwitchProject).toHaveBeenCalledWith('alpha', 'Alpha');
    expect(onOpenProject).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('the close button dismisses the sheet without invoking either project action', () => {
    const { onOpenProject, onSwitchProject, onClose } = renderSheet();

    fireEvent.click(
      screen.getByRole('button', { name: 'Close project switcher' }),
    );

    expect(onClose).toHaveBeenCalledOnce();
    expect(onOpenProject).not.toHaveBeenCalled();
    expect(onSwitchProject).not.toHaveBeenCalled();
  });

  test('renders an empty state when there are no projects to switch to', () => {
    render(
      <ChatDockProjectSwitcherSheet
        anchorRef={createRef<HTMLElement>()}
        boundProjectSlug="alpha"
        projects={[]}
        onOpenProject={vi.fn()}
        onSwitchProject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // The label collapses to the Empty family's shared phrasing (the sheet's
    // own header already names the noun); the description carries the fact.
    // Asserting both keeps the copy pinned rather than only its existence.
    expect(screen.getByText('Nothing here yet')).toBeTruthy();
    expect(
      screen.getByText('This Station has no projects to switch to.'),
    ).toBeTruthy();
  });
});

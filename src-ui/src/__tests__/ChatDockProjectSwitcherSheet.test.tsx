/**
 * @vitest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { ChatDockProjectSwitcherSheet } from '../components/chat-dock/ChatDockProjectSwitcherSheet';

const SWITCHER_CSS = readFileSync(
  resolve(import.meta.dirname, '..', 'index.css'),
  'utf8',
);

function cssRule(selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = SWITCHER_CSS.match(
    new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`),
  );
  expect(match, `${selector} rule should exist in index.css`).toBeTruthy();
  return match?.[1] ?? '';
}

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

  test('the Open icon does not trigger the row Switch action (#3319 acceptance)', () => {
    const { onOpenProject, onSwitchProject } = renderSheet();

    fireEvent.click(
      within(row('Beta')).getByRole('button', { name: 'Open Beta' }),
    );

    expect(onOpenProject).toHaveBeenCalledWith('beta');
    expect(onSwitchProject).not.toHaveBeenCalled();
  });

  test('long project names truncate instead of displacing the Open icon', () => {
    const projects = [
      {
        ...PROJECTS[0],
        slug: 'knowledge-docs',
        name: 'Example · Knowledge Docs',
      },
      { ...PROJECTS[1], slug: 'xyz', name: 'XYZ' },
    ];
    renderSheet({ boundProjectSlug: 'knowledge-docs', projects });

    const longNameRow = row('Example · Knowledge Docs');
    const shortNameRow = row('XYZ');
    for (const projectRow of [longNameRow, shortNameRow]) {
      const name = projectRow.querySelector(
        '.chat-dock__project-switcher-name',
      );
      expect(name).toBeTruthy();
      expect(
        projectRow.querySelector('.chat-dock__project-switcher-actions'),
      ).toBeTruthy();
    }

    // jsdom cannot calculate this layout. Assert the CSS geometry that keeps
    // the flexible name column from displacing the fixed icon column, the
    // name truncation, and the >=44px targets on both actions.
    const rowCss = cssRule('.chat-dock__project-switcher-row');
    expect(rowCss).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/,
    );

    const nameCss = cssRule('.chat-dock__project-switcher-name');
    expect(nameCss).toMatch(/min-width:\s*0/);
    expect(nameCss).toMatch(/overflow:\s*hidden/);
    expect(nameCss).toMatch(/text-overflow:\s*ellipsis/);
    expect(nameCss).toMatch(/white-space:\s*nowrap/);

    const switchCss = cssRule('.chat-dock__project-switcher-switch');
    expect(switchCss).toMatch(/min-height:\s*44px/);
    expect(switchCss).toMatch(/min-width:\s*0/);

    const openCss = cssRule('.chat-dock__project-switcher-open');
    expect(openCss).toMatch(/min-width:\s*44px/);
    expect(openCss).toMatch(/min-height:\s*44px/);
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

  test('"Open project" closes the sheet and delegates to onOpenProject with the row\'s slug', () => {
    const { onOpenProject, onClose } = renderSheet();

    fireEvent.click(
      within(row('Beta')).getByRole('button', { name: 'Open Beta' }),
    );

    expect(onOpenProject).toHaveBeenCalledWith('beta');
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

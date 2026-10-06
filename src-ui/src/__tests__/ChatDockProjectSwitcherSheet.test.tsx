/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { ChatDockProjectSwitcherSheet } from '../components/chat-dock/ChatDockProjectSwitcherSheet';
import type { ProjectMetadata } from '../contexts/ProjectsContext';

// The Project list the sidebar shows, which every surface's accents are
// allocated over (`useProjectAccents`). Defaults to the sheet's own list.
const sidebarProjects = vi.hoisted(() => ({
  list: undefined as ProjectMetadata[] | undefined,
}));
vi.mock('../contexts/ProjectsContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contexts/ProjectsContext')>()),
  useProjects: () => ({
    projects: sidebarProjects.list ?? PROJECTS,
    isLoading: false,
    isConfirmedLoaded: true,
  }),
}));

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
    onNewProject?: ReturnType<typeof vi.fn<() => void>>;
    onClose?: ReturnType<typeof vi.fn<() => void>>;
  } = {},
) {
  const anchorRef = createRef<HTMLElement>();
  const onOpenProject =
    overrides.onOpenProject ?? vi.fn<(projectSlug: string) => void>();
  const onSwitchProject =
    overrides.onSwitchProject ??
    vi.fn<(projectSlug: string, projectName: string) => void>();
  const onNewProject = overrides.onNewProject ?? vi.fn<() => void>();
  const onClose = overrides.onClose ?? vi.fn<() => void>();
  render(
    <ChatDockProjectSwitcherSheet
      anchorRef={anchorRef}
      boundProjectSlug={overrides.boundProjectSlug ?? 'alpha'}
      projects={overrides.projects ?? PROJECTS}
      onOpenProject={onOpenProject}
      onSwitchProject={onSwitchProject}
      onNewProject={onNewProject}
      onClose={onClose}
    />,
  );
  return { onOpenProject, onSwitchProject, onNewProject, onClose };
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
  test("draws a project's icon in place of its colour bar, and the bar for one without", () => {
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    const projects = [
      { ...PROJECTS[0], icon: image },
      { ...PROJECTS[1], icon: '/Users/me/secrets/logo.png' },
    ];
    sidebarProjects.list = projects;
    try {
      renderSheet({ projects });
      const alpha = row('Alpha').querySelector(
        '.chat-dock__project-switcher-icon',
      );
      expect(alpha?.querySelector('img')?.getAttribute('src')).toBe(image);
      // The bar's sizing class stays on the bar: an icon is not a 3px bar.
      expect(alpha?.querySelector('.chat-dock__project-switcher-accent')).toBe(
        null,
      );
      // A refused value is not an icon: Beta keeps its colour bar.
      const beta = row('Beta').querySelector<HTMLElement>(
        '.chat-dock__project-switcher-accent',
      );
      expect(beta?.querySelector('img')).toBeNull();
      expect(beta?.classList.contains('project-icon--bar')).toBe(true);
      expect(beta?.style.backgroundColor).toBe('var(--event-agent-complete)');
    } finally {
      sidebarProjects.list = undefined;
    }
  });

  test("paints a project with the sidebar's colour, whatever list the sheet is handed", () => {
    // The sidebar holds three projects; `beta` is the second in sorted order
    // there. Handed only `beta`, an allocation over the sheet's own list
    // would give it the palette's first colour instead.
    sidebarProjects.list = [
      { ...PROJECTS[0] },
      { ...PROJECTS[1] },
      { ...PROJECTS[1], id: 'p-gamma', slug: 'gamma', name: 'Gamma' },
    ];
    try {
      renderSheet({ projects: [PROJECTS[1]], boundProjectSlug: 'beta' });
      const accent = row('Beta').querySelector<HTMLElement>(
        '.chat-dock__project-switcher-accent',
      );
      expect(accent?.style.backgroundColor).toBe('var(--event-agent-complete)');
    } finally {
      sidebarProjects.list = undefined;
    }
  });

  test('renders as a dialog labeled "Switch project"', () => {
    renderSheet();
    expect(screen.getByRole('dialog', { name: 'Projects' })).toBeTruthy();
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
    const body = screen.getByRole('dialog', { name: 'Projects' });
    expect(body.textContent).not.toMatch(/move|transfer/i);
  });

  test('the bound project is exposed as current, visually flagged, and keeps both actions enabled (D5)', () => {
    renderSheet({ boundProjectSlug: 'alpha' });

    const current = screen.getByTitle('Selected project');
    expect(row('Alpha').getAttribute('aria-current')).toBe('true');
    expect(row('Beta').hasAttribute('aria-current')).toBe(false);
    expect(current.closest('li')).toBe(row('Alpha'));

    const alphaButtons = within(row('Alpha')).getAllByRole('button');
    for (const button of alphaButtons) {
      expect(button.hasAttribute('disabled')).toBe(false);
    }
    // The non-bound row never renders the decorative label at all.
    expect(within(row('Beta')).queryByTitle('Selected project')).toBeNull();
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

  test.each([
    { projects: PROJECTS, label: 'New project' },
    { projects: [], label: 'New project' },
  ])(
    'offers project creation with $projects.length projects',
    ({ projects, label }) => {
      const calls: string[] = [];
      const { onOpenProject, onSwitchProject } = renderSheet({
        projects,
        onClose: vi.fn(() => {
          calls.push('close');
        }),
        onNewProject: vi.fn(() => {
          calls.push('create');
        }),
      });
      if (projects.length === 0) {
        expect(screen.getByText('Nothing here yet')).toBeTruthy();
        expect(
          screen.getByText('Use + to create your first project.'),
        ).toBeTruthy();
      }
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(calls).toEqual(['close', 'create']);
      expect(onOpenProject).not.toHaveBeenCalled();
      expect(onSwitchProject).not.toHaveBeenCalled();
    },
  );
});

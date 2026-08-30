/**
 * @vitest-environment jsdom
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const sdkMocks = vi.hoisted(() => ({
  project: undefined as ProjectConfig | undefined,
  isLoading: false,
  isError: false,
  error: undefined as Error | undefined,
  refetch: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  updateFailure: null as Error | null,
  deleteFailure: null as Error | null,
  environments: [] as Array<{
    profile: { id: string; name: string; environmentId?: string };
  }>,
  environmentsError: false,
}));

const navigationMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3141' }),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    navigate: navigationMocks.navigate,
  }),
}));

vi.mock('../hooks/useCloseShortcut', () => ({
  useCloseShortcut: vi.fn(),
}));

vi.mock('../components/ModelSelector', () => ({
  ModelSelector: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
  }) => (
    <input
      aria-label="Default AI Model"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock('../components/PathAutocomplete', () => ({
  PathAutocomplete: ({
    value,
    onChange,
    placeholder,
    className,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    className?: string;
  }) => (
    <input
      aria-label="Working Directory"
      className={className}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock('../views/project-settings/AgentsSection', () => ({
  AgentsSection: () => (
    <section className="project-settings__section">Agents section</section>
  ),
}));

vi.mock('../views/project-settings/LayoutsSection', () => ({
  LayoutsSection: () => <section>Layouts section</section>,
}));

vi.mock('../views/project-settings/KnowledgeSection', () => ({
  KnowledgeSection: () => <section>Knowledge section</section>,
}));

// archive#1502 — stubbed like its siblings: this suite is the SHELL
// port's pin, and the section's own behavior (§3.6's states, §4.1's
// not-backing path) is covered by `project-settings/__tests__/
// ResourcesSection.test.tsx` against its own SDK mock.
vi.mock('../views/project-settings/ResourcesSection', () => ({
  ResourcesSection: () => <section>Resources section</section>,
}));

vi.mock('@kontourai/station-sdk', () => ({
  useSshEnvironmentsQuery: () => ({
    data: sdkMocks.environmentsError ? undefined : sdkMocks.environments,
    isLoading: false,
    isSuccess: !sdkMocks.environmentsError,
    isError: sdkMocks.environmentsError,
  }),
  useProjectQuery: vi.fn(() => ({
    data: sdkMocks.project,
    isLoading: sdkMocks.isLoading,
    isError: sdkMocks.isError,
    error: sdkMocks.error,
    refetch: sdkMocks.refetch,
  })),
  useUpdateProjectMutation: vi.fn(() => ({
    isPending: false,
    mutateAsync: async (payload: Partial<ProjectConfig> & { slug: string }) => {
      sdkMocks.updateProject(payload);
      if (sdkMocks.updateFailure) throw sdkMocks.updateFailure;
      return {
        ...(sdkMocks.project as ProjectConfig),
        ...payload,
        updatedAt: '2026-07-07T23:45:00.000Z',
      };
    },
  })),
  useDeleteProjectMutation: vi.fn(() => ({
    isPending: false,
    mutateAsync: async (slug: string) => {
      sdkMocks.deleteProject(slug);
      if (sdkMocks.deleteFailure) throw sdkMocks.deleteFailure;
    },
  })),
}));

import { ProjectSettingsView } from '../views/ProjectSettingsView';

const projectFixture: ProjectConfig = {
  id: 'project-demo',
  slug: 'demo',
  name: 'Demo Project',
  icon: 'D',
  description: 'Demo project description',
  workingDirectory: '/Users/brian/dev/demo',
  defaultModel: 'openai:gpt-5',
  agents: [agentId('codex')],
  createdAt: '2026-07-07T12:00:00.000Z',
  updatedAt: '2026-07-07T12:00:00.000Z',
};

function renderProjectSettings() {
  return render(<ProjectSettingsView slug="demo" />);
}

function inputValue(input: Element | null) {
  return (input as HTMLInputElement | null)?.value;
}

function expectPageFullRoot(container: HTMLElement) {
  expect(container.firstElementChild?.classList.contains('page')).toBe(true);
  expect(container.firstElementChild?.classList.contains('page--full')).toBe(
    true,
  );
}

describe('ProjectSettingsView (#250 shell port)', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/projects/demo/settings');
    sdkMocks.project = projectFixture;
    sdkMocks.isLoading = false;
    sdkMocks.isError = false;
    sdkMocks.error = undefined;
    sdkMocks.updateProject.mockClear();
    sdkMocks.deleteProject.mockClear();
    sdkMocks.updateFailure = null;
    sdkMocks.deleteFailure = null;
    sdkMocks.refetch.mockClear();
    sdkMocks.environments = [];
    sdkMocks.environmentsError = false;
    navigationMocks.navigate.mockClear();
  });

  test('renders through the canonical page-layout root and keeps project settings reachable', () => {
    const { container } = renderProjectSettings();

    expectPageFullRoot(container);
    expect(container.querySelector('.project-settings')).toBeNull();
    expect(
      screen.getByRole('heading', { name: 'D Demo Project' }),
    ).toBeTruthy();
    expect(inputValue(screen.getByLabelText('Working Directory'))).toBe(
      '/Users/brian/dev/demo',
    );
    expect(
      inputValue(container.querySelector('.project-settings__name-input')),
    ).toBe('Demo Project');
    expect(screen.getByText('Agents section')).toBeTruthy();
    expect(screen.getByText('Layouts section')).toBeTruthy();
    expect(screen.getByText('Knowledge section')).toBeTruthy();
    expect(container.querySelector('#section-workspace')).toBeTruthy();
    expect(container.querySelector('#section-basic-info')).toBeTruthy();
    expect(container.querySelector('#section-model')).toBeTruthy();
    expect(
      inputValue(
        screen.getByLabelText('Execution environment') as HTMLSelectElement,
      ),
    ).toBe('shared');
    expect(container.querySelector('#section-danger')).toBeTruthy();
  });

  test('shows a dangling saved environment as the selected missing option', () => {
    sdkMocks.project = {
      ...projectFixture,
      defaultEnvironment: { kind: 'saved', id: 'deleted-environment' as any },
    };
    renderProjectSettings();

    expect(
      (screen.getByLabelText('Default environment') as HTMLSelectElement).value,
    ).toBe('deleted-environment');
    expect(screen.getByRole('status').textContent).toContain(
      'names a saved environment that no longer exists',
    );
  });

  test('reports unavailable inventory without claiming the saved environment was deleted', () => {
    sdkMocks.project = {
      ...projectFixture,
      defaultEnvironment: { kind: 'saved', id: 'env-unchecked' as any },
    };
    sdkMocks.environmentsError = true;
    renderProjectSettings();

    expect(screen.getByRole('alert').textContent).toContain(
      'Saved environments are unavailable',
    );
    expect(screen.queryByText(/no longer exists/)).toBeNull();
    expect(
      (screen.getByLabelText('Default environment') as HTMLSelectElement).value,
    ).toBe('env-unchecked');
  });

  test('clears a dangling saved default through a real selection change', async () => {
    sdkMocks.project = {
      ...projectFixture,
      defaultEnvironment: { kind: 'saved', id: 'deleted-environment' as any },
    };
    renderProjectSettings();

    fireEvent.change(screen.getByLabelText('Default environment'), {
      target: { value: 'current' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(sdkMocks.updateProject).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'demo',
          defaultEnvironment: { kind: 'current' },
        }),
      ),
    );
  });

  test('keeps the active section tab fully visible in the horizontal mobile rail', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    window.history.replaceState(
      {},
      '',
      '/projects/demo/settings?section=layouts',
    );

    renderProjectSettings();

    expect(
      screen
        .getByRole('link', { name: 'Layouts' })
        .getAttribute('aria-current'),
    ).toBe('location');
    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({
        block: 'nearest',
        inline: 'start',
      }),
    );
  });

  test('renders loading through canonical Skeleton inside the page root', () => {
    sdkMocks.project = undefined;
    sdkMocks.isLoading = true;

    const { container } = renderProjectSettings();

    expectPageFullRoot(container);
    expect(container.querySelector('.project-settings__loading')).toBeNull();
    expect(screen.getByLabelText('Loading project')).toBeTruthy();
    expect(container.querySelectorAll('.skeleton')).toHaveLength(3);
  });

  test('renders ErrorState with retry instead of an infinite skeleton when the project query fails (#762)', () => {
    sdkMocks.project = undefined;
    sdkMocks.isLoading = false;
    sdkMocks.isError = true;
    sdkMocks.error = new Error('Project not found');

    const { container } = renderProjectSettings();

    expectPageFullRoot(container);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Could not load project settings')).toBeTruthy();
    expect(screen.getByText('Project not found')).toBeTruthy();
    expect(screen.queryByLabelText('Loading project')).toBeNull();
    expect(container.querySelectorAll('.skeleton')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(sdkMocks.refetch).toHaveBeenCalledTimes(1);
  });

  test('preserves save payload behavior and clears dirty state on success', async () => {
    const { container } = renderProjectSettings();

    fireEvent.change(
      container.querySelector('.project-settings__name-input') as Element,
      {
        target: { value: 'Demo Project Updated' },
      },
    );
    fireEvent.change(
      container.querySelector(
        '.project-settings__working-dir-input',
      ) as Element,
      {
        target: { value: '~/dev/demo' },
      },
    );
    fireEvent.change(screen.getByLabelText('Execution environment'), {
      target: { value: 'worktree' },
    });

    expect(screen.getByText('unsaved')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(sdkMocks.updateProject).toHaveBeenCalledWith({
        slug: 'demo',
        name: 'Demo Project Updated',
        icon: 'D',
        description: 'Demo project description',
        defaultModel: 'openai:gpt-5',
        defaultWorkspaceIsolation: 'worktree',
        defaultEnvironment: { kind: 'current' },
        workingDirectory: '~/dev/demo',
        agents: ['codex'],
      }),
    );
    expect(screen.queryByText('unsaved')).toBeNull();
  });

  test('surfaces failed saves through the canonical ErrorState alert', async () => {
    sdkMocks.updateFailure = new Error('Name rejected by policy');
    const { container } = renderProjectSettings();

    fireEvent.change(
      container.querySelector('.project-settings__name-input') as Element,
      {
        target: { value: 'Reject Save' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toBeTruthy();
    expect(screen.getByText('Could not save project settings')).toBeTruthy();
    expect(screen.getByText('Name rejected by policy')).toBeTruthy();
    expect(screen.getByText('unsaved')).toBeTruthy();
  });

  test('keeps a failed deletion in context and renders the rejection', async () => {
    sdkMocks.deleteFailure = new Error('Station connection was interrupted');
    renderProjectSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Station connection was interrupted',
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(navigationMocks.navigate).not.toHaveBeenCalled();
  });

  test('explains that deleting a Project retains Tasks and chats without a live workspace', () => {
    renderProjectSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Project' }));

    expect(screen.getByRole('dialog').textContent).toContain(
      'Tasks and chats stay in history',
    );
    expect(screen.getByRole('dialog').textContent).toContain(
      'no longer have a live Project workspace',
    );
  });
});

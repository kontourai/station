/**
 * @vitest-environment jsdom
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const createProjectMock = vi.fn();
const applyProjectLayoutMock = vi.fn();
const validateDirectoryMock = vi.fn();
const setProjectMock = vi.fn();
const onCloseMock = vi.fn();
const reposQueryState = vi.hoisted(() => ({
  data: undefined as
    | { workspace: string; workspaceIsRepo: boolean; repos: unknown[] }
    | undefined,
  isFetching: false,
  isError: false,
  refetch: vi.fn(),
}));
const iconCandidatesState = vi.hoisted(() => ({
  data: [] as Array<{
    relativePath: string;
    dataUrl: string;
    mediaType: string;
    source: 'favicon';
  }>,
  isFetching: false,
  isError: false,
}));
const iconCandidatesQueryMock = vi.hoisted(() => vi.fn());
const availableLayoutsState = vi.hoisted(() => ({ data: [] as any[] }));
const projectsRefetchMock = vi.hoisted(() => vi.fn());
const projectsQueryState = vi.hoisted(() => ({
  data: [] as Array<{ slug: string; name: string }>,
  isSuccess: true,
  refetch: projectsRefetchMock,
}));
const createProjectMutationState = vi.hoisted(() => ({ isPending: false }));
const availableLayoutsQueryMock = vi.hoisted(() => vi.fn());
const layoutCatalogTelemetry = vi.hoisted(() => ({ track: vi.fn() }));
const StationHttpError = vi.hoisted(
  () =>
    class StationHttpError extends Error {
      readonly status: number;

      constructor(status: number) {
        super(`HTTP ${status}`);
        this.name = 'StationHttpError';
        this.status = status;
      }
    },
);

const codingLayout = {
  id: 'builtin:coding',
  name: 'Coding',
  slug: 'coding',
  icon: '⌘',
  description: 'A coding workspace.',
  source: 'builtin',
  type: 'coding',
  tabCount: 3,
  visible: true,
  enabled: true,
  lifecycle: { state: 'installed' },
};
const reviewLayout = {
  id: 'plugin:review',
  name: 'Review',
  slug: 'review',
  icon: '✓',
  description: 'Review pull requests.',
  source: 'plugin',
  sourceIdentity: { id: 'review-plugin' },
  plugin: 'review-plugin',
  type: 'review',
  tabCount: 2,
  visible: true,
  enabled: true,
  lifecycle: { state: 'installed' },
};

vi.mock('@kontourai/station-sdk', () => ({
  applyProjectLayout: (...args: unknown[]) => applyProjectLayoutMock(...args),
  useAvailableProjectLayoutsQuery: (config: unknown) => {
    availableLayoutsQueryMock(config);
    return {
      ...availableLayoutsState,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  },
  useCreateProjectMutation: () => ({
    isPending: createProjectMutationState.isPending,
    mutateAsync: createProjectMock,
  }),
  useProjectsQuery: () => projectsQueryState,
  useFileSystemBrowseQuery: () => ({ refetch: validateDirectoryMock }),
  useSshEnvironmentsQuery: () => ({ data: [], isLoading: false }),
  useProjectIconCandidatesQuery: (...args: unknown[]) => {
    iconCandidatesQueryMock(...args);
    return iconCandidatesState;
  },
  telemetry: layoutCatalogTelemetry,
  StationHttpError,
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3000' }),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ setProject: setProjectMock }),
}));

vi.mock('../hooks/useGitActions', () => ({
  useReposQuery: () => reposQueryState,
}));

vi.mock('../components/PathAutocomplete', () => ({
  PathAutocomplete: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
  }) => (
    <input
      aria-label="Working Directory"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

import { NewProjectModal } from '../components/modals/NewProjectModal';

describe('NewProjectModal starter layout picker', () => {
  beforeEach(() => {
    localStorage.clear();
    createProjectMock.mockReset();
    createProjectMock.mockResolvedValue({ slug: 'my-project' });
    applyProjectLayoutMock.mockReset();
    applyProjectLayoutMock.mockResolvedValue({});
    validateDirectoryMock.mockReset();
    // The shape a SUCCESSFUL `useFileSystemBrowseQuery` refetch actually
    // returns: a settled query carries `data`. `{error: null}` alone is the
    // shape of a refetch that answered nothing, which is a failure to check —
    // not a folder that exists.
    validateDirectoryMock.mockResolvedValue({
      error: null,
      data: { entries: [] },
    });
    setProjectMock.mockReset();
    onCloseMock.mockReset();
    reposQueryState.data = undefined;
    reposQueryState.isFetching = false;
    reposQueryState.isError = false;
    reposQueryState.refetch.mockReset();
    reposQueryState.refetch.mockResolvedValue({
      data: { workspace: '', workspaceIsRepo: false, repos: [] },
    });
    iconCandidatesState.data = [];
    iconCandidatesState.isFetching = false;
    iconCandidatesState.isError = false;
    iconCandidatesQueryMock.mockReset();
    availableLayoutsQueryMock.mockReset();
    availableLayoutsState.data = [codingLayout, reviewLayout];
    projectsQueryState.data = [];
    projectsQueryState.isSuccess = true;
    projectsRefetchMock.mockReset();
    projectsRefetchMock.mockImplementation(async () => ({
      data: projectsQueryState.data,
    }));
    createProjectMutationState.isPending = false;
  });

  test('uses one inline identity control without derivation pills or a duplicate preview', () => {
    render(<NewProjectModal isOpen onClose={onCloseMock} />);

    expect(availableLayoutsQueryMock).toHaveBeenCalledWith({ enabled: true });

    expect(screen.getByLabelText('Choose project icon')).toBeTruthy();
    expect(screen.getByLabelText('Project identity')).toBeTruthy();
    expect(screen.queryByText('Preview')).toBeNull();
    expect(screen.queryByText(/create as/i)).toBeNull();
    expect(screen.queryByText(/^leaf\b/i)).toBeNull();
  });

  test('keeps local artwork opt-in and lets the user return to initials', async () => {
    iconCandidatesState.data = [
      {
        relativePath: 'public/favicon.png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        mediaType: 'image/png',
        source: 'favicon',
      },
    ];
    createProjectMock.mockResolvedValue({ slug: 'station' });

    render(<NewProjectModal isOpen onClose={onCloseMock} />);
    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/tmp/station/' },
    });
    fireEvent.click(screen.getByLabelText('Choose project icon'));
    fireEvent.click(screen.getByLabelText('Use public/favicon.png'));
    fireEvent.click(screen.getByRole('button', { name: 'Use initials' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(createProjectMock).toHaveBeenCalledWith(
        expect.objectContaining({ icon: undefined }),
      ),
    );
  });

  test('does not discover artwork while typing a partial path', async () => {
    render(<NewProjectModal isOpen onClose={onCloseMock} />);

    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/Users/me/de' },
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    expect(validateDirectoryMock).not.toHaveBeenCalled();
    expect(iconCandidatesQueryMock).toHaveBeenLastCalledWith(
      '/Users/me/de',
      expect.objectContaining({ enabled: false }),
    );
  });

  test('enables local artwork discovery once a directory is picked', async () => {
    render(<NewProjectModal isOpen onClose={onCloseMock} />);

    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/Users/me/site/' },
    });

    await waitFor(() =>
      expect(iconCandidatesQueryMock).toHaveBeenLastCalledWith(
        '/Users/me/site',
        expect.objectContaining({ enabled: true }),
      ),
    );
    expect(validateDirectoryMock).not.toHaveBeenCalled();
  });

  test('keeps non-Git directories neutral and recommends eligible Coding for Git directories', async () => {
    const { rerender } = render(
      <NewProjectModal isOpen onClose={onCloseMock} />,
    );
    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/tmp/plain/' },
    });
    expect(screen.queryByText('Recommended for this Git directory')).toBeNull();
    expect(
      screen
        .getByRole('button', { name: /Start without a layout/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');

    reposQueryState.data = {
      workspace: '/tmp/repo',
      workspaceIsRepo: true,
      repos: [{ root: '/tmp/repo' }],
    };
    rerender(<NewProjectModal isOpen onClose={onCloseMock} />);
    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/tmp/repo/' },
    });

    // Detection and selection settle in that order, one commit apart: the
    // Recommended group renders as soon as the settled directory reports a
    // repo, and the effect that SELECTS Coding runs after that commit. Waiting
    // on the group and then reading `aria-pressed` synchronously read the
    // pre-selection render whenever the host was busy enough to separate the
    // two (#1603). The pressed state is the later signal, so it is the one to
    // await; the group is still asserted, after it. Above the 1s default,
    // because the hook's own 400ms settle has to elapse before discovery is
    // even asked — that leaves ~600ms for the query, the render and the
    // selection effect on a loaded host.
    await waitFor(
      () =>
        expect(
          screen
            .getByRole('button', { name: /Coding/ })
            .getAttribute('aria-pressed'),
        ).toBe('true'),
      { timeout: 3_000 },
    );
    expect(screen.getByText('Recommended for this Git directory')).toBeTruthy();
  });

  test('does not surface or create Coding when the distribution omits it', async () => {
    availableLayoutsState.data = [reviewLayout];
    reposQueryState.data = {
      workspace: '/tmp/repo',
      workspaceIsRepo: true,
      repos: [{ root: '/tmp/repo' }],
    };

    render(<NewProjectModal isOpen onClose={onCloseMock} />);
    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/tmp/repo/' },
    });

    expect(screen.queryByText('Recommended for this Git directory')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'Minimal' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createProjectMock).toHaveBeenCalled());
    expect(applyProjectLayoutMock).not.toHaveBeenCalled();
  });

  test('persists an explicit choice across catalog refresh and resets it for a new directory', async () => {
    reposQueryState.data = {
      workspace: '/tmp/repo',
      workspaceIsRepo: true,
      repos: [{ root: '/tmp/repo' }],
    };
    const { rerender } = render(
      <NewProjectModal isOpen onClose={onCloseMock} />,
    );
    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/tmp/repo/' },
    });
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: /Coding/ })
          .getAttribute('aria-pressed'),
      ).toBe('true'),
    );

    fireEvent.click(
      screen.getByRole('button', { name: /Start without a layout/ }),
    );
    availableLayoutsState.data = [reviewLayout, codingLayout];
    rerender(<NewProjectModal isOpen onClose={onCloseMock} />);
    expect(
      screen
        .getByRole('button', { name: /Start without a layout/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');

    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/tmp/other-repo/' },
    });
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: /Coding/ })
          .getAttribute('aria-pressed'),
      ).toBe('true'),
    );
  });

  test('preserves an explicit Git opt-out through project creation', async () => {
    reposQueryState.data = {
      workspace: '/tmp/repo',
      workspaceIsRepo: true,
      repos: [{ root: '/tmp/repo' }],
    };
    render(<NewProjectModal isOpen onClose={onCloseMock} />);
    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/tmp/repo/' },
    });
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: /Coding/ })
          .getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    fireEvent.click(
      screen.getByRole('button', { name: /Start without a layout/ }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createProjectMock).toHaveBeenCalled());
    expect(applyProjectLayoutMock).not.toHaveBeenCalled();
    expect(reposQueryState.refetch).not.toHaveBeenCalled();
  });

  test('shows locally recent layouts in MRU order with catalog metadata', () => {
    localStorage.setItem(
      'recentLayouts',
      JSON.stringify(['plugin:review', 'builtin:coding']),
    );
    render(<NewProjectModal isOpen onClose={onCloseMock} />);

    expect(screen.getByText('Recent on this device')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: /Review|Coding/ });
    expect(buttons[0].textContent).toContain('Review');
    expect(buttons[1].textContent).toContain('Coding');
    expect(buttons[0].textContent).toContain('Plugin: review-plugin');
    expect(buttons[0].textContent).toContain('2 tabs');
  });

  test('keeps every project draft field mounted while browsing and selecting a layout', () => {
    render(<NewProjectModal isOpen onClose={onCloseMock} />);
    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/tmp/draft/' },
    });
    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'Draft Project' },
    });
    fireEvent.change(screen.getByLabelText(/Description/), {
      target: { value: 'Keep this description' },
    });
    fireEvent.click(screen.getByLabelText('Choose project icon'));
    fireEvent.change(screen.getByLabelText(/Emoji or image URL/), {
      target: { value: '🚀' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Browse all' }));
    const browser = screen.getByRole('dialog', {
      name: /Browse installed layouts/,
    });
    expect(browser).toBeTruthy();
    fireEvent.click(within(browser).getByRole('button', { name: /Coding/ }));

    expect(
      screen.queryByRole('dialog', { name: /Browse installed layouts/ }),
    ).toBeNull();
    expect(
      (screen.getByLabelText('Working Directory') as HTMLInputElement).value,
    ).toBe('/tmp/draft/');
    expect(
      (screen.getByPlaceholderText('My Project') as HTMLInputElement).value,
    ).toBe('Draft Project');
    expect(
      (screen.getByLabelText(/Description/) as HTMLTextAreaElement).value,
    ).toBe('Keep this description');
    expect(
      (screen.getByLabelText(/Emoji or image URL/) as HTMLInputElement).value,
    ).toBe('🚀');
  });

  test('applies only the selected canonical ID and records it after success', async () => {
    render(<NewProjectModal isOpen onClose={onCloseMock} />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse all' }));
    fireEvent.click(
      within(
        screen.getByRole('dialog', { name: /Browse installed layouts/ }),
      ).getByRole('button', { name: /Review/ }),
    );
    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'My Project' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(applyProjectLayoutMock).toHaveBeenCalledWith(
        'http://localhost:3000',
        'my-project',
        'plugin:review',
      ),
    );
    expect(JSON.parse(localStorage.getItem('recentLayouts') ?? '[]')).toEqual([
      'plugin:review',
    ]);
    expect(setProjectMock).toHaveBeenCalledWith('my-project');
    expect(onCloseMock).toHaveBeenCalled();
  });

  /**
   * #1536 E4. This used to assert the opposite: a manually typed path
   * re-ran repo discovery AT SUBMIT and applied Coding when it found a repo.
   * Nothing on screen said so — the recommendation was never rendered, so
   * "Start without a layout" was the option shown as pressed while the project
   * was created with a Coding layout. Create applies the selection the picker
   * shows and nothing else, so with no repo discovered there is no layout.
   *
   * `useReposQuery` is mocked in this file, so the `enabled` gate that decides
   * WHETHER discovery runs is invisible here — that seam is covered against the
   * real query in `hooks/__tests__/useNewProjectStarter.test.tsx`.
   */
  test('creates no layout for a typed path when no repository is discovered', async () => {
    reposQueryState.refetch.mockResolvedValue({
      data: {
        workspace: '/tmp/typed-workspace',
        workspaceIsRepo: false,
        repos: [{ root: '/tmp/typed-workspace/repo' }],
      },
    });
    createProjectMock.mockResolvedValue({ slug: 'typed-workspace' });

    render(<NewProjectModal isOpen onClose={onCloseMock} />);
    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/tmp/typed-workspace' },
    });
    // The state the user is looking at when they press Create.
    expect(
      screen
        .getByRole('button', { name: /Start without a layout/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createProjectMock).toHaveBeenCalled());
    expect(applyProjectLayoutMock).not.toHaveBeenCalled();
    expect(reposQueryState.refetch).not.toHaveBeenCalled();
  });

  /**
   * The recommendation itself is not removed — it is only made visible before
   * it can be applied. A detected Git directory still selects Coding, and the
   * card that Create then applies is the one on screen. The typed path carries
   * NO trailing slash on purpose: that is the shape #1536 E4 was reported
   * against, and the twin of `tests/project-architecture.spec.ts`'s
   * "a manually typed path shows the Git recommendation".
   */
  test('applies the recommended Coding starter for a typed path once it is the shown selection', async () => {
    reposQueryState.data = {
      workspace: '/tmp/repo',
      workspaceIsRepo: true,
      repos: [{ root: '/tmp/repo' }],
    };
    createProjectMock.mockResolvedValue({ slug: 'repo' });

    render(<NewProjectModal isOpen onClose={onCloseMock} />);
    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/tmp/repo' },
    });
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: /Coding/ })
          .getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(applyProjectLayoutMock).toHaveBeenCalledWith(
        'http://localhost:3000',
        'repo',
        'builtin:coding',
      ),
    );
  });

  test('retries a failed starter apply without creating the project again', async () => {
    applyProjectLayoutMock.mockRejectedValueOnce(
      new Error('Starter could not apply'),
    );
    render(<NewProjectModal isOpen onClose={onCloseMock} />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse all' }));
    fireEvent.click(
      within(
        screen.getByRole('dialog', { name: /Browse installed layouts/ }),
      ).getByRole('button', { name: /Review/ }),
    );
    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'My Project' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(screen.getByText('Starter could not apply')).toBeTruthy(),
    );
    expect(localStorage.getItem('recentLayouts')).toBeNull();
    expect(setProjectMock).not.toHaveBeenCalled();
    expect(onCloseMock).not.toHaveBeenCalled();

    expect(
      screen.getByText(
        'Project created. Retry the selected starter layout to finish setup.',
      ),
    ).toBeTruthy();
    expect(screen.getByPlaceholderText('My Project').matches(':disabled')).toBe(
      true,
    );
    expect(
      screen
        .getByRole('button', { name: /Start without a layout/ })
        .matches(':disabled'),
    ).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Retry layout' }).matches(':disabled'),
    ).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Retry layout' }));

    await waitFor(() =>
      expect(setProjectMock).toHaveBeenCalledWith('my-project'),
    );
    expect(createProjectMock).toHaveBeenCalledTimes(1);
    expect(applyProjectLayoutMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem('recentLayouts') ?? '[]')).toEqual([
      'plugin:review',
    ]);
    expect(onCloseMock).toHaveBeenCalledOnce();
  });

  test('derives the project name from the working directory until edited', async () => {
    render(<NewProjectModal isOpen onClose={onCloseMock} />);

    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/tmp/launch-pad' },
    });

    await waitFor(() => {
      const nameInput = screen.getByPlaceholderText(
        'My Project',
      ) as HTMLInputElement;
      expect(nameInput.value).toBe('Launch Pad');
    });
  });

  test('derives the project name from the working directory until edited', async () => {
    render(<NewProjectModal isOpen onClose={onCloseMock} />);

    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/tmp/launch-pad' },
    });

    await waitFor(() => {
      const nameInput = screen.getByPlaceholderText(
        'My Project',
      ) as HTMLInputElement;
      expect(nameInput.value).toBe('Launch Pad');
    });
  });
});

describe('NewProjectModal copy density and layout browser placement (station#1825 items 3-4)', () => {
  beforeEach(() => {
    localStorage.clear();
    createProjectMock.mockReset();
    createProjectMock.mockResolvedValue({ slug: 'my-project' });
    applyProjectLayoutMock.mockReset();
    applyProjectLayoutMock.mockResolvedValue({});
    validateDirectoryMock.mockReset();
    validateDirectoryMock.mockResolvedValue({ error: null });
    setProjectMock.mockReset();
    onCloseMock.mockReset();
    reposQueryState.data = undefined;
    reposQueryState.isFetching = false;
    reposQueryState.isError = false;
    reposQueryState.refetch.mockReset();
    reposQueryState.refetch.mockResolvedValue({
      data: { workspace: '', workspaceIsRepo: false, repos: [] },
    });
    iconCandidatesState.data = [];
    iconCandidatesState.isFetching = false;
    iconCandidatesState.isError = false;
    iconCandidatesQueryMock.mockReset();
    availableLayoutsQueryMock.mockReset();
    availableLayoutsState.data = [codingLayout, reviewLayout];
  });

  test('item 3: states the working-directory-first behavior once, not three times, and keeps the non-obvious facts as field-level hints', () => {
    render(<NewProjectModal isOpen onClose={onCloseMock} />);

    // The old three-line intro paragraph is gone.
    expect(screen.queryByText(/Start with the workspace folder/)).toBeNull();
    // The redundant "instruction-as-heading" card title is gone.
    expect(screen.queryByText('Working directory first')).toBeNull();
    // Its own two-line restatement of the same ordering is gone too.
    expect(
      screen.queryByText(/Point Station at the folder you actually want/),
    ).toBeNull();

    // The two genuinely non-obvious behaviors survive as a short hint
    // attached to the field they concern (Project identity: the name and
    // icon), not as a preamble read before any input exists.
    const identityField = screen
      .getByLabelText('Project identity')
      .closest('.editor-field') as HTMLElement;
    expect(identityField).toBeTruthy();
    expect(
      within(identityField).getByText(
        /Follows the working directory until you edit it/,
      ),
    ).toBeTruthy();
    expect(
      within(identityField).getByText(/Uses initials until you choose an icon/),
    ).toBeTruthy();
  });

  test('item 4: the layout browser swaps in as the modal body — Create is not present while browsing, and the browser is never appended after it', () => {
    render(<NewProjectModal isOpen onClose={onCloseMock} />);

    // Before browsing: exactly one dialog, Create present, no browser markup
    // anywhere in the document.
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy();
    expect(
      document.querySelector('.new-project-layout-browser__actions'),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Browse all' }));

    // The defect this fixes: the old nested-dialog implementation kept the
    // project form (and its Create button) mounted underneath, with the
    // browse panel appended after it. A genuine swap removes the form
    // entirely while browsing — there is no "primary action" for this step
    // other than the browser's own trailing action.
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
    expect(document.querySelector('.new-project-modal__form')).toBeNull();

    const panel = screen.getByRole('dialog', {
      name: /Browse installed layouts/,
    });
    const backButton = screen.getByRole('button', { name: 'Back to project' });
    // Structural proof, not just presence: the actions row is the LAST
    // direct child of the dialog panel — nothing renders after it (the
    // reported bug: "it adds content to the bottom after the create
    // button").
    expect(panel.lastElementChild).toBe(backButton.closest('div'));
    expect(panel.lastElementChild?.contains(backButton)).toBe(true);

    fireEvent.click(backButton);

    // Restores the same modal — no second dialog was ever created — with
    // Create last again and no trailing content after its actions row.
    const restoredPanel = screen.getByRole('dialog', { name: 'New Project' });
    expect(restoredPanel).toBe(panel);
    const createButton = screen.getByRole('button', { name: 'Create' });
    const formEl = document.querySelector(
      '.new-project-modal__form',
    ) as HTMLElement;
    expect(restoredPanel.lastElementChild).toBe(formEl);
    expect(formEl.lastElementChild?.contains(createButton)).toBe(true);
  });
});

describe('NewProjectModal layout browser dismissal scope (station#1825 item 4, review round 2)', () => {
  beforeEach(() => {
    localStorage.clear();
    createProjectMock.mockReset();
    createProjectMock.mockResolvedValue({ slug: 'my-project' });
    applyProjectLayoutMock.mockReset();
    applyProjectLayoutMock.mockResolvedValue({});
    validateDirectoryMock.mockReset();
    validateDirectoryMock.mockResolvedValue({ error: null });
    setProjectMock.mockReset();
    onCloseMock.mockReset();
    reposQueryState.data = undefined;
    reposQueryState.isFetching = false;
    reposQueryState.isError = false;
    reposQueryState.refetch.mockReset();
    reposQueryState.refetch.mockResolvedValue({
      data: { workspace: '', workspaceIsRepo: false, repos: [] },
    });
    iconCandidatesState.data = [];
    iconCandidatesState.isFetching = false;
    iconCandidatesState.isError = false;
    iconCandidatesQueryMock.mockReset();
    availableLayoutsQueryMock.mockReset();
    availableLayoutsState.data = [codingLayout, reviewLayout];
  });

  test('HIGH: Escape while browsing returns to the draft form instead of discarding it and exiting the flow', () => {
    render(<NewProjectModal isOpen onClose={onCloseMock} />);
    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'Draft Keeper' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Browse all' }));
    expect(
      screen.getByRole('dialog', { name: /Browse installed layouts/ }),
    ).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    // Back on the draft form — not closed, and the draft survived.
    expect(onCloseMock).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'New Project' })).toBeTruthy();
    expect(
      (screen.getByPlaceholderText('My Project') as HTMLInputElement).value,
    ).toBe('Draft Keeper');
  });

  test('HIGH: a backdrop tap while browsing returns to the draft form instead of exiting the flow', () => {
    const { container } = render(
      <NewProjectModal isOpen onClose={onCloseMock} />,
    );
    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'Draft Keeper' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Browse all' }));

    const overlay = container.querySelector('.responsive-surface-overlay')!;
    fireEvent.pointerDown(overlay);

    expect(onCloseMock).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'New Project' })).toBeTruthy();
    expect(
      (screen.getByPlaceholderText('My Project') as HTMLInputElement).value,
    ).toBe('Draft Keeper');
  });

  test('HIGH: hardware/browser Back while browsing returns to the draft form instead of discarding it', async () => {
    render(<NewProjectModal isOpen onClose={onCloseMock} />);
    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'Draft Keeper' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Browse all' }));
    expect(
      screen.getByRole('dialog', { name: /Browse installed layouts/ }),
    ).toBeTruthy();

    window.history.back();

    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: /Browse installed layouts/ }),
      ).toBeNull(),
    );
    expect(onCloseMock).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'New Project' })).toBeTruthy();
    expect(
      (screen.getByPlaceholderText('My Project') as HTMLInputElement).value,
    ).toBe('Draft Keeper');
  });

  test('the header close button while browsing is scoped "Close layout browser" and also returns to the draft, never "Close new project"', () => {
    render(<NewProjectModal isOpen onClose={onCloseMock} />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse all' }));

    expect(
      screen.queryByRole('button', { name: 'Close new project' }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Close layout browser' }),
    );

    expect(onCloseMock).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'New Project' })).toBeTruthy();
  });

  test('regression guard: Escape and a backdrop tap on the draft step itself still exit the whole flow', () => {
    const { unmount } = render(
      <NewProjectModal isOpen onClose={onCloseMock} />,
    );

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCloseMock).toHaveBeenCalledTimes(1);
    unmount();

    onCloseMock.mockReset();
    const second = render(<NewProjectModal isOpen onClose={onCloseMock} />);
    const overlay = second.container.querySelector(
      '.responsive-surface-overlay',
    )!;
    fireEvent.pointerDown(overlay);
    expect(onCloseMock).toHaveBeenCalledTimes(1);
    second.unmount();
  });

  test('HIGH: returning from the layout browser moves focus into the form instead of leaving it on document.body', () => {
    render(<NewProjectModal isOpen onClose={onCloseMock} />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse all' }));
    // Forward transition already lands focus on the browser's own heading —
    // establishing that document.body is not simply the jsdom default.
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Browse installed layouts' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Back to project' }));

    // This test's own top-of-file mock replaces `PathAutocomplete` with a
    // bare `<input>` carrying no autofocus behavior of its own, so it cannot
    // exercise the real-app effect-ordering race the production comment
    // documents (a `useLayoutEffect` here loses to `PathAutocomplete`'s own
    // deeper passive `useEffect`, verified live in a real browser — fixed by
    // matching effect types so this ancestor's callback runs after). What
    // this test CAN and does prove: focus deliberately lands on an explicit,
    // owned target — never `document.body` — regardless of what any
    // descendant field does.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'New Project' }),
    );
  });
});

describe('NewProjectModal refusals (4-HOME-007, 4-HOME-008, SHELL-01)', () => {
  beforeEach(() => {
    localStorage.clear();
    createProjectMock.mockReset();
    createProjectMock.mockResolvedValue({ slug: 'my-project' });
    applyProjectLayoutMock.mockReset();
    applyProjectLayoutMock.mockResolvedValue({});
    validateDirectoryMock.mockReset();
    validateDirectoryMock.mockResolvedValue({
      error: null,
      data: { entries: [] },
    });
    setProjectMock.mockReset();
    onCloseMock.mockReset();
    reposQueryState.data = undefined;
    reposQueryState.isFetching = false;
    reposQueryState.isError = false;
    reposQueryState.refetch.mockReset();
    reposQueryState.refetch.mockResolvedValue({
      data: { workspace: '', workspaceIsRepo: false, repos: [] },
    });
    iconCandidatesState.data = [];
    iconCandidatesQueryMock.mockReset();
    availableLayoutsQueryMock.mockReset();
    availableLayoutsState.data = [codingLayout, reviewLayout];
    projectsQueryState.data = [];
    projectsQueryState.isSuccess = true;
    projectsRefetchMock.mockReset();
    projectsRefetchMock.mockImplementation(async () => ({
      data: projectsQueryState.data,
    }));
    createProjectMutationState.isPending = false;
  });

  const auditAlphaProjects = [
    { slug: 'audit-alpha', name: 'Audit Alpha' },
    { slug: 'audit-alpha-2', name: 'Audit Alpha 2' },
  ];

  test('warns from the cache without blocking, then refuses on the refreshed list', async () => {
    projectsQueryState.data = auditAlphaProjects;
    render(<NewProjectModal isOpen onClose={onCloseMock} />);

    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'Audit Alpha' },
    });

    // Cache-only: a warning the user can proceed past, never a veto.
    const advisory = await screen.findByRole('status');
    expect(advisory.textContent).toBe(
      "A project called 'Audit Alpha' may already exist. Station checks with the server when you create it.",
    );
    expect(screen.queryByRole('alert')).toBeNull();
    const create = screen.getByRole('button', {
      name: 'Create',
    }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);

    fireEvent.click(create);

    // The refreshed list agrees, so now it is a refusal — the confirmed
    // sentence, with the free slug, and no POST.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      "A project called 'Audit Alpha' already exists. The slug 'audit-alpha-3' is available.",
    );
    // The old 409 sentence, which described storage rather than the name.
    expect(alert.textContent).not.toContain('storage changed');
    expect(
      (
        screen.getByPlaceholderText('My Project') as HTMLInputElement
      ).getAttribute('aria-invalid'),
    ).toBe('true');
    expect(projectsRefetchMock).toHaveBeenCalled();
    expect(createProjectMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
  });

  /**
   * `['projects']` stays fresh for five minutes with refetch on
   * mount and on focus disabled, so a project deleted by another device, the
   * CLI, or another tab lingers in this cache. Vetoing on it would refuse a
   * legitimate name for minutes and never attempt the POST — the only
   * authority on whether the slug is taken.
   */
  test('a stale cached conflict never blocks a name the server says is free', async () => {
    projectsQueryState.data = auditAlphaProjects;
    // The project was deleted elsewhere; the refreshed read is the truth.
    projectsRefetchMock.mockResolvedValue({ data: [] });
    render(<NewProjectModal isOpen onClose={onCloseMock} />);

    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'Audit Alpha' },
    });
    expect(await screen.findByRole('status')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(createProjectMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Audit Alpha', slug: 'audit-alpha' }),
      ),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a failed refresh lets the POST proceed so the server decides', async () => {
    projectsQueryState.data = auditAlphaProjects;
    projectsRefetchMock.mockRejectedValue(new Error('offline'));
    render(<NewProjectModal isOpen onClose={onCloseMock} />);

    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'Audit Alpha' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createProjectMock).toHaveBeenCalled());
  });

  test('a refresh that answers with no list lets the POST proceed too', async () => {
    projectsQueryState.data = auditAlphaProjects;
    projectsRefetchMock.mockResolvedValue({ data: undefined });
    render(<NewProjectModal isOpen onClose={onCloseMock} />);

    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'Audit Alpha' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createProjectMock).toHaveBeenCalled());
  });

  test('clears a confirmed duplicate refusal as soon as the name changes', async () => {
    projectsQueryState.data = [{ slug: 'audit-alpha', name: 'Audit Alpha' }];
    render(<NewProjectModal isOpen onClose={onCloseMock} />);

    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'Audit Alpha' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('alert')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'Audit Beta' },
    });

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(
      (screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  test('says nothing at all while the project list has not loaded', async () => {
    projectsQueryState.data = [];
    projectsQueryState.isSuccess = false;
    render(<NewProjectModal isOpen onClose={onCloseMock} />);

    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'Audit Alpha' },
    });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(createProjectMock).toHaveBeenCalled());
  });

  /**
   * 4-HOME-008: this was a silent no-op — the browse 404 was thrown from a
   * place nothing rendered, so Create stayed enabled, no POST was issued and
   * no message appeared anywhere in the modal.
   */
  test('reports a nonexistent working directory against the field and issues no POST', async () => {
    // The SDK stamps the browse route's HTTP status on a refused check; a
    // 404 is the server's VERDICT about the path, which is what earns the
    // disabled Create below (#765: only a verdict may disable it).
    validateDirectoryMock.mockResolvedValue({
      error: Object.assign(new Error('Folder not found'), { status: 404 }),
    });
    render(<NewProjectModal isOpen onClose={onCloseMock} />);
    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/definitely/not/a/real/dir-audit' },
    });
    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'Audit Alpha' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Folder not found');
    expect(alert.id).toBe('new-project-directory-error');
    expect(createProjectMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
  });

  test('re-enables Create once the refused directory is edited', async () => {
    validateDirectoryMock.mockResolvedValue({
      error: Object.assign(new Error('Folder not found'), { status: 404 }),
    });
    render(<NewProjectModal isOpen onClose={onCloseMock} />);
    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/definitely/not/a/real/dir-audit' },
    });
    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'Audit Alpha' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByRole('alert');

    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/tmp/real-enough' },
    });

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(
      (screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  test('says so when the directory check answers with neither data nor an error', async () => {
    validateDirectoryMock.mockResolvedValue({ error: null });
    render(<NewProjectModal isOpen onClose={onCloseMock} />);
    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/tmp/unanswered' },
    });
    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'Audit Alpha' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'Station could not check this folder. Try again.',
    );
    expect(createProjectMock).not.toHaveBeenCalled();
    // "Try again." must be actionable: no verdict was established about the
    // path, so Create stays enabled for the retry (#765 F7-class).
    expect(
      (screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  /**
   * #765 residue (F7-class, observed in two independent audit passes): on a
   * loaded host the directory pre-check can fail WITHOUT a verdict (dead
   * backend, 5xx, network refusal). That refusal used to disable Create with
   * copy reading "Try again." — pointer clicks silently dead against a
   * message whose remedy the disabled button made impossible, while a later
   * attempt (check recovered) worked. A verdict-less failure must leave
   * Create enabled and a re-click must genuinely retry.
   */
  test('keeps Create clickable through a verdict-less directory-check failure, and the retry creates', async () => {
    validateDirectoryMock.mockResolvedValueOnce({
      error: new TypeError('Failed to fetch'),
    });
    validateDirectoryMock.mockResolvedValue({
      error: null,
      data: { entries: [] },
    });
    render(<NewProjectModal isOpen onClose={onCloseMock} />);
    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/tmp/audit-loaded-host' },
    });
    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'Audit Alpha' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Failed to fetch');
    expect(createProjectMock).not.toHaveBeenCalled();
    // No verdict about the path: the input must not claim invalidity and the
    // retry control must stay live.
    expect(
      screen.getByLabelText('Working Directory').getAttribute('aria-invalid'),
    ).toBeNull();
    const create = screen.getByRole('button', {
      name: 'Create',
    }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);

    fireEvent.click(create);
    await waitFor(() => expect(createProjectMock).toHaveBeenCalled());
  });

  test('a 5xx from the browse route is not a verdict about the path and keeps Create enabled', async () => {
    validateDirectoryMock.mockResolvedValue({
      error: Object.assign(new Error('Folder could not be read.'), {
        status: 503,
      }),
    });
    render(<NewProjectModal isOpen onClose={onCloseMock} />);
    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/tmp/audit-busy' },
    });
    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'Audit Alpha' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await screen.findByRole('alert');
    expect(createProjectMock).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  /**
   * SHELL-01: the 6-8s window where Create looked ignored is what invited the
   * double submit. The directory check is the first await on the submit path,
   * so pending state must already be showing while it runs.
   */
  test('shows pending state on Create while the directory check is in flight', async () => {
    let release: (value: { error: null; data: unknown }) => void = () => {};
    validateDirectoryMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    render(<NewProjectModal isOpen onClose={onCloseMock} />);
    fireEvent.change(screen.getByLabelText('Working Directory'), {
      target: { value: '/tmp/slow' },
    });
    fireEvent.change(screen.getByPlaceholderText('My Project'), {
      target: { value: 'Audit Alpha' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    const pending = (await screen.findByRole('button', {
      name: 'Creating…',
    })) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);

    await act(async () => {
      release({ error: null, data: { entries: [] } });
    });
    await waitFor(() => expect(createProjectMock).toHaveBeenCalled());
  });

  test('shows pending state on Create while the creation request is in flight', () => {
    createProjectMutationState.isPending = true;
    render(<NewProjectModal isOpen onClose={onCloseMock} />);

    const pending = screen.getByRole('button', {
      name: 'Creating…',
    }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
  });
});

/**
 * @vitest-environment jsdom
 */

import type { Skill } from '@kontourai/station-contracts/catalog';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const selectionState = {
  selectedId: null as string | null,
  select: vi.fn(),
  deselect: vi.fn(),
};

let localSkillsMock: any[] = [];
let localSkillsPendingMock = false;
let localSkillsErrorMock: unknown = null;
const refetchSkillsMock = vi.fn();
let editableSkillMock: any;
let detailPendingMock = false;
let detailErrorMock: unknown = null;
const refetchDetailMock = vi.fn();
const createLocalSkillMock = vi.fn().mockResolvedValue(undefined);
const updateLocalSkillMock = vi.fn().mockResolvedValue(undefined);
const importSkillsMock = vi
  .fn()
  .mockResolvedValue({ imported: 0, results: [] });
const runSkillMock = vi.fn().mockResolvedValue(undefined);
const uninstallSkillMock = vi.fn();
const setDockStateMock = vi.fn();
const setActiveChatMock = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useCreateLocalSkillMutation: () => ({
    isPending: false,
    mutateAsync: createLocalSkillMock,
  }),
  useImportSkills: () => ({ isPending: false, mutateAsync: importSkillsMock }),
  useRunSkill: () => ({ isPending: false, mutateAsync: runSkillMock }),
  useInstallSkillMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useSkillContentQuery: () => ({ data: undefined }),
  useSkillQuery: () => ({
    data: editableSkillMock,
    isPending: detailPendingMock,
    error: detailErrorMock,
    refetch: refetchDetailMock,
  }),
  useSkillsQuery: () => ({
    data: localSkillsMock,
    error: localSkillsErrorMock,
    isPending: localSkillsPendingMock,
    refetch: refetchSkillsMock,
  }),
  useUninstallSkillMutation: () => ({
    isPending: false,
    mutate: uninstallSkillMock,
  }),
  useUpdateLocalSkillMutation: () => ({
    isPending: false,
    mutateAsync: updateLocalSkillMock,
  }),
  useUpdateSkillMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));

const navigateMock = vi.fn();
const showToastMock = vi.fn();

vi.mock('../contexts/NavigationContext', () => {
  // NavigationContext publishes two read hooks: `useNavigation` (subscribes to
  // the store, optionally through a selector) and `useNavigationActions` (the
  // memoized actions, no subscription). This mock answers both from one value.
  const navigation = () => ({
    navigate: navigateMock,
    setDockState: setDockStateMock,
    setActiveChat: setActiveChatMock,
  });
  return {
    useNavigation: (
      selector?: (state: ReturnType<typeof navigation>) => unknown,
    ) => (selector ? selector(navigation()) : navigation()),
    useNavigationActions: navigation,
  };
});

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [{ slug: 'station', name: 'Station', skills: [] }],
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost' }),
}));

vi.mock('../hooks/useActiveChatSessions', () => ({
  useLaunchChat: () => vi.fn().mockResolvedValue('session-1'),
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

vi.mock('../hooks/useUrlSelection', () => ({
  useUrlSelection: () => selectionState,
}));

vi.mock('../hooks/useCloseShortcut', () => ({
  useCloseShortcut: vi.fn(),
}));

import { SkillsView } from '../views/SkillsView';
import {
  chooseOverflow,
  openOverflow,
  overflowItems,
} from './helpers/overflow-menu';

/**
 * A skill as the list and detail reads hand it over. The view sets
 * `installed` itself, and nothing here reads the registry `id`, so a fixture
 * carries neither.
 */
type SkillFixture = Partial<Skill> & { name: string };

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
});

afterEach(() => {
  vi.unstubAllGlobals();
  selectionState.selectedId = null;
  selectionState.select.mockReset();
  selectionState.deselect.mockReset();
  navigateMock.mockReset();
  showToastMock.mockReset();
  localSkillsMock = [];
  localSkillsPendingMock = false;
  localSkillsErrorMock = null;
  refetchSkillsMock.mockReset();
  editableSkillMock = undefined;
  detailPendingMock = false;
  detailErrorMock = null;
  refetchDetailMock.mockReset();
  createLocalSkillMock.mockClear();
  updateLocalSkillMock.mockClear();
  importSkillsMock.mockClear();
  runSkillMock.mockClear();
  setDockStateMock.mockClear();
  setActiveChatMock.mockClear();
});

describe('SkillsView', () => {
  function renderEditor() {
    const rendered = render(<SkillsView />);
    const edit = screen.queryByRole('button', { name: 'Edit skill' });
    if (edit && !(edit as HTMLButtonElement).disabled) fireEvent.click(edit);
    return rendered;
  }

  function chooseImportFile(name: string, content: string) {
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const chosen = new File([content], name, { type: 'text/markdown' });
    Object.defineProperty(input, 'files', {
      value: [chosen],
      configurable: true,
    });
    fireEvent.change(input);
  }

  // SHELL-09. `isLoading` was a hardcoded `false`, so for the ~2.2 s the skills
  // read was in flight the list panel asserted "No installed skills yet" — the
  // definitive empty state, with a CTA to create one — and then swapped in 24
  // installed skills. Reproduced 3/3 in the audit; a new user's first
  // impression of Guidance was a screen telling them they had nothing.
  test('shows the loading skeleton, not the empty state, while skills load', () => {
    localSkillsPendingMock = true;
    localSkillsMock = [];

    renderEditor();

    expect(screen.getByLabelText('Loading list')).toBeTruthy();
    expect(screen.queryByText('No installed skills yet')).toBeNull();
  });

  test('shows the empty state once the skills read settles empty', () => {
    localSkillsPendingMock = false;
    localSkillsMock = [];

    renderEditor();

    expect(screen.getByText('No installed skills yet')).toBeTruthy();
    expect(screen.queryByLabelText('Loading list')).toBeNull();
  });

  // The pending fix above left the other half of SHELL-09 open: a
  // FAILED read also settles with no data, so `isPending === false` plus the
  // `= []` default rendered the same definitive "No installed skills yet" over
  // a 500. Error is not empty.
  test('shows the read failure, not the empty state, when the skills query errors', () => {
    localSkillsPendingMock = false;
    localSkillsMock = [];
    localSkillsErrorMock = new Error('skills read failed');

    renderEditor();

    expect(screen.queryByText('No installed skills yet')).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Unable to load skills')).toBeTruthy();
    expect(screen.getByText('skills read failed')).toBeTruthy();
  });

  test('retries the skills read from the failure state', () => {
    localSkillsErrorMock = new Error('skills read failed');

    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(refetchSkillsMock).toHaveBeenCalledTimes(1);
  });

  test('imports markdown through the live mutation and refreshes the skill list', async () => {
    importSkillsMock.mockResolvedValueOnce({
      imported: 1,
      results: [
        { filename: 'release-check.md', success: true, name: 'release-check' },
      ],
    });
    renderEditor();

    fireEvent.click(screen.getByRole('button', { name: 'Import .md' }));
    chooseImportFile('release-check.md', '# Release check');
    await screen.findByText('1 file to import');
    fireEvent.click(screen.getByRole('button', { name: 'Import 1' }));

    await waitFor(() =>
      expect(importSkillsMock).toHaveBeenCalledWith([
        { filename: 'release-check.md', content: '# Release check' },
      ]),
    );
    await waitFor(() => expect(refetchSkillsMock).toHaveBeenCalledTimes(1));
    expect(
      screen.getByText('release-check.md — imported as release-check'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open release-check' }));
    expect(selectionState.select).toHaveBeenCalledWith('release-check');
    expect(screen.queryByRole('dialog', { name: 'Import Skills' })).toBeNull();
  });

  test('renders an import rejection in the dialog', async () => {
    importSkillsMock.mockRejectedValueOnce(
      new Error('Import route unavailable'),
    );
    renderEditor();

    fireEvent.click(screen.getByRole('button', { name: 'Import .md' }));
    chooseImportFile('release-check.md', '# Release check');
    await screen.findByText('1 file to import');
    fireEvent.click(screen.getByRole('button', { name: 'Import 1' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Import route unavailable',
    );
  });

  // #2708: the import fetcher's refusal carries `details`; the dialog shows
  // the server's reason, not "Validation failed: files …".
  test('an import validation refusal shows the reason, not the field key', async () => {
    const { importSkills } = await import('@kontourai/station-sdk/client');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error: 'Validation failed',
            details: {
              formErrors: [],
              fieldErrors: { files: ['Add at least one markdown file.'] },
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    importSkillsMock.mockImplementationOnce((files: never) =>
      importSkills('http://localhost', files),
    );
    renderEditor();

    fireEvent.click(screen.getByRole('button', { name: 'Import .md' }));
    chooseImportFile('release-check.md', '# Release check');
    await screen.findByText('1 file to import');
    fireEvent.click(screen.getByRole('button', { name: 'Import 1' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Add at least one markdown file.');
    expect(alert.textContent).not.toContain('Validation failed');
  });

  test('renders the create form when the URL selection is /skills/new', () => {
    selectionState.selectedId = 'new';

    renderEditor();

    expect(screen.getByText('New Skill')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy();
    expect(screen.queryByText('No skill selected')).toBeNull();
  });

  test('requests the new-skill route when the add button is clicked', () => {
    renderEditor();

    fireEvent.click(screen.getByRole('button', { name: 'New skill' }));

    expect(selectionState.select).toHaveBeenCalledWith('new');
  });

  test('starts with a skill overview and guards returning from unsaved authoring', () => {
    selectionState.selectedId = 'plan-work';
    localSkillsMock = [
      {
        name: 'plan-work',
        description: 'Turn an idea into a plan',
        origin: 'user',
        writable: true,
      },
    ];
    editableSkillMock = {
      name: 'plan-work',
      description: 'Turn an idea into a plan',
      body: 'Plan {{idea}}',
      variables: [{ name: 'idea', description: 'The change you want to make' }],
    };
    render(<SkillsView />);

    expect(screen.getByRole('region', { name: 'Skill overview' })).toBeTruthy();
    expect(screen.getByText('Required before starting')).toBeTruthy();
    expect(screen.getByText('The change you want to make')).toBeTruthy();
    expect(screen.queryByLabelText('Body')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Use in a new chat' }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Edit skill' }));
    fireEvent.change(screen.getByLabelText('Body'), {
      target: { value: 'Changed {{idea}}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Back to overview' }));
    expect(
      screen.getByRole('dialog', { name: 'Unsaved Changes' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toBe(
      'Changed {{idea}}',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back to overview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('region', { name: 'Skill overview' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit skill' }));
    expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toBe(
      'Plan {{idea}}',
    );
  });

  test.each([
    { defaultValue: '', required: true },
    { defaultValue: '   ', required: true },
    { defaultValue: 'staging', required: false },
  ])(
    'overview and start agree about the default $defaultValue',
    ({ defaultValue, required }) => {
      selectionState.selectedId = 'release-check';
      localSkillsMock = [{ name: 'release-check', writable: true }];
      editableSkillMock = {
        name: 'release-check',
        body: 'Ship to {{env}}',
        variables: [{ name: 'env', default: defaultValue }],
      };
      render(<SkillsView />);
      expect(
        screen.getByText(
          required ? 'Required before starting' : 'Default: staging',
        ),
      ).toBeTruthy();
      fireEvent.click(
        screen.getByRole('button', { name: 'Use in a new chat' }),
      );
      expect(
        (
          screen.getByRole('button', {
            name: 'Start chat',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(required);
    },
  );

  test('offers supported finding and file import from the library welcome', () => {
    render(<SkillsView />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Find skills in Registry' }),
    );
    expect(navigateMock).toHaveBeenCalledWith('/registry/skills');
    fireEvent.click(screen.getByRole('button', { name: 'Import skill files' }));
    expect(screen.getByRole('dialog', { name: 'Import Skills' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Choose .md files' }),
    ).toBeTruthy();
  });

  test('keeps the Registry Skills link in the skills body', () => {
    renderEditor();

    fireEvent.click(
      screen.getByRole('button', { name: 'Browse Registry Skills' }),
    );
    expect(navigateMock).toHaveBeenCalledWith('/registry/skills');
  });

  // #1582 D6. Mounted through the real view, not the row builder: the chip and
  // the band header are rendered by `SplitPaneLayout` from `badge`/`section`,
  // so a builder-only assertion would pass with neither on screen.
  test('every row says which root it was loaded from, banded by source', () => {
    localSkillsMock = [
      {
        name: 'built-in-skill',
        source: 'flow-agents',
        origin: 'package',
        writable: false,
      },
      {
        name: 'machine-skill',
        source: 'local',
        origin: 'user',
        writable: true,
      },
      {
        name: 'workspace-skill',
        source: 'local',
        origin: 'project',
        writable: true,
      },
      { name: 'unrecorded-skill', source: 'local', writable: true },
    ];

    const { container } = renderEditor();

    const chips = Array.from(
      container.querySelectorAll('.skill-source-chip'),
    ).map((chip) => chip.textContent);
    expect(chips).toEqual([
      'This workspace',
      'This machine',
      'Built in',
      'Source unrecorded',
    ]);
    const headers = Array.from(
      container.querySelectorAll('.split-pane__section-header'),
    ).map((header) => header.textContent);
    expect(headers).toEqual([
      'This workspace',
      'This machine',
      'Built in',
      'Source unrecorded',
    ]);
    // The rows themselves moved with their bands — the built-in row that was
    // authored first is no longer first on screen.
    const names = Array.from(
      container.querySelectorAll('.split-pane__item-name-text'),
    ).map((name) => name.textContent);
    expect(names).toEqual([
      'workspace-skill',
      'machine-skill',
      'built-in-skill',
      'unrecorded-skill',
    ]);
  });

  // The detail pane used to call anything writable "Workspace-authored skill",
  // which is what named a machine-scoped skill a workspace one (#1582 D6).
  test('the detail pane names the same root the list chip does', () => {
    selectionState.selectedId = 'machine-skill';
    localSkillsMock = [
      {
        name: 'machine-skill',
        source: 'local',
        origin: 'user',
        installed: true,
        writable: true,
      },
    ];
    editableSkillMock = { name: 'machine-skill', body: 'do the thing' };

    renderEditor();

    expect(screen.queryByText('Workspace-authored skill')).toBeNull();
    expect(screen.getAllByText('This machine').length).toBeGreaterThan(0);
  });

  // The Skills editor owns the whole authoring surface: the command switch,
  // the body's variables, usage counters, and test/export.
  describe('command skills', () => {
    /**
     * The server states a writability decision for every row it serves
     * (#1655), so these fixtures state one. `writable: true` is the DEFAULT
     * here because this block's subject is the command surface, and a caller
     * that is about writability overrides it — the packaged-skill case below
     * does. The field itself is the subject of its own describe block, where
     * nothing is defaulted.
     */
    function selectSkill(skill: SkillFixture, detail?: SkillFixture) {
      selectionState.selectedId = skill.name;
      localSkillsMock = [{ writable: true, ...skill }];
      editableSkillMock = detail ?? skill;
    }

    test('offers export on a local skill', () => {
      selectSkill(
        { name: 'release-check', description: 'Ship it', source: 'local' },
        {
          name: 'release-check',
          description: 'Ship it',
          source: 'local',
          body: 'Check {{ticket}}',
        },
      );

      renderEditor();

      // #3045: the header shows two labelled actions; Export folds into the
      // menu and is not a button on the row.
      expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Export .md' })).toBeNull();
      fireEvent.click(
        screen.getByRole('button', { name: 'More skill actions' }),
      );
      expect(screen.getByRole('menuitem', { name: 'Export .md' })).toBeTruthy();
    });

    // Review M3: every action folded out of the header is still there, and
    // still does its job.
    test('the header menu holds Duplicate, Export and a destructive Remove, and each works', async () => {
      selectSkill(
        { name: 'release-check', description: 'Ship it', source: 'local' },
        {
          name: 'release-check',
          description: 'Ship it',
          source: 'local',
          body: 'Check {{ticket}}',
        },
      );
      // jsdom has no object URLs; these are the two calls a download makes.
      const createObjectURL = vi.fn(() => 'blob:skill');
      const { createObjectURL: realCreate, revokeObjectURL: realRevoke } = URL;
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = vi.fn();
      uninstallSkillMock.mockClear();
      createLocalSkillMock.mockClear();
      renderEditor();

      expect(overflowItems(openOverflow('More skill actions'))).toEqual([
        { name: 'Try draft in a new chat', danger: false },
        { name: 'Duplicate', danger: false },
        { name: 'Export .md', danger: false },
        { name: 'Remove', danger: true },
      ]);
      fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
      expect(uninstallSkillMock).toHaveBeenCalledWith(
        'release-check',
        expect.anything(),
      );

      chooseOverflow('More skill actions', 'Export .md');
      expect(createObjectURL).toHaveBeenCalledTimes(1);

      chooseOverflow('More skill actions', 'Duplicate');
      await waitFor(() =>
        expect(createLocalSkillMock).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'release-check-copy' }),
        ),
      );
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    });

    test('turns a skill into a command and writes both switches', async () => {
      selectSkill(
        { name: 'release-check', source: 'local' },
        { name: 'release-check', source: 'local', body: 'Ship {{ticket}}' },
      );

      renderEditor();
      fireEvent.click(
        screen.getByRole('switch', { name: 'Runnable as a slash command' }),
      );
      fireEvent.click(
        screen.getByRole('switch', { name: 'Offer to every agent' }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(updateLocalSkillMock).toHaveBeenCalled());
      expect(updateLocalSkillMock.mock.calls[0][0].command).toEqual({
        enabled: true,
        global: true,
      });
    });

    // #2708: the thrown message is field-qualified for CLI and agent readers
    // ("Validation failed: command …"); the editor shows the server's reason.
    // Driven through the REAL fetcher the update hook calls
    // (`updateLocalSkill`), answering the shared validation middleware's body,
    // so this proves the fetcher keeps `details` — not only that the view
    // reads them off an error built by hand.
    test('a refused save toasts the server reason, not the field key', async () => {
      const { StationHttpError, updateLocalSkill } = await import(
        '@kontourai/station-sdk/client'
      );
      let thrown: Promise<unknown> = Promise.resolve();
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error: 'Validation failed',
            details: {
              formErrors: [],
              fieldErrors: {
                command: [
                  'A command word is lowercase letters, digits and dashes.',
                ],
              },
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', fetchMock);
      updateLocalSkillMock.mockImplementationOnce(
        ({ name, ...updates }: { name: string }) => {
          const saved = updateLocalSkill('http://localhost', name, updates);
          thrown = saved.catch((caught: unknown) => caught);
          return saved;
        },
      );
      selectSkill(
        { name: 'release-check', source: 'local' },
        { name: 'release-check', source: 'local', body: 'Ship {{ticket}}' },
      );

      renderEditor();
      fireEvent.click(
        screen.getByRole('switch', { name: 'Runnable as a slash command' }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(showToastMock).toHaveBeenCalledWith(
          'A command word is lowercase letters, digits and dashes.',
        ),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost/api/skills/release-check',
        expect.objectContaining({ method: 'PUT' }),
      );
      // The same sentence would render from a plain Error carrying only the
      // reasons; what the fetcher now keeps is the status and the details.
      expect(await thrown).toBeInstanceOf(StationHttpError);
      expect(await thrown).toMatchObject({ status: 400 });
    });

    // Turning a command OFF has to be a WRITE. Omitting `command` from the
    // payload would leave the old declaration on disk and the skill would go on
    // answering to its word.
    test('sends command.enabled false when the switch is turned off', async () => {
      selectSkill(
        {
          name: 'release-check',
          source: 'local',
          command: { enabled: true, global: true },
        },
        {
          name: 'release-check',
          source: 'local',
          body: 'Ship it',
          command: { enabled: true, global: true },
        },
      );

      renderEditor();
      fireEvent.click(
        screen.getByRole('switch', { name: 'Runnable as a slash command' }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(updateLocalSkillMock).toHaveBeenCalled());
      expect(updateLocalSkillMock.mock.calls[0][0].command).toEqual({
        enabled: false,
      });
    });

    test('derives the variable chips from the body, not from declarations', () => {
      selectSkill(
        { name: 'release-check', source: 'local' },
        {
          name: 'release-check',
          source: 'local',
          body: 'Ship {{ticket}} now',
          command: { enabled: true },
          // `stale` is declared but the body no longer uses it: a field that
          // substitutes nothing must not be offered.
          variables: [
            { name: 'ticket', description: 'Jira key' },
            { name: 'stale', description: 'gone' },
          ],
        },
      );

      renderEditor();

      expect(screen.getByText('{{ticket}}')).toBeTruthy();
      expect(screen.queryByText('{{stale}}')).toBeNull();
      expect(screen.getByDisplayValue('Jira key')).toBeTruthy();
    });

    // An unreadable counter store is not an unused skill.
    test('says the counters are unavailable instead of claiming zero runs', () => {
      selectSkill(
        {
          name: 'release-check',
          source: 'local',
          statsUnavailable: 'usage file unreadable',
        },
        { name: 'release-check', source: 'local', body: 'Ship it' },
      );

      renderEditor();

      // Both the list row and the editor footer say it, and neither says "0".
      expect(screen.getAllByText('run count unavailable').length).toBe(2);
      expect(screen.queryByText(/0 runs/)).toBeNull();
    });

    test('shows the recorded run count when the store was read', () => {
      selectSkill(
        {
          name: 'release-check',
          source: 'local',
          stats: { runs: 3, successes: 3, failures: 0, qualityScore: 100 },
        },
        { name: 'release-check', source: 'local', body: 'Ship it' },
      );

      renderEditor();

      expect(screen.getAllByText('3 runs · 100% success').length).toBe(2);
    });

    // Slice 1 answers 409 for a command declared on a skill Station cannot
    // write. The editor says what would make it possible instead of offering a
    // switch that fails on save.
    test('offers read-only guidance instead of command authoring on a packaged skill', () => {
      selectSkill(
        {
          name: 'packaged-skill',
          source: 'package',
          writable: false,
          writeRefusal: {
            reason: 'canonical-package',
            detail: 'It is served from a package that ships read-only.',
            packageDirectory: '/pkgs/packaged-skill',
          },
        },
        { name: 'packaged-skill', source: 'package', body: 'Read only' },
      );

      renderEditor();

      expect(
        screen.getByText(/Install it into your workspace to author it here/),
      ).toBeTruthy();
      expect(
        screen.queryByRole('switch', { name: 'Runnable as a slash command' }),
      ).toBeNull();
    });

    // A declaration that is not in EFFECT (a clashing word) must say so rather
    // than read as enabled.
    test('renders the server command diagnostic', () => {
      selectSkill(
        {
          name: 'release-check',
          source: 'local',
          command: { enabled: false },
          commandDiagnostic: "'/ship' is already answered by 'other-skill'",
        },
        { name: 'release-check', source: 'local', body: 'Ship it' },
      );

      renderEditor();

      expect(
        screen.getByText("'/ship' is already answered by 'other-skill'"),
      ).toBeTruthy();
    });

    test('the commands filter narrows the list to command skills', () => {
      localSkillsMock = [
        { name: 'plain-skill', source: 'local', writable: true },
        {
          name: 'release-check',
          source: 'local',
          writable: true,
          command: { enabled: true },
        },
      ];

      render(<SkillsView filter="commands" />);

      expect(screen.getByText('release-check')).toBeTruthy();
      expect(screen.queryByText('plain-skill')).toBeNull();
      expect(screen.getByText('/release-check')).toBeTruthy();
    });

    // archive#4463 ("the
    // reviewer's misattribution "): the Commands tab is itself empty here
    // (no skill is a command), independent of any search. A typed query on
    // top of that must not read as "your search matched nothing" — the tab
    // is what's empty, not the query, so `collectionEmpty` is derived from
    // the CURRENT TAB's pre-query collection, not the whole (both-tabs)
    // skills list.
    test('a typed query on an empty Commands tab shows the tab-empty state, not FilteredEmpty', () => {
      localSkillsMock = [
        { name: 'plain-skill', source: 'local', writable: true },
      ];

      render(<SkillsView filter="commands" />);
      fireEvent.change(screen.getByPlaceholderText('Search skills...'), {
        target: { value: 'plain' },
      });

      expect(screen.getByText('No skills are commands yet')).toBeTruthy();
      expect(screen.queryByText(/Nothing in skills matches/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull();
    });

    // `selected` changes the moment skill B is clicked, but the
    // form used to keep skill A's body until B's DETAIL arrived — so Test and
    // Export could operate on A's body under B's header, and a failed B read
    // left the mismatch standing forever. While B's detail is pending the
    // pane waits (skeleton), A's body is gone, and every body-bound action is
    // disabled.
    test("selecting a second skill with its detail pending clears the first skill's body and disables the actions", () => {
      const skillA = { name: 'skill-a', source: 'local', writable: true };
      const skillB = { name: 'skill-b', source: 'local', writable: true };
      selectionState.selectedId = 'skill-a';
      localSkillsMock = [skillA, skillB];
      editableSkillMock = { name: 'skill-a', source: 'local', body: 'A body' };

      const { rerender } = renderEditor();
      expect(screen.getByDisplayValue('A body')).toBeTruthy();

      // Skill B selected; its detail read is in flight.
      selectionState.selectedId = 'skill-b';
      editableSkillMock = undefined;
      detailPendingMock = true;
      rerender(<SkillsView />);

      expect(
        screen.getByRole('status', { name: 'Loading skill' }),
      ).toBeTruthy();
      expect(screen.queryByDisplayValue('A body')).toBeNull();
      expect(
        (
          screen.getByRole('button', {
            name: 'Use in a new chat',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      fireEvent.click(
        screen.getByRole('button', { name: 'More skill actions' }),
      );
      expect(
        (
          screen.getByRole('menuitem', {
            name: 'Export .md',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(
        (screen.getByRole('menuitem', { name: 'Remove' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    });

    // Review failure half: a detail read that FAILS must render the
    // failure with a retry, not A's form under B's header indefinitely.
    test('a failed detail read renders the error with retry and keeps actions disabled', () => {
      selectionState.selectedId = 'skill-b';
      localSkillsMock = [
        { name: 'skill-a', source: 'local', writable: true },
        { name: 'skill-b', source: 'local', writable: true },
      ];
      editableSkillMock = undefined;
      detailErrorMock = new Error('detail read failed');

      renderEditor();

      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.getByText('Unable to load skill')).toBeTruthy();
      expect(screen.getByText('detail read failed')).toBeTruthy();
      expect(
        (
          screen.getByRole('button', {
            name: 'Use in a new chat',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);

      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(refetchDetailMock).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * #1655 — the editor offers Save from the SERVER's writability decision.
   *
   * Every fixture here is one where `writable` and the fields the view used to
   * derive editability from DISAGREE, because a fixture where they coincide
   * passes under both derivations and therefore proves nothing. The exact
   * payload shapes are the ones
   * `src-server/routes/agents/__tests__/skills.routes.writable.test.ts` asserts
   * the route emits, so the two halves of the seam are pinned against the same
   * bytes rather than against each other's imagination.
   */
  describe('the Save action follows the server writability decision', () => {
    /**
     * Fixtures are typed against the contract, so a `writeRefusal` must carry
     * the reason union and the required `packageDirectory`, and its `detail`
     * is the server's own sentence (`SKILL_REFUSAL_STATEMENT` and the
     * served-in-place / canonical-package branches in `skill-service.ts`).
     * The one deliberate exception is the whole-object cast in 'a refusal
     * without the package directory renders no path element'; the reason-only
     * casts below stand for a server that is a release ahead.
     */
    function selectRow(row: SkillFixture, detail?: SkillFixture) {
      selectionState.selectedId = row.name;
      localSkillsMock = [row];
      editableSkillMock = detail ?? { ...row, body: 'Body' };
    }

    /** A registry install in the workspace root: `source: 'registry'`, writable. */
    const REGISTRY_BUT_WRITABLE = {
      name: 'bought-in',
      description: 'From the registry',
      source: 'registry',
      origin: 'registry' as const,
      writable: true,
    };

    /**
     * A package in the plugins root whose own install record says
     * `source: 'local'`. Station does not write that root, so `PUT` answers 409.
     */
    const LOCAL_BUT_NOT_WRITABLE = {
      name: 'vendor-tool',
      description: 'From a plugin root',
      source: 'local',
      writable: false,
      writeRefusal: {
        reason: 'outside-writable-root' as const,
        // The shape the server actually emits: prose with no author-controlled
        // text, and the path in its own field. A fixture that inlined the path
        // would agree with a claim the server stopped making.
        detail:
          'Station does not write the directory this package resolves to.',
        packageDirectory: '/station/plugins/vendor/skills/vendor-tool',
      },
    };

    /** A plugin serves this one in place: no registry entry exists to install. */
    const SERVED_IN_PLACE = {
      name: 'vendor-prompt',
      source: 'plugin',
      writable: false,
      writeRefusal: {
        reason: 'served-in-place' as const,
        detail:
          'A plugin serves it in place, from a directory Station does not own.',
        packageDirectory: '/station/plugins/vendor',
      },
    };

    test("offers Save on a writable package the old derivation called read-only (source: 'registry')", () => {
      selectRow(REGISTRY_BUT_WRITABLE);

      renderEditor();

      expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
      // Editable fields follow the same decision, not just the button.
      expect(
        (
          screen.getByLabelText('Description', {
            selector: 'input',
          }) as HTMLInputElement
        ).disabled,
      ).toBe(false);
      expect(screen.queryByText(/^Read-only:/)).toBeNull();
    });

    test("withholds Save on a package the server refuses, even though source is 'local'", () => {
      selectRow(LOCAL_BUT_NOT_WRITABLE);

      renderEditor();

      // The whole defect: this used to render a Save the route answers 409 for.
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Edit skill' })).toBeNull();
      expect(
        screen.queryByLabelText('Description', { selector: 'input' }),
      ).toBeNull();
    });

    test("states the SERVER's reason rather than an explanation composed here", () => {
      selectRow(LOCAL_BUT_NOT_WRITABLE);

      renderEditor();

      // The server's own sentence, verbatim. Prose composed in the view would be
      // a second derivation of a decision the view does not make.
      expect(
        screen.getByText(
          new RegExp(
            LOCAL_BUT_NOT_WRITABLE.writeRefusal.detail.replace(
              /[.*+?^${}()|[\]\\]/g,
              '\\$&',
            ),
          ),
        ),
      ).toBeTruthy();
      // The remedy for THIS reason, chosen by the code rather than appended to
      // every reason alike.
      expect(
        screen.getByText(/Install it into your workspace to author it here\./),
      ).toBeTruthy();
      // And not the generic sentence that used to stand in for every refusal.
      expect(
        screen.queryByText(/Browse Registry to discover or install skills/),
      ).toBeNull();
    });

    test('a server that states no decision is read-only, not permissively writable', () => {
      // Fail-closed: `writable` absent is not a grant. The old derivation read
      // `source: 'local'` here and offered Save.
      selectRow({ name: 'undecided', source: 'local' });

      renderEditor();

      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
      // With no reason to state, the generic sentence is what is left — and it
      // is honest, because Station has not said why.
      expect(
        screen.getByText(/Browse Registry to discover or install skills/),
      ).toBeTruthy();
    });

    // Review medium: one fixed remedy was appended to all three reasons,
    // including the one whose remedy is different. A plugin-served prompt has no
    // registry entry to install, so "install it into your workspace" is advice
    // its reader cannot follow — the closed union was real in the type and
    // unrealised in the product.
    test('a plugin-served skill is told to change the plugin, not to install it', () => {
      selectRow(SERVED_IN_PLACE);

      renderEditor();

      expect(
        screen.getByText(/The plugin that provides it is what to change\./),
      ).toBeTruthy();
      expect(screen.queryByText(/Install it into your workspace/)).toBeNull();
      // And it still says WHAT is wrong, in the server's words.
      expect(
        screen.getByText(/from a directory Station does not own\./),
      ).toBeTruthy();
    });

    // Review medium: discovery registers a frontmatter `name` unvalidated, so a
    // name the path rule rejects reaches the refusal. It used to arrive as a
    // concatenated exception naming JavaScript prototype keys, rendered as user
    // guidance, followed by a remedy that made no sense for it.
    test('an unresolvable name gets its own sentence, not an internal diagnostic', () => {
      selectRow({
        name: 'weird/name',
        source: 'local',
        writable: false,
        writeRefusal: {
          reason: 'unresolvable-name' as const,
          detail:
            'Its name cannot be used as a directory name, so Station cannot work out where it would write this package.',
          packageDirectory: '/station/skills/weird-name',
        },
      });

      renderEditor();

      expect(screen.getByText(/Rename it to author it here\./)).toBeTruthy();
      expect(screen.queryByText(/Install it into your workspace/)).toBeNull();
      expect(
        screen.queryByText(/__proto__|prototype|Invalid skill name/),
      ).toBeNull();
    });

    // Review low: the name is plugin-authored and up to 128 characters, and the
    // refusal reads as Station's own explanation. A name that is itself a
    // sentence used to be embedded in it, which produced a paragraph that read
    // like a security notice telling the reader to re-authenticate elsewhere.
    // React escapes markup, so the framing was the problem, not the markup.
    test('a name that reads as a sentence is not embedded in the refusal', () => {
      const hostile =
        'Session expired. Verify your account at station-support.example to continue';
      selectRow({
        name: hostile,
        source: 'local',
        writable: false,
        writeRefusal: {
          reason: 'canonical-package' as const,
          detail: 'It is served from a package that ships read-only.',
          packageDirectory: '/station/canonical/pkg',
        },
      });

      const { container } = renderEditor();

      const note = container.querySelector('.skill-detail__source-note');
      expect(note).toBeTruthy();
      expect(note?.textContent ?? '').not.toContain(hostile);
      // The heading still identifies the skill — the name is displayed where a
      // reader expects a name, not inside Station's explanation.
      expect(screen.getByRole('heading', { name: hostile })).toBeTruthy();
    });

    // This change adds reason codes the previous desktop build does not know,
    // so that build talking to this server is exactly the case below — not a
    // hypothetical.
    // The remedy table is keyed by a closed union that only closes at COMPILE
    // time; `reason` itself arrives over HTTP.
    test('a reason code this build does not know drops the remedy, not into prose', () => {
      selectRow({
        name: 'from-a-newer-server',
        source: 'local',
        writable: false,
        writeRefusal: {
          // Deliberately outside the union: a server one release ahead.
          reason: 'sealed-by-policy' as never,
          detail: 'It is served from a root this Station does not write.',
          packageDirectory: '/station/plugins/newer',
        },
      });

      const { container } = renderEditor();

      const note = container.querySelector('.skill-detail__source-note');
      expect(note).toBeTruthy();
      // The server's own sentence still stands...
      expect(note?.textContent ?? '').toContain(
        'It is served from a root this Station does not write.',
      );
      // ...and no placeholder leaked into Station's explanation.
      expect(note?.textContent ?? '').not.toContain('undefined');
      // Save stays withheld: an unknown reason is still a refusal.
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    });

    // Review low: `detail` used to carry the package path, and a plugin names
    // its own directories — so the mitigation for a hostile NAME did nothing
    // about a hostile DIRECTORY. The path now renders as a path.
    test('the package path renders as its own labelled element, not as prose', () => {
      const hostileDirectory =
        '/plugins/Session expired — verify your account at station-support.example/skills/notes';
      selectRow({
        name: 'notes',
        source: 'local',
        writable: false,
        writeRefusal: {
          reason: 'outside-writable-root' as const,
          detail:
            'Station does not write the directory this package resolves to.',
          packageDirectory: hostileDirectory,
        },
      });

      const { container } = renderEditor();

      // Station's sentence contains none of the author's text...
      const note = container.querySelector('.skill-detail__source-note');
      expect(note?.textContent ?? '').not.toContain('station-support.example');
      // ...and the path is present, in its own element, labelled as a path.
      const path = container.querySelector('.skill-detail__source-path');
      expect(path).toBeTruthy();
      expect(path?.querySelector('code')?.textContent).toBe(hostileDirectory);
      expect(path?.textContent ?? '').toContain('Package directory');
    });

    // `packageDirectory` is REQUIRED in the contract, so this shape is one no
    // conforming server emits — an older build, or a proxy that dropped it. The
    // view must still render the refusal it has and no empty path furniture,
    // rather than an element wrapped round a blank code block. Cast, because the
    // type correctly forbids what this test constructs on purpose.
    test('a refusal without the package directory renders no path element', () => {
      selectRow({
        name: 'weird/name',
        source: 'local',
        writable: false,
        writeRefusal: {
          reason: 'unresolvable-name',
          detail:
            'Its name cannot be used as a directory name, so Station cannot work out where it would write this package.',
        } as never,
      });

      const { container } = renderEditor();

      expect(container.querySelector('.skill-detail__source-path')).toBeNull();
      expect(screen.getByText(/Rename it to author it here\./)).toBeTruthy();
    });

    // And the case the server DOES emit: the rename remedy with the path it
    // needs to be actionable at all.
    test('an unresolvable name still shows which package to rename', () => {
      selectRow({
        name: 'weird/name',
        source: 'local',
        writable: false,
        writeRefusal: {
          reason: 'unresolvable-name' as const,
          detail:
            'Its name cannot be used as a directory name, so Station cannot work out where it would write this package.',
          packageDirectory: '/station/skills/bought-in',
        },
      });

      const { container } = renderEditor();

      expect(screen.getByText(/Rename it to author it here\./)).toBeTruthy();
      expect(
        container.querySelector('.skill-detail__source-path code')?.textContent,
      ).toBe('/station/skills/bought-in');
    });

    // Review low, same class as the `undefined` above: the remedy table is a
    // plain object literal, so a reason code naming an INHERITED key used to
    // render JavaScript source into Station's own explanation.
    test.each([
      ['constructor', /function Object|\[native code\]/],
      ['toString', /function toString|\[native code\]/],
      ['hasOwnProperty', /function hasOwnProperty|\[native code\]/],
      ['__proto__', /\[object Object\]/],
    ])('an inherited key (%s) renders no JavaScript', (reason, sourceShape) => {
      selectRow({
        name: 'from-a-newer-server',
        source: 'local',
        writable: false,
        writeRefusal: {
          reason: reason as never,
          detail: 'It is served from a root this Station does not write.',
          packageDirectory: '/station/plugins/newer',
        },
      });

      const { container } = renderEditor();

      const text =
        container.querySelector('.skill-detail__source-note')?.textContent ??
        '';
      expect(text).toContain(
        'It is served from a root this Station does not write.',
      );
      expect(text).not.toMatch(sourceShape);
      expect(text).not.toContain('undefined');
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    });

    // The fifth reason code, added when the rule landed: the package is plainly
    // the user's own and sits in a root Station writes, so the remedy is a
    // rename of one side or the other — never "install it".
    test('a directory-name mismatch is told to make the two names match', () => {
      selectRow({
        name: 'Bought-In',
        source: 'local',
        writable: false,
        writeRefusal: {
          reason: 'directory-name-mismatch' as const,
          detail:
            "The package discovery found for it sits in a directory whose name is not this skill's name.",
          packageDirectory: '/station/skills/bought-in',
        },
      });

      const { container } = renderEditor();

      expect(
        screen.getByText(/Rename the directory, or the skill's own name/),
      ).toBeTruthy();
      expect(screen.queryByText(/Install it into your workspace/)).toBeNull();
      // Not "Station does not own this": it plainly does. The view's own
      // "Read-only." opener is its framing of every refusal and is correct here
      // — the package cannot be saved as things stand — so only the ownership
      // claim is excluded, not the whole phrase.
      const note = container.querySelector('.skill-detail__source-note');
      expect(note?.textContent ?? '').not.toMatch(
        /does not own|ships read-only/i,
      );
      expect(
        container.querySelector('.skill-detail__source-path code')?.textContent,
      ).toBe('/station/skills/bought-in');
    });

    // Review H1: this used to be published as `outside-writable-root`, which
    // told the reader the package sat somewhere Station does not write and to
    // install it into their workspace. Both false for a broken path inside a
    // root Station DOES write — installing repairs no link.
    test('an unreadable path is not told to install itself into the workspace', () => {
      selectRow({
        name: 'ghost',
        source: 'local',
        writable: false,
        writeRefusal: {
          reason: 'containment-unreadable' as const,
          detail:
            'Where a write to it would land could not be determined, so Station will not write it.',
          packageDirectory: '/station/skills/ghost',
        },
      });

      const { container } = renderEditor();

      expect(screen.getByText(/Check the path it sits at/)).toBeTruthy();
      expect(screen.queryByText(/Install it into your workspace/)).toBeNull();
      const note = container.querySelector('.skill-detail__source-note');
      expect(note?.textContent ?? '').not.toMatch(/skills root|does not own/);
    });

    test('Create is still offered while authoring a new skill', () => {
      // `isCreating` short-circuits the decision on purpose: nothing is
      // discovered under a name that does not exist yet, so there is no package
      // to refuse.
      selectionState.selectedId = 'new';
      localSkillsMock = [LOCAL_BUT_NOT_WRITABLE];

      renderEditor();

      expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy();
    });
  });
});

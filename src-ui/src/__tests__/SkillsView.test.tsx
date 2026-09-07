/**
 * @vitest-environment jsdom
 */

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
let registrySkillsMock: any[] = [];
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
const sendMessageMock = vi.fn().mockResolvedValue(undefined);
const createChatSessionMock = vi.fn().mockReturnValue('session-1');
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
  useRegistrySkillsQuery: () => ({
    data: registrySkillsMock,
    isLoading: false,
  }),
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
  useUninstallSkillMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useUpdateLocalSkillMutation: () => ({
    isPending: false,
    mutateAsync: updateLocalSkillMock,
  }),
  useUpdateSkillMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));

const navigateMock = vi.fn();
const showToastMock = vi.fn();

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    navigate: navigateMock,
    setDockState: setDockStateMock,
    setActiveChat: setActiveChatMock,
  }),
}));

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [{ slug: 'station', name: 'Station', skills: [] }],
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost' }),
}));

vi.mock('../hooks/useActiveChatSessions', () => ({
  useCreateChatSession: () => createChatSessionMock,
  useSendMessage: () => sendMessageMock,
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

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
});

afterEach(() => {
  selectionState.selectedId = null;
  selectionState.select.mockReset();
  selectionState.deselect.mockReset();
  navigateMock.mockReset();
  showToastMock.mockReset();
  localSkillsMock = [];
  localSkillsPendingMock = false;
  localSkillsErrorMock = null;
  refetchSkillsMock.mockReset();
  registrySkillsMock = [];
  editableSkillMock = undefined;
  detailPendingMock = false;
  detailErrorMock = null;
  refetchDetailMock.mockReset();
  createLocalSkillMock.mockClear();
  updateLocalSkillMock.mockClear();
  importSkillsMock.mockClear();
  runSkillMock.mockClear();
  sendMessageMock.mockClear();
  createChatSessionMock.mockClear();
  setDockStateMock.mockClear();
  setActiveChatMock.mockClear();
});

describe('SkillsView', () => {
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

    render(<SkillsView />);

    expect(screen.getByLabelText('Loading list')).toBeTruthy();
    expect(screen.queryByText('No installed skills yet')).toBeNull();
  });

  test('shows the empty state once the skills read settles empty', () => {
    localSkillsPendingMock = false;
    localSkillsMock = [];

    render(<SkillsView />);

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

    render(<SkillsView />);

    expect(screen.queryByText('No installed skills yet')).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Unable to load skills')).toBeTruthy();
    expect(screen.getByText('skills read failed')).toBeTruthy();
  });

  test('retries the skills read from the failure state', () => {
    localSkillsErrorMock = new Error('skills read failed');

    render(<SkillsView />);
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
    render(<SkillsView />);

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
  });

  test('renders an import rejection in the dialog', async () => {
    importSkillsMock.mockRejectedValueOnce(
      new Error('Import route unavailable'),
    );
    render(<SkillsView />);

    fireEvent.click(screen.getByRole('button', { name: 'Import .md' }));
    chooseImportFile('release-check.md', '# Release check');
    await screen.findByText('1 file to import');
    fireEvent.click(screen.getByRole('button', { name: 'Import 1' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Import route unavailable',
    );
  });

  test('renders the create form when the URL selection is /skills/new', () => {
    selectionState.selectedId = 'new';

    render(<SkillsView />);

    expect(screen.getByText('New Skill')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy();
    expect(screen.queryByText('No skill selected')).toBeNull();
  });

  test('opens the create form when the add button is clicked', () => {
    render(<SkillsView />);

    fireEvent.click(screen.getByRole('button', { name: 'New skill' }));

    expect(selectionState.select).toHaveBeenCalledWith('new');
    expect(screen.getByText('New Skill')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy();
  });

  test('lists only installed local skills on /skills', () => {
    localSkillsMock = [
      {
        name: 'installed-skill',
        description: 'Installed locally',
        version: '1.0.0',
        source: 'local',
        writable: true,
      },
    ];
    registrySkillsMock = [
      {
        id: 'registry-only-skill',
        displayName: 'Registry Only Skill',
        description: 'Should not appear on /skills',
        version: '9.9.9',
      },
    ];

    render(<SkillsView />);

    expect(screen.getByText('installed-skill')).toBeTruthy();
    expect(screen.queryByText('Registry Only Skill')).toBeNull();
  });

  test('keeps the Registry Skills link in the skills body', () => {
    render(<SkillsView />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Browse Registry Skills' }),
    );
    expect(navigateMock).toHaveBeenCalledWith('/registry/skills');
  });

  test('defines a Skill without a redundant cross-link action', () => {
    render(<SkillsView />);

    expect(
      screen.getByText(
        'Every skill Station loaded, grouped by where it came from. Author your own here; install more from Registry.',
      ),
    ).toBeTruthy();

    expect(screen.queryByRole('button', { name: 'Open Playbooks' })).toBeNull();
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

    const { container } = render(<SkillsView />);

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

    render(<SkillsView />);

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
    function selectSkill(skill: any, detail?: any) {
      selectionState.selectedId = skill.name;
      localSkillsMock = [{ writable: true, ...skill }];
      editableSkillMock = detail ?? skill;
    }

    test('offers export and test, and no conversion action', () => {
      selectSkill(
        { name: 'release-check', description: 'Ship it', source: 'local' },
        {
          name: 'release-check',
          description: 'Ship it',
          source: 'local',
          body: 'Check {{ticket}}',
        },
      );

      render(<SkillsView />);

      expect(screen.getByRole('button', { name: 'Export .md' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '▶ Test' })).toBeTruthy();
    });

    test('turns a skill into a command and writes both switches', async () => {
      selectSkill(
        { name: 'release-check', source: 'local' },
        { name: 'release-check', source: 'local', body: 'Ship {{ticket}}' },
      );

      render(<SkillsView />);
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

      render(<SkillsView />);
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

      render(<SkillsView />);

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

      render(<SkillsView />);

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

      render(<SkillsView />);

      expect(screen.getAllByText('3 runs · 100% success').length).toBe(2);
    });

    // Slice 1 answers 409 for a command declared on a skill Station cannot
    // write. The editor says what would make it possible instead of offering a
    // switch that fails on save.
    test('offers the install action, not a switch, on a read-only skill', () => {
      selectSkill(
        {
          name: 'packaged-skill',
          source: 'package',
          writable: false,
          writeRefusal: {
            reason: 'canonical-package',
            detail:
              "'packaged-skill' is served from the package at /pkgs/packaged-skill, which ships read-only",
          },
        },
        { name: 'packaged-skill', source: 'package', body: 'Read only' },
      );

      render(<SkillsView />);

      expect(
        screen.getByText('Install to workspace to make this a command'),
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

      render(<SkillsView />);

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

    test('a test run opens a dock session and counts the run', async () => {
      selectSkill(
        { name: 'release-check', source: 'local' },
        { name: 'release-check', source: 'local', body: 'Ship it' },
      );

      render(<SkillsView />);
      fireEvent.click(screen.getByRole('button', { name: '▶ Test' }));
      fireEvent.click(screen.getByRole('button', { name: '▶ Send to Agent' }));

      await waitFor(() =>
        expect(runSkillMock).toHaveBeenCalledWith('release-check'),
      );
      expect(createChatSessionMock).toHaveBeenCalled();
      expect(setDockStateMock).toHaveBeenCalledWith(true);
      expect(sendMessageMock).toHaveBeenCalledWith(
        'session-1',
        'station',
        undefined,
        'Ship it',
      );
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

      const { rerender } = render(<SkillsView />);
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
        (screen.getByRole('button', { name: '▶ Test' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(
        (
          screen.getByRole('button', {
            name: 'Export .md',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(
        (screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(
        (screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
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

      render(<SkillsView />);

      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.getByText('Unable to load skill')).toBeTruthy();
      expect(screen.getByText('detail read failed')).toBeTruthy();
      expect(
        (screen.getByRole('button', { name: '▶ Test' }) as HTMLButtonElement)
          .disabled,
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
     * RESIDUAL, not a style choice: `any` on both parameters means no fixture
     * in this file is typechecked against `SkillListing` or
     * `SkillWriteRefusal`. That is the mechanism that let two fixtures keep
     * pre-reword prose while a comment above them claimed they were what the
     * server emits (round 8 fixed the instances; this names the class).
     *
     * It has a second live consequence: `packageDirectory` is REQUIRED on
     * `SkillWriteRefusal` — deliberately de-optionalised, see its docblock in
     * `catalog.ts` — and 4 of the 11 `writeRefusal` fixtures here omit it, so
     * they encode a shape no server can produce. Typing these parameters is the
     * fix; it is a separate change because it will red every fixture at once.
     */
    function selectRow(row: any, detail?: any) {
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

      render(<SkillsView />);

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

      render(<SkillsView />);

      // The whole defect: this used to render a Save the route answers 409 for.
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
      expect(
        (
          screen.getByLabelText('Description', {
            selector: 'input',
          }) as HTMLInputElement
        ).disabled,
      ).toBe(true);
    });

    test("states the SERVER's reason rather than an explanation composed here", () => {
      selectRow(LOCAL_BUT_NOT_WRITABLE);

      render(<SkillsView />);

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

      render(<SkillsView />);

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

      render(<SkillsView />);

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
            'Its name cannot be used as a directory name, so Station cannot locate a package of its own to write.',
        },
      });

      render(<SkillsView />);

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

      const { container } = render(<SkillsView />);

      const note = container.querySelector('.skill-detail__source-note');
      expect(note).toBeTruthy();
      expect(note?.textContent ?? '').not.toContain(hostile);
      // The heading still identifies the skill — the name is displayed where a
      // reader expects a name, not inside Station's explanation.
      expect(screen.getAllByDisplayValue(hostile).length).toBeGreaterThan(0);
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
        },
      });

      const { container } = render(<SkillsView />);

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

      const { container } = render(<SkillsView />);

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

      const { container } = render(<SkillsView />);

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

      const { container } = render(<SkillsView />);

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
        },
      });

      const { container } = render(<SkillsView />);

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

      const { container } = render(<SkillsView />);

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

      const { container } = render(<SkillsView />);

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

      render(<SkillsView />);

      expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy();
    });
  });
});

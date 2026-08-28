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
        'Author workspace skills here; discover and install new skills in Registry.',
      ),
    ).toBeTruthy();

    expect(screen.queryByRole('button', { name: 'Open Playbooks' })).toBeNull();
  });

  // The Skills editor owns the whole authoring surface: the command switch,
  // the body's variables, usage counters, and test/export.
  describe('command skills', () => {
    function selectSkill(skill: any, detail?: any) {
      selectionState.selectedId = skill.name;
      localSkillsMock = [skill];
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
        { name: 'packaged-skill', source: 'package' },
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
        { name: 'plain-skill', source: 'local' },
        { name: 'release-check', source: 'local', command: { enabled: true } },
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
      localSkillsMock = [{ name: 'plain-skill', source: 'local' }];

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
      const skillA = { name: 'skill-a', source: 'local' };
      const skillB = { name: 'skill-b', source: 'local' };
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
        { name: 'skill-a', source: 'local' },
        { name: 'skill-b', source: 'local' },
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
});

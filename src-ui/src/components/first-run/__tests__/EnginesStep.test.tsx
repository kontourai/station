/**
 * @vitest-environment jsdom
 *
 * The engines chapter as the user meets it: what the checklist shows, what a
 * confirm creates (and does not create), and what happens when a create warns
 * or fails.
 */

import type {
  DevicePresentation,
  ExternalEngineReadinessProjection,
} from '@kontourai/station-contracts/system-status';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentData } from '../../../contexts/AgentsContext';

const materializeEngineAgent = vi.fn();
const agentsState: {
  agents: AgentData[];
  loaded: boolean;
  settled: boolean;
} = { agents: [], loaded: true, settled: true };
const statusState: {
  data:
    | {
        externalEngines?: ExternalEngineReadinessProjection[];
        devicePresentation?: DevicePresentation;
      }
    | undefined;
  isLoading: boolean;
} = { data: { externalEngines: [] }, isLoading: false };
/** archive#3843: which machine is reading the chapter. */
let devicePresentation: DevicePresentation | undefined;

vi.mock('../../../contexts/AgentsContext', () => ({
  useAgents: () => agentsState.agents,
  useAgentsLoaded: () => agentsState.loaded,
  useAgentsSettled: () => agentsState.settled,
}));
vi.mock('@kontourai/station-sdk', () => ({
  useMaterializeEngineAgentMutation: () => ({
    mutateAsync: materializeEngineAgent,
  }),
}));
vi.mock('../../../hooks/useDevicePresentation', () => ({
  useDevicePresentation: () => devicePresentation,
}));
vi.mock('../../../hooks/useSystemStatus', () => ({
  useSystemStatus: () => statusState,
}));

import {
  FirstRunEnginesChapter,
  useFirstRunEngineOptions,
} from '../EnginesStep';
import { buildFirstRunEngineOptions } from '../first-run-engines';

function engine(
  overrides: Partial<ExternalEngineReadinessProjection> & { name: string },
): ExternalEngineReadinessProjection {
  return {
    engineId: overrides.name.toLowerCase(),
    detected: false,
    ready: false,
    source: null,
    ...overrides,
  } as ExternalEngineReadinessProjection;
}

const CODEX = engine({
  name: 'Codex',
  engineId: 'codex' as never,
  engineConnectionId: 'codex' as never,
  detected: true,
  ready: true,
});
const CLAUDE = engine({
  name: 'Claude Code',
  engineId: 'claude-code' as never,
  engineConnectionId: 'claude' as never,
  detected: true,
  ready: true,
});
const KIRO = engine({
  name: 'Kiro',
  engineId: 'kiro' as never,
  engineConnectionId: 'kiro' as never,
  detected: true,
  reason: 'sign_in_required',
});
const OPENCODE = engine({
  name: 'OpenCode',
  engineId: 'opencode' as never,
  engineConnectionId: 'opencode' as never,
  reason: 'missing_prerequisites',
});

function renderChapter(
  engines: ExternalEngineReadinessProjection[],
  agents: AgentData[] = [],
) {
  const onDone = vi.fn();
  const onDefer = vi.fn();
  const onGiveUp = vi.fn();
  const view = render(
    <FirstRunEnginesChapter
      options={buildFirstRunEngineOptions({ engines, agents })}
      onDone={onDone}
      onDefer={onDefer}
      onGiveUp={onGiveUp}
    />,
  );
  /** Re-render with a fresh catalog answer, as a `['agents']` refetch does. */
  const update = (
    nextEngines: ExternalEngineReadinessProjection[],
    nextAgents: AgentData[] = [],
  ) =>
    view.rerender(
      <FirstRunEnginesChapter
        options={buildFirstRunEngineOptions({
          engines: nextEngines,
          agents: nextAgents,
        })}
        onDone={onDone}
        onDefer={onDefer}
        onGiveUp={onGiveUp}
      />,
    );
  return { onDone, onDefer, onGiveUp, update };
}

/**
 * The row's checkbox, or `null` when the row has none. Only a row Station can
 * genuinely act on mounts one — a locked row renders its state and its reason
 * as text, never as a disabled control that keyboard users cannot reach.
 */
function checkbox(engineId: string): HTMLInputElement | null {
  return screen
    .getByTestId(`first-run-engine-${engineId}`)
    .querySelector('input');
}

function row(engineId: string): HTMLElement {
  return screen.getByTestId(`first-run-engine-${engineId}`);
}

beforeEach(() => {
  materializeEngineAgent
    .mockReset()
    .mockImplementation(async (engineId: string) => ({
      data: { slug: engineId, name: engineId },
      created: true,
    }));
  agentsState.agents = [];
  agentsState.loaded = true;
  agentsState.settled = true;
  statusState.data = { externalEngines: [] };
  statusState.isLoading = false;
  devicePresentation = undefined;
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('the checklist', () => {
  test('lists the detected engines and pre-ticks the ready ones', () => {
    renderChapter([CODEX, KIRO]);
    expect(checkbox('codex')?.checked).toBe(true);
    expect(row('codex').textContent).toContain('Enable Codex');
    // A row Station cannot act on is a STATE and a REASON, never a control.
    expect(checkbox('kiro')).toBeNull();
    expect(row('kiro').textContent).toContain('Kiro');
    expect(screen.getByText('Sign in to Kiro to use it here.')).toBeTruthy();
  });

  test('shows an already-enabled engine as done, not as new work', () => {
    renderChapter(
      [CODEX],
      [
        {
          slug: 'codex-agent',
          name: 'Codex Agent',
          execution: { agentConnectionId: 'codex' },
        } as AgentData,
      ],
    );
    // The copy states the state (: the old card rendered "Already set
    // up as X" beside an unticked box and a "Set up 2" button).
    expect(row('codex').textContent).toContain('Ready — Codex');
    expect(checkbox('codex')).toBeNull();
    expect(screen.getByText(/Already set up as/)).toBeTruthy();
  });

  test('a locked row keeps its reason in the document, not behind a disabled control', () => {
    // The note IS the reason the row is locked. Rendering that row as a
    // `disabled` checkbox would drop it out of the tab order and out of a
    // keyboard user's reach; rendering it as text keeps it readable and makes
    // the refusal structural rather than an attribute.
    renderChapter([KIRO]);
    expect(checkbox('kiro')).toBeNull();
    expect(screen.getByText('Sign in to Kiro to use it here.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });

  test('a tickable row is a plain, editable checkbox', () => {
    // Playwright's check/uncheck actionability treats a readOnly or disabled
    // input as not editable, so a tickable row that carried either would be
    // untickable from the browser suite while every jsdom test still passed —
    // and that bucket does not run per-PR.
    renderChapter([CODEX, KIRO]);
    const tickable = checkbox('codex') as HTMLInputElement;
    expect(tickable.readOnly).toBe(false);
    expect(tickable.disabled).toBe(false);
  });

  test('an already-enabled engine cannot be turned into a create', () => {
    const { onDone } = renderChapter(
      [CODEX],
      [
        {
          slug: 'codex-agent',
          name: 'Codex Agent',
          execution: { agentConnectionId: 'codex' },
        } as AgentData,
      ],
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(materializeEngineAgent).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test('keeps undetected engines out of the main list', () => {
    renderChapter([CODEX, OPENCODE]);
    expect(screen.getByText('Station also works with')).toBeTruthy();
    // Present as information, but with no control at all — an unchecked box
    // for something the user cannot install from here would be a dead action.
    expect(
      screen.getByTestId('first-run-engine-opencode').querySelector('input'),
    ).toBeNull();
  });

  test('says nothing about other engines when there are none', () => {
    renderChapter([CODEX]);
    expect(screen.queryByText('Station also works with')).toBeNull();
  });
});

/**
 * archive#3843 — the scan runs on the machine Station is installed on. Every
 * sentence the chapter writes about where it looked is therefore a sentence
 * about the HOST, and "this machine" is only true for someone sitting at it.
 */
describe('on a paired device the chapter names the host it scanned', () => {
  const PAIRED: DevicePresentation = {
    deviceClass: 'paired',
    hostName: 'workshop',
  };

  function renderPaired(engines: ExternalEngineReadinessProjection[]) {
    devicePresentation = PAIRED;
    return render(
      <FirstRunEnginesChapter
        options={buildFirstRunEngineOptions({
          engines,
          agents: [],
          devicePresentation: PAIRED,
        })}
        onDone={vi.fn()}
        onDefer={vi.fn()}
        onGiveUp={vi.fn()}
      />,
    );
  }

  test('the lede names the computer Station runs on, not "this machine"', () => {
    renderPaired([CODEX]);
    expect(
      screen.getByText(
        'Station found these on workshop, the computer it runs on. Pick the ones you use and Station sets up an agent for each — you can change them later.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/found these on this machine/)).toBeNull();
  });

  test('the still-scanning line names the host', () => {
    devicePresentation = PAIRED;
    render(
      <FirstRunEnginesChapter
        options={[]}
        loading
        onDone={vi.fn()}
        onDefer={vi.fn()}
        onGiveUp={vi.fn()}
      />,
    );
    expect(screen.getByTestId('first-run-engines-loading').textContent).toBe(
      'Looking for agent CLIs on workshop…',
    );
  });

  test('an engine the scan did not find says where it would have to be installed', () => {
    renderPaired([CODEX, OPENCODE]);
    expect(row('opencode').textContent).toContain(
      'Not found on workshop. Agent CLIs run on that computer, so it has to be installed there.',
    );
    expect(row('opencode').textContent).not.toContain('this machine');
  });

  test('on the host the same rows keep their original wording', () => {
    renderChapter([CODEX, OPENCODE]);
    expect(
      screen.getByText(/Station found these on this machine\./),
    ).toBeTruthy();
    expect(row('opencode').textContent).toContain('Not found on this machine.');
    expect(screen.queryByText(/workshop/)).toBeNull();
  });
});

describe('confirming the checklist', () => {
  test('creates exactly one Agent per newly ticked engine', async () => {
    const { onDone } = renderChapter([CODEX, CLAUDE]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up 2' }));
    });
    expect(materializeEngineAgent).toHaveBeenCalledTimes(2);
    // Only the engine binding crosses the wire. The chapter used to send a
    // name it invented, and that name became a SECOND row per engine.
    expect(materializeEngineAgent).toHaveBeenNthCalledWith(1, 'codex');
    expect(materializeEngineAgent).toHaveBeenNthCalledWith(2, 'claude');
    // A clean batch has nothing to read, so it advances the run itself.
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('first-run-engines-report')).toBeNull();
  });

  test('creates nothing for an engine that already has an Agent', async () => {
    // The row is ticked — that is what "already enabled" looks like — so this
    // is the second-run duplicate the chapter must never produce.
    const { onDone } = renderChapter(
      [CODEX],
      [
        {
          slug: 'codex-agent',
          name: 'Codex Agent',
          execution: { agentConnectionId: 'codex' },
        } as AgentData,
      ],
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    });
    expect(materializeEngineAgent).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test('respects a box the user unticks', async () => {
    renderChapter([CODEX, CLAUDE]);
    fireEvent.click(checkbox('claude-code') as HTMLInputElement);
    expect(checkbox('claude-code')?.checked).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up 1' }));
    });
    expect(materializeEngineAgent).toHaveBeenCalledTimes(1);
    expect(materializeEngineAgent).toHaveBeenCalledWith('codex');
  });

  test('"Not now" materialises nothing and defers the whole chapter', () => {
    // Distinct from `onDone`: this is the decision the chapter WRITES DOWN, so
    // it is never confused with "the engine step finished". It replaces the
    // "Skip" that dismissed the old notice-layer card and completed the run.
    const { onDone, onDefer } = renderChapter([CODEX]);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(materializeEngineAgent).not.toHaveBeenCalled();
    expect(onDefer).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  test('a second activation cannot double-create', async () => {
    // The confirm is `aria-disabled` while the batch runs, not `disabled`, so
    // it is genuinely still clickable — the refusal is the handler's, not the
    // browser's.
    let release: (value: unknown) => void = () => {};
    materializeEngineAgent.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    renderChapter([CODEX]);
    const confirm = screen.getByRole('button', { name: 'Set up 1' });
    fireEvent.click(confirm);
    const running = screen.getByRole('button', { name: 'Setting up…' });
    expect((running as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(running);
    expect(materializeEngineAgent).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({ data: {}, created: true });
    });
  });
});

describe('the batch is legible while it runs and when it lands', () => {
  function startSlowBatch() {
    let release: (value: unknown) => void = () => {};
    materializeEngineAgent.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    const view = renderChapter([CODEX, CLAUDE]);
    fireEvent.click(screen.getByRole('button', { name: 'Set up 2' }));
    return { ...view, release: () => release({ data: {}, created: true }) };
  }

  test('the live region exists before there is anything to say', () => {
    // A `role="status"` inserted with its content already in it is not
    // reliably announced; this one is in the DOM from first render and only
    // its text changes.
    renderChapter([CODEX]);
    const status = screen.getByTestId('first-run-engines-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe('');
  });

  test('progress is announced, not only painted on a dead button', async () => {
    const { release } = startSlowBatch();
    expect(screen.getByTestId('first-run-engines-status').textContent).toBe(
      'Setting up 2 agents…',
    );
    const confirm = screen.getByRole('button', { name: 'Setting up…' });
    expect(confirm.getAttribute('aria-busy')).toBe('true');
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      release();
    });
  });

  test('the announced count is the BATCH, not a catalog that moves under it (delta review MEDIUM-B)', async () => {
    // Each create invalidates ['agents']; each refetch that lands flips a
    // finished row to `enabled` (`selectable: false`). Deriving the count from
    // the current options therefore shrank it mid-batch — and in a live region
    // that RE-ANNOUNCES: "Setting up 2 agents…", then "Setting up 1 agent…",
    // while two were running the whole time.
    const { release, update } = startSlowBatch();
    expect(screen.getByTestId('first-run-engines-status').textContent).toBe(
      'Setting up 2 agents…',
    );

    // The first create lands and its row goes from available to enabled.
    update(
      [CODEX, CLAUDE],
      [
        {
          slug: 'codex-agent',
          name: 'Codex Agent',
          execution: { agentConnectionId: 'codex' },
        } as AgentData,
      ],
    );

    expect(screen.getByTestId('first-run-engines-status').textContent).toBe(
      'Setting up 2 agents…',
    );
    await act(async () => {
      release();
    });
  });

  test('the user can still leave while the batch runs', async () => {
    // Focus must not fall to <body> mid-batch, and a chapter that traps
    // someone in a running batch would be blocking Home.
    const { release, onDefer } = startSlowBatch();
    const defer = screen.getByRole('button', { name: 'Not now' });
    expect((defer as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(defer);
    expect(onDefer).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
    });
  });

  test('the report takes focus and carries its own summary', async () => {
    materializeEngineAgent.mockRejectedValue(new Error('offline'));
    renderChapter([CODEX]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up 1' }));
    });
    const report = await screen.findByTestId('first-run-engines-report');
    expect(document.activeElement).toBe(report);
    expect(report.getAttribute('aria-label')).toBe('What Station set up');
    expect(screen.getByTestId('first-run-engines-status').textContent).toBe(
      '1 could not be set up.',
    );
  });

  test('each outcome carries its severity as data, not only as wording', async () => {
    // The colour rule keys off this attribute (`EnginesStep.css`), so the
    // three kinds cannot all render as the same muted grey again.
    materializeEngineAgent
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        data: { slug: 'claude', name: 'Claude Code' },
        created: true,
        warnings: ['not launchable'],
      });
    renderChapter([CODEX, CLAUDE]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up 2' }));
    });
    const items = screen
      .getByTestId('first-run-engines-report')
      .querySelectorAll('.first-run-engines__report-item');
    expect([...items].map((item) => item.getAttribute('data-status'))).toEqual([
      'failed',
      'warned',
    ]);
  });
});

describe('reporting what actually happened', () => {
  test('one failure does not lose the rest of the batch', async () => {
    materializeEngineAgent
      .mockRejectedValueOnce(new Error('name already taken'))
      .mockResolvedValueOnce({
        data: { slug: 'claude', name: 'Claude Code' },
        created: true,
      });
    const { onDone, onGiveUp } = renderChapter([CODEX, CLAUDE]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up 2' }));
    });

    expect(materializeEngineAgent).toHaveBeenCalledTimes(2);
    const report = await screen.findByTestId('first-run-engines-report');
    expect(report.textContent).toContain(
      'Codex: could not be set up. name already taken',
    );
    expect(report.textContent).toContain('Claude Code: set up as');
    // A failure has to be read, so the run waits for the user here — and the
    // way out is "continue WITHOUT them", which is not the completing exit
    //  This used to be a plain Continue that called `onDone`.
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('first-run-engines-give-up'));
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  test('a saved-but-not-launchable Agent is not reported as a clean set-up', async () => {
    materializeEngineAgent.mockResolvedValue({
      data: { slug: 'codex', name: 'Codex' },
      created: true,
      warnings: ['Agent saved but not launchable: codex is signed out.'],
    });
    const { onDone } = renderChapter([CODEX]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up 1' }));
    });
    const report = await screen.findByTestId('first-run-engines-report');
    expect(report.textContent).toContain('not launchable');
    expect(report.textContent).not.toContain('set up as');
    expect(onDone).not.toHaveBeenCalled();
  });

  test('an every-create-failed batch reports, and leaving is not completing', async () => {
    materializeEngineAgent.mockRejectedValue(new Error('offline'));
    const { onDone, onGiveUp } = renderChapter([CODEX]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up 1' }));
    });
    expect(
      (await screen.findByTestId('first-run-engines-report')).textContent,
    ).toContain('offline');
    fireEvent.click(screen.getByTestId('first-run-engines-give-up'));
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  test('a failed create does not float an unhandled rejection', async () => {
    const unhandled = vi.fn();
    window.addEventListener('unhandledrejection', unhandled);
    materializeEngineAgent.mockRejectedValue(new Error('offline'));
    renderChapter([CODEX]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up 1' }));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener('unhandledrejection', unhandled);
  });
});

describe('useFirstRunEngineOptions — when the inputs can be trusted', () => {
  test('reports the engines the server actually returned', () => {
    statusState.data = { externalEngines: [CODEX, OPENCODE] };
    const { result } = renderHook(() => useFirstRunEngineOptions());
    expect(result.current.settled).toBe(true);
    expect(result.current.options.map((option) => option.state)).toEqual([
      'available',
      'undetected',
    ]);
  });

  test('is not settled while system status is still loading', () => {
    statusState.isLoading = true;
    statusState.data = undefined;
    const { result } = renderHook(() => useFirstRunEngineOptions());
    expect(result.current.settled).toBe(false);
  });

  test('is not settled until the agent catalog has answered', () => {
    agentsState.loaded = false;
    agentsState.settled = false;
    statusState.data = { externalEngines: [CODEX] };
    const { result } = renderHook(() => useFirstRunEngineOptions());
    expect(result.current.settled).toBe(false);
  });

  test('a FAILED agent catalog settles with no options rather than stalling', () => {
    // Without the catalog the chapter cannot tell an enabled engine from a
    // new one, and waiting forever would strand the whole guided run at
    // Connect. Both failure modes are worse than skipping the chapter.
    agentsState.loaded = false;
    agentsState.settled = true;
    statusState.data = { externalEngines: [CODEX] };
    const { result } = renderHook(() => useFirstRunEngineOptions());
    expect(result.current.settled).toBe(true);
    expect(result.current.options).toEqual([]);
  });

  test('a status answer without engine rows is settled and empty', () => {
    statusState.data = {};
    const { result } = renderHook(() => useFirstRunEngineOptions());
    expect(result.current.settled).toBe(true);
    expect(result.current.options).toEqual([]);
  });
});

describe('the lede describes the list, so it needs one', () => {
  test('no lede while the catalog has not answered', () => {
    render(
      <FirstRunEnginesChapter
        options={[]}
        loading
        onDone={vi.fn()}
        onDefer={vi.fn()}
        onGiveUp={vi.fn()}
      />,
    );
    expect(
      screen.queryByText(/Station found these on this machine/),
    ).toBeNull();
    expect(screen.getByTestId('first-run-engines-loading')).toBeTruthy();
  });

  test('no lede when Station has nothing to offer', () => {
    // `externalEngines` is empty on a home with no engine connections even
    // where the CLIs are installed, so this state is reachable and its copy
    // must not claim Station "found these".
    renderChapter([]);
    expect(
      screen.queryByText(/Station found these on this machine/),
    ).toBeNull();
    expect(screen.getByTestId('first-run-engines-none')).toBeTruthy();
  });

  test('the lede appears once there is a list to describe', () => {
    renderChapter([CODEX]);
    expect(
      screen.getByText(/Station found these on this machine/),
    ).toBeTruthy();
  });
});

describe('seeding the selection when the catalog arrives in pieces', () => {
  test('an empty answer does not latch the seed at nothing', () => {
    // `/api/system/status` reports `externalEngines: []` in one window and the
    // real rows in the next. Seeding on the first settled answer latched `[]`,
    // so three enable-able engines rendered unticked with a primary action
    // reading "Continue" — seen live on a fresh temp home.
    const { update } = renderChapter([]);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();

    update([CODEX, CLAUDE]);
    expect(checkbox('codex')?.checked).toBe(true);
    expect(checkbox('claude-code')?.checked).toBe(true);
    expect(screen.getByRole('button', { name: 'Set up 2' })).toBeTruthy();
  });

  test('a later answer never re-ticks a box the user cleared', () => {
    // The other direction, and the reason this is seeded rather than derived.
    const { update } = renderChapter([CODEX, CLAUDE]);
    fireEvent.click(checkbox('claude-code') as HTMLInputElement);
    expect(checkbox('claude-code')?.checked).toBe(false);

    update([CODEX, CLAUDE]);
    expect(checkbox('claude-code')?.checked).toBe(false);
    expect(screen.getByRole('button', { name: 'Set up 1' })).toBeTruthy();
  });

  test('clearing everything survives a refetch', () => {
    // The strongest form: an EMPTY selection is a decision too, and the seed
    // guard must not read it as "not seeded yet".
    const { update } = renderChapter([CODEX]);
    fireEvent.click(checkbox('codex') as HTMLInputElement);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();

    update([CODEX]);
    expect(checkbox('codex')?.checked).toBe(false);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });
});

describe('H1 — a batch that FAILED does not offer a plain "Continue"', () => {
  test('a failure offers retry and continue-without, never acknowledgement', async () => {
    // The defect: the report's single Continue advanced the run, About-you's
    // Skip then wrote `completed`, and the home recorded a finished first run
    // for engines that were never enabled.
    materializeEngineAgent.mockRejectedValue(new Error('offline'));
    const { onDone, onGiveUp } = renderChapter([CODEX]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up 1' }));
    });
    await screen.findByTestId('first-run-engines-report');

    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.getByTestId('first-run-engines-retry')).toBeTruthy();
    expect(screen.getByTestId('first-run-engines-give-up')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  test('continue-without ends the run WITHOUT completing it', async () => {
    materializeEngineAgent.mockRejectedValue(new Error('offline'));
    const { onDone, onGiveUp } = renderChapter([CODEX]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up 1' }));
    });
    await screen.findByTestId('first-run-engines-report');
    fireEvent.click(screen.getByTestId('first-run-engines-give-up'));

    expect(onGiveUp).toHaveBeenCalledTimes(1);
    // `onDone` is the "everything the user asked for exists" exit, and this is
    // not it. Calling both would put the run back on the path that completes.
    expect(onDone).not.toHaveBeenCalled();
  });

  test('retry re-runs only what failed, and advances once it lands', async () => {
    materializeEngineAgent
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        data: { slug: 'claude', name: 'Claude Code' },
        created: true,
      });
    const { onDone } = renderChapter([CODEX, CLAUDE]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up 2' }));
    });
    await screen.findByTestId('first-run-engines-report');
    expect(materializeEngineAgent).toHaveBeenCalledTimes(2);

    materializeEngineAgent.mockResolvedValue({
      data: { slug: 'codex', name: 'Codex' },
      created: true,
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('first-run-engines-retry'));
    });

    // Exactly one more materialise — the engine that failed, addressed by the
    // only thing the endpoint takes (its connection id). The engine that
    // already succeeded is not re-materialised.
    expect(materializeEngineAgent).toHaveBeenCalledTimes(3);
    expect(materializeEngineAgent).toHaveBeenLastCalledWith('codex');
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  test('an engine that was ALREADY materialised is a success, not a failure', async () => {
    // `materialize-engine` is find-or-create, so a second confirm (or a second
    // device) answers `created: false` with the existing Agent. That is the
    // run doing what it offered to do — it must not land in the failed set,
    // and it must not hold the run at a report with no plain way on.
    materializeEngineAgent.mockResolvedValue({
      data: { slug: 'codex', name: 'Codex' },
      created: false,
    });
    const { onDone, onGiveUp } = renderChapter([CODEX]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up 1' }));
    });

    // No report at all: nothing needs acknowledging, so the run advances.
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('first-run-engines-report')).toBeNull();
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  test('an already-materialised engine is reported as such beside a failure', async () => {
    // The report's wording is derived from the endpoint's own answer: this run
    // created nothing for Codex, so it may not say it did.
    materializeEngineAgent
      .mockResolvedValueOnce({
        data: { slug: 'codex', name: 'Codex' },
        created: false,
      })
      .mockRejectedValueOnce(new Error('offline'));
    renderChapter([CODEX, CLAUDE]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up 2' }));
    });
    const report = await screen.findByTestId('first-run-engines-report');
    expect(report.textContent).toContain('Codex: already set up as “Codex”.');
    expect(report.textContent).not.toContain('Codex: set up as');
    expect(screen.getByTestId('first-run-engines-status').textContent).toBe(
      '1 already set up · 1 could not be set up.',
    );
  });

  test('a retry whose engine has LEFT the catalog does not complete the run', async () => {
    // The empty-plan shortcut, which is again by another door. `runBatch`
    // re-plans a retry from the CURRENT options; an engine that dropped out of
    // `externalEngines` (or flipped to blocked under a flapping probe) yields
    // no plan entry at all, and `plan.length === 0` used to take the
    // "everything the user asked for exists" exit — completing a run over the
    // one engine that never worked.
    materializeEngineAgent.mockRejectedValue(new Error('offline'));
    const { onDone, onGiveUp, update } = renderChapter([CODEX]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up 1' }));
    });
    await screen.findByTestId('first-run-engines-report');

    // Codex is gone from the catalog between the failure and the retry.
    update([CLAUDE]);
    await act(async () => {
      fireEvent.click(screen.getByTestId('first-run-engines-retry'));
    });

    const report = await screen.findByTestId('first-run-engines-report');
    expect(report.textContent).toContain(
      'Codex: could not be set up. Station is no longer offering it here.',
    );
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.getByTestId('first-run-engines-give-up')).toBeTruthy();
    expect(screen.getByTestId('first-run-engines-retry')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  test('a selection that has become unplannable before the first confirm reports it', async () => {
    // The same shortcut on the way IN: the checklist seeds once, so a ready
    // engine that goes `blocked` while the user reads the list stays ticked
    // and stays counted — and then plans to nothing.
    const { onDone, onGiveUp, update } = renderChapter([CODEX, CLAUDE]);
    expect(checkbox('codex')?.checked).toBe(true);

    update([
      { ...CODEX, ready: false, reason: 'sign_in_required' } as never,
      CLAUDE,
    ]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up 1' }));
    });

    // Claude still ran; Codex is reported as the failure it is, carrying the
    // row's OWN reason rather than a guess.
    expect(materializeEngineAgent).toHaveBeenCalledTimes(1);
    expect(materializeEngineAgent).toHaveBeenCalledWith('claude');
    const report = await screen.findByTestId('first-run-engines-report');
    expect(report.textContent).toContain('Claude Code: set up as');
    expect(report.textContent).toContain(
      'Codex: could not be set up. Sign in to Codex to use it here.',
    );
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  test('an empty request still finishes — the shortcut is not simply removed', async () => {
    // The discriminating half. Nothing was ASKED for, so there is nothing
    // unresolved and the run may move on; only a request that cannot be
    // planned is a failure. Without this the fix would strand every machine
    // Station has nothing to offer on.
    const { onDone, onGiveUp } = renderChapter([KIRO]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    });
    expect(materializeEngineAgent).not.toHaveBeenCalled();
    expect(screen.queryByTestId('first-run-engines-report')).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  test('a warning is not a failure and keeps the plain acknowledgement', async () => {
    // A warned create SAVED — the Agent exists. Treating it as a failure would
    // block a run that did what it said it would.
    materializeEngineAgent.mockResolvedValue({
      data: { slug: 'codex', name: 'Codex' },
      created: true,
      warnings: ['Agent saved but not launchable: Codex is signed out.'],
    });
    const { onDone } = renderChapter([CODEX]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up 1' }));
    });
    await screen.findByTestId('first-run-engines-report');

    expect(screen.queryByTestId('first-run-engines-retry')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

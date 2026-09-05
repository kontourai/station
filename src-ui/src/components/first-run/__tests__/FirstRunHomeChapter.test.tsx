/**
 * @vitest-environment jsdom
 *
 * The first-run chapter's placement and gate (UX audit RT-02, SHELL-12).
 *
 * These are the assertions the old surface could not make, because its
 * activation was a readiness probe and its placement was a fixed corner slot:
 * that the chapter's PRESENCE is a durable fact about the home and nothing
 * else, that a flapping `/api/system/status` cannot toggle it, that a deferral
 * is written down, and that it renders as a dialog rather than on the notice
 * layer.
 */

import type { FirstRunState } from '@kontourai/station-contracts/config';
import type { ExternalEngineReadinessProjection } from '@kontourai/station-contracts/system-status';
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderWithIsolatedConnections as render } from '../../../__tests__/renderWithIsolatedConnections';

const updateConfig = vi.fn();
const recordFirstRunDecision = vi.fn();
const materializeEngineAgent = vi.fn();
const configValue: {
  firstRun?: FirstRunState;
  userProfile?: unknown;
  builtinAgentEngineConnectionId?: string | null;
} = {};
const setupState = { launcherWouldShow: false };
const configState = { settled: true };
/** Every value the chapter published about owning the screen  */
const presence: boolean[] = [];
const engineState: {
  engines: ExternalEngineReadinessProjection[];
  statusLoading: boolean;
  statusRestored: boolean;
  agentsLoaded: boolean;
  agentsSettled: boolean;
} = {
  engines: [],
  statusLoading: false,
  statusRestored: false,
  agentsLoaded: true,
  agentsSettled: true,
};

vi.mock('../../../contexts/ConfigContext', () => ({
  useConfig: () => configValue,
  useConfigSettled: () => configState.settled,
  useConfigActions: () => ({
    updateConfig,
    recordFirstRunDecision,
    isSaving: false,
  }),
}));
vi.mock('../../../contexts/AgentsContext', () => ({
  useAgents: () => [],
  useAgentsLoaded: () => engineState.agentsLoaded,
  useAgentsSettled: () => engineState.agentsSettled,
}));
// The engines step enables through ONE server path — `POST
// /agents/materialize-engine` (archive#3627) — so the batch is observed here
// as the mutation it really performs, not as an agent-draft create.
vi.mock('@kontourai/station-sdk', () => ({
  useMaterializeEngineAgentMutation: () => ({
    mutateAsync: materializeEngineAgent,
  }),
  useDevicePresentation: () => undefined,
}));
// Existing setup is capability-gated. This chapter suite is about the
// durable onboarding gate, so model the ordinary unavailable capability.
vi.mock('@kontourai/station-sdk/setup-imports-query', () => ({
  useSetupImportSourcesQuery: () => ({
    data: [{ id: 'codex-prompts', available: false }],
    isLoading: false,
    isError: false,
  }),
  useCreateSetupImportPreviewMutation: () => ({}),
  useApplySetupImportMutation: () => ({}),
  useReviewSetupImportTargetsMutation: () => ({
    data: undefined,
    isPending: false,
    isError: false,
    mutate: vi.fn(),
    reset: vi.fn(),
  }),
  useRollbackSetupImportMutation: () => ({}),
}));
vi.mock('../../../contexts/onboarding-setup-store', () => ({
  useOnboardingSetupState: () => setupState,
  firstRunChapterPresence: { set: (open: boolean) => presence.push(open) },
}));
/**
 * The disclosure step, stubbed down to the things this file is about: what
 * the chapter ASKS it (is there anything to disclose, has the query answered)
 * and what it does with the answers (advance on an acknowledgement, close on a
 * decline). The inventory, the acknowledgement POST and the dismissal's own
 * persistence are the component's own, covered in
 * `UsageTelemetryDisclosure.test.tsx`.
 */
const disclosureState = { settled: true, outstanding: false };
const { dismissUsageTelemetryDisclosure } = vi.hoisted(() => ({
  dismissUsageTelemetryDisclosure: vi.fn(),
}));
vi.mock('../../UsageTelemetryDisclosure', () => ({
  useUsageTelemetryDisclosureState: () => disclosureState,
  dismissUsageTelemetryDisclosure,
  UsageTelemetryDisclosureStep: ({
    onAdvance,
    onDefer,
  }: {
    onAdvance: () => void;
    onDefer: () => void;
  }) => (
    <div data-testid="first-run-disclosure">
      <button type="button" onClick={onDefer}>
        Not now
      </button>
      <button type="button" onClick={onAdvance}>
        I understand
      </button>
    </div>
  ),
}));
vi.mock('../../../hooks/useSystemStatus', () => ({
  useSystemStatus: () => ({
    data: { externalEngines: engineState.engines },
    isLoading: engineState.statusLoading,
    // A RESTORED query has data and is not "loading", but is still fetching —
    // the chapter's auto-open reads this one.
    isFetching: engineState.statusLoading || engineState.statusRestored,
  }),
}));
vi.mock('../../EnginePicker', () => ({
  EnginePicker: ({
    eyebrow,
    title,
    onChosen,
    onDismiss,
  }: {
    eyebrow?: string;
    title?: string;
    onChosen: () => void;
    onDismiss: () => void;
  }) => (
    <div data-testid="engine-picker">
      <div>{eyebrow}</div>
      <div>{title}</div>
      <button type="button" onClick={onChosen}>
        Use selected engine
      </button>
      <button type="button" onClick={onDismiss}>
        Decide later
      </button>
    </div>
  ),
}));

import {
  FirstRunHomeChapter,
  firstRunStepCounterLabel,
  planFirstRunChapterSteps,
} from '../FirstRunHomeChapter';
import { firstRunStore } from '../first-run-store';

const READY_CODEX = {
  engineId: 'codex',
  name: 'Codex',
  engineConnectionId: 'codex',
  detected: true,
  ready: true,
  source: 'cli',
} as ExternalEngineReadinessProjection;

const READY_CLAUDE = {
  engineId: 'claude',
  name: 'Claude Code',
  engineConnectionId: 'claude',
  detected: true,
  ready: true,
  source: 'cli',
} as ExternalEngineReadinessProjection;

const UNVERIFIABLE_CLAUDE = {
  engineId: 'claude',
  name: 'Claude Code',
  engineConnectionId: 'claude',
  detected: false,
  ready: false,
  source: null,
  reason: 'cannot_verify',
} as ExternalEngineReadinessProjection;

beforeEach(() => {
  updateConfig.mockReset().mockResolvedValue(undefined);
  recordFirstRunDecision.mockReset().mockResolvedValue(undefined);
  presence.length = 0;
  materializeEngineAgent
    .mockReset()
    .mockImplementation(async (engineId: string) => ({
      data: { slug: engineId, name: engineId },
      created: true,
    }));
  configValue.firstRun = { status: 'pending' };
  dismissUsageTelemetryDisclosure.mockReset();
  disclosureState.settled = true;
  disclosureState.outstanding = false;
  setupState.launcherWouldShow = false;
  configState.settled = true;
  configValue.userProfile = undefined;
  // Existing tests exercise the chapter transitions after an engine choice.
  // A dedicated case below covers the genuinely unchosen first-run state.
  configValue.builtinAgentEngineConnectionId = 'codex';
  engineState.engines = [READY_CODEX];
  engineState.statusLoading = false;
  engineState.statusRestored = false;
  engineState.agentsLoaded = true;
  engineState.agentsSettled = true;
  firstRunStore.reset();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('AC1 — the gate is a durable fact about the home', () => {
  test('asks which engine powers Station before advancing past engine setup', async () => {
    configValue.builtinAgentEngineConnectionId = undefined;
    engineState.engines = [];
    render(<FirstRunHomeChapter />);

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByTestId('engine-picker')).toBeTruthy();
    expect(screen.queryByTestId('first-run-about-you')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'Use selected engine' }),
    );
    expect(screen.getByTestId('first-run-about-you')).toBeTruthy();
  });

  test('a home that has never answered opens the chapter on the first render', () => {
    render(<FirstRunHomeChapter />);
    expect(screen.getByTestId('first-run-engines')).toBeTruthy();
    expect(screen.getByTestId('first-run-home-card')).toBeTruthy();
  });

  test('the agents step contains no unrelated empty import panel', () => {
    render(<FirstRunHomeChapter />);
    expect(screen.getByTestId('first-run-engines')).toBeTruthy();
    expect(screen.queryByTestId('existing-setup-import-stepper')).toBeNull();
  });

  test('a completed home is offered nothing at all', () => {
    configValue.firstRun = {
      status: 'completed',
      completedAt: '2026-01-01T00:00:00.000Z',
    };
    render(<FirstRunHomeChapter />);
    expect(screen.queryByTestId('first-run-engines')).toBeNull();
    expect(screen.queryByTestId('first-run-home-card')).toBeNull();
  });

  test('a home whose config predates the field is not ambushed', () => {
    // The regression the old `sawSetupLauncher` rule was reaching for, kept
    // without the rule: absent is "this home has already been in use", which
    // is a different state from `pending` and must never open a guided run.
    configValue.firstRun = undefined;
    render(<FirstRunHomeChapter />);
    expect(screen.queryByTestId('first-run-engines')).toBeNull();
    expect(screen.queryByTestId('first-run-home-card')).toBeNull();
  });

  test('the engines on this machine cannot decide whether the chapter runs', () => {
    // RT-02 exactly: with `claude`/`codex` ready on first paint the launcher
    // never appeared and the run never happened. Ready engines now change what
    // the chapter SAYS, never whether it exists.
    engineState.engines = [READY_CODEX, READY_CLAUDE];
    render(<FirstRunHomeChapter />);
    expect(screen.getByTestId('first-run-engines')).toBeTruthy();
  });
});

describe('a restored config snapshot cannot re-open a deferred run', () => {
  test('nothing auto-opens while the config read is still being revalidated', () => {
    // `['config']` is persisted to IndexedDB, so a boot renders the PREVIOUS
    // session's copy first. Right after a deferral that copy still says
    // `pending`.
    configState.settled = false;
    render(<FirstRunHomeChapter />);
    expect(screen.queryByTestId('first-run-engines')).toBeNull();
    // The card renders from the restored copy, and should: it offers, it does
    // not interrupt.
    expect(screen.getByTestId('first-run-home-card')).toBeTruthy();
  });

  test('a stale pending that resolves to skipped never opens the chapter', () => {
    // THE OBSERVED DEFECT, as a test: deferred a moment ago, reloaded, and the
    // restored snapshot re-opened the chapter over the decision just made.
    configState.settled = false;
    configValue.firstRun = { status: 'pending' };
    const view = render(<FirstRunHomeChapter />);
    expect(screen.queryByTestId('first-run-engines')).toBeNull();

    // The network answers with what the home actually holds.
    configValue.firstRun = {
      status: 'skipped',
      skippedAt: '2026-01-01T00:00:00.000Z',
    };
    configState.settled = true;
    view.rerender(<FirstRunHomeChapter />);

    expect(screen.queryByTestId('first-run-engines')).toBeNull();
    expect(screen.getByTestId('first-run-home-card')).toBeTruthy();
  });

  test('a confirmed pending still opens it', () => {
    // The guard must not swallow the case it exists to protect.
    configState.settled = false;
    const view = render(<FirstRunHomeChapter />);
    expect(screen.queryByTestId('first-run-engines')).toBeNull();

    configState.settled = true;
    view.rerender(<FirstRunHomeChapter />);
    expect(screen.getByTestId('first-run-engines')).toBeTruthy();
  });
});

describe('the connect launcher goes first, and can only ever delay', () => {
  test('the chapter does not stack on top of the full-screen setup launcher', () => {
    setupState.launcherWouldShow = true;
    render(<FirstRunHomeChapter />);
    expect(screen.queryByTestId('first-run-engines')).toBeNull();
    // Still OFFERED: the durable fact is untouched, so Home carries the card
    // and the run is one click (or one launcher dismissal) away. This is what
    // separates it from the old rule, which decided the run never happened.
    expect(screen.getByTestId('first-run-home-card')).toBeTruthy();
  });

  test('resolving the launcher opens the chapter that was waiting for it', () => {
    setupState.launcherWouldShow = true;
    const view = render(<FirstRunHomeChapter />);
    expect(screen.queryByTestId('first-run-engines')).toBeNull();

    setupState.launcherWouldShow = false;
    configState.settled = true;
    view.rerender(<FirstRunHomeChapter />);
    expect(screen.getByTestId('first-run-engines')).toBeTruthy();
  });

  test('nothing opens on a RESTORED status from the previous session', () => {
    // `['system-status']` is persisted to IndexedDB, so a boot renders last
    // session's answer — which can say "chat is ready" while THIS session's
    // Station has nothing configured. Opening on it left the launcher under
    // the chapter's scrim with its primary action unclickable (E2E bucket).
    engineState.statusRestored = true;
    setupState.launcherWouldShow = false;
    const view = render(<FirstRunHomeChapter />);
    expect(screen.queryByTestId('first-run-engines')).toBeNull();

    // The network confirms it, and it says the launcher owns the screen.
    engineState.statusRestored = false;
    setupState.launcherWouldShow = true;
    view.rerender(<FirstRunHomeChapter />);
    expect(screen.queryByTestId('first-run-engines')).toBeNull();
  });

  test('nothing opens before the launcher question has been ASKED', () => {
    // `isBlockingFullScreen` is false while `/api/system/status` is in flight,
    // because the launcher's own visibility is `!!status && …`. Treating that
    // as "no launcher" opened the chapter first and left the launcher under
    // its scrim, with its primary action unclickable.
    engineState.statusLoading = true;
    const view = render(<FirstRunHomeChapter />);
    expect(screen.queryByTestId('first-run-engines')).toBeNull();

    // The answer arrives, and it says the launcher owns the screen.
    engineState.statusLoading = false;
    setupState.launcherWouldShow = true;
    view.rerender(<FirstRunHomeChapter />);
    expect(screen.queryByTestId('first-run-engines')).toBeNull();

    // …and once it is resolved, the chapter opens.
    setupState.launcherWouldShow = false;
    view.rerender(<FirstRunHomeChapter />);
    expect(screen.getByTestId('first-run-engines')).toBeTruthy();
  });

  test('the chapter publishes whether it owns the screen', () => {
    // this is the ONE piece of state both first-run overlays read,
    // which is what makes "at most one of them exists" a rule rather than two
    // components guessing from the same flapping probe. The integrated
    // assertion lives in `first-run-overlay-exclusivity.test.tsx`.
    const view = render(<FirstRunHomeChapter />);
    expect(presence.at(-1)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(presence.at(-1)).toBe(false);

    view.unmount();
    // Leaving Home hands the screen back even if the chapter was still open.
    expect(presence.at(-1)).toBe(false);
  });

  // "a launcher that re-appears cannot close a chapter already open" USED to
  // live here. It passed while mocking `OnboardingGate` away, so it could only
  // ever see one of the two overlays — the review's is precisely that the
  // other one was rendering at the same time. Replaced by
  // `src-ui/src/__tests__/first-run-overlay-exclusivity.test.tsx`, which mounts
  // both components and the real store between them.
});

describe('AC5 — a flapping status probe cannot toggle the chapter', () => {
  test('cannot_verify ↔ ready leaves the chapter exactly where it was', () => {
    engineState.engines = [UNVERIFIABLE_CLAUDE];
    const view = render(<FirstRunHomeChapter />);
    expect(screen.getByTestId('first-run-engines')).toBeTruthy();
    const firstRow = screen.getByTestId('first-run-engine-claude').textContent;

    // The probe flaps to ready…
    engineState.engines = [READY_CLAUDE];
    view.rerender(<FirstRunHomeChapter />);
    expect(screen.getByTestId('first-run-engines')).toBeTruthy();
    expect(screen.getByTestId('first-run-engine-claude').textContent).not.toBe(
      firstRow,
    );

    // …and back again. Six transitions, one chapter, never a mount or unmount.
    for (const engines of [
      [UNVERIFIABLE_CLAUDE],
      [READY_CLAUDE],
      [UNVERIFIABLE_CLAUDE],
    ]) {
      engineState.engines = engines;
      view.rerender(<FirstRunHomeChapter />);
      expect(screen.getByTestId('first-run-engines')).toBeTruthy();
    }
  });

  test('an unanswered status probe holds the list, not the chapter', () => {
    // Opened on a settled probe, then the query re-keys and goes back in
    // flight (`useSystemStatus` is keyed by apiBase, so switching connection
    // mid-chapter does exactly this). The LIST goes back to its loading line;
    // the chapter does not move.
    const view = render(<FirstRunHomeChapter />);
    expect(screen.getByTestId('first-run-engines')).toBeTruthy();

    engineState.statusLoading = true;
    view.rerender(<FirstRunHomeChapter />);
    expect(screen.getByTestId('first-run-engines')).toBeTruthy();
    expect(screen.getByTestId('first-run-engines-loading')).toBeTruthy();

    engineState.statusLoading = false;
    view.rerender(<FirstRunHomeChapter />);
    expect(screen.queryByTestId('first-run-engines-loading')).toBeNull();
    // The selection seeds from the answer that arrived, not from the empty
    // catalog the list was showing.
    expect(screen.getByRole('button', { name: 'Set up 1' })).toBeTruthy();
  });

  test('a machine with no engines gets an honest line, not a blank card', () => {
    engineState.engines = [];
    render(<FirstRunHomeChapter />);
    expect(screen.getByTestId('first-run-engines-none')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });
});

describe('AC3 — it renders as a dialog, and only inside Home', () => {
  test('the chapter is a modal surface, not a notice-layer card', () => {
    const { container } = render(<FirstRunHomeChapter />);
    const overlay = document.querySelector('.responsive-surface-overlay');
    expect(overlay).toBeTruthy();
    // The shared surface owns the layer. Nothing in the first-run tree may
    // declare its own placement — that is how the old card ended up above
    // modal scrims and the command palette.
    expect(
      document.querySelector('.first-run-about[style], .first-run-engines'),
    ).toBeTruthy();
    expect(container.querySelector('aside')).toBeNull();
  });

  test('unmounting the route takes the chapter with it', () => {
    // The component is mounted by `HomeView`, so "navigated away" is
    // "unmounted". Nothing survives to follow the user.
    const view = render(<FirstRunHomeChapter />);
    expect(screen.getByTestId('first-run-engines')).toBeTruthy();
    view.unmount();
    expect(document.querySelector('.responsive-surface-overlay')).toBeNull();
    expect(screen.queryByTestId('first-run-engines')).toBeNull();
  });
});

describe('AC2 — deferring and completing both write the durable fact', () => {
  test('"Not now" writes skipped, closes, and leaves the Home card', async () => {
    render(<FirstRunHomeChapter />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

    await waitFor(() =>
      expect(recordFirstRunDecision).toHaveBeenCalledTimes(1),
    );
    // A status and nothing else: the server decides whether the move is legal
    // and stamps when it happened
    expect(recordFirstRunDecision).toHaveBeenCalledWith({ status: 'skipped' });
    expect(screen.queryByTestId('first-run-engines')).toBeNull();
    expect(screen.getByTestId('first-run-home-card')).toBeTruthy();
  });

  test('deferral survives reload without re-arming and stays resumable while config is pending', () => {
    const firstMount = render(<FirstRunHomeChapter />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(firstRunStore.getSnapshot()).toEqual({
      chapter: 'connect',
      deferred: true,
    });

    firstMount.unmount();
    // The server mutation is intentionally fire-and-forget, so the restored
    // config snapshot can still say pending on this next mount.
    configValue.firstRun = { status: 'pending' };
    render(<FirstRunHomeChapter />);

    expect(screen.queryByTestId('first-run-engines')).toBeNull();
    expect(screen.getByTestId('first-run-home-card')).toBeTruthy();

    // Deferred is a snooze, not terminal completion: the still-pending run is
    // offered non-modally and can be resumed explicitly from where it stopped.
    fireEvent.click(screen.getByRole('button', { name: 'Set up Station' }));
    expect(screen.getByTestId('first-run-engines')).toBeTruthy();
    expect(firstRunStore.getSnapshot().chapter).not.toBe('done');
  });

  test('a reload resumes the last unfinished chapter instead of step one', () => {
    engineState.engines = [];
    const firstMount = render(<FirstRunHomeChapter />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByTestId('first-run-about-you')).toBeTruthy();
    expect(firstRunStore.getSnapshot().chapter).toBe('about-you');

    firstMount.unmount();
    render(<FirstRunHomeChapter />);

    expect(screen.getByTestId('first-run-about-you')).toBeTruthy();
    expect(screen.queryByTestId('first-run-engines')).toBeNull();
  });

  test('a deferred home does not re-open the chapter, and can re-enter it', () => {
    configValue.firstRun = {
      status: 'skipped',
      skippedAt: '2026-01-01T00:00:00.000Z',
    };
    render(<FirstRunHomeChapter />);
    expect(screen.queryByTestId('first-run-engines')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Set up Station' }));
    expect(screen.getByTestId('first-run-engines')).toBeTruthy();
  });

  test('re-closing an already-deferred chapter does not rewrite skippedAt', () => {
    configValue.firstRun = {
      status: 'skipped',
      skippedAt: '2026-01-01T00:00:00.000Z',
    };
    render(<FirstRunHomeChapter />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up Station' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(recordFirstRunDecision).not.toHaveBeenCalled();
  });

  test('completing enables the chosen engines once and writes completed', async () => {
    engineState.engines = [READY_CODEX, READY_CLAUDE];
    render(<FirstRunHomeChapter />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up 2' }));
    });
    expect(materializeEngineAgent).toHaveBeenCalledTimes(2);

    // The questions are the second step of the same dialog — not a second
    // surface in a corner somewhere.
    await waitFor(() =>
      expect(screen.getByTestId('first-run-about-you')).toBeTruthy(),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Start your first chat' }),
      );
    });

    expect(recordFirstRunDecision.mock.calls.map((call) => call[0])).toEqual([
      { status: 'completed' },
    ]);
    // Skipping the questions persists NO profile at all — absent is what makes
    // the server inject nothing.
    expect(
      updateConfig.mock.calls.some((call) =>
        Object.hasOwn(call[0], 'userProfile'),
      ),
    ).toBe(false);
    expect(screen.queryByTestId('first-run-about-you')).toBeNull();
  });

  test('completing leaves no stray deferral behind it', async () => {
    // `ResponsiveDialogSurface` runs its own `onClose` as it tears down, and
    // this chapter's `onClose` IS the deferral. The config refetch after the
    // `completed` PUT has not landed at that instant, so the record still
    // reads `pending` — and a `skipped` write landing after `completed`
    // persists a finished run as a deferred one.
    engineState.engines = [];
    render(<FirstRunHomeChapter />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    });
    await waitFor(() =>
      expect(screen.getByTestId('first-run-about-you')).toBeTruthy(),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Start your first chat' }),
      );
    });
    // The card is still on screen until the config refetch lands, so the
    // chapter is re-openable inside that window — and closing it must not
    // write a deferral over the completion that just happened.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up Station' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close setup' }));
    });

    expect(
      recordFirstRunDecision.mock.calls.map((call) => call[0].status),
    ).toEqual(['completed']);
  });

  test('H1 — a failed engine can never leave the home completed', async () => {
    // The review's High: the report's Continue advanced unconditionally,
    // About-you's Skip wrote `completed`, and a home whose chosen engines were
    // never enabled recorded a finished first run.
    materializeEngineAgent.mockRejectedValue(new Error('offline'));
    render(<FirstRunHomeChapter />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up 1' }));
    });
    await screen.findByTestId('first-run-engines-report');

    // There is no exit from here that completes: the questions are not even
    // reachable, so `complete` cannot be called.
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('first-run-engines-give-up'));
    });

    expect(screen.queryByTestId('first-run-about-you')).toBeNull();
    expect(
      recordFirstRunDecision.mock.calls.map((call) => call[0].status),
    ).toEqual(['skipped']);
    // And the card stays: the engines they asked for still do not exist, so
    // the run is still on offer.
    expect(screen.getByTestId('first-run-home-card')).toBeTruthy();
  });

  test('H1 — retrying until it lands DOES complete', async () => {
    // The other direction, so the guard cannot be satisfied by never
    // completing anything.
    materializeEngineAgent.mockRejectedValueOnce(new Error('offline'));
    render(<FirstRunHomeChapter />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up 1' }));
    });
    await screen.findByTestId('first-run-engines-report');

    materializeEngineAgent.mockResolvedValue({
      data: { slug: 'codex', name: 'Codex' },
      created: true,
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('first-run-engines-retry'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('first-run-about-you')).toBeTruthy(),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Start your first chat' }),
      );
    });

    expect(
      recordFirstRunDecision.mock.calls.map((call) => call[0].status),
    ).toEqual(['completed']);
  });

  test('H1 — a retry whose engine has left the catalog cannot complete the home', async () => {
    // The durable half of the empty-plan defect: the chapter's report used to
    // vanish and the run walk on to the questions, whose Skip writes
    // `completed` — for a home whose Codex was never set up and is no longer
    // even on offer.
    materializeEngineAgent.mockRejectedValue(new Error('offline'));
    const view = render(<FirstRunHomeChapter />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set up 1' }));
    });
    await screen.findByTestId('first-run-engines-report');

    // The engine drops out of the catalog before the retry lands. The
    // re-render is load-bearing: `runBatch` closes over the options of the
    // render it was created in, so mutating the fixture alone would leave the
    // retry planning against the OLD catalog and this test would pass without
    // ever reaching the empty-plan branch it exists for (proved by injection —
    // it did exactly that until the rerender was added).
    engineState.engines = [];
    view.rerender(<FirstRunHomeChapter />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('first-run-engines-retry'));
    });

    expect(screen.queryByTestId('first-run-about-you')).toBeNull();
    expect(
      recordFirstRunDecision.mock.calls.map((call) => call[0].status),
    ).toEqual([]);
    // The only exits are still the two honest ones.
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('first-run-engines-give-up'));
    });
    expect(
      recordFirstRunDecision.mock.calls.map((call) => call[0].status),
    ).toEqual(['skipped']);
  });

  test('an already-enabled engine is shown as done and creates nothing', async () => {
    // "no duplicate agents": an enabled row is not selectable, so it can
    // never enter a batch however it renders.
    engineState.engines = [READY_CODEX];
    render(<FirstRunHomeChapter />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Codex' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    });
    expect(materializeEngineAgent).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId('first-run-about-you')).toBeTruthy(),
    );
  });

  test('a failed durable write leaves the home pending rather than lying', async () => {
    recordFirstRunDecision.mockRejectedValue(new Error('offline'));
    render(<FirstRunHomeChapter />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    });
    // Nothing claims it was saved: `configValue.firstRun` is still `pending`,
    // so the next load offers the chapter again. The rejection is caught, not
    // floated.
    expect(configValue.firstRun?.status).toBe('pending');
  });
});

/**
 * The usage-telemetry disclosure is the run's FIRST STEP, not a modal over it.
 *
 * On a fresh home `OnboardingGate`'s standalone `<UsageTelemetryDisclosure
 * firstRun />` rendered after its children and therefore ON TOP of this
 * chapter — two modals on the first screen a person ever sees (reproduced
 * live). The gate withholds that modal while the home is `pending`
 * (`shouldRenderUsageTelemetryDisclosure`, covered integrated in
 * `first-run-overlay-exclusivity.test.tsx`); these are the chapter's half.
 */
describe('the disclosure is the first step of the run, not a modal over it', () => {
  test('an outstanding disclosure opens the run at step 1 of 3', () => {
    disclosureState.outstanding = true;
    render(<FirstRunHomeChapter />);

    expect(screen.getByTestId('first-run-disclosure')).toBeTruthy();
    expect(screen.getByText('Step 1 of 3')).toBeTruthy();
    expect(screen.getByText('What Station sends')).toBeTruthy();
    // The engines step is BEHIND it, not beside it.
    expect(screen.queryByTestId('first-run-engines')).toBeNull();

    // Acknowledging is the ONLY way forward; the counter follows the steps
    // the run actually rendered.
    fireEvent.click(screen.getByRole('button', { name: 'I understand' }));
    expect(screen.getByTestId('first-run-engines')).toBeTruthy();
    expect(screen.getByText('Step 2 of 3')).toBeTruthy();
    expect(screen.queryByTestId('first-run-disclosure')).toBeNull();
  });

  test('"Not now" on the disclosure step CLOSES the run, never advances (#765 B1)', async () => {
    // Reproduced live: "Not now" on "Step 1 of 3" advanced to step 2, which
    // reads as the modal refusing to be dismissed. Declining the disclosure
    // is a deferral of the run — the dialog closes, the durable fact is
    // written, and the Home card keeps offering the run.
    disclosureState.outstanding = true;
    render(<FirstRunHomeChapter />);
    expect(screen.getByTestId('first-run-disclosure')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    });

    expect(
      screen.queryByTestId('first-run-engines'),
      '"Not now" advanced into the engines step',
    ).toBeNull();
    expect(screen.queryByTestId('first-run-disclosure')).toBeNull();
    expect(recordFirstRunDecision).toHaveBeenCalledWith({ status: 'skipped' });
    expect(screen.getByTestId('first-run-home-card')).toBeTruthy();
  });

  test('an already-acknowledged home runs two steps and says so', () => {
    // The count is derived from the run the chapter actually opened with, so
    // "Step 1 of 3" is never printed over a run that has two steps.
    disclosureState.outstanding = false;
    render(<FirstRunHomeChapter />);

    expect(screen.queryByTestId('first-run-disclosure')).toBeNull();
    expect(screen.getByTestId('first-run-engines')).toBeTruthy();
    expect(screen.getByText('Step 1 of 2')).toBeTruthy();
  });

  test('nothing opens until the disclosure query has answered', () => {
    // Opening on an unanswered query would print a step count that is about
    // to change under the reader — the same class of lie as a label with
    // nothing behind it.
    disclosureState.settled = false;
    disclosureState.outstanding = false;
    const view = render(<FirstRunHomeChapter />);
    expect(screen.queryByTestId('first-run-engines')).toBeNull();
    expect(screen.queryByTestId('first-run-disclosure')).toBeNull();
    // The Home card still offers the run: it interrupts nobody.
    expect(screen.getByTestId('first-run-home-card')).toBeTruthy();

    disclosureState.settled = true;
    disclosureState.outstanding = true;
    view.rerender(<FirstRunHomeChapter />);
    expect(screen.getByTestId('first-run-disclosure')).toBeTruthy();
    expect(screen.getByText('Step 1 of 3')).toBeTruthy();
  });

  test('closing the run at the disclosure step writes the deferral AND dismisses the disclosure', async () => {
    // The dialog's own close is the RUN's decision at every step. At the
    // disclosure step it is also the DISCLOSURE's decision: without recording
    // the dismissal, the `skipped` write flips the home off `pending`,
    // `OnboardingGate` mounts the standalone modal on every route, and the
    // dialog the user just closed re-appears over `/agents` (#765 B1,
    // reproduced live).
    disclosureState.outstanding = true;
    render(<FirstRunHomeChapter />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close setup' }));
    });
    expect(recordFirstRunDecision).toHaveBeenCalledWith({ status: 'skipped' });
    expect(
      dismissUsageTelemetryDisclosure,
      'closing over the disclosure step left the disclosure undismissed',
    ).toHaveBeenCalled();
  });

  test('closing the run at a LATER step does not touch the disclosure', async () => {
    // The disclosure behind an acknowledged step is settled server-side; a
    // close at the engines step must not write a client snooze for it.
    disclosureState.outstanding = false;
    render(<FirstRunHomeChapter />);
    expect(screen.getByTestId('first-run-engines')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close setup' }));
    });
    expect(recordFirstRunDecision).toHaveBeenCalledWith({ status: 'skipped' });
    expect(dismissUsageTelemetryDisclosure).not.toHaveBeenCalled();
  });
});

describe('first useful chat handoff', () => {
  async function openQuestions() {
    engineState.engines = [];
    render(<FirstRunHomeChapter />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByTestId('first-run-about-you');
  }

  test.each([
    ['Start your first chat', 'station:open-new-chat', 'done'],
    ['Take the tour', 'station-start-first-run-tour', 'tour'],
  ] as const)(
    '%s saves intentional answers before its canonical intent',
    async (label, eventName, chapter) => {
      await openQuestions();
      fireEvent.click(screen.getByRole('radio', { name: 'Engineer' }));
      let finishSave!: () => void;
      updateConfig.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishSave = resolve;
          }),
      );
      const intent = vi.fn();
      const otherIntent = vi.fn();
      const otherEvent =
        eventName === 'station:open-new-chat'
          ? 'station-start-first-run-tour'
          : 'station:open-new-chat';
      window.addEventListener(eventName, intent);
      window.addEventListener(otherEvent, otherIntent);
      try {
        fireEvent.click(screen.getByRole('button', { name: label }));
        expect(updateConfig).toHaveBeenCalledWith({
          userProfile: { role: 'engineer' },
        });
        expect(intent).not.toHaveBeenCalled();
        expect(recordFirstRunDecision).not.toHaveBeenCalled();
        expect(
          (
            screen.getByRole('button', {
              name: 'Start your first chat',
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(true);
        expect(
          (
            screen.getByRole('button', {
              name: 'Take the tour',
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(true);
        await act(async () => finishSave());
        expect(intent).toHaveBeenCalledTimes(1);
        expect(otherIntent).not.toHaveBeenCalled();
        expect(firstRunStore.getSnapshot().chapter).toBe(chapter);
        expect(screen.queryByTestId('first-run-about-you')).toBeNull();
      } finally {
        window.removeEventListener(eventName, intent);
        window.removeEventListener(otherEvent, otherIntent);
      }
    },
  );

  test.each(['Start your first chat', 'Take the tour'])(
    '%s stays recoverable when selected answers cannot be saved',
    async (label) => {
      await openQuestions();
      fireEvent.click(screen.getByRole('radio', { name: 'Engineer' }));
      updateConfig.mockRejectedValueOnce(new Error('offline'));
      const intent = vi.fn();
      window.addEventListener('station:open-new-chat', intent);
      window.addEventListener('station-start-first-run-tour', intent);
      try {
        await act(async () =>
          fireEvent.click(screen.getByRole('button', { name: label })),
        );
        expect(screen.getByRole('alert').textContent).toContain('offline');
        expect(screen.getByTestId('first-run-about-you')).toBeTruthy();
        expect(recordFirstRunDecision).not.toHaveBeenCalled();
        expect(intent).not.toHaveBeenCalled();
        await act(async () =>
          fireEvent.click(screen.getByRole('button', { name: label })),
        );
        expect(intent).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener('station:open-new-chat', intent);
        window.removeEventListener('station-start-first-run-tour', intent);
      }
    },
  );
});

describe('leaving during personalization save', () => {
  test.each(['Start your first chat', 'Take the tour'])(
    '%s does not navigate after setup is closed',
    async (label) => {
      engineState.engines = [];
      render(<FirstRunHomeChapter />);
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      await screen.findByTestId('first-run-about-you');
      fireEvent.click(screen.getByRole('radio', { name: 'Engineer' }));
      let finishSave!: () => void;
      updateConfig.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishSave = resolve;
          }),
      );
      const intent = vi.fn();
      window.addEventListener('station:open-new-chat', intent);
      window.addEventListener('station-start-first-run-tour', intent);
      try {
        fireEvent.click(screen.getByRole('button', { name: label }));
        fireEvent.click(screen.getByRole('button', { name: 'Close setup' }));
        await act(async () => finishSave());
        expect(intent).not.toHaveBeenCalled();
        expect(
          recordFirstRunDecision.mock.calls.map((call) => call[0].status),
        ).toEqual(['skipped']);
        expect(screen.queryByTestId('first-run-about-you')).toBeNull();
        expect(firstRunStore.getSnapshot().deferred).toBe(true);
      } finally {
        window.removeEventListener('station:open-new-chat', intent);
        window.removeEventListener('station-start-first-run-tour', intent);
      }
    },
  );
});

/**
 * #1536 A8: four modals numbered as three. The run showed "Step 1 of 3",
 * "Step 2 of 3", an unnumbered "Choose what powers Station", then
 * "Step 3 of 3" — so the one screen with no number read as something that had
 * escaped the wizard.
 */
describe('the engine-role screen is a counted step of the run', () => {
  test('plans it only when the role is unanswered', () => {
    expect(
      planFirstRunChapterSteps({
        disclosureOutstanding: true,
        engineRoleUnanswered: true,
      }),
    ).toEqual(['disclosure', 'engines', 'engine-role', 'about-you']);
    expect(
      planFirstRunChapterSteps({
        disclosureOutstanding: false,
        engineRoleUnanswered: false,
      }),
    ).toEqual(['engines', 'about-you']);
  });

  test('says nothing rather than "Step 0 of N" for a step this run is not showing', () => {
    expect(
      firstRunStepCounterLabel(['engines', 'about-you'], 'engine-role'),
    ).toBeUndefined();
  });

  test('counts every screen the run shows, and numbers the role screen among them', async () => {
    disclosureState.outstanding = true;
    configValue.builtinAgentEngineConnectionId = undefined;
    engineState.engines = [];
    render(<FirstRunHomeChapter />);

    expect(screen.getByText('Step 1 of 4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'I understand' }));
    expect(screen.getByText('Step 2 of 4')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const picker = await screen.findByTestId('engine-picker');
    // The screen that used to carry a decorative eyebrow and no number.
    expect(picker.textContent).toContain('Step 3 of 4');
    expect(picker.textContent).toContain('Choose what powers Station');

    fireEvent.click(
      screen.getByRole('button', { name: 'Use selected engine' }),
    );
    expect(screen.getByText('Step 4 of 4')).toBeTruthy();
  });

  test('stops counting the role screen when the role is answered mid-run', async () => {
    disclosureState.outstanding = false;
    configValue.builtinAgentEngineConnectionId = undefined;
    engineState.engines = [];
    render(<FirstRunHomeChapter />);

    // Planned as three: engines, engine-role, about-you.
    expect(screen.getByText('Step 1 of 3')).toBeTruthy();
    // Settings in another tab answers the role while this run is open.
    configValue.builtinAgentEngineConnectionId = 'codex';

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.queryByTestId('engine-picker')).toBeNull();
    expect(screen.getByTestId('first-run-about-you')).toBeTruthy();
    // Not "Step 3 of 3" over a run that only ever showed two screens.
    expect(screen.getByText('Step 2 of 2')).toBeTruthy();
  });
});

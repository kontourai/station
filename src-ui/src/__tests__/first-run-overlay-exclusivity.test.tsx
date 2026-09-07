/**
 * @vitest-environment jsdom
 *
 * AT MOST ONE FIRST-RUN OVERLAY
 *
 * `OnboardingGate`'s `SetupLauncher` and Home's first-run chapter both decide
 * from the same flapping `/api/system/status`, and they used to decide
 * SEPARATELY: the chapter consulted the launcher only at its one-shot
 * auto-open, while the gate re-mounted the launcher whenever the probe went
 * back to `cannot_verify`. A `ready → cannot_verify` transition after the
 * chapter opened therefore produced both, with the launcher stranded under the
 * chapter's scrim — the inaccessible-under-a-scrim class this branch exists to
 * remove.
 *
 * Both components are REAL here, and so is the store between them
 * (`onboarding-setup-store`). That is the whole point: the previous unit test
 * mocked the gate away and could only ever observe one of the two.
 */

import type { SystemStatus } from '@kontourai/station-sdk';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

let currentStatus: SystemStatus | null = null;
const navigate = vi.fn();
const refetch = vi.fn();
const forceRefetch = vi.fn();
const recordFirstRunDecision = vi.fn();

vi.mock('../hooks/useSystemStatus', () => ({
  useSystemStatus: () => ({
    data: currentStatus,
    isLoading: false,
    isPending: false,
    isError: false,
    failureReason: null,
    error: null,
    refetch,
    dataUpdatedAt: Date.now(),
  }),
}));
vi.mock('../hooks/useInvalidateCachesOnConnectionSwitch', () => ({
  useInvalidateCachesOnConnectionSwitch: () => {},
}));
/**
 * The disclosure stubbed as a MOUNT MARKER, deliberately.
 *
 * The real component decides for itself whether it has anything to show, from
 * a query this file does not stand up. What is under test here is the other
 * decision — whether `OnboardingGate` mounts it at all — so the stub renders
 * unconditionally and its count IS that decision. `outstanding` below is the
 * chapter's own input, and drives whether the run has a disclosure step.
 */
const disclosureState = { settled: true, outstanding: false };
vi.mock('../components/UsageTelemetryDisclosure', () => ({
  UsageTelemetryDisclosure: () => (
    <div data-testid="usage-telemetry-disclosure-modal" />
  ),
  UsageTelemetryDisclosureStep: ({ onAdvance }: { onAdvance: () => void }) => (
    <button
      type="button"
      data-testid="first-run-disclosure"
      onClick={onAdvance}
    >
      Keep usage telemetry on
    </button>
  ),
  useUsageTelemetryDisclosureState: () => disclosureState,
  dismissUsageTelemetryDisclosure: vi.fn(),
}));
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
  ToastProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({
    isTauri: false,
    target: 'web',
    isMobile: false,
    isDesktop: false,
    supervisesBundledServer: false,
  }),
  // OnboardingGate reads this; a mock missing it throws before any assertion
  // in this file runs, which is how all nine cases were red on origin/main.
  // undefined is the honest value here: these cases are a web target, which
  // never has a native bootstrap to recover.
  nativeProfileBootstrapRecoveryError: () => undefined,
}));
vi.mock('../platform/native/tauriInvoke', () => ({
  tauriInvoke: vi.fn(),
}));
vi.mock('../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => ({ status: null, restart: vi.fn() }),
}));
vi.mock('../lib/serverHealth', () => ({
  checkServerHealthDetailed: vi.fn(),
  checkHostCompatibility: vi.fn(),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate, pathname: '/' }),
}));
vi.mock('../components/PendingPairingReconciler', () => ({
  PendingPairingReconciler: () => null,
}));
vi.mock('@kontourai/station-connect', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-connect')>();
  return {
    ...actual,
    useConnections: () => ({
      apiBase: 'http://localhost:3242',
      activeConnection: {
        id: 'tailnet-station',
        name: 'Tailnet Station',
        credentialState: 'saved',
        url: 'http://localhost:3242',
      },
      connections: [],
    }),
    attemptLocalSelfProvisionOnce: vi.fn().mockResolvedValue(false),
    ConnectionManagerModal: () => null,
  };
});
// The chapter's own inputs. `ConfigContext` is substituted rather than the SDK
// beneath it so this file stays about the ONE seam it is testing: the shared
// setup store between the two overlays.
const configValue: { firstRun?: { status: string } } = {
  firstRun: { status: 'pending' },
};
vi.mock('../contexts/ConfigContext', () => ({
  useConfig: () => configValue,
  useConfigSettled: () => true,
  useConfigActions: () => ({
    updateConfig: vi.fn(),
    recordFirstRunDecision,
    isSaving: false,
  }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
  useAgentsLoaded: () => true,
  useAgentsSettled: () => true,
}));
vi.mock('@kontourai/station-sdk', () => ({
  authenticatedFetch: vi.fn(),
  useDevicePresentation: () => undefined,
  // The engines step's one enable path (archive#3627). Nothing here confirms
  // a batch; it exists so the step can mount.
  useMaterializeEngineAgentMutation: () => ({ mutateAsync: vi.fn() }),
  // #1559 gave detected-but-unconnected rows their own server path, and this
  // mock never grew it — so every case that reached the engines step threw
  // "No export is defined on the mock" and six tests here were red on `main`
  // rather than exercising the exclusivity rule they are named for.
  useConnectAndMaterializeEngineMutation: () => ({ mutateAsync: vi.fn() }),
  useForceRefetchSystemStatus: () => forceRefetch,
  useEngineConnectionsQuery: () => ({ data: [] }),
  useConfigQuery: () => ({ data: configValue, isFetching: false }),
  useUpdateConfigMutation: () => ({ mutate: () => {}, isPending: false }),
  FullScreenLoader: () => null,
  FullScreenError: () => null,
}));

import { FirstRunHomeChapter } from '../components/first-run/FirstRunHomeChapter';
import { OnboardingGate } from '../components/OnboardingGate';
import {
  firstRunChapterPresence,
  onboardingSetupStore,
} from '../contexts/onboarding-setup-store';
import { deviceSettingsStore } from '../lib/device-settings-store';

function status(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    prerequisites: [],
    acp: { connected: false, connections: [] },
    providers: {
      configuredChatReady: false,
      configured: [],
      detected: { ollama: false, bedrock: false },
    },
    clis: {},
    recommendation: {
      code: 'unconfigured',
      type: 'connections',
      actionLabel: 'Open Connections',
      title: 'No usable AI path is configured yet',
      detail: 'Add a provider connection to make Station ready.',
    },
    ready: false,
    ...overrides,
  } as SystemStatus;
}

/** Chat is ready, so `shouldShowSetupBanner` says the launcher is not needed. */
function readyStatus(): SystemStatus {
  return status({
    providers: {
      configuredChatReady: true,
      configured: [],
      detected: { ollama: false, bedrock: false },
    },
    ready: true,
  });
}

function renderBoth() {
  return render(
    <OnboardingGate>
      <FirstRunHomeChapter />
    </OnboardingGate>,
  );
}

function overlayCounts() {
  return {
    launcher: screen.queryAllByTestId('setup-launcher').length,
    chapter: screen.queryAllByTestId('first-run-engines').length,
    disclosure: screen.queryAllByTestId('usage-telemetry-disclosure-modal')
      .length,
  };
}

beforeEach(() => {
  globalThis.localStorage.clear();
  deviceSettingsStore.reloadFromStorage();
  onboardingSetupStore.reset();
  firstRunChapterPresence.set(false);
  configValue.firstRun = { status: 'pending' };
  disclosureState.settled = true;
  disclosureState.outstanding = false;
  navigate.mockReset();
  refetch.mockReset().mockResolvedValue(undefined);
  forceRefetch.mockReset().mockResolvedValue(undefined);
  recordFirstRunDecision.mockReset().mockResolvedValue(undefined);
  currentStatus = readyStatus();
});

describe('the two first-run overlays are mutually exclusive', () => {
  test('the probe flapping AFTER the chapter opens does not add a launcher', () => {
    const view = renderBoth();
    expect(overlayCounts()).toEqual({ launcher: 0, chapter: 1, disclosure: 0 });

    // `ready → cannot_verify`: exactly the transition the audit measured, and
    // the one that used to mount the launcher under the chapter's scrim.
    currentStatus = status();
    view.rerender(
      <OnboardingGate>
        <FirstRunHomeChapter />
      </OnboardingGate>,
    );

    expect(overlayCounts()).toEqual({ launcher: 0, chapter: 1, disclosure: 0 });
  });

  test('flapping back and forth never produces two', () => {
    const view = renderBoth();
    for (const next of [status(), readyStatus(), status(), readyStatus()]) {
      currentStatus = next;
      view.rerender(
        <OnboardingGate>
          <FirstRunHomeChapter />
        </OnboardingGate>,
      );
      const counts = overlayCounts();
      expect(counts.launcher + counts.chapter).toBe(1);
    }
  });

  test('closing the chapter hands the screen back to the launcher', () => {
    // The suppression is not a permanent silencing: a Station that genuinely
    // still needs connecting gets its launcher the moment the chapter is out
    // of the way.
    const view = renderBoth();
    currentStatus = status();
    view.rerender(
      <OnboardingGate>
        <FirstRunHomeChapter />
      </OnboardingGate>,
    );
    expect(overlayCounts()).toEqual({ launcher: 0, chapter: 1, disclosure: 0 });

    configValue.firstRun = { status: 'skipped' };
    screen.getByRole('button', { name: 'Not now' }).click();
    view.rerender(
      <OnboardingGate>
        <FirstRunHomeChapter />
      </OnboardingGate>,
    );

    expect(overlayCounts()).toEqual({ launcher: 1, chapter: 0, disclosure: 0 });
  });

  test('a launcher already up keeps the chapter from opening over it', () => {
    // The other direction of the same rule, integrated: this is what the
    // chapter's own auto-open gate is for.
    currentStatus = status();
    renderBoth();
    expect(overlayCounts()).toEqual({ launcher: 1, chapter: 0, disclosure: 0 });
  });
});

/**
 * THE THIRD OVERLAY. `OnboardingGate` renders the usage-telemetry disclosure
 * after its children, so wherever it renders it renders on top: on a fresh
 * home it landed over the first-run chapter (reproduced live — two modals on
 * first open) and on `origin/main` it lands over the setup launcher, which is
 * why the first-run E2E specs had to answer it before they could click
 * anything. On a `pending` home it is the chapter's first step instead; on
 * every other home it is what shipped, waiting its turn.
 */
describe('the usage-telemetry disclosure is the third overlay under the same rule', () => {
  test('a pending home shows it as a chapter STEP, never as its own modal', () => {
    disclosureState.outstanding = true;
    const view = renderBoth();

    expect(screen.queryAllByTestId('first-run-disclosure')).toHaveLength(1);
    expect(overlayCounts()).toEqual({
      launcher: 0,
      chapter: 0,
      disclosure: 0,
    });
    // Step one, and the engines step is genuinely behind it. FOUR, not
    // three: this home has recorded no engine role either, and #1575 put
    // that screen into the plan — the assertion had said three since, which
    // is why this case was red on `main`.
    expect(screen.getByText('Step 1 of 4')).toBeTruthy();
    screen.getByTestId('first-run-disclosure').click();
    view.rerender(
      <OnboardingGate>
        <FirstRunHomeChapter />
      </OnboardingGate>,
    );
    expect(screen.queryAllByTestId('first-run-engines')).toHaveLength(1);
    expect(screen.getByText('Step 2 of 4')).toBeTruthy();
  });

  test('a pending home is not offered the modal even with the chapter closed', () => {
    // THE DISCRIMINATING CASE for the `pending` rule, and the one a fault
    // injection found missing: while the chapter is up the modal is already
    // withheld by the one-overlay rule, so a test that only looks at an OPEN
    // chapter cannot tell the two reasons apart.
    //
    // A chapter that has just been closed is the gap that leaves. "Not now"
    // is fire-and-forget, so `firstRun` still reads `pending` until the write
    // lands and the config query refetches — and the launcher is not wanted
    // here either. Without the `pending` rule the modal takes that window and
    // fills the screen the instant the person dismissed the run.
    const view = renderBoth();
    expect(overlayCounts()).toEqual({
      launcher: 0,
      chapter: 1,
      disclosure: 0,
    });

    screen.getByRole('button', { name: 'Not now' }).click();
    view.rerender(
      <OnboardingGate>
        <FirstRunHomeChapter />
      </OnboardingGate>,
    );

    // Still `pending`: the durable write has not come back yet.
    expect(configValue.firstRun).toEqual({ status: 'pending' });
    expect(overlayCounts()).toEqual({
      launcher: 0,
      chapter: 0,
      disclosure: 0,
    });
  });

  test('an upgraded home keeps the standalone modal', () => {
    // No `firstRun` record at all: a home that predates the field, which is
    // the population the standalone modal was shipped for.
    configValue.firstRun = undefined;
    renderBoth();

    expect(overlayCounts()).toEqual({
      launcher: 0,
      chapter: 0,
      disclosure: 1,
    });
  });

  test('it waits for the setup launcher rather than covering it', () => {
    configValue.firstRun = undefined;
    currentStatus = status();
    const view = renderBoth();
    expect(overlayCounts()).toEqual({
      launcher: 1,
      chapter: 0,
      disclosure: 0,
    });

    // And it takes the screen the moment the launcher is answered.
    onboardingSetupStore.dismiss();
    view.rerender(
      <OnboardingGate>
        <FirstRunHomeChapter />
      </OnboardingGate>,
    );
    expect(overlayCounts()).toEqual({
      launcher: 0,
      chapter: 0,
      disclosure: 1,
    });
  });

  test('a chapter re-opened from Home’s card suppresses it while it is up', () => {
    // A deferred home carries BOTH: the card offers the run, and the modal is
    // mounted because the home is no longer `pending`. Opening the run from
    // the card must not leave the modal stacked on top of it.
    configValue.firstRun = { status: 'skipped' };
    const view = renderBoth();
    expect(overlayCounts()).toEqual({
      launcher: 0,
      chapter: 0,
      disclosure: 1,
    });

    screen.getByRole('button', { name: 'Set up Station' }).click();
    view.rerender(
      <OnboardingGate>
        <FirstRunHomeChapter />
      </OnboardingGate>,
    );
    expect(overlayCounts()).toEqual({
      launcher: 0,
      chapter: 1,
      disclosure: 0,
    });

    screen.getByRole('button', { name: 'Not now' }).click();
    view.rerender(
      <OnboardingGate>
        <FirstRunHomeChapter />
      </OnboardingGate>,
    );
    expect(overlayCounts()).toEqual({
      launcher: 0,
      chapter: 0,
      disclosure: 1,
    });
  });
});

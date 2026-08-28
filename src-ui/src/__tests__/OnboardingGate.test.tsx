/**
 * @vitest-environment jsdom
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SystemStatus } from '@kontourai/station-sdk';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { BannerHost } from '../components/notifications/BannerHost';
import { bannerStore } from '../contexts/banner-store';
import type { BundledServerStatus } from '../platform/native';

let currentStatus: SystemStatus | null = null;
let isLoading = false;
let isPending: boolean | undefined;
let isError = false;
let queryFailureReason: unknown = null;
let credentialState: 'saved' | 'required' = 'saved';
let lastSuccessAt: number | undefined;
let lastError:
  | {
      reason: 'authentication-failed' | 'unreachable' | 'awaiting-approval';
      at: number;
    }
  | undefined;
let activeConnectionUrl = 'http://localhost:3242';
let activeConnectionId = 'tailnet-station';
let connections: unknown[] = [];
let configData: any;
let bundledStatus: BundledServerStatus | null = null;
let platformProfile = {
  isTauri: false,
  target: 'web' as string,
  isMobile: false,
  isDesktop: false,
  supervisesBundledServer: false,
};
const navigate = vi.fn();
let currentPathname = '/';
const refetch = vi.fn();
const forceRefetch = vi.fn();
const restartBundledServerMock = vi.fn(() => Promise.resolve(true));
const toastMocks = vi.hoisted(() => ({ showToast: vi.fn() }));
let bootstrapRecoveryError: string | undefined;

vi.mock('../hooks/useSystemStatus', () => ({
  useSystemStatus: () => ({
    data: currentStatus,
    isLoading,
    isPending,
    isError,
    // archive#1818 1 : while `isConnectPending` is true
    // (still retrying), the real `@tanstack/query-core` reducer only ever
    // populates `failureReason` — `error` is set exclusively by the
    // `'error'` action, which simultaneously flips `status` to `'error'`
    // (making `isPending`/`isConnectPending` false). This mock therefore
    // exposes ONLY `failureReason` while pending, matching the real hook's
    // actual reachable state space — not the impossible
    // `isLoading: true` + `error` set combination the pre-fix test used.
    failureReason: queryFailureReason,
    refetch,
  }),
}));

// archive#1290: exercised in its own dedicated unit test
// (useInvalidateCachesOnConnectionSwitch.test.tsx) against a real
// QueryClient. This suite mocks every other dependency at the module
// boundary rather than wrapping in a QueryClientProvider, so mock this one
// away too instead of pulling react-query into every test here.
vi.mock('../hooks/useInvalidateCachesOnConnectionSwitch', () => ({
  useInvalidateCachesOnConnectionSwitch: () => {},
}));

// archive#2472: UsageTelemetryDisclosure reaches for a real QueryClient.
// Its consent behavior is covered in its own suite; this suite's contract
// (documented above) is module-boundary mocks, not a QueryClientProvider
// wrap — so mock the component away like every other cross-cutting dep.
vi.mock('../components/UsageTelemetryDisclosure', () => ({
  UsageTelemetryDisclosure: () => null,
}));

// Provider ordering is covered against the real application entrypoint in
// main-provider-order.test.ts. This component suite isolates onboarding
// behavior from the toast implementation while retaining the hook contract.
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: toastMocks.showToast }),
}));

// archive#1715: the local self-authorization effect calls
// `nativeProfileRepository` whenever `platformProfile.isDesktop` is true —
// every desktop-supervision case in this file. Returning `undefined` from
// `pendingLocalSelfProvisionProfileName` keeps the effect a no-op for every
// test here that isn't specifically about it.
const pendingLocalSelfProvisionProfileNameMock = vi.fn(
  (): string | undefined => undefined,
);
const nativeProfileRefreshMock = vi.fn(() => Promise.resolve(false));
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => platformProfile,
  nativeProfileBootstrapRecoveryError: () => bootstrapRecoveryError,
  nativeProfileRepository: () => ({
    pendingLocalSelfProvisionProfileName:
      pendingLocalSelfProvisionProfileNameMock,
    refresh: nativeProfileRefreshMock,
  }),
}));

const attemptLocalSelfProvisionOnceMock = vi.fn(
  (): Promise<boolean> => Promise.resolve(false),
);
vi.mock('../platform/native/tauriInvoke', () => ({
  invokeTauri: vi.fn(),
}));

vi.mock('../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => bundledStatus,
  restartBundledServer: () => restartBundledServerMock(),
}));

vi.mock('../lib/serverHealth', () => ({
  checkServerHealth: vi.fn(),
  checkServerHealthDetailed: vi.fn(),
}));

// archive#1776 — this used to mock `connectionFailureCopy`
// itself with a canned `(reason: string) =>...` shape that ignores every
// argument beyond `reason`. `OnboardingGate` threads real `host`/`address`
// arguments through it (`activeConnection.name || apiBase`,
// `activeConnection.url`) and excludes the `awaiting-approval` reason before
// ever calling it — none of which a mock that never looks at its arguments
// can observe. Using the REAL `connectionFailureCopy` (via
// `importOriginal`, keeping every other export mocked) means the tests below
// assert on the actual rendered host/address text, the same pattern
// `ConnectionListPanel.test.tsx` already uses for this function.
vi.mock('@kontourai/station-connect', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-connect')>();
  return {
    ...actual,
    useConnections: () => ({
      apiBase: 'http://localhost:3242',
      activeConnection: {
        id: activeConnectionId,
        name: 'Tailnet Station',
        credentialState,
        lastSuccessAt,
        lastError,
        url: activeConnectionUrl,
      },
      connections,
    }),
    attemptLocalSelfProvisionOnce: (
      ...args: Parameters<typeof attemptLocalSelfProvisionOnceMock>
    ) => attemptLocalSelfProvisionOnceMock(...args),
    ConnectionManagerModal: ({
      isOpen,
      initialPanel,
      onRestartInjectedConnection,
    }: {
      isOpen: boolean;
      initialPanel?: string;
      onRestartInjectedConnection?: () => void;
    }) =>
      isOpen ? (
        <div data-testid="connection-manager">
          Connection manager: {initialPanel ?? 'list'}
          {onRestartInjectedConnection && (
            <button
              type="button"
              data-testid="cm-restart-injected"
              onClick={() => onRestartInjectedConnection()}
            >
              restart
            </button>
          )}
        </div>
      ) : null,
  };
});

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    navigate,
    pathname: currentPathname,
  }),
}));

// The reconciler owns the network exchange, which this suite has no business
// running. Substituting it lets a test drive the one thing OnboardingGate
// actually decides: what the shell shows once a request reaches a terminal
// outcome. `null` (the default) keeps every other test's reconciler inert.
let pairingReconcilerOutcome: { title: string; message: string } | null = null;
vi.mock('../components/PendingPairingReconciler', async () => {
  const { useEffect } = await import('react');
  return {
    PendingPairingReconciler: ({
      enabled,
      onTerminalFailure,
    }: {
      enabled: boolean;
      onTerminalFailure: (title: string, message: string) => void;
    }) => {
      useEffect(() => {
        if (!enabled || !pairingReconcilerOutcome) return;
        onTerminalFailure(
          pairingReconcilerOutcome.title,
          pairingReconcilerOutcome.message,
        );
      }, [enabled]);
      return null;
    },
  };
});

vi.mock('@kontourai/station-sdk', () => ({
  authenticatedFetch: vi.fn(),
  useForceRefetchSystemStatus: () => forceRefetch,
  // archive#1194: EnginePicker (rendered when the engine-picker variant
  // applies) reads these — empty/no-op defaults keep every other test in
  // this file (none of which exercise the picker's own behavior) unaffected.
  useAgentConnectionsQuery: () => ({ data: [] }),
  useConfigQuery: () => ({ data: configData }),
  useUpdateConfigMutation: () => ({
    mutate: () => {},
    isPending: false,
  }),
  FullScreenLoader: ({
    label,
    message,
    action,
  }: {
    label?: string;
    message?: string;
    action?: ReactNode;
  }) => (
    <div>
      {message ?? label}
      {action}
    </div>
  ),
  FullScreenError: ({
    title,
    description,
    detail,
    onRetry,
    retryLabel,
    secondaryAction,
    actions,
  }: {
    title: string;
    description?: string;
    detail?: string;
    onRetry?: () => void;
    retryLabel?: string;
    secondaryAction?: { label: string; onClick: () => void };
    actions?: {
      label: string;
      onClick: () => void;
      variant?: 'primary' | 'secondary';
    }[];
  }) => (
    <div>
      <div>{title}</div>
      {description && <div>{description}</div>}
      {detail && <pre>{detail}</pre>}
      {actions ? (
        actions.map((action) => (
          <button type="button" key={action.label} onClick={action.onClick}>
            {action.label}
          </button>
        ))
      ) : (
        <>
          {onRetry && (
            <button type="button" onClick={onRetry}>
              {retryLabel}
            </button>
          )}
          {secondaryAction && (
            <button type="button" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </button>
          )}
        </>
      )}
    </div>
  ),
}));

import { OnboardingGate } from '../components/OnboardingGate';
import { onboardingSetupStore } from '../contexts/onboarding-setup-store';
import {
  OPEN_CONNECTIONS_MODAL_EVENT,
  openConnectionsModal,
} from '../lib/connectionModalEvents';
import { deviceSettingsStore } from '../lib/device-settings-store';

function createStatus(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    prerequisites: [],
    acp: {
      connected: false,
      connections: [],
    },
    providers: {
      configuredChatReady: false,
      configured: [],
      detected: {
        ollama: false,
        bedrock: false,
      },
    },
    clis: {},
    recommendation: {
      code: 'unconfigured',
      type: 'connections',
      actionLabel: 'Open Connections',
      title: 'No usable AI path is configured yet',
      detail:
        'Start Ollama locally or add a provider/runtime connection to make Station ready for first-run chat.',
    },
    ready: false,
    ...overrides,
  };
}

describe('OnboardingGate', () => {
  beforeEach(() => {
    bannerStore.reset();
    globalThis.localStorage.clear();
    currentStatus = createStatus();
    isLoading = false;
    isPending = undefined;
    isError = false;
    queryFailureReason = null;
    credentialState = 'saved';
    lastSuccessAt = undefined;
    lastError = undefined;
    activeConnectionUrl = 'http://localhost:3242';
    activeConnectionId = 'tailnet-station';
    connections = [];
    // archive#1194: resolved, no explicit choice yet — the
    // representative "config has loaded" default for every existing test
    // in this file (none of which exercise the picker's own gating).
    configData = {};
    bundledStatus = null;
    platformProfile = {
      isTauri: false,
      target: 'web',
      isMobile: false,
      isDesktop: false,
      supervisesBundledServer: false,
    };
    navigate.mockReset();
    refetch.mockReset();
    // The real refetch (react-query) always returns a promise; a bare mockReset
    // leaves it undefined, which is not a state the component can ever see.
    refetch.mockResolvedValue(undefined);
    forceRefetch.mockReset();
    forceRefetch.mockResolvedValue(undefined);
    restartBundledServerMock.mockReset();
    restartBundledServerMock.mockResolvedValue(true);
    onboardingSetupStore.reset();
    currentPathname = '/';
    pendingLocalSelfProvisionProfileNameMock.mockReset();
    pendingLocalSelfProvisionProfileNameMock.mockReturnValue(undefined);
    nativeProfileRefreshMock.mockReset();
    nativeProfileRefreshMock.mockResolvedValue(false);
    attemptLocalSelfProvisionOnceMock.mockReset();
    attemptLocalSelfProvisionOnceMock.mockResolvedValue(false);
    pairingReconcilerOutcome = null;
    bootstrapRecoveryError = undefined;
    toastMocks.showToast.mockReset();
  });

  function chatReadyStatus(): SystemStatus {
    return createStatus({
      providers: {
        configuredChatReady: true,
        configured: [],
        detected: { ollama: false, bedrock: false },
      },
      ready: true,
    });
  }

  test('reports each desktop bootstrap recovery error once per component lifetime', async () => {
    platformProfile = {
      ...platformProfile,
      isTauri: true,
      isDesktop: true,
      target: 'macos',
    };
    bootstrapRecoveryError = 'The local credential could not be stored.';
    const { rerender } = render(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );
    await waitFor(() =>
      expect(toastMocks.showToast).toHaveBeenCalledWith(
        'The local credential could not be stored.',
      ),
    );
    platformProfile = { ...platformProfile, isDesktop: false };
    rerender(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );
    expect(toastMocks.showToast).toHaveBeenCalledTimes(1);

    // This makes the effect run again with the SAME terminal error. Without
    // the ref guard it would report a duplicate when desktop returns.
    platformProfile = { ...platformProfile, isDesktop: true };
    rerender(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );
    expect(toastMocks.showToast).toHaveBeenCalledTimes(1);

    bootstrapRecoveryError = 'The replacement credential could not be stored.';
    rerender(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );
    await waitFor(() => expect(toastMocks.showToast).toHaveBeenCalledTimes(2));
    expect(toastMocks.showToast).toHaveBeenLastCalledWith(
      'The replacement credential could not be stored.',
    );
  });

  test('does not report a bootstrap recovery error outside desktop', async () => {
    bootstrapRecoveryError = 'The local credential could not be stored.';
    render(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(toastMocks.showToast).not.toHaveBeenCalled();
  });

  test('refetches status when the active connection records new success evidence', () => {
    currentStatus = null;
    const { rerender } = render(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );

    expect(refetch).not.toHaveBeenCalled();
    lastSuccessAt = Date.now();
    rerender(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test('refetches status when rejected credentials are replaced', () => {
    currentStatus = null;
    credentialState = 'required';
    const { rerender } = render(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );

    expect(refetch).not.toHaveBeenCalled();
    credentialState = 'saved';
    rerender(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test('keeps the first-run launcher dismissed when recommendations change', () => {
    const { rerender } = render(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );

    expect(screen.getByTestId('setup-launcher')).toBeTruthy();
    expect(screen.getByText('Choose what powers Station')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Dismiss setup launcher'));
    expect(screen.queryByTestId('setup-launcher')).toBeNull();

    currentStatus = createStatus({
      providers: {
        configuredChatReady: false,
        configured: [],
        detected: {
          ollama: true,
          bedrock: false,
        },
      },
      recommendation: {
        code: 'detected-provider',
        type: 'providers',
        actionLabel: 'Add Ollama connection',
        title: 'Ollama is available',
        detail:
          'Create a model connection for the detected local Ollama server to make first-run chat explicit.',
        detectedProviderType: 'ollama',
        detectedProviderLabel: 'Ollama',
      },
    });

    rerender(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );

    expect(screen.queryByTestId('setup-launcher')).toBeNull();
    expect(screen.getByText('App')).toBeTruthy();
  });

  test('keeps the first-run reminder non-blocking for the current app surface', () => {
    const onUnderlyingAction = vi.fn();
    render(
      <OnboardingGate>
        <button type="button" onClick={onUnderlyingAction}>
          Install plugin
        </button>
      </OnboardingGate>,
    );

    expect(screen.getByTestId('setup-launcher').tagName).toBe('ASIDE');
    expect(
      document.querySelector('.onboarding-setup-launcher__backdrop'),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Install plugin' }));
    expect(onUnderlyingAction).toHaveBeenCalledOnce();
  });

  test('does not cover visible provider actions on the 390px connections route', () => {
    currentPathname = '/connections/providers';
    const onAddProvider = vi.fn();
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });

    render(
      <OnboardingGate>
        <button type="button" onClick={onAddProvider}>
          Add provider
        </button>
      </OnboardingGate>,
    );

    expect(screen.queryByTestId('setup-launcher')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    expect(onAddProvider).toHaveBeenCalledOnce();
  });

  test('routes setup actions to provider setup instead of the server connection modal', () => {
    render(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );

    fireEvent.click(screen.getByText('Open Connections'));

    expect(navigate).toHaveBeenCalledWith('/connections/models');
    expect(screen.queryByTestId('setup-launcher')).toBeNull();
    expect(screen.queryByText('Connection manager')).toBeNull();
  });

  // archive#794: the launcher used to record a *persisted* dismissal when the user
  // navigated to Connections to do the setup, so it vanished for good — while
  // Connections still read "chat: setup needed" and its own copy promised it
  // "disappears automatically once chat is ready".
  test('navigating to Connections defers the launcher without recording a dismissal', () => {
    render(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );

    fireEvent.click(screen.getByText('Open Connections'));

    expect(screen.queryByTestId('setup-launcher')).toBeNull();
    expect(deviceSettingsStore.get('onboardingSetupDismissed')).toBe(false);
  });

  test('the explicit dismiss action still records a persisted dismissal', () => {
    render(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );

    fireEvent.click(screen.getByLabelText('Dismiss setup launcher'));

    expect(screen.queryByTestId('setup-launcher')).toBeNull();
    // Dismissal now persists through the device-settings store (archive#
    // settings-revamp) rather than its own raw localStorage key.
    expect(deviceSettingsStore.get('onboardingSetupDismissed')).toBe(true);
  });

  // archive#794: a deferral covers the trip into Connections. Leaving that
  // area without finishing setup must bring the launcher back, or the same
  // "gone while chat is still unready" complaint returns, session-scoped.
  test('re-arms the launcher when the user leaves the Connections area', async () => {
    const { rerender } = render(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );

    fireEvent.click(screen.getByText('Open Connections'));
    expect(screen.queryByTestId('setup-launcher')).toBeNull();

    currentPathname = '/connections/providers';
    rerender(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );
    expect(screen.queryByTestId('setup-launcher')).toBeNull();

    currentPathname = '/';
    rerender(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );
    await act(async () => {
      await refetch.mock.results.at(-1)?.value;
    });
    expect(screen.getByTestId('setup-launcher')).toBeTruthy();
  });

  test('keeps one connection modal owner above the app shell', () => {
    currentStatus = chatReadyStatus();
    render(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );

    fireEvent(window, new Event(OPEN_CONNECTIONS_MODAL_EVENT));

    expect(screen.getByText('Connection manager: list')).toBeTruthy();
  });

  test('consumes a connection request emitted before the deferred owner mounts', () => {
    currentStatus = chatReadyStatus();
    openConnectionsModal({ mode: 'pair-device' });

    render(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );

    expect(screen.getByText('Connection manager: pair-device')).toBeTruthy();
  });

  test('keeps the app usable without a setup overlay when a runtime is available', () => {
    currentStatus = createStatus({
      recommendation: {
        code: 'runtime-only',
        type: 'runtimes',
        actionLabel: 'Review runtimes',
        title: 'An engine is available before chat is configured',
        detail:
          'Connected runtimes are detectable, but there is still no explicit chat-capable model connection configured.',
      },
      clis: {
        codex: true,
      },
    });

    render(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );

    expect(screen.getByText('App')).toBeTruthy();
    expect(screen.queryByTestId('setup-launcher')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  describe('station#1194 review round 2 (MEDIUM): engine picker re-prompt gate', () => {
    function readyStatus(): SystemStatus {
      return createStatus({
        providers: {
          configuredChatReady: true,
          configured: [
            {
              id: 'bedrock-default',
              type: 'bedrock',
              enabled: true,
              capabilities: ['llm'],
            },
          ],
          detected: { ollama: false, bedrock: true },
        },
        recommendation: {
          code: 'configured-chat-ready',
          type: 'providers',
          actionLabel: 'Review model connections',
          title: 'A chat-capable model connection is already configured',
          detail: 'Station can already route chat through bedrock.',
        },
        ready: true,
      });
    }

    test('does not block a truly-unchosen ready system with another picker', () => {
      currentStatus = readyStatus();
      configData = {}; // resolved, no explicit choice yet

      render(
        <OnboardingGate>
          <div>App</div>
        </OnboardingGate>,
      );

      expect(screen.queryByTestId('engine-picker')).toBeNull();
      expect(screen.getByText('App')).toBeTruthy();
    });

    test('does not block the mobile chat surface with the engine picker', () => {
      currentStatus = readyStatus();
      configData = {};
      platformProfile = {
        isTauri: true,
        target: 'ios',
        isMobile: true,
        isDesktop: false,
        supervisesBundledServer: false,
      };
      connections = [
        {
          id: 'saved-lan',
          endpoints: [{ id: 'endpoint-1', kind: 'lan-http' }],
          selectedEndpointId: 'endpoint-1',
          environmentId: null,
        },
      ];

      render(
        <OnboardingGate>
          <div>App</div>
        </OnboardingGate>,
      );

      expect(screen.queryByTestId('engine-picker')).toBeNull();
      expect(screen.getByText('App')).toBeTruthy();
    });

    test.each([
      '/registry/plugins',
      '/plugins',
      '/skills',
      '/agents',
      '/settings',
      '/profile',
      '/projects/example',
      '/projects/example/edit',
    ])(
      'does not interrupt the %s workflow with the default-engine picker',
      (pathname) => {
        currentStatus = readyStatus();
        configData = {}; // resolved, no explicit choice yet
        currentPathname = pathname;
        const onUnderlyingAction = vi.fn();

        render(
          <OnboardingGate>
            <button type="button" onClick={onUnderlyingAction}>
              Continue workflow
            </button>
          </OnboardingGate>,
        );

        expect(screen.queryByTestId('engine-picker')).toBeNull();
        fireEvent.click(
          screen.getByRole('button', { name: 'Continue workflow' }),
        );
        expect(onUnderlyingAction).toHaveBeenCalledOnce();
      },
    );

    test('does NOT re-show the picker once builtinAgentEngineConnectionId is already set — even with no local dismiss recorded', () => {
      currentStatus = readyStatus();
      configData = { builtinAgentEngineConnectionId: 'codex-runtime' };

      render(
        <OnboardingGate>
          <div>App</div>
        </OnboardingGate>,
      );

      expect(screen.queryByTestId('engine-picker')).toBeNull();
      expect(screen.getByText('App')).toBeTruthy();
    });

    test('does NOT re-show the picker when the explicit choice is Station itself (persisted null)', () => {
      currentStatus = readyStatus();
      configData = { builtinAgentEngineConnectionId: null };

      render(
        <OnboardingGate>
          <div>App</div>
        </OnboardingGate>,
      );

      expect(screen.queryByTestId('engine-picker')).toBeNull();
    });

    test('does NOT show the picker while config is still resolving (avoids a flash-then-hide)', () => {
      currentStatus = readyStatus();
      configData = undefined;

      render(
        <OnboardingGate>
          <div>App</div>
        </OnboardingGate>,
      );

      expect(screen.queryByTestId('engine-picker')).toBeNull();
      expect(screen.getByText('App')).toBeTruthy();
    });

    test('keeps the first-run picker on Home so it cannot block Settings', () => {
      currentStatus = readyStatus();
      configData = {};
      currentPathname = '/settings';

      render(
        <OnboardingGate>
          <div>App</div>
        </OnboardingGate>,
      );

      expect(screen.queryByTestId('engine-picker')).toBeNull();
      expect(screen.getByText('App')).toBeTruthy();
    });
  });

  test('defers the setup launcher when opening all connections', () => {
    render(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );

    fireEvent.click(screen.getByText('View All Connections'));

    expect(navigate).toHaveBeenCalledWith('/connections');
    expect(screen.queryByTestId('setup-launcher')).toBeNull();
  });

  test("routes an engine attention action to that engine's Agent Apps configuration", () => {
    currentStatus = createStatus({
      externalEngines: [
        {
          engineId: engineId('codex'),
          name: 'Codex',
          engineConnectionId: engineConnectionId('codex'),
          detected: true,
          ready: false,
          source: null,
          reason: 'sign_in_required',
        },
      ],
    });
    render(
      <OnboardingGate>
        <div>App</div>
      </OnboardingGate>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Codex' }));
    expect(navigate).toHaveBeenCalledWith('/connections/engines/codex');
  });

  test('does not inject optional knowledge setup into the app shell', () => {
    currentStatus = chatReadyStatus();

    render(
      <OnboardingGate>
        <button type="button">Underlying app action</button>
      </OnboardingGate>,
    );

    expect(screen.queryByTestId('setup-launcher')).toBeNull();
    expect(screen.queryByTestId('knowledge-nudge')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Underlying app action' }),
    ).toBeTruthy();
  });

  test('surfaces one credential reconnect action after a protected request is rejected', async () => {
    currentStatus = chatReadyStatus();
    credentialState = 'required';

    render(
      <OnboardingGate>
        <div>App</div>
        <BannerHost />
      </OnboardingGate>,
    );

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Request access to reconnect to Tailnet Station/i,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    expect(screen.getByText('Connection manager: list')).toBeTruthy();
  });

  test('keeps the connected shell mounted while a newly selected connection needs credentials', async () => {
    currentStatus = chatReadyStatus();
    const { rerender } = render(
      <OnboardingGate>
        <div>App shell</div>
        <BannerHost />
      </OnboardingGate>,
    );

    currentStatus = null;
    credentialState = 'required';
    rerender(
      <OnboardingGate>
        <div>App shell</div>
        <BannerHost />
      </OnboardingGate>,
    );

    expect(screen.getByText('App shell')).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Request access to reconnect to Tailnet Station/i,
    );
    expect(screen.queryByText('Pair this device to a Station')).toBeNull();
  });

  test('keeps the connected shell mounted while a new connection status loads', () => {
    currentStatus = chatReadyStatus();
    const { rerender } = render(
      <OnboardingGate>
        <div>App shell</div>
      </OnboardingGate>,
    );

    currentStatus = null;
    isLoading = true;
    rerender(
      <OnboardingGate>
        <div>App shell</div>
      </OnboardingGate>,
    );

    expect(screen.getByText('App shell')).toBeTruthy();
    expect(screen.queryByText('Station')).toBeNull();
  });

  test('preserves shell and modal identity across loading and credential repair states', () => {
    currentStatus = chatReadyStatus();
    const { rerender } = render(
      <OnboardingGate>
        <div data-testid="app-shell-node">App shell</div>
      </OnboardingGate>,
    );
    fireEvent(window, new Event(OPEN_CONNECTIONS_MODAL_EVENT));
    const shellNode = screen.getByTestId('app-shell-node');
    const modalNode = screen.getByTestId('connection-manager');

    currentStatus = null;
    isLoading = true;
    rerender(
      <OnboardingGate>
        <div data-testid="app-shell-node">App shell</div>
      </OnboardingGate>,
    );
    expect(screen.getByTestId('app-shell-node')).toBe(shellNode);
    expect(screen.getByTestId('connection-manager')).toBe(modalNode);

    isLoading = false;
    credentialState = 'required';
    rerender(
      <OnboardingGate>
        <div data-testid="app-shell-node">App shell</div>
      </OnboardingGate>,
    );
    expect(screen.getByTestId('app-shell-node')).toBe(shellNode);
    expect(screen.getByTestId('connection-manager')).toBe(modalNode);
  });

  test('wires the local-server Restart handler into the steady-state modal on a supervising desktop', () => {
    // The catch-all modal (reached once connected / after a remote pairs) is
    // exactly the PR's headline scenario: paired remote → local server later
    // fails. It must carry the restart affordance too.
    platformProfile = {
      isTauri: true,
      target: 'macos',
      isMobile: false,
      isDesktop: true,
      supervisesBundledServer: true,
    };
    // A real saved remote is present (the headline scenario: paired remote →
    // local server later fails), so the gate skips the supervisor-phase screen
    // and reaches the steady-state catch-all modal.
    connections = [
      {
        id: 'remote',
        name: 'Paired Station',
        environmentId: 'env-1',
        endpoints: [],
        selectedEndpointId: '',
      },
    ];
    currentStatus = chatReadyStatus();
    // The status the real scenario carries. This fixture used to be omitted
    // entirely, leaving it null — which happened to pass while the handler
    // was gated on `supervisesBundledServer` alone. It is now also gated on
    // sidecar ownership (the command refuses for any other owner), so the
    // test has to say who owns the home, the same as the app does.
    bundledStatus = {
      phase: 'failed',
      attempt: 5,
      maxAttempts: 5,
      apiBase: null,
      port: null,
      lastExitCode: 1,
      nextRetryInMs: null,
      logPath: '/tmp/station-server.log',
      ownership: 'sidecar',
      canRunInBackground: true,
      failClosed: false,
      message: '',
    };

    render(
      <OnboardingGate>
        <div>App shell</div>
      </OnboardingGate>,
    );
    fireEvent(window, new Event(OPEN_CONNECTIONS_MODAL_EVENT));

    const restart = screen.getByTestId('cm-restart-injected');
    fireEvent.click(restart);
    expect(restartBundledServerMock).toHaveBeenCalledTimes(1);
    // A restart that genuinely reached the host and succeeded has nothing to
    // report — the toast stays quiet.
    expect(toastMocks.showToast).not.toHaveBeenCalled();
  });

  /**
   * archive#4475 — `restartBundledServer`'s own doc comment says the boolean
   * exists "so the recovery screen can tell the user when it didn't [reach
   * the host]", but both callers of it discarded that boolean with a bare
   * `void restartBundledServer;` — a dangling proxy (tailscale serve → a
   * port nothing owns) makes the restart POST fail, and the button read as
   * dead: no error, no re-enable, nothing. This is the mechanism check: a
   * failed restart must surface visibly and the control must remain
   * re-tappable (never disabled, so nothing to assert there beyond the
   * click firing again below).
   */
  test('surfaces a visible failure when the restart request does not reach the host', async () => {
    platformProfile = {
      isTauri: true,
      target: 'macos',
      isMobile: false,
      isDesktop: true,
      supervisesBundledServer: true,
    };
    connections = [
      {
        id: 'remote',
        name: 'Paired Station',
        environmentId: 'env-1',
        endpoints: [],
        selectedEndpointId: '',
      },
    ];
    currentStatus = chatReadyStatus();
    bundledStatus = {
      phase: 'failed',
      attempt: 5,
      maxAttempts: 5,
      apiBase: null,
      port: null,
      lastExitCode: 1,
      nextRetryInMs: null,
      logPath: '/tmp/station-server.log',
      ownership: 'sidecar',
      canRunInBackground: true,
      failClosed: false,
      message: '',
    };
    restartBundledServerMock.mockResolvedValue(false);

    render(
      <OnboardingGate>
        <div>App shell</div>
      </OnboardingGate>,
    );
    fireEvent(window, new Event(OPEN_CONNECTIONS_MODAL_EVENT));

    const restart = screen.getByTestId('cm-restart-injected');
    fireEvent.click(restart);

    await waitFor(() => expect(toastMocks.showToast).toHaveBeenCalledTimes(1));
    expect(toastMocks.showToast.mock.calls[0]?.[0]).toMatch(
      /couldn.t restart/i,
    );
    // archive#4512: sticky until dismissed — a 5s default would
    // vanish this toast, "Try again" and all, while the reader was still
    // reading the first sentence of a restart failure.
    expect(toastMocks.showToast.mock.calls[0]?.[2]).toBe(0);
    // Re-tappable: nothing about the control (never disabled to begin with)
    // stops a second attempt from reaching the same request again.
    fireEvent.click(restart);
    expect(restartBundledServerMock).toHaveBeenCalledTimes(2);
  });

  /**
   * archive#4512 — a prior round claimed "re-tappable" evidence
   * by re-clicking the ORIGINAL restart control, which never exercises the
   * toast's own retry action at all. A reviewer's that
   * deleted the whole `actions` argument from the `showToast` call stayed
   * green against all 79 tests in this file, because nothing invoked it.
   * This drives the action's `onClick` directly, the way a reader clicking
   * "Try again" IN THE TOAST (not back on the original control) would.
   */
  test('the failure toast carries a working Try again action that retries the same request', async () => {
    // archive#4512 — this used to assert the ARGUMENT passed to
    // the mocked `showToast` (`calls[0][2] === 0`), which proved nothing
    // about the actual toast: the real store's `duration: 0` new-toast path
    // scheduled `setTimeout(dismiss, 0)` regardless, dismissing the toast on
    // the very next macrotask. Delegating the mock to the REAL toastStore
    // and running its timers is the effect test that catches that — an
    // argument assertion cannot.
    const { toastStore: realToastStore } = await vi.importActual<
      typeof import('../contexts/ToastContext')
    >('../contexts/ToastContext');
    toastMocks.showToast.mockImplementation(
      (
        message: string,
        sessionId?: string,
        duration?: number,
        actions?: unknown,
      ) =>
        realToastStore.show(
          message,
          sessionId,
          duration,
          actions as Parameters<typeof realToastStore.show>[3],
        ),
    );
    realToastStore.dismissAll();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    platformProfile = {
      isTauri: true,
      target: 'macos',
      isMobile: false,
      isDesktop: true,
      supervisesBundledServer: true,
    };
    connections = [
      {
        id: 'remote',
        name: 'Paired Station',
        environmentId: 'env-1',
        endpoints: [],
        selectedEndpointId: '',
      },
    ];
    currentStatus = chatReadyStatus();
    bundledStatus = {
      phase: 'failed',
      attempt: 5,
      maxAttempts: 5,
      apiBase: null,
      port: null,
      lastExitCode: 1,
      nextRetryInMs: null,
      logPath: '/tmp/station-server.log',
      ownership: 'sidecar',
      canRunInBackground: true,
      failClosed: false,
      message: '',
    };
    restartBundledServerMock.mockResolvedValue(false);

    try {
      render(
        <OnboardingGate>
          <div>App shell</div>
        </OnboardingGate>,
      );
      fireEvent(window, new Event(OPEN_CONNECTIONS_MODAL_EVENT));
      fireEvent.click(screen.getByTestId('cm-restart-injected'));

      await waitFor(() =>
        expect(toastMocks.showToast).toHaveBeenCalledTimes(1),
      );
      expect(restartBundledServerMock).toHaveBeenCalledTimes(1);

      // The EFFECT, from the real store — not the mocked call's arguments.
      const toastBefore = realToastStore
        .getSnapshot()
        .find((t) => t.message.match(/couldn.t restart/i));
      expect(
        toastBefore,
        'restart-failure toast never reached the real store',
      ).toBeTruthy();

      // Run every timer the store scheduled. A `duration: 0` toast must
      // still be present after this — the exact case broke.
      act(() => {
        vi.runAllTimers();
      });
      const toastAfter = realToastStore
        .getSnapshot()
        .find((t) => t.message.match(/couldn.t restart/i));
      expect(
        toastAfter,
        'the restart-failure toast auto-dismissed despite duration: 0',
      ).toBeTruthy();

      const actions = toastAfter?.actions as
        | Array<{ label: string; onClick: () => void }>
        | undefined;
      expect(actions).toHaveLength(1);
      expect(actions?.[0]?.label).toBe('Try again');

      // Invoke the action itself — not a re-click of the original control.
      actions?.[0]?.onClick();
      expect(restartBundledServerMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      realToastStore.dismissAll();
    }
  });

  test('withholds the modal Restart handler when the sidecar does not own the home', () => {
    // The negative the gate exists for, and the one nothing asserted: a
    // service-owned (or unowned) home refuses restart_bundled_server, so
    // offering the control routes the user to a button that does nothing.
    platformProfile = {
      isTauri: true,
      target: 'macos',
      isMobile: false,
      isDesktop: true,
      supervisesBundledServer: true,
    };
    connections = [
      {
        id: 'remote',
        name: 'Paired Station',
        environmentId: 'env-1',
        endpoints: [],
        selectedEndpointId: '',
      },
    ];
    currentStatus = chatReadyStatus();
    bundledStatus = {
      phase: 'stopped',
      attempt: 0,
      maxAttempts: 5,
      apiBase: null,
      port: 38141,
      lastExitCode: null,
      nextRetryInMs: null,
      logPath: '/tmp/station-server.log',
      ownership: 'service',
      canRunInBackground: true,
      failClosed: false,
      message: 'A durable Station service owns this home.',
    };

    render(
      <OnboardingGate>
        <div>App shell</div>
      </OnboardingGate>,
    );
    fireEvent(window, new Event(OPEN_CONNECTIONS_MODAL_EVENT));

    expect(screen.queryByTestId('cm-restart-injected')).toBeNull();
  });

  test('does not pass a restart handler to the steady-state modal when the desktop does not supervise', () => {
    // Web/mobile parity: no bundled server, so nothing to restart from here.
    currentStatus = chatReadyStatus();

    render(
      <OnboardingGate>
        <div>App shell</div>
      </OnboardingGate>,
    );
    fireEvent(window, new Event(OPEN_CONNECTIONS_MODAL_EVENT));

    expect(screen.getByTestId('connection-manager')).toBeTruthy();
    expect(screen.queryByTestId('cm-restart-injected')).toBeNull();
  });

  test('keeps initial credential repair inside the shell banner', async () => {
    currentStatus = null;
    credentialState = 'required';

    render(
      <OnboardingGate>
        <div>App</div>
        <BannerHost />
      </OnboardingGate>,
    );

    expect(screen.getByText('App')).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Request access to reconnect to Tailnet Station/,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    expect(screen.getByText('Connection manager: list')).toBeTruthy();
  });

  test('keeps the mobile shell available and launches connection management before a real host is saved', async () => {
    platformProfile = {
      isTauri: true,
      target: 'ios',
      isMobile: true,
      isDesktop: false,
      supervisesBundledServer: false,
    };
    currentStatus = null;

    render(
      <OnboardingGate>
        <div>App</div>
        <BannerHost />
      </OnboardingGate>,
    );

    expect(screen.getByText('App')).toBeTruthy();
    expect(await screen.findByText('No Station connected')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Connect to a Station' }),
    );
    expect(screen.getByText('Connection manager: list')).toBeTruthy();
  });

  test('keeps the mobile shell available for a saved host that is offline before first success', () => {
    platformProfile = {
      isTauri: true,
      target: 'android',
      isMobile: true,
      isDesktop: false,
      supervisesBundledServer: false,
    };
    connections = [
      {
        id: 'saved-lan',
        name: 'Tailnet Station',
        url: 'http://localhost:3242',
        endpoints: [{ id: 'endpoint-1', kind: 'lan-http' }],
        selectedEndpointId: 'endpoint-1',
        environmentId: null,
      },
    ];
    currentStatus = null;

    render(
      <OnboardingGate>
        <div>App</div>
        <BannerHost />
      </OnboardingGate>,
    );

    expect(screen.getByText('App')).toBeTruthy();
    expect(screen.queryByText('Connect to your Station host')).toBeNull();
    expect(screen.queryByText("Can't reach server")).toBeNull();
  });

  test('keeps the shell available and discloses a live pairing approval wait', async () => {
    platformProfile = {
      isTauri: false,
      target: 'web',
      isMobile: true,
      isDesktop: false,
      supervisesBundledServer: false,
    };
    activeConnectionUrl = 'http://localhost:3242';
    connections = [
      {
        id: 'saved-lan',
        name: 'Tailnet Station',
        url: 'http://localhost:3242',
        endpoints: [{ id: 'endpoint-1', kind: 'lan-http' }],
        selectedEndpointId: 'endpoint-1',
        environmentId: null,
      },
    ];
    currentStatus = null;
    const now = Date.now();
    globalThis.localStorage.setItem(
      'station-pairing-pending-exchange:v1:http://localhost:3242:direct',
      JSON.stringify({
        endpoint: 'http://localhost:3242',
        offerId: 'offer-1',
        proof: 'proof-1',
        requestId: 'request-1',
        requestedAt: now - 60_000,
        expiresAt: now + 240_000,
        browserSession: false,
        requestKind: 'direct',
        targetConnectionId: 'saved-lan',
        targetConnectionLabel: 'Tailnet Station',
      }),
    );

    render(
      <OnboardingGate>
        <div>App</div>
        <BannerHost />
      </OnboardingGate>,
    );

    expect(screen.getByText('App')).toBeTruthy();
    expect(
      await screen.findByText(/Preparing the connection to Tailnet Station/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Waiting for approval on Tailnet Station/),
    ).toBeTruthy();
  });

  describe('a declined request is read as declined (#3387)', () => {
    function seedPhoneAwaitingApproval() {
      platformProfile = {
        isTauri: false,
        target: 'web',
        isMobile: true,
        isDesktop: false,
        supervisesBundledServer: false,
      };
      activeConnectionUrl = 'http://localhost:3242';
      // The phone's one saved Station is BOTH the active connection and the
      // exchange's target, which is what the E2E journey actually looks like.
      // The fixture used to leave these different and still expect the banner,
      // which is exactly how an attribution defect stayed invisible.
      activeConnectionId = 'saved-lan';
      // The phone in the pairing journey has no credential yet — the state
      // that also arms the credential banner once the wait is over.
      credentialState = 'required';
      connections = [
        {
          id: 'saved-lan',
          name: 'Tailnet Station',
          url: 'http://localhost:3242',
          endpoints: [{ id: 'endpoint-1', kind: 'lan-http' }],
          selectedEndpointId: 'endpoint-1',
          environmentId: null,
          credentialState: 'required',
        },
      ];
      currentStatus = null;
      const now = Date.now();
      globalThis.localStorage.setItem(
        'station-pairing-pending-exchange:v1:http://localhost:3242:direct',
        JSON.stringify({
          endpoint: 'http://localhost:3242',
          offerId: 'offer-1',
          proof: 'proof-1',
          requestId: 'request-1',
          requestedAt: now - 60_000,
          expiresAt: now + 240_000,
          browserSession: false,
          requestKind: 'direct',
          targetConnectionId: 'saved-lan',
          targetConnectionLabel: 'Tailnet Station',
        }),
      );
      pairingReconcilerOutcome = {
        title: 'Access request declined',
        message:
          // The reconciler's real output since archive#3849: the shared map
          // names the Station by its browser-local label, so a banner about a
          // Station the reader is not looking at says which one.
          'Tailnet Station declined this device. Request access again if that was unexpected.',
      };
    }

    test('shows the decline instead of leaving it behind the stack cap', async () => {
      seedPhoneAwaitingApproval();

      render(
        <OnboardingGate>
          <div>App</div>
          <BannerHost />
        </OnboardingGate>,
      );

      expect(
        await screen.findByText(/Tailnet Station declined this device/),
      ).toBeTruthy();
      expect(
        screen.getByRole('button', { name: 'Request access again' }),
      ).toBeTruthy();
      // Not merely present: the front banner. A collapsed stack renders one
      // banner plus a cap, and the decline used to be the banner behind it.
      expect(screen.queryByTestId('banner-stack-cap')).toBeNull();
    });

    test('withdraws the superseded waiting claim', async () => {
      seedPhoneAwaitingApproval();

      render(
        <OnboardingGate>
          <div>App</div>
          <BannerHost />
        </OnboardingGate>,
      );

      await screen.findByText(/Tailnet Station declined this device/);
      expect(
        screen.queryByText(/Waiting for approval on Tailnet Station/),
      ).toBeNull();
    });

    test('does not stack a second request-access instruction under it', async () => {
      seedPhoneAwaitingApproval();

      render(
        <OnboardingGate>
          <div>App</div>
          <BannerHost />
        </OnboardingGate>,
      );

      await screen.findByText(/Tailnet Station declined this device/);
      expect(
        screen.queryByText(/Request access to reconnect to Tailnet Station/),
      ).toBeNull();
    });

    /**
     * Requesting access never activates its target: the list row's handler
     * stops propagation so the row is not selected, and the deep-link path
     * find-or-ADDS a connection without activating it. So the Station that
     * declined is routinely NOT the one in front of the user.
     */
    function seedTwoStationsWithBRequesting() {
      seedPhoneAwaitingApproval();
      // A is active and healthy; B is saved, needs access, and is the target
      // of the pending exchange.
      activeConnectionId = 'station-a';
      credentialState = 'required';
      connections = [
        {
          id: 'station-a',
          name: 'Station A',
          url: 'http://localhost:3242',
          endpoints: [{ id: 'endpoint-a', kind: 'lan-http' }],
          selectedEndpointId: 'endpoint-a',
          environmentId: null,
          credentialState: 'required',
        },
        {
          id: 'saved-lan',
          name: 'Station B',
          url: 'http://localhost:9100',
          endpoints: [{ id: 'endpoint-b', kind: 'lan-http' }],
          selectedEndpointId: 'endpoint-b',
          environmentId: null,
          credentialState: 'required',
        },
      ];
    }

    test('attributes a decline to the Station that declined, not the active one', async () => {
      seedTwoStationsWithBRequesting();

      render(
        <OnboardingGate>
          <div>App</div>
          <BannerHost />
        </OnboardingGate>,
      );

      // Withholding it would be the original archive#3387 defect: the user just asked
      // B for access and got refused. It renders — naming B.
      const banner = await screen.findByText(
        /Tailnet Station declined this device/,
      );
      expect(banner.textContent).toContain('Station B');
    });

    test('does not let B’s decline pass as the active Station’s state', async () => {
      seedTwoStationsWithBRequesting();

      render(
        <OnboardingGate>
          <div>App</div>
          <BannerHost />
        </OnboardingGate>,
      );
      const banner = await screen.findByText(
        /Tailnet Station declined this device/,
      );

      // It must not read as A's answer. The decline takes the band's one
      // visible slot (see the disclosed tradeoff in OnboardingGate), so naming
      // its subject is what keeps it honest.
      expect(banner.textContent).toContain('Station B');
      expect(banner.textContent).not.toContain('Station A');
      //.and nothing of A's is left collapsed behind a cap either.
      expect(screen.queryByTestId('banner-stack-cap')).toBeNull();
    });

    test('shows a decline for a target the deep-link path added but never activated', async () => {
      seedTwoStationsWithBRequesting();
      // `resolvePendingTarget` find-or-adds by origin and does not activate,
      // so the target is a connection the user has never selected. Keyed on
      // the target alone with no render for a non-active subject, this decline
      // would be invisible — archive#3387 reintroduced.
      activeConnectionId = 'station-a';

      render(
        <OnboardingGate>
          <div>App</div>
          <BannerHost />
        </OnboardingGate>,
      );

      expect(
        await screen.findByText(/Tailnet Station declined this device/),
      ).toBeTruthy();
    });

    test('starts naming its subject once a different Station is selected', async () => {
      seedPhoneAwaitingApproval();

      const { rerender } = render(
        <OnboardingGate>
          <div>App</div>
          <BannerHost />
        </OnboardingGate>,
      );
      // One Station, and it is the subject: the copy stands unqualified.
      const banner = await screen.findByText(
        /Tailnet Station declined this device/,
      );
      expect(banner.textContent).not.toContain('Tailnet Station:');

      // Select a different Station. The decline is still true, and still about
      // the first one — so it must now say which.
      activeConnectionId = 'other-station';
      activeConnectionUrl = 'http://localhost:9999';
      pairingReconcilerOutcome = null;
      rerender(
        <OnboardingGate>
          <div>App</div>
          <BannerHost />
        </OnboardingGate>,
      );

      await waitFor(() => {
        expect(
          screen.getByText(/Tailnet Station declined this device/).textContent,
        ).toContain('Tailnet Station:');
      });
    });

    test('retires the decline once the same Station starts working', async () => {
      seedPhoneAwaitingApproval();

      const { rerender } = render(
        <OnboardingGate>
          <div>App</div>
          <BannerHost />
        </OnboardingGate>,
      );
      await screen.findByText(/Tailnet Station declined this device/);

      // The Station the decline names now holds a credential. A decline that
      // outlived the condition it described would keep a working Station
      // looking refused.
      credentialState = 'saved';
      connections = [
        { ...(connections[0] as object), credentialState: 'device-session' },
      ];
      lastSuccessAt = Date.now();
      pairingReconcilerOutcome = null;
      rerender(
        <OnboardingGate>
          <div>App</div>
          <BannerHost />
        </OnboardingGate>,
      );

      await waitFor(() => {
        expect(
          screen.queryByText(/Tailnet Station declined this device/),
        ).toBeNull();
      });
    });
  });

  test('uses persisted authentication failure copy in the credential banner', async () => {
    currentStatus = null;
    credentialState = 'required';
    lastError = { reason: 'authentication-failed', at: Date.now() };

    render(
      <OnboardingGate>
        <div>App</div>
        <BannerHost />
      </OnboardingGate>,
    );

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(
      /Tailnet Station isn't accepting this device/,
    );
    // archive#3297: one line. The remedy is a tap away, not a third line of
    // prose on a phone.
    // archive#3903 rewrote that second line: it used to say "pair this device
    // again" beside a button labelled Request access.
    expect(alert.textContent).not.toMatch(/request access to/i);
    // archive#4470b: the disclosure toggle's label is the constant "Details"
    // now (was "More"/"Less").
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /isn't authorised there\. Request access to Tailnet Station again/i,
    );
    // The copy must not send the reader at the network. This banner is the
    // surface that told a phone its answering host "may be off, asleep, or on
    // another network" while it returned 401.
    expect((await screen.findByRole('alert')).textContent).not.toMatch(
      /off, asleep|another network/i,
    );
  });

  test('does not ask the real connectionFailureCopy to explain awaiting approval', async () => {
    currentStatus = null;
    credentialState = 'required';
    lastError = { reason: 'awaiting-approval', at: Date.now() };

    render(
      <OnboardingGate>
        <div>App</div>
        <BannerHost />
      </OnboardingGate>,
    );

    expect(screen.getByText('App')).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Request access to reconnect to Tailnet Station/,
    );
  });

  test('keeps the web shell and connection manager reachable when the initial endpoint is unavailable', () => {
    currentStatus = null;
    isLoading = true;
    const onSettingsAction = vi.fn();

    const view = render(
      <OnboardingGate>
        <button type="button" onClick={onSettingsAction}>
          Open Settings
        </button>
      </OnboardingGate>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(onSettingsAction).toHaveBeenCalledOnce();
    fireEvent(window, new Event(OPEN_CONNECTIONS_MODAL_EVENT));
    expect(screen.getByTestId('connection-manager')).toBeTruthy();
    expect(screen.queryByText("Can't reach server")).toBeNull();

    isLoading = false;
    isError = true;
    view.rerender(
      <OnboardingGate>
        <button type="button" onClick={onSettingsAction}>
          Open Settings
        </button>
      </OnboardingGate>,
    );

    expect(screen.getByRole('button', { name: 'Open Settings' })).toBeTruthy();
    expect(screen.getByTestId('connection-manager')).toBeTruthy();
  });

  test('does not treat an injected host connection as a real saved host', async () => {
    platformProfile = {
      isTauri: true,
      target: 'ios',
      isMobile: true,
      isDesktop: false,
      supervisesBundledServer: false,
    };
    connections = [
      {
        id: 'cli-base',
        endpoints: [{ id: 'endpoint-cli', kind: 'manual' }],
        selectedEndpointId: 'endpoint-cli',
        environmentId: null,
      },
    ];
    currentStatus = null;

    render(
      <OnboardingGate>
        <div>App</div>
        <BannerHost />
      </OnboardingGate>,
    );

    expect(await screen.findByText('No Station connected')).toBeTruthy();
  });

  describe('desktop bundled-server supervision', () => {
    const desktopProfile = {
      isTauri: true,
      target: 'macos',
      isMobile: false,
      isDesktop: true,
      supervisesBundledServer: true,
    };

    function bundled(
      overrides: Partial<BundledServerStatus> = {},
    ): BundledServerStatus {
      return {
        phase: 'starting',
        attempt: 0,
        maxAttempts: 5,
        apiBase: null,
        port: null,
        lastExitCode: null,
        nextRetryInMs: null,
        logPath: '/tmp/station-server.log',
        ownership: 'sidecar',
        canRunInBackground: true,
        failClosed: false,
        message: '',
        ...overrides,
      };
    }

    beforeEach(() => {
      platformProfile = { ...desktopProfile };
      currentStatus = null;
    });

    test.each([
      ['before the supervisor reports', null, null],
      ['while starting', bundled({ phase: 'starting' }), /Starting Station/],
      [
        'while restarting',
        bundled({ phase: 'restarting' }),
        /Restarting Station/,
      ],
      ['while stopping', bundled({ phase: 'stopping' }), /Restarting Station/],
      [
        'while stopped',
        bundled({ phase: 'stopped' }),
        /local Station is stopped/,
      ],
      [
        'after a service error',
        bundled({
          phase: 'failed',
          message: "Station's local Station stopped.",
        }),
        /local Station stopped/,
      ],
    ] as const)(
      'mounts the usable shell immediately %s',
      async (_label, status, bannerCopy) => {
        bundledStatus = status;
        render(
          <OnboardingGate>
            <button type="button">Open Settings</button>
            <BannerHost />
          </OnboardingGate>,
        );

        expect(
          screen.getByRole('button', { name: 'Open Settings' }),
        ).toBeTruthy();
        expect(screen.queryByText('Starting Station…')).toBeNull();
        if (bannerCopy) {
          expect((await screen.findByRole('status')).textContent).toMatch(
            bannerCopy,
          );
          expect(
            screen.getByRole('button', { name: 'Restart Station' }),
          ).toBeTruthy();
          fireEvent.click(
            screen.getByRole('button', { name: 'Manage Stations' }),
          );
          expect(screen.getByTestId('connection-manager')).toBeTruthy();
        } else {
          expect(screen.queryByRole('alert')).toBeNull();
        }
      },
    );

    test('keeps local-service failure actionable through the banner', async () => {
      bundledStatus = bundled({
        phase: 'failed',
        message:
          "Station's local Station stopped. Check its log and restart it.",
      });
      render(
        <OnboardingGate>
          <div>App</div>
          <BannerHost />
        </OnboardingGate>,
      );

      expect(screen.getByText('App')).toBeTruthy();
      expect((await screen.findByRole('status')).textContent).toMatch(
        /local Station stopped/i,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Restart Station' }));
      expect(restartBundledServerMock).toHaveBeenCalledTimes(1);

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Manage Stations',
        }),
      );
      expect(screen.getByText('Connection manager: list')).toBeTruthy();
    });

    /**
     * archive#4475 — the banner's own "Restart Station" action used to
     * discard `restartBundledServer`'s result (`void restartBundledServer;`
     * in OnboardingGate.tsx), so a request that never reached the host (the
     * owner's dangling-tailscale-proxy scenario) left the banner reading
     * exactly as it did before the tap — a dead button, silently.
     */
    test('surfaces a visible failure when the banner Restart does not reach the host', async () => {
      bundledStatus = bundled({
        phase: 'failed',
        message:
          "Station's local Station stopped. Check its log and restart it.",
      });
      restartBundledServerMock.mockResolvedValue(false);
      render(
        <OnboardingGate>
          <div>App</div>
          <BannerHost />
        </OnboardingGate>,
      );

      expect((await screen.findByRole('status')).textContent).toMatch(
        /local Station stopped/i,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Restart Station' }));
      expect(restartBundledServerMock).toHaveBeenCalledTimes(1);

      await waitFor(() =>
        expect(toastMocks.showToast).toHaveBeenCalledTimes(1),
      );
      expect(toastMocks.showToast.mock.calls[0]?.[0]).toMatch(
        /couldn.t restart/i,
      );
      // Re-tappable: the banner's own action button is never disabled by
      // this path, so a second tap reaches the same request again.
      fireEvent.click(screen.getByRole('button', { name: 'Restart Station' }));
      expect(restartBundledServerMock).toHaveBeenCalledTimes(2);
    });

    test('allows a first launch with a healthy desktop-owned sidecar and no service install', () => {
      bundledStatus = bundled({
        phase: 'running',
        apiBase: 'http://127.0.0.1:3200',
        port: 3200,
      });
      currentStatus = chatReadyStatus();
      render(
        <OnboardingGate>
          <div>App</div>
        </OnboardingGate>,
      );
      expect(screen.getByText('App')).toBeTruthy();
      expect(screen.queryByText('Starting Station…')).toBeNull();
    });

    test.each([
      'starting',
      'restarting',
      'stopping',
      'stopped',
      'failed',
    ] as const)(
      'keeps the booted shell and connection access mounted while the service is %s',
      async (phase) => {
        bundledStatus = bundled({ phase: 'running' });
        currentStatus = chatReadyStatus();
        const view = render(
          <OnboardingGate>
            <button type="button">Open Settings</button>
            <BannerHost />
          </OnboardingGate>,
        );

        bundledStatus = bundled({ phase, message: 'service detail' });
        currentStatus = null;
        view.rerender(
          <OnboardingGate>
            <button type="button">Open Settings</button>
            <BannerHost />
          </OnboardingGate>,
        );

        expect(
          screen.getByRole('button', { name: 'Open Settings' }),
        ).toBeTruthy();
        expect(screen.queryByText('Starting Station…')).toBeNull();
        expect(
          await screen.findByRole('button', { name: 'Restart Station' }),
        ).toBeTruthy();
        fireEvent.click(
          screen.getByRole('button', { name: 'Manage Stations' }),
        );
        expect(screen.getByTestId('connection-manager')).toBeTruthy();
      },
    );

    test('a real saved remote host takes precedence over the supervisor screen', () => {
      bundledStatus = bundled({ phase: 'failed', attempt: 5 });
      connections = [
        {
          id: 'saved-lan',
          endpoints: [{ id: 'endpoint-1', kind: 'lan-http' }],
          selectedEndpointId: 'endpoint-1',
          environmentId: null,
        },
      ];
      render(
        <OnboardingGate>
          <div>App</div>
        </OnboardingGate>,
      );
      expect(screen.queryByText("Station's local service stopped")).toBeNull();
      expect(screen.getByText('App')).toBeTruthy();
    });

    test('a report-error host that does not supervise degrades to the web flow', () => {
      // TAURI_UNKNOWN_PROFILE: native, but supervisesBundledServer stays false.
      platformProfile = {
        isTauri: true,
        target: 'unknown',
        isMobile: false,
        isDesktop: false,
        supervisesBundledServer: false,
      };
      bundledStatus = null;
      render(
        <OnboardingGate>
          <div>App</div>
        </OnboardingGate>,
      );
      expect(screen.queryByText('Starting Station…')).toBeNull();
      expect(screen.getByText('App')).toBeTruthy();
    });
  });

  // archive#1007 / archive#1958. Pairing chrome flows through BannerHost under the header
  // (not a root strip). Pin in-flow layout, drag region, and dismiss.
  describe('pairing banner does not occlude the window chrome (#1007)', () => {
    function shell(children?: ReactNode) {
      return (
        <OnboardingGate>
          <header data-testid="app-header">Station</header>
          <BannerHost />
          {children}
        </OnboardingGate>
      );
    }

    function showCredentialBanner() {
      currentStatus = createStatus({ ready: true });
      lastSuccessAt = Date.now();
      const view = render(shell());
      currentStatus = null;
      credentialState = 'required';
      view.rerender(shell());
      return view;
    }

    test('renders under the header in flow, not as a fixed overlay', async () => {
      const style = document.createElement('style');
      style.textContent = readFileSync(
        join(
          process.cwd(),
          'src-ui/src/components/notifications/BannerHost.css',
        ),
        'utf8',
      );
      document.head.append(style);
      try {
        showCredentialBanner();
        const banner = await screen.findByRole('alert');

        const computed = getComputedStyle(banner);
        expect(
          computed.position === 'fixed' || computed.position === 'absolute',
        ).toBe(false);

        const header = screen.getByTestId('app-header');
        expect(
          header.compareDocumentPosition(banner) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      } finally {
        style.remove();
      }
    });

    test('marks the strip as a drag region so the overlay title bar still drags', async () => {
      showCredentialBanner();
      const banner = await screen.findByRole('alert');
      expect(banner.hasAttribute('data-tauri-drag-region')).toBe(true);
    });

    test('offers a named, keyboard-reachable dismiss that hides the banner', async () => {
      showCredentialBanner();
      const dismiss = await screen.findByRole('button', {
        name: 'Dismiss pairing reminder',
      });
      expect(dismiss.tagName).toBe('BUTTON');
      expect(dismiss.hasAttribute('disabled')).toBe(false);

      fireEvent.click(dismiss);
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());

      act(() => {
        window.dispatchEvent(new Event(OPEN_CONNECTIONS_MODAL_EVENT));
      });
      expect(screen.getByTestId('connection-manager')).toBeTruthy();
    });

    test('re-arms when the connection evidence changes', async () => {
      const view = showCredentialBanner();
      fireEvent.click(
        await screen.findByRole('button', {
          name: 'Dismiss pairing reminder',
        }),
      );
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());

      lastSuccessAt = (lastSuccessAt ?? 0) + 1000;
      view.rerender(shell());
      expect(await screen.findByRole('alert')).toBeTruthy();
    });
  });

  describe('local self-authorization (station#1715)', () => {
    test('does nothing on a non-desktop platform, even with a pending profile', async () => {
      platformProfile = { ...platformProfile, isDesktop: false };
      pendingLocalSelfProvisionProfileNameMock.mockReturnValue('local');
      render(
        <OnboardingGate>
          <div>App</div>
        </OnboardingGate>,
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(pendingLocalSelfProvisionProfileNameMock).not.toHaveBeenCalled();
      expect(attemptLocalSelfProvisionOnceMock).not.toHaveBeenCalled();
    });

    test('is a no-op on desktop when no Station is pending provisioning', async () => {
      platformProfile = {
        ...platformProfile,
        isDesktop: true,
        isTauri: true,
      };
      pendingLocalSelfProvisionProfileNameMock.mockReturnValue(undefined);
      render(
        <OnboardingGate>
          <div>App</div>
        </OnboardingGate>,
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(pendingLocalSelfProvisionProfileNameMock).toHaveBeenCalled();
      expect(attemptLocalSelfProvisionOnceMock).not.toHaveBeenCalled();
    });

    test('attempts provisioning once on desktop when a Station is pending, and refetches status on success', async () => {
      platformProfile = {
        ...platformProfile,
        isDesktop: true,
        isTauri: true,
      };
      pendingLocalSelfProvisionProfileNameMock.mockReturnValue('local');
      attemptLocalSelfProvisionOnceMock.mockResolvedValue(true);
      render(
        <OnboardingGate>
          <div>App</div>
        </OnboardingGate>,
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(attemptLocalSelfProvisionOnceMock).toHaveBeenCalledTimes(1);
      expect(attemptLocalSelfProvisionOnceMock).toHaveBeenCalledWith(
        expect.objectContaining({ profileName: 'local' }),
      );
      expect(nativeProfileRefreshMock).toHaveBeenCalledTimes(1);
      expect(forceRefetch).toHaveBeenCalledTimes(1);
    });

    test('does not refresh or refetch when the attempt does not provision', async () => {
      platformProfile = {
        ...platformProfile,
        isDesktop: true,
        isTauri: true,
      };
      pendingLocalSelfProvisionProfileNameMock.mockReturnValue('local');
      attemptLocalSelfProvisionOnceMock.mockResolvedValue(false);
      render(
        <OnboardingGate>
          <div>App</div>
        </OnboardingGate>,
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(attemptLocalSelfProvisionOnceMock).toHaveBeenCalledTimes(1);
      expect(nativeProfileRefreshMock).not.toHaveBeenCalled();
      expect(forceRefetch).not.toHaveBeenCalled();
    });
  });
});

import {
  engineConnectionId,
  engineId,
} from '@kontourai/station-contracts/agent-identity';

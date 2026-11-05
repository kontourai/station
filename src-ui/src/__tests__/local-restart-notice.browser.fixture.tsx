import { ConnectionsProvider } from '@kontourai/station-connect';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { NotificationContainer } from '../components/notifications/NotificationContainer';
import { OnboardingGate } from '../components/OnboardingGate';
import { NavigationProvider } from '../contexts/NavigationContext';
import { ToastProvider } from '../contexts/ToastContext';
import { openConnectionsModal } from '../lib/connectionModalEvents';
import type {
  BundledServerStatus,
  NativeCommandResult,
  NativePlatformAdapter,
} from '../platform/native/types';
import type * as ProductionProfile from '../platform/PlatformProfileContext';

export const useNativeProfileStoreEpoch: typeof ProductionProfile.useNativeProfileStoreEpoch =
  () => 0;

export const useNativeProfileSelection: typeof ProductionProfile.useNativeProfileSelection =
  () => async (connectionId) => {
    throw new Error(`Unexpected native profile selection: ${connectionId}`);
  };

export const usePlatformProfile: typeof ProductionProfile.usePlatformProfile =
  () => ({
    isTauri: true,
    isDesktop: true,
    isMobile: false,
    isDevBuild: false,
    target: 'windows',
    supervisesBundledServer: true,
  });

export const nativeProfileBootstrapRecoveryError: typeof ProductionProfile.nativeProfileBootstrapRecoveryError =
  () => undefined;

export const PlatformBootstrap: typeof ProductionProfile.PlatformBootstrap =
  () => {
    throw new Error(
      'Unexpected production platform bootstrap in restart fixture',
    );
  };

export type RestartFixtureControl = {
  requests: number;
  settle(index: number, delivered: boolean): void;
};

declare global {
  interface Window {
    restartFixture: RestartFixtureControl;
  }
}

const pending: ((result: NativeCommandResult<void>) => void)[] = [];
window.restartFixture = {
  requests: 0,
  settle(index, delivered) {
    const resolve = pending[index];
    if (!resolve) throw new Error(`Missing restart request ${index}`);
    resolve(
      delivered
        ? { status: 'ok', value: undefined }
        : {
            status: 'error',
            command: 'restart-bundled-server',
            message: 'Request delivery failed',
          },
    );
  },
};

const failed: BundledServerStatus = {
  phase: 'failed',
  ownership: 'sidecar',
  attempt: 5,
  maxAttempts: 5,
  apiBase: null,
  port: null,
  lastExitCode: 1,
  nextRetryInMs: null,
  logPath: null,
  canRunInBackground: true,
  failClosed: false,
  message: 'Local Station stopped.',
};

export const adapter: Pick<
  NativePlatformAdapter,
  | 'restartBundledServer'
  | 'getBundledServerStatus'
  | 'subscribeToBundledServerStatus'
> = {
  restartBundledServer: () =>
    new Promise((resolve) => {
      pending.push(resolve);
      window.restartFixture.requests += 1;
    }),
  getBundledServerStatus: async () => ({ status: 'ok', value: failed }),
  subscribeToBundledServerStatus: () => ({ dispose() {} }),
};

export function mountRestartFixture() {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing fixture root');
  createRoot(root).render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ConnectionsProvider
        seedDefault={false}
        nativeShell
        injectedConnection={{
          id: 'fixture-local',
          name: 'Local Station',
          source: 'managed-loopback',
          status: 'failed',
        }}
      >
        <NavigationProvider>
          <ToastProvider>
            <OnboardingGate>
              <main>
                <label>
                  Unsent note
                  <textarea defaultValue="Keep my investigation notes" />
                </label>
                <button
                  type="button"
                  onClick={() => openConnectionsModal({ mode: 'list' })}
                >
                  Manage Stations
                </button>
              </main>
            </OnboardingGate>
            <NotificationContainer />
          </ToastProvider>
        </NavigationProvider>
      </ConnectionsProvider>
    </QueryClientProvider>,
  );
}

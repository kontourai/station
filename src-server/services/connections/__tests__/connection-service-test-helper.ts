import { createCredentialApplicationFactory } from '../../orchestration/credential-application-ledger.js';
import type { EventStore } from '../../orchestration/event-store.js';
import { ConnectionService } from '../connection-service.js';

function createCredentialApplicationFactoryForTest() {
  const applications = new Map<
    string,
    {
      connectionId: string;
      recoveryFingerprint: string;
      candidateProfileRef: string;
      previousProfileRef?: string;
      state:
        | 'reserved'
        | 'staged'
        | 'commit-pending'
        | 'adopted'
        | 'rolled-back'
        | 'superseded'
        | 'indeterminate';
    }
  >();
  return createCredentialApplicationFactory({
    reserve: ({ attemptId, fingerprint, ...input }) => {
      if (applications.has(attemptId)) return null;
      const application = {
        ...input,
        recoveryFingerprint: fingerprint,
        state: 'reserved' as const,
      };
      applications.set(attemptId, application);
      return application;
    },
    transition: ({ attemptId, from, to }) => {
      const current = applications.get(attemptId);
      if (!current || !from.includes(current.state)) return { kind: 'stale' };
      applications.set(attemptId, { ...current, state: to });
      return { kind: 'applied' };
    },
    acknowledge: ({ attemptId }) =>
      applications.has(attemptId) ? { kind: 'applied' } : { kind: 'stale' },
    latest: (connectionId) =>
      [...applications.values()]
        .filter((application) => application.connectionId === connectionId)
        .at(-1) ?? null,
    acquireMutation: () => ({
      release: () => undefined,
      stillOwner: () => true,
    }),
  });
}

/**
 * Test-only composition seam. It deliberately mirrors the production
 * constructor except for the required private ledger. Tests that exercise
 * credential settlement compose a real temporary EventStore separately;
 * ordinary connection tests receive this deterministic in-memory Adapter.
 */
export function createConnectionServiceForTest(
  ...dependencies: any[]
): ConnectionService {
  return createConnectionServiceWithCredentialApplicationFactoryForTest(
    createCredentialApplicationFactoryForTest(),
    ...dependencies,
  );
}

/** Explicit real SQLite composition for tests of private application authority. */
export function createConnectionServiceWithCredentialApplicationFactoryForTest(
  protocol: ReturnType<EventStore['createCredentialApplicationFactory']>,
  ...dependencies: any[]
): ConnectionService {
  const [
    providerService,
    getProviderAdapters,
    getACPConnections,
    getACPStatus,
    getAppConfig,
    updateAppConfig,
    ...optionalDependencies
  ] = dependencies;
  return new ConnectionService(
    providerService,
    getProviderAdapters,
    getACPConnections,
    getACPStatus,
    getAppConfig,
    updateAppConfig,
    protocol,
    ...optionalDependencies,
  );
}

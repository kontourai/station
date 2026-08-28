/**
 * The Computers list, as ONE derivation shared by everything that makes a
 * claim about it (; lane design P5).
 *
 * Two consumers used to answer "how many computers are there?" independently:
 * `ComputersSection` folded manual + paired + SSH records into one row per
 * identity (archive#1096's merge), while the section rail added
 * `savedStations.length + sshComputers.length`. Those disagree in both
 * directions — the rail omitted every locally-registered manual entry, and
 * double-counted a paired device that is also an SSH computer, which the
 * body renders as a single row. A count beside a list is a claim ABOUT that
 * list, so it has to come from the list.
 *
 * `hideEndpoint` only changes a row's `detail` text (SSH forward addresses
 * are meaningless on a phone), never how many rows there are or which
 * identities they carry — so the rail's count and the body's rows can share
 * this hook without the rail having to know anything about viewport.
 */

import { useConnections } from '@kontourai/station-connect';
import type { KnownEnvironment } from '@kontourai/station-contracts';
import {
  type SshEnvironmentView,
  sshEnvironmentsToKnownEnvironments,
  useSshEnvironmentsQuery,
} from '@kontourai/station-sdk';
import { useMemo, useSyncExternalStore } from 'react';
import {
  buildComputerRows,
  type ComputerRowModel,
  foldKnownEnvironments,
  isManualEntry,
} from './computer-rows';
import { knownEnvironmentRegistry } from './known-environment-registry';
import {
  pairedAuthorizationByConnection,
  savedConnectionsToKnownEnvironments,
} from './knownEnvironmentAdapters';

export interface UseComputerRowsResult {
  rows: ComputerRowModel[];
  /** The folded identities behind the rows, for callers that need the source. */
  environments: KnownEnvironment[];
  sshEnvironments: SshEnvironmentView[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useComputerRows(
  options: {
    hideEndpoint?: (endpointUrl: string, kind: string) => boolean;
  } = {},
): UseComputerRowsResult {
  // The ONE registry instance for the app. A component constructing its own
  // subscribes to listeners nobody else notifies, so a Station added from the
  // dialog stayed invisible here until the next remount — the exact failure
  // `known-environment-registry.ts` was written to prevent, in the one place
  // that had not adopted it.
  const registry = knownEnvironmentRegistry();
  const manual = useSyncExternalStore(
    (onChange) => registry.subscribe(onChange),
    () => registry.getAll(),
  );
  const { connections } = useConnections();
  const sshEnvironmentsQuery = useSshEnvironmentsQuery();
  const { hideEndpoint } = options;

  const sshEnvironments = useMemo(
    () => sshEnvironmentsQuery.data ?? [],
    [sshEnvironmentsQuery.data],
  );
  const paired = useMemo(
    () => savedConnectionsToKnownEnvironments(connections),
    [connections],
  );
  const ssh = useMemo(
    () => sshEnvironmentsToKnownEnvironments(sshEnvironments),
    [sshEnvironments],
  );
  const environments = useMemo(
    () => foldKnownEnvironments([manual, paired, ssh]),
    [manual, paired, ssh],
  );
  const pairedAuthorization = useMemo(
    () => pairedAuthorizationByConnection(connections),
    [connections],
  );

  const rows = useMemo(
    () =>
      buildComputerRows({
        environments,
        sshEnvironments,
        isManualEntry,
        isPairedAuthorized: (environment) => {
          if (environment.environmentId) {
            const byEnv = pairedAuthorization.byEnvironmentId.get(
              environment.environmentId,
            );
            if (byEnv !== undefined) return byEnv;
          }
          const connectionId = environment.id.startsWith('paired:')
            ? environment.id.slice('paired:'.length)
            : null;
          const byConnection = connectionId
            ? pairedAuthorization.byConnectionId.get(connectionId)
            : undefined;
          // No lookup entry at all — conservative default: not evidenced as
          // authorized, so do not claim control.
          return byConnection ?? false;
        },
        ...(hideEndpoint ? { hideEndpoint } : {}),
      }),
    [environments, hideEndpoint, pairedAuthorization, sshEnvironments],
  );

  return {
    rows,
    environments,
    sshEnvironments,
    isLoading: sshEnvironmentsQuery.isLoading,
    isError: sshEnvironmentsQuery.isError,
    refetch: () => void sshEnvironmentsQuery.refetch(),
  };
}

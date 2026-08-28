import {
  completePendingPairing,
  completeVerifiedPairing,
  type PendingPairingExchange,
  useConnections,
} from '@kontourai/station-connect';
import { pairingStateCopy } from '@kontourai/station-contracts/pairing-copy';
import { useEffect, useRef } from 'react';
import { checkHostCompatibility } from '../lib/compatibilityLoader';

/** Runs only after a submitted access request returns control to the shell. */
export function PendingPairingReconciler({
  pending,
  enabled,
  onCompleted,
  onTerminalFailure,
  onConnectionWaiting,
  onApprovalWaiting,
}: {
  pending: PendingPairingExchange;
  enabled: boolean;
  onCompleted: () => void;
  onTerminalFailure: (title: string, message: string) => void;
  onConnectionWaiting: () => void;
  onApprovalWaiting: () => void;
}) {
  const {
    commitVerifiedPairing,
    connections,
    markDeviceSession,
    reconcileHandshake,
    setActiveConnection,
    setCredential,
  } = useConnections();
  const completedRef = useRef(onCompleted);
  const terminalFailureRef = useRef(onTerminalFailure);
  const connectionWaitingRef = useRef(onConnectionWaiting);
  const approvalWaitingRef = useRef(onApprovalWaiting);
  const connectionsRef = useRef(connections);
  const operationsRef = useRef({
    commitVerifiedPairing,
    markDeviceSession,
    reconcileHandshake,
    setActiveConnection,
    setCredential,
  });
  completedRef.current = onCompleted;
  terminalFailureRef.current = onTerminalFailure;
  connectionWaitingRef.current = onConnectionWaiting;
  approvalWaitingRef.current = onApprovalWaiting;
  connectionsRef.current = connections;
  operationsRef.current = {
    commitVerifiedPairing,
    markDeviceSession,
    reconcileHandshake,
    setActiveConnection,
    setCredential,
  };

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let resumedAfterSharedAbort = false;
    const controller = new AbortController();
    const finish = (title: string, message: string) => {
      if (disposed) return;
      terminalFailureRef.current(title, message);
    };
    const runCompletion = () => {
      void completePendingPairing(pending, {
        signal: controller.signal,
        onProgress: ({ status }) => {
          if (disposed) return;
          if (status === 'waiting-for-connection') {
            connectionWaitingRef.current();
          } else {
            approvalWaitingRef.current();
          }
        },
        completePaired: async (result, { signal }) => {
          const failed = (title: string, message: string) => ({
            status: 'failed' as const,
            failure: { title, message },
          });
          try {
            const compatibility = await checkHostCompatibility(
              pending.endpoint,
              signal,
            );
            if (signal.aborted) {
              return failed(
                'Station could not be saved',
                'Station stopped completing the approved request before this Station could be saved on this device.',
              );
            }
            if (compatibility.blocking) {
              return failed('Station update required', compatibility.reason);
            }
          } catch {
            return failed(
              'Station could not be verified',
              'Station compatibility could not be verified after approval. Request access again after checking reachability to this Station.',
            );
          }

          const target = connectionsRef.current.find(
            (connection) => connection.id === pending.targetConnectionId,
          );
          if (!target) {
            return failed(
              'Saved Station is no longer available',
              `The saved Station for this request was forgotten on this device. Add ${pending.targetConnectionLabel || 'the Station'} again, then request access.`,
            );
          }
          try {
            const operations = operationsRef.current;
            const connectionId = await completeVerifiedPairing(
              operations,
              {
                connectionId: target.id,
                name: target.name,
                endpoint: pending.endpoint,
              },
              { ...result, endpoint: pending.endpoint },
            );
            operations.reconcileHandshake(connectionId, {
              environmentId: result.environmentId,
              authentication: { scheme: 'bearer', protocolVersion: 1 },
            });
            return { status: 'completed' } as const;
          } catch {
            return failed(
              'Access was approved but not saved',
              'The Station approved this device, but the Station could not be saved on this device. Request access again after checking local storage.',
            );
          }
        },
      }).then((completion) => {
        if (disposed || completion.status === 'aborted') {
          if (
            !disposed &&
            completion.status === 'aborted' &&
            !controller.signal.aborted &&
            !resumedAfterSharedAbort
          ) {
            resumedAfterSharedAbort = true;
            runCompletion();
          }
          return;
        }
        if (completion.status === 'paired') {
          completedRef.current();
          return;
        }
        if (completion.status === 'post-exchange-failed') {
          const failure = completion.failure;
          if (
            failure &&
            typeof failure === 'object' &&
            'title' in failure &&
            'message' in failure &&
            typeof failure.title === 'string' &&
            typeof failure.message === 'string'
          ) {
            finish(failure.title, failure.message);
          } else {
            finish(
              'Station could not be saved',
              'The Station approved this device, but it could not be saved on this device. Request access again.',
            );
          }
          return;
        }
        // The shared pairing-state map (archive#3849). This surface is chrome
        // that may be reporting on a Station the reader is not looking at, so
        // it takes the DEVICE-subject decline — archive#3387's distinction,
        // kept as a second named id rather than collapsed away — and names
        // that Station by its browser-local label.
        const stationLabel = pending.targetConnectionLabel;
        if (completion.status === 'declined') {
          const copy = pairingStateCopy('declined-device', stationLabel);
          finish(copy.title, copy.message);
          return;
        }
        if (completion.status === 'expired') {
          const copy = pairingStateCopy(
            pending.requestKind === 'direct'
              ? 'expired-access-request'
              : 'expired-pairing-code',
            stationLabel,
          );
          finish(copy.title, copy.message);
          return;
        }
        if (completion.status === 'identity-changed') {
          finish(
            'Station identity changed',
            'The Station identity changed while this request was open. Request access again from the intended Station.',
          );
          return;
        }
        if (completion.status === 'failed') {
          finish(
            'Station could not be saved',
            'The Station returned an unexpected response while completing access. Request access again.',
          );
          return;
        }
      });
    };
    runCompletion();

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [enabled, pending]);

  return null;
}

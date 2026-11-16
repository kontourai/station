import { useEffect, useState, useSyncExternalStore } from 'react';
import { useStationConnectionsOptional } from '../../connections/StationConnectionsContext';
import type { StationConnection } from '../../connections/station-connection';
import {
  type RemoteSessionReaderRequest,
  remoteSessionReaderStore,
} from '../../contexts/remote-session-reader-store';
import { describeStationFailure } from '../../utils/stationFailure';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { ErrorState, SkeletonBlock } from '../state';
import { RemoteSessionReader } from './RemoteSessionReader';

export {
  remoteContinuationReason,
  remoteHistoryEvents,
} from './RemoteSessionReader';

/**
 * Resolves the reader's owning connection: this Station, which relays the
 * remote read. The surface never derives host authority itself.
 */
function RemoteSessionReaderShell({
  request,
}: {
  request: RemoteSessionReaderRequest;
}) {
  const connections = useStationConnectionsOptional();
  const [attempt, setAttempt] = useState(0);
  const [owner, setOwner] = useState<{
    attempt: number;
    station?: StationConnection;
    error?: unknown;
  }>();
  useEffect(() => {
    if (!connections) return;
    let active = true;
    let release = () => {};
    void connections
      .resolve({})
      .then((lease) => {
        release = lease.release;
        if (!active) {
          release();
          return;
        }
        setOwner({ attempt, station: lease.connection });
      })
      .catch((error: unknown) => {
        if (active) setOwner({ attempt, error });
      });
    return () => {
      active = false;
      release();
    };
  }, [connections, attempt]);
  const close = () => remoteSessionReaderStore.close(request);
  const station =
    owner?.attempt === attempt && owner.station?.isCurrent()
      ? owner.station
      : undefined;
  if (station)
    return (
      <RemoteSessionReader
        request={request}
        station={station}
        onClose={close}
      />
    );
  return (
    <Dialog
      title={request.title}
      subtitle={`On ${request.environmentLabel} · Read only`}
      closeLabel="Close remote session"
      size="lg"
      onClose={close}
    >
      <div data-testid="remote-session-reader-connecting">
        {!connections || (owner?.attempt === attempt && owner.error) ? (
          <ErrorState
            title="Station unavailable"
            description={describeStationFailure(owner?.error).body}
            action={
              <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
            }
          />
        ) : (
          <SkeletonBlock label="Connecting to this Station" />
        )}
      </div>
    </Dialog>
  );
}

/** Mounted once with the app overlays; renders nothing until a row asks. */
export function RemoteSessionReaderHost() {
  const request = useSyncExternalStore(
    remoteSessionReaderStore.subscribe,
    remoteSessionReaderStore.getSnapshot,
  );
  return request ? (
    <RemoteSessionReaderShell key={request.epoch} request={request} />
  ) : null;
}

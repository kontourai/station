import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useEffect, useState } from 'react';
import { workObservation } from '../contexts/work-observation';
import { useStationConnectionsOptional } from './StationConnectionsContext';
import type { StationConnection } from './station-connection';
import { chatBelongsToStation, readChatStationBinding } from './station-state';

type ChatOwner = Parameters<typeof chatBelongsToStation>[0];

/** Restored remote tabs retain their original principal; absence never selects host. */
export function useChatStationConnection(
  chat?: ChatOwner | null,
  provided?: StationConnection,
) {
  const connections = useStationConnectionsOptional();
  const client = useContext(QueryClientContext);
  const bindingKey = JSON.stringify(
    readChatStationBinding(chat?.stationBinding),
  );
  const remote = Boolean(chat && !chatBelongsToStation(chat));
  const [resolved, setResolved] = useState<{
    key: string;
    connection?: StationConnection;
    failed?: boolean;
  }>();
  useEffect(() => {
    if (!remote || provided || !bindingKey || !connections || !client) return;
    const binding = readChatStationBinding(JSON.parse(bindingKey));
    if (!binding || chat?.stationBindingInvalid) return;
    let cancelled = false;
    let release = () => {};
    void connections
      .resolve({ binding })
      .then(async (lease) => {
        release = lease.release;
        if (cancelled || !lease.connection.isCurrent()) {
          release();
          return;
        }
        const { ensureOrchestrationEventStream } = await import(
          '../hooks/orchestration/ensureOrchestrationEventStream'
        );
        if (cancelled || !lease.connection.isCurrent()) {
          release();
          return;
        }
        const stop = ensureOrchestrationEventStream(
          lease.connection.targetApiBase,
          client,
          undefined,
          false,
          false,
          lease.connection,
        );
        release = () => {
          stop();
          lease.release();
        };
        setResolved({ key: bindingKey, connection: lease.connection });
      })
      .catch(() => {
        release();
        if (!cancelled) setResolved({ key: bindingKey, failed: true });
      });
    return () => {
      cancelled = true;
      release();
    };
  }, [
    bindingKey,
    chat?.stationBindingInvalid,
    client,
    connections,
    provided,
    remote,
  ]);
  const connection =
    provided ??
    (resolved && resolved.key === bindingKey ? resolved.connection : undefined);
  const current =
    connection?.isCurrent() && (!chat || chatBelongsToStation(chat, connection))
      ? connection
      : undefined;
  if (current && client) workObservation(client, current);
  const resolving = Boolean(
    remote &&
      !current &&
      !provided &&
      bindingKey &&
      connections &&
      client &&
      !chat?.stationBindingInvalid &&
      !(resolved?.key === bindingKey && resolved.failed),
  );
  return {
    connection: current,
    unavailable: remote && !current && !resolving,
    resolving,
  };
}

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useStationConnections } from '../connections/StationConnectionsContext';
import type {
  ChatStationBindingV1,
  StationConnection,
} from '../connections/station-connection';
import {
  readChatStationBinding,
  stationStateKey,
} from '../connections/station-state';
import { useAuthorityPersistence } from '../contexts/AuthorityPersistenceContext';
import { activeChatsStore } from '../contexts/active-chats-store';
import {
  type OutboundDispatchTurn,
  type OutboundStationIdentity,
  outboundDispatch,
} from '../lib/outboundQueue';
import { ensureOrchestrationEventStream } from './orchestration/ensureOrchestrationEventStream';
import { projectOutboundQueueEntries } from './outboundQueueProjection';
import { useOutboundQueueFlush } from './useOutboundQueueFlush';
import { useSurfaceVisibilityFlags } from './useSurfaceVisibilityFlags';

/**
 * The chats' non-host Station bindings, one per Station, as a string. The
 * store notifies on every streamed token and composer keystroke; a string
 * snapshot re-renders this root-level mount only when a binding changes.
 */
function readChatStationBindings(): string {
  const bindings = new Map<string, ChatStationBindingV1>();
  for (const chat of Object.values(activeChatsStore.getSnapshot())) {
    const binding = readChatStationBinding(chat.stationBinding);
    if (binding && binding.affinity.kind !== 'host')
      bindings.set(stationStateKey(binding), binding);
  }
  return JSON.stringify([...bindings.values()]);
}

/** Retained work keeps its own connection leased, independently of the visible tab. */
export function OutboundQueueFlushMount({ apiBase }: { apiBase: string }) {
  const { observation, namespace, status } = useAuthorityPersistence();
  const enabled = useSurfaceVisibilityFlags().has('paired-station-chats');
  const chatBindingsSignature = useSyncExternalStore(
    activeChatsStore.subscribe,
    readChatStationBindings,
  );
  const [rows, setRows] = useState<OutboundDispatchTurn[]>([]);
  const [readyNamespace, setReadyNamespace] = useState<string>();
  const hostEnvironmentId = observation?.environmentId;
  useEffect(() => {
    let current = true;
    setReadyNamespace(undefined);
    if (!namespace || !hostEnvironmentId || status !== 'verified') return;
    void outboundDispatch
      .bindLegacyHost({
        apiBase,
        environmentId: hostEnvironmentId,
        authorityNamespace: namespace,
        host: true,
      })
      .then(() => {
        if (current) setReadyNamespace(namespace);
      })
      .catch(() => {
        /* Unknown legacy ownership never grants peer replay. */
      });
    return () => {
      current = false;
    };
  }, [apiBase, hostEnvironmentId, namespace, status]);
  useEffect(() => {
    let current = true;
    const refresh = () => {
      void outboundDispatch
        .snapshot()
        .then((next) => {
          if (current) setRows(next);
        })
        .catch(() => {});
    };
    refresh();
    const stop = outboundDispatch.subscribe(refresh);
    const stopRemote = outboundDispatch.subscribeRemoteChange(refresh);
    return () => {
      current = false;
      stop();
      stopRemote();
    };
  }, []);
  const bindings = useMemo(() => {
    const chatBindings: unknown[] = JSON.parse(chatBindingsSignature);
    const next = new Map<string, ChatStationBindingV1>();
    for (const candidate of [
      ...chatBindings,
      ...rows.map((row) => row.station?.binding),
    ]) {
      const binding = readChatStationBinding(candidate);
      if (binding && binding.affinity.kind !== 'host')
        next.set(stationStateKey(binding), binding);
    }
    return next;
  }, [chatBindingsSignature, rows]);
  if (!namespace || readyNamespace !== namespace || status !== 'verified')
    return null;
  return (
    <>
      <ConnectionQueueOwner key={`host:${namespace}`} />
      {[...bindings].map(([key, binding]) =>
        enabled ? (
          <ConnectionQueueOwner key={key} binding={binding} rows={rows} />
        ) : (
          <RetainedQueueProjection key={key} binding={binding} rows={rows} />
        ),
      )}
    </>
  );
}

function ConnectionQueueOwner({
  binding,
  rows = [],
}: {
  binding?: ChatStationBindingV1;
  rows?: OutboundDispatchTurn[];
}) {
  const resolver = useStationConnections();
  const bindingKey = JSON.stringify(binding ?? null);
  const [resolved, setResolved] = useState<{
    key: string;
    connection: StationConnection;
  }>();
  useEffect(() => {
    let current = true;
    let release = () => {};
    const target = readChatStationBinding(JSON.parse(bindingKey));
    void resolver
      .resolve(target ? { binding: target } : undefined)
      .then(async (lease) => {
        release = lease.release;
        if (!current) {
          release();
          return;
        }
        await activeChatsStore.recoverLegacyImports(lease.connection);
        if (current && lease.connection.isCurrent())
          setResolved({ key: bindingKey, connection: lease.connection });
      })
      .catch(() => {
        /* Retained work waits for its original connection. */
      });
    return () => {
      current = false;
      release();
    };
  }, [bindingKey, resolver]);
  return resolved?.key === bindingKey && resolved.connection.isCurrent() ? (
    <ConnectionQueueFlushMount connection={resolved.connection} />
  ) : binding ? (
    <RetainedQueueProjection binding={binding} rows={rows} />
  ) : null;
}

function RetainedQueueProjection({
  binding,
  rows,
}: {
  binding: ChatStationBindingV1;
  rows: OutboundDispatchTurn[];
}) {
  const { namespace } = useAuthorityPersistence();
  const bindingKey = JSON.stringify(binding);
  useEffect(() => {
    if (!namespace) return;
    const target = readChatStationBinding(JSON.parse(bindingKey));
    if (!target || target.affinity.kind === 'host') return;
    const station: OutboundStationIdentity = {
      binding: target,
      apiBase: '',
      environmentId: target.environmentId,
      authorityNamespace: JSON.stringify([
        namespace,
        target.affinity.principalNamespace,
      ]),
    };
    let current = true;
    void outboundDispatch
      .retiredKeys(station, { partitioned: true })
      .then((retired) => {
        if (current)
          projectOutboundQueueEntries(rows, retired, undefined, station);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [bindingKey, namespace, rows]);
  return null;
}

function ConnectionQueueFlushMount({
  connection,
}: {
  connection: StationConnection;
}) {
  const client = useQueryClient();
  useEffect(() => {
    if (connection.routeKind === 'host' || !connection.isCurrent()) return;
    return ensureOrchestrationEventStream(
      connection.targetApiBase,
      client,
      undefined,
      false,
      false,
      connection,
    );
  }, [client, connection]);
  useOutboundQueueFlush(connection.targetApiBase, connection);
  return null;
}

import { listProjects } from '@kontourai/station-sdk/client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  GLOBAL_CONTEXT,
  NO_PROJECT_LABEL,
} from '../components/modals/new-chat-modal-utils';
import { useStationConnectionsOptional } from '../connections/StationConnectionsContext';
import type { StationConnection } from '../connections/station-connection';

/** A remote chat chooses the receiver's Project explicitly, never a local slug. */
export function useConversationStartTarget(
  environmentId: string | undefined,
  enabled: boolean,
) {
  const connections = useStationConnectionsOptional();
  const active = enabled && !!environmentId && environmentId !== 'current';
  const [attempt, setAttempt] = useState(0);
  const [resolved, setResolved] = useState<{
    environmentId: string;
    connection?: StationConnection;
    error?: unknown;
  }>();
  useEffect(() => {
    void attempt;
    if (!active || !connections?.remoteEnabled || !environmentId) return;
    let cancelled = false;
    let release = () => {};
    void connections.resolve({ environmentId }).then(
      (lease) => {
        release = lease.release;
        if (cancelled) {
          release();
          return;
        }
        setResolved({ environmentId, connection: lease.connection });
      },
      (error) => {
        if (!cancelled) setResolved({ environmentId, error });
      },
    );
    return () => {
      cancelled = true;
      release();
    };
  }, [active, connections, environmentId, attempt]);
  const connection =
    active &&
    resolved?.environmentId === environmentId &&
    resolved.connection?.isCurrent()
      ? resolved.connection
      : undefined;
  const scope = useMemo(
    () =>
      connection
        ? { ...connection.requestScope, isCurrent: connection.isCurrent }
        : undefined,
    [connection],
  );
  const apiBase = connection?.targetApiBase;
  const projects = useQuery({
    queryKey: ['conversation-start-projects', apiBase, connection?.runtimeKey],
    enabled: !!scope?.isCurrent(),
    retry: false,
    queryFn: ({ signal }) => {
      if (!scope?.isCurrent())
        throw new Error('Reconnect to the selected Station.');
      return listProjects(apiBase!, { requestScope: scope, signal });
    },
  });
  const [choice, setChoice] = useState<{
    environmentId: string;
    context: string;
  }>();
  const context =
    choice && choice.environmentId === environmentId
      ? choice.context
      : undefined;
  const project = projects.data?.find((entry) => entry.slug === context);
  return {
    active,
    scope,
    connection,
    connectionError:
      active && resolved?.environmentId === environmentId
        ? resolved.error
        : undefined,
    reconnect: () => setAttempt((value) => value + 1),
    projects,
    context,
    project,
    ready: Boolean(
      connection &&
        connection.capabilities.startChat.state === 'allowed' &&
        (context === GLOBAL_CONTEXT || (projects.isSuccess && !!project)),
    ),
    choose: (value: string) => {
      if (environmentId) setChoice({ environmentId, context: value });
    },
    options: [
      {
        value: GLOBAL_CONTEXT,
        label: NO_PROJECT_LABEL,
        glyph: 'globe' as const,
      },
      ...(projects.data ?? []).map((entry) => ({
        value: entry.slug,
        label: entry.name,
        icon: entry.icon,
        workingDirectory: entry.workingDirectory,
      })),
    ],
  };
}

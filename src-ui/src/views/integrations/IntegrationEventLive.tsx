import type { ToolServerEventStreamFrame } from '@kontourai/station-contracts/tool';
import {
  type ApiRequestScope,
  useStreamIntegrationEventsMutation,
} from '@kontourai/station-sdk';
import { StationHttpError } from '@kontourai/station-sdk/client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { PageRow } from '../../components/PageRow';
import {
  describeReadFailure,
  ErrorState,
  SkeletonBlock,
} from '../../components/state';
import { IntegrationEventRead } from './IntegrationEventRead';

type EventArrival = Extract<ToolServerEventStreamFrame, { type: 'event' }>;
type EventListeningView = {
  cursor: string | null;
  events: EventArrival[];
  active: boolean;
  truncated: boolean;
  unavailable: boolean;
  warning: boolean;
};

const recentEventLimit = 20;

export function IntegrationEventLive({
  integrationId,
  name,
  scope,
}: {
  integrationId: string;
  name: string;
  scope: ApiRequestScope;
}) {
  const request = useStreamIntegrationEventsMutation();
  const session = useRef<AbortController | null>(null);
  const [view, setView] = useState<EventListeningView>({
    cursor: null,
    events: [],
    active: false,
    truncated: false,
    unavailable: false,
    warning: false,
  });
  const [stopping, setStopping] = useState(false);
  useEffect(
    () => () => {
      const current = session.current;
      session.current = null;
      current?.abort();
    },
    [],
  );

  const listen = () => {
    if (session.current) return;
    const controller = new AbortController();
    session.current = controller;
    setView((current) => ({
      ...current,
      active: false,
      unavailable: false,
      warning: false,
    }));
    void request
      .mutateAsync({
        id: integrationId,
        input: { name, cursor: view.cursor },
        requestScope: scope,
        signal: controller.signal,
        receive(frame) {
          if (session.current !== controller || controller.signal.aborted)
            return;
          setView((current) => {
            switch (frame.type) {
              case 'active':
                return {
                  ...current,
                  active: true,
                  cursor: frame.cursor,
                  truncated: current.truncated || frame.truncated,
                };
              case 'heartbeat':
                return { ...current, cursor: frame.cursor };
              case 'event': {
                const events = [
                  ...current.events.filter(
                    (event) => event.eventId !== frame.eventId,
                  ),
                  frame,
                ];
                return {
                  ...current,
                  cursor: frame.cursor,
                  events: events.slice(-recentEventLimit),
                  truncated:
                    current.truncated || events.length > recentEventLimit,
                };
              }
              case 'warning':
                return { ...current, warning: true };
              case 'ended':
                return {
                  ...current,
                  unavailable: frame.reason === 'unavailable',
                };
            }
          });
        },
      })
      .catch(() => {})
      .finally(() => {
        if (session.current !== controller) return;
        session.current = null;
        if (controller.signal.aborted) request.reset();
        setStopping(false);
        setView((current) => ({ ...current, active: false }));
      });
  };

  const stop = () => {
    if (!session.current) return;
    setStopping(true);
    session.current.abort();
  };

  const outdated =
    request.error instanceof StationHttpError && request.error.status === 404;
  const unavailable = request.isError || view.unavailable;
  return (
    <div className="content-stack integration-event-catalog">
      <PageRow
        title={
          stopping
            ? 'Stopping listener'
            : request.isPending
              ? 'Listening for events'
              : 'Live events'
        }
        control={
          <Button
            variant="primary"
            disabled={stopping}
            onClick={request.isPending ? stop : listen}
          >
            {request.isPending ? 'Stop listening' : 'Listen'}
          </Button>
        }
      />
      {request.isPending && !view.active ? (
        <SkeletonBlock label="Opening the event stream" />
      ) : (
        <>
          {outdated ? (
            <p>Update this Station to listen for events.</p>
          ) : unavailable ? (
            <ErrorState
              variant="compact"
              title="Live events unavailable"
              description={
                request.isError ? describeReadFailure(request.error) : undefined
              }
            />
          ) : null}
          {view.warning && request.isPending && (
            <p role="status">
              An event could not be read. Listening continues.
            </p>
          )}
          {(!unavailable || view.events.length > 0) && (
            <IntegrationEventRead
              events={view.events}
              truncated={view.truncated}
              emptyLabel="No live events received"
            />
          )}
        </>
      )}
    </div>
  );
}

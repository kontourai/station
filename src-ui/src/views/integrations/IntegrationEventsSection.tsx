import {
  type ApiRequestScope,
  useDiscoverIntegrationEventsMutation,
  usePollIntegrationEventsMutation,
} from '@kontourai/station-sdk';
import { StationHttpError } from '@kontourai/station-sdk/client';
import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { PageRow } from '../../components/PageRow';
import {
  describeReadFailure,
  ErrorState,
  SkeletonBlock,
} from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { IntegrationEventRead } from './IntegrationEventRead';

export function IntegrationEventsSection({
  integrationId,
}: {
  integrationId: string;
}) {
  const scope = useHostRequestAuthorityScope();
  if (!scope) return null;
  return (
    <EventCatalog
      key={JSON.stringify([scope.apiBase, scope.authorityKey, integrationId])}
      integrationId={integrationId}
      scope={scope}
    />
  );
}

function EventCatalog({
  integrationId,
  scope,
}: {
  integrationId: string;
  scope: ApiRequestScope;
}) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const discovery = useDiscoverIntegrationEventsMutation();
  const poll = usePollIntegrationEventsMutation();
  const [event, setEvent] = useState<{ name: string; label: string }>();
  const [lastCursor, setLastCursor] = useState<string | null>(null);
  const eventOpener = useRef<HTMLButtonElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (event) {
      back.current?.focus();
    } else if (open && eventOpener.current) {
      eventOpener.current.focus();
      eventOpener.current = null;
    }
  }, [event, open]);
  const check = () =>
    discovery.mutate({ id: integrationId, requestScope: scope });
  const backToCatalog = () => {
    setEvent(undefined);
    poll.reset();
  };
  const close = () => {
    setOpen(false);
    eventOpener.current = null;
    backToCatalog();
  };
  const read = (name: string, cursor: string | null) => {
    setLastCursor(cursor);
    poll.mutate({
      id: integrationId,
      requestScope: scope,
      input: { name, cursor },
    });
  };
  const currentPage = poll.data?.supported ? poll.data : undefined;
  const outdatedPoll =
    poll.error instanceof StationHttpError && poll.error.status === 404;
  const outdated =
    discovery.error instanceof StationHttpError &&
    discovery.error.status === 404;

  return (
    <section className="agent-editor__section" aria-label="MCP Events">
      <PageRow
        title="MCP Events"
        control={
          <Button
            ref={opener}
            onClick={() => {
              if (discovery.isPending) return;
              setOpen(true);
              check();
            }}
            aria-disabled={discovery.isPending}
          >
            Check events
          </Button>
        }
      />
      {open && (
        <Dialog
          title={event?.label ?? 'MCP Events'}
          closeLabel="Close MCP Events"
          onClose={close}
          returnFocusTarget={opener.current}
          footer={
            event ? (
              <>
                <Button ref={back} onClick={backToCatalog}>
                  Back
                </Button>
                {currentPage && (
                  <Button
                    variant="primary"
                    onClick={() => read(event.name, currentPage.cursor)}
                  >
                    {currentPage.hasMore ? 'Next page' : 'Check again'}
                  </Button>
                )}
              </>
            ) : (
              <Button onClick={close}>Done</Button>
            )
          }
        >
          {event &&
            (outdatedPoll ? (
              <p>Update this Station to read event pages.</p>
            ) : poll.isError ? (
              <ErrorState
                variant="compact"
                title="Events unavailable"
                description={describeReadFailure(poll.error)}
                action={
                  <Button onClick={() => read(event.name, lastCursor)}>
                    Retry
                  </Button>
                }
              />
            ) : poll.data ? (
              <IntegrationEventRead page={poll.data} />
            ) : (
              <SkeletonBlock label="Reading events" />
            ))}
          <div hidden={Boolean(event)}>
            {outdated ? (
              <p>Update this Station to check MCP Events.</p>
            ) : discovery.isError ? (
              <ErrorState
                variant="compact"
                title="Event catalog unavailable"
                description={describeReadFailure(discovery.error)}
                action={<Button onClick={check}>Retry</Button>}
              />
            ) : discovery.data?.supported ? (
              discovery.data.events.length ? (
                <section
                  className="integration-event-catalog"
                  aria-label="Available event types"
                >
                  {discovery.data.events.map((event) => (
                    <PageRow
                      key={event.name}
                      title={event.title || event.name}
                      description={event.description}
                      control={
                        <Button
                          onClick={(click) => {
                            eventOpener.current = click.currentTarget;
                            setEvent({
                              name: event.name,
                              label: event.title || event.name,
                            });
                            read(event.name, null);
                          }}
                        >
                          Read events
                        </Button>
                      }
                    />
                  ))}
                </section>
              ) : (
                <p>This tool server offers no event types.</p>
              )
            ) : discovery.data ? (
              <p>This tool server does not advertise MCP Events.</p>
            ) : (
              <SkeletonBlock label="Checking events" />
            )}
          </div>
        </Dialog>
      )}
    </section>
  );
}

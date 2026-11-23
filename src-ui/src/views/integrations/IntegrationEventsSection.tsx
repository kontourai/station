import {
  type ApiRequestScope,
  useDiscoverIntegrationEventsMutation,
} from '@kontourai/station-sdk';
import { StationHttpError } from '@kontourai/station-sdk/client';
import { useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { PageRow } from '../../components/PageRow';
import { ErrorState, SkeletonBlock } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';

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
  const check = () =>
    discovery.mutate({ id: integrationId, requestScope: scope });
  const close = () => setOpen(false);
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
          title="MCP Events"
          closeLabel="Close MCP Events"
          onClose={close}
          returnFocusTarget={opener.current}
          footer={<Button onClick={close}>Done</Button>}
        >
          {outdated ? (
            <p>Update this Station to check MCP Events.</p>
          ) : discovery.isError ? (
            <ErrorState
              variant="compact"
              title="Event catalog unavailable"
              description={discovery.error.message}
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
        </Dialog>
      )}
    </section>
  );
}

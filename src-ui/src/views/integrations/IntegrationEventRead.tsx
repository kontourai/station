import type { ToolServerEventPollPage } from '@kontourai/station-contracts/tool';
import { useId, useState } from 'react';
import { DisclosureToggle } from '../../components/DisclosureToggle';
import { PageRow } from '../../components/PageRow';
import { Empty } from '../../components/state';

const eventTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

export function IntegrationEventRead({
  page,
}: {
  page: ToolServerEventPollPage;
}) {
  if (!page.supported)
    return <p>This tool server does not advertise MCP Events.</p>;

  return (
    <div className="content-stack">
      {page.truncated && (
        <p role="status">Some earlier events are unavailable.</p>
      )}
      {page.events.length === 0 ? (
        <Empty variant="compact" label="No events in this page" />
      ) : (
        <section
          className="integration-event-catalog"
          aria-label="Event results"
        >
          {page.events.map((event) => (
            <EventDetails key={event.eventId} event={event} />
          ))}
        </section>
      )}
    </div>
  );
}

function EventDetails({
  event,
}: {
  event: Extract<
    ToolServerEventPollPage,
    { supported: true }
  >['events'][number];
}) {
  const payloadId = useId();
  const [open, setOpen] = useState(false);
  return (
    <PageRow
      title={
        <time dateTime={event.timestamp}>
          {eventTime.format(new Date(event.timestamp))}
        </time>
      }
      description={<code>{event.eventId}</code>}
    >
      <DisclosureToggle
        expanded={open}
        controls={payloadId}
        onToggle={() => setOpen(!open)}
      >
        Event data
      </DisclosureToggle>
      <pre id={payloadId} className="integration-event-data" hidden={!open}>
        {open && JSON.stringify(event.data, null, 2)}
      </pre>
    </PageRow>
  );
}

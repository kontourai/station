import {
  STATION_RELEASE_HISTORY_URL,
  type StationReleaseNotes,
  useStationReleaseHistoryQuery,
  useStationReleaseNotesQuery,
} from '@kontourai/station-sdk/release-notes-query';
import { Field, Select } from '@kontourai/ui/react';
import { useId, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '../Button';
import { DisclosureToggle } from '../DisclosureToggle';
import { Empty, ErrorState, SkeletonBlock } from '../state';
import './Updates.css';

function NotesBody({ body }: { body: string }) {
  return (
    <div className="release-notes__body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children, href }) => {
            const pull =
              /^https:\/\/github\.com\/kontourai\/station\/pull\/(\d+)$/.exec(
                href ?? '',
              );
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {pull && children === href ? `#${pull[1]}` : children}
              </a>
            );
          },
          img: ({ alt }) => <span>{alt}</span>,
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

function MissingNotes({ retry }: { retry?: () => void }) {
  return (
    <Empty
      label="Release notes unavailable"
      description="A changelog has not been published for this version."
      action={
        retry ? (
          <Button onClick={retry}>Check release notes again</Button>
        ) : undefined
      }
    />
  );
}

function PublishedNotes({
  release,
  history = false,
}: {
  release: StationReleaseNotes;
  history?: boolean;
}) {
  return (
    <article className="content-stack">
      {release.body.trim() ? (
        <NotesBody body={release.body} />
      ) : (
        <MissingNotes />
      )}
      <footer className="release-notes__links">
        <a href={release.url} target="_blank" rel="noopener noreferrer">
          View this release on GitHub
        </a>
        {history && (
          <a
            href={STATION_RELEASE_HISTORY_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            All releases on GitHub
          </a>
        )}
      </footer>
    </article>
  );
}

export function ReleaseNotes({
  version,
  nativeApp = false,
  notes,
  active = true,
  collapsible = false,
}: {
  version: string;
  nativeApp?: boolean;
  notes?: string | null;
  active?: boolean;
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expanded = !collapsible || open;
  const id = useId();
  const query = useStationReleaseNotesQuery(
    version,
    nativeApp,
    active && expanded,
  );
  return (
    <section className="release-notes content-stack">
      {collapsible ? (
        <DisclosureToggle
          expanded={expanded}
          onToggle={() => setOpen(!open)}
          controls={id}
        >
          What’s new
        </DisclosureToggle>
      ) : (
        <h4>What’s new</h4>
      )}
      {expanded && (
        <div id={id} className="content-stack">
          {query.data?.body.trim() ? (
            <PublishedNotes release={query.data} />
          ) : (
            <>
              {notes?.trim() && <NotesBody body={notes} />}
              {query.isFetching && !notes?.trim() && (
                <SkeletonBlock count={1} label="Loading release notes" />
              )}
              {query.isError ? (
                <ErrorState
                  variant="compact"
                  title="Could not load release notes."
                  action={
                    <Button onClick={() => void query.refetch()}>
                      Retry release notes
                    </Button>
                  }
                />
              ) : (
                !query.isFetching &&
                !notes?.trim() && (
                  <MissingNotes retry={() => void query.refetch()} />
                )
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

export function ReleaseHistory({
  active = true,
  nativeApp = false,
}: {
  active?: boolean;
  nativeApp?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState('');
  const id = useId();
  const query = useStationReleaseHistoryQuery(active && expanded);
  const releases = nativeApp
    ? query.data
        ?.slice()
        .sort(
          (a, b) =>
            Number(b.tag.startsWith('desktop-')) -
            Number(a.tag.startsWith('desktop-')),
        )
    : query.data;
  const release =
    releases?.find((entry) => entry.tag === selected) ?? releases?.[0];
  return (
    <section className="release-history content-stack">
      <DisclosureToggle
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        controls={id}
      >
        Previous versions and changelogs
      </DisclosureToggle>
      {expanded && (
        <div id={id} className="content-stack">
          {query.isFetching && !query.data && (
            <SkeletonBlock count={1} label="Loading release history" />
          )}
          {query.isError && (
            <ErrorState
              variant="compact"
              title="Could not load release history."
              action={
                <Button onClick={() => void query.refetch()}>
                  Retry release history
                </Button>
              }
            />
          )}
          {query.data &&
            (query.data.length ? (
              <>
                <Field label="Release" htmlFor={`${id}-release`}>
                  <Select
                    id={`${id}-release`}
                    value={release?.tag ?? ''}
                    onChange={(event) => setSelected(event.target.value)}
                  >
                    {releases?.map((entry) => (
                      <option key={entry.tag} value={entry.tag}>
                        {entry.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                {release && <PublishedNotes release={release} history />}
              </>
            ) : (
              <Empty
                label="Nothing here yet"
                description="Versioned releases have not been published yet."
              />
            ))}
          {!query.data?.length && (
            <a
              href={STATION_RELEASE_HISTORY_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              All releases on GitHub
            </a>
          )}
        </div>
      )}
    </section>
  );
}

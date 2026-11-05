import {
  STATION_RELEASE_HISTORY_URL,
  type StationReleaseNotes,
  useStationReleaseHistoryQuery,
  useStationReleaseNotesQuery,
} from '@kontourai/station-sdk/release-notes-query';
import { useId, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '../Button';
import { Empty, ErrorState, SkeletonBlock } from '../state';
import './Updates.css';

function NotesBody({ body }: { body: string }) {
  return (
    <div className="release-notes__body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ alt }) => <span>{alt}</span>,
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

function MissingNotes() {
  return (
    <Empty
      variant="compact"
      label="Nothing here yet"
      description="A changelog has not been published for this version."
    />
  );
}

function PublishedNotes({ release }: { release: StationReleaseNotes }) {
  return (
    <>
      {release.body.trim() ? (
        <NotesBody body={release.body} />
      ) : (
        <MissingNotes />
      )}
      <a href={release.url} target="_blank" rel="noopener noreferrer">
        View this release on GitHub
      </a>
    </>
  );
}

export function ReleaseNotes({
  version,
  nativeApp = false,
  notes,
  active = true,
}: {
  version: string;
  nativeApp?: boolean;
  notes?: string | null;
  active?: boolean;
}) {
  const query = useStationReleaseNotesQuery(version, nativeApp, active);
  return (
    <div className="release-notes">
      <h4>What’s new in {version}</h4>
      {query.data ? (
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
            !query.isFetching && !notes?.trim() && <MissingNotes />
          )}
        </>
      )}
    </div>
  );
}

export function ReleaseHistory({ active = true }: { active?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState('');
  const id = useId();
  const query = useStationReleaseHistoryQuery(active && expanded);
  const release =
    query.data?.find((entry) => entry.tag === selected) ?? query.data?.[0];
  return (
    <details
      className="release-history"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>Previous versions and changelogs</summary>
      {expanded && (
        <>
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
                <label htmlFor={id}>Release</label>
                <select
                  id={id}
                  value={release?.tag ?? ''}
                  onChange={(event) => setSelected(event.target.value)}
                >
                  {query.data.map((entry) => (
                    <option key={entry.tag} value={entry.tag}>
                      {entry.name}
                    </option>
                  ))}
                </select>
                {release && <PublishedNotes release={release} />}
              </>
            ) : (
              <Empty
                variant="compact"
                label="Nothing here yet"
                description="Versioned releases have not been published yet."
              />
            ))}
        </>
      )}
      <a
        href={STATION_RELEASE_HISTORY_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        All releases on GitHub
      </a>
    </details>
  );
}

import type { ExternalSessionHistoryEntry } from '@kontourai/station-contracts/orchestration';
import {
  cancelExternalSessionHistoryImport,
  useExternalSessionHistoryQuery,
  useExternalSessionTranscriptQuery,
  useImportExternalSessionHistory,
} from '@kontourai/station-sdk/external-session-history-query';
import { Field, Input, Select } from '@kontourai/ui/react';
import { useEffect, useRef, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { ActionRow } from '../ActionRow';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { Empty, ErrorState, SkeletonList } from '../state';

const engineNames: Readonly<Record<string, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
  opencode: 'OpenCode',
  acp: 'Custom engine',
};

export function ExternalSessionHistory({
  onClose,
  onOpenSaved,
}: {
  onClose: () => void;
  onOpenSaved: (threadId: string) => void;
}) {
  const scope = useHostRequestAuthorityScope();
  const [selected, select] = useState<ExternalSessionHistoryEntry>();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [provider, setProvider] = useState('');
  return (
    <Dialog
      title="Third-party history"
      closeLabel="Close third-party history"
      onClose={onClose}
    >
      {!scope ? (
        <Empty label="Connect to Station to browse history" />
      ) : selected ? (
        <ArchiveTranscript
          key={selected.id}
          entry={selected}
          onBack={() => select(undefined)}
          onOpen={onOpenSaved}
        />
      ) : (
        <div className="content-stack">
          <form
            className="content-stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (!provider) setOffset(0);
              setSearch(searchInput.trim());
            }}
          >
            <Field label="Engine" htmlFor="external-history-provider">
              <Select
                id="external-history-provider"
                value={provider}
                onChange={(event) => {
                  setProvider(event.target.value);
                  setOffset(0);
                  setSearch('');
                  setSearchInput('');
                }}
              >
                <option value="">All engines</option>
                {Object.entries(engineNames).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label={
                provider
                  ? 'Filter this page by folder'
                  : 'Search by engine or folder'
              }
              htmlFor="external-history-search"
            >
              <Input
                id="external-history-search"
                value={searchInput}
                maxLength={120}
                onChange={(event) => setSearchInput(event.target.value)}
              />
            </Field>
            <Button type="submit">Search</Button>
          </form>
          <ArchiveList
            offset={offset}
            provider={provider || undefined}
            search={search}
            move={setOffset}
            select={select}
          />
        </div>
      )}
    </Dialog>
  );
}

function ArchiveList({
  offset,
  search,
  provider,
  move,
  select,
}: {
  offset: number;
  search: string;
  provider?: string;
  move: (offset: number) => void;
  select: (entry: ExternalSessionHistoryEntry) => void;
}) {
  const query = useExternalSessionHistoryQuery(
    useHostRequestAuthorityScope(),
    offset,
    search,
    provider,
  );
  if (query.isLoading)
    return <SkeletonList label="Finding third-party conversations" />;
  if (query.isError)
    return (
      <ErrorState
        title="Couldn’t load third-party history"
        description={query.error.message}
        action={<Button onClick={() => void query.refetch()}>Retry</Button>}
      />
    );
  const data = query.data;
  if (!data) return null;
  return (
    <>
      {data.partial && (
        <p>
          {provider
            ? 'Some conversations are outside this engine’s current scan limits.'
            : 'Choose an engine to browse older conversations.'}
        </p>
      )}
      {data.sessions.length === 0 ? (
        <Empty
          label={
            data.nextOffset === null
              ? 'No conversations found'
              : 'No matches on this page'
          }
        />
      ) : (
        <ul className="content-stack">
          {data.sessions.map((entry) => (
            <li key={entry.id}>
              <Button onClick={() => select(entry)}>
                {engineNames[entry.provider] ?? entry.provider} ·{' '}
                {new Date(entry.updatedAt).toLocaleString()}
              </Button>
              <div>{entry.cwd || 'Folder unavailable'}</div>
            </li>
          ))}
        </ul>
      )}
      {offset > 0 && <Button onClick={() => move(0)}>First page</Button>}
      {data.nextOffset !== null && (
        <Button onClick={() => move(data.nextOffset ?? 0)}>Next page</Button>
      )}
    </>
  );
}

function ArchiveTranscript({
  entry,
  onBack,
  onOpen,
}: {
  entry: ExternalSessionHistoryEntry;
  onBack: () => void;
  onOpen: (threadId: string) => void;
}) {
  const scope = useHostRequestAuthorityScope();
  const [cursor, setCursor] = useState<string | null>(null);
  const [fromStart, setFromStart] = useState(false);
  const [canceled, setCanceled] = useState(false);
  const [cancelError, setCancelError] = useState<string>();
  const [canceling, setCanceling] = useState(false);
  const activeImport = useRef<
    { abort: AbortController; cancel: () => Promise<void> } | undefined
  >(undefined);

  const query = useExternalSessionTranscriptQuery(
    entry.hasTranscript ? scope : undefined,
    entry.id,
    cursor,
    fromStart,
  );
  const imported = useImportExternalSessionHistory(scope);
  useEffect(
    () => () => {
      const operation = activeImport.current;
      if (operation) {
        void operation.cancel().catch(() => undefined);
        operation.abort.abort();
      }
    },
    [],
  );
  const openSaved = () => {
    if (canceling || !scope?.isCurrent() || !imported.data) return;
    onOpen(imported.data.threadId);
  };
  const startImport = () => {
    if (activeImport.current || canceling || !scope?.isCurrent()) return;
    const abort = new AbortController();
    const operationId = Array.from(
      crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    activeImport.current = {
      abort,
      cancel: () =>
        cancelExternalSessionHistoryImport(
          scope.apiBase,
          entry.id,
          operationId,
          { requestScope: scope },
        ),
    };
    setCanceled(false);
    setCancelError(undefined);
    imported.mutate(
      { id: entry.id, operationId, signal: abort.signal },
      {
        onSettled: () => {
          activeImport.current = undefined;
        },
      },
    );
  };
  const stopImport = async () => {
    const operation = activeImport.current;
    if (!operation) return;
    setCancelError(undefined);
    setCanceling(true);
    try {
      await operation.cancel();
      operation.abort.abort();
      setCanceled(true);
    } catch {
      setCancelError('Couldn’t stop the import. Try again.');
    } finally {
      setCanceling(false);
    }
  };
  const nextCursor = query.data?.nextCursor;
  return (
    <div className="content-stack">
      <Button disabled={imported.isPending || canceling} onClick={onBack}>
        Back to results
      </Button>
      <p>{entry.cwd}</p>
      {!entry.hasTranscript ? (
        <Empty label="Transcript unavailable for this engine" />
      ) : query.isLoading ? (
        <SkeletonList label="Reading transcript" />
      ) : query.isError ? (
        <ErrorState
          title="Couldn’t read the transcript"
          description={query.error.message}
          action={<Button onClick={() => void query.refetch()}>Retry</Button>}
        />
      ) : (
        query.data && (
          <>
            {query.data.startsNearEnd && (
              <>
                <p>Preview starts near the end of this transcript.</p>
                <Button
                  disabled={imported.isPending || canceling}
                  onClick={() => {
                    setCursor(null);
                    setFromStart(true);
                  }}
                >
                  Read from the beginning
                </Button>
              </>
            )}
            {query.data.truncated && (
              <p>Some text was shortened for this preview.</p>
            )}
            {query.data.messages.length === 0 && (
              <Empty label="This page has no message text" />
            )}
            {query.data.messages.map((message) => (
              <article key={message.id}>
                <strong>{message.role === 'user' ? 'You' : 'Agent'}</strong>
                <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {message.text}
                </p>
              </article>
            ))}
            <ActionRow
              label="Transcript pages"
              overflowLabel="More transcript actions"
              secondary={
                cursor && (
                  <Button
                    disabled={imported.isPending || canceling}
                    onClick={() => setCursor(null)}
                  >
                    First page
                  </Button>
                )
              }
              primary={
                nextCursor && (
                  <Button
                    disabled={imported.isPending || canceling}
                    onClick={() => setCursor(nextCursor)}
                  >
                    More messages
                  </Button>
                )
              }
            />
          </>
        )
      )}
      {(imported.isPending || canceling || imported.data || query.data) && (
        <>
          {(imported.isPending || canceling) && (
            <p role="status">
              {canceling ? 'Stopping import…' : 'Importing conversation…'}
            </p>
          )}
          <ActionRow
            label="Save conversation"
            overflowLabel="More conversation actions"
            primary={
              imported.isPending || canceling ? (
                <Button onClick={() => void stopImport()} disabled={canceling}>
                  Cancel import
                </Button>
              ) : imported.data ? (
                <Button onClick={openSaved}>Open saved conversation</Button>
              ) : (
                <Button onClick={startImport}>
                  {canceled ? 'Resume import' : 'Import conversation'}
                </Button>
              )
            }
          />
          {canceled && !imported.data && (
            <p role="status">
              Import canceled. Any saved messages stay in History.
            </p>
          )}
          {cancelError && <ErrorState variant="compact" title={cancelError} />}
          {imported.error && !canceled && (
            <ErrorState
              variant="compact"
              title="Import paused"
              description={imported.error.message}
            />
          )}
        </>
      )}
    </div>
  );
}

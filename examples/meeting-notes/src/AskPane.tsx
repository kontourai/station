/**
 * Ask pane — retrieval-grounded Q&A over the K3 index
 * (`s203-knowledge-meeting-notes` plan, Wave 2 Task 5, AC2-provenance-qa).
 *
 * Per the pickup Probe's Q3 decision (`s203-knowledge-meeting-notes--pull-
 * work.md` §pickup_probe): "the honest v1 is retrieval + excerpt
 * presentation with provenance links (no generation)". This pane is a
 * search box, not a chat product — a query goes straight to Task 2's
 * `POST /api/knowledge/index/search` (via `useSearchKnowledgeIndexMutation`)
 * and every hit is rendered as an answer card (title, category, matched
 * excerpt, score) with a provenance affordance that opens the source
 * record's own detail (self-contained here — see the module doc below for
 * why, and the noted Wave 3 duplication). No `useSendToChat`/model call is
 * wired in; Q3 already resolved that question, so this file does not
 * re-litigate it.
 *
 * Provenance/detail rendering: `examples/knowledge-docs-starter/` type-shape
 * precedent aside, this plan's Wave 2 Task 4 (`GraphPane.tsx`, a parallel
 * worker's file) is expected to introduce its own "open a record's detail"
 * affordance for the Library tab. As of this task's landing, `GraphPane.tsx`
 * does not exist yet in this worktree and `index.tsx` defines no shared
 * cross-pane selection state to coordinate through, so this pane renders its
 * own self-contained detail panel (fetching the full `KitRecord` via
 * `useKnowledgeRecordQuery` on demand). `GraphPane.tsx` has since landed with
 * its own detail panel and the two panes still don't share cross-pane
 * selection state — that remains a deliberate, small duplication (each
 * pane's detail affordance is scoped to its own tab), not a follow-up this
 * Wave 3 cleanup pass reopens. The relevant-root filter duplication IS
 * addressed by this pass — see `./roots.ts`.
 */

import type { LayoutComponentProps } from '@kontourai/station-sdk';
import {
  useApiBase,
  useKnowledgeRecordQuery,
  useKnowledgeRootsQuery,
  useNavigation,
  useSearchKnowledgeIndexMutation,
} from '@kontourai/station-sdk';
import type { KnowledgeSearchResult } from '@kontourai/station-sdk/client';
import { type FormEvent, useState } from 'react';
import { isRelevantRoot } from './roots';
import { Empty, ErrorState, Skeleton } from './state';

/** Sentinel scope-picker value for "search every relevant root" (as opposed
 * to one specifically-selected root) — never a real root id, so it can
 * never collide with a registered root's `id` (`root:...`-prefixed). */
const ALL_ROOTS_VALUE = '__all__';

/** Matches `NO_EMBEDDER_ERROR`'s exact wording in
 * `src-server/routes/knowledge-index-routes.ts` — the same honest-400
 * convention `/index/rebuild`/`/migrate` already use. */
function isNoEmbedderError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('No embedding provider connection is configured')
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SourceDetailProps {
  rootId: string;
  recordId: string;
  onClose: () => void;
}

/** Self-contained provenance detail — see module doc. Fetches the hit's full
 * `KitRecord` (never trusts the search hit's own fields as the record —
 * same K3 "never treat an index hit as the record" rule the search route
 * itself already applies server-side). */
function SourceDetail({ rootId, recordId, onClose }: SourceDetailProps) {
  const recordQuery = useKnowledgeRecordQuery(rootId, recordId);

  return (
    <section
      className="mn-ask-detail"
      data-testid="mn-ask-detail"
      aria-label="Source record detail"
    >
      <div className="mn-ask-detail__header">
        <span className="mn-ask-detail__title">Source record</span>
        <button
          type="button"
          className="button button--secondary button--small"
          data-testid="mn-ask-detail-close"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      {recordQuery.isLoading && <Skeleton variant="line" />}
      {recordQuery.isError && (
        <ErrorState
          title="Could not load source record"
          description={errorText(recordQuery.error)}
        />
      )}
      {recordQuery.data && (
        <div className="mn-ask-detail__body">
          <p className="mn-ask-detail__meta">
            <strong>{recordQuery.data.title}</strong> · {recordQuery.data.type}{' '}
            / {recordQuery.data.category}
          </p>
          <p className="mn-ask-detail__id">
            <code>{recordQuery.data.id}</code>
          </p>
          <pre className="mn-ask-detail__content">{recordQuery.data.body}</pre>
        </div>
      )}
    </section>
  );
}

interface AnswerCardProps {
  result: KnowledgeSearchResult;
  isSelected: boolean;
  onViewSource: () => void;
}

function AnswerCard({ result, isSelected, onViewSource }: AnswerCardProps) {
  return (
    <li className="mn-ask-card" data-testid="mn-ask-result">
      <div className="mn-ask-card__header">
        <span className="mn-ask-card__title">{result.title}</span>
        <span className="mn-ask-card__category">{result.category}</span>
      </div>
      <blockquote className="mn-ask-card__excerpt">{result.excerpt}</blockquote>
      <div className="mn-ask-card__footer">
        <span className="mn-ask-card__score">
          Relevance score: {result.score.toFixed(3)}
        </span>
        <button
          type="button"
          className="mn-ask-card__source-link"
          data-testid={`mn-ask-source-link-${result.recordId}`}
          aria-pressed={isSelected}
          onClick={onViewSource}
        >
          View source record →
        </button>
      </div>
    </li>
  );
}

export function AskPane(_props: LayoutComponentProps) {
  const { apiBase } = useApiBase();
  const navigation = useNavigation() as {
    selectedProject?: string | null;
    navigate?: (pathname: string) => void;
  };
  const selectedProject = navigation.selectedProject ?? null;
  const rootsQuery = useKnowledgeRootsQuery();

  const [query, setQuery] = useState('');
  const [scopeRootId, setScopeRootId] = useState<string>(ALL_ROOTS_VALUE);
  const [selectedResult, setSelectedResult] =
    useState<KnowledgeSearchResult | null>(null);

  const searchMutation = useSearchKnowledgeIndexMutation();

  if (!apiBase) {
    return (
      <ErrorState
        title="Station API is not available"
        description="This pane needs a live Station connection to search the knowledge index."
      />
    );
  }

  if (rootsQuery.isLoading) {
    return (
      <div className="mn-shell" data-testid="mn-ask-pane">
        <Skeleton variant="line" className="mn-root-picker__skeleton" />
      </div>
    );
  }

  if (rootsQuery.isError) {
    return (
      <ErrorState
        title="Could not load knowledge roots"
        description={errorText(rootsQuery.error)}
      />
    );
  }

  const relevantRoots = (rootsQuery.data ?? []).filter((root) =>
    isRelevantRoot(root, selectedProject),
  );

  if (relevantRoots.length === 0) {
    return (
      <Empty
        variant="compact"
        label="No personal or project knowledge root registered yet"
        description="Register a personal or project knowledge-store root in Settings before asking questions about your meetings."
      />
    );
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    setSelectedResult(null);
    const rootIds =
      scopeRootId === ALL_ROOTS_VALUE
        ? relevantRoots.map((root) => root.id)
        : [scopeRootId];
    searchMutation.mutate({ query: trimmed, rootIds });
  };

  const results = searchMutation.data ?? [];

  return (
    <div className="mn-shell" data-testid="mn-ask-pane">
      <form className="mn-toolbar" onSubmit={handleSubmit}>
        <label className="mn-field" htmlFor="mn-ask-scope">
          <span className="mn-field__label">Search scope</span>
          <select
            id="mn-ask-scope"
            data-testid="mn-ask-scope"
            className="mn-select"
            value={scopeRootId}
            onChange={(event) => setScopeRootId(event.target.value)}
          >
            <option value={ALL_ROOTS_VALUE}>
              All roots (personal + active project)
            </option>
            {relevantRoots.map((root) => (
              <option key={root.id} value={root.id}>
                {root.displayName} (
                {root.scope.kind === 'personal' ? 'personal' : 'project'})
              </option>
            ))}
          </select>
        </label>
        <label className="mn-field mn-ask-field__query" htmlFor="mn-ask-query">
          <span className="mn-field__label">Ask about your meetings</span>
          <input
            id="mn-ask-query"
            data-testid="mn-ask-query"
            className="mn-select mn-ask-input"
            type="text"
            placeholder="e.g. what did we decide about the roadmap?"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="button button--primary"
          data-testid="mn-ask-submit"
          disabled={!query.trim() || searchMutation.isPending}
        >
          {searchMutation.isPending ? 'Searching…' : 'Ask'}
        </button>
      </form>

      {searchMutation.isPending && (
        <div data-testid="mn-ask-loading">
          <Skeleton variant="line" />
          <Skeleton variant="line" />
          <Skeleton variant="line" />
        </div>
      )}

      {searchMutation.isError && isNoEmbedderError(searchMutation.error) && (
        <ErrorState
          title="No embedding model configured"
          description={
            <>
              Retrieval-grounded search needs an embedding-capable Model
              connection. Configure one in Connections → Models, then ask again.
            </>
          }
          action={
            navigation.navigate ? (
              <button
                type="button"
                className="button button--secondary button--small"
                data-testid="mn-ask-configure-embedder"
                onClick={() => navigation.navigate?.('/connections/models')}
              >
                Open Connections → Models
              </button>
            ) : undefined
          }
        />
      )}

      {searchMutation.isError && !isNoEmbedderError(searchMutation.error) && (
        <ErrorState
          title="Search failed"
          description={errorText(searchMutation.error)}
          action={
            <button
              type="button"
              className="button button--secondary button--small"
              data-testid="mn-ask-retry"
              onClick={handleSubmit as unknown as () => void}
            >
              Retry
            </button>
          }
        />
      )}

      {searchMutation.isIdle && (
        <Empty
          variant="prominent"
          label="Ask about your meetings…"
          description="Search returns retrieval-grounded excerpts from your compiled notes and raw transcripts, each with a link back to its source record. This is not a chat — no answer is generated, only found."
        />
      )}

      {searchMutation.isSuccess && results.length === 0 && (
        <Empty
          variant="compact"
          label="No matching excerpts found"
          description={`Nothing in the selected scope matched "${query.trim()}". Try a different phrasing or widen the scope to all roots.`}
        />
      )}

      {searchMutation.isSuccess && results.length > 0 && (
        <ul className="mn-ask-results" data-testid="mn-ask-results">
          {results.map((result) => (
            <AnswerCard
              key={`${result.rootId}:${result.recordId}`}
              result={result}
              isSelected={
                selectedResult?.recordId === result.recordId &&
                selectedResult?.rootId === result.rootId
              }
              onViewSource={() =>
                setSelectedResult((prev) =>
                  prev?.recordId === result.recordId &&
                  prev?.rootId === result.rootId
                    ? null
                    : result,
                )
              }
            />
          ))}
        </ul>
      )}

      {selectedResult && (
        <SourceDetail
          rootId={selectedResult.rootId}
          recordId={selectedResult.recordId}
          onClose={() => setSelectedResult(null)}
        />
      )}
    </div>
  );
}

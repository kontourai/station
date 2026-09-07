import {
  useConnectionsQuery,
  useGlobalKnowledgeStatusQuery,
  useSaveModelConnectionMutation,
  useTestVectorDbConnectionMutation,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { getPathForView } from '../app-shell/routing';
import { CheckGlyph, CloseGlyph } from '../components/icons/Glyph';
import { PageRow } from '../components/PageRow';
import { PageSection } from '../components/PageSection';
import { PageEyebrowTrail, usePageHeader } from '../components/page-frame';
import { SectionNav } from '../components/SectionNav';
import { Empty, ErrorState, Skeleton } from '../components/state';
import { useNavigation } from '../contexts/NavigationContext';
import { useCloseShortcut } from '../hooks/useCloseShortcut';
import { useSectionNavigation } from '../hooks/useSectionNavigation';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { modelProviderDisplayLabel } from '../utils/modelProviderDisplay';
import {
  findModelConnectionById,
  getKnowledgeInventory,
} from './connectionInventory';
import './KnowledgeConnectionView.css';
import './editor-layout.css';

function IconDatabase() {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}

function IconGlobe() {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

/**
 * The eyebrow this view publishes standalone (not `embedded`) — see the
 * usage site below for why it is unlinked.
 */
const CONNECTIONS_EYEBROW = (
  <PageEyebrowTrail segments={[{ label: 'Connections' }]} />
);

export function KnowledgeConnectionView({
  embedded = false,
}: {
  /**
   * When embedded inside another route-owning view (the /developer Storage
   * tab), skip this view's own page chrome (breadcrumb + DetailHeader) and its
   * Escape/close binding so it does not double-render the header or hijack the
   * host's route-level Escape fallback.
   */
  embedded?: boolean;
} = {}) {
  const { navigate } = useNavigation();

  const connectionsQuery = useConnectionsQuery();
  const statusQuery = useGlobalKnowledgeStatusQuery();
  const connections = connectionsQuery.data ?? [];
  const status = statusQuery.data;

  const { vectorDb: fallbackVectorDb, embeddingProvider: fallbackEmbedding } =
    getKnowledgeInventory(connections);
  const vectorDb =
    findModelConnectionById(connections, status?.vectorDb?.id) ??
    fallbackVectorDb;
  const embeddingProvider =
    findModelConnectionById(connections, status?.embedding?.id) ??
    fallbackEmbedding;

  const [dataDir, setDataDir] = useState<string | null>(null);
  const editingDataDir =
    dataDir ?? ((vectorDb?.config.dataDir as string) || '');

  const [testResult, setTestResult] = useState<{
    healthy: boolean;
  } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const saveMutation = useSaveModelConnectionMutation({
    onSuccess: () => {
      setDataDir(null);
    },
  });

  const testMutation = useTestVectorDbConnectionMutation({
    onSuccess: (data) => {
      setTestResult(data ?? null);
      setTestError(null);
    },
    onError: (err: Error) => {
      setTestResult(null);
      setTestError(err.message);
    },
  });

  const stats = status?.stats;
  /**
   * CI-R5: the index result is the receipt, and a zero is the most important
   * one to show — hiding the section until something had been indexed left
   * the surrounding "knowledge is on" copy standing next to nothing a reader
   * could check. Present whenever the server answered.
   */
  const hasUsage = Boolean(stats);
  const knowledgeSections = hasUsage
    ? (['vector-database', 'embedding-model', 'usage'] as const)
    : (['vector-database', 'embedding-model'] as const);
  const { activeSection, hrefForSection, navigateToSection } =
    useSectionNavigation(knowledgeSections, 'vector-database');
  const dirty =
    dataDir !== null && dataDir !== (vectorDb?.config.dataDir as string);
  const { guard, DiscardModal } = useUnsavedGuard(dirty);
  useCloseShortcut(() => guard(() => navigate('/connections')), !embedded);
  /**
   * Embedded in a Settings section this view is not a page, so it publishes
   * nothing — the host page keeps its own title. Standalone, the frame
   * renders the title this view used to draw itself.
   *
   * archive#4463: the eyebrow is the parent only
   * ('Connections'), unlinked — not the retired 'Connections / Knowledge
   * infrastructure' breadcrumb-as-eyebrow, which restated the title (the
   * host's own page heading) one line above it. Unlinked because
   * `/connections` is a redirect-only resolver: a click would be a no-op or
   * a sibling jump dressed up as "go up", the same call made for the five
   * `ConnectionsSectionFrame` sections.
   */
  usePageHeader(embedded ? null : { eyebrow: CONNECTIONS_EYEBROW });

  return (
    <>
      <div className="knowledge-view">
        <p className="knowledge-view__cross-link">
          Looking for a personal store?{' '}
          <button
            type="button"
            className="button button--link"
            onClick={() =>
              guard(() =>
                navigate('/settings', {
                  view: 'knowledge',
                  highlight: 'personal-knowledge-store',
                }),
              )
            }
          >
            Open Settings → My knowledge store
          </button>
          . Project-specific knowledge lives in that project's Settings →
          Project knowledge.
        </p>

        <SectionNav
          aria-label="Knowledge sections"
          items={knowledgeSections.map((id) => ({
            key: id,
            label:
              id === 'vector-database'
                ? 'Vector database'
                : id === 'embedding-model'
                  ? 'Embedding model'
                  : 'Usage',
            href: hrefForSection(id),
          }))}
          activeKey={activeSection}
          onNavigate={navigateToSection}
        />

        {/* Vector Database */}
        <PageSection
          id="section-vector-database"
          className="knowledge-view__section"
          eyebrow="Knowledge storage"
          title="Vector database"
          description="Choose where Station stores indexed documents and semantic search data."
        >
          {connectionsQuery.isLoading || statusQuery.isLoading ? (
            <Skeleton variant="block" />
          ) : connectionsQuery.isError || statusQuery.isError ? (
            <ErrorState
              variant="compact"
              title="Couldn't load vector database configuration."
            />
          ) : vectorDb ? (
            <div className="knowledge-view__card">
              <PageRow
                className="knowledge-view__card-header"
                label={
                  <>
                    <span className="knowledge-view__card-icon">
                      <IconDatabase />
                    </span>
                    <span className="knowledge-view__card-name">
                      {vectorDb.name}
                    </span>
                  </>
                }
                description={modelProviderDisplayLabel(vectorDb.type)}
                status={
                  <span
                    className={`knowledge-view__status knowledge-view__status--${vectorDb.enabled ? 'enabled' : 'disabled'}`}
                  >
                    {vectorDb.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                }
              />

              <div className="knowledge-view__field">
                <label
                  className="editor-label"
                  htmlFor="knowledge-data-directory"
                >
                  Data Directory
                </label>
                <input
                  id="knowledge-data-directory"
                  className="editor-input"
                  type="text"
                  value={editingDataDir}
                  onChange={(e) => setDataDir(e.target.value)}
                />
              </div>

              <div className="knowledge-view__actions">
                <button
                  type="button"
                  className="editor-btn editor-btn--primary"
                  onClick={() => {
                    if (!vectorDb) return;
                    saveMutation.mutate({
                      connection: {
                        ...vectorDb,
                        config: {
                          ...vectorDb.config,
                          dataDir: editingDataDir,
                        },
                      },
                      isNew: false,
                    });
                  }}
                  disabled={saveMutation.isPending || !dirty}
                >
                  {saveMutation.isPending ? 'Saving...' : 'Save'}
                </button>
                <button
                  type="button"
                  className="editor-btn"
                  onClick={() => {
                    if (!vectorDb) return;
                    testMutation.mutate(vectorDb.id);
                  }}
                  disabled={testMutation.isPending}
                >
                  {testMutation.isPending ? 'Testing...' : 'Test Connection'}
                </button>
                {testResult && (
                  <span
                    className={`knowledge-view__test-result knowledge-view__test-result--${testResult.healthy ? 'ok' : 'fail'}`}
                  >
                    {testResult.healthy ? (
                      <>
                        <CheckGlyph /> Healthy
                      </>
                    ) : (
                      <>
                        <CloseGlyph /> Connection failed
                      </>
                    )}
                  </span>
                )}
                {testError && (
                  <span className="knowledge-view__test-result knowledge-view__test-result--fail">
                    <CloseGlyph /> {testError}
                  </span>
                )}
              </div>
            </div>
          ) : status?.vectorDb ? (
            /*
             * CI-R6: this panel resolved only through `/api/connections`, and
             * the built-in store (`lancedb-builtin`) is not a persisted
             * connection record on a real home — so the section rendered as a
             * blank bordered box while the server was reporting a working
             * store. It now falls back to the same knowledge-status payload
             * every other surface reads. Read-only on purpose: there is no
             * connection record behind it to edit.
             */
            <div className="knowledge-view__card">
              <PageRow
                className="knowledge-view__card-header"
                label={
                  <>
                    <span className="knowledge-view__card-icon">
                      <IconDatabase />
                    </span>
                    <span className="knowledge-view__card-name">
                      {status.vectorDb.name}
                    </span>
                  </>
                }
                description="Built-in vector store — Station manages it, so there is nothing to configure here."
                status={
                  <span
                    className={`knowledge-view__status knowledge-view__status--${status.vectorDb.enabled ? 'enabled' : 'disabled'}`}
                  >
                    {status.vectorDb.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                }
              />
            </div>
          ) : (
            <Empty
              variant="compact"
              label="No vector database configured"
              description="Station needs somewhere to store indexed documents before knowledge can be recalled."
              action={
                <button
                  type="button"
                  className="knowledge-view__link"
                  onClick={() =>
                    guard(() => navigate('/settings?view=knowledge'))
                  }
                >
                  Add a knowledge source →
                </button>
              }
            />
          )}
        </PageSection>

        {/* Embedding Provider */}
        <PageSection
          id="section-embedding-model"
          className="knowledge-view__section"
          eyebrow="Semantic search"
          title="Embedding model"
          description="Select the model that turns project knowledge into searchable vectors."
        >
          {embeddingProvider ? (
            <div className="knowledge-view__card">
              <PageRow
                className="knowledge-view__card-header"
                label={
                  <>
                    <span className="knowledge-view__card-icon">
                      <IconGlobe />
                    </span>
                    <span className="knowledge-view__card-name">
                      {embeddingProvider.name}
                    </span>
                  </>
                }
                description={modelProviderDisplayLabel(embeddingProvider.type)}
                control={
                  <button
                    type="button"
                    className="knowledge-view__link"
                    onClick={() =>
                      guard(() =>
                        navigate(
                          getPathForView({
                            type: 'connections-model-edit',
                            id: embeddingProvider.id,
                          })!,
                        ),
                      )
                    }
                  >
                    Edit →
                  </button>
                }
              />
              <p className="knowledge-view__card-desc">
                Provides embedding vectors for knowledge indexing and semantic
                search
              </p>
            </div>
          ) : (
            <Empty
              variant="compact"
              label="No embedding model configured."
              action={
                <button
                  type="button"
                  className="knowledge-view__link"
                  onClick={() =>
                    guard(() =>
                      navigate(getPathForView({ type: 'connections-models' })!),
                    )
                  }
                >
                  Add one in Models →
                </button>
              }
            />
          )}
        </PageSection>

        {/* Stats */}
        {hasUsage && stats && (
          <PageSection
            id="section-usage"
            className="knowledge-view__section"
            eyebrow="Index health"
            title="Usage"
            description="What this Station's knowledge index actually holds, counted by the server when this page loaded."
          >
            <div className="knowledge-view__stats">
              <div className="knowledge-view__stat">
                <span className="knowledge-view__stat-value">
                  {stats.totalDocuments}
                </span>
                <span className="knowledge-view__stat-label">documents</span>
              </div>
              <div className="knowledge-view__stat">
                <span className="knowledge-view__stat-value">
                  {stats.totalChunks.toLocaleString()}
                </span>
                <span className="knowledge-view__stat-label">chunks</span>
              </div>
              <div className="knowledge-view__stat">
                <span className="knowledge-view__stat-value">
                  {stats.projectCount}
                </span>
                <span className="knowledge-view__stat-label">projects</span>
              </div>
            </div>
          </PageSection>
        )}
      </div>
      <DiscardModal />
    </>
  );
}

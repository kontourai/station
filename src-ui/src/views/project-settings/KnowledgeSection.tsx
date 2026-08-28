import {
  useCreateKnowledgeRootMutation,
  useKnowledgeBulkDeleteMutation,
  useKnowledgeDeleteMutation,
  useKnowledgeDocsQuery,
  useKnowledgeRootsQuery,
  useKnowledgeSaveMutation,
  useKnowledgeScanMutation,
  useKnowledgeStatusQuery,
  useMigratePreIndexKnowledgeMutation,
  useProjectQuery,
} from '@kontourai/station-sdk';
import { useRef, useState } from 'react';
import {
  CheckGlyph,
  DatabaseGlyph,
  FolderGlyph,
} from '../../components/icons/Glyph';
import { PageSection } from '../../components/PageSection';
import { Empty, ErrorState, Skeleton } from '../../components/state';
import { useNavigation } from '../../contexts/NavigationContext';
import { errorText } from '../../utils/errorText';
import type { DocMeta, KnowledgeStatus } from './types';
import { getKnowledgeTimeAgo } from './utils';

/**
 * Non-destructive guarantee, quoted verbatim from `docs/guides/knowledge.md`'s
 * "The non-destructive guarantee" section (K4 project-settings task — consume
 * the doc's own wording, do not re-derive new copy).
 */
const MIGRATE_GUARANTEE_TEXT =
  'Migration only ever adds: it creates a new, project-scoped knowledge store ' +
  'root, writes each pre-index document into it as a record, and builds an index ' +
  'partition for that root. It never writes to, moves, or deletes anything ' +
  'under the pre-index vectordb/ or projects/*/knowledge/ directories.';

function KnowledgeStoreSubsection({ slug }: { slug: string }) {
  const {
    data: roots,
    isLoading: rootsLoading,
    error: rootsError,
  } = useKnowledgeRootsQuery();
  const { data: docs = [] } = useKnowledgeDocsQuery(slug) as {
    data?: DocMeta[];
  };
  const createRootMutation = useCreateKnowledgeRootMutation();
  const migrateMutation = useMigratePreIndexKnowledgeMutation();

  const projectRoot = roots?.find(
    (root) => root.scope.kind === 'project' && root.scope.projectSlug === slug,
  );
  const hasPreIndexKnowledge = docs.length > 0;

  function handleCreateRoot() {
    createRootMutation.mutate({
      scope: { kind: 'project', projectSlug: slug },
      adapterId: 'kit-default-store',
    });
  }

  function handleMigrate() {
    migrateMutation.mutate({ projectSlug: slug });
  }

  const migrateResult = migrateMutation.data;

  return (
    <div className="knowledge-section__card">
      <div className="knowledge-section__card-header">
        <span className="knowledge-section__card-label">Knowledge store</span>
      </div>

      {rootsLoading ? (
        <Skeleton variant="line" />
      ) : rootsError ? (
        <ErrorState
          title="Could not load the project knowledge store"
          description={errorText(rootsError)}
        />
      ) : projectRoot ? (
        <div className="knowledge-section__source-list">
          <div className="knowledge-section__source">
            <span className="knowledge-section__source-icon">
              <DatabaseGlyph />
            </span>
            <div className="knowledge-section__source-info">
              <span className="knowledge-section__source-name">
                {projectRoot.displayName}
              </span>
              <span className="knowledge-section__source-path">
                {projectRoot.storeRoot}
              </span>
            </div>
            <span className="knowledge-section__badge">
              {projectRoot.adapterId}
            </span>
          </div>
        </div>
      ) : (
        <Empty
          variant="compact"
          label="This project doesn't have its own knowledge store yet"
          description="Create a dedicated project knowledge store to hold this project's knowledge records."
          action={
            <button
              type="button"
              className="knowledge-section__action-btn"
              onClick={handleCreateRoot}
              disabled={createRootMutation.isPending}
            >
              {createRootMutation.isPending
                ? 'Creating…'
                : 'Create project knowledge store'}
            </button>
          }
        />
      )}

      {createRootMutation.isError && (
        <ErrorState
          title="Could not create the project knowledge store"
          description={errorText(createRootMutation.error)}
        />
      )}

      {hasPreIndexKnowledge && (
        <div className="knowledge-section__migrate">
          <p className="knowledge-section__migrate-copy">
            This project has existing knowledge from before knowledge stores.{' '}
            {MIGRATE_GUARANTEE_TEXT}
          </p>
          <button
            type="button"
            className="knowledge-section__action-btn"
            onClick={handleMigrate}
            disabled={migrateMutation.isPending}
          >
            {migrateMutation.isPending
              ? 'Migrating…'
              : "Migrate this project's existing knowledge"}
          </button>

          {migrateMutation.isError && (
            <ErrorState
              title="Migration failed"
              description={errorText(migrateMutation.error)}
            />
          )}

          {migrateResult && (
            <div className="knowledge-section__scan-result">
              <CheckGlyph /> Migrated {migrateResult.documentsMigrated}{' '}
              document(s), {migrateResult.chunksIndexed} chunk(s) across{' '}
              {migrateResult.namespacesProcessed.length} namespace(s).
              {migrateResult.namespaceResults.some(
                (result) => result.status === 'error',
              ) && (
                <ul className="knowledge-section__migrate-errors">
                  {migrateResult.namespaceResults
                    .filter((result) => result.status === 'error')
                    .map((result) => (
                      <li key={`${result.projectSlug}:${result.namespace}`}>
                        {result.namespace}: {result.error}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * `guard` is `ProjectSettingsView.tsx`'s own `useUnsavedGuard` guard (
 * finding, 1) — both cross-links below must route through it
 * like every other navigation trigger on a page with dirty state.
 */
export function KnowledgeSection({
  slug,
  guard,
}: {
  slug: string;
  guard: (callback: () => void) => void;
}) {
  const { navigate } = useNavigation();
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{
    indexed: number;
    skipped: number;
  } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: docs = [] } = useKnowledgeDocsQuery(slug) as {
    data?: DocMeta[];
  };
  const { data: status } = useKnowledgeStatusQuery(slug) as {
    data?: KnowledgeStatus | null;
  };
  const { data: project } = useProjectQuery(slug) as {
    data?: { workingDirectory?: string | null };
  };
  const deleteMutation = useKnowledgeDeleteMutation(slug);
  const clearMutation = useKnowledgeBulkDeleteMutation(slug);
  const scanMutation = useKnowledgeScanMutation(slug);
  const saveKnowledgeMutation = useKnowledgeSaveMutation(slug);

  async function handleScan() {
    setScanning(true);
    setScanResult(null);
    try {
      const result = await scanMutation.mutateAsync({});
      setScanResult(result ?? null);
    } catch {
      /* ignore */
    }
    setScanning(false);
  }

  async function uploadFiles(files: FileList | File[]) {
    setUploading(true);
    for (const file of Array.from(files)) {
      try {
        const content = await file.text();
        await saveKnowledgeMutation.mutateAsync({
          filename: file.name,
          content,
        });
      } catch {
        /* ignore */
      }
    }
    setUploading(false);
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragOver(false);
    if (event.dataTransfer.files.length > 0) {
      void uploadFiles(event.dataTransfer.files);
    }
  }

  const workingDir = project?.workingDirectory;

  return (
    <PageSection
      id="section-knowledge"
      className="project-settings__section knowledge-section"
      eyebrow="Project context"
      title="Project knowledge"
      description="Index durable project context so agents can retrieve it when needed."
      actions={
        status ? (
          <span className="knowledge-section__stat">
            {status.totalChunks} chunks · {status.documentCount} docs
            {status.lastIndexed &&
              ` · indexed ${getKnowledgeTimeAgo(status.lastIndexed)}`}
          </span>
        ) : undefined
      }
    >
      <p className="knowledge-section__cross-link">
        Looking for your personal knowledge store?{' '}
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
        . Managing the vector database or embedding model?{' '}
        <button
          type="button"
          className="button button--link"
          onClick={() => guard(() => navigate('/connections/knowledge'))}
        >
          Open Knowledge infrastructure
        </button>
      </p>
      <KnowledgeStoreSubsection slug={slug} />

      <div className="knowledge-section__card">
        <div className="knowledge-section__card-header">
          <span className="knowledge-section__card-label">Sources</span>
          <button
            type="button"
            className="knowledge-section__action-btn"
            onClick={handleScan}
            disabled={scanning || !workingDir}
          >
            {scanning ? '⟳ Scanning…' : '⟳ Index directory'}
          </button>
        </div>
        {workingDir ? (
          <div className="knowledge-section__source-list">
            <div className="knowledge-section__source">
              <span className="knowledge-section__source-icon">
                <FolderGlyph />
              </span>
              <div className="knowledge-section__source-info">
                <span className="knowledge-section__source-name">
                  {workingDir.split('/').filter(Boolean).pop()}
                </span>
                <span className="knowledge-section__source-path">
                  {workingDir}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <Empty variant="compact" label="No working directory configured." />
        )}
        {scanResult && (
          <div className="knowledge-section__scan-result">
            <CheckGlyph /> Indexed {scanResult.indexed} files, skipped{' '}
            {scanResult.skipped}
          </div>
        )}
      </div>

      <div className="knowledge-section__card">
        <div className="knowledge-section__card-header">
          <span className="knowledge-section__card-label">Documents</span>
          <span className="knowledge-section__stat">{docs.length} files</span>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".txt,.md,.json,.csv,.html,.ts,.tsx,.js,.py,.yaml,.yml,.toml,.xml,.sql,.sh,.css"
          style={{ display: 'none' }}
          onChange={(event) => {
            if (event.target.files) {
              void uploadFiles(event.target.files);
            }
            event.target.value = '';
          }}
        />
        <button
          type="button"
          className={`knowledge-section__dropzone${dragOver ? ' knowledge-section__dropzone--active' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? (
            <span>Uploading…</span>
          ) : (
            <span>
              {dragOver
                ? 'Drop files here'
                : 'Drop files here or click to browse'}
            </span>
          )}
        </button>

        {docs.length > 0 && (
          <div className="knowledge-section__doc-list">
            {docs.map((doc) => (
              <div key={doc.id} className="knowledge-section__doc">
                <span className="knowledge-section__doc-name">
                  {doc.filename}
                </span>
                <span className="knowledge-section__badge">
                  {doc.chunkCount} chunks
                </span>
                <button
                  type="button"
                  className="knowledge-section__doc-remove"
                  onClick={() => deleteMutation.mutate(doc.id)}
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="knowledge-section__status">
        {docs.length > 0 && (
          <button
            type="button"
            className="knowledge-section__clear-btn"
            onClick={() => clearMutation.mutate(docs.map((doc) => doc.id))}
            disabled={clearMutation.isPending}
          >
            {clearMutation.isPending ? 'Clearing…' : 'Clear all'}
          </button>
        )}
      </div>
    </PageSection>
  );
}

import {
  useKnowledgeBulkDeleteMutation,
  useKnowledgeDeleteMutation,
  useKnowledgeDocsQuery,
  useKnowledgeSaveMutation,
  useKnowledgeScanMutation,
  useKnowledgeStatusQuery,
  useMigratePreIndexKnowledgeMutation,
} from '@kontourai/station-sdk';
import { useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { CheckGlyph, FolderGlyph } from '../../components/icons/Glyph';
import { PageSection } from '../../components/PageSection';
import { Empty, ErrorState, Skeleton } from '../../components/state';
import { useNavigation } from '../../contexts/NavigationContext';
import { useScopedProjectQuery } from '../../contexts/ProjectsContext';
import { errorText } from '../../utils/errorText';
import type { DocMeta, KnowledgeStatus } from './types';
import { getKnowledgeTimeAgo } from './utils';

/** Keep source recovery and cutover limits aligned with docs/guides/knowledge.md. */
const MIGRATE_GUARANTEE_TEXT =
  'Migration copies records into a project Knowledge store and builds its index. ' +
  'The source corpus stays in place, with no automatic cutover or cleanup. ' +
  'Reading the source can first recover an interrupted earlier write.';

function KnowledgeStoreSubsection({ slug }: { slug: string }) {
  const { navigate } = useNavigation();
  const { data: docs = [] } = useKnowledgeDocsQuery(slug) as {
    data?: DocMeta[];
  };
  const migrateMutation = useMigratePreIndexKnowledgeMutation();

  const hasPreIndexKnowledge = docs.length > 0;

  function handleMigrate() {
    migrateMutation.mutate({ projectSlug: slug });
  }

  const migrateResult = migrateMutation.data;

  return (
    <div className="knowledge-section__card">
      <div className="knowledge-section__card-header">
        <span className="knowledge-section__card-label">Knowledge store</span>
      </div>

      <p>Manage registered repositories and knowledge stores in Sources.</p>
      <Button
        size="sm"
        onClick={() =>
          navigate(`/projects/${slug}/edit`, { section: 'resources' })
        }
      >
        Manage sources
      </Button>

      {hasPreIndexKnowledge && (
        <div className="knowledge-section__migrate">
          <p className="knowledge-section__migrate-copy">
            This project has existing knowledge from before knowledge stores.{' '}
            {MIGRATE_GUARANTEE_TEXT}
          </p>
          <Button
            size="sm"
            onClick={handleMigrate}
            disabled={migrateMutation.isPending}
          >
            {migrateMutation.isPending
              ? 'Migrating…'
              : "Migrate this project's existing knowledge"}
          </Button>

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

export function KnowledgeSection({ slug }: { slug: string }) {
  const { navigate } = useNavigation();
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{
    indexed: number;
    skipped: number;
  } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const docsQuery = useKnowledgeDocsQuery(slug);
  const { data: docs = [] } = docsQuery as {
    data?: DocMeta[];
  };
  const { data: status } = useKnowledgeStatusQuery(slug) as {
    data?: KnowledgeStatus | null;
  };
  const { data: project } = useScopedProjectQuery(slug) as {
    data?: { workingDirectory?: string | null };
  };
  const deleteMutation = useKnowledgeDeleteMutation(slug);
  const clearMutation = useKnowledgeBulkDeleteMutation(slug);
  const scanMutation = useKnowledgeScanMutation(slug);
  const saveKnowledgeMutation = useKnowledgeSaveMutation(slug);

  async function handleScan() {
    setScanning(true);
    setScanResult(null);
    setOperationError(null);
    try {
      const result = await scanMutation.mutateAsync({});
      setScanResult(result ?? null);
    } catch (error) {
      setOperationError(errorText(error));
    }
    setScanning(false);
  }

  async function uploadFiles(files: FileList | File[]) {
    setUploading(true);
    setOperationError(null);
    const failures: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const content = await file.text();
        await saveKnowledgeMutation.mutateAsync({
          filename: file.name,
          content,
        });
      } catch (error) {
        failures.push(`${file.name}: ${errorText(error)}`);
      }
    }
    setOperationError(failures.length ? failures.join('; ') : null);
    setUploading(false);
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragOver(false);
    if (!uploading && event.dataTransfer.files.length > 0) {
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
        <Button
          variant="link"
          onClick={() =>
            navigate('/settings', {
              view: 'knowledge',
              highlight: 'personal-knowledge-store',
            })
          }
        >
          Open Settings → My knowledge store
        </Button>
        . Managing the vector database or embedding model?{' '}
        <Button
          variant="link"
          onClick={() => navigate('/connections/knowledge')}
        >
          Open Knowledge infrastructure
        </Button>
      </p>
      <KnowledgeStoreSubsection slug={slug} />
      {operationError && (
        <ErrorState
          variant="compact"
          title="Knowledge action failed"
          description={operationError}
        />
      )}
      {deleteMutation.isError && (
        <ErrorState
          variant="compact"
          title="Could not remove document"
          description={errorText(deleteMutation.error)}
        />
      )}
      {clearMutation.isError && (
        <ErrorState
          variant="compact"
          title="Could not clear documents"
          description={errorText(clearMutation.error)}
        />
      )}

      <div className="knowledge-section__card">
        <div className="knowledge-section__card-header">
          <span className="knowledge-section__card-label">Sources</span>
          <Button
            size="sm"
            onClick={handleScan}
            disabled={scanning || !workingDir}
          >
            {scanning ? 'Scanning…' : 'Index directory'}
          </Button>
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
          {!docsQuery.isLoading && !docsQuery.isError && (
            <span className="knowledge-section__stat">{docs.length} files</span>
          )}
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
          disabled={uploading}
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

        {docsQuery.isLoading ? (
          <Skeleton variant="block" />
        ) : docsQuery.isError ? (
          <ErrorState
            variant="compact"
            title="Could not load documents"
            action={
              <Button onClick={() => void docsQuery.refetch()}>Retry</Button>
            }
          />
        ) : (
          docs.length > 0 && (
            <div className="knowledge-section__doc-list">
              {docs.map((doc) => (
                <div key={doc.id} className="knowledge-section__doc">
                  <span className="knowledge-section__doc-name">
                    {doc.filename}
                  </span>
                  <span className="knowledge-section__badge">
                    {doc.chunkCount} chunks
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => deleteMutation.mutate(doc.id)}
                    title="Remove"
                    aria-label={`Remove ${doc.filename}`}
                    disabled={
                      deleteMutation.isPending || clearMutation.isPending
                    }
                  >
                    ×
                  </Button>
                </div>
              ))}
            </div>
          )
        )}
      </div>

      <div className="knowledge-section__status">
        {docs.length > 0 && (
          <Button
            variant="danger-outline"
            size="sm"
            onClick={() => clearMutation.mutate(docs.map((doc) => doc.id))}
            disabled={clearMutation.isPending}
          >
            {clearMutation.isPending ? 'Clearing…' : 'Clear all'}
          </Button>
        )}
      </div>
    </PageSection>
  );
}

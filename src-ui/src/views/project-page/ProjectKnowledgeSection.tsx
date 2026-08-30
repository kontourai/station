import {
  deleteKnowledgeDoc,
  fetchKnowledgeDocs,
  updateKnowledgeNamespace,
  uploadKnowledge,
  useKnowledgeBulkDeleteMutation,
  useKnowledgeDeleteMutation,
  useKnowledgeDocContentQuery,
  useKnowledgeScanMutation,
  useKnowledgeSearchQuery,
} from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  AttachmentGlyph,
  CheckGlyph,
  FolderGlyph,
  TimeGlyph,
} from '../../components/icons/Glyph';
import { describeReadFailure, ErrorState } from '../../components/state';
import { ProjectKnowledgeDocGroup } from './ProjectKnowledgeDocGroup';
import { ProjectKnowledgeNamespaceConfig } from './ProjectKnowledgeNamespaceConfig';
import { ProjectKnowledgeRulesEditor } from './ProjectKnowledgeRulesEditor';
import { ProjectKnowledgeScanModal } from './ProjectKnowledgeScanModal';
import { ProjectKnowledgeViewerModal } from './ProjectKnowledgeViewerModal';
import type {
  DocMeta,
  KnowledgeNamespace,
  KnowledgeSearchResult,
  KnowledgeStatusSummary,
} from './types';
import {
  buildKnowledgeScanOptions,
  buildRulesContent,
  splitKnowledgeDocs,
  timeAgo,
} from './utils';

export function ProjectKnowledgeSection({
  apiBase,
  slug,
  projectWorkingDirectory,
  docs,
  docsError = false,
  docsFailure,
  onRetryDocs,
  namespaces,
  knowledgeStatus,
}: {
  apiBase: string;
  slug: string;
  projectWorkingDirectory?: string;
  docs: DocMeta[];
  docsError?: boolean;
  docsFailure?: unknown;
  onRetryDocs?: () => void;
  namespaces: KnowledgeNamespace[];
  knowledgeStatus?: KnowledgeStatusSummary | null;
}) {
  const qc = useQueryClient();
  const [selectedNs, setSelectedNs] = useState<string | null>(null);
  const [rulesContent, setRulesContent] = useState('');
  const [savingRules, setSavingRules] = useState(false);
  const [rulesSaveFailure, setRulesSaveFailure] = useState<unknown>(null);
  const [rulesLoaded, setRulesLoaded] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadFailures, setUploadFailures] = useState<
    Array<{ filename: string; error: unknown }>
  >([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showScanDialog, setShowScanDialog] = useState(false);
  const [scanInclude, setScanInclude] = useState('');
  const [scanExclude, setScanExclude] = useState('');
  const [scanResult, setScanResult] = useState<{
    indexed: number;
    skipped: number;
  } | null>(null);
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [dirOpen, setDirOpen] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(true);
  const [storageDirDraft, setStorageDirDraft] = useState('');
  const [viewingDoc, setViewingDoc] = useState<DocMeta | null>(null);

  const {
    data: rulesSearchData,
    isLoading: rulesLoading,
    isError: rulesError,
    error: rulesFailure,
    refetch: refetchRules,
  } = useKnowledgeSearchQuery(slug, '*', 'rules', {
    enabled: selectedNs === 'rules' && !rulesLoaded,
  });
  const { data: viewingContent, isLoading: contentLoading } =
    useKnowledgeDocContentQuery(slug, viewingDoc?.id ?? null);
  const deleteMutation = useKnowledgeDeleteMutation(slug);
  const bulkDeleteMutation = useKnowledgeBulkDeleteMutation(slug);
  const scanMutation = useKnowledgeScanMutation(slug);

  useEffect(() => {
    if (selectedNs !== 'rules' || rulesLoaded || !rulesSearchData) return;
    const nextRulesContent = buildRulesContent(
      rulesSearchData as KnowledgeSearchResult[],
    );
    if (nextRulesContent) {
      setRulesContent(nextRulesContent);
    }
    setRulesLoaded(true);
  }, [rulesLoaded, rulesSearchData, selectedNs]);

  useEffect(() => {
    if (!selectedNs) return;
    const namespace = namespaces.find((entry) => entry.id === selectedNs);
    setStorageDirDraft((namespace as any)?.storageDir ?? '');
  }, [namespaces, selectedNs]);

  const { dirDocs, uploadDocs } = splitKnowledgeDocs(docs, selectedNs);
  const selectedNamespace =
    selectedNs === null
      ? null
      : namespaces.find((entry) => entry.id === selectedNs) || null;

  async function handleSaveRules() {
    if (!rulesContent.trim()) return;
    setSavingRules(true);
    setRulesSaveFailure(null);
    try {
      const rulesDocs = await fetchKnowledgeDocs(slug, 'rules');
      for (const doc of rulesDocs) {
        await deleteKnowledgeDoc(slug, doc.id, 'rules');
      }
      await uploadKnowledge(slug, 'project-rules.md', rulesContent, 'rules');
      qc.invalidateQueries({ queryKey: ['knowledge', 'docs', slug] });
    } catch (error) {
      setRulesSaveFailure(error);
    } finally {
      setSavingRules(false);
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    setUploading(true);
    setUploadFailures([]);
    const failures: Array<{ filename: string; error: unknown }> = [];
    for (const file of Array.from(files)) {
      try {
        const content = await file.text();
        await uploadKnowledge(slug, file.name, content);
      } catch (error) {
        failures.push({ filename: file.name, error });
      }
    }
    qc.invalidateQueries({ queryKey: ['knowledge', 'docs', slug] });
    if (failures.length > 0) {
      qc.invalidateQueries({ queryKey: ['knowledge', 'namespaces', slug] });
    }
    setUploadFailures(failures);
    setUploading(false);
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragOver(false);
    if (event.dataTransfer.files.length > 0) {
      uploadFiles(event.dataTransfer.files);
    }
  }

  function handleScan() {
    setScanResult(null);
    scanMutation.mutate(buildKnowledgeScanOptions(scanInclude, scanExclude), {
      onSuccess: (data: any) => {
        setScanResult(data);
        setShowScanDialog(false);
      },
    });
  }

  function toggleDoc(id: string) {
    setSelectedDocs((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllInGroup(groupDocs: DocMeta[]) {
    const ids = groupDocs.map((doc) => doc.id);
    const allSelected = ids.every((id) => selectedDocs.has(id));
    setSelectedDocs((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  return (
    <div className="project-page__knowledge">
      <div className="project-page__knowledge-header">
        <div className="project-page__knowledge-title-row">
          <span className="project-page__section-label">
            Knowledge & Documents
          </span>
          <div className="project-page__knowledge-actions">
            {selectedDocs.size > 0 && (
              <button
                type="button"
                className="project-page__add-btn project-page__add-btn--danger"
                onClick={() => bulkDeleteMutation.mutate([...selectedDocs])}
                disabled={bulkDeleteMutation.isPending}
              >
                {bulkDeleteMutation.isPending
                  ? 'Deleting…'
                  : `Delete ${selectedDocs.size}`}
              </button>
            )}
            {projectWorkingDirectory && (
              <button
                type="button"
                className="project-page__add-btn"
                onClick={() => {
                  scanMutation.reset();
                  setShowScanDialog(true);
                }}
                disabled={scanMutation.isPending}
              >
                {scanMutation.isPending ? '⟳ Scanning…' : '⟳ Index directory'}
              </button>
            )}
          </div>
        </div>
        {knowledgeStatus && knowledgeStatus.totalChunks > 0 && (
          <div className="project-page__knowledge-stats">
            {knowledgeStatus.documentCount} documents ·{' '}
            {knowledgeStatus.totalChunks} chunks
            {knowledgeStatus.lastIndexed &&
              ` · updated ${timeAgo(knowledgeStatus.lastIndexed)}`}
          </div>
        )}
      </div>

      {docsError && (
        <ErrorState
          variant="compact"
          title="Couldn't load project knowledge"
          description={describeReadFailure(docsFailure)}
          action={
            onRetryDocs ? (
              <button type="button" onClick={onRetryDocs}>
                Retry
              </button>
            ) : undefined
          }
        />
      )}

      {namespaces.length > 0 && (
        <div className="project-page__ns-tabs">
          <button
            type="button"
            className={`project-page__ns-tab${selectedNs === null ? ' project-page__ns-tab--active' : ''}`}
            onClick={() => setSelectedNs(null)}
          >
            All
          </button>
          {namespaces.map((namespace) => (
            <button
              type="button"
              key={namespace.id}
              className={`project-page__ns-tab${selectedNs === namespace.id ? ' project-page__ns-tab--active' : ''}`}
              onClick={() => setSelectedNs(namespace.id)}
            >
              {namespace.label}
            </button>
          ))}
        </div>
      )}

      {selectedNs === 'rules' && (
        <ProjectKnowledgeRulesEditor
          rulesLoaded={rulesLoaded}
          rulesLoading={rulesLoading}
          rulesError={rulesError}
          rulesFailure={rulesFailure}
          onRetryRules={() => void refetchRules()}
          rulesContent={rulesContent}
          savingRules={savingRules}
          rulesSaveFailure={rulesSaveFailure}
          onRulesChange={setRulesContent}
          onSaveRules={handleSaveRules}
        />
      )}

      {selectedNs && selectedNamespace && (
        <ProjectKnowledgeNamespaceConfig
          apiBase={apiBase}
          namespace={
            selectedNamespace as KnowledgeNamespace & {
              storageDir?: string;
              writeFiles?: boolean;
              enhance?: { auto?: boolean };
            }
          }
          storageDirDraft={storageDirDraft}
          onStorageDirChange={setStorageDirDraft}
          onStorageDirBlur={() => {
            const value = storageDirDraft.trim();
            const currentValue = (
              selectedNamespace as KnowledgeNamespace & { storageDir?: string }
            ).storageDir;
            if (value !== (currentValue ?? '')) {
              updateKnowledgeNamespace(slug, selectedNs, {
                storageDir: value || undefined,
              }).then(() =>
                qc.invalidateQueries({
                  queryKey: ['knowledge', 'namespaces', slug],
                }),
              );
            }
          }}
          onWriteFilesChange={(checked) => {
            updateKnowledgeNamespace(slug, selectedNs, {
              writeFiles: checked,
            }).then(() =>
              qc.invalidateQueries({
                queryKey: ['knowledge', 'namespaces', slug],
              }),
            );
          }}
          onAutoEnhanceChange={(checked) => {
            updateKnowledgeNamespace(slug, selectedNs, {
              enhance: checked
                ? { agent: 'sales-sa:sales-sa', auto: true }
                : undefined,
            }).then(() =>
              qc.invalidateQueries({
                queryKey: ['knowledge', 'namespaces', slug],
              }),
            );
          }}
        />
      )}

      {scanResult && (
        <div className="project-page__scan-result">
          <CheckGlyph /> Indexed {scanResult.indexed} files, skipped{' '}
          {scanResult.skipped}
        </div>
      )}

      {dirDocs.length > 0 && (
        <ProjectKnowledgeDocGroup
          title="Directory Index"
          icon={<FolderGlyph />}
          docs={dirDocs}
          open={dirOpen}
          allSelected={dirDocs.every((doc) => selectedDocs.has(doc.id))}
          onToggleOpen={() => setDirOpen((open) => !open)}
          onToggleAll={() => toggleAllInGroup(dirDocs)}
          headerMeta={
            <div className="project-page__doc-group-meta">
              From: {projectWorkingDirectory}
            </div>
          }
          onToggleDoc={toggleDoc}
          onDeleteDoc={(id) => deleteMutation.mutate(id)}
          onViewDoc={setViewingDoc}
          selectedDocs={selectedDocs}
        />
      )}

      <ProjectKnowledgeDocGroup
        title="Uploaded Documents"
        icon={<AttachmentGlyph />}
        docs={uploadDocs}
        open={uploadOpen}
        allSelected={
          uploadDocs.length > 0 &&
          uploadDocs.every((doc) => selectedDocs.has(doc.id))
        }
        onToggleOpen={() => setUploadOpen((open) => !open)}
        onToggleAll={() => toggleAllInGroup(uploadDocs)}
        onToggleDoc={toggleDoc}
        onDeleteDoc={(id) => deleteMutation.mutate(id)}
        onViewDoc={setViewingDoc}
        selectedDocs={selectedDocs}
      >
        <div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.md,.json,.csv,.html,.ts,.tsx,.js,.py,.yaml,.yml,.toml,.xml,.sql,.sh,.css"
            style={{ display: 'none' }}
            onChange={(event) => {
              if (event.target.files) uploadFiles(event.target.files);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            className={`project-page__dropzone${dragOver ? ' project-page__dropzone--active' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <span className="project-page__dropzone-icon">
              {uploading ? <TimeGlyph /> : <AttachmentGlyph />}
            </span>
            <span className="project-page__dropzone-text">
              {uploading
                ? 'Uploading…'
                : dragOver
                  ? 'Drop files here'
                  : 'Drop files here or click to browse'}
            </span>
            <span className="project-page__dropzone-hint">
              .md .txt .json .ts .py .yaml and more
            </span>
          </button>
          {uploadFailures.length > 0 && (
            <ErrorState
              variant="compact"
              title={`Couldn't upload ${uploadFailures.length === 1 ? uploadFailures[0].filename : `${uploadFailures.length} files`}`}
              description={uploadFailures
                .map(
                  ({ filename, error }) =>
                    `${filename}: ${describeReadFailure(error)}`,
                )
                .join(' ')}
            />
          )}
        </div>
      </ProjectKnowledgeDocGroup>

      {viewingDoc && (
        <ProjectKnowledgeViewerModal
          doc={viewingDoc}
          content={viewingContent}
          loading={contentLoading}
          onClose={() => setViewingDoc(null)}
        />
      )}

      {showScanDialog && (
        <ProjectKnowledgeScanModal
          projectWorkingDirectory={projectWorkingDirectory}
          scanInclude={scanInclude}
          scanExclude={scanExclude}
          scanning={scanMutation.isPending}
          scanFailure={scanMutation.error}
          onClose={() => setShowScanDialog(false)}
          onScan={handleScan}
          onScanIncludeChange={setScanInclude}
          onScanExcludeChange={setScanExclude}
        />
      )}
    </div>
  );
}

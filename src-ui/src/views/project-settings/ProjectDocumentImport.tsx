import {
  KNOWLEDGE_DOCUMENT_BATCH_MAX_BYTES,
  KNOWLEDGE_DOCUMENT_BATCH_MAX_FILES,
  KNOWLEDGE_DOCUMENT_MAX_BYTES,
  type KnowledgeStoreRoot,
} from '@kontourai/station-contracts/knowledge-store';
import {
  useImportKnowledgeDocumentsMutation,
  useKnowledgeDocumentImportQuery,
  useResumeKnowledgeDocumentImportMutation,
} from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useEffect, useState } from 'react';
import { z } from 'zod/v3';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { userFacingErrorMessage } from '../../utils/errorText';

const pointerSchema = z.object({
  requestId: z.string().uuid(),
  rootId: z.string(),
  registrationId: z.string().uuid(),
  files: z
    .array(
      z.object({
        filename: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(8),
});
type Pointer = z.infer<typeof pointerSchema>;
function retainedPointers(prefix: string): Pointer[] {
  const pointers: Pointer[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key !== prefix && !key?.startsWith(`${prefix}:`)) continue;
      try {
        const value = localStorage.getItem(key);
        if (value) pointers.push(pointerSchema.parse(JSON.parse(value)));
      } catch {
        /* Preserve unreadable entries for manual recovery. */
      }
    }
  } catch {
    return pointers;
  }
  return pointers;
}
interface Preview {
  filename: string;
  sha256: string;
  bytes: number;
  text: string;
  contentBase64: string;
}

export function ProjectDocumentImport({
  projectId,
  roots,
  authority,
  canManage,
}: {
  projectId: string;
  roots: KnowledgeStoreRoot[];
  authority: ApiRequestScope & { draftRecoveryKey?: string };
  canManage: boolean;
}) {
  const storageKey = `station.document-import:${JSON.stringify([authority.apiBase, authority.draftRecoveryKey ?? authority.authorityKey, projectId])}`;
  const [saved, setSaved] = useState<Pointer | undefined>(() => {
    try {
      return retainedPointers(storageKey)[0];
    } catch {
      return undefined;
    }
  });
  const [pointers, setPointers] = useState(() => retainedPointers(storageKey));
  useEffect(() => {
    const refresh = () => {
      const retained = retainedPointers(storageKey);
      setPointers(retained);
      setSaved(
        (current) =>
          retained.find((item) => item.requestId === current?.requestId) ??
          retained[0],
      );
    };
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, [storageKey]);
  const [rootId, setRootId] = useState('');
  const [preview, setPreview] = useState<Preview[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(false);
  const upload = useImportKnowledgeDocumentsMutation(authority);
  const resume = useResumeKnowledgeDocumentImportMutation(authority);
  const receipt = useKnowledgeDocumentImportQuery(
    authority,
    canManage ? saved?.rootId : undefined,
    canManage ? saved?.requestId : undefined,
  );
  const eligible = roots.filter(
    (root) =>
      root.projectId === projectId &&
      root.registrationId &&
      root.adapterId === 'kit-default-store',
  );
  const target = eligible.find((root) => root.id === rootId);
  const savedRoot = eligible.find(
    (root) =>
      root.id === saved?.rootId && root.registrationId === saved.registrationId,
  );
  const busy = preparing || upload.isPending || resume.isPending;
  const { DiscardModal } = useUnsavedGuard(preview.length > 0 && !saved);
  async function choose(files: FileList | null) {
    setError(undefined);
    setPreview([]);
    if (!files?.length) return;
    setPreparing(true);
    try {
      const selected = Array.from(files);
      if (
        selected.length > KNOWLEDGE_DOCUMENT_BATCH_MAX_FILES ||
        selected.reduce((sum, file) => sum + file.size, 0) >
          KNOWLEDGE_DOCUMENT_BATCH_MAX_BYTES
      )
        throw new Error('Choose up to 8 files, at most 1 MiB in total.');
      const result: Preview[] = [];
      for (const file of selected) {
        if (
          !/\.(md|markdown|txt)$/i.test(file.name) ||
          file.name.length > 240 ||
          /[/\\\r\n\0]/.test(file.name) ||
          file.size === 0 ||
          file.size > KNOWLEDGE_DOCUMENT_MAX_BYTES
        )
          throw new Error(
            'Choose nonempty Markdown or plain-text files, at most 256 KiB each.',
          );
        const bytes = new Uint8Array(await file.arrayBuffer());
        const text = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
        if (!text.trim() || text.includes('\0'))
          throw new Error(
            'Choose UTF-8 text documents without binary content.',
          );
        const sha256 = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
          (byte) => byte.toString(16).padStart(2, '0'),
        ).join('');
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        result.push({
          filename: file.name,
          bytes: bytes.length,
          text,
          sha256,
          contentBase64: btoa(binary),
        });
      }
      if (
        new Set(result.map((file) => `${file.filename}\0${file.sha256}`))
          .size !== result.length
      )
        throw new Error('Select each identical document only once.');
      setPreview(result);
    } catch (cause) {
      setError(userFacingErrorMessage(cause));
    } finally {
      setPreparing(false);
    }
  }
  async function start() {
    if (
      !canManage ||
      !target?.registrationId ||
      !preview.length ||
      busy ||
      saved
    )
      return;
    setError(undefined);
    try {
      const pointer: Pointer = {
        requestId: crypto.randomUUID(),
        rootId: target.id,
        registrationId: target.registrationId,
        files: preview.map(({ filename, sha256 }) => ({ filename, sha256 })),
      };
      // Persist identity before sending; a lost acknowledgement must not create a new request.
      localStorage.setItem(
        `${storageKey}:${pointer.requestId}`,
        JSON.stringify(pointer),
      );
      setPointers(retainedPointers(storageKey));
      setSaved(pointer);
      const documents = preview.map(({ filename, contentBase64 }) => ({
        filename,
        contentBase64,
      }));
      setPreview([]);
      await upload.mutateAsync({
        requestId: pointer.requestId,
        expectedRoot: target,
        documents,
      });
    } catch (cause) {
      setError(userFacingErrorMessage(cause));
    }
  }
  async function continueImport(retryUncertain: boolean) {
    if (
      !canManage ||
      !saved ||
      !savedRoot ||
      busy ||
      receipt.isError ||
      receipt.isFetching ||
      !receipt.data
    )
      return;
    setError(undefined);
    setRetry(false);
    try {
      await resume.mutateAsync({
        expectedRoot: savedRoot,
        requestId: saved.requestId,
        retryUncertain,
      });
    } catch (cause) {
      setError(userFacingErrorMessage(cause));
    }
  }
  function setAside() {
    try {
      if (!saved) return;
      localStorage.removeItem(`${storageKey}:${saved.requestId}`);
      // Older versions used one shared slot; remove it only when it still names this import.
      const legacy = localStorage.getItem(storageKey);
      if (
        legacy &&
        pointerSchema.parse(JSON.parse(legacy)).requestId === saved.requestId
      )
        localStorage.removeItem(storageKey);
      const remaining = retainedPointers(storageKey);
      setPointers(remaining);
      setSaved(remaining[0]);
      setError(undefined);
    } catch (cause) {
      setError(userFacingErrorMessage(cause));
    }
  }
  return (
    <section aria-label="Import documents" className="project-sources__form">
      <h3>Import documents</h3>
      <p>
        Add Markdown or plain-text documents to Project knowledge. Preview up to
        8 files before importing. Originals are retained on this Station.
      </p>
      {saved ? (
        <>
          <label>
            Saved imports
            <select
              value={saved.requestId}
              disabled={busy}
              onChange={(event) => {
                const pointer = retainedPointers(storageKey).find(
                  (item) => item.requestId === event.target.value,
                );
                if (pointer) setSaved(pointer);
              }}
            >
              {Array.from(
                new Map(
                  pointers.map((item) => [item.requestId, item]),
                ).values(),
              ).map((pointer) => (
                <option key={pointer.requestId} value={pointer.requestId}>
                  {pointer.files[0]?.filename ?? 'Documents'} ·{' '}
                  {pointer.requestId}
                </option>
              ))}
            </select>
          </label>
          <p>
            Saved import: <code>{saved.requestId}</code>
          </p>
          {!canManage ? (
            <p>
              Current operator permission is required to check or continue this
              import.
            </p>
          ) : (
            <>
              {receipt.isPending ? (
                <p>Checking saved import…</p>
              ) : receipt.isError ? (
                <p role="alert">
                  {userFacingErrorMessage(receipt.error)} No documents are
                  resent automatically.
                </p>
              ) : (
                <>
                  <p>Import status: {receipt.data?.phase}</p>
                  <ul>
                    {receipt.data?.documents.map((file) => (
                      <li key={file.recordId}>
                        {file.filename}: {file.phase}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <Button
                disabled={busy || receipt.isFetching}
                onClick={() => void receipt.refetch()}
              >
                Check saved import
              </Button>
              {receipt.data &&
                ['pending', 'partial'].includes(receipt.data.phase) && (
                  <Button
                    disabled={
                      busy ||
                      !savedRoot ||
                      receipt.isError ||
                      receipt.isFetching
                    }
                    onClick={() => void continueImport(false)}
                  >
                    Continue saved import
                  </Button>
                )}
              {receipt.data?.documents.some(
                (file) => file.phase === 'uncertain',
              ) && (
                <Button
                  disabled={
                    busy || !savedRoot || receipt.isError || receipt.isFetching
                  }
                  onClick={() => setRetry(true)}
                >
                  Review uncertain retry
                </Button>
              )}
            </>
          )}
          {!savedRoot && (
            <p>
              The original source registration is unavailable. Reconnecting a
              store does not transfer this import.
            </p>
          )}
          <p>
            Setting this aside only removes this browser’s recovery pointer.
            Retained originals and imported records stay on the Station. Keep
            the import ID for recovery.
          </p>
          <Button disabled={busy} onClick={setAside}>
            Set aside
          </Button>
        </>
      ) : (
        <>
          {eligible.length ? (
            <label>
              Destination store
              <select
                value={rootId}
                disabled={!canManage || busy}
                onChange={(event) => setRootId(event.target.value)}
              >
                <option value="">Choose a Project store</option>
                {eligible.map((root) => (
                  <option key={root.id} value={root.id}>
                    {root.displayName}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p>
              Create a Station-managed knowledge store below to import
              documents.
            </p>
          )}
          <label>
            Documents
            <input
              type="file"
              multiple
              accept=".md,.markdown,.txt,text/plain,text/markdown"
              disabled={!canManage || busy}
              onChange={(event) => void choose(event.target.files)}
            />
          </label>
          {preview.map((file) => (
            <details key={`${file.filename}:${file.sha256}`}>
              <summary>
                {file.filename} · {file.bytes} bytes
              </summary>
              <p>
                SHA-256: <code>{file.sha256}</code>
              </p>
              <pre>{file.text.slice(0, 4000)}</pre>
              {file.text.length > 4000 && (
                <p>
                  Preview shows the first 4,000 characters. The complete file
                  will be imported.
                </p>
              )}
            </details>
          ))}
          <Button
            disabled={!canManage || !target || !preview.length || busy}
            onClick={() => void start()}
          >
            Import {preview.length || ''} documents
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <ConfirmModal
        isOpen={retry}
        title="Retry uncertain documents?"
        message="The previous attempt has no confirmed publication. Station will check the saved record identities and retry missing documents from retained originals. Continue only if you want this import completed."
        confirmLabel="Retry missing documents"
        confirmDisabled={
          !canManage ||
          busy ||
          !savedRoot ||
          receipt.isError ||
          receipt.isFetching
        }
        onConfirm={() => void continueImport(true)}
        onCancel={() => setRetry(false)}
      />
      <DiscardModal />
    </section>
  );
}

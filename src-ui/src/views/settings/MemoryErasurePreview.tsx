import {
  getJson,
  useApiQuery,
  useFeaturePreviewsQuery,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { z } from 'zod/v3';
import { Button } from '../../components/Button';
import { ErrorState, Skeleton } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';

const responseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    kind: z.enum(['record', 'proposal']),
    id: z.string(),
    title: z.string(),
  }),
});

export function MemoryErasurePreview() {
  const scope = useHostRequestAuthorityScope();
  const previews = useFeaturePreviewsQuery();
  const enabled = previews.data?.some(
    (item) => item.id === 'private-memory' && item.enabled,
  );
  const [kind, setKind] = useState<'record' | 'proposal'>('record');
  const [id, setId] = useState('');
  const [target, setTarget] = useState<{
    kind: 'record' | 'proposal';
    id: string;
  } | null>(null);
  const preview = useApiQuery(
    [
      'memory',
      'erasure-preview',
      scope?.apiBase ?? null,
      scope?.authorityKey ?? null,
      target?.kind ?? null,
      target?.id ?? null,
    ],
    async (signal) => {
      if (!scope || !target || !scope.isCurrent())
        throw new Error('Choose a memory first.');
      const query = new URLSearchParams({ kind: target.kind, id: target.id });
      const response = await getJson(
        `${scope.apiBase}/api/knowledge/memory/erasure-preview?${query}`,
        { requestScope: scope, signal },
      );
      if (!response.ok) throw new Error('Could not find that memory.');
      const result = responseSchema.parse(await response.json()).data;
      if (!scope.isCurrent()) throw new Error('Memory access changed.');
      return result;
    },
    {
      enabled: Boolean(enabled && scope && target),
      retry: false,
      staleTime: 0,
      gcTime: 0,
      cancelWhenInactive: true,
    },
  );
  if (!scope || !enabled) return null;
  return (
    <section
      aria-label="Memory erasure preview"
      className="knowledge-memory-preview"
    >
      <h3>Preview memory erasure</h3>
      <p>Find a memory or proposal by its ID. Erasure is not available yet.</p>
      <div className="knowledge-memory-preview__form">
        <label>
          Type{' '}
          <select
            className="editor-input"
            value={kind}
            onChange={(event) => {
              setKind(
                event.target.value === 'proposal' ? 'proposal' : 'record',
              );
              setTarget(null);
            }}
          >
            <option value="record">Record</option>
            <option value="proposal">Proposal</option>
          </select>
        </label>
        <label>
          ID{' '}
          <input
            className="editor-input"
            value={id}
            maxLength={512}
            onChange={(event) => {
              setId(event.target.value);
              setTarget(null);
            }}
          />
        </label>
        <Button
          disabled={!id.trim() || preview.isFetching}
          onClick={() => setTarget({ kind, id: id.trim() })}
        >
          Preview
        </Button>
      </div>
      {preview.isFetching && (
        <Skeleton variant="block" label="Loading preview" />
      )}
      {preview.isError && (
        <ErrorState
          title="Couldn’t load preview"
          action={<Button onClick={() => void preview.refetch()}>Retry</Button>}
        />
      )}
      {!preview.isError && preview.data && target && (
        <div>
          <h4>{preview.data.title}</h4>
          <p>
            {preview.data.kind}: {preview.data.id}
          </p>
          <p>
            Claims affected (from Surface): unavailable.{' '}
            <a href="https://github.com/kontourai/surface/issues/360">
              About claim impact
            </a>
          </p>
          <p>Station has no verified claim bundle for this memory.</p>
          <p>
            The effects on other records and proposals are determined at erasure
            time.{' '}
            <a href="https://github.com/kontourai/corpus/issues/69">
              About cascade preview
            </a>
          </p>
        </div>
      )}
    </section>
  );
}

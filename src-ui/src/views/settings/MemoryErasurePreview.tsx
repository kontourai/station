import {
  getJson,
  useApiQuery,
  useFeaturePreviewsQuery,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { z } from 'zod/v3';
import { Button } from '../../components/Button';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';

const recordImpactSchema = z.object({
  purged: z.array(z.string()),
  cascaded: z.array(z.string()),
  survivors: z.array(z.string()),
  referrers: z.array(z.string()),
  alreadyPurged: z.array(z.string()),
  proposalsRejected: z.array(z.string()),
  proposalsScrubbed: z.array(z.string()),
  proposalsBlocked: z.array(z.string()),
});
const proposalImpactSchema = z.object({
  proposalId: z.string(),
  alreadyErased: z.boolean(),
  state: z.enum(['pending', 'applied', 'rejected']),
  recordId: z.string().optional(),
  record: recordImpactSchema.optional(),
  revision: z.string().min(1),
});
const responseSchema = z.object({
  success: z.literal(true),
  data: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('record'),
      id: z.string(),
      title: z.string(),
      impact: recordImpactSchema.extend({ revision: z.string().min(1) }),
    }),
    z.object({
      kind: z.literal('proposal'),
      id: z.string(),
      title: z.string(),
      impact: proposalImpactSchema,
    }),
  ]),
});
const proposalListSchema = z.object({
  success: z.literal(true),
  data: z.array(
    z.object({
      id: z.string(),
      candidate: z.object({ title: z.string() }),
      erasure: z.unknown().optional(),
    }),
  ),
});

class MemoryLookupError extends Error {
  constructor(readonly kind: 'not-found' | 'unavailable') {
    super(kind);
  }
}

function RecordImpact({
  impact,
}: {
  impact: z.infer<typeof recordImpactSchema>;
}) {
  const groups = [
    ['Records to erase', impact.purged],
    ['Dependent records to erase', impact.cascaded],
    ['Records to review', impact.survivors],
    ['Records that link to erased records', impact.referrers],
    ['Already erased records', impact.alreadyPurged],
    ['Proposals to reject', impact.proposalsRejected],
    ['Proposals to clear', impact.proposalsScrubbed],
    ['Proposals blocked from approval', impact.proposalsBlocked],
  ] as const;
  return (
    <>
      <dl>
        {groups.map(([label, ids]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{ids.length ? ids.join(', ') : 'None'}</dd>
          </div>
        ))}
      </dl>
      {(impact.survivors.length > 0 || impact.referrers.length > 0) && (
        <p>Records to review may still contain erased content.</p>
      )}
    </>
  );
}

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
  const scopeKey = [scope?.apiBase ?? null, scope?.authorityKey ?? null];
  const proposals = useApiQuery(
    ['memory', 'proposals', ...scopeKey],
    async (signal) => {
      if (!scope || !scope.isCurrent())
        throw new MemoryLookupError('unavailable');
      const response = await getJson(
        `${scope.apiBase}/api/knowledge/memory/proposals`,
        { requestScope: scope, signal },
      );
      if (response.status === 404) throw new MemoryLookupError('not-found');
      if (!response.ok) throw new MemoryLookupError('unavailable');
      const result = proposalListSchema.parse(await response.json()).data;
      if (!scope.isCurrent()) throw new MemoryLookupError('unavailable');
      return result
        .filter((item) => !item.erasure)
        .map((item) => ({ id: item.id, title: item.candidate.title }));
    },
    {
      enabled: Boolean(enabled && scope),
      retry: false,
      staleTime: 0,
      gcTime: 0,
      cancelWhenInactive: true,
    },
  );
  const preview = useApiQuery(
    [
      'memory',
      'erasure-preview',
      ...scopeKey,
      target?.kind ?? null,
      target?.id ?? null,
    ],
    async (signal) => {
      if (!scope || !target || !scope.isCurrent())
        throw new MemoryLookupError('unavailable');
      const query = new URLSearchParams({ kind: target.kind, id: target.id });
      const response = await getJson(
        `${scope.apiBase}/api/knowledge/memory/erasure-preview?${query}`,
        { requestScope: scope, signal },
      );
      if (response.status === 404 || response.status === 400)
        throw new MemoryLookupError('not-found');
      if (!response.ok) throw new MemoryLookupError('unavailable');
      const result = responseSchema.parse(await response.json()).data;
      if (
        result.kind !== target.kind ||
        result.id !== target.id ||
        (result.kind === 'proposal' && result.impact.proposalId !== result.id)
      )
        throw new MemoryLookupError('unavailable');
      if (!scope.isCurrent()) throw new MemoryLookupError('unavailable');
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
  if (!scope || !enabled || !scope.isCurrent()) return null;
  const listMissing =
    proposals.error instanceof MemoryLookupError &&
    proposals.error.kind === 'not-found';
  const targetMissing =
    preview.error instanceof MemoryLookupError &&
    preview.error.kind === 'not-found';
  return (
    <section aria-label="Look up a memory" className="knowledge-memory-preview">
      <h3>Look up a memory</h3>
      <p>Erasing memories isn’t available yet.</p>
      <h4>Proposals</h4>
      {proposals.isFetching && (
        <SkeletonBlock count={1} label="Loading proposals" />
      )}
      {listMissing && (
        <Empty
          label="Private memory is unavailable"
          description="Check that the preview is enabled and that you have access."
        />
      )}
      {proposals.isError && !listMissing && (
        <ErrorState
          title="Couldn’t load proposals"
          action={
            <Button onClick={() => void proposals.refetch()}>Retry</Button>
          }
        />
      )}
      {!proposals.isFetching &&
        !proposals.isError &&
        proposals.data?.length === 0 && (
          <Empty label="Proposals will appear here" />
        )}
      {!proposals.isFetching &&
        !proposals.isError &&
        proposals.data &&
        proposals.data.length > 0 && (
          <ul>
            {proposals.data.map((proposal) => (
              <li key={proposal.id}>
                {proposal.title}{' '}
                <Button
                  onClick={() => {
                    setKind('proposal');
                    setId(proposal.id);
                    setTarget({ kind: 'proposal', id: proposal.id });
                  }}
                >
                  Look up proposal
                </Button>
              </li>
            ))}
          </ul>
        )}
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
            maxLength={200}
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
          Look up
        </Button>
      </div>
      {preview.isFetching && (
        <SkeletonBlock count={1} label="Looking up memory" />
      )}
      {targetMissing && <p>That ID doesn’t match a memory or proposal.</p>}
      {preview.isError && !targetMissing && (
        <ErrorState
          title="Couldn’t load memory"
          action={<Button onClick={() => void preview.refetch()}>Retry</Button>}
        />
      )}
      {!preview.isError && preview.data && target && (
        <div>
          <h4>{preview.data.title}</h4>
          <p>
            Found {preview.data.kind} · {preview.data.id}
          </p>
          <p>
            Claims affected (from Surface): unavailable.{' '}
            <a href="https://github.com/kontourai/surface/issues/360">
              About claim impact
            </a>
          </p>
          <p>Station can’t yet show which answers depend on this memory.</p>
          <h4>Erasure effects</h4>
          {preview.data.kind === 'proposal' ? (
            <>
              <p>Proposal to erase: {preview.data.impact.proposalId}</p>
              {preview.data.impact.recordId && (
                <p>Created record: {preview.data.impact.recordId}</p>
              )}
              {preview.data.impact.record && (
                <RecordImpact impact={preview.data.impact.record} />
              )}
            </>
          ) : (
            <RecordImpact impact={preview.data.impact} />
          )}
        </div>
      )}
    </section>
  );
}

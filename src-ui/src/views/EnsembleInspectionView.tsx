import type { EnsembleInspectionInput } from '@kontourai/station-contracts/ensemble';
import { useInspectEnsemble } from '@kontourai/station-sdk';
import { StationHttpError } from '@kontourai/station-sdk/client';
import { useState } from 'react';
import { Button } from '../components/Button';
import { usePageHeader } from '../components/page-frame';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { useNavigationActions } from '../contexts/NavigationContext';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { CliSessionGroupsPanel } from './CliSessionGroupsPanel';
import { EnsembleCliGroupForm } from './EnsembleCliGroupForm';
import { EnsembleInspectionResult } from './EnsembleInspectionResult';
import { EnsemblePresetUpload } from './EnsemblePresetUpload';
import { EnsembleRecordedGroupInspection } from './EnsembleRecordedGroupInspection';
import { ReportGroupsPanel } from './ReportGroupsPanel';
import './EnsembleInspectionView.css';

export function EnsembleInspectionView() {
  usePageHeader({ title: 'Inspect an Ensemble' });
  const scope = useHostRequestAuthorityScope();
  const { navigate } = useNavigationActions();
  return (
    <section className="ensemble-inspection" aria-label="Ensemble inspection">
      <Button
        variant="secondary"
        onClick={() => navigate('/agents', { tab: null })}
      >
        Agents
      </Button>
      <p>
        Inspect preset configuration and receiver bindings before saving or
        running a group.
      </p>
      {scope && (
        <EnsemblePresetUpload
          key={`upload:${scope.apiBase}:${scope.authorityKey}`}
          scope={scope}
        />
      )}
      {scope ? (
        <InspectionForm
          key={`${scope.apiBase}:${scope.authorityKey}`}
          scope={scope}
        />
      ) : (
        <p role="alert">Current Station authority is unavailable.</p>
      )}
      {scope && (
        <ReportGroupsPanel
          key={`reports:${scope.apiBase}:${scope.authorityKey}`}
          scope={scope}
        />
      )}
      {scope && (
        <CliSessionGroupsPanel
          key={`groups:${scope.apiBase}:${scope.authorityKey}`}
          scope={scope}
        />
      )}
    </section>
  );
}

function InspectionForm({
  scope,
}: {
  scope: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
}) {
  const inspection = useInspectEnsemble(scope);
  const [path, setPath] = useState('');
  const [groupDraftDirty, setGroupDraftDirty] = useState(false);
  const { guard, DiscardModal } = useUnsavedGuard(groupDraftDirty);
  const [source, setSource] = useState<{ hash: string; memberIds: string[] }>();
  const [bindings, setBindings] = useState<EnsembleInspectionInput['bindings']>(
    {},
  );
  const result = scope.isCurrent() ? inspection.data : undefined;
  const failure =
    inspection.error instanceof StationHttpError &&
    inspection.error.status === 403
      ? 'Inspection denied. Use the current locally granted operator on a personal Station.'
      : inspection.error instanceof StationHttpError &&
          inspection.error.status === 409
        ? 'Inspection is stale. Reload the source and select the receiver bindings again.'
        : 'Inspection unavailable. Check current Station authority, the source file and exact receiver IDs.';
  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const selected = Object.fromEntries(
            Object.entries(bindings).filter(
              ([, binding]) => binding.agent || binding.projectSlug,
            ),
          );
          inspection.mutate(
            {
              path,
              bindings: selected,
              ...(source ? { expectedPresetHash: source.hash } : {}),
            },
            {
              onSuccess: (data) =>
                setSource({
                  hash: data.source.sha256,
                  memberIds: data.facts
                    .filter((fact) => fact.id.startsWith('member:'))
                    .flatMap((fact) => (fact.memberId ? [fact.memberId] : [])),
                }),
            },
          );
        }}
      >
        <label>
          Preset path on This Station
          <input
            value={path}
            maxLength={4096}
            required
            autoComplete="off"
            spellCheck={false}
            disabled={inspection.isPending}
            onChange={(event) => {
              const nextPath = event.target.value;
              guard(() => {
                setGroupDraftDirty(false);
                setPath(nextPath);
                setSource(undefined);
                setBindings({});
                inspection.reset();
              });
            }}
          />
        </label>
        {source?.memberIds.map((id) => (
          <fieldset key={id} disabled={inspection.isPending || groupDraftDirty}>
            <legend>Receiver binding for {id}</legend>
            <label>
              Agent ID
              <input
                value={bindings[id]?.agent ?? ''}
                maxLength={64}
                autoComplete="off"
                onChange={(event) => {
                  setBindings({
                    ...bindings,
                    [id]: {
                      agent: event.target.value,
                      projectSlug: bindings[id]?.projectSlug ?? '',
                    },
                  });
                  inspection.reset();
                }}
              />
            </label>
            <label>
              Project ID
              <input
                value={bindings[id]?.projectSlug ?? ''}
                maxLength={128}
                autoComplete="off"
                onChange={(event) => {
                  setBindings({
                    ...bindings,
                    [id]: {
                      projectSlug: event.target.value,
                      agent: bindings[id]?.agent ?? '',
                    },
                  });
                  inspection.reset();
                }}
              />
            </label>
          </fieldset>
        ))}
        <Button
          type="submit"
          pending={inspection.isPending}
          disabled={!scope.isCurrent() || !path || groupDraftDirty}
          pendingLabel="Inspecting…"
        >
          Inspect configuration
        </Button>
        {source && (
          <Button
            variant="secondary"
            type="button"
            disabled={inspection.isPending}
            onClick={() => {
              guard(() => {
                setGroupDraftDirty(false);
                setSource(undefined);
                setBindings({});
                inspection.reset();
              });
            }}
          >
            Reload source
          </Button>
        )}
      </form>
      {source && (
        <EnsembleRecordedGroupInspection
          scope={scope}
          path={path}
          hash={source.hash}
        />
      )}
      {inspection.isError && <p role="alert">{failure}</p>}
      {source && result && scope.isCurrent() && (
        <EnsembleCliGroupForm
          key={`${path}:${source.hash}`}
          scope={scope}
          path={path}
          hash={source.hash}
          memberIds={source.memberIds}
          onDirtyChange={setGroupDraftDirty}
        />
      )}
      <DiscardModal />
      {result && <EnsembleInspectionResult result={result} />}
    </>
  );
}

import { useInspectEnsemble } from '@kontourai/station-sdk';
import {
  type ApiRequestScope,
  StationHttpError,
} from '@kontourai/station-sdk/client';
import { useState } from 'react';
import { Button } from '../components/Button';
import { ErrorState, SkeletonBlock } from '../components/state';
import { EnsembleInspectionResult } from './EnsembleInspectionResult';

type Props = {
  scope: ApiRequestScope & { isCurrent(): boolean };
  hash: string;
  path?: string;
  presetJson?: string;
};

export function EnsembleRecordedGroupInspection(props: Props) {
  return (
    <RecordedGroupForm
      key={`${props.scope.apiBase}:${props.scope.authorityKey}:${props.path ?? 'uploaded'}:${props.hash}`}
      {...props}
    />
  );
}

function RecordedGroupForm({ scope, hash, path, presetJson }: Props) {
  const support = useInspectEnsemble(scope);
  const inspection = useInspectEnsemble(scope);
  const [opened, setOpened] = useState(false);
  const [groupId, setGroupId] = useState('');
  const current = scope.isCurrent();
  const offer = current ? support.data?.groupInspection : undefined;
  const available = offer?.state === 'available';
  const result = current ? inspection.data : undefined;
  const source = { path, presetJson, expectedPresetHash: hash, bindings: {} };
  const checkSupport = () => {
    if (!scope.isCurrent()) return;
    setOpened(true);
    inspection.reset();
    support.mutate(source);
  };
  const inspect = () => {
    if (!scope.isCurrent() || !available || !groupId.trim()) return;
    inspection.mutate({ ...source, groupId: groupId.trim() });
  };
  const stale =
    inspection.error instanceof StationHttpError &&
    inspection.error.status === 409;
  return (
    <section aria-label="Inspect a recorded Ensemble group">
      <h3>Recorded group bindings</h3>
      <p>
        Inspect recorded Session references, dependencies and context receipts.
      </p>
      <Button
        type="button"
        variant="secondary"
        pending={support.isPending}
        pendingLabel="Checking support…"
        disabled={!current || inspection.isPending}
        onClick={checkSupport}
      >
        {opened ? 'Refresh recorded group support' : 'Inspect a recorded group'}
      </Button>
      {opened && !current && (
        <p role="status">Station authority changed. Reopen this view.</p>
      )}
      {current && support.isPending && (
        <SkeletonBlock label="Checking recorded group support" />
      )}
      {current && support.isError && (
        <ErrorState
          variant="compact"
          title="Recorded group support could not be checked."
          action={
            <Button type="button" variant="secondary" onClick={checkSupport}>
              Retry support check
            </Button>
          }
        />
      )}
      {current && support.isSuccess && !available && (
        <p role="status">
          {offer?.state === 'unavailable'
            ? offer.detail
            : 'This host does not offer recorded group inspection.'}
        </p>
      )}
      {available && current && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            inspect();
          }}
        >
          <label>
            Recorded group ID
            <input
              value={groupId}
              maxLength={128}
              required
              autoComplete="off"
              spellCheck={false}
              disabled={inspection.isPending}
              onChange={(event) => {
                setGroupId(event.target.value);
                inspection.reset();
              }}
            />
          </label>
          <Button
            type="submit"
            pending={inspection.isPending}
            pendingLabel="Inspecting group…"
            disabled={!groupId.trim() || support.isPending}
          >
            Inspect recorded bindings
          </Button>
        </form>
      )}
      {current && inspection.isPending && (
        <SkeletonBlock label="Loading recorded group bindings" />
      )}
      {current && inspection.isError && (
        <ErrorState
          variant="compact"
          title={
            stale
              ? 'The recorded group or preset changed. Refresh and inspect again.'
              : 'Recorded bindings are unavailable for this preset and Station authority.'
          }
          action={
            <Button
              type="button"
              variant="secondary"
              disabled={!available || !groupId.trim() || inspection.isPending}
              onClick={inspect}
            >
              Retry recorded bindings
            </Button>
          }
        />
      )}
      {result && <EnsembleInspectionResult result={result} />}
    </section>
  );
}

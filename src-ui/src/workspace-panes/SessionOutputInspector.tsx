import type { StationBasisPaneRequestScope } from '@kontourai/station-basis-pane/station-basis-pane';
import type { StationSessionOutputRow } from '@kontourai/station-contracts/session-inventory';
import { useSessionOutputInspection } from '@kontourai/station-sdk/session-outputs';
import { useEffect, useMemo } from 'react';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../components/ResponsiveDialogSurface';
import { SkeletonBlock } from '../components/state';

export function SessionOutputInspector({
  row,
  requestScope,
  returnFocusTarget,
  onClose,
  onUnavailable,
}: {
  row: StationSessionOutputRow;
  requestScope: StationBasisPaneRequestScope;
  returnFocusTarget: HTMLElement | null;
  onClose(): void;
  onUnavailable(): void;
}) {
  const inspection = useSessionOutputInspection(
    row.output.ref.sessionId,
    row.output.ref.eventId,
    { enabled: true, requestScope },
  );
  const imageUrl = useMemo(() => {
    if (inspection.data?.kind !== 'image') return null;
    try {
      const bytes = Uint8Array.from(atob(inspection.data.data), (unit) =>
        unit.charCodeAt(0),
      );
      return URL.createObjectURL(
        new Blob([bytes], { type: inspection.data.mediaType }),
      );
    } catch {
      return null;
    }
  }, [inspection.data]);
  useEffect(
    () => () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    },
    [imageUrl],
  );
  useEffect(() => {
    if (inspection.error) onUnavailable();
  }, [inspection.error, onUnavailable]);
  return (
    <ResponsiveDialogSurface
      ariaLabel="Session output"
      returnFocusTarget={returnFocusTarget}
      onClose={onClose}
    >
      <ResponsiveDialogHeader
        title="Session output"
        closeLabel="Close Session output"
        onClose={onClose}
      />
      {inspection.isLoading ? (
        <SkeletonBlock count={3} label="Loading output" />
      ) : null}
      {inspection.error ? (
        <p role="alert">This output is unavailable.</p>
      ) : null}
      {inspection.data?.kind === 'metadata' ? (
        <p>Metadata only. This pull request is live external state.</p>
      ) : null}
      {inspection.data?.kind === 'text' ? (
        <pre className="session-output-inspector__text">
          {inspection.data.text}
        </pre>
      ) : null}
      {inspection.data?.kind === 'image' && imageUrl ? (
        <img
          className="session-output-inspector__image"
          src={imageUrl}
          alt="Declared Session output"
        />
      ) : null}
    </ResponsiveDialogSurface>
  );
}

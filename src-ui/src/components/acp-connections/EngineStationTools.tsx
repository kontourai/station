import { useEngineStationTools } from '@kontourai/station-sdk/engine-setup';
import { useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { describeStationFailure } from '../../utils/stationFailure';
import { Button } from '../Button';
import { ConfirmModal } from '../modals/ConfirmModal';
import { ErrorState, SkeletonBlock } from '../state';

export function EngineStationTools({ connectionId }: { connectionId: string }) {
  const scope = useHostRequestAuthorityScope();
  return scope ? (
    <ScopedTools
      key={`${scope.apiBase}:${scope.authorityKey}:${connectionId}`}
      connectionId={connectionId}
      scope={scope}
    />
  ) : null;
}
function ScopedTools({
  connectionId,
  scope,
}: {
  connectionId: string;
  scope: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
}) {
  const { query, enable, repair, offered } = useEngineStationTools(
    connectionId,
    scope,
  );
  const [confirmation, setConfirmation] = useState<NonNullable<
    NonNullable<typeof query.data>['recommended']
  > | null>(null);
  if (!offered) return null;
  if (query.isPending) return <SkeletonBlock />;
  if (query.isError)
    return (
      <ErrorState
        title="Couldn't load Agent tools"
        action={<Button onClick={() => void query.refetch()}>Retry</Button>}
      />
    );
  const view = query.data;
  if (!view) return null;
  return (
    <div className="editor-field">
      <ConfirmModal
        isOpen={confirmation !== null}
        title="Use recommended engine setup"
        message={`Uses these launch arguments and keeps the connection and Agent:\n\n${confirmation?.command ?? ''} ${confirmation?.args.join(' ') ?? ''}`}
        confirmLabel="Apply setup"
        cancelLabel="Cancel"
        onCancel={() => setConfirmation(null)}
        onConfirm={() => {
          if (confirmation) repair.mutate(confirmation);
          setConfirmation(null);
        }}
      />
      {view.recommended ? (
        <Button
          pending={repair.isPending}
          onClick={() => {
            if (view.recommended) setConfirmation(view.recommended);
          }}
        >
          Use recommended setup
        </Button>
      ) : null}
      {!view.selected ? (
        <>
          <span className="editor-label">Station tools</span>
          <p className="editor-help">
            Let this Agent work with your Station chats, knowledge and docs.
          </p>
        </>
      ) : null}
      {view.selected ? (
        <p className="editor-help" role="status">
          Station tools selected for new chats.
        </p>
      ) : view.supported ? (
        <Button pending={enable.isPending} onClick={() => enable.mutate()}>
          Add Station tools
        </Button>
      ) : (
        <p className="editor-help">
          Check the engine connection before adding Station tools.
        </p>
      )}
      {repair.error ? (
        <ErrorState
          title="Couldn't update engine setup"
          description={describeStationFailure(repair.error).body}
          action={
            <Button onClick={() => void query.refetch()}>Check status</Button>
          }
        />
      ) : null}
      {enable.error ? (
        <ErrorState
          title="Couldn't add Station tools"
          description={describeStationFailure(enable.error).body}
          action={
            <Button onClick={() => void query.refetch()}>Check status</Button>
          }
        />
      ) : null}
    </div>
  );
}

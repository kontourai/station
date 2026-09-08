import { useOrchestrationSessionQuery } from '@kontourai/station-sdk';
import { useState } from 'react';
import { Button } from '../Button';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import { SessionDetail } from '../session-detail/SessionDetail';
import { SkeletonBlock } from '../state';
import './InboxSessionDetails.css';

export default function InboxSessionDetails({
  threadId,
  apiBase,
  onClose,
  onOpenActivity,
}: {
  threadId: string;
  apiBase: string;
  onClose: () => void;
  onOpenActivity: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(threadId);
  const detail = useOrchestrationSessionQuery(selectedId, { retry: false });
  return (
    <ResponsiveDialogSurface
      layer="dialog"
      ariaLabel="Chat details"
      onClose={onClose}
      overlayClassName="inbox-session-details-overlay"
      panelClassName="inbox-session-details"
    >
      <ResponsiveDialogHeader
        title="Chat details"
        closeLabel="Close chat details"
        onClose={onClose}
      />
      <div className="inbox-session-details__body">
        {detail.isLoading && (
          <SkeletonBlock count={1} label="Loading chat details" />
        )}
        {detail.isError && (
          <div role="alert">
            <p>Could not load this session.</p>
            <Button onClick={() => void detail.refetch()}>Retry</Button>
          </div>
        )}
        {detail.data && (
          <SessionDetail
            presentation="chat"
            apiBase={apiBase}
            session={detail.data.session}
            onTaskChanged={() => void detail.refetch()}
            getSelectionIntent={() => 0}
            onAdopted={(child) => setSelectedId(child.threadId)}
          />
        )}
      </div>
      <Button onClick={() => onOpenActivity(selectedId)}>
        Open in Activity
      </Button>
    </ResponsiveDialogSurface>
  );
}

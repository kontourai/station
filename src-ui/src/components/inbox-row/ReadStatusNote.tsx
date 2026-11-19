import { conversationQueries } from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import './ReadStatusNote.css';

/**
 * #3075 review: one quiet note per surface when the server could not read
 * this person's read state. The rows themselves show "unknown"; this says
 * why once and offers a re-read. The conversations stay listed either way.
 */
export function ReadStatusNote({
  items,
}: {
  items: readonly Pick<HomeWorkItem, 'readStateUnavailable'>[];
}) {
  if (!items.some((item) => item.readStateUnavailable === true)) return null;
  return <ReadStatusNoteBody />;
}

function ReadStatusNoteBody() {
  const client = useQueryClient();
  return (
    <p className="read-status-note" role="status">
      Read status unavailable.{' '}
      <button
        type="button"
        className="read-status-note__retry"
        onClick={() =>
          void client.invalidateQueries(
            { queryKey: conversationQueries.inventory().queryKey },
            // A read already in flight answers too; never cancel it.
            { cancelRefetch: false },
          )
        }
      >
        Retry
      </button>
    </p>
  );
}

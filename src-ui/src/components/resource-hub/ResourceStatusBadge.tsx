import { Badge } from '@kontourai/ui/react';
import type { ResourceStatus } from './resource-status';
import './resource-hub.css';

/**
 * A resource's status as a labelled badge; color only reinforces the text.
 * Inline (a `span`), so it can sit inside a row button. A long label is
 * cut visually but stays whole in the accessible text, and the reason is
 * read with it.
 */
export function ResourceStatusBadge({ status }: { status: ResourceStatus }) {
  return (
    <span className="resource-status" title={status.label}>
      <Badge
        value={status.label}
        tone={status.tone}
        className="resource-status__badge"
      />
      {status.reason ? (
        <span className="sr-only">{`: ${status.reason}`}</span>
      ) : null}
    </span>
  );
}

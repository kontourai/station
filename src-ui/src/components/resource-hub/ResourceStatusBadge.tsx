import { StatusBadge } from '@kontourai/ui/react';
import type { ResourceStatus } from './resource-status';
import './resource-hub.css';

/** A resource's status as a labelled badge; color only reinforces the text. */
export function ResourceStatusBadge({ status }: { status: ResourceStatus }) {
  return (
    <StatusBadge
      status={status.label}
      tone={status.tone}
      className="resource-status-badge"
    />
  );
}

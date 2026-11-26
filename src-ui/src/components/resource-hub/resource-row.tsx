import type { ReactNode } from 'react';
import type { SplitPaneItem } from '../SplitPaneLayout';
import { ResourceStatusBadge } from './ResourceStatusBadge';
import type { ResourceStatus } from './resource-status';

interface ResourceRowInput {
  id: string;
  name: string;
  icon?: ReactNode;
  /** Rendered as the row's badge, beside the name. */
  status: ResourceStatus;
  /** At most two short facts, never the status. Empty ones are left out. */
  facts?: readonly [(string | null | undefined)?, (string | null | undefined)?];
}

/**
 * Builds a `SplitPaneLayout` row: the status is a badge beside the name, and
 * the subtitle holds facts only. Rows used to put the status word in the
 * subtitle and paint an inline dot as the icon.
 */
export function resourceRow(input: ResourceRowInput): SplitPaneItem {
  const subtitle = (input.facts ?? []).filter(Boolean).join(' · ');
  return {
    id: input.id,
    name: input.name,
    ...(input.icon ? { icon: input.icon } : {}),
    badge: <ResourceStatusBadge status={input.status} />,
    ...(subtitle ? { subtitle } : {}),
  };
}

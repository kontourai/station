import type {
  SpatialBoardResolvedPin,
  WorkReference,
} from '@kontourai/station-contracts';
import type { SemanticTone } from '@kontourai/ui/react';

export const PIN_STATE_COPY: Record<
  SpatialBoardResolvedPin['state'],
  { label: string; detail: string }
> = {
  current: { label: 'Linked', detail: 'This pin opens the work it points to.' },
  missing: {
    label: 'Not found',
    detail: 'The work this pin points to no longer exists.',
  },
  stale: {
    label: 'Moved',
    detail: 'The work this pin points to now lives in a different project.',
  },
  unavailable: {
    label: 'Can’t load',
    detail:
      'Station couldn’t read the work this pin points to. It may be temporary.',
  },
  ambiguous: {
    label: 'Multiple matches',
    detail: 'More than one owner record matches this pin’s exact identity.',
  },
  NOT_VERIFIED: {
    label: 'Unconfirmed',
    detail: 'Station is still looking up the work this pin points to.',
  },
};

export const PIN_STATE_TONE: Record<
  SpatialBoardResolvedPin['state'],
  SemanticTone
> = {
  current: 'positive',
  missing: 'negative',
  stale: 'caution',
  unavailable: 'negative',
  ambiguous: 'caution',
  NOT_VERIFIED: 'neutral',
};

export function referenceKindLabel(reference: WorkReference) {
  switch (reference.kind) {
    case 'task':
      return 'Task';
    case 'run':
      return 'Flow run';
    case 'receipt':
      return 'Receipt';
    case 'artifact':
      return 'Artifact';
    default:
      return reference.kind.charAt(0).toUpperCase() + reference.kind.slice(1);
  }
}

export function referenceLabel(reference: WorkReference) {
  switch (reference.kind) {
    case 'project':
    case 'session':
    case 'approval':
    case 'agent':
      return `${reference.kind} ${reference.id}`;
    case 'task':
      return `task ${reference.projectId}/${reference.id}`;
    case 'receipt':
      return reference.owner === 'scheduler-run'
        ? `scheduler receipt ${reference.id}`
        : `review receipt ${reference.projectSlug}/${reference.id}`;
    case 'run':
      return `flow run ${reference.projectId}/${reference.id}${reference.gateId ? `/${reference.gateId}` : ''}`;
    case 'artifact':
      return `artifact ${reference.runId}/${reference.id}`;
  }
}

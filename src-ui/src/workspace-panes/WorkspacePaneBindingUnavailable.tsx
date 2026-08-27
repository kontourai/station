import { Empty, ErrorState, SkeletonList } from '../components/state';
import type { WorkspacePaneBoundIdentity } from './useWorkspacePaneBoundIdentity';

/**
 * station#3969. Every line here used to be written in the resolver's own
 * vocabulary — "binding", "captured identity", "occurrence", "renderer". None
 * of those are words a person has met: a "pane occurrence" is our name for one
 * open copy of a pane, and a "binding" is our name for the Project or layout it
 * remembers being part of. What the reader needs is which of their things is
 * missing, and whether anything of theirs is lost.
 */
const copy = {
  'missing-project-binding': [
    'This pane isn’t linked to a Project',
    'It was saved without one, so Station can’t tell which Project’s work to show here.',
  ],
  'missing-layout-binding': [
    'This pane isn’t linked to a layout',
    'It was saved without one, so Station can’t tell where it belongs.',
  ],
  'pane-instance-invalid': [
    'This pane can’t open here',
    'It was saved as a different kind of pane than the one trying to show it.',
  ],
  'pane-state-mismatch': [
    'This pane’s saved contents are missing',
    'Station either can’t find them or they belong to a different pane.',
  ],
} as const;

function unresolvableCopy(
  entity: 'Project' | 'layout',
  reason: 'missing' | 'ambiguous',
): readonly [string, string] {
  if (reason === 'ambiguous')
    return [
      `More than one ${entity} matches`,
      `This pane remembers a ${entity} name that now fits more than one, so Station won’t guess which you meant.`,
    ];
  return [
    `That ${entity} is gone`,
    `The ${entity} this pane was saved in no longer exists${entity === 'layout' ? ' in its Project' : ' on this Station'}.`,
  ];
}

/** Shared presentation for a resolver state that cannot render a pane. */
export function WorkspacePaneBindingUnavailable({
  identity,
}: {
  identity: Exclude<WorkspacePaneBoundIdentity, { state: 'resolved' }>;
}) {
  if (identity.state === 'loading')
    return (
      <SkeletonList count={1} withIcon={false} label="Loading this pane" />
    );
  if (identity.state === 'query-error') {
    const target = identity.query === 'projects' ? 'Projects' : 'layouts';
    return (
      <ErrorState
        variant="compact"
        title={`Could not load ${target}`}
        description={`Station couldn’t read the ${target.toLowerCase()} this pane needs to know where it belongs.`}
      />
    );
  }
  const [label, description] =
    identity.state === 'project-unresolvable'
      ? unresolvableCopy('Project', identity.reason)
      : identity.state === 'layout-unresolvable'
        ? unresolvableCopy('layout', identity.reason)
        : copy[identity.state];
  return <Empty variant="compact" label={label} description={description} />;
}

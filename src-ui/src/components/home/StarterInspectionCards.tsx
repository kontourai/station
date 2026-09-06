import type {
  StarterInspectionId,
  StarterInspectionObservation,
  StarterInspectionReference,
  StarterWorkObservation,
} from '@kontourai/station-contracts/starter-work';
import {
  useLaunchStarterInspectionMutation,
  useStarterInspectionCandidateQuery,
  useStarterWorkObservationQuery,
  useStarterWorkQuery,
} from '@kontourai/station-sdk';
import { useNavigation } from '../../contexts/NavigationContext';
import { Button } from '../Button';
import { PageCallout } from '../PageCallout';
import { SkeletonBlock } from '../state';
import { navigateStarterHref } from './starterNavigation';

const INSPECTIONS = [
  {
    id: 'inspect-approval',
    title: 'Inspect an approval',
    description: 'Open one real approval request without deciding it.',
    action: 'Inspect approval',
  },
  {
    id: 'inspect-receipt',
    title: 'Inspect review evidence',
    description: 'Open one real independent-review receipt as evidence input.',
    action: 'Inspect receipt',
  },
] as const;

function isInspectionObservation(
  value: StarterWorkObservation | undefined,
): value is StarterInspectionObservation {
  return (
    value?.starterId === 'inspect-approval' ||
    value?.starterId === 'inspect-receipt'
  );
}

function identity(reference: StarterInspectionReference): string {
  if (reference.kind === 'approval') return `approval\0${reference.id}`;
  return reference.owner === 'independent-review'
    ? `receipt\0${reference.owner}\0${reference.projectSlug}\0${reference.id}`
    : `receipt\0${reference.owner}\0${reference.id}`;
}

export async function starterInspectionOperationId(
  starterId: StarterInspectionId,
  reference: StarterInspectionReference,
): Promise<string> {
  if (!globalThis.crypto?.subtle)
    throw new Error('Secure Starter identity is unavailable.');
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${starterId}\0${identity(reference)}`),
  );
  return `inspect:${starterId}:${[...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

export function StarterInspectionCards() {
  return (
    <>
      {INSPECTIONS.map((inspection) => (
        <StarterInspectionCard key={inspection.id} {...inspection} />
      ))}
    </>
  );
}

function StarterInspectionCard({
  id,
  title,
  description,
  action,
}: (typeof INSPECTIONS)[number]) {
  const { navigate } = useNavigation();
  const status = useStarterWorkQuery(id);
  const unbound = status.data?.state === 'unbound';
  const bound = status.data?.state === 'bound';
  const candidate = useStarterInspectionCandidateQuery(id, {
    enabled: unbound,
  });
  const observation = useStarterWorkObservationQuery(id, { enabled: bound });
  const inspectionObservation = isInspectionObservation(observation.data)
    ? observation.data
    : undefined;
  const launch = useLaunchStarterInspectionMutation();
  const target =
    unbound && candidate.data?.state === 'current'
      ? candidate.data.reference
      : bound && inspectionObservation?.targetRef
        ? inspectionObservation.targetRef
        : null;
  const href = bound ? inspectionObservation?.href : undefined;
  const loading =
    status.isLoading ||
    (unbound && candidate.isLoading) ||
    (bound && observation.isLoading);
  const failed =
    status.isError ||
    status.data?.state === 'unavailable' ||
    (unbound && candidate.isError) ||
    (bound && observation.isError);

  const retry = () => {
    if (status.isError) void status.refetch();
    else if (unbound) void candidate.refetch();
    else void observation.refetch();
  };

  const open = async () => {
    if (href) {
      navigateStarterHref(navigate, href);
      return;
    }
    if (!target) return;
    const result = await launch.mutateAsync({
      starterId: id,
      operationId: await starterInspectionOperationId(id, target),
      targetRef: target,
    });
    if (result.state === 'opened') navigateStarterHref(navigate, result.href);
  };

  if (loading)
    return (
      // #1582 C4: the same page callout Home's other offers use. One id per
      // inspection, so the two cards are distinct and neither can be deduped
      // away by the other.
      <PageCallout calloutId={`starter-${id}`} ariaLabel={title} busy>
        <SkeletonBlock count={1} label={`Checking ${title.toLowerCase()}`} />
      </PageCallout>
    );

  const ownerState = unbound
    ? candidate.data?.state
    : inspectionObservation?.completion.state;
  const unreachable =
    failed ||
    ownerState === 'missing' ||
    ownerState === 'unavailable' ||
    ownerState === 'NOT_VERIFIED';
  return (
    <PageCallout
      calloutId={`starter-${id}`}
      // An owner Station cannot reach is not an ordinary offer.
      tone={unreachable ? 'warning' : 'info'}
      ariaLabel={title}
      title={title}
      action={
        unreachable ? (
          <Button onClick={retry}>
            Retry {id === 'inspect-approval' ? 'approval' : 'receipt'}{' '}
            inspection
          </Button>
        ) : target ? (
          <Button
            variant="primary"
            pending={launch.isPending}
            onClick={() => void open()}
          >
            {bound
              ? `Reopen ${id === 'inspect-approval' ? 'approval' : 'receipt'}`
              : action}
          </Button>
        ) : null
      }
    >
      {failed
        ? 'The exact owner is unavailable.'
        : ownerState === 'missing'
          ? 'An exact owner-backed item is not available yet.'
          : ownerState === 'unavailable' || ownerState === 'NOT_VERIFIED'
            ? 'The exact owner could not be verified.'
            : description}
      {launch.isError && (
        <p className="page-callout__notice" role="alert">
          Inspection was not confirmed. Retry reuses the same exact operation.
        </p>
      )}
    </PageCallout>
  );
}

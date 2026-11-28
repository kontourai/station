import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useDeviceAccessProposal } from '../../workspace-panes/device/deviceToolchainApi';
import { ActionRow } from '../ActionRow';
import { Button } from '../Button';
import { useOptionalConversationConnection } from '../conversation/ConversationConnectionContext';
import { ErrorState, SkeletonBlock } from '../state';

function ProposalActions({
  scope,
  id,
}: {
  scope: ApiRequestScope;
  id: string;
}) {
  const { proposal, decision } = useDeviceAccessProposal(scope, id);
  if (proposal.isPending)
    return <SkeletonBlock label="Loading device access request" count={1} />;
  if (proposal.error?.status === 403)
    return <p>The Station operator can decide this request.</p>;
  if (proposal.error?.status === 404)
    return <p>This device access request is unavailable.</p>;
  if (proposal.isError)
    return (
      <ErrorState
        variant="compact"
        title="Could not load the device access request"
        action={<Button onClick={() => void proposal.refetch()}>Retry</Button>}
      />
    );
  if (proposal.data.state !== 'pending') {
    const labels = {
      approved: 'Device access approved',
      declined: 'Device access declined',
      expired: 'Device access request expired',
    };
    return <p>{labels[proposal.data.state]}</p>;
  }
  return (
    <section aria-label="Device access request" className="content-stack">
      <p>
        Allow agent sessions to control simulators and emulators. Approval
        installs agent-device {proposal.data.version} from npm.
      </p>
      {decision.isError && (
        <ErrorState variant="compact" title="Could not save your decision" />
      )}
      <ActionRow
        overflowLabel="More device access actions"
        secondary={
          <Button
            disabled={decision.isPending}
            onClick={() => decision.mutate('decline')}
          >
            Decline
          </Button>
        }
        primary={
          <Button
            variant="primary"
            disabled={decision.isPending}
            onClick={() => decision.mutate('approve')}
          >
            Allow and install
          </Button>
        }
      />
    </section>
  );
}

export function DeviceAccessProposalCard({ id }: { id: string }) {
  const connection = useOptionalConversationConnection();
  const scope = connection?.requestScope;
  if (
    !scope?.isCurrent() ||
    connection?.record?.readOnly ||
    connection?.station?.isCurrent() === false
  )
    return (
      <p>Open the chat on this Station to decide the device access request.</p>
    );
  return <ProposalActions key={scope.authorityKey} scope={scope} id={id} />;
}

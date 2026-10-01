import { useAgentsQuery } from '@kontourai/station-sdk';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import {
  type SchedulerJobDialogRequest,
  schedulerJobDialogStore,
} from '../../contexts/scheduler-job-dialog-store';
import { useSchedulerProviders } from '../../hooks/useScheduler';
import { useNewChatSetupReturn } from '../modals/useNewChatSetupReturn';
import { JobFormModal } from './JobFormModal';

const SETUP_PATHS = ['/agents', '/connections'];
function SchedulerJobDialog({
  request,
}: {
  request: SchedulerJobDialogRequest;
}) {
  const { data: providers = [] } = useSchedulerProviders();
  const agents = useAgentsQuery();
  const [ready, setReady] = useState(false);
  const [setupError, setSetupError] = useState<unknown>();
  const close = () => schedulerJobDialogStore.close(request);
  const setup = useNewChatSetupReturn({
    authority: request.authority,
    onCancel: close,
    onResume: setSetupError,
    revalidate: () => agents.refetch({ throwOnError: true }),
    workflowLabel: request.job ? 'Edit Job' : 'Add Job',
    readyToResume: ready && !agents.isFetching && !agents.isError,
    allowedPaths: SETUP_PATHS,
  });
  return (
    <JobFormModal
      job={request.job}
      prefill={request.prefill}
      providers={providers}
      onClose={close}
      hidden={setup.suspended}
      setupError={setupError}
      checkingSetup={agents.isFetching}
      onReadinessChange={setReady}
      onSetupAgent={(target) => {
        setSetupError(undefined);
        setup.begin(target);
      }}
    />
  );
}
export function SchedulerJobDialogHost() {
  const request = useSyncExternalStore(
    schedulerJobDialogStore.subscribe,
    schedulerJobDialogStore.getSnapshot,
  );
  const authority = useHostRequestAuthorityScope();
  const current =
    request?.authority.isCurrent() &&
    authority?.authorityKey === request.authority.authorityKey &&
    authority.apiBase === request.authority.apiBase;
  useEffect(() => {
    if (request && !current) schedulerJobDialogStore.close(request);
  }, [current, request]);
  return request && current ? (
    <SchedulerJobDialog key={request.epoch} request={request} />
  ) : null;
}

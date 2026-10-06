import { useAgentsQuery } from '@kontourai/station-sdk';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import {
  type SchedulerJobDialogRequest,
  schedulerJobDialogStore,
} from '../../contexts/scheduler-job-dialog-store';
import { useReconcilingCatalogRefresh } from '../../hooks/useNewChatSelectionModel';
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
  // Unchanged retained rows may share identity across successful reads.
  useReconcilingCatalogRefresh(
    agents.catalogState,
    agents.dataUpdatedAt,
    agents.refetch,
  );
  const [ready, setReady] = useState(false);
  const [setupError, setSetupError] = useState<unknown>();
  const checkingSetup =
    agents.isFetching || agents.catalogState === 'reconciling';
  useEffect(() => {
    if (!checkingSetup && agents.isSuccess) setSetupError(undefined);
  }, [checkingSetup, agents.isSuccess]);
  const close = () => schedulerJobDialogStore.close(request);
  const setup = useNewChatSetupReturn({
    authority: request.authority,
    onCancel: close,
    onResume: setSetupError,
    revalidate: async () => {
      const result = await agents.refetch({ throwOnError: true });
      if (result.data?.catalogState === 'reconciling')
        throw new Error(
          'Could not verify current agent setup while Station updates its catalog.',
        );
    },
    workflowLabel: request.job ? 'Edit Job' : 'Add Job',
    readyToResume: ready && !checkingSetup && !agents.isError,
    allowedPaths: SETUP_PATHS,
  });
  return (
    <JobFormModal
      job={request.job}
      prefill={request.prefill}
      providers={providers}
      onClose={setup.close}
      hidden={setup.suspended}
      setupError={setupError}
      checkingSetup={checkingSetup}
      interactionDisabled={setup.pending}
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

import {
  useConnectAndMaterializeEngineMutation,
  useMaterializeEngineAgentMutation,
} from '@kontourai/station-sdk';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import { useSystemStatus } from '../../hooks/useSystemStatus';
import { userFacingErrorMessage } from '../../utils/errorText';
import {
  buildFirstRunEngineOptions,
  isEngineStillStarting,
} from '../first-run/first-run-engines';
import { ErrorState, SkeletonList } from '../state';

export function AutomaticEnginePreparation({
  agents,
  refresh,
  onComplete,
  onStart,
  isCurrent,
}: {
  agents: AgentData[];
  refresh: () => Promise<void>;
  /**
   * `startingNotice`: an app whose first start is still running on the
   * server. Not a failure, so it never arrives as `failure`.
   */
  onComplete: (
    engineId?: string,
    failure?: string,
    startingNotice?: string,
  ) => void;
  onStart: () => void;
  isCurrent: () => boolean;
}) {
  const status = useSystemStatus();
  const connect = useConnectAndMaterializeEngineMutation();
  const materialize = useMaterializeEngineAgentMutation();
  const attempted = useRef(false);
  const active = useRef(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const prepare = useEffectEvent(async () => {
    const candidates = buildFirstRunEngineOptions({
      engines: status.data?.externalEngines ?? [],
      agents,
    }).filter(
      (option) =>
        option.state === 'available' || option.state === 'detected_connect',
    );
    let lastEngine: string | undefined;
    let failureMessage: string | undefined;
    let startingNotice: string | undefined;
    for (const candidate of candidates) {
      if (!active.current || !isCurrent()) return;
      lastEngine = candidate.engineId;
      try {
        const result = candidate.registryEntryId
          ? await connect.mutateAsync(candidate.registryEntryId)
          : candidate.engineConnectionId
            ? await materialize.mutateAsync(candidate.engineConnectionId)
            : undefined;
        if (!active.current || !isCurrent()) return;
        if (result) {
          await refresh();
          if (active.current && isCurrent()) {
            if (result.warnings?.length)
              onComplete(lastEngine, result.warnings.join('\n'));
            else onComplete(lastEngine);
          }
          return;
        }
      } catch (failure) {
        if (!active.current || !isCurrent()) return;
        if (isEngineStillStarting(failure)) {
          startingNotice = userFacingErrorMessage(failure);
        } else {
          failureMessage = userFacingErrorMessage(failure);
        }
      }
    }
    if (!active.current || !isCurrent()) return;
    await refresh();
    if (active.current && isCurrent())
      onComplete(lastEngine, failureMessage, startingNotice);
  });
  useEffect(() => {
    if (
      attempted.current ||
      status.isLoading ||
      status.isFetching ||
      !status.data
    )
      return;
    attempted.current = true;
    onStart();
    void prepare().catch((failure) => {
      if (active.current && isCurrent())
        setError(userFacingErrorMessage(failure));
    });
  }, [status.data, status.isLoading, status.isFetching, isCurrent, onStart]);
  if (status.error || error)
    return (
      <ErrorState
        variant="compact"
        title="Could not prepare an AI app"
        description={error ?? userFacingErrorMessage(status.error)}
      />
    );
  return <SkeletonList count={1} label="Finding a working AI app" />;
}

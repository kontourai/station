import { useState } from 'react';
import type { UsageDays } from '../../components/resource-hub/UsagePanel';
import { ConnectionUsage } from '../engine-detail/EngineUsageTab';
import { useEngineAccountAccess } from '../engine-detail/useEngineAccountAccess';

/**
 * A model connection's Station-observed usage, by the model connection runs
 * recorded (`modelConnectionId`), on this Station only.
 */
export function ModelUsageTab({
  connectionId,
  name,
}: {
  connectionId: string;
  name: string;
}) {
  const access = useEngineAccountAccess();
  const [days, setDays] = useState<UsageDays>(7);
  return (
    <ConnectionUsage
      filter={{ modelConnectionId: connectionId }}
      label={name}
      scope="This Station · this model connection"
      unattributed="Runs recorded before Station tracked each run's model connection are not counted here."
      access={access}
      days={days}
      onDaysChange={setDays}
    />
  );
}

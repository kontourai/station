import type { ACPConnectionRegistryEntry } from '@kontourai/station-contracts/acp';
import { useState } from 'react';
import {
  recheckACPConnectionRegistry,
  useACPConnectionRegistry,
} from '../../hooks/useACPConnections';
import { useDevicePresentation } from '../../hooks/useDevicePresentation';
import { EngineInstallHint } from './EngineInstallHint';
import { registryEntryDiscovery } from './registryEntryDiscovery';

/**
 * The install hint for one catalogue entry. Mounted only for an entry the
 * host lookup did not find, so a found entry costs no queries. Once mounted it
 * reads the live registry query rather than the caller's copy: a surface may
 * hold a snapshot (the add dialog keeps the entry it was opened with), and
 * after "Check again" the hint must follow the fresh lookup.
 */
export function RegistryEntryInstallHint({
  entry,
}: {
  entry: ACPConnectionRegistryEntry;
}) {
  if (registryEntryDiscovery(entry) !== 'not-installed') return null;
  return <LiveRegistryEntryInstallHint entry={entry} />;
}

function LiveRegistryEntryInstallHint({
  entry,
}: {
  entry: ACPConnectionRegistryEntry;
}) {
  const devicePresentation = useDevicePresentation();
  const [rechecking, setRechecking] = useState(false);
  const {
    data: entries,
    refetch,
    isFetching = false,
  } = useACPConnectionRegistry() as {
    data?: ACPConnectionRegistryEntry[];
    refetch: () => unknown;
    isFetching?: boolean;
  };
  const current =
    entries?.find((candidate) => candidate.id === entry.id) ?? entry;
  if (registryEntryDiscovery(current) !== 'not-installed') return null;
  return (
    <EngineInstallHint
      name={current.name}
      recipe={current.hostInstall}
      devicePresentation={devicePresentation}
      provenance={current.source === 'core' ? undefined : current.sourceName}
      onCheckAgain={() => {
        setRechecking(true);
        // The re-read updates the host's search PATH; the refetch then
        // carries the fresh detection into the shared catalogue query.
        void recheckACPConnectionRegistry()
          .catch(() => undefined)
          .then(() => refetch())
          .finally(() => setRechecking(false));
      }}
      checking={rechecking || isFetching}
    />
  );
}

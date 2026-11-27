import { useSyncExternalStore } from 'react';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/state';
import { pluginRegistry } from '../../core/PluginRegistry';

/**
 * Says which apps this window could not load, with Retry. A refusal to load
 * remote extension code is not a failure: the extension controls answer it.
 */
export function AppsLoadFailure() {
  const status = useSyncExternalStore(
    pluginRegistry.subscribe,
    pluginRegistry.getLoadStatus,
  );
  if (status.state !== 'degraded' || status.failure === 'remote-isolation')
    return null;
  return (
    <ErrorState
      variant="compact"
      title={
        status.failedPluginNames.length
          ? `Couldn't load: ${status.failedPluginNames.join(', ')}`
          : "Couldn't load this Station's apps"
      }
      action={
        <Button size="sm" onClick={() => void pluginRegistry.reload()}>
          Retry
        </Button>
      }
    />
  );
}

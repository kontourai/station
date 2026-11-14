/**
 * Offers the remote task engine as an engine connection and a same-id Agent,
 * once the person has a connection ready for chats (preview on, policy
 * allows it, acknowledged, token set). Uses the registry's own native-engine
 * adoption, so it is idempotent and honours a recorded decline: removing the
 * engine from the Agents page keeps it removed.
 */
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import {
  adoptNativeEngineConnection,
  materializeEngineAgent,
  type NativeEngineAdoptionOutcome,
} from '../../domain/agent-registry.js';
import type { ConfigLoader } from '../../domain/config-loader.js';
import type { RemoteTaskEngineService } from './service.js';

export const REMOTE_TASK_ENGINE_ID = 'remote-task';

export async function adoptRemoteTaskEngineWhenReady(deps: {
  readonly service: Pick<RemoteTaskEngineService, 'readyConnections'>;
  readonly configLoader: ConfigLoader;
  readonly reloadAgents: () => Promise<void>;
}): Promise<NativeEngineAdoptionOutcome | 'not-ready'> {
  if (deps.service.readyConnections().length === 0) return 'not-ready';
  const outcome = await adoptNativeEngineConnection(
    deps.configLoader,
    REMOTE_TASK_ENGINE_ID,
  );
  if (outcome === 'adopted' || outcome === 'exists')
    await materializeEngineAgent(
      deps.configLoader,
      REMOTE_TASK_ENGINE_ID,
      engineDisplayLabel(REMOTE_TASK_ENGINE_ID) ?? 'Remote task engine',
    );
  if (outcome === 'adopted') await deps.reloadAgents();
  return outcome;
}

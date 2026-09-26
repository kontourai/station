import type {
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerScopeV1,
} from '@kontourai/station-contracts/self-hosted-broker';
import {
  createNativeV2PionDiagnosticAdapter,
  type NativeV2PionDiagnosticAdapterDependencies,
  type NativeV2PionDiagnosticAdapterInput,
} from './native-v2-pion-diagnostic-adapter.js';
import type { SelfHostedBrokerClient } from './self-hosted-broker-client.js';
import { SelfHostedBrokerConnector as BrokerConnector } from './self-hosted-broker-connector.js';

export interface NativeV2PionDiagnosticLabInput
  extends Omit<NativeV2PionDiagnosticAdapterInput, 'surface'> {
  surface: SelfHostedBrokerNativeClientSurfaceV2;
  scope: SelfHostedBrokerScopeV1;
  client: SelfHostedBrokerClient;
}

/**
 * Explicit opt-in lab composition. Nothing in runtime startup imports this
 * factory; callers must register it and invoke the native-v2 poll themselves.
 * The legacy browser-offer callback always rejects, and the only negotiated
 * channel is Pion's bounded `station-lab-v1` diagnosticEcho profile.
 */
export function createNativeV2PionDiagnosticLab(
  input: NativeV2PionDiagnosticLabInput,
  dependencies?: NativeV2PionDiagnosticAdapterDependencies,
) {
  const { surface, scope, client, ...adapterInput } = input;
  const pion = createNativeV2PionDiagnosticAdapter(
    { ...adapterInput, surface },
    dependencies,
  );
  const connector = new BrokerConnector(
    scope,
    client,
    input.trust,
    async () => {
      throw new Error('native_pion_diagnostic_browser_offer_forbidden');
    },
    pion.adapter,
  );
  let closeTask: Promise<void> | undefined;
  let closed = false;
  return Object.freeze({
    register(signal: AbortSignal) {
      if (closed) throw new Error('native_pion_diagnostic_lab_closed');
      return connector.register(signal);
    },
    pollNative(signal: AbortSignal) {
      if (closed) throw new Error('native_pion_diagnostic_lab_closed');
      return connector.pollNative(signal);
    },
    get activePeerCount() {
      return pion.activePeerCount;
    },
    close(signal: AbortSignal) {
      if (!closeTask) {
        closed = true;
        closeTask = (async () => {
          const withdrawal = connector.withdraw(signal);
          const retirement = pion.close();
          const results = await Promise.allSettled([withdrawal, retirement]);
          const errors = results.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : [],
          );
          if (errors.length)
            throw new AggregateError(
              errors,
              'native_pion_diagnostic_lab_close_failed',
            );
        })();
      }
      return closeTask;
    },
  });
}

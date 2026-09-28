import { describe, expectTypeOf, it } from 'vitest';
import type {
  PluginManifest,
  PluginOperationalEventObserver,
  PluginOperationalEventSubscriptionEntry,
} from '../index.js';

// A compile-time contract: `typecheck:sdk` fails if the SDK barrel stops
// exporting these types or their shapes stop accepting this declaration.
describe('plugin operational event subscription public contract', () => {
  it('re-exports a source-compatible manifest declaration and observer', () => {
    const subscription: PluginOperationalEventSubscriptionEntry = {
      id: 'runtime-ready',
      version: '1.0.0',
      eventTypes: ['station.runtime.lifecycle/v1'],
      projection: 'metadata',
    };
    const manifest: PluginManifest = {
      name: 'example-plugin',
      version: '1.0.0',
      serverModule: 'server.mjs',
      operationalEventSubscriptions: [subscription],
    };
    const observer: PluginOperationalEventObserver = {
      observe: async ({ projection }) =>
        projection.kind === 'metadata'
          ? { kind: 'accepted' }
          : { kind: 'rejected', failureCode: 'metadata_required' },
    };
    const input: Parameters<PluginOperationalEventObserver['observe']>[0] = {
      subscriptionId: subscription.id,
      projection: {
        kind: 'metadata',
        event: {
          schemaVersion: 'station.operational-event/v1',
          id: 'event-1',
          type: 'station.runtime.lifecycle/v1',
          producer: { id: 'station-server', version: '1' },
          occurredAt: '2026-08-17T00:00:00.000Z',
          scopes: [],
          privacy: 'private',
          delivery: 'durable',
        },
      },
      idempotencyKey: 'key',
      attempt: 1,
      signal: new AbortController().signal,
    };

    expectTypeOf(manifest.operationalEventSubscriptions).toEqualTypeOf<
      PluginOperationalEventSubscriptionEntry[] | undefined
    >();
    expectTypeOf(observer.observe).parameter(0).toEqualTypeOf(input);
  });
});

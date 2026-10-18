import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@kontourai/station-contracts/config';
import type {
  PluginDailyPing,
  PluginTelemetryEvent,
  PublisherTelemetryDeclaration,
} from '@kontourai/station-contracts/plugin-telemetry';
import {
  PRODUCT_TELEMETRY_ACKNOWLEDGEMENT_PROTOCOL,
  type TelemetryFeedback,
  type TelemetryLiteNoticeReceipt,
  type TelemetryOutboxEntry,
  type TelemetryPublisherId,
} from '@kontourai/station-contracts/product-telemetry';
import {
  PLUGIN_TELEMETRY_DATA_REVISION,
  parsePluginDailyPing,
  parsePluginTelemetryCount,
  pluginTelemetryInventoryRevision,
  pluginTelemetryPropertyValues,
} from '@kontourai/station-shared/plugin-telemetry';
import { resolveTelemetryConfiguration } from '../domain/telemetry-configuration.js';
import { writeUserNotice } from '../utils/logger.js';
import { persistedRandomIdentifierHash } from './persisted-random-identifier.js';
import {
  assertPluginTelemetryAdmission,
  type PluginTelemetryCatalogOptions,
  pluginTelemetryBindings,
} from './plugins/plugin-telemetry-admission.js';
import { TelemetryLocalState } from './telemetry-local-state.js';
import { abortableTelemetryOperation } from './telemetry-response.js';

type Binding = Awaited<ReturnType<typeof pluginTelemetryBindings>>[number];
type Counts = Record<
  string,
  { count: number; properties: Record<string, Record<string, number>> }
>;
interface PublisherState {
  revision: string;
  generation: string;
  day: string;
  counts: Counts;
  previous?: { day: string; counts: Counts };
  attempted?: string;
  reported?: string;
  notice?: TelemetryLiteNoticeReceipt;
  acknowledgement?: {
    publisher: TelemetryPublisherId;
    destination: string;
    inventoryRevision: string;
    acknowledgedAt: string;
  };
  feedbackDay?: string;
  lowering?: { at: string; feedbackSent: boolean };
  retired?: boolean;
}
const bucket = (count: number): '0' | '1' | '2-3' | '4+' =>
  count === 0 ? '0' : count === 1 ? '1' : count <= 3 ? '2-3' : '4+';
const publisherId = (binding: Binding): TelemetryPublisherId =>
  `publisher:${binding.declaration.publisher}`;
function currentNotice(binding: Binding, state: PublisherState): boolean {
  return (
    state.notice?.publisher === publisherId(binding) &&
    state.notice.inventoryRevision === state.revision
  );
}
function acknowledged(binding: Binding, state: PublisherState): boolean {
  return (
    state.acknowledgement?.publisher === publisherId(binding) &&
    state.acknowledgement.destination === binding.declaration.endpoint &&
    state.acknowledgement.inventoryRevision ===
      pluginTelemetryInventoryRevision(binding.declaration, 'full')
  );
}
function empty(declaration: PublisherTelemetryDeclaration): Counts {
  return Object.fromEntries(
    Object.entries(declaration.events).map(([name, event]) => [
      name,
      {
        count: 0,
        properties: Object.fromEntries(
          Object.entries(event.properties).map(([key, domain]) => [
            key,
            Object.fromEntries(
              pluginTelemetryPropertyValues(domain).map((value) => [value, 0]),
            ),
          ]),
        ),
      },
    ]),
  );
}
/** Withdrawal persists before removal, invalidating both queued snapshots and receipts. */
export async function retirePluginTelemetry(
  homeDir: string,
  publisher: TelemetryPublisherId,
): Promise<void> {
  await new TelemetryLocalState(homeDir).publisherDaily<PublisherState>(
    publisher,
    (state) =>
      state
        ? {
            ...state,
            retired: true,
            counts: {},
            previous: undefined,
            notice: undefined,
            acknowledgement: undefined,
          }
        : null,
  );
}
export class PluginTelemetryService {
  private readonly local: TelemetryLocalState;
  private stopped = false;
  private readonly requests = new Map<AbortController, TelemetryPublisherId>();
  constructor(
    private readonly options: {
      homeDir: string;
      catalog: PluginTelemetryCatalogOptions;
      config: () => AppConfig;
      env: NodeJS.ProcessEnv;
      fetch: typeof globalThis.fetch;
    },
  ) {
    this.local = new TelemetryLocalState(options.homeDir);
  }
  stop() {
    this.stopped = true;
    for (const request of this.requests.keys()) request.abort();
  }
  reconfigure(previous: AppConfig) {
    const current = this.options.config();
    const dnt =
      resolveTelemetryConfiguration(current, this.options.env).publishers
        .operator.reason === 'DNT';
    const registryChanged =
      JSON.stringify(previous.publicTelemetryRegistries) !==
      JSON.stringify(current.publicTelemetryRegistries);
    for (const [request, publisher] of this.requests) {
      if (
        dnt ||
        registryChanged ||
        previous.telemetryTier?.[publisher] !==
          current.telemetryTier?.[publisher] ||
        previous.telemetryPublisherPolicy?.[publisher] !==
          current.telemetryPublisherPolicy?.[publisher]
      )
        request.abort();
    }
  }
  withdraw(publisher: TelemetryPublisherId) {
    for (const [request, owner] of this.requests)
      if (owner === publisher) request.abort();
  }
  get configured(): boolean {
    return !!this.options.config().publicTelemetryRegistries?.length;
  }
  private bindings() {
    if (!this.configured) return Promise.resolve([]);
    return pluginTelemetryBindings(this.options.catalog, this.options.config());
  }
  private async binding(publisher: TelemetryPublisherId) {
    const binding = (await this.bindings()).find(
      (row) => publisherId(row) === publisher,
    );
    if (!binding)
      throw new Error('Telemetry publisher is not installed or verified');
    return binding;
  }
  private state(binding: Binding, change?: (state: PublisherState) => void) {
    const revision = pluginTelemetryInventoryRevision(
      binding.declaration,
      'lite',
    );
    const day = new Date().toISOString().slice(0, 10);
    return this.local.publisherDaily<PublisherState>(
      publisherId(binding),
      (prior) => {
        if (!binding.isSelected())
          throw new Error('Plugin installation changed');
        let state = prior;
        if (
          !state ||
          state.revision !== revision ||
          (state.retired && state.generation !== binding.generation)
        )
          state = {
            revision,
            generation: binding.generation,
            day,
            counts: empty(binding.declaration),
            attempted: prior?.attempted,
            reported: prior?.reported,
            feedbackDay: prior?.feedbackDay,
          };
        else if (state.generation !== binding.generation)
          state = { ...state, generation: binding.generation };
        if (state.day !== day)
          state = {
            ...state,
            day,
            counts: empty(binding.declaration),
            previous: { day: state.day, counts: state.counts },
          };
        if (!state.retired) change?.(state);
        return state;
      },
    );
  }
  private resolution(binding: Binding, state: PublisherState) {
    const id = publisherId(binding);
    return resolveTelemetryConfiguration(
      this.options.config(),
      this.options.env,
      {
        [id]: acknowledged(binding, state),
      },
      {},
      [id],
    ).publishers[id];
  }
  async status() {
    const rows = await Promise.all(
      (await this.bindings()).map(async (binding) => {
        const state = (await this.state(binding))!;
        return [
          publisherId(binding),
          {
            ...this.resolution(binding, state),
            destination: binding.declaration.endpoint,
            endpointConfigured: true,
            liteInventoryRevision: state.revision,
            liteInventory: binding.declaration.events,
            fullInventoryRevision: pluginTelemetryInventoryRevision(
              binding.declaration,
              'full',
            ),
            liteNoticeShown: currentNotice(binding, state),
          },
        ] as const;
      }),
    );
    return Object.fromEntries(rows);
  }
  async disclosure(publisher: TelemetryPublisherId) {
    const binding = await this.binding(publisher);
    const state = (await this.state(binding))!;
    const resolution = this.resolution(binding, state);
    return {
      publisher,
      destination: binding.declaration.endpoint,
      endpointConfigured: true,
      acknowledged: acknowledged(binding, state),
      inventoryRevision: pluginTelemetryInventoryRevision(
        binding.declaration,
        'full',
      ),
      acknowledgementProtocol: PRODUCT_TELEMETRY_ACKNOWLEDGEMENT_PROTOCOL,
      events: Object.fromEntries(
        Object.entries(binding.declaration.events).map(([name, event]) => [
          name,
          {
            description: 'Publisher-declared count',
            properties: Object.fromEntries(
              Object.entries(event.properties).map(([key, domain]) => [
                key,
                { domain: pluginTelemetryPropertyValues(domain) },
              ]),
            ),
          },
        ]),
      ),
      envelope:
        'Full plugin_event v1: random event_id, data_revision, inventory_revision, publisher, declared name and enum/bucket properties, server timestamp, and a per-publisher monthly pseudonymous distinct_id. Lite plugin_daily v1: only bucketed previous-day event/property marginal counts and a random event_id; no installation ID or raw day. Direct HTTPS exposes network metadata to the receiver.',
      telemetryEnabled: resolution.tier === 'full',
      enabledSource: resolution.source,
      publishers: {
        ...resolveTelemetryConfiguration(
          this.options.config(),
          this.options.env,
        ).publishers,
        ...(await this.status()),
      },
    };
  }
  async acknowledge(
    publisher: TelemetryPublisherId,
    revision: string,
    destination?: string,
  ) {
    const binding = await this.binding(publisher);
    const state = (await this.state(binding))!;
    if (
      this.resolution(binding, state).reason === 'DNT' ||
      revision !==
        pluginTelemetryInventoryRevision(binding.declaration, 'full') ||
      destination !== binding.declaration.endpoint
    )
      throw new Error(
        'Telemetry disclosure or destination changed; review after DO_NOT_TRACK is removed',
      );
    if (!(await binding.isCurrent())) throw new Error('Plugin changed');
    await this.state(binding, (next) => {
      next.acknowledgement = {
        publisher: publisherId(binding),
        destination: binding.declaration.endpoint,
        inventoryRevision: revision,
        acknowledgedAt: new Date().toISOString(),
      };
    });
  }
  async notice(headless: boolean) {
    for (const binding of await this.bindings()) {
      await this.state(binding, (state) => {
        if (!headless || currentNotice(binding, state)) return;
        writeUserNotice(
          `${publisherId(binding)} telemetry: Lite sends one identifier-free daily ping with bucketed declared event/property counts to ${binding.declaration.endpoint}. Turn off: station telemetry set ${publisherId(binding)} off. Inventory: ${state.revision}`,
        );
        state.notice = {
          publisher: publisherId(binding),
          inventoryRevision: state.revision,
          shownAt: new Date().toISOString(),
        };
      });
    }
  }
  async recordNotice(publisher: TelemetryPublisherId, revision: string) {
    const binding = await this.binding(publisher);
    if (
      revision !== pluginTelemetryInventoryRevision(binding.declaration, 'lite')
    )
      throw new Error('Telemetry notice changed');
    await this.state(binding, (state) => {
      state.notice = {
        publisher,
        inventoryRevision: revision,
        shownAt: new Date().toISOString(),
      };
    });
  }
  async count(
    plugin: string,
    events: Array<{
      event: string;
      attributes: Record<string, string | number>;
    }>,
  ) {
    if (this.stopped) throw new Error('Telemetry stopped');
    const binding = (await this.bindings()).find(
      (row) => row.plugin === plugin,
    );
    if (!binding)
      throw new Error('Plugin has no verified telemetry declaration');
    // Validate the entire batch before admitting any of it. Caller timestamps and plugin IDs are never forwarded.
    const parsed = events.map((event) =>
      parsePluginTelemetryCount(
        binding.declaration,
        event.event,
        event.attributes,
      ),
    );
    if (!(await binding.isCurrent())) throw new Error('Plugin changed');
    let state = (await this.state(binding))!;
    if (state.retired) throw new Error('Publisher retired');
    const resolution = this.resolution(binding, state);
    if (resolution.tier === 'off') {
      await this.local.record({
        publisher: publisherId(binding),
        tier: 'lite',
        recordedAt: new Date().toISOString(),
        outcome: 'dropped',
        reason: resolution.reason === 'DNT' ? 'DNT' : 'off',
        payload: { event: 'telemetry_dropped', count: parsed.length },
      });
      return;
    }
    state = (await this.state(binding, (next) => {
      for (const event of parsed) {
        const counts = next.counts[event.name];
        counts.count = Math.min(65535, counts.count + 1);
        for (const [key, value] of Object.entries(event.properties))
          counts.properties[key][value] = Math.min(
            65535,
            counts.properties[key][value] + 1,
          );
      }
    }))!;
    if (resolution.tier !== 'full') return;
    const distinct_id = await persistedRandomIdentifierHash(
      this.options.homeDir,
      'usage-telemetry-id',
      undefined,
      { month: new Date(), publisherId: publisherId(binding) },
    );
    for (const event of parsed) {
      const payload: PluginTelemetryEvent = {
        event: 'plugin_event',
        schema_version: 1,
        data_revision: PLUGIN_TELEMETRY_DATA_REVISION,
        inventory_revision: pluginTelemetryInventoryRevision(
          binding.declaration,
          'full',
        ),
        event_id: randomUUID(),
        publisher: publisherId(binding),
        name: event.name,
        properties: event.properties,
        distinct_id,
        timestamp: new Date().toISOString(),
      };
      await this.send(binding, payload, 'full', state);
    }
  }
  async flushDaily() {
    if (this.stopped) return;
    await this.notice(this.options.env.STATION_STDOUT_HANDSHAKE !== '1');
    for (const binding of await this.bindings()) {
      let payload: PluginDailyPing | undefined;
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000)
        .toISOString()
        .slice(0, 10);
      const state = await this.state(binding, (state) => {
        if (
          !state.previous ||
          state.previous.day !== yesterday ||
          state.attempted === today ||
          state.reported === yesterday
        )
          return;
        state.attempted = today;
        state.reported = yesterday;
        payload = parsePluginDailyPing(
          {
            event: 'plugin_daily',
            schema_version: 1,
            data_revision: PLUGIN_TELEMETRY_DATA_REVISION,
            inventory_revision: state.revision,
            event_id: randomUUID(),
            publisher: publisherId(binding),
            events: Object.fromEntries(
              Object.entries(state.previous.counts).map(([name, event]) => [
                name,
                {
                  count: bucket(event.count),
                  properties: Object.fromEntries(
                    Object.entries(event.properties).map(([key, values]) => [
                      key,
                      Object.fromEntries(
                        Object.entries(values).map(([value, count]) => [
                          value,
                          bucket(count),
                        ]),
                      ),
                    ]),
                  ),
                },
              ]),
            ),
          },
          binding.declaration,
        );
      });
      if (payload && state) await this.send(binding, payload, 'lite', state);
    }
  }
  async tierLowered(
    publisher: TelemetryPublisherId,
    reason?: TelemetryFeedback['reason'],
    action: TelemetryFeedback['action'] = 'tier-lowered',
  ) {
    const binding = await this.binding(publisher);
    let allowed = false;
    const state = (await this.state(binding, (state) => {
      if (this.resolution(binding, state).reason === 'DNT') return;
      const day = new Date().toISOString().slice(0, 10);
      allowed = !!reason && reason !== 'skip' && state.feedbackDay !== day;
      if (allowed) state.feedbackDay = day;
      state.lowering = { at: new Date().toISOString(), feedbackSent: allowed };
    }))!;
    if (allowed && reason)
      await this.send(binding, { publisher, action, reason }, 'lite', state);
  }
  async feedback(payload: TelemetryFeedback) {
    if (payload.action !== 'tier-lowered') return false;
    const binding = (await this.bindings()).find(
      (row) => publisherId(row) === payload.publisher,
    );
    if (!binding) return false;
    let allowed = false;
    const state = (await this.state(binding, (state) => {
      const elapsed = state.lowering
        ? Date.now() - Date.parse(state.lowering.at)
        : -1;
      const today = new Date().toISOString().slice(0, 10);
      if (
        this.resolution(binding, state).reason !== 'DNT' &&
        state.lowering &&
        !state.lowering.feedbackSent &&
        elapsed >= 0 &&
        elapsed <= 600000 &&
        state.feedbackDay !== today
      ) {
        allowed = true;
        if (payload.reason !== 'skip') {
          state.lowering.feedbackSent = true;
          state.feedbackDay = today;
        }
      }
    }))!;
    if (allowed && payload.reason !== 'skip')
      await this.send(binding, payload, 'lite', state);
    return allowed;
  }
  private async send(
    binding: Binding,
    payload: PluginDailyPing | PluginTelemetryEvent | TelemetryFeedback,
    tier: 'lite' | 'full',
    snapshot: PublisherState,
  ) {
    let outcome: TelemetryOutboxEntry['outcome'] = 'dropped';
    let reason: TelemetryOutboxEntry['reason'] = 'expired';
    const artifactCurrent = await binding.isCurrent();
    const state = await this.local.publisherDaily<PublisherState>(
      publisherId(binding),
      (state) => state,
    );
    let eligible = true;
    try {
      assertPluginTelemetryAdmission(
        binding.declaration,
        binding.receipt,
        this.options.config().publicTelemetryRegistries,
      );
    } catch {
      eligible = false;
    }
    if (
      eligible &&
      !this.stopped &&
      state &&
      !state.retired &&
      state.revision === snapshot.revision &&
      artifactCurrent &&
      binding.isSelected()
    ) {
      const resolution = this.resolution(binding, state);
      reason =
        resolution.reason === 'DNT'
          ? 'DNT'
          : resolution.tier === 'off' && !('action' in payload)
            ? 'off'
            : tier === 'full' && resolution.tier !== 'full'
              ? 'disclosure'
              : tier === 'lite' &&
                  !('action' in payload) &&
                  !currentNotice(binding, state)
                ? 'notice'
                : 'transport';
      if (reason === 'transport') {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1000);
        this.requests.set(controller, publisherId(binding));
        try {
          const response = await abortableTelemetryOperation(
            this.options.fetch(binding.declaration.endpoint, {
              method: 'POST',
              redirect: 'error',
              signal: controller.signal,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            }),
            controller.signal,
          );
          if (response.ok) {
            outcome = 'sent';
            reason = 'acknowledged';
          }
          await abortableTelemetryOperation(
            Promise.resolve(response.body?.cancel()),
            controller.signal,
          );
        } catch {
          /* Bounded optional delivery; no retry, credentials or error text. */
        } finally {
          clearTimeout(timer);
          this.requests.delete(controller);
        }
      }
    }
    await this.local.record({
      publisher: publisherId(binding),
      tier,
      recordedAt: new Date().toISOString(),
      outcome,
      reason,
      payload,
    });
  }
}

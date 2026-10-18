import { randomBytes, randomUUID } from 'node:crypto';
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
  pluginTelemetryPublisherId,
} from '@kontourai/station-shared/plugin-telemetry';
import { resolvePublicAddress } from '@kontourai/station-shared/public-network';
import { resolveTelemetryConfiguration } from '../domain/telemetry-configuration.js';
import { writeUserNotice } from '../utils/logger.js';
import { persistedRandomIdentifierHash } from './persisted-random-identifier.js';
import { sendPluginTelemetry } from './plugin-telemetry-transport.js';
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
  requests?: number;
  fullEvents?: number;
  full?: PluginTelemetryEvent[];
}
const bucket = (count: number): '0' | '1' | '2-3' | '4+' =>
  count === 0 ? '0' : count === 1 ? '1' : count <= 3 ? '2-3' : '4+';
const publisherId = (binding: Binding): TelemetryPublisherId =>
  pluginTelemetryPublisherId(
    binding.receipt.registryKeyDigest,
    binding.declaration.publisher,
  );
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
            full: undefined,
            notice: undefined,
            acknowledgement: undefined,
          }
        : null,
  );
}
export class PluginTelemetryService {
  private readonly local: TelemetryLocalState;
  private stopped = false;
  private readonly withdrawn = new Set<TelemetryPublisherId>();
  private readonly capabilities = new Map<
    string,
    {
      plugin: string;
      publisher: TelemetryPublisherId;
      revision: string;
      generation: string;
      expires: number;
    }
  >();
  private readonly requests = new Map<AbortController, TelemetryPublisherId>();
  constructor(
    private readonly options: {
      homeDir: string;
      catalog: PluginTelemetryCatalogOptions;
      config: () => AppConfig;
      env: NodeJS.ProcessEnv;
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
    this.withdrawn.add(publisher);
    for (const [token, claim] of this.capabilities)
      if (claim.publisher === publisher) this.capabilities.delete(token);
    for (const [request, owner] of this.requests)
      if (owner === publisher) request.abort();
  }
  async mountPane(plugin: string) {
    const binding = (await this.bindings()).find(
      (row) => row.plugin === plugin,
    );
    if (!binding || this.stopped) throw new Error('Publisher unavailable');
    const state = await this.state(binding);
    if (!state || state.retired || this.withdrawn.has(publisherId(binding)))
      throw new Error('Publisher retired');
    for (const [token, claim] of this.capabilities)
      if (claim.expires <= Date.now()) this.capabilities.delete(token);
    if (this.capabilities.size >= 1024)
      throw new Error('Too many mounted panes');
    const token = randomBytes(32).toString('base64url');
    this.capabilities.set(token, {
      plugin,
      publisher: publisherId(binding),
      revision: state.revision,
      generation: binding.generation,
      expires: Date.now() + 300000,
    });
    return {
      token,
      publisher: publisherId(binding),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    };
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
        ) {
          if (prior?.retired && prior.generation !== binding.generation)
            this.withdrawn.delete(publisherId(binding));
          state = {
            revision,
            generation: binding.generation,
            day,
            counts: empty(binding.declaration),
            attempted: prior?.attempted,
            reported: prior?.reported,
            feedbackDay: prior?.feedbackDay,
          };
        } else if (state.generation !== binding.generation)
          state = { ...state, generation: binding.generation };
        if (state.day !== day)
          state = {
            ...state,
            day,
            counts: empty(binding.declaration),
            previous: { day: state.day, counts: state.counts },
            requests: 0,
            fullEvents: 0,
            full: [],
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
        'Full plugin_event v1: random event_id, data_revision, inventory_revision, publisher, declared name and enum/bucket properties, server timestamp, and a per-publisher monthly pseudonymous distinct_id. Lite plugin_daily v1: only bucketed previous-day event/property marginal counts and a random event_id; Station adds no installation ID or raw day, but plugin-chosen counts can encode a stable identifier. Plugin publishers default Off and require opt-in. Direct HTTPS exposes network metadata to the receiver.',
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
          `${publisherId(binding)} telemetry is Off until you choose Lite or Full. Lite sends plugin-chosen bucketed counts that can encode identifiers to ${binding.declaration.endpoint}. Choose Lite/Full or keep Off: station telemetry set ${publisherId(binding)} <off|lite|full>. Inventory: ${state.revision}`,
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
    capability: string,
    events: Array<{
      event: string;
      attributes: Record<string, string | number>;
    }>,
  ) {
    if (this.stopped) throw new Error('Telemetry stopped');
    const claim = this.capabilities.get(capability);
    if (!claim || claim.expires <= Date.now())
      throw new Error('Pane capability expired');
    const binding = (await this.bindings()).find(
      (row) =>
        row.plugin === claim.plugin &&
        publisherId(row) === claim.publisher &&
        row.generation === claim.generation &&
        pluginTelemetryInventoryRevision(row.declaration, 'lite') ===
          claim.revision,
    );
    if (!binding) throw new Error('Pane capability no longer current');
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
    if (state.retired || this.withdrawn.has(publisherId(binding)))
      throw new Error('Publisher retired');
    let admitted = false;
    state = (await this.state(binding, (next) => {
      if ((next.requests ?? 0) < 100) {
        next.requests = (next.requests ?? 0) + 1;
        admitted = true;
      }
    }))!;
    if (!admitted) {
      await this.drop(binding, 'overflow', parsed.length);
      return;
    }
    const resolution = this.resolution(binding, state);
    if (resolution.tier === 'off') {
      await this.drop(
        binding,
        resolution.reason === 'DNT' ? 'DNT' : 'off',
        parsed.length,
      );
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
    const payloads: PluginTelemetryEvent[] = parsed.map((event) => ({
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
    }));
    let dropped = 0;
    await this.state(binding, (next) => {
      const available = Math.max(0, 100 - (next.fullEvents ?? 0));
      const accepted = payloads.slice(0, available);
      next.fullEvents = (next.fullEvents ?? 0) + accepted.length;
      next.full ??= [];
      next.full.push(...accepted);
      dropped = payloads.length - accepted.length;
    });
    if (dropped) await this.drop(binding, 'overflow', dropped);
  }

  private async drop(
    binding: Binding,
    reason: TelemetryOutboxEntry['reason'],
    count: number,
  ) {
    await this.local.record({
      publisher: publisherId(binding),
      tier: 'lite',
      recordedAt: new Date().toISOString(),
      outcome: 'dropped',
      reason,
      payload: { event: 'telemetry_dropped', count },
    });
  }
  async flushFull() {
    for (const binding of await this.bindings()) {
      let events: PluginTelemetryEvent[] = [];
      const state = await this.state(binding, (next) => {
        events = next.full ?? [];
        next.full = [];
      });
      if (events.length && state)
        await this.send(
          binding,
          { event: 'plugin_events', events },
          'full',
          state,
        );
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
          publisherId(binding),
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
      if (this.resolution(binding, state).tier === 'off') return;
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
        this.resolution(binding, state).tier !== 'off' &&
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
    payload:
      | PluginDailyPing
      | { event: 'plugin_events'; events: PluginTelemetryEvent[] }
      | TelemetryFeedback,
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
          : resolution.tier === 'off'
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
        try {
          const selected = await abortableTelemetryOperation(
            resolvePublicAddress(
              new URL(binding.declaration.endpoint).hostname,
            ),
            controller.signal,
          );
          this.requests.set(controller, publisherId(binding));
          assertPluginTelemetryAdmission(
            binding.declaration,
            binding.receipt,
            this.options.config().publicTelemetryRegistries,
          );
          const finalResolution = this.resolution(binding, state);
          if (finalResolution.tier === 'off') {
            reason = finalResolution.reason === 'DNT' ? 'DNT' : 'off';
            throw new Error('Publisher disabled');
          }
          if (tier === 'full' && finalResolution.tier !== 'full') {
            reason = 'disclosure';
            throw new Error('Full withdrawn');
          }
          // Withdrawal may happen before controller registration during DNS/admission.
          if (
            (this.withdrawn.has(publisherId(binding)) &&
              !('action' in payload)) ||
            !binding.isSelected() ||
            controller.signal.aborted
          )
            throw new Error('Publisher withdrawn');
          const sent = await abortableTelemetryOperation(
            sendPluginTelemetry(
              binding.declaration.endpoint,
              JSON.stringify(payload),
              selected,
              controller.signal,
            ),
            controller.signal,
          );
          if (sent) {
            outcome = 'sent';
            reason = 'acknowledged';
          }
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
      payload:
        outcome === 'dropped'
          ? {
              event: 'telemetry_dropped',
              count:
                'events' in payload && Array.isArray(payload.events)
                  ? payload.events.length
                  : 1,
            }
          : payload,
    });
  }
}

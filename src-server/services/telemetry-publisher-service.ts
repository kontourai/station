import { randomUUID } from 'node:crypto';
import type {
  ProductTelemetryBuild,
  StationDailyPing,
  TelemetryFeedback,
  TelemetryOutboxEntry,
  UsageTelemetryEvent,
  UsageTelemetryProperties,
} from '@kontourai/station-contracts/product-telemetry';
import {
  LITE_TELEMETRY_INVENTORY_REVISION,
  liteTelemetryNoticeText,
  mapRuntimeChannelToTelemetryChannel,
  mapRuntimeVersionToTelemetryVersion,
  parseStationDailyPing,
} from '@kontourai/station-shared/product-telemetry';
import type { ResolvedTelemetryConfiguration } from '../domain/telemetry-configuration.js';
import { writeUserNotice } from '../utils/logger.js';
import {
  type TelemetryDailyState,
  TelemetryLocalState,
} from './telemetry-local-state.js';
import { abortableTelemetryOperation } from './telemetry-response.js';

type Publisher = 'kontour' | 'operator';
interface PublisherOptions {
  homeDir: string;
  build: ProductTelemetryBuild;
  channel?: string;
  configuration: () => ResolvedTelemetryConfiguration;
  operatorEndpoint: () => string | undefined;
  facts?: () => Promise<
    Pick<
      StationDailyPing,
      | 'paired_devices_bucket'
      | 'private_plugins_bucket'
      | 'layouts_customized'
      | 'home_replaced'
      | 'branding_overridden'
    >
  >;
  fetch: typeof globalThis.fetch;
}
const PUBLISHERS = ['kontour', 'operator'] as const;
function utcWeek(date: Date): string {
  const monday = new Date(date);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}
function age(
  first: string,
  day: string,
): StationDailyPing['install_age_bucket'] {
  const days = Math.max(0, (Date.parse(day) - Date.parse(first)) / 86_400_000);
  return days === 0
    ? '0d'
    : days <= 7
      ? '1-7d'
      : days <= 30
        ? '8-30d'
        : days <= 90
          ? '31-90d'
          : '91d+';
}
function bucket(count: number): '0' | '1' | '2-3' | '4+' {
  return count === 0 ? '0' : count === 1 ? '1' : count <= 3 ? '2-3' : '4+';
}

/** Identifier-free daily sender. Full operator batching retains its existing receipt protocol. */
export class TelemetryPublisherService {
  readonly local: TelemetryLocalState;
  private readonly epochs: Record<Publisher, number> = {
    kontour: 0,
    operator: 0,
  };
  private readonly requests = new Map<AbortController, Publisher>();
  private stopped = false;
  private readonly shownNotices = new Set<Publisher>();
  constructor(private readonly options: PublisherOptions) {
    this.local = new TelemetryLocalState(options.homeDir);
  }
  private endpoint(publisher: Publisher) {
    return publisher === 'kontour'
      ? this.options.configuration().authorEndpoint
      : this.options.operatorEndpoint();
  }
  reconfigure(publisher?: Publisher): void {
    for (const name of PUBLISHERS)
      if (!publisher || publisher === name) this.epochs[name]++;
    // Already dispatched bodies cannot be withdrawn; retain their bounded delivery result.
  }
  stop(): void {
    this.stopped = true;
    this.reconfigure();
    for (const request of this.requests.keys()) request.abort();
  }
  canSendDaily(): boolean {
    return PUBLISHERS.some(
      (publisher) =>
        this.shownNotices.has(publisher) &&
        !!this.endpoint(publisher) &&
        this.options.configuration().publishers[publisher].tier !== 'off',
    );
  }
  private seed(now: Date, prior?: TelemetryDailyState): TelemetryDailyState {
    const channel =
      mapRuntimeChannelToTelemetryChannel(this.options.channel) ?? 'unknown';
    const day = now.toISOString().slice(0, 10);
    const week = utcWeek(now);
    const month = day.slice(0, 7);
    return {
      firstRun: prior?.firstRun ?? day,
      lastActiveDay: day,
      lastActiveWeek: week,
      lastActiveMonth: month,
      day,
      attempted: prior?.attempted ?? {},
      reported: prior?.reported ?? {},
      ...(prior && prior.day < day
        ? { previous: { day: prior.day, ping: prior.ping } }
        : {}),
      lowerings: prior?.lowerings ?? {},
      feedbackDays: prior?.feedbackDays ?? {},
      engineFailures: {},
      notices: prior?.notices ?? {},
      ping: {
        event: 'station_daily',
        event_id: randomUUID(),
        version: this.options.build.version,
        channel,
        platform: process.platform,
        arch: process.arch,
        surfaces_today: [],
        engines_used_today: [],
        first_active_this_week: prior?.lastActiveWeek !== week,
        first_active_this_month: prior?.lastActiveMonth !== month,
        install_age_bucket: age(prior?.firstRun ?? day, day),
        paired_devices_bucket: '0',
        distribution: 'unknown',
        public_plugins_enabled: [],
        private_plugins_bucket: '0',
        branding_overridden: false,
        home_replaced: false,
        layouts_customized: 'unknown',
        setup_abandoned_step: 'none',
        engine_connect_failures: [],
        safe_mode_entered: 0,
        plugin_disabled_after_crash: 0,
      },
    };
  }
  private async update(
    update?: (ping: TelemetryDailyState['ping']) => void,
  ): Promise<void> {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    await this.local.daily((prior) => {
      const state =
        !prior || prior.day !== today
          ? this.seed(now, prior ?? undefined)
          : prior;
      update?.(state.ping);
      return state;
    });
  }
  async notice(headless: boolean): Promise<void> {
    const facts = await this.options.facts?.();
    await this.update((ping) => {
      if (facts) Object.assign(ping, facts);
    });
    await this.local.daily((state) => {
      if (!state) throw new Error('Telemetry daily state is unavailable');
      const outstanding = PUBLISHERS.filter(
        (publisher) =>
          state.notices[publisher]?.inventoryRevision !==
          LITE_TELEMETRY_INVENTORY_REVISION,
      );
      if (headless && outstanding.length)
        writeUserNotice(liteTelemetryNoticeText());
      for (const publisher of PUBLISHERS) {
        if (
          state.notices[publisher]?.inventoryRevision ===
          LITE_TELEMETRY_INVENTORY_REVISION
        ) {
          this.shownNotices.add(publisher);
          continue;
        }
        if (!headless) continue;
        this.shownNotices.add(publisher);
        state.notices[publisher] = {
          publisher,
          inventoryRevision: LITE_TELEMETRY_INVENTORY_REVISION,
          shownAt: new Date().toISOString(),
        };
      }
      return state;
    });
  }
  async recordNotice(
    publisher: Publisher,
    inventoryRevision: string,
  ): Promise<void> {
    if (inventoryRevision !== LITE_TELEMETRY_INVENTORY_REVISION)
      throw new Error('Telemetry notice changed');
    await this.update();
    await this.local.daily((state) => {
      if (!state) throw new Error('Telemetry daily state is unavailable');
      state.notices[publisher] = {
        publisher,
        inventoryRevision,
        shownAt: new Date().toISOString(),
      };
      return state;
    });
    this.shownNotices.add(publisher);
  }
  async observe<E extends UsageTelemetryEvent>(
    event: E,
    properties: UsageTelemetryProperties<E>,
  ): Promise<void> {
    // Unrelated Full observations do not mutate the daily accumulator.
    if (
      ![
        'engine_turn',
        'client_connected',
        'setup_abandoned',
        'safe_mode_entered',
        'plugin_disabled_after_crash',
        'engine_connect_failed',
      ].includes(event)
    )
      return;
    // Only fields already validated against the Full inventory reach this projection.
    await this.update((ping) => {
      if (
        event === 'engine_turn' &&
        'engine' in properties &&
        !ping.engines_used_today.includes(
          properties.engine as StationDailyPing['engines_used_today'][number],
        )
      )
        ping.engines_used_today.push(
          properties.engine as StationDailyPing['engines_used_today'][number],
        );
      if (
        event === 'client_connected' &&
        'surface' in properties &&
        !ping.surfaces_today.includes(
          properties.surface as StationDailyPing['surfaces_today'][number],
        )
      )
        ping.surfaces_today.push(
          properties.surface as StationDailyPing['surfaces_today'][number],
        );
      if (event === 'setup_abandoned' && 'step' in properties)
        ping.setup_abandoned_step =
          properties.step as StationDailyPing['setup_abandoned_step'];
      if (event === 'safe_mode_entered')
        ping.safe_mode_entered = Math.min(65535, ping.safe_mode_entered + 1);
      if (event === 'plugin_disabled_after_crash')
        ping.plugin_disabled_after_crash = Math.min(
          65535,
          ping.plugin_disabled_after_crash + 1,
        );
    });
    if (event === 'engine_connect_failed' && 'engine' in properties) {
      await this.local.daily((state) => {
        if (!state) throw new Error('Telemetry daily state is unavailable');
        const ping = state.ping;
        const engine =
          properties.engine as StationDailyPing['engines_used_today'][number];
        const entry = ping.engine_connect_failures.find(
          (row) => row.engine === engine,
        );
        const count = Math.min(65535, (state.engineFailures[engine] ?? 0) + 1);
        state.engineFailures[engine] = count;
        if (entry) entry.bucket = bucket(count);
        else
          ping.engine_connect_failures.push({ engine, bucket: bucket(count) });
        return state;
      });
    }
  }
  async flushDaily(): Promise<void> {
    if (this.stopped) return;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const facts = await this.options.facts?.();
    const jobs: Array<{
      publisher: Publisher;
      payload: StationDailyPing;
      notice: boolean;
    }> = [];
    await this.local.daily((prior) => {
      const state =
        !prior || prior.day !== today
          ? this.seed(now, prior ?? undefined)
          : prior;
      if (facts) Object.assign(state.ping, facts);
      for (const publisher of PUBLISHERS) {
        // Only yesterday is eligible, including after a long offline gap.
        const yesterday = new Date(now.getTime() - 86_400_000)
          .toISOString()
          .slice(0, 10);
        const snapshot = state.previous;
        if (!snapshot || snapshot.day !== yesterday) continue;
        // A backward clock correction must not retain a reservation in the future.
        if ((state.attempted[publisher] ?? '') > today) {
          delete state.attempted[publisher];
          delete state.reported[publisher];
        }
        if (
          state.attempted[publisher] === today ||
          state.reported[publisher] === snapshot.day
        )
          continue;
        // Reserve before I/O: concurrent processes cannot duplicate an attempt.
        state.attempted[publisher] = today;
        state.reported[publisher] = snapshot.day;
        jobs.push({
          publisher,
          payload: parseStationDailyPing(
            {
              ...snapshot.ping,
              version: mapRuntimeVersionToTelemetryVersion(
                snapshot.ping.version,
              ),
              event_id: randomUUID(),
            },
            [],
            'semver',
          ),
          notice:
            state.notices[publisher]?.inventoryRevision ===
            LITE_TELEMETRY_INVENTORY_REVISION,
        });
      }
      return state;
    });
    await Promise.all(
      jobs.map(({ publisher, payload, notice }) =>
        this.send(publisher, payload, notice),
      ),
    );
  }
  async tierLowered(
    publisher: Publisher,
    reason?: TelemetryFeedback['reason'],
  ): Promise<void> {
    if (this.options.configuration().publishers[publisher].reason === 'DNT')
      return;
    let sendReason = false;
    await this.update();
    await this.local.daily((state) => {
      if (!state) throw new Error('Telemetry daily state is unavailable');
      const today = new Date().toISOString().slice(0, 10);
      state.feedbackDays ??= {};
      sendReason =
        !!reason &&
        reason !== 'skip' &&
        state.feedbackDays[publisher] !== today;
      if (sendReason) state.feedbackDays[publisher] = today;
      state.lowerings ??= {};
      state.lowerings[publisher] = {
        at: new Date().toISOString(),
        feedbackSent: sendReason,
      };
      return state;
    });
    if (sendReason && reason)
      await this.send(
        publisher,
        { publisher, action: 'tier-lowered', reason },
        true,
      );
  }
  async feedback(payload: TelemetryFeedback): Promise<boolean> {
    if (payload.reason === 'skip') return true;
    if (payload.publisher !== 'kontour' && payload.publisher !== 'operator')
      return false;
    const publisher = payload.publisher;
    if (
      payload.action !== 'tier-lowered' ||
      this.options.configuration().publishers[publisher].reason === 'DNT'
    )
      return false;
    let allowed = false;
    await this.update();
    await this.local.daily((state) => {
      if (!state) throw new Error('Telemetry daily state is unavailable');
      const lowering = state.lowerings?.[publisher];
      const elapsed = lowering ? Date.now() - Date.parse(lowering.at) : -1;
      const today = new Date().toISOString().slice(0, 10);
      state.feedbackDays ??= {};
      if (
        lowering &&
        !lowering.feedbackSent &&
        elapsed >= 0 &&
        elapsed <= 10 * 60_000 &&
        state.feedbackDays[publisher] !== today
      ) {
        lowering.feedbackSent = true;
        state.feedbackDays[publisher] = today;
        allowed = true;
      }
      return state;
    });
    if (allowed) await this.send(publisher, payload, true);
    return allowed;
  }
  private async send(
    publisher: Publisher,
    payload: StationDailyPing | TelemetryFeedback,
    notice: boolean,
  ): Promise<void> {
    const config = this.options.configuration();
    const resolution = config.publishers[publisher];
    const endpoint = this.endpoint(publisher);
    const epoch = this.epochs[publisher];
    let reason: TelemetryOutboxEntry['reason'] =
      resolution.tier === 'off' &&
      (!('action' in payload) || resolution.reason === 'DNT')
        ? resolution.reason === 'DNT'
          ? 'DNT'
          : 'off'
        : !endpoint
          ? 'unconfigured'
          : !notice
            ? 'notice'
            : 'transport';
    let outcome: TelemetryOutboxEntry['outcome'] = 'dropped';
    if (reason === 'transport' && !this.stopped) {
      const controller = new AbortController();
      this.requests.set(controller, publisher);
      const timeout = setTimeout(() => controller.abort(), 1000);
      try {
        if (epoch !== this.epochs[publisher] || controller.signal.aborted)
          throw new Error('Telemetry configuration changed');
        // A Full source credential could identify an installation across Lite days.
        const response = await abortableTelemetryOperation(
          this.options.fetch(endpoint!, {
            method: 'POST',
            redirect: 'error',
            signal: controller.signal,
            headers: {
              'content-type': 'application/json',
            },
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
        /* Transport failures are recorded without endpoint or error text. */
      } finally {
        clearTimeout(timeout);
        this.requests.delete(controller);
      }
    }
    await this.local.record({
      publisher,
      tier: 'lite',
      recordedAt: new Date().toISOString(),
      outcome,
      reason,
      payload,
    });
  }
}

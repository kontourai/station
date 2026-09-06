import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '@kontourai/station-contracts/config';
import { redactDeep } from '@kontourai/station-shared/redaction';
import { usageTelemetryOutcomes } from '../telemetry/metrics.js';
import type { Logger } from '../utils/logger.js';
import { persistedRandomIdentifierHash } from './persisted-random-identifier.js';
import {
  assertUsageTelemetryInventoryContract,
  USAGE_TELEMETRY_EVENTS,
  USAGE_TELEMETRY_INVENTORY_REVISION,
  type UsageTelemetryEvent,
  type UsageTelemetryProperties,
} from './usage-telemetry-inventory.js';

const MAX_BUFFER = 100;
const BATCH_SIZE = 20;
const FLUSH_INTERVAL_MS = 10_000;
const MAX_SHUTDOWN_FLUSH_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 1_000;
// Optional telemetry must not consume Station's service-stop time when an
// ingestion host accepts a connection but never responds.
type BufferedEvent = {
  event: UsageTelemetryEvent;
  properties: Record<string, string>;
};

export interface UsageTelemetryServiceOptions {
  homeDir: string;
  appConfig: AppConfig;
  version: string;
  logger: Pick<Logger, 'warn'>;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}
function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (['0', 'false', 'off', 'disabled'].includes(value.trim().toLowerCase()))
    return false;
  if (['1', 'true', 'on', 'enabled'].includes(value.trim().toLowerCase()))
    return true;
  return undefined;
}
/** Server-only, dependency-free product telemetry. It never reads vendor homes. */
export class UsageTelemetryService {
  private readonly endpoint: string | undefined;
  private readonly apiKey: string | undefined;
  private enabled: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;
  private readonly disclosurePath: string;
  private readonly buffer: BufferedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> | undefined;
  private requestAbort: AbortController | undefined;
  private acceptingTracks = true;
  private readonly tracking = new Set<Promise<void>>();
  constructor(private readonly options: UsageTelemetryServiceOptions) {
    const env = options.env ?? process.env;
    this.enabled =
      options.appConfig.telemetryEnabled ??
      parseBoolean(env.STATION_TELEMETRY_ENABLED) ??
      true;
    this.endpoint = env.STATION_TELEMETRY_ENDPOINT?.trim() || undefined;
    this.apiKey = env.STATION_USAGE_TELEMETRY_KEY?.trim() || undefined;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.setIntervalImpl = options.setInterval ?? globalThis.setInterval;
    this.clearIntervalImpl = options.clearInterval ?? globalThis.clearInterval;
    this.disclosurePath = join(
      options.homeDir,
      'config',
      'usage-telemetry-disclosure.json',
    );
  }
  get active(): boolean {
    return (
      this.enabled &&
      this.endpoint !== undefined &&
      this.hasCurrentDisclosureReceipt
    );
  }
  private hasCurrentDisclosureReceipt = false;
  async loadDisclosureReceipt(): Promise<boolean> {
    try {
      const receipt = JSON.parse(
        await readFile(this.disclosurePath, 'utf8'),
      ) as unknown;
      const isCurrentReceipt = Boolean(
        receipt &&
          typeof receipt === 'object' &&
          typeof (receipt as { acknowledgedAt?: unknown }).acknowledgedAt ===
            'string' &&
          (receipt as { inventoryRevision?: unknown }).inventoryRevision ===
            USAGE_TELEMETRY_INVENTORY_REVISION,
      );
      if (!isCurrentReceipt)
        this.warn('Usage telemetry disclosure receipt is invalid.');
      this.hasCurrentDisclosureReceipt = isCurrentReceipt;
    } catch (error: any) {
      if (error?.code !== 'ENOENT')
        this.warn('Usage telemetry disclosure receipt is invalid.', error);
      this.hasCurrentDisclosureReceipt = false;
    }
    return this.hasCurrentDisclosureReceipt;
  }
  async acknowledgeDisclosure(): Promise<void> {
    const configDir = join(this.options.homeDir, 'config');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await chmod(configDir, 0o700);
    const replacement = `${this.disclosurePath}.${randomUUID()}.tmp`;
    await writeFile(
      replacement,
      `${JSON.stringify({ acknowledgedAt: new Date().toISOString(), inventoryRevision: USAGE_TELEMETRY_INVENTORY_REVISION })}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    await rename(replacement, this.disclosurePath);
    await chmod(this.disclosurePath, 0o600);
    // A changed inventory stops emission: otherwise new fields could leave before disclosure.
    await this.loadDisclosureReceipt();
  }
  /**
   * Whether THIS Station has somewhere to send events.
   *
   * Reported to the client because the first-run disclosure says "none is
   * configured here, so nothing is sent" — a claim about this host, not a
   * general reassurance. Without this field the UI would be asserting a fact
   * it cannot see: the endpoint is read from the environment at construction
   * and appears nowhere else in the API.
   */
  get endpointConfigured(): boolean {
    return this.endpoint !== undefined;
  }
  async disclosure(): Promise<{
    acknowledged: boolean;
    inventoryRevision: string;
    events: typeof USAGE_TELEMETRY_EVENTS;
    endpointConfigured: boolean;
    telemetryEnabled: boolean;
  }> {
    return {
      acknowledged: await this.loadDisclosureReceipt(),
      inventoryRevision: USAGE_TELEMETRY_INVENTORY_REVISION,
      events: USAGE_TELEMETRY_EVENTS,
      endpointConfigured: this.endpointConfigured,
      // The EFFECTIVE setting, which is `telemetryEnabled` folded over the
      // `STATION_TELEMETRY_ENABLED` fallback and the default. A client that
      // read `AppConfig.telemetryEnabled` alone would render "on" for a host
      // the environment has switched off, and offer to turn off something
      // that is already off.
      telemetryEnabled: this.enabled,
    };
  }
  get bufferedCount(): number {
    return this.buffer.length;
  }
  reconfigure(appConfig: AppConfig): void {
    const env = this.options.env ?? process.env;
    this.enabled =
      appConfig.telemetryEnabled ??
      parseBoolean(env.STATION_TELEMETRY_ENABLED) ??
      true;
    if (!this.enabled) {
      // Disabling withdraws consent for data still in memory, so discard it rather than flushing it.
      if (this.timer) this.clearIntervalImpl(this.timer);
      this.timer = undefined;
      this.buffer.length = 0;
      this.requestAbort?.abort();
    }
  }
  track<E extends UsageTelemetryEvent>(
    event: E,
    properties: UsageTelemetryProperties<E>,
  ): Promise<void> {
    if (!this.acceptingTracks) return Promise.resolve();
    const operation = this.trackAccepted(event, properties);
    this.tracking.add(operation);
    void operation.finally(() => this.tracking.delete(operation));
    return operation;
  }
  private async trackAccepted<E extends UsageTelemetryEvent>(
    event: E,
    properties: UsageTelemetryProperties<E>,
  ): Promise<void> {
    if (!this.hasCurrentDisclosureReceipt) await this.loadDisclosureReceipt();
    if (!this.active) return;
    try {
      assertUsageTelemetryInventoryContract(event, properties);
    } catch (error) {
      this.recordOutcome('drift_rejected');
      this.warn('Usage telemetry event dropped.', error);
      return;
    }
    try {
      const safeProperties = redactDeep(properties) as Record<string, string>;
      if (this.buffer.length === MAX_BUFFER) {
        this.buffer.shift();
        this.recordOutcome('event_dropped');
        this.warn('Usage telemetry buffer overflow; dropped oldest event.');
      }
      this.buffer.push({ event, properties: safeProperties });
      this.ensureTimer();
      if (this.buffer.length >= BATCH_SIZE) void this.flush();
    } catch (error) {
      this.recordOutcome('event_rejected');
      this.warn('Usage telemetry event dropped.', error);
    }
  }
  async stationStarted(): Promise<void> {
    await this.track('station_started', {
      version: this.options
        .version as UsageTelemetryProperties<'station_started'>['version'],
      platform: process.platform,
      arch: process.arch,
    });
  }
  trackSessionRecovery(
    properties: UsageTelemetryProperties<'session_recovery'>,
  ): void {
    void this.track('session_recovery', properties).catch(() => undefined);
  }
  trackEngineTurn(properties: UsageTelemetryProperties<'engine_turn'>): void {
    void this.track('engine_turn', properties).catch(() => undefined);
  }
  private ensureTimer(): void {
    if (this.timer || !this.active) return;
    this.timer = this.setIntervalImpl(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    this.timer?.unref?.();
  }
  private warn(message: string, error?: unknown): void {
    try {
      if (error === undefined) this.options.logger.warn(message);
      else
        this.options.logger.warn(message, {
          error: error instanceof Error ? error.message : String(error),
        });
    } catch {
      /* optional diagnostics */
    }
  }
  private recordOutcome(outcome: string, count = 1): void {
    try {
      usageTelemetryOutcomes.add(count, { outcome });
    } catch {
      /* optional observability */
    }
  }
  private async distinctIdHash(): Promise<string> {
    return persistedRandomIdentifierHash(
      this.options.homeDir,
      'usage-telemetry-id',
      'Usage telemetry identity did not persist as a UUID.',
    );
  }
  private async awaitFlushWithinDeadline(
    flushing: Promise<void>,
    deadline: number,
  ): Promise<void> {
    const remaining = Math.max(0, deadline - Date.now());
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      flushing,
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(() => {
          // Shutdown begins by allowing an acknowledged request to finish.
          // Only expiry of its shared budget is allowed to cancel it.
          this.requestAbort?.abort();
          resolve();
        }, remaining);
      }),
    ]);
    if (timeoutId) clearTimeout(timeoutId);
  }
  private async flushWithDeadline(deadline?: number): Promise<void> {
    if (!this.active || this.buffer.length === 0 || this.flushing)
      return this.flushing;
    const batch = this.buffer.slice(0, BATCH_SIZE);
    this.flushing = (async () => {
      const controller = new AbortController();
      this.requestAbort = controller;
      const timeout = Math.max(
        0,
        Math.min(
          REQUEST_TIMEOUT_MS,
          deadline === undefined ? REQUEST_TIMEOUT_MS : deadline - Date.now(),
        ),
      );
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await this.fetchImpl(this.endpoint!, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
          },
          body: JSON.stringify({
            distinct_id: await this.distinctIdHash(),
            events: batch,
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        for (const retained of batch) {
          const index = this.buffer.indexOf(retained);
          if (index !== -1) this.buffer.splice(index, 1);
        }
      } catch (error) {
        this.recordOutcome('batch_failed');
        this.warn('Usage telemetry batch failed; requeued.', error);
      } finally {
        clearTimeout(timeoutId);
        if (this.requestAbort === controller) this.requestAbort = undefined;
        this.flushing = undefined;
      }
    })();
    return this.flushing;
  }
  async flush(): Promise<void> {
    return this.flushWithDeadline();
  }
  async shutdown(signal?: AbortSignal): Promise<void> {
    try {
      // Close admission before observing background work. Every accepted
      // track is registered synchronously, so this drain includes fire-and-
      // forget startup and orchestration telemetry that may still be reading
      // disclosure state or starting persistence beneath the Station home.
      this.acceptingTracks = false;
      if (this.timer) this.clearIntervalImpl(this.timer);
      this.timer = undefined;
      const aborted = new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      const abortRequest = () => this.requestAbort?.abort();
      signal?.addEventListener('abort', abortRequest, { once: true });
      // The runtime owns the aggregate optional-network budget. This local
      // bound remains for direct/legacy callers and is never allowed to extend
      // the runtime's earlier AbortSignal.
      const deadline = Date.now() + 1_500;
      await Promise.race([Promise.allSettled([...this.tracking]), aborted]);
      if (signal?.aborted) {
        this.buffer.length = 0;
        return;
      }
      if (this.flushing)
        await this.awaitFlushWithinDeadline(this.flushing, deadline);
      for (
        let attempt = 0;
        this.buffer.length > 0 &&
        !signal?.aborted &&
        attempt < MAX_SHUTDOWN_FLUSH_ATTEMPTS &&
        Date.now() < deadline;
        attempt++
      )
        await this.awaitFlushWithinDeadline(
          this.flushWithDeadline(deadline),
          deadline,
        );
      if (this.buffer.length > 0) {
        this.recordOutcome('shutdown_dropped', this.buffer.length);
        this.warn('Usage telemetry shutdown left events unsent.');
      }
      this.buffer.length = 0;
      signal?.removeEventListener('abort', abortRequest);
    } catch (error) {
      this.warn('Usage telemetry shutdown failed.', error);
    }
  }
}

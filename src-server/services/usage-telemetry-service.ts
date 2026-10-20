import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '@kontourai/station-contracts/config';
import {
  PRODUCT_TELEMETRY_ACKNOWLEDGEMENT_PROTOCOL,
  PRODUCT_TELEMETRY_ENVELOPE,
  type ProductTelemetryBatch,
  type ProductTelemetryBuild,
  type ProductTelemetryCommitReceipt,
  type ProductTelemetryObservation,
  STATION_DAILY_FIELDS,
} from '@kontourai/station-contracts/product-telemetry';
import type {
  ProductTelemetryDeliveryStatus,
  TelemetryConnectionProbeStatus,
} from '@kontourai/station-contracts/telemetry-delivery';
import { publishJsonFileWithOwnedLock } from '@kontourai/station-shared/json-file-storage';
import {
  LITE_TELEMETRY_INVENTORY_REVISION,
  mapRuntimeChannelToTelemetryChannel,
  PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
  parseProductTelemetryCommitReceipt,
  parseProductTelemetryProbeReceipt,
} from '@kontourai/station-shared/product-telemetry';
import { redactDeep } from '@kontourai/station-shared/redaction';
import {
  type ResolvedTelemetryConfiguration,
  resolveProductTelemetryEnabled,
  resolveProductTelemetryEnvironment,
  resolveTelemetryConfiguration,
} from '../domain/telemetry-configuration.js';
import {
  type BuildProvenanceSnapshot,
  captureBuildProvenance,
} from '../routes/system/build-provenance.js';
import { usageTelemetryOutcomes } from '../telemetry/metrics.js';
import { errorMessage } from '../utils/error-message.js';
import type { Logger } from '../utils/logger.js';
import { persistedRandomIdentifierHash } from './persisted-random-identifier.js';
import type { TelemetrySecretResolver } from './secrets/secret-binding-administration.js';
import {
  abortableTelemetryOperation,
  readTelemetryJson,
  TelemetryRequestError,
  telemetryRequestFailure,
} from './telemetry-response.js';
import {
  assertUsageTelemetryInventoryContract,
  FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION,
  USAGE_TELEMETRY_EVENTS,
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
type BufferedEvent = ProductTelemetryObservation;

interface UsageTelemetryServiceOptions {
  homeDir: string;
  appConfig: AppConfig;
  version: string;
  /** null preserves explicitly unknown bootstrap provenance. */
  buildProvenance?: BuildProvenanceSnapshot | null;
  logger: Pick<Logger, 'warn'>;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  telemetrySecretResolver?: TelemetrySecretResolver;
}
/**
 * Where the effective `telemetryEnabled` came from. The precedence is
 * saved config over canonical/legacy product environment values over the default, and a client
 * cannot see the last two — so a first-run screen offering to keep telemetry
 * as it is cannot tell "recorded" from "the environment is deciding, for now"
 * without being told. #1582 A3/L1: the distinction is what decides whether
 * keeping the current state has to WRITE it down.
 */
type UsageTelemetryEnabledSource = 'config' | 'env' | 'default';

/** Server-only product observations and delivery state, independent of OTel SDK availability. */
export class UsageTelemetryService {
  private readonly build: ProductTelemetryBuild;
  private endpoint: string | undefined;
  private keyRef: string | undefined;
  private savedDestination = false;
  private readonly apiKey: string | undefined;
  private appConfig: AppConfig;
  private get enabled(): boolean {
    return resolveProductTelemetryEnabled(
      this.appConfig,
      this.options.env ?? process.env,
      this.hasCurrentDisclosureReceipt,
    ).enabled;
  }
  private enabledSource: UsageTelemetryEnabledSource;
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
  private deliveryEpoch = 0;
  private readonly counts: ProductTelemetryDeliveryStatus['counts'] = {
    buffered: 0,
    acknowledged: 0,
    overflowDropped: 0,
    withdrawn: 0,
    shutdownDropped: 0,
    rejected: 0,
    attempts: 0,
    failedAttempts: 0,
  };
  private lastAttemptAt: string | null = null;
  private lastAcknowledged: ProductTelemetryDeliveryStatus['lastAcknowledged'] =
    null;
  private lastFailure: ProductTelemetryDeliveryStatus['lastFailure'] = null;
  private latestDelivery: 'never' | 'acknowledged' | 'failed' = 'never';
  private probeStatus: TelemetryConnectionProbeStatus = {
    phase: 'never',
    checkedAt: null,
    scope: null,
    failure: null,
  };
  private probing: Promise<TelemetryConnectionProbeStatus> | undefined;
  private probeAbort: AbortController | undefined;
  constructor(private readonly options: UsageTelemetryServiceOptions) {
    const env = options.env ?? process.env;
    const provenance =
      options.buildProvenance === undefined
        ? captureBuildProvenance(env)
        : options.buildProvenance;
    const channel = mapRuntimeChannelToTelemetryChannel(provenance?.channel);
    this.build = {
      version: options.version,
      platform: process.platform,
      arch: process.arch,
      ...(provenance?.fullSha &&
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(provenance.fullSha) &&
      provenance.shaSource
        ? { sha: provenance.fullSha, sha_source: provenance.shaSource }
        : {}),
      ...(channel ? { channel } : {}),
      ...(provenance?.dirty !== undefined ? { dirty: provenance.dirty } : {}),
    };
    const resolved = resolveProductTelemetryEnabled(options.appConfig, env);
    const destinations = resolveProductTelemetryEnvironment(env);
    this.appConfig = options.appConfig;
    this.enabledSource = resolved.source;
    this.endpoint =
      options.appConfig.productTelemetryEndpoint?.trim() ||
      destinations.endpoint.value;
    this.keyRef = options.appConfig.productTelemetryKeyRef?.trim() || undefined;
    this.savedDestination =
      !!options.appConfig.productTelemetryEndpoint?.trim();
    this.apiKey = destinations.key.value;
    for (const notice of [
      ...resolved.notices,
      ...destinations.endpoint.notices,
      ...destinations.key.notices,
    ])
      this.warn(
        `Product telemetry environment: ${notice.code} (${notice.envVar}).`,
      );
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
            FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION,
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
  async acknowledgeDisclosure(inventoryRevision: string): Promise<void> {
    if (
      resolveTelemetryConfiguration(
        this.appConfig,
        this.options.env ?? process.env,
      ).publishers.operator.reason === 'DNT'
    )
      throw new Error(
        'Full telemetry must be confirmed after DO_NOT_TRACK is removed.',
      );
    if (inventoryRevision !== FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION)
      throw new Error(
        'Usage telemetry disclosure changed; review the current inventory.',
      );
    const configDir = join(this.options.homeDir, 'config');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await chmod(configDir, 0o700);
    // The shared publisher owns the temporary (removed on failure, which the
    // hand-rolled pair here did not do), the data fsync and the directory
    // fsync. The options keep the receipt's existing compact-plus-newline
    // document byte for byte.
    await publishJsonFileWithOwnedLock(
      this.disclosurePath,
      {
        acknowledgedAt: new Date().toISOString(),
        inventoryRevision: FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION,
      },
      { indent: null, trailingNewline: true },
    );
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
  async telemetryStatus(): Promise<
    ResolvedTelemetryConfiguration & {
      liteInventoryRevision: string;
      liteInventory: typeof STATION_DAILY_FIELDS;
      fullInventoryRevision: string;
    }
  > {
    await this.loadDisclosureReceipt();
    return {
      ...resolveTelemetryConfiguration(
        this.appConfig,
        this.options.env ?? process.env,
        { operator: this.hasCurrentDisclosureReceipt },
      ),
      liteInventoryRevision: LITE_TELEMETRY_INVENTORY_REVISION,
      liteInventory: STATION_DAILY_FIELDS,
      fullInventoryRevision: FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION,
    };
  }
  async disclosure(): Promise<{
    acknowledged: boolean;
    inventoryRevision: string;
    events: typeof USAGE_TELEMETRY_EVENTS;
    envelope: string;
    acknowledgementProtocol: number;
    endpointConfigured: boolean;
    telemetryEnabled: boolean;
    enabledSource: UsageTelemetryEnabledSource;
    publishers: ReturnType<typeof resolveTelemetryConfiguration>['publishers'];
  }> {
    await this.loadDisclosureReceipt();
    const resolved = resolveTelemetryConfiguration(
      this.appConfig,
      this.options.env ?? process.env,
      { operator: this.hasCurrentDisclosureReceipt },
    );
    return {
      acknowledged: await this.loadDisclosureReceipt(),
      inventoryRevision: FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION,
      events: USAGE_TELEMETRY_EVENTS,
      acknowledgementProtocol: PRODUCT_TELEMETRY_ACKNOWLEDGEMENT_PROTOCOL,
      envelope: Object.entries(PRODUCT_TELEMETRY_ENVELOPE)
        .map(
          ([scope, fields]) =>
            `${scope}: ` +
            Object.entries(fields)
              .map(([field, meaning]) => `${field}: ${meaning}`)
              .join(' '),
        )
        .join('\n\n'),
      endpointConfigured: this.endpointConfigured,
      telemetryEnabled: resolved.publishers.operator.tier === 'full',
      publishers: resolved.publishers,
      enabledSource: this.enabledSource,
    };
  }
  get bufferedCount(): number {
    return this.buffer.length;
  }
  async deliveryStatus(): Promise<ProductTelemetryDeliveryStatus> {
    await this.loadDisclosureReceipt();
    const operator = resolveTelemetryConfiguration(
      this.appConfig,
      this.options.env ?? process.env,
      { operator: this.hasCurrentDisclosureReceipt },
    ).publishers.operator;
    const phase = !this.endpoint
      ? 'unconfigured'
      : operator.reason === 'disclosure'
        ? 'awaiting-disclosure'
        : operator.tier !== 'full'
          ? 'disabled'
          : this.latestDelivery === 'acknowledged'
            ? 'acknowledged'
            : this.latestDelivery === 'failed'
              ? 'failed'
              : 'ready';
    return {
      scope: 'current-process',
      observedAt: new Date().toISOString(),
      phase,
      endpointConfigured: this.endpointConfigured,
      keyConfigured: !!this.keyRef || (!this.savedDestination && !!this.apiKey),
      enabled: this.enabled,
      disclosureAcknowledged: this.hasCurrentDisclosureReceipt,
      sending: !!this.flushing,
      queued: this.buffer.length,
      counts: { ...this.counts },
      lastAttemptAt: this.lastAttemptAt,
      lastAcknowledged: this.lastAcknowledged
        ? { ...this.lastAcknowledged }
        : null,
      lastFailure: this.lastFailure ? { ...this.lastFailure } : null,
      probe: this.probeSnapshot(),
    };
  }
  private probeSnapshot(): TelemetryConnectionProbeStatus {
    return {
      ...this.probeStatus,
      failure: this.probeStatus.failure
        ? { ...this.probeStatus.failure }
        : null,
    };
  }
  async checkConnection(): Promise<TelemetryConnectionProbeStatus> {
    if (this.probing) return this.probing;
    let probeUrl: URL;
    try {
      if (!this.acceptingTracks)
        throw new TelemetryRequestError('service_stopped');
      if (!this.endpoint)
        throw new TelemetryRequestError('endpoint_unconfigured');
      probeUrl = new URL(this.endpoint);
      if (
        !['http:', 'https:'].includes(probeUrl.protocol) ||
        probeUrl.username ||
        probeUrl.password ||
        probeUrl.hash ||
        probeUrl.search ||
        !probeUrl.pathname.endsWith('/v1/product/events')
      )
        throw new TelemetryRequestError('probe_unsupported');
      probeUrl.pathname = probeUrl.pathname.replace(/events$/, 'probes');
    } catch (error) {
      const failure = telemetryRequestFailure(
        error instanceof TelemetryRequestError
          ? error
          : new TelemetryRequestError('probe_unsupported'),
      );
      this.probeStatus = {
        phase: failure.code === 'service_stopped' ? 'failed' : 'unsupported',
        checkedAt: failure.at,
        scope: null,
        failure,
      };
      return this.probeSnapshot();
    }
    this.probeStatus = {
      phase: 'checking',
      checkedAt: null,
      scope: null,
      failure: null,
    };
    const controller = new AbortController();
    const epoch = this.deliveryEpoch;
    this.probeAbort = controller;
    const timeout = setTimeout(() => controller.abort('timeout'), 3_000);
    this.probing = (async () => {
      try {
        const credential = await this.requestCredential(controller.signal);
        if (epoch !== this.deliveryEpoch) return this.probeSnapshot();
        credential.assertCurrent();
        const response = await abortableTelemetryOperation(
          this.fetchImpl(probeUrl, {
            method: 'POST',
            redirect: 'error',
            headers: {
              'content-type': 'application/json',
              ...(credential.key ? { 'x-api-key': credential.key } : {}),
            },
            body: JSON.stringify({
              protocol: 'station-product-probe/v1',
              inventoryRevision: PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
            }),
            signal: controller.signal,
          }),
          controller.signal,
        );
        if ([404, 405, 426].includes(response.status))
          throw new TelemetryRequestError('probe_unsupported', response.status);
        if (!response.ok)
          throw new TelemetryRequestError('http_refused', response.status);
        const body = await readTelemetryJson(response, controller.signal);
        credential.assertCurrent();
        try {
          parseProductTelemetryProbeReceipt(
            body && typeof body === 'object' && 'probe' in body
              ? body.probe
              : null,
          );
        } catch {
          throw new TelemetryRequestError('receipt_invalid');
        }
        if (epoch !== this.deliveryEpoch) return this.probeSnapshot();
        if (!this.acceptingTracks || controller.signal.aborted)
          throw new TelemetryRequestError('service_stopped');
        this.probeStatus = {
          phase: 'ready',
          checkedAt: new Date().toISOString(),
          scope: 'postgres-schema-v1',
          failure: null,
        };
      } catch (error) {
        if (epoch !== this.deliveryEpoch) return this.probeSnapshot();
        const failure = telemetryRequestFailure(error, controller.signal);
        this.probeStatus = {
          phase:
            failure.code === 'probe_unsupported' ? 'unsupported' : 'failed',
          checkedAt: failure.at,
          scope: null,
          failure,
        };
      } finally {
        clearTimeout(timeout);
        if (this.probeAbort === controller) this.probeAbort = undefined;
        this.probing = undefined;
      }
      return this.probeSnapshot();
    })();
    return this.probing;
  }
  reconfigure(appConfig: AppConfig): void {
    const env = this.options.env ?? process.env;
    // Both halves, together: `options.appConfig` is the snapshot this service
    // was CONSTRUCTED with and is never updated, so a source derived from it
    // later would report where the value came from at boot rather than now.
    const resolved = resolveProductTelemetryEnabled(
      appConfig,
      env,
      this.hasCurrentDisclosureReceipt,
    );
    const destinations = resolveProductTelemetryEnvironment(env);
    const endpoint =
      appConfig.productTelemetryEndpoint?.trim() || destinations.endpoint.value;
    const keyRef = appConfig.productTelemetryKeyRef?.trim() || undefined;
    const savedDestination = !!appConfig.productTelemetryEndpoint?.trim();
    const destinationChanged =
      endpoint !== this.endpoint ||
      keyRef !== this.keyRef ||
      savedDestination !== this.savedDestination;
    if (this.enabled !== resolved.enabled || destinationChanged) {
      this.deliveryEpoch++;
      this.latestDelivery = 'never';
      this.lastFailure = null;
    }
    if (destinationChanged) {
      this.requestAbort?.abort();
      this.probeAbort?.abort();
      this.counts.withdrawn += this.buffer.length;
      this.buffer.length = 0;
      this.lastAcknowledged = null;
      this.lastAttemptAt = null;
      this.probeStatus = {
        phase: 'never',
        checkedAt: null,
        scope: null,
        failure: null,
      };
    }
    this.endpoint = endpoint;
    this.keyRef = keyRef;
    this.savedDestination = savedDestination;
    this.appConfig = appConfig;
    this.enabledSource = resolved.source;
    if (!this.active) {
      // Disabling withdraws consent for data still in memory, so discard it rather than flushing it.
      if (this.timer) this.clearIntervalImpl(this.timer);
      this.timer = undefined;
      this.counts.withdrawn += this.buffer.length;
      this.buffer.length = 0;
      this.requestAbort?.abort();
    }
  }
  private async requestCredential(
    signal: AbortSignal,
  ): Promise<{ key?: string; assertCurrent: () => void }> {
    if (!this.keyRef)
      return {
        key: this.savedDestination ? undefined : this.apiKey,
        assertCurrent: () => {},
      };
    try {
      if (!this.endpoint || !this.options.telemetrySecretResolver)
        throw new Error();
      const credential = await abortableTelemetryOperation(
        this.options.telemetrySecretResolver.resolveForTelemetry({
          id: this.keyRef,
          transport: 'product',
          destination: this.endpoint,
          signal,
        }),
        signal,
      );
      return {
        key: credential.key,
        assertCurrent: () => {
          try {
            credential.assertCurrent();
          } catch {
            throw new TelemetryRequestError('credential_unavailable');
          }
        },
      };
    } catch (error) {
      if (signal.aborted) throw error;
      throw new TelemetryRequestError('credential_unavailable');
    }
  }
  track<E extends UsageTelemetryEvent>(
    event: E,
    properties: UsageTelemetryProperties<E>,
  ): Promise<void> {
    if (!this.acceptingTracks) return Promise.resolve();
    const operation = this.trackAccepted(
      event,
      properties,
      randomUUID(),
      new Date().toISOString(),
      this.deliveryEpoch,
    );
    this.tracking.add(operation);
    void operation.finally(() => this.tracking.delete(operation));
    return operation;
  }
  private async trackAccepted<E extends UsageTelemetryEvent>(
    event: E,
    properties: UsageTelemetryProperties<E>,
    eventId: string,
    occurredAt: string,
    epoch: number,
  ): Promise<void> {
    if (!this.hasCurrentDisclosureReceipt) await this.loadDisclosureReceipt();
    if (!this.active || epoch !== this.deliveryEpoch) return;
    try {
      assertUsageTelemetryInventoryContract(event, properties);
      assertUsageTelemetryInventoryContract('station_started', {
        version: this.build.version,
        platform: this.build.platform,
        arch: this.build.arch,
      });
    } catch (error) {
      this.counts.rejected++;
      this.recordOutcome('drift_rejected');
      this.warn('Usage telemetry event dropped.', error);
      return;
    }
    try {
      const safeProperties = redactDeep(properties) as Record<string, string>;
      if (this.buffer.length === MAX_BUFFER) {
        this.buffer.shift();
        this.counts.overflowDropped++;
        this.recordOutcome('event_dropped');
        this.warn('Usage telemetry buffer overflow; dropped oldest event.');
      }
      this.buffer.push({
        event,
        properties: safeProperties,
        event_id: eventId,
        occurred_at: occurredAt,
        observed_at: new Date().toISOString(),
        build: { ...this.build },
      });
      this.counts.buffered++;
      this.ensureTimer();
      if (this.buffer.length >= BATCH_SIZE) void this.flush();
    } catch (error) {
      this.counts.rejected++;
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
          error: errorMessage(error),
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
      new Date(),
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
    const epoch = this.deliveryEpoch;
    const endpoint = this.endpoint!;
    this.counts.attempts++;
    this.lastAttemptAt = new Date().toISOString();
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
      const timeoutId = setTimeout(() => controller.abort('timeout'), timeout);
      try {
        const credential = await this.requestCredential(controller.signal);
        if (epoch !== this.deliveryEpoch) return;
        const distinctId = await abortableTelemetryOperation(
          this.distinctIdHash(),
          controller.signal,
        );
        if (epoch !== this.deliveryEpoch || controller.signal.aborted) return;
        credential.assertCurrent();
        const response = await abortableTelemetryOperation(
          this.fetchImpl(endpoint, {
            method: 'POST',
            redirect: 'error',
            headers: {
              'content-type': 'application/json',
              ...(credential.key ? { 'x-api-key': credential.key } : {}),
            },
            body: JSON.stringify({
              schema_version: 1,
              inventory_revision: PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
              distinct_id: distinctId,
              events: batch,
            } satisfies ProductTelemetryBatch),
            signal: controller.signal,
          }),
          controller.signal,
        );
        if (!response.ok)
          throw new TelemetryRequestError('http_refused', response.status);
        const body = await readTelemetryJson(response, controller.signal);
        credential.assertCurrent();
        let receipt: ProductTelemetryCommitReceipt;
        try {
          receipt = parseProductTelemetryCommitReceipt(
            body && typeof body === 'object' && 'receipt' in body
              ? body.receipt
              : null,
            batch.map((event) => event.event_id),
          );
        } catch {
          throw new TelemetryRequestError('receipt_invalid');
        }
        // Withdrawal fences late acknowledgements, including a transport that ignored abort.
        if (epoch !== this.deliveryEpoch || controller.signal.aborted) return;
        for (const retained of batch) {
          const index = this.buffer.indexOf(retained);
          if (index !== -1) this.buffer.splice(index, 1);
        }
        this.counts.acknowledged += receipt.eventIds.length;
        this.lastAcknowledged = {
          at: new Date().toISOString(),
          storedAt: receipt.storedAt,
          eventCount: receipt.eventIds.length,
        };
        this.latestDelivery = 'acknowledged';
      } catch (error) {
        if (epoch !== this.deliveryEpoch) return;
        this.counts.failedAttempts++;
        this.lastFailure = telemetryRequestFailure(error, controller.signal);
        this.latestDelivery = 'failed';
        this.recordOutcome('batch_failed');
        this.warn(
          'Usage telemetry batch failed; requeued.',
          new TelemetryRequestError(
            this.lastFailure.code,
            this.lastFailure.httpStatus,
          ),
        );
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
      this.probeAbort?.abort();
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
        this.counts.shutdownDropped += this.buffer.length;
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
        this.counts.shutdownDropped += this.buffer.length;
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

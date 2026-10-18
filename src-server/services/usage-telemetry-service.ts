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
  type TelemetryFeedback,
  type TelemetryLiteNoticeReceipt,
  type TelemetryOutboxEntry,
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
import { TelemetryPublisherService } from './telemetry-publisher-service.js';
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
  dailyFacts?: ConstructorParameters<
    typeof TelemetryPublisherService
  >[0]['facts'];
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
    return (
      this.resolvedConfiguration().publishers[this.publisher].tier === 'full'
    );
  }
  private readonly fetchImpl: typeof fetch;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;
  private readonly disclosurePath: string;
  private readonly buffer: BufferedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> | undefined;
  private dailyFlushing: Promise<void> | undefined;
  private readonly dropped = new Map<string, TelemetryOutboxEntry>();
  private requestAbort: AbortController | undefined;
  private acceptingTracks = true;
  private started = false;
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
  private readonly publishers: TelemetryPublisherService;
  private readonly author?: UsageTelemetryService;
  constructor(
    private readonly options: UsageTelemetryServiceOptions,
    private readonly publisher: 'kontour' | 'operator' = 'operator',
    publishers?: TelemetryPublisherService,
  ) {
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
    if (publisher === 'kontour') {
      this.endpoint = resolveTelemetryConfiguration(
        options.appConfig,
        env,
      ).authorEndpoint;
      this.keyRef = undefined;
      this.savedDestination = true;
    }
    this.publishers =
      publishers ??
      new TelemetryPublisherService({
        homeDir: options.homeDir,
        build: this.build,
        channel: provenance?.channel,
        configuration: () => this.resolvedConfiguration(),
        operatorEndpoint: () => this.endpoint,
        facts: options.dailyFacts,
        fetch: this.fetchImpl,
      });
    if (
      publisher === 'operator' &&
      resolveTelemetryConfiguration(options.appConfig, env).authorEndpoint
    )
      this.author = new UsageTelemetryService(
        options,
        'kontour',
        this.publishers,
      );
    this.disclosurePath = join(
      options.homeDir,
      'config',
      publisher === 'kontour'
        ? 'usage-telemetry-disclosure-kontour.json'
        : 'usage-telemetry-disclosure.json',
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
  private resolvedConfiguration(): ResolvedTelemetryConfiguration {
    return resolveTelemetryConfiguration(
      this.appConfig,
      this.options.env ?? process.env,
      {
        operator:
          this.publisher === 'operator' && this.hasCurrentDisclosureReceipt,
        kontour:
          this.publisher === 'kontour'
            ? this.hasCurrentDisclosureReceipt
            : this.author?.hasCurrentDisclosureReceipt,
      },
    );
  }
  async outbox(publisher?: 'kontour' | 'operator') {
    await this.flushDropped();
    await this.author?.flushDropped();
    return this.publishers.local.outbox(publisher);
  }
  async submitFeedback(payload: TelemetryFeedback): Promise<boolean> {
    return this.publishers.feedback(payload);
  }
  async recordTierLowering(
    publisher: 'kontour' | 'operator',
    reason?: TelemetryFeedback['reason'],
  ): Promise<void> {
    await this.publishers.tierLowered(publisher, reason);
  }
  async recordLiteNotice(
    publisher: 'kontour' | 'operator',
    revision: string,
  ): Promise<void> {
    await this.publishers.recordNotice(publisher, revision);
    this.ensureTimer();
  }
  async loadDisclosureReceipt(): Promise<boolean> {
    await this.author?.loadDisclosureReceipt();
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
            FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION &&
          (this.publisher === 'operator' ||
            (!!this.endpoint &&
              'publisher' in receipt &&
              receipt.publisher === 'kontour' &&
              'destination' in receipt &&
              receipt.destination === this.endpoint)),
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
  async acknowledgeDisclosure(
    inventoryRevision: string,
    publisher: 'kontour' | 'operator' = 'operator',
    destination?: string,
  ): Promise<void> {
    if (this.resolvedConfiguration().publishers[publisher].reason === 'DNT')
      throw new Error(
        'Full telemetry must be confirmed after DO_NOT_TRACK is removed.',
      );
    if (this.publisher === 'operator' && publisher === 'kontour') {
      if (!this.author)
        throw new Error('Author telemetry destination is unconfigured.');
      return this.author.acknowledgeDisclosure(
        inventoryRevision,
        publisher,
        destination,
      );
    }
    if (
      this.publisher === 'kontour' &&
      (!this.endpoint || destination !== this.endpoint)
    )
      throw new Error(
        'Author telemetry destination changed; review the current disclosure.',
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
        ...(this.publisher === 'kontour'
          ? { publisher: 'kontour', destination: this.endpoint }
          : {}),
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
      liteNotices: Partial<
        Record<'kontour' | 'operator', TelemetryLiteNoticeReceipt>
      >;
      liteInventoryRevision: string;
      liteInventory: typeof STATION_DAILY_FIELDS;
      fullInventoryRevision: string;
    }
  > {
    await this.loadDisclosureReceipt();
    return {
      ...this.resolvedConfiguration(),
      liteNotices: this.publishers.local.notices(),
      liteInventoryRevision: LITE_TELEMETRY_INVENTORY_REVISION,
      liteInventory: STATION_DAILY_FIELDS,
      fullInventoryRevision: FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION,
    };
  }
  async disclosure(publisher?: 'kontour' | 'operator'): Promise<{
    publisher?: 'kontour';
    destination?: string;
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
    const resolved = this.resolvedConfiguration();
    if (publisher === 'kontour' && this.publisher === 'operator') {
      if (!this.author)
        throw new Error('Author telemetry destination is unconfigured.');
      return {
        ...(await this.author.disclosure()),
        publishers: resolved.publishers,
      };
    }
    return {
      ...(this.publisher === 'kontour'
        ? { publisher: 'kontour' as const, destination: this.endpoint }
        : {}),
      acknowledged: this.hasCurrentDisclosureReceipt,
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
      telemetryEnabled: resolved.publishers[this.publisher].tier === 'full',
      publishers: resolved.publishers,
      enabledSource: resolved.publishers[this.publisher].source,
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
  reconfigure(appConfig: AppConfig, recordSettingChange = false): void {
    const env = this.options.env ?? process.env;
    const destinations = resolveProductTelemetryEnvironment(env);
    const endpoint =
      this.publisher === 'kontour'
        ? resolveTelemetryConfiguration(appConfig, env).authorEndpoint
        : appConfig.productTelemetryEndpoint?.trim() ||
          destinations.endpoint.value;
    const keyRef =
      this.publisher === 'operator'
        ? appConfig.productTelemetryKeyRef?.trim() || undefined
        : undefined;
    const savedDestination =
      this.publisher === 'kontour' ||
      !!appConfig.productTelemetryEndpoint?.trim();
    const destinationChanged =
      endpoint !== this.endpoint ||
      keyRef !== this.keyRef ||
      savedDestination !== this.savedDestination;
    const nextTier = resolveTelemetryConfiguration(appConfig, env, {
      operator:
        this.publisher === 'operator' && this.hasCurrentDisclosureReceipt,
      kontour:
        this.publisher === 'kontour'
          ? this.hasCurrentDisclosureReceipt
          : this.author?.hasCurrentDisclosureReceipt,
    }).publishers[this.publisher].tier;
    if (this.enabled !== (nextTier === 'full') || destinationChanged) {
      this.deliveryEpoch++;
      this.latestDelivery = 'never';
      this.lastFailure = null;
    }
    if (destinationChanged) {
      this.requestAbort?.abort();
      this.probeAbort?.abort();
      this.counts.withdrawn += this.buffer.length;
      this.recordDropped(this.buffer, 'off');
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
    const choiceChanged =
      JSON.stringify(this.appConfig.telemetryTier) !==
        JSON.stringify(appConfig.telemetryTier) ||
      this.appConfig.telemetryEnabled !== appConfig.telemetryEnabled;
    if (this.publisher === 'operator') {
      const prior = this.resolvedConfiguration().publishers;
      const next = resolveTelemetryConfiguration(appConfig, env, {
        operator: this.hasCurrentDisclosureReceipt,
        kontour: this.author?.hasCurrentDisclosureReceipt,
      }).publishers;
      for (const publisher of ['kontour', 'operator'] as const) {
        if (
          prior[publisher].tier !== next[publisher].tier ||
          (publisher === 'operator' && destinationChanged)
        )
          this.publishers.reconfigure(publisher);
      }
    }
    const changed = [
      ...new Set([...Object.keys(this.appConfig), ...Object.keys(appConfig)]),
    ].some(
      (key) =>
        JSON.stringify(appConfig[key as keyof AppConfig]) !==
        JSON.stringify(this.appConfig[key as keyof AppConfig]),
    );
    this.author?.reconfigure(appConfig);
    this.appConfig = appConfig;
    if (recordSettingChange && changed && this.publisher === 'operator')
      void this.track('setting_category_changed', {
        category: choiceChanged || destinationChanged ? 'privacy' : 'other',
      }).catch((error) =>
        this.warn('Settings telemetry observation failed.', error),
      );
    if (!this.active) {
      // Disabling withdraws consent for data still in memory, so discard it rather than flushing it.
      if (this.timer) this.clearIntervalImpl(this.timer);
      this.timer = undefined;
      this.counts.withdrawn += this.buffer.length;
      this.recordDropped(this.buffer, 'off');
      this.buffer.length = 0;
      this.requestAbort?.abort();
    }
    if (this.started) this.ensureTimer();
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
      new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString(),
      this.deliveryEpoch,
    ).catch((error) => this.warn('Usage telemetry observation failed.', error));
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
    try {
      assertUsageTelemetryInventoryContract(
        event,
        properties,
        [],
        [this.build.version],
      );
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
    if (this.publisher === 'operator') {
      await this.publishers.observe(event, properties);
      void this.author?.track(event, properties);
    }
    const observation: BufferedEvent = {
      event,
      properties: redactDeep(properties) as Record<string, string>,
      event_id: eventId,
      occurred_at: occurredAt,
      observed_at: new Date(
        Math.floor(Date.now() / 60_000) * 60_000,
      ).toISOString(),
      build: { ...this.build },
    };
    if (!this.active || epoch !== this.deliveryEpoch) {
      const tier = this.resolvedConfiguration().publishers[this.publisher];
      await this.recordFull(
        [observation],
        'dropped',
        tier.reason === 'DNT'
          ? 'DNT'
          : !this.endpoint
            ? 'unconfigured'
            : tier.tier === 'off'
              ? 'off'
              : 'disclosure',
      );
      return;
    }
    try {
      const safeProperties = redactDeep(properties) as Record<string, string>;
      if (this.buffer.length === MAX_BUFFER) {
        this.recordDropped(this.buffer.slice(0, 1), 'overflow');
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
        observed_at: new Date(
          Math.floor(Date.now() / 60_000) * 60_000,
        ).toISOString(),
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
    if (this.publisher === 'operator' && !this.started) {
      this.started = true;
      try {
        await this.publishers.notice(
          (this.options.env ?? process.env).STATION_STDOUT_HANDSHAKE !== '1',
        );
        this.ensureTimer();
      } catch (error) {
        this.warn(
          'Usage telemetry notice unavailable; Lite remains gated.',
          error,
        );
      }
    }
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
    if (
      this.timer ||
      !this.acceptingTracks ||
      (!this.active &&
        (this.publisher === 'kontour' || !this.publishers.canSendDaily()))
    )
      return;
    this.timer = this.setIntervalImpl(() => {
      void Promise.all([this.flush(), this.flushDaily()]).catch((error) =>
        this.warn('Usage telemetry flush failed.', error),
      );
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
  private async recordFull(
    events: BufferedEvent[],
    outcome: TelemetryOutboxEntry['outcome'],
    reason: TelemetryOutboxEntry['reason'],
    distinctId = '',
  ): Promise<void> {
    if (!events.length) return;
    if (outcome === 'dropped') {
      const recordedAt = new Date().toISOString();
      const key = `${recordedAt.slice(0, 10)}:${reason}`;
      const prior = this.dropped.get(key);
      this.dropped.set(key, {
        publisher: this.publisher,
        tier: 'full',
        recordedAt,
        outcome,
        reason,
        payload: {
          event: 'telemetry_dropped',
          count:
            (prior && 'count' in prior.payload ? prior.payload.count : 0) +
            events.length,
        },
      });
      return;
    }
    await this.publishers.local.record({
      publisher: this.publisher,
      tier: 'full',
      outcome,
      reason,
      recordedAt: new Date().toISOString(),
      payload: {
        schema_version: 1,
        inventory_revision: PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
        distinct_id: distinctId,
        events: [...events],
      },
    });
  }
  private async flushDropped(): Promise<void> {
    const pending = [...this.dropped];
    this.dropped.clear();
    for (let index = 0; index < pending.length; index++) {
      try {
        await this.publishers.local.record(pending[index][1]);
      } catch (error) {
        for (const [key, entry] of pending.slice(index)) {
          const newer = this.dropped.get(key);
          if ('count' in entry.payload && newer && 'count' in newer.payload)
            entry.payload.count += newer.payload.count;
          this.dropped.set(key, entry);
        }
        this.warn('Usage telemetry ledger failed.', error);
        return;
      }
    }
  }
  private recordDropped(
    events: BufferedEvent[],
    reason: TelemetryOutboxEntry['reason'],
  ): void {
    if (!events.length) return;
    const operation = this.recordFull([...events], 'dropped', reason).catch(
      (error) => this.warn('Usage telemetry ledger failed.', error),
    );
    this.tracking.add(operation);
    void operation.finally(() => this.tracking.delete(operation));
  }
  private async distinctIdHash(): Promise<string> {
    return persistedRandomIdentifierHash(
      this.options.homeDir,
      'usage-telemetry-id',
      'Usage telemetry identity did not persist as a UUID.',
      { month: new Date(), publisherId: this.publisher },
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
      let wireId = '';
      try {
        const credential = await this.requestCredential(controller.signal);
        if (epoch !== this.deliveryEpoch) return;
        const distinctId = await abortableTelemetryOperation(
          this.distinctIdHash(),
          controller.signal,
        );
        if (epoch !== this.deliveryEpoch || controller.signal.aborted) return;
        wireId = distinctId;
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
        await this.recordFull(batch, 'sent', 'acknowledged', distinctId);
        this.counts.acknowledged += receipt.eventIds.length;
        this.lastAcknowledged = {
          at: new Date().toISOString(),
          storedAt: receipt.storedAt,
          eventCount: receipt.eventIds.length,
        };
        this.latestDelivery = 'acknowledged';
      } catch (error) {
        if (epoch !== this.deliveryEpoch) return;
        await this.recordFull(batch, 'dropped', 'transport', wireId);
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
  async flushDaily(): Promise<void> {
    if (this.publisher !== 'operator' || !this.acceptingTracks) return;
    if (this.dailyFlushing) return this.dailyFlushing;
    this.dailyFlushing = this.publishers.flushDaily().finally(() => {
      this.dailyFlushing = undefined;
    });
    return this.dailyFlushing;
  }
  async flush(): Promise<void> {
    if (!this.acceptingTracks) return this.flushing;
    await Promise.all([
      this.flushDropped(),
      this.author?.flushDropped(),
      this.flushWithDeadline(),
      this.author?.flushWithDeadline(),
    ]);
  }
  async shutdown(signal?: AbortSignal): Promise<void> {
    const abortRequest = () => this.requestAbort?.abort();
    try {
      // Close admission before observing background work. Every accepted
      // track is registered synchronously, so this drain includes fire-and-
      // forget startup and orchestration telemetry that may still be reading
      // disclosure state or starting persistence beneath the Station home.
      this.acceptingTracks = false;
      this.probeAbort?.abort();
      if (this.timer) this.clearIntervalImpl(this.timer);
      this.timer = undefined;
      // Network cancellation is installed before waiting on local daily publication.
      if (signal?.aborted) abortRequest();
      else signal?.addEventListener('abort', abortRequest, { once: true });
      const aborted = new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      // Reserve the rest of the 1.5s optional budget for local ledger settlement.
      const deadline = Date.now() + 1_000;
      const authorShutdown = this.author?.shutdown(signal);
      if (this.publisher === 'operator') {
        this.publishers.stop();
        await this.dailyFlushing?.catch((error) =>
          this.warn('Usage telemetry daily shutdown failed.', error),
        );
      }
      await Promise.race([Promise.allSettled([...this.tracking]), aborted]);
      if (signal?.aborted) {
        this.recordDropped(this.buffer, 'transport');
        this.counts.shutdownDropped += this.buffer.length;
        this.buffer.length = 0;
        await authorShutdown;
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
      await this.recordFull(this.buffer, 'dropped', 'transport');
      this.buffer.length = 0;
      await authorShutdown;
    } catch (error) {
      this.warn('Usage telemetry shutdown failed.', error);
    } finally {
      await this.flushDropped().catch((error) =>
        this.warn('Usage telemetry ledger failed.', error),
      );
      signal?.removeEventListener('abort', abortRequest);
    }
  }
}

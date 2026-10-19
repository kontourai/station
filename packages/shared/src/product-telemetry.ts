import { createHash } from 'node:crypto';

export {
  USAGE_TELEMETRY_EVENTS,
  type UsageTelemetryEvent,
  type UsageTelemetryProperties,
} from '@kontourai/station-contracts/product-telemetry';

import {
  FULL_DISCLOSURE_WORDING_REVISION,
  PRODUCT_TELEMETRY_ENVELOPE,
  type ProductTelemetryBatch,
  type ProductTelemetryBuild,
  type ProductTelemetryCommitReceipt,
  type ProductTelemetryObservation,
  type ProductTelemetryProbeReceipt,
  type ProductTelemetryProbeRequest,
  type ProductTelemetryPropertyDefinition as PropertyDefinition,
  STATION_DAILY_FIELDS,
  type StationDailyPing,
  TELEMETRY_CHANNELS,
  TELEMETRY_COUNT_BUCKETS,
  TELEMETRY_ENGINES,
  USAGE_TELEMETRY_EVENTS,
  type UsageTelemetryEvent,
} from '@kontourai/station-contracts/product-telemetry';

/** Runtime builds call the preview release ring beta; telemetry uses preview. */
export function mapRuntimeChannelToTelemetryChannel(
  channel: string | undefined,
): ProductTelemetryBuild['channel'] {
  const label = channel === 'beta' ? 'preview' : channel;
  return TELEMETRY_CHANNELS.find((allowed) => allowed === label);
}

export function renderUsageTelemetryInventory(): string {
  return Object.entries(USAGE_TELEMETRY_EVENTS)
    .map(([event, definition]) => {
      const eventDefinition = definition as {
        description: string;
        properties: Record<string, PropertyDefinition>;
      };
      const properties = Object.entries(eventDefinition.properties)
        .map(
          ([property, definition]) =>
            `| \`${property}\` | ${Array.isArray(definition.domain) ? definition.domain.map((value) => `\`${value}\``).join(', ') : definition.domain} |`,
        )
        .join('\n');
      return `## \`${event}\`\n\n${eventDefinition.description}\n\n| Property | Permitted value |\n| --- | --- |\n${properties}`;
    })
    .join('\n\n');
}

/** Wire compatibility depends only on the event/property/envelope data inventory. */
export const PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION = createHash('sha256')
  .update(
    renderUsageTelemetryEnvelopeInventory() +
      '\n\n' +
      renderUsageTelemetryInventory(),
  )
  .digest('hex');

/** Consent covers the disclosed data and the wording the person reviewed. */
export const FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION = createHash('sha256')
  .update(
    `full-disclosure-wording:${FULL_DISCLOSURE_WORDING_REVISION}\n\n` +
      renderUsageTelemetryEnvelopeInventory() +
      '\n\n' +
      renderUsageTelemetryInventory(),
  )
  .digest('hex');

/**
 * Existing disclosure API/receipt name; never use this for wire admission.
 * @deprecated Use FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION.
 */
export const USAGE_TELEMETRY_INVENTORY_REVISION =
  FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION;

/** Fails loudly if an implementation and the published inventory diverge. */
export function assertUsageTelemetryInventoryContract(
  event: string,
  properties: Record<string, unknown>,
  publicRegistryIds: readonly string[] = [],
  publicReleaseVersions: readonly string[] = [],
): asserts properties is Record<string, string> {
  const definition = USAGE_TELEMETRY_EVENTS[event as UsageTelemetryEvent];
  if (!Object.hasOwn(USAGE_TELEMETRY_EVENTS, event) || !definition)
    throw new Error(
      `Usage telemetry inventory drift: event "${event}" is not published.`,
    );
  const eventDefinition: { properties: Record<string, PropertyDefinition> } =
    definition;
  for (const property of Object.keys(properties)) {
    if (!Object.hasOwn(eventDefinition.properties, property))
      throw new Error(
        `Usage telemetry inventory drift: property "${event}.${property}" is not published.`,
      );
  }
  for (const property of Object.keys(eventDefinition.properties)) {
    if (!Object.hasOwn(properties, property))
      throw new Error(
        `Usage telemetry inventory drift: published property "${event}.${property}" is missing from code.`,
      );
  }
  for (const [property, value] of Object.entries(properties)) {
    const propertyDefinition = eventDefinition.properties[property];
    if (typeof value !== 'string')
      throw new Error(
        `Usage telemetry inventory drift: property "${event}.${property}" must be a string.`,
      );
    const allowed = propertyDefinition.domain;
    const valid = Array.isArray(allowed)
      ? (allowed as readonly string[]).includes(value)
      : allowed === 'public-registry-id-or-custom'
        ? value === 'custom' ||
          (value.length <= 128 && publicRegistryIds.includes(value))
        : allowed === 'public-release-version-or-custom'
          ? value === 'custom' ||
            (value.length <= 64 && publicReleaseVersions.includes(value))
          : /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
              value,
            );
    if (!valid)
      throw new Error(
        `Usage telemetry inventory drift: property "${event}.${property}" has invalid value "${value}"; permitted: ${Array.isArray(allowed) ? allowed.join(', ') : allowed}.`,
      );
  }
}

/** Envelope fields participate in the disclosure receipt just like event properties. */
export function renderUsageTelemetryEnvelopeInventory(): string {
  return (
    '## Version 1 envelope\n\n' +
    Object.entries(PRODUCT_TELEMETRY_ENVELOPE)
      .map(
        ([scope, fields]) =>
          `### ${scope} fields\n\n| Field | Disclosed meaning |\n| --- | --- |\n` +
          Object.entries(fields)
            .map(([field, meaning]) => `| \`${field}\` | ${meaning} |`)
            .join('\n'),
      )
      .join('\n\n') +
    '\n\nProducer wall-clock times do not guarantee synchronized clocks or receiver arrival. Branches, hostnames, instance and boot identifiers are excluded.'
  );
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const utcTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const productUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

export function parseProductTelemetryCommitReceipt(
  value: unknown,
  expectedEventIds: readonly string[],
): ProductTelemetryCommitReceipt {
  if (
    !record(value) ||
    !onlyKeys(value, [
      'protocol',
      'receiptId',
      'sourceId',
      'eventIds',
      'inserted',
      'alreadyPresent',
      'storedAt',
    ]) ||
    value.protocol !== 'station-product-commit/v1' ||
    !productUuid(value.receiptId) ||
    !productUuid(value.sourceId) ||
    !utcTime(value.storedAt) ||
    !Array.isArray(value.eventIds) ||
    value.eventIds.length < 1 ||
    value.eventIds.length > 20 ||
    typeof value.inserted !== 'number' ||
    !Number.isInteger(value.inserted) ||
    value.inserted < 0 ||
    typeof value.alreadyPresent !== 'number' ||
    !Number.isInteger(value.alreadyPresent) ||
    value.alreadyPresent < 0
  )
    throw new Error('Invalid product telemetry commit receipt');
  const eventIds: string[] = [];
  for (const id of value.eventIds) {
    if (!productUuid(id)) throw new Error('Invalid product receipt event ID');
    eventIds.push(id.toLowerCase());
  }
  const expected = new Set(expectedEventIds.map((id) => id.toLowerCase()));
  if (
    new Set(eventIds).size !== eventIds.length ||
    expected.size !== eventIds.length ||
    eventIds.some((id) => !expected.has(id)) ||
    value.inserted + value.alreadyPresent !== eventIds.length
  )
    throw new Error('Product telemetry receipt does not cover its batch');
  return {
    protocol: 'station-product-commit/v1',
    receiptId: value.receiptId.toLowerCase(),
    sourceId: value.sourceId.toLowerCase(),
    eventIds,
    inserted: value.inserted,
    alreadyPresent: value.alreadyPresent,
    storedAt: value.storedAt,
  };
}

export function parseProductTelemetryProbeRequest(
  value: unknown,
): ProductTelemetryProbeRequest {
  if (
    !record(value) ||
    !onlyKeys(value, ['protocol', 'inventoryRevision']) ||
    value.protocol !== 'station-product-probe/v1' ||
    value.inventoryRevision !== PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION
  )
    throw new Error('Invalid product telemetry probe');
  return {
    protocol: 'station-product-probe/v1',
    inventoryRevision: PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
  };
}

export function parseProductTelemetryProbeReceipt(
  value: unknown,
): ProductTelemetryProbeReceipt {
  if (
    !record(value) ||
    !onlyKeys(value, [
      'protocol',
      'sourceId',
      'inventoryRevision',
      'checkedAt',
      'storage',
    ]) ||
    value.protocol !== 'station-product-probe/v1' ||
    !productUuid(value.sourceId) ||
    value.inventoryRevision !== PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION ||
    !utcTime(value.checkedAt) ||
    value.storage !== 'postgres-schema-v1'
  )
    throw new Error('Invalid product telemetry probe receipt');
  return {
    protocol: 'station-product-probe/v1',
    sourceId: value.sourceId.toLowerCase(),
    inventoryRevision: PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
    checkedAt: value.checkedAt,
    storage: 'postgres-schema-v1',
  };
}

/** Strict v1 receiver boundary. Legacy batches require a separate explicit ingestion profile. */
export function parseProductTelemetryBatch(
  value: unknown,
  publicRegistryIds: readonly string[] = [],
  publicReleaseVersions: readonly string[] = [],
): ProductTelemetryBatch {
  if (
    !record(value) ||
    !onlyKeys(value, Object.keys(PRODUCT_TELEMETRY_ENVELOPE.batch)) ||
    value.schema_version !== 1 ||
    value.inventory_revision !== PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION ||
    typeof value.distinct_id !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.distinct_id) ||
    !Array.isArray(value.events) ||
    value.events.length < 1 ||
    value.events.length > 20
  ) {
    throw new Error('Unsupported or invalid product telemetry batch');
  }
  const events: ProductTelemetryObservation[] = [];
  for (const event of value.events) {
    if (
      !record(event) ||
      !onlyKeys(event, Object.keys(PRODUCT_TELEMETRY_ENVELOPE.observation)) ||
      typeof event.event_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        event.event_id,
      ) ||
      !utcTime(event.occurred_at) ||
      !utcTime(event.observed_at) ||
      typeof event.event !== 'string' ||
      !record(event.properties) ||
      !record(event.build)
    ) {
      throw new Error('Invalid product telemetry observation');
    }
    assertUsageTelemetryInventoryContract(
      event.event,
      event.properties,
      publicRegistryIds,
      publicReleaseVersions,
    );
    const build = event.build;
    if (!onlyKeys(build, Object.keys(PRODUCT_TELEMETRY_ENVELOPE.build)))
      throw new Error('Undisclosed product telemetry build fields');
    const buildProperties = {
      version: build.version,
      platform: build.platform,
      arch: build.arch,
    };
    assertUsageTelemetryInventoryContract('station_started', buildProperties);
    if (
      typeof buildProperties.version !== 'string' ||
      typeof buildProperties.platform !== 'string' ||
      typeof buildProperties.arch !== 'string'
    )
      throw new Error('Invalid product telemetry build identity');
    if (
      (build.sha === undefined) !== (build.sha_source === undefined) ||
      (build.sha !== undefined &&
        (typeof build.sha !== 'string' ||
          !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(build.sha))) ||
      (build.sha_source !== undefined &&
        (typeof build.sha_source !== 'string' ||
          !['build-stamp', 'checkout'].includes(build.sha_source))) ||
      (build.channel !== undefined &&
        (typeof build.channel !== 'string' ||
          !['stable', 'preview', 'nightly', 'dev', 'source-checkout'].includes(
            build.channel,
          ))) ||
      (build.dirty !== undefined && typeof build.dirty !== 'boolean')
    )
      throw new Error('Invalid product telemetry build provenance');
    events.push({
      event_id: event.event_id,
      event: event.event as UsageTelemetryEvent,
      occurred_at: event.occurred_at,
      observed_at: event.observed_at,
      properties: { ...event.properties },
      build: {
        version: buildProperties.version,
        platform: buildProperties.platform,
        arch: buildProperties.arch,
        ...(typeof build.sha === 'string' ? { sha: build.sha } : {}),
        ...(build.sha_source === 'build-stamp' ||
        build.sha_source === 'checkout'
          ? { sha_source: build.sha_source }
          : {}),
        ...(typeof build.channel === 'string'
          ? { channel: build.channel as ProductTelemetryBuild['channel'] }
          : {}),
        ...(typeof build.dirty === 'boolean' ? { dirty: build.dirty } : {}),
      },
    });
  }
  return {
    schema_version: 1,
    inventory_revision: value.inventory_revision as string,
    distinct_id: value.distinct_id,
    events,
  };
}

export function renderLiteTelemetryInventory(): string {
  return (
    '## `station_daily` Lite inventory\n\n' +
    Object.entries(STATION_DAILY_FIELDS)
      .map(
        ([field, definition]) =>
          `- \`${field}\`: ${JSON.stringify(definition)}`,
      )
      .join('\n')
  );
}
export const LITE_TELEMETRY_INVENTORY_REVISION = createHash('sha256')
  .update(renderLiteTelemetryInventory())
  .digest('hex');

/** A sender must show the new notice whenever this revision changes. */
export function hasCurrentLiteTelemetryNotice(
  receipt: { inventoryRevision: string } | undefined,
): boolean {
  return receipt?.inventoryRevision === LITE_TELEMETRY_INVENTORY_REVISION;
}

export function monthlyTelemetryId(installSecret: string, date: Date): string {
  return createHash('sha256')
    .update(installSecret + date.toISOString().slice(0, 7))
    .digest('hex');
}

/** Registry membership comes from the public catalog, never from a syntactic ID match. */
export function parseStationDailyPing(
  value: unknown,
  publicRegistryIds: readonly string[] = [],
  publicReleaseVersions: readonly string[] = [],
): StationDailyPing {
  if (
    !record(value) ||
    Object.keys(value).length !== Object.keys(STATION_DAILY_FIELDS).length ||
    !onlyKeys(value, Object.keys(STATION_DAILY_FIELDS))
  )
    throw new Error('Invalid station_daily fields');
  const scalar = (
    item: unknown,
    domain: readonly string[] | string,
    max?: number,
  ): boolean => {
    if (Array.isArray(domain))
      return typeof item === 'string' && domain.includes(item);
    if (domain === 'boolean') return typeof item === 'boolean';
    if (domain === 'count')
      return (
        typeof item === 'number' &&
        Number.isInteger(item) &&
        item >= 0 &&
        item <= (max ?? 65535)
      );
    if (domain === 'uuid-v4') return productUuid(item);
    if (domain === 'engine-count-buckets')
      return (
        record(item) &&
        Object.keys(item).length === 2 &&
        onlyKeys(item, ['engine', 'bucket']) &&
        typeof item.engine === 'string' &&
        TELEMETRY_ENGINES.some((engine) => engine === item.engine) &&
        typeof item.bucket === 'string' &&
        TELEMETRY_COUNT_BUCKETS.some((bucket) => bucket === item.bucket)
      );
    if (typeof item !== 'string' || item.length > (max ?? 128)) return false;
    if (domain === 'public-release-version-or-custom')
      return item === 'custom' || publicReleaseVersions.includes(item);
    return (
      (domain === 'public-registry-id-or-none-or-custom' &&
        ['none', 'custom'].includes(item)) ||
      publicRegistryIds.includes(item)
    );
  };
  for (const [field, definition] of Object.entries(STATION_DAILY_FIELDS)) {
    const item = value[field];
    const limit =
      'maxLength' in definition
        ? definition.maxLength
        : 'max' in definition
          ? definition.max
          : undefined;
    if ('arrayMax' in definition) {
      if (
        !Array.isArray(item) ||
        item.length > definition.arrayMax ||
        item.some((entry) => !scalar(entry, definition.domain, limit)) ||
        new Set(item.map((entry) => (record(entry) ? entry.engine : entry)))
          .size !== item.length
      )
        throw new Error(`Invalid station_daily field: ${field}`);
    } else if (!scalar(item, definition.domain, limit))
      throw new Error(`Invalid station_daily field: ${field}`);
  }
  return structuredClone(value) as StationDailyPing;
}

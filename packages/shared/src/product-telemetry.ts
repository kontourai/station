import { createHash } from 'node:crypto';

export {
  USAGE_TELEMETRY_EVENTS,
  type UsageTelemetryEvent,
  type UsageTelemetryProperties,
} from '@kontourai/station-contracts/product-telemetry';

import {
  PRODUCT_TELEMETRY_ENVELOPE,
  type ProductTelemetryBatch,
  type ProductTelemetryBuild,
  type ProductTelemetryObservation,
  type ProductTelemetryPropertyDefinition as PropertyDefinition,
  USAGE_TELEMETRY_EVENTS,
  type UsageTelemetryEvent,
} from '@kontourai/station-contracts/product-telemetry';

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

/** A receipt covers this exact published inventory, not a vague telemetry policy. */
export const USAGE_TELEMETRY_INVENTORY_REVISION = createHash('sha256')
  .update(
    renderUsageTelemetryEnvelopeInventory() +
      '\n\n' +
      renderUsageTelemetryInventory(),
  )
  .digest('hex');

/** Fails loudly if an implementation and the published inventory diverge. */
export function assertUsageTelemetryInventoryContract(
  event: string,
  properties: Record<string, unknown>,
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

/** Strict v1 receiver boundary. Legacy batches require a separate explicit ingestion profile. */
export function parseProductTelemetryBatch(
  value: unknown,
): ProductTelemetryBatch {
  if (
    !record(value) ||
    !onlyKeys(value, Object.keys(PRODUCT_TELEMETRY_ENVELOPE.batch)) ||
    value.schema_version !== 1 ||
    value.inventory_revision !== USAGE_TELEMETRY_INVENTORY_REVISION ||
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
    assertUsageTelemetryInventoryContract(event.event, event.properties);
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

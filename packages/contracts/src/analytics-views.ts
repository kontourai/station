import type { PrivateUsageGroupBy } from './usage-export.js';
export type AnalyticsViewMeasure =
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'reportedCost'
  | 'estimatedCost';
export interface AnalyticsViewSource {
  recipientId: string;
  provider?: string;
  model?: string;
  accountKey?: string;
}
export type AnalyticsViewRange =
  | { kind: 'relative'; days: 7 | 14 | 30 | 90 }
  | { kind: 'fixed'; from: string; to: string };
export interface AnalyticsViewDefinition {
  title: string;
  sources: AnalyticsViewSource[];
  range: AnalyticsViewRange;
  comparison?:
    | { kind: 'previous' }
    | { kind: 'fixed'; from: string; to: string };
  groupBy: PrivateUsageGroupBy;
  measure: AnalyticsViewMeasure;
  timeZone: 'UTC';
}
export interface AnalyticsSavedView {
  id: string;
  revision: number;
  definition: AnalyticsViewDefinition;
  updatedAt: string;
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (
  v: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) =>
  required.every((k) => k in v) &&
  Object.keys(v).every((k) => required.includes(k) || optional.includes(k));
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    v,
  );
const day = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
const fixed = (v: Record<string, unknown>) =>
  day(v.from) &&
  day(v.to) &&
  v.from <= v.to &&
  Date.parse(v.to) - Date.parse(v.from) <= 365 * 86400000;
function definitionShape(v: unknown): v is AnalyticsViewDefinition {
  if (
    !record(v) ||
    !keys(
      v,
      ['title', 'sources', 'range', 'groupBy', 'measure', 'timeZone'],
      ['comparison'],
    ) ||
    !text(v.title, 120) ||
    v.timeZone !== 'UTC' ||
    typeof v.groupBy !== 'string' ||
    !['provider', 'model', 'station', 'day'].includes(v.groupBy) ||
    typeof v.measure !== 'string' ||
    ![
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'reportedCost',
      'estimatedCost',
    ].includes(v.measure) ||
    !Array.isArray(v.sources) ||
    v.sources.length < 1 ||
    v.sources.length > 4
  )
    return false;
  const ids = new Set<string>();
  for (const source of v.sources) {
    if (
      !record(source) ||
      !keys(source, ['recipientId'], ['provider', 'model', 'accountKey']) ||
      !uuid(source.recipientId) ||
      ids.has(source.recipientId) ||
      ['provider', 'model', 'accountKey'].some(
        (k) => source[k] !== undefined && !text(source[k], 200),
      ) ||
      (source.accountKey !== undefined && source.provider === undefined)
    )
      return false;
    ids.add(source.recipientId);
  }
  if (!record(v.range)) return false;
  if (v.range.kind === 'relative') {
    if (
      !keys(v.range, ['kind', 'days']) ||
      ![7, 14, 30, 90].includes(Number(v.range.days)) ||
      typeof v.range.days !== 'number'
    )
      return false;
  } else if (
    v.range.kind !== 'fixed' ||
    !keys(v.range, ['kind', 'from', 'to']) ||
    !fixed(v.range)
  )
    return false;
  if (v.comparison !== undefined) {
    if (!record(v.comparison)) return false;
    if (v.comparison.kind === 'previous') {
      if (!keys(v.comparison, ['kind'])) return false;
    } else if (
      v.comparison.kind !== 'fixed' ||
      !keys(v.comparison, ['kind', 'from', 'to']) ||
      !fixed(v.comparison)
    )
      return false;
  }
  return true;
}
export function parseAnalyticsViewDefinition(
  value: unknown,
): AnalyticsViewDefinition {
  if (!definitionShape(value))
    throw new Error('Invalid analytics view definition');
  return value;
}
export function parseAnalyticsSavedView(value: unknown): AnalyticsSavedView {
  if (
    !record(value) ||
    !keys(value, ['id', 'revision', 'definition', 'updatedAt']) ||
    !uuid(value.id) ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !definitionShape(value.definition) ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt))
  )
    throw new Error('Invalid saved analytics view');
  return {
    id: value.id,
    revision: value.revision,
    definition: value.definition,
    updatedAt: value.updatedAt,
  };
}
/** UTC Station-observation windows; display timezone never rewrites source facts. */
export function resolveAnalyticsViewWindows(
  value: AnalyticsViewDefinition,
  today: string,
) {
  const definition = parseAnalyticsViewDefinition(value);
  if (!day(today)) throw new Error('Invalid observation day');
  const shift = (date: string, days: number) =>
    new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86400000)
      .toISOString()
      .slice(0, 10);
  const primary =
    definition.range.kind === 'fixed'
      ? { from: definition.range.from, to: definition.range.to }
      : { from: shift(today, 1 - definition.range.days), to: today };
  const comparison =
    definition.comparison?.kind === 'fixed'
      ? { from: definition.comparison.from, to: definition.comparison.to }
      : definition.comparison
        ? {
            from: shift(
              primary.from,
              -(
                (Date.parse(primary.to) - Date.parse(primary.from)) / 86400000 +
                1
              ),
            ),
            to: shift(primary.from, -1),
          }
        : undefined;
  if (!fixed(primary) || (comparison && !fixed(comparison)))
    throw new Error('Invalid comparison window');
  return { primary, ...(comparison ? { comparison } : {}) };
}

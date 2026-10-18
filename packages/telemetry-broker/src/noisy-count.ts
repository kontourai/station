import { createHmac } from 'node:crypto';
import { STATION_DAILY_FIELDS } from '@kontourai/station-contracts/product-telemetry';

// Add/remove-one-ping L1 sensitivity: 16 scalar buckets + sets of 5+8+20+8 = 57.
// Empty sets contribute one sentinel, already bounded by their arrayMax.
const sensitivity = Object.entries(STATION_DAILY_FIELDS).reduce(
  (sum, [field, rule]) =>
    sum +
    (field === 'event' || field === 'event_id'
      ? 0
      : 'arrayMax' in rule
        ? rule.arrayMax
        : 1),
  0,
);
const countEpsilon = 1 / sensitivity;

export function noisyCount(
  secret: Buffer,
  publisher: string,
  day: string,
  dimension: string,
  value: string,
  count: number,
): number {
  const seed = createHmac('sha256', secret)
    .update(
      JSON.stringify([
        'station-lite-noise-v1',
        publisher,
        day,
        dimension,
        value,
      ]),
    )
    .digest();
  // Two independent geometric failures-before-success variates give discrete Laplace.
  // Open-interval 52-bit uniforms avoid log(0) and endpoints rounded to one.
  const geometric = (offset: number) => {
    const u =
      (seed.readUIntBE(offset, 6) * 16 + (seed[offset + 6] >>> 4) + 0.5) /
      2 ** 52;
    return Math.floor(-Math.log(u) / countEpsilon);
  };
  return Math.max(0, Math.round(count + geometric(0) - geometric(8)));
}

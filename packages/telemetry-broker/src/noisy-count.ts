import { createHmac } from 'node:crypto';
import { PUBLIC_COUNT_EPSILON } from './public-domain.js';

const countEpsilon = PUBLIC_COUNT_EPSILON;

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
        'station-lite-weekly-noise-v2',
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

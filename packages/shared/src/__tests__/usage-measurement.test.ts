import { describe, expect, it } from 'vitest';
import {
  describeUnreportedMeasurements,
  formatMeasuredCostUsd,
  formatMeasuredTokens,
  UNREPORTED_MEASUREMENT_TEXT,
  unreportedMeasurementClasses,
} from '../usage-measurement.js';

describe('the one unreported-measurement representation (station#3201)', () => {
  it('formats an unreported figure as the shared dash and a reported zero as zero', () => {
    expect(formatMeasuredTokens(undefined)).toBe(UNREPORTED_MEASUREMENT_TEXT);
    expect(formatMeasuredTokens(0)).toBe('0');
    expect(formatMeasuredTokens(1234)).toBe('1,234');

    expect(formatMeasuredCostUsd(undefined)).toBe(UNREPORTED_MEASUREMENT_TEXT);
    // A provider that reported zero cost says so; only absence dashes.
    expect(formatMeasuredCostUsd(0)).toBe('$0.0000');
    expect(formatMeasuredCostUsd(0.0125)).toBe('$0.0125');
  });

  it("discloses nothing for Station's own accounting, where absence is a counted zero", () => {
    expect(unreportedMeasurementClasses({ source: 'station-memory' })).toEqual(
      [],
    );
    expect(
      describeUnreportedMeasurements(
        { source: 'station-memory' },
        () => 'Station',
      ),
    ).toBeNull();
  });

  it('names only the classes actually absent from the response', () => {
    expect(
      unreportedMeasurementClasses({
        source: 'engine-events',
        provider: 'claude',
        inputTokens: 900,
        totalTokens: 1020,
      }),
    ).toEqual(['cost', 'context usage']);

    expect(
      unreportedMeasurementClasses({
        source: 'engine-events',
        provider: 'acp',
        contextTokens: 27_554,
      }),
    ).toEqual(['token counts', 'cost']);

    expect(
      unreportedMeasurementClasses({
        source: 'engine-events',
        provider: 'claude',
        totalTokens: 10,
        costUsd: 0,
        contextTokens: 4,
      }),
    ).toEqual([]);
  });

  it('treats a reported zero as reported, not as a gap to disclose', () => {
    expect(
      unreportedMeasurementClasses({
        source: 'engine-events',
        provider: 'claude',
        inputTokens: 0,
        costUsd: 0,
        contextTokens: 0,
      }),
    ).toEqual([]);
  });

  it('names the engine through the injected label map, falling back to the raw id', () => {
    const label = (provider: string) =>
      provider === 'acp' ? 'Custom engine' : null;

    expect(
      describeUnreportedMeasurements(
        { source: 'engine-events', provider: 'acp', contextTokens: 1 },
        label,
      ),
    ).toBe(
      'Custom engine did not report token counts or cost for this session. Station shows only what the engine measured — it does not estimate these.',
    );

    expect(
      describeUnreportedMeasurements(
        { source: 'engine-events', provider: 'brand-new', contextTokens: 1 },
        label,
      ),
    ).toContain('brand-new did not report');

    expect(
      describeUnreportedMeasurements(
        { source: 'engine-events', contextTokens: 1 },
        label,
      ),
    ).toContain('This session\u2019s engine did not report');
  });

  it('lists three missing classes as a readable series', () => {
    expect(
      describeUnreportedMeasurements(
        { source: 'engine-events', provider: 'muse' },
        () => 'Muse Code',
      ),
    ).toContain('Muse Code did not report token counts, cost or context usage');
  });
});

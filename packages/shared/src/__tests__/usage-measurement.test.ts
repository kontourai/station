import { describe, expect, it } from 'vitest';
import {
  conversationStatsMeasurementView,
  describeUnreportedMeasurements,
  enginesReportingTokensSeparately,
  formatMeasuredCostUsd,
  formatMeasuredTokens,
  UNREPORTED_MEASUREMENT_TEXT,
  unreportedMeasurementClasses,
} from '../usage-measurement.js';

describe('the one unreported-measurement representation (station#3201)', () => {
  it('formats an unreported figure as "Not reported" and a reported zero as zero', () => {
    expect(UNREPORTED_MEASUREMENT_TEXT).toBe('Not reported');
    expect(formatMeasuredTokens(undefined)).toBe('Not reported');
    expect(formatMeasuredTokens(0)).toBe('0');
    expect(formatMeasuredTokens(1234)).toBe('1,234');

    expect(formatMeasuredCostUsd(undefined)).toBe('Not reported');
    // A provider that reported zero cost says so; only absence reads
    // "Not reported".
    expect(formatMeasuredCostUsd(0)).toBe('$0.0000');
    expect(formatMeasuredCostUsd(0.0125)).toBe('$0.0125');
  });

  it("names only token counts for Station's own accounting, and only when none were reported (#5390)", () => {
    // Station prices cost itself and estimates context itself, so neither is
    // something the model failed to report.
    expect(unreportedMeasurementClasses({ source: 'station-memory' })).toEqual([
      'token counts',
    ]);
    expect(
      describeUnreportedMeasurements(
        { source: 'station-memory' },
        () => 'Station',
      ),
    ).toBe('The model did not report token counts for this chat.');
    expect(
      describeUnreportedMeasurements(
        { source: 'station-memory', inputTokens: 0, outputTokens: 0 },
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

  it('counts a cost in the engine\u2019s own unit and the engine\u2019s own context reading as reported', () => {
    expect(
      unreportedMeasurementClasses({
        source: 'engine-events',
        provider: 'acp',
        reportedCostUnits: 1,
        contextPercent: 2.2,
      }),
    ).toEqual(['token counts']);
    expect(
      unreportedMeasurementClasses({
        source: 'engine-events',
        provider: 'acp',
      }),
    ).toEqual(['token counts', 'cost', 'context usage']);
  });

  it('does not call token counts unreported when two engines each reported their own (#5389)', () => {
    const mixed = {
      turns: 2,
      toolCalls: 0,
      estimatedCost: 0.25,
      contextTokens: 900,
      measurement: { source: 'engine-events' as const, provider: 'codex' },
      engines: [
        { provider: 'claude', turns: 1, toolCalls: 0, inputTokens: 14 },
        { provider: 'codex', turns: 1, toolCalls: 0, totalTokens: 790 },
      ],
    };
    expect(
      describeUnreportedMeasurements(
        conversationStatsMeasurementView(mixed),
        () => 'Codex',
      ),
    ).toBeNull();
    // A cache figure is a reported token count too.
    expect(
      unreportedMeasurementClasses(
        conversationStatsMeasurementView({
          ...mixed,
          engines: [
            { provider: 'claude', turns: 1, toolCalls: 0, cacheReadTokens: 9 },
          ],
        }),
      ),
    ).toEqual([]);
    // An engine row without token figures does not stand in for them.
    expect(
      unreportedMeasurementClasses(
        conversationStatsMeasurementView({
          ...mixed,
          engines: [{ provider: 'acp', turns: 2, toolCalls: 0 }],
        }),
      ),
    ).toEqual(['token counts']);
  });
});

describe('enginesReportingTokensSeparately (#5389)', () => {
  const claude = {
    provider: 'claude',
    turns: 1,
    toolCalls: 0,
    inputTokens: 14,
  };
  const codex = { provider: 'codex', turns: 1, toolCalls: 0, totalTokens: 790 };
  const acp = { provider: 'acp', turns: 1, toolCalls: 0 };

  it('lists the engines that reported tokens when there are several', () => {
    expect(
      enginesReportingTokensSeparately({ engines: [claude, acp, codex] }),
    ).toEqual([claude, codex]);
  });

  it('is undefined when the conversation has a single token total', () => {
    expect(enginesReportingTokensSeparately({})).toBeUndefined();
    expect(
      enginesReportingTokensSeparately({ engines: [claude, acp] }),
    ).toBeUndefined();
  });
});

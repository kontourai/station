import { describe, expect, test } from 'vitest';
import { isStationTransportFailure } from '../stationTransportFailure';

describe('isStationTransportFailure', () => {
  test.each([
    'Native Station request failed: Station refused the connection.',
    'TypeError: Failed to fetch',
    'ECONNREFUSED connecting to Station',
  ])('recognizes a Station transport diagnostic: %s', (message) => {
    expect(isStationTransportFailure(new Error(message))).toBe(true);
  });

  test('does not turn an ordinary server failure into an outage claim', () => {
    expect(
      isStationTransportFailure(
        new Error('source session is already being continued'),
      ),
    ).toBe(false);
  });

  test('the generic native prefix alone never claims an outage — it also wraps refusals (#2630 delta, #2645 sol round)', () => {
    expect(
      isStationTransportFailure(
        new Error(
          'Native Station request failed: no host-authorized active Station',
        ),
      ),
    ).toBe(false);
    // But a native TRANSPORT detail behind the same prefix still matches.
    expect(
      isStationTransportFailure(
        new Error(
          'Native Station request failed: Station request timed out before response headers arrived.',
        ),
      ),
    ).toBe(true);
    // Safari's fetch failure phrase is covered.
    expect(isStationTransportFailure(new Error('Load failed'))).toBe(true);
  });
});

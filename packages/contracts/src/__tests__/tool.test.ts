import { describe, expect, it } from 'vitest';
import { EXECUTION_MODE } from '../tool.js';

describe('EXECUTION_MODE (Phase-B vocabulary rename)', () => {
  it('exposes the renamed canonical values', () => {
    expect(EXECUTION_MODE).toEqual({
      EXTERNAL: 'external',
      STATION: 'station',
    });
  });
});

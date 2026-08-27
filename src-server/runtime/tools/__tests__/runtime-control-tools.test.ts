import { describe, expect, test } from 'vitest';

import { SC_READ_ONLY_TOOLS } from '../runtime-control-tools.js';

describe('runtime control tools', () => {
  test('keeps skill listing auto-approved', () => {
    expect(SC_READ_ONLY_TOOLS).toContain('station-control_list_skills');
  });
});

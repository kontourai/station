import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { supervise } from '../../station-dogfood-reconcile.mjs';
import { createFixture } from './fixture.js';

export function registerRecoverySupervision() {
  describe('station dogfood reconcile', () => {
    it('keeps supervising on a 15-second cadence after an individual reconcile fails', async () => {
      const fixture = createFixture({ active: false });
      const outcomes = [
        { action: 'first' },
        new Error('transient'),
        { action: 'third' },
      ];
      const sleep = vi.fn().mockResolvedValue(undefined);
      const errors: string[] = [];

      await supervise(fixture.config, {
        maxIterations: 3,
        registerSignals: false,
        sleep,
        reconcile: () => {
          const next = outcomes.shift();
          if (next instanceof Error) throw next;
          return next;
        },
        reportError: (error) => errors.push(error),
      });

      expect(sleep).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenNthCalledWith(1, 15_000);
      expect(errors).toEqual(['station dogfood reconcile failed: transient']);
      const log = readFileSync(
        path.join(fixture.config.logDir, 'station-update.log'),
        'utf8',
      );
      expect(log).toContain('"action":"first"');
      expect(log).toContain('"action":"third"');
    });
  });
}

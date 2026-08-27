import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLifecycleEvents } from '@kontourai/station-shared/lifecycle-events';
import { describe, expect, it } from 'vitest';
import { createRuntimeProcessLifecycle } from '../runtime-process-lifecycle.js';

describe('runtime process lifecycle', () => {
  it('records actual shutdown and exit evidence with the managed boot identity', () => {
    const file = join(
      mkdtempSync(join(tmpdir(), 'station-runtime-life-')),
      'events.jsonl',
    );
    const lifecycle = createRuntimeProcessLifecycle({
      STATION_LIFECYCLE_JOURNAL: file,
      STATION_INSTANCE_ID: 'phone',
      STATION_BUILD_SHA: 'a'.repeat(40),
      STATION_BOOT_ID: '11111111-1111-4111-8111-111111111111',
    });
    lifecycle.observeShutdown('SIGTERM');
    lifecycle.observeExit(0, null);
    expect(readLifecycleEvents(file)).toMatchObject([
      { type: 'shutdown_observed', reason: 'SIGTERM', sender: 'unknown' },
      { type: 'process_exit', exitCode: 0, signal: null, sender: 'unknown' },
    ]);
  });

  it.each([0, 7])(
    'records direct exit %s exactly once and suppresses duplicate explicit writes',
    (code) => {
      const file = join(
        mkdtempSync(join(tmpdir(), 'station-runtime-exit-')),
        'events.jsonl',
      );
      const lifecycle = createRuntimeProcessLifecycle({
        STATION_LIFECYCLE_JOURNAL: file,
        STATION_INSTANCE_ID: 'phone',
        STATION_BUILD_SHA: 'a'.repeat(40),
        STATION_BOOT_ID: '11111111-1111-4111-8111-111111111111',
      });
      const processEvents = new EventEmitter();
      lifecycle.installExitObserver(processEvents as any);
      processEvents.emit('exit', code);
      lifecycle.observeExit(code);
      expect(
        readLifecycleEvents(file).filter(
          (event) => event.type === 'process_exit',
        ),
      ).toHaveLength(1);
      expect(readLifecycleEvents(file).at(-1)).toMatchObject({
        type: 'process_exit',
        exitCode: code,
      });
    },
  );
});

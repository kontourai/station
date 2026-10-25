import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { readStationHomeRecovery } from '@kontourai/station-shared/station-home-archive';

/** Negative activation fence only; this digest never grants identity or source access. */
export function analyticsHomeActivation(home: string): string {
  const before = lstatSync(home, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink())
    throw new Error('Analytics home activation unavailable');
  const recovery = readStationHomeRecovery(home);
  if (recovery.kind === 'unavailable')
    throw new Error('Analytics home activation unavailable');
  const after = lstatSync(home, { bigint: true });
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  )
    throw new Error('Analytics home activation changed');
  return createHash('sha256')
    .update(
      JSON.stringify([
        'station-analytics-activation/v1',
        before.dev.toString(),
        before.ino.toString(),
        recovery.kind === 'recovered'
          ? recovery.recovery.recoveryId
          : 'original',
      ]),
    )
    .digest('hex');
}

export function captureAnalyticsHomeActivation(home: string) {
  const id = analyticsHomeActivation(home);
  return {
    id,
    assertCurrent() {
      if (analyticsHomeActivation(home) !== id)
        throw new Error('Analytics home activation changed');
    },
  };
}

/** A provenance failure disables private export, without taking generic Station startup down. */
export function analyticsHomeExportActivation(home: string): () => string {
  let activation: ReturnType<typeof captureAnalyticsHomeActivation>;
  try {
    activation = captureAnalyticsHomeActivation(home);
  } catch {
    return () => {
      throw new Error('Analytics home activation unavailable');
    };
  }
  return () => {
    activation.assertCurrent();
    return activation.id;
  };
}

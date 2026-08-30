// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import {
  nativeEngineAdoptionDetection,
  nativeEngineAdoptionSuppressed,
  SUPPRESS_NATIVE_ENGINE_ADOPTION_ENV,
} from '../native-engine-adoption.js';

const containedScreenshotEnv = {
  [SUPPRESS_NATIVE_ENGINE_ADOPTION_ENV]: '1',
  STATION_HOME_SOURCE: '--temp-home',
  STATION_INSTANCE_ID: 'e2e-screenshot-mes5x00-abc123',
};

describe('gallery native-engine adoption containment (#875)', () => {
  it('flag on in the contained screenshot runtime suppresses detection', async () => {
    const realDetection = vi.fn(async () => true);
    const detection = nativeEngineAdoptionDetection(
      containedScreenshotEnv,
      realDetection,
    );

    expect(detection.suppressed).toBe(true);
    await expect(detection.detect('codex')).resolves.toBe(false);
    expect(realDetection).not.toHaveBeenCalled();
  });

  it('flag absent leaves real detection untouched', async () => {
    const realDetection = vi.fn(async () => true);
    const detection = nativeEngineAdoptionDetection(
      {
        STATION_HOME_SOURCE: '--temp-home',
        STATION_INSTANCE_ID: 'e2e-screenshot-mes5x00-abc123',
      },
      realDetection,
    );

    expect(detection.suppressed).toBe(false);
    await expect(detection.detect('codex')).resolves.toBe(true);
    expect(realDetection).toHaveBeenCalledWith('codex');
  });

  it.each([
    {
      name: 'persistent home',
      env: { ...containedScreenshotEnv, STATION_HOME_SOURCE: 'default' },
    },
    {
      name: 'non-screenshot E2E instance',
      env: {
        ...containedScreenshotEnv,
        STATION_INSTANCE_ID: 'e2e-product-mes5x00-abc123',
      },
    },
    {
      name: 'wrong flag value',
      env: {
        ...containedScreenshotEnv,
        [SUPPRESS_NATIVE_ENGINE_ADOPTION_ENV]: 'true',
      },
    },
  ])('requires the full containment conjunction: $name', ({ env }) => {
    expect(nativeEngineAdoptionSuppressed(env)).toBe(false);
  });
});

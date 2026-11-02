// @vitest-environment node

/**
 * #4418: the client decoder over a real browser's WebCodecs, fed access units
 * cut from a recorded Android emulator stream (Constrained Baseline,
 * 1080x2400), from a loopback page (a secure context).
 *
 * A delta sent before the keyframe is dropped, never decoded; the keyframe
 * (with its parameter sets) and the two deltas after it come out as
 * full-size pictures, in order. Where the browser has no H.264 decoder (some
 * Linux Chromium builds), the decoder must say `unsupported` so the viewer
 * falls back to images; that branch is asserted instead, and named.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { splitAnnexB } from '@kontourai/station-contracts/live-surface';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { describe, expect, test } from 'vitest';
import { chromiumIsInstalled } from '../../../../tests/helpers/css-cascade-fixture';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../');
const sample = readFileSync(
  resolve(
    REPO_ROOT,
    'tests/fixtures/live-surface/android-emulator-1080x2400-baseline.h264',
  ),
);

/** Annex-B with 4-byte start codes, as the producer publishes units. */
function annexB(...nals: Uint8Array[]): string {
  return Buffer.concat(
    nals.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), Buffer.from(nal)]),
  ).toString('base64');
}

describe.skipIf(!chromiumIsInstalled(REPO_ROOT))(
  'client H.264 decoding in a real browser (#4418)',
  () => {
    test('decodes the emulator keyframe and its deltas at full size, never a delta first', async () => {
      const output = await build({
        entryPoints: [
          resolve(import.meta.dirname, 'fixtures/videoDecoderHarness.ts'),
        ],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'browser',
        logLevel: 'error',
      });
      const script = output.outputFiles[0]!.text;
      const server = createServer((request, response) => {
        if (request.url === '/harness.js') {
          response.setHeader('Content-Type', 'text/javascript');
          response.end(script);
          return;
        }
        response.setHeader('Content-Type', 'text/html');
        response.end(
          '<!doctype html><script type="module" src="/harness.js"></script>',
        );
      });
      await new Promise<void>((done) =>
        server.listen(0, '127.0.0.1', () => done()),
      );
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.goto(
          `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
        );
        await page.waitForFunction(
          () => typeof window.decodeUnits === 'function',
        );
        const [sps, pps, idr, delta1, delta2] = splitAnnexB(
          new Uint8Array(sample),
        ) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array];
        const result = await page.evaluate(
          (units) => window.decodeUnits(units),
          [
            { keyframe: false, base64: annexB(delta1) },
            { keyframe: true, base64: annexB(sps, pps, idr) },
            { keyframe: false, base64: annexB(delta1) },
            { keyframe: false, base64: annexB(delta2) },
          ],
        );
        expect(result.capable).toBe(true);
        expect(result.errors).toEqual([]);
        if (result.outcomes[1] === 'unsupported') {
          // No H.264 in this browser build: the viewer falls back to images.
          expect(result.outcomes).toEqual([
            'awaiting-keyframe',
            'unsupported',
            'awaiting-keyframe',
            'awaiting-keyframe',
          ]);
          return;
        }
        expect(result.outcomes).toEqual([
          'awaiting-keyframe',
          'decoding',
          'decoding',
          'decoding',
        ]);
        expect(result.pictures).toEqual([
          { width: 1080, height: 2400, seq: 2 },
          { width: 1080, height: 2400, seq: 3 },
          { width: 1080, height: 2400, seq: 4 },
        ]);
      } finally {
        await browser.close();
        await new Promise<void>((done) => server.close(() => done()));
      }
    }, 60_000);
  },
);

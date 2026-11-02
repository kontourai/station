// @vitest-environment node

/**
 * #4418: the client decoder over a real browser's WebCodecs, fed access units
 * cut from a recorded Android emulator stream (Constrained Baseline,
 * 1080x2400), from a loopback page (a secure context).
 *
 * - A delta sent before the keyframe is dropped, never decoded; the keyframe
 *   (with its parameter sets) and the two deltas after it come out as
 *   full-size pictures, in order. A browser with no H.264 decoder (some Linux
 *   Chromium builds) SKIPS this case, named; with `STATION_EXPECT_H264=1` it
 *   fails instead, so a lane that expects decoding cannot pass without it.
 * - A profile the browser refuses (the same stream with an invalid profile
 *   byte) is reported `unsupported`, so the viewer falls back to images.
 * - In a lane that requires Chromium (`chromiumRequired`), a missing browser
 *   fails the suite instead of skipping it.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { splitAnnexB } from '@kontourai/station-contracts/live-surface';
import { type Browser, chromium } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  chromiumIsInstalled,
  chromiumRequired,
} from '../../../../tests/helpers/css-cascade-fixture';

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

const CHROMIUM = chromiumIsInstalled(REPO_ROOT);

if (!CHROMIUM && chromiumRequired())
  test('Playwright Chromium is installed for the decode suite', () => {
    throw new Error(
      'Playwright Chromium is missing in a lane that requires it: run npm run install:playwright',
    );
  });

type Units = { keyframe: boolean; base64: string }[];
type Result = Awaited<ReturnType<Window['decodeUnits']>>;

describe.skipIf(!CHROMIUM)(
  'client H.264 decoding in a real browser (#4418)',
  () => {
    let browser: Browser;
    let server: Server;
    let origin = '';

    beforeAll(async () => {
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
      server = createServer((request, response) => {
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
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      browser = await chromium.launch();
    }, 60_000);

    afterAll(async () => {
      await browser?.close();
      await new Promise<void>((done) => server?.close(() => done()));
    });

    async function decode(units: Units): Promise<Result> {
      const page = await browser.newPage();
      try {
        await page.goto(origin);
        await page.waitForFunction(
          () => typeof window.decodeUnits === 'function',
        );
        return await page.evaluate((list) => window.decodeUnits(list), units);
      } finally {
        await page.close();
      }
    }

    const [sps, pps, idr, delta1, delta2] = splitAnnexB(
      new Uint8Array(sample),
    ) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array];

    test('decodes the emulator keyframe and its deltas at full size, never a delta first', async (context) => {
      const result = await decode([
        { keyframe: false, base64: annexB(delta1) },
        { keyframe: true, base64: annexB(sps, pps, idr) },
        { keyframe: false, base64: annexB(delta1) },
        { keyframe: false, base64: annexB(delta2) },
      ]);
      expect(result.capable).toBe(true);
      if (result.outcomes[1] === 'unsupported') {
        if (process.env.STATION_EXPECT_H264 === '1')
          throw new Error(
            'STATION_EXPECT_H264=1, but this browser refused Constrained Baseline H.264',
          );
        context.skip(
          'this browser build has no H.264 decoder; set STATION_EXPECT_H264=1 where it must',
        );
      }
      expect(result.errors).toEqual([]);
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
    }, 60_000);

    test('a profile the browser refuses is reported unsupported, and nothing decodes', async () => {
      // The same SPS with profile_idc 1, which no H.264 profile uses.
      const refused = Uint8Array.from(sps);
      refused[1] = 0x01;
      const result = await decode([
        { keyframe: true, base64: annexB(refused, pps, idr) },
        { keyframe: false, base64: annexB(delta1) },
      ]);
      expect(result.capable).toBe(true);
      expect(result.outcomes).toEqual(['unsupported', 'awaiting-keyframe']);
      expect(result.pictures).toEqual([]);
    }, 60_000);
  },
);

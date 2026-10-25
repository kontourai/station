import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import { runSurfaceCommand } from '../commands/surfaces.js';

let home: string, base: string, server: ReturnType<typeof serve>;
let uploaded: Uint8Array | undefined,
  id: string | undefined,
  unavailable: boolean,
  statusReads: number;
const makeTempDir = trackTempDirs();
const output = vi.spyOn(console, 'log').mockImplementation(() => {});
const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
const manifest = {
  schema: 'station.walkthrough/v1',
  id: 'w1',
  createdAt: '2026-10-24T00:00:00Z',
  source: { adapter: 'test', adapterVersion: '1', durationMs: 1000 },
  capture: { platform: 'unknown' },
  coverage: {
    transcript: 'absent',
    frames: 'absent',
    marks: 'absent',
    elements: 'absent',
    route: 'absent',
    console: 'absent',
    network: 'absent',
  },
  events: [],
};
beforeEach(async () => {
  output.mockClear();
  errors.mockClear();
  uploaded = undefined;
  id = undefined;
  unavailable = false;
  statusReads = 0;
  home = makeTempDir('station-walkthrough-cli-');
  await writeFile(join(home, 'review.mp4'), 'raw local recording');
  const app = new Hono();
  app.use('*', async (c, next) => {
    expect(c.req.header('authorization')).toBe(
      'Bearer test-walkthrough-credential',
    );
    await next();
  });
  app.post('/api/projects/alpha/walkthroughs/import', async (c) => {
    expect(c.req.query('filename')).toBe('review.mp4');
    id = c.req.header('x-walkthrough-request-id');
    uploaded = new Uint8Array(await c.req.arrayBuffer());
    return c.json(
      { success: true, data: { operation: { status: 'accepted' } } },
      202,
    );
  });
  app.get('/api/projects/alpha/walkthroughs/imports/:id', (c) => {
    statusReads++;
    expect(c.req.param('id')).toBe(id);
    return c.json({
      success: true,
      data: {
        operation: { status: unavailable ? 'failed' : 'succeeded' },
        outcome: unavailable
          ? {
              status: 'unavailable',
              reason: 'needs-consent',
              downloads: [
                { component: 'speech-model', version: 'v1', bytes: 1234 },
              ],
            }
          : { status: 'imported', id: 'w1' },
      },
    });
  });
  app.get('/api/projects/alpha/walkthroughs', (c) =>
    c.json({
      success: true,
      data: { items: [{ id: 'w1' }], nextCursor: 'w1' },
    }),
  );
  app.get('/api/projects/alpha/walkthroughs/w1', (c) =>
    c.json({ success: true, data: manifest }),
  );
  base = await new Promise((resolve) => {
    server = serve(
      { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
      (info) => resolve(`http://127.0.0.1:${info.port}`),
    );
  });
});
afterEach(async () => {
  setClientCredentialResolver(undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const target = () => [
  `--api-base=${base}`,
  '--credential=test-walkthrough-credential',
];
test('CLI dispatch uploads local bytes, follows the operation, then reads list and manifest through SDK', async () => {
  await runSurfaceCommand('walkthrough', [
    'import',
    join(home, 'review.mp4'),
    '--project',
    'alpha',
    ...target(),
  ]);
  expect(Buffer.from(uploaded!).toString()).toBe('raw local recording');
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  expect(statusReads).toBe(1);
  expect(output).toHaveBeenLastCalledWith('w1');
  await runSurfaceCommand('walkthrough', [
    'list',
    '--project=alpha',
    ...target(),
  ]);
  expect(JSON.parse(output.mock.calls.at(-1)![0]).items).toEqual([
    { id: 'w1' },
  ]);
  await runSurfaceCommand('walkthrough', [
    'show',
    'w1',
    '--project',
    'alpha',
    ...target(),
  ]);
  expect(JSON.parse(output.mock.calls.at(-1)![0])).toEqual(manifest);
});
test('CLI preserves download sizes and the consent remedy instead of printing an id', async () => {
  unavailable = true;
  await expect(
    runSurfaceCommand('walkthrough', [
      'import',
      join(home, 'review.mp4'),
      '--project',
      'alpha',
      ...target(),
    ]),
  ).rejects.toThrow(
    'speech-model v1 (1234 bytes). Run station media-tools download --yes',
  );
  expect(output).not.toHaveBeenCalled();
});

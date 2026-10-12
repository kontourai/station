/**
 * A project icon set or changed after creation (`PUT /:slug`), and at
 * creation (`POST /`), over real storage: the route validates with the
 * contracts rule (`projectIconProblem`), the service persists or clears, and
 * the assertions read the record back from the file store the writer wrote.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROJECT_ICON_MAX_IMAGE_BYTES,
  PROJECT_ICON_PROBLEM_MESSAGES,
} from '@kontourai/station-contracts/project';
import { describe, expect, test } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { putProject } from '../../../domain/__tests__/file-storage-test-helpers.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { ProjectService } from '../../../services/projects/project-service.js';
import { createProjectRoutes } from '../projects.js';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** The shape discovery and the picker produce: a base64 PNG data URL. */
function pngDataUrl(byteLength: number): string {
  const bytes = Buffer.alloc(byteLength);
  Buffer.from(PNG_SIGNATURE).copy(bytes);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

const makeTempDir = trackTempDirs();

function tempDir(): string {
  return makeTempDir('station-project-icon-');
}

async function harness(storedIcon?: string) {
  const home = tempDir();
  const storage = new FileStorageAdapter(home);
  const app = createProjectRoutes(
    new ProjectService(storage) as any,
    storage as any,
    home,
    { listAgents: async () => [] },
  );
  await putProject(storage, {
    id: 'project-icon',
    slug: 'demo',
    name: 'Demo',
    ...(storedIcon === undefined ? {} : { icon: storedIcon }),
    workingDirectory: tempDir(),
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  });
  /** The record as the file store holds it, not as the route echoed it. */
  const stored = () =>
    JSON.parse(
      readFileSync(join(home, 'projects', 'demo', 'project.json'), 'utf8'),
    ) as Record<string, unknown>;
  const put = (body: Record<string, unknown>) =>
    app.request('/demo', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { app, storage, stored, put };
}

describe('PUT /:slug sets and clears the icon', () => {
  test('a picked image is persisted, then replaced by a glyph', async () => {
    const { stored, put } = await harness();
    const image = pngDataUrl(512);

    const first = await put({ icon: image });
    expect(first.status).toBe(200);
    expect(stored().icon).toBe(image);

    const second = await put({ icon: '🧭' });
    expect(second.status).toBe(200);
    expect(stored().icon).toBe('🧭');
  });

  test.each([
    ['an empty string (the settings form’s None)', ''],
    ['null (an API clear)', null],
  ])('%s clears a stored icon instead of storing it', async (_label, clear) => {
    const { stored, put } = await harness('🧭');
    const response = await put({ icon: clear });
    expect(response.status).toBe(200);
    expect(stored()).not.toHaveProperty('icon');
    expect((await json(response)).data).not.toHaveProperty('icon');
  });

  test('an update that does not name the icon keeps the stored one', async () => {
    // Including a legacy value the rule now refuses: renaming must not
    // depend on re-validating an icon the caller did not send.
    const { stored, put } = await harness('https://example.com/legacy.png');
    const response = await put({ name: 'Renamed' });
    expect(response.status).toBe(200);
    expect(stored()).toMatchObject({
      name: 'Renamed',
      icon: 'https://example.com/legacy.png',
    });
  });

  test('an image at the byte bound is accepted', async () => {
    const { stored, put } = await harness();
    const image = pngDataUrl(PROJECT_ICON_MAX_IMAGE_BYTES);
    expect((await put({ icon: image })).status).toBe(200);
    expect(stored().icon).toBe(image);
  });
});

describe('PUT /:slug refuses what the rule refuses, and stores nothing', () => {
  test.each([
    [
      'a local absolute path',
      '/Users/me/secrets/logo.png',
      PROJECT_ICON_PROBLEM_MESSAGES['glyph-shape'],
    ],
    [
      'a remote URL',
      'https://example.com/logo.png',
      PROJECT_ICON_PROBLEM_MESSAGES['glyph-shape'],
    ],
    [
      'an image one byte past the bound',
      pngDataUrl(PROJECT_ICON_MAX_IMAGE_BYTES + 1),
      PROJECT_ICON_PROBLEM_MESSAGES['image-too-large'],
    ],
    [
      'an SVG',
      'data:image/svg+xml;base64,PHN2Zy8+',
      PROJECT_ICON_PROBLEM_MESSAGES['image-type'],
    ],
    [
      'a glyph one past the bound',
      'x'.repeat(17),
      PROJECT_ICON_PROBLEM_MESSAGES['glyph-too-long'],
    ],
  ])('%s', async (_label, icon, message) => {
    const { stored, put } = await harness('🧭');
    const response = await put({ icon });
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.details.fieldErrors.icon).toEqual([message]);
    expect(stored().icon).toBe('🧭');
  });
});

describe('POST / applies the same rule at creation', () => {
  test('a glyph is stored and a local path is refused', async () => {
    const { app, storage } = await harness();
    const create = (body: Record<string, unknown>) =>
      app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No folder: a named one needs a filesystem grant this test is not
        // about; the project lands in its Station-managed default.
        body: JSON.stringify(body),
      });

    const refused = await create({
      name: 'Leaky',
      slug: 'leaky',
      icon: '/Users/me/secrets/logo.png',
    });
    expect(refused.status).toBe(400);
    expect(storage.listProjects().map((project) => project.slug)).not.toContain(
      'leaky',
    );

    const created = await create({ name: 'Glyph', slug: 'glyph', icon: '🚀' });
    expect(created.status).toBe(201);
    expect(storage.getProject('glyph').icon).toBe('🚀');

    const cleared = await create({ name: 'Plain', slug: 'plain', icon: '' });
    expect(cleared.status).toBe(201);
    expect(storage.getProject('plain')).not.toHaveProperty('icon');
  });
});

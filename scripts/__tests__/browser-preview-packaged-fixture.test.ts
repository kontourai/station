import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { waitForProductionIdentity } from '../browser-preview-packaged-fixture.mjs';
import {
  assertPackagedStationApp,
  createFixtureHome,
  createRetainedEvidenceSink,
  FIXTURE_MARKER,
  FIXTURE_PROJECT_ID,
  FIXTURE_PROJECT_SLUG,
  fixtureCodingLayout,
  fixtureHtml,
  fixtureProject,
  MAX_BROWSER_PREVIEW_FRAME_SAMPLES,
  MAX_BROWSER_PREVIEW_RESOURCE_TYPES,
  parseBrowserPreviewMeasurement,
  removeFixtureHome,
  startLoopbackFixture,
} from '../lib/browser-preview-packaged-fixture.mjs';
import { redactVerificationOutput } from '../lib/verification-redaction.mjs';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('packaged Browser Preview fixture', () => {
  test('seeds one exact project and coding layout under an owned Station home', async () => {
    const home = await createFixtureHome();
    roots.push(home);

    expect(
      JSON.parse(readFileSync(join(home, FIXTURE_MARKER), 'utf8')),
    ).toMatchObject({ schemaVersion: 1, root: realpathSync(home) });
    expect(
      JSON.parse(
        readFileSync(
          join(home, 'projects', FIXTURE_PROJECT_SLUG, 'project.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      id: FIXTURE_PROJECT_ID,
      slug: FIXTURE_PROJECT_SLUG,
      workingDirectory: join(home, 'workspace'),
    });
    expect(
      JSON.parse(
        readFileSync(
          join(
            home,
            'projects',
            FIXTURE_PROJECT_SLUG,
            'layouts',
            'coding.json',
          ),
          'utf8',
        ),
      ),
    ).toMatchObject({
      id: 'builtin:coding',
      type: 'coding',
      config: {},
    });
  });

  test('serves numeric-loopback controls without recording typed fixture input', async () => {
    const home = await createFixtureHome();
    roots.push(home);
    const fixture = await startLoopbackFixture(home);
    try {
      expect(fixture.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const page = await fetch(fixture.endpoint);
      expect(await page.text()).toContain('Station Browser Preview Fixture');
      const submitted = await fetch(
        `${fixture.endpoint}echo?fixtureInput=private-text`,
      );
      expect(submitted.ok).toBe(true);
      await fixture.flush();
      const events = readFileSync(fixture.eventsPath, 'utf8');
      expect(events).toContain('input-submitted');
      expect(events).toContain('"length":12');
      expect(events).not.toContain('private-text');
      expect(events).not.toContain('127.0.0.1');
    } finally {
      await fixture.close();
    }
  });

  test('records only bounded URL-free Browser Preview page measurements', async () => {
    const home = await createFixtureHome();
    roots.push(home);
    const fixture = await startLoopbackFixture(home);
    try {
      const response = await fetch(`${fixture.endpoint}observation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'browser-preview-page-v1',
          initialRafDeltasMs: Array.from(
            { length: MAX_BROWSER_PREVIEW_FRAME_SAMPLES + 4 },
            (_, index) => index + 0.1234,
          ),
          resizeToRafMs: [4.5678],
          viewportSampleCount: 2,
          resourceInitiators: Array.from(
            { length: MAX_BROWSER_PREVIEW_RESOURCE_TYPES + 4 },
            (_, index) => ({ type: `script-${index}`, count: index + 1 }),
          ),
        }),
      });
      expect(response.status).toBe(204);
      await fixture.flush();
      const events = readFileSync(fixture.eventsPath, 'utf8');
      expect(events).toContain('browser-preview-measurement');
      expect(events).not.toContain(fixture.endpoint);
      expect(events).not.toContain('http://');
      const measurement = JSON.parse(
        events.split('\n').filter(Boolean).at(-1)!,
      );
      expect(measurement.initialRafDeltasMs).toHaveLength(
        MAX_BROWSER_PREVIEW_FRAME_SAMPLES,
      );
      expect(measurement.resourceInitiators).toHaveLength(
        MAX_BROWSER_PREVIEW_RESOURCE_TYPES,
      );
    } finally {
      await fixture.close();
    }
  });

  test('rejects malformed Browser Preview measurements and bounds parsed samples', () => {
    expect(parseBrowserPreviewMeasurement(null)).toBeNull();
    expect(
      parseBrowserPreviewMeasurement({
        type: 'browser-preview-page-v1',
        initialRafDeltasMs: [1.23456, -1, Number.NaN],
        resizeToRafMs: [2.34567],
        viewportSampleCount: 1,
        resourceInitiators: [
          { type: 'script', count: 3 },
          { type: 'https-url-is-not-an-initiator', count: -1 },
        ],
      }),
    ).toEqual({
      type: 'browser-preview-measurement',
      initialRafDeltasMs: [1.235],
      resizeToRafMs: [2.346],
      viewportSampleCount: 1,
      resourceInitiators: [{ type: 'script', count: 3 }],
    });
  });

  test('refuses cleanup unless the exact owned marker remains present', async () => {
    const root = mkdtempSync(
      join(tmpdir(), 'station-browser-preview-fixture-'),
    );
    roots.push(root);
    await expect(removeFixtureHome(root)).rejects.toThrow('fixture marker');
  });

  test('caps every retained HTTP evidence artifact by events and bytes', async () => {
    const home = await createFixtureHome();
    roots.push(home);
    const fixture = await startLoopbackFixture(home);
    try {
      for (let index = 0; index < 80; index += 1) {
        await fetch(`${fixture.endpoint}echo?fixtureInput=${'x'.repeat(80)}`);
      }
      await fixture.flush();
      const retained = readFileSync(fixture.eventsPath);
      const stats = fixture.evidenceStats();
      expect(stats.events).toBeLessThanOrEqual(stats.maxEvents);
      expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes);
      expect(retained.byteLength).toBe(stats.bytes);
    } finally {
      await fixture.close();
    }
  });

  test('uses canonical verification redaction before bounding desktop or HTTP evidence', async () => {
    const root = mkdtempSync(
      join(tmpdir(), 'station-browser-preview-fixture-'),
    );
    roots.push(root);
    const evidencePath = join(root, 'retained.ndjson');
    const secret = 'fixture-internal-capability-should-not-survive';
    const githubToken = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    const sink = await createRetainedEvidenceSink(evidencePath, {
      maxEvents: 2,
      maxBytes: 512,
    });
    const firstRecord = {
      text: `Authorization: Bearer ${secret} url=https://user:pass@example.test/path?token=${secret} native=/Users/fixture/private.txt`,
      token: 'json-token-must-not-survive',
    };
    const secondRecord = {
      text: `x-station-internal-token=another-secret ${githubToken}`,
    };
    await sink.append(firstRecord);
    await sink.append(secondRecord);
    await sink.append({ text: 'must not be appended' });
    await sink.close();

    const retained = readFileSync(evidencePath, 'utf8');
    expect(retained).toBe(
      `${redactVerificationOutput(JSON.stringify(firstRecord))}\n${redactVerificationOutput(JSON.stringify(secondRecord))}\n`,
    );
    expect(retained).not.toContain(secret);
    expect(retained).not.toContain('another-secret');
    expect(retained).not.toContain('json-token-must-not-survive');
    expect(retained).not.toContain(githubToken);
    expect(retained).not.toContain('user:pass@');
    expect(retained.split('\n').filter(Boolean)).toHaveLength(2);
    expect(statSync(evidencePath).size).toBeLessThanOrEqual(512);
  });

  test('requires the authenticated production identity triple, not an unrelated 200', async () => {
    const expected = {
      instanceId: 'browser-preview-instance',
      sha: 'a'.repeat(40),
      bootId: '11111111-1111-4111-8111-111111111111',
    };
    const token = 'fixture-production-token';
    const request = async (
      _url: string | Request | URL,
      init?: RequestInit,
    ) => {
      expect(init?.headers).toMatchObject({
        'x-station-internal-token': token,
        'x-station-proxy-caller': 'local',
      });
      return new Response(JSON.stringify({ ...expected, bootId: 'other' }), {
        status: 200,
      });
    };
    await expect(
      waitForProductionIdentity('http://127.0.0.1:4444', expected, token, {
        deadlineMs: 1,
        request,
      }),
    ).rejects.toThrow('expected authenticated identity');
  });

  test('refuses marker and home symlink cleanup plus copied-marker substitution', async () => {
    const home = await createFixtureHome();
    const otherHome = await createFixtureHome();
    roots.push(home, otherHome);
    const marker = join(home, FIXTURE_MARKER);
    rmSync(marker);
    symlinkSync(join(home, 'workspace', 'README.md'), marker);
    await expect(removeFixtureHome(home)).rejects.toThrow(
      'regular fixture marker',
    );
    expect(statSync(join(home, 'workspace', 'README.md')).isFile()).toBe(true);

    rmSync(marker);
    writeFileSync(marker, readFileSync(join(otherHome, FIXTURE_MARKER)));
    await expect(removeFixtureHome(home)).rejects.toThrow(
      'unknown fixture marker',
    );

    const link = `${home}-link`;
    symlinkSync(otherHome, link);
    roots.push(link);
    await expect(removeFixtureHome(link)).rejects.toThrow(
      'symlink fixture root',
    );
  });

  test('keeps fixture values explicit and independent of ambient homes', () => {
    expect(fixtureProject('/tmp/fixture-home').id).toBe(FIXTURE_PROJECT_ID);
    expect(fixtureCodingLayout().slug).toBe('coding');
    expect(fixtureHtml()).toContain('Attempt remote redirect');
    expect(fixtureHtml()).toContain('Attempt download');
    expect(fixtureHtml()).toContain('Attempt popup');
    expect(fixtureHtml()).toContain('resizeToRafMs');
  });

  test('accepts the packaged lowercase Tauri binary rather than the display name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-browser-preview-app-'));
    roots.push(root);
    const app = join(root, 'Station.app');
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    mkdirSync(join(app, 'Contents', 'Resources', 'dist-server'), {
      recursive: true,
    });
    writeFileSync(join(app, 'Contents', 'MacOS', 'station'), 'fixture');
    writeFileSync(
      join(app, 'Contents', 'Resources', 'dist-server', 'station-build.json'),
      JSON.stringify({ sha: 'a'.repeat(40) }),
    );

    await expect(assertPackagedStationApp(app)).resolves.toMatchObject({
      app,
      executable: join(app, 'Contents', 'MacOS', 'station'),
      buildSha: 'a'.repeat(40),
    });
  });
});

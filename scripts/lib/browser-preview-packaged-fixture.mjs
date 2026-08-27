import {
  constants,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { redactVerificationOutput } from './verification-redaction.mjs';

export const FIXTURE_SCHEMA_VERSION = 1;
export const FIXTURE_PROJECT_ID = '00000000-0000-4000-8000-000000002411';
export const FIXTURE_PROJECT_SLUG = 'browser-preview-fixture';
export const FIXTURE_MARKER = '.station-browser-preview-fixture.json';
export const MAX_RETAINED_EVENTS = 64;
export const MAX_RETAINED_BYTES = 32 * 1024;
export const MAX_BROWSER_PREVIEW_FRAME_SAMPLES = 24;
export const MAX_BROWSER_PREVIEW_RESOURCE_TYPES = 12;
export const MAX_BROWSER_PREVIEW_VIEWPORT_SAMPLES = 24;

const FIXTURE_ROOT_PREFIX = 'station-browser-preview-fixture-';
const FULL_GIT_SHA = /^[0-9a-f]{40}$/i;

function boundedMilliseconds(value, maximum = 10_000) {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= maximum
    ? Math.round(value * 1_000) / 1_000
    : null;
}

function boundedCount(value, maximum) {
  return Number.isInteger(value) && value >= 0 && value <= maximum
    ? value
    : null;
}

/**
 * The loopback page can report browser-derived timing only. This parser keeps
 * it bounded and URL-free so a hostile page cannot turn the fixture event log
 * into an unbounded artifact or a substitute for a native-host observation.
 */
export function parseBrowserPreviewMeasurement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value;
  if (record.type !== 'browser-preview-page-v1') return null;
  const initialRafDeltasMs = Array.isArray(record.initialRafDeltasMs)
    ? record.initialRafDeltasMs
        .slice(0, MAX_BROWSER_PREVIEW_FRAME_SAMPLES)
        .map((sample) => boundedMilliseconds(sample))
        .filter((sample) => sample !== null)
    : [];
  const resizeToRafMs = Array.isArray(record.resizeToRafMs)
    ? record.resizeToRafMs
        .slice(0, MAX_BROWSER_PREVIEW_FRAME_SAMPLES)
        .map((sample) => boundedMilliseconds(sample))
        .filter((sample) => sample !== null)
    : [];
  const viewportSampleCount = boundedCount(
    record.viewportSampleCount,
    MAX_BROWSER_PREVIEW_VIEWPORT_SAMPLES,
  );
  if (viewportSampleCount === null) return null;
  const resourceInitiators = Array.isArray(record.resourceInitiators)
    ? record.resourceInitiators
        .slice(0, MAX_BROWSER_PREVIEW_RESOURCE_TYPES)
        .flatMap((candidate) => {
          if (
            !candidate ||
            typeof candidate !== 'object' ||
            Array.isArray(candidate)
          )
            return [];
          const type = candidate.type;
          const count = boundedCount(candidate.count, 1_000);
          return typeof type === 'string' &&
            /^[a-z][a-z0-9-]{0,31}$/.test(type) &&
            count !== null
            ? [{ type, count }]
            : [];
        })
    : [];
  return {
    type: 'browser-preview-measurement',
    initialRafDeltasMs,
    resizeToRafMs,
    viewportSampleCount,
    resourceInitiators,
  };
}

function browserPreviewMeasurementScript() {
  return `<script>
(() => {
  const maxFrames = ${MAX_BROWSER_PREVIEW_FRAME_SAMPLES};
  const maxResources = ${MAX_BROWSER_PREVIEW_RESOURCE_TYPES};
  const maxViewports = ${MAX_BROWSER_PREVIEW_VIEWPORT_SAMPLES};
  const initialRafDeltasMs = [];
  const resizeToRafMs = [];
  let viewportSampleCount = 0;
  let previousFrame;
  let sentInitial = false;
  const rounded = (value) => Math.round(value * 1000) / 1000;
  const resourceInitiators = () => {
    const counts = new Map();
    for (const entry of performance.getEntriesByType('resource')) {
      const type = typeof entry.initiatorType === 'string' ? entry.initiatorType : 'other';
      counts.set(type, (counts.get(type) || 0) + 1);
    }
    return [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, maxResources)
      .map(([type, count]) => ({ type, count }));
  };
  const report = () => {
    const body = JSON.stringify({
      type: 'browser-preview-page-v1',
      initialRafDeltasMs,
      resizeToRafMs,
      viewportSampleCount,
      resourceInitiators: resourceInitiators(),
    });
    fetch('/observation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  };
  const sampleFrame = (timestamp) => {
    if (previousFrame !== undefined && initialRafDeltasMs.length < maxFrames)
      initialRafDeltasMs.push(rounded(timestamp - previousFrame));
    previousFrame = timestamp;
    if (initialRafDeltasMs.length < maxFrames) {
      requestAnimationFrame(sampleFrame);
    } else if (!sentInitial) {
      sentInitial = true;
      report();
    }
  };
  addEventListener('resize', () => {
    if (viewportSampleCount >= maxViewports || resizeToRafMs.length >= maxFrames)
      return;
    viewportSampleCount += 1;
    const observedAt = performance.now();
    requestAnimationFrame((paintAt) => {
      if (resizeToRafMs.length < maxFrames)
        resizeToRafMs.push(rounded(Math.max(0, paintAt - observedAt)));
    });
  });
  addEventListener('pagehide', report, { once: true });
  requestAnimationFrame(sampleFrame);
})();
</script>`;
}

/** A no-follow, bounded NDJSON sink shared by HTTP and packaged desktop logs. */
export async function createRetainedEvidenceSink(
  path,
  { maxBytes = MAX_RETAINED_BYTES, maxEvents = MAX_RETAINED_EVENTS } = {},
) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Retained evidence maxBytes must be a positive integer.');
  }
  if (!Number.isInteger(maxEvents) || maxEvents < 1) {
    throw new Error('Retained evidence maxEvents must be a positive integer.');
  }
  const descriptor = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let bytes = 0;
  let events = 0;
  let writes = Promise.resolve();
  return {
    append(record) {
      writes = writes.then(async () => {
        if (events >= maxEvents || bytes >= maxBytes) return false;
        const line = Buffer.from(
          `${redactVerificationOutput(JSON.stringify(record))}\n`,
          'utf8',
        );
        const remaining = maxBytes - bytes;
        if (line.byteLength > remaining) return false;
        await descriptor.write(line);
        bytes += line.byteLength;
        events += 1;
        return true;
      });
      return writes;
    },
    async flush() {
      await writes;
    },
    async close() {
      await writes;
      await descriptor.close();
    },
    stats() {
      return { bytes, events, maxBytes, maxEvents };
    },
  };
}

export function fixtureProject(home, now = '2026-01-01T00:00:00.000Z') {
  return {
    id: FIXTURE_PROJECT_ID,
    name: 'Browser Preview Fixture',
    slug: FIXTURE_PROJECT_SLUG,
    description:
      'Owned, bounded loopback fixture for packaged Browser Preview verification.',
    workingDirectory: join(home, 'workspace'),
    knowledgeNamespaces: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function fixtureCodingLayout(now = '2026-01-01T00:00:00.000Z') {
  return {
    id: 'builtin:coding',
    projectSlug: FIXTURE_PROJECT_SLUG,
    slug: 'coding',
    name: 'Coding',
    type: 'coding',
    config: {},
    createdAt: now,
    updatedAt: now,
  };
}

export function fixtureHtml() {
  return `<!doctype html>
<html lang="en">
  <meta charset="utf-8">
  <title>Station Browser Preview Fixture</title>
  <body>
    <main>
      <h1>Station Browser Preview Fixture</h1>
      <p id="identity">numeric-loopback fixture</p>
      <form action="/echo" method="get">
        <label>Fixture input <input name="fixtureInput" value="" autocomplete="off"></label>
        <button type="submit">Submit fixture input</button>
      </form>
      <p><a href="/same-origin" id="same-origin">Navigate same origin</a></p>
      <p><a href="/redirect-remote" id="redirect-remote">Attempt remote redirect</a></p>
      <p><a href="/fixture-download.txt" download id="fixture-download">Attempt download</a></p>
      <button type="button" id="fixture-popup" onclick="window.open('/popup', '_blank')">Attempt popup</button>
    </main>
    ${browserPreviewMeasurementScript()}
  </body>
</html>`;
}

function responseHtml(title, body) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><body><main><h1>${title}</h1>${body}<p><a href="/">Return to fixture</a></p></main></body></html>`;
}

/**
 * Starts the only non-Station server used by the physical fixture.  It binds
 * a numeric loopback address, emits a bounded event record, and deliberately
 * offers controls that exercise the native navigation/popup/download policy.
 */
export async function startLoopbackFixture(root) {
  const eventsPath = join(root, 'fixture-events.ndjson');
  const evidence = await createRetainedEvidenceSink(eventsPath);
  const record = (event) =>
    evidence.append({ at: new Date().toISOString(), ...event });
  await record({ type: 'fixture-started' });
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const finish = (status, headers, body) => {
      void record({
        type: 'http',
        method: request.method,
        path: requestUrl.pathname,
        status,
      });
      response.writeHead(status, headers);
      response.end(body);
    };
    if (requestUrl.pathname === '/') {
      finish(
        200,
        {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
        fixtureHtml(),
      );
      return;
    }
    if (requestUrl.pathname === '/same-origin') {
      finish(
        200,
        {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
        responseHtml(
          'Same-origin navigation reached',
          '<p id="same-origin-reached">same origin retained</p>',
        ),
      );
      return;
    }
    if (requestUrl.pathname === '/echo') {
      const submitted = requestUrl.searchParams.get('fixtureInput') ?? '';
      // The event records only the length, never arbitrary typed text.
      void record({ type: 'input-submitted', length: submitted.length });
      finish(
        200,
        {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
        responseHtml(
          'Fixture input accepted',
          '<p id="fixture-input-accepted">fixture input submitted</p>',
        ),
      );
      return;
    }
    if (requestUrl.pathname === '/observation' && request.method === 'POST') {
      let body = '';
      let receivedBytes = 0;
      request.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes <= 8 * 1024) body += chunk.toString('utf8');
      });
      request.on('end', () => {
        const measurement =
          receivedBytes <= 8 * 1024
            ? parseBrowserPreviewMeasurement(
                (() => {
                  try {
                    return JSON.parse(body);
                  } catch {
                    return null;
                  }
                })(),
              )
            : null;
        void record(
          measurement ?? {
            type: 'browser-preview-measurement-rejected',
            reason: receivedBytes > 8 * 1024 ? 'body-too-large' : 'invalid',
          },
        );
        response.writeHead(measurement ? 204 : 400, {
          'cache-control': 'no-store',
        });
        response.end();
      });
      return;
    }
    if (requestUrl.pathname === '/redirect-remote') {
      finish(
        302,
        { location: 'https://example.com/', 'cache-control': 'no-store' },
        'redirect denied by preview policy',
      );
      return;
    }
    if (requestUrl.pathname === '/fixture-download.txt') {
      finish(
        200,
        {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="fixture-download.txt"',
          'cache-control': 'no-store',
        },
        'Station Browser Preview download fixture\n',
      );
      return;
    }
    if (requestUrl.pathname === '/popup') {
      finish(
        200,
        {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
        responseHtml(
          'Popup reached',
          '<p id="popup-reached">A popup should not be created by the native host.</p>',
        ),
      );
      return;
    }
    finish(
      404,
      {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
      'not found',
    );
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('The loopback fixture did not obtain a numeric TCP port.');
  }
  const endpoint = `http://127.0.0.1:${address.port}/`;
  // Keep the numeric-loopback URL available to the operator only. Retained
  // evidence records the fixture state, never a navigation target.
  await record({ type: 'fixture-listening', interface: 'numeric-loopback' });
  return {
    endpoint,
    eventsPath,
    flush() {
      return evidence.flush();
    },
    evidenceStats() {
      return evidence.stats();
    },
    async close() {
      await new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
      await evidence.close();
    },
  };
}

export async function createFixtureHome() {
  const root = await mkdtemp(join(tmpdir(), FIXTURE_ROOT_PREFIX));
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('Fixture mkdtemp root must be a real directory.');
  }
  const canonicalRoot = await realpath(root);
  const now = new Date().toISOString();
  await mkdir(join(root, 'workspace'), { recursive: true, mode: 0o700 });
  await mkdir(join(root, 'projects', FIXTURE_PROJECT_SLUG, 'layouts'), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    join(root, 'workspace', 'README.md'),
    '# Browser Preview Fixture\n',
    {
      mode: 0o600,
    },
  );
  await writeFile(
    join(root, 'projects', FIXTURE_PROJECT_SLUG, 'project.json'),
    `${JSON.stringify(fixtureProject(root, now), null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(root, 'projects', FIXTURE_PROJECT_SLUG, 'layouts', 'coding.json'),
    `${JSON.stringify(fixtureCodingLayout(now), null, 2)}\n`,
    { mode: 0o600 },
  );
  const marker = await open(
    join(root, FIXTURE_MARKER),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await marker.writeFile(
      `${JSON.stringify(
        {
          schemaVersion: FIXTURE_SCHEMA_VERSION,
          createdAt: now,
          root: canonicalRoot,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await marker.close();
  }
  return root;
}

export async function assertFixtureHome(root) {
  if (!basename(root).startsWith(FIXTURE_ROOT_PREFIX)) {
    throw new Error(`Refusing to clean a non-fixture temporary path: ${root}`);
  }
  const rootMetadata = await lstat(root).catch(() => null);
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(
      `Refusing to clean a non-directory or symlink fixture root: ${root}`,
    );
  }
  const canonicalRoot = await realpath(root).catch(() => null);
  if (!canonicalRoot)
    throw new Error(`Refusing to clean an unresolved fixture root: ${root}`);
  const marker = join(root, FIXTURE_MARKER);
  const metadata = await lstat(marker).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error(
      `Refusing to clean a home without a regular fixture marker: ${root}`,
    );
  }
  let descriptor;
  try {
    descriptor = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await descriptor.stat();
    if (
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      !opened.isFile()
    ) {
      throw new Error(
        `Refusing to clean a fixture marker that changed while opening: ${root}`,
      );
    }
    const parsed = JSON.parse(await descriptor.readFile('utf8'));
    if (
      parsed?.schemaVersion !== FIXTURE_SCHEMA_VERSION ||
      parsed?.root !== canonicalRoot
    ) {
      throw new Error(
        `Refusing to clean a home with an unknown fixture marker: ${root}`,
      );
    }
  } finally {
    await descriptor?.close();
  }
  return canonicalRoot;
}

export async function removeFixtureHome(root) {
  const canonicalRoot = await assertFixtureHome(root);
  // Revalidate immediately before recursive removal; cleanup never follows a
  // substituted symlink or a marker copied from another owned mkdtemp root.
  await assertFixtureHome(canonicalRoot);
  await rm(canonicalRoot, { recursive: true, force: true, maxRetries: 2 });
}

export async function assertPackagedStationApp(appPath) {
  const app = resolve(appPath);
  if (!app.endsWith('.app')) {
    throw new Error(
      `Expected a packaged Station .app bundle, received: ${app}`,
    );
  }
  // Tauri's bundle display name is Station, while the configured Rust binary
  // is the lowercase `station`; the fixture must validate the actual package
  // entry point rather than infer it from the app display name.
  const executable = join(app, 'Contents', 'MacOS', 'station');
  const resources = join(app, 'Contents', 'Resources');
  const [executableMetadata, resourceMetadata] = await Promise.all([
    lstat(executable).catch(() => null),
    lstat(resources).catch(() => null),
  ]);
  if (
    !executableMetadata?.isFile() ||
    executableMetadata.isSymbolicLink() ||
    !resourceMetadata?.isDirectory() ||
    resourceMetadata.isSymbolicLink()
  ) {
    throw new Error(
      `The packaged Station app is incomplete; expected executable and Resources under: ${app}`,
    );
  }
  const manifestPath = join(resources, 'dist-server', 'station-build.json');
  const manifestMetadata = await lstat(manifestPath).catch(() => null);
  if (!manifestMetadata?.isFile() || manifestMetadata.isSymbolicLink()) {
    throw new Error(
      `The packaged Station app is missing a regular build manifest: ${app}`,
    );
  }
  const build = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    !build ||
    typeof build.sha !== 'string' ||
    !FULL_GIT_SHA.test(build.sha)
  ) {
    throw new Error(
      `The packaged Station app has no valid build identity: ${app}`,
    );
  }
  return { app, executable, buildSha: build.sha };
}

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { spawnSyncBounded } from './lib/bounded-capture.mjs';

const root = resolve(import.meta.dirname, '..');
const directory = mkdtempSync(join(tmpdir(), 'station-author-build-'));
const endpoint = 'https://telemetry.example.invalid/station';
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith('GITHUB_') && !key.startsWith('STATION_'),
  ),
);
const official = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'kontourai/station',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/tags/v1.2.3',
  GITHUB_WORKFLOW_REF:
    'kontourai/station/.github/workflows/release.yml@refs/tags/v1.2.3',
  STATION_CHANNEL: 'stable',
  STATION_AUTHOR_TELEMETRY_ENDPOINT: endpoint,
};

function child(args, env) {
  const result = spawnSyncBounded(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...inherited, ...env },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `Child terminated: ${result.signal}`);
  return result;
}

function build(env, expected, channel) {
  const result = child(['esbuild.config.mjs'], {
    ...env,
    STATION_BUILD_SERVER_DIR: directory,
  });
  assert.equal(result.status, 0, result.stderr);
  const bundle = readFileSync(join(directory, 'command-station.js'), 'utf8');
  const context = {};
  const banner = bundle
    .split('\n')
    .filter((line) => line.startsWith('globalThis.__STATION_'))
    .join('\n');
  assert.ok(banner, 'Server bundle is missing build metadata');
  runInNewContext(banner, context);
  assert.equal(context.__STATION_AUTHOR_TELEMETRY_ENDPOINT__, expected);
  assert.equal(context.__STATION_SERVER_BUILD__.channel, channel);
  const constant = child(
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    ${banner}
    const { STATION_AUTHOR_TELEMETRY_ENDPOINT } = await import('./src-server/domain/telemetry-build-constants.ts');
    assert.equal(STATION_AUTHOR_TELEMETRY_ENDPOINT, ${JSON.stringify(expected)});
  `,
    ],
    {
      STATION_AUTHOR_TELEMETRY_ENDPOINT:
        'https://runtime.example.invalid/ignored',
    },
  );
  assert.equal(constant.status, 0, constant.stderr);
}

try {
  build({}, '', 'source-checkout');
  build({ ...official, STATION_AUTHOR_TELEMETRY_ENDPOINT: '' }, '', 'stable');
  build(official, endpoint, 'stable');
  build(
    {
      ...official,
      STATION_CHANNEL: 'preview',
      GITHUB_REF: 'refs/tags/v1.2.3-preview.1',
      GITHUB_WORKFLOW_REF:
        'kontourai/station/.github/workflows/release.yml@refs/tags/v1.2.3-preview.1',
    },
    endpoint,
    'preview',
  );
  build(
    {
      ...official,
      STATION_CHANNEL: 'nightly',
      GITHUB_EVENT_NAME: 'schedule',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_WORKFLOW_REF:
        'kontourai/station/.github/workflows/nightly.yml@refs/heads/main',
    },
    endpoint,
    'nightly',
  );

  for (const invalid of [
    'not a URL',
    'http://telemetry.example.invalid',
    'https://user:password@telemetry.example.invalid',
    'https://@telemetry.example.invalid',
    `${endpoint}?token=public`,
    `${endpoint}?`,
    `${endpoint}#fragment`,
    ` ${endpoint}`,
  ]) {
    const result = child(['esbuild.config.mjs'], {
      ...official,
      STATION_AUTHOR_TELEMETRY_ENDPOINT: invalid,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /must be an HTTPS URL without credentials, query or fragment/,
    );
  }
  for (const env of [
    { STATION_AUTHOR_TELEMETRY_ENDPOINT: endpoint },
    { ...official, GITHUB_REPOSITORY: 'fork/station' },
    { ...official, GITHUB_EVENT_NAME: 'pull_request' },
    { ...official, GITHUB_EVENT_NAME: 'pull_request_target' },
    {
      ...official,
      GITHUB_WORKFLOW_REF:
        'kontourai/station/.github/workflows/build-android.yml@refs/heads/main',
    },
  ]) {
    const result = child(['esbuild.config.mjs'], env);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /forbidden outside official release builds/);
  }
  const mismatch = child(['esbuild.config.mjs'], {
    ...official,
    STATION_CHANNEL: 'nightly',
  });
  assert.equal(mismatch.status, 1, mismatch.stderr);
  assert.match(mismatch.stderr, /existing build channel to match/);

  for (const [enabled, channel] of [
    [false, 'stable'],
    [true, 'stable'],
    [true, 'nightly'],
  ]) {
    const cli = child(['packages/cli/esbuild.config.mjs'], {
      ...official,
      GITHUB_EVENT_NAME:
        channel === 'nightly' ? 'schedule' : 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_WORKFLOW_REF: `kontourai/station/.github/workflows/${channel === 'nightly' ? 'nightly' : 'publish-packages'}.yml@refs/heads/main`,
      STATION_CLI_BUILD_CHANNEL: channel,
      STATION_AUTHOR_TELEMETRY_ENDPOINT: enabled ? endpoint : '',
    });
    assert.equal(cli.status, 0, cli.stderr);
    const bundle = readFileSync(
      join(root, 'packages/cli/dist/station.mjs'),
      'utf8',
    );
    const context = {};
    runInNewContext(
      bundle
        .split('\n')
        .filter((line) => line.startsWith('globalThis.__STATION_'))
        .join('\n'),
      context,
    );
    assert.equal(
      context.__STATION_AUTHOR_TELEMETRY_ENDPOINT__,
      enabled ? endpoint : '',
    );
    assert.equal(context.__STATION_CLI_BUNDLE__.channel, channel);
  }

  // Source execution never reads the endpoint from the runtime environment.
  const source = child(
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { STATION_AUTHOR_TELEMETRY_ENDPOINT } from './src-server/domain/telemetry-build-constants.ts';
    assert.equal(STATION_AUTHOR_TELEMETRY_ENDPOINT, '');
  `,
    ],
    { STATION_AUTHOR_TELEMETRY_ENDPOINT: endpoint },
  );
  assert.equal(source.status, 0, source.stderr);
  console.log(
    'Author telemetry build guard: PASS (real server bundles, empty/default, stable/preview/nightly, invalid URLs, non-official contexts, channel mismatch, source runtime)',
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

const ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT = resolve(ROOT, 'scripts/query-google-play-release.mjs');
const PRELOAD = pathToFileURL(
  resolve(import.meta.dirname, 'fixtures/google-play-readback-preload.mjs'),
).href;
const IDENTITY = JSON.stringify({
  packageName: 'io.kontourai.station.nightly',
  versionCode: 242801,
  versionName: '0.1.3-nightly.242801',
});
// Generous: a child that never exits is the failure under test, and a
// healthy one finishes in a few seconds even on a loaded host.
const KILL_AFTER_MS = 45_000;

/** The parent's environment without any Google credential of its own. */
const childEnv = (extra: Record<string, string>) => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !/^(GOOGLE_|GCLOUD_|CLOUDSDK_|GCP_)/.test(key))
      env[key] = value;
  return { ...env, ...extra };
};

function runChild(args: string[], env: Record<string, string>) {
  return new Promise<{
    status: number | null;
    killed: boolean;
    stdout: string;
    stderr: string;
  }>((resolveRun) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: childEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, KILL_AFTER_MS);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolveRun({ status, killed, stdout, stderr });
    });
  });
}

const cli = (scenario: string) =>
  runChild(['--import', PRELOAD, SCRIPT, 'query-json', IDENTITY], {
    PLAY_FAKE_SCENARIO: scenario,
  });

describe('query-google-play-release CLI', () => {
  test('stdout is only the observation; a retry line goes to stderr', async () => {
    const result = await cli('unavailable-once');
    expect(result).toMatchObject({ status: 0, killed: false });
    expect(JSON.parse(result.stdout)).toMatchObject({
      provider: 'google-play',
      observed: { versionCode: 242801, status: 'completed' },
    });
    expect(result.stderr.trim()).toBe(
      'Google Play cohort verification failed: create-edit failed with HTTP 503 (attempt 1 of 3); retrying in 2000 ms from a new edit',
    );
  });

  test('a cleanup failure after a good read is a stderr warning, not a failure', async () => {
    const result = await cli('cleanup-fails');
    expect(result).toMatchObject({ status: 0, killed: false });
    expect(JSON.parse(result.stdout)).toMatchObject({
      provider: 'google-play',
    });
    expect(result.stderr).toContain(
      'Google Play readback warning: delete-edit failed with HTTP 500 (attempt 1 of 3) for temporary edit edit-1;',
    );
  });

  test('a final failure exits non-zero with the named error and no stdout', async () => {
    const result = await cli('forbidden');
    expect(result).toMatchObject({ status: 1, killed: false, stdout: '' });
    expect(result.stderr.trim()).toBe(
      'Google Play cohort verification failed: create-edit failed with HTTP 403 (attempt 1 of 3)',
    );
  });
});

describe('query-google-play-release token time limit', () => {
  let server: http.Server | undefined;
  const makeTempDir = trackTempDirs();
  afterEach(() => {
    server?.closeAllConnections();
    server?.close();
  });

  test('a token exchange that never answers ends the CLI within its budget', async () => {
    // A real external-account credential whose subject token answers and
    // whose STS exchange never does: google-auth-library gives that request
    // no timeout and no signal, so its socket stays open after the readback
    // gives up on it.
    const seen: string[] = [];
    server = http.createServer((request, response) => {
      seen.push(String(request.url));
      if (String(request.url).startsWith('/subject')) {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('subject-jwt');
      }
    });
    await new Promise<void>((ready) =>
      server?.listen(0, '127.0.0.1', () => ready()),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${address.port}`;
    const home = makeTempDir('play-readback-');
    const credentials = join(home, 'external-account.json');
    writeFileSync(
      credentials,
      JSON.stringify({
        type: 'external_account',
        audience:
          '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q',
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        token_url: `${base}/sts`,
        credential_source: { url: `${base}/subject`, format: { type: 'text' } },
      }),
    );
    const entry = `import(${JSON.stringify(pathToFileURL(SCRIPT).href)}).then((m) => m.runCli(['query-json', ${JSON.stringify(IDENTITY)}], { requestTimeoutMs: 2000, totalBudgetMs: 8000, minAttemptBudgetMs: 100 }))`;
    const started = Date.now();
    const result = await runChild(['--input-type=module', '--eval', entry], {
      GOOGLE_APPLICATION_CREDENTIALS: credentials,
      // Without a project id, GoogleAuth#getClient itself fetches a token to
      // look one up, and the stall would land in acquire-client; both run in
      // the same time-limited stage. A known project puts it in acquire-token.
      GOOGLE_CLOUD_PROJECT: 'readback-test',
    });
    expect(result).toMatchObject({ status: 1, killed: false, stdout: '' });
    // The 8 s budget plus node start-up; an abandoned STS socket that kept
    // the process alive would run to the 45 s kill instead.
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(result.stderr).toContain(
      'acquire-token local deadline elapsed (attempt 1 of 3); retrying in 2000 ms from a new edit',
    );
    expect(result.stderr).toContain(
      'last failure: acquire-token local deadline elapsed (attempt 2 of 3)',
    );
    // Each attempt built a new client, so each reached STS on its own.
    expect(seen.filter((url) => url.startsWith('/sts'))).toHaveLength(2);
  });
});

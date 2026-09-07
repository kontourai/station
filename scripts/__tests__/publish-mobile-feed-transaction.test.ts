import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  FIXTURE_TEST_TIMEOUT_MS,
  runBoundedFixture,
} from './helpers/bounded-fixture-process.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

type TransactionRunOptions = {
  deploy?: number;
  signal?: string;
  redraftFails?: boolean;
  publishCommitsThenFails?: boolean;
  viewUnavailable?: boolean;
  publishNoOp?: boolean;
  publishFailsNoCommit?: boolean;
  hangRoot?: boolean;
  timeoutMs?: number;
  allowTimeoutResult?: boolean;
  withFeed?: boolean;
};

async function run({
  deploy = 0,
  signal = '',
  redraftFails = false,
  publishCommitsThenFails = false,
  viewUnavailable = false,
  publishNoOp = false,
  publishFailsNoCommit = false,
  hangRoot = false,
  timeoutMs,
  allowTimeoutResult,
  withFeed = true,
}: TransactionRunOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'station-feed-transaction-'));
  roots.push(root);
  const log = join(root, 'gh.log');
  const gh = join(root, 'gh');
  const node = join(root, 'node');
  const feed = join(root, 'feed.json');
  const state = join(root, 'draft.state');
  const nodeLog = join(root, 'node.log');
  const bashEnvironment = join(root, 'bash-environment');
  writeFileSync(log, '');
  writeFileSync(feed, '{}');
  writeFileSync(state, 'true');
  writeFileSync(nodeLog, '');
  writeFileSync(
    gh,
    '#!/usr/bin/env bash\necho "$*" >> "$GH_LOG"\nif [[ "$1 $2" == "release view" ]]; then [[ "$VIEW_UNAVAILABLE" == 1 ]] && exit 8; cat "$STATE_FILE"; exit 0; fi\nif [[ "$*" == *"--draft=false"* ]]; then [[ "$PUBLISH_FAILS_NO_COMMIT" == 1 ]] && exit 9; [[ "$PUBLISH_NOOP" == 1 ]] || echo false > "$STATE_FILE"; [[ "$PUBLISH_COMMITS_THEN_FAILS" == 1 ]] && exit 9; fi\nif [[ "$*" == *"--draft=true"* ]]; then [[ "$REDRAFT_FAILS" == 1 ]] && exit 9; echo true > "$STATE_FILE"; fi\n',
  );
  writeFileSync(
    node,
    '#!/usr/bin/env bash\necho "$*" >> "$NODE_LOG"\nif [[ "$*" == *"validate-config"* ]]; then exit 0; fi\nexit "$DEPLOY_STATUS"\n',
  );
  writeFileSync(
    bashEnvironment,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash variable expansion literal
    'if [[ "${STATION_TEST_HANG_ROOT:-}" == 1 ]]; then exec sleep 60; fi\n',
  );
  chmodSync(gh, 0o755);
  chmodSync(node, 0o755);
  const result = await runBoundedFixture(
    'bash',
    [
      resolve('scripts/publish-mobile-feed-transaction.sh'),
      ...(withFeed ? [feed] : []),
    ],
    {
      cwd: resolve('.'),
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        RELEASE_TAG: 'v1.2.3',
        GH_LOG: log,
        DEPLOY_STATUS: String(deploy),
        NODE_LOG: nodeLog,
        REDRAFT_FAILS: redraftFails ? '1' : '0',
        STATION_TEST_SIGNAL: signal,
        STATE_FILE: state,
        PUBLISH_COMMITS_THEN_FAILS: publishCommitsThenFails ? '1' : '0',
        VIEW_UNAVAILABLE: viewUnavailable ? '1' : '0',
        PUBLISH_NOOP: publishNoOp ? '1' : '0',
        PUBLISH_FAILS_NO_COMMIT: publishFailsNoCommit ? '1' : '0',
        BASH_ENV: bashEnvironment,
        STATION_TEST_HANG_ROOT: hangRoot ? '1' : undefined,
        VITE_NATIVE_APP_UPDATE_CHANNEL: 'stable',
        VITE_NATIVE_APP_VERSION: '1.2.3',
        VITE_NATIVE_APP_UPDATE_FEED_URL: withFeed
          ? 'https://updates.example.test/mobile/stable.json'
          : undefined,
        VITE_NATIVE_APP_UPDATE_PROVIDER_ORIGIN: withFeed
          ? 'https://updates.example.test'
          : undefined,
        NATIVE_APP_UPDATE_ACTION_URL: withFeed
          ? 'https://downloads.example.test/station.apk'
          : undefined,
        NATIVE_APP_UPDATE_ACTION_KIND: withFeed ? 'artifact' : undefined,
        NATIVE_APP_UPDATE_ACTION_ORIGINS: withFeed
          ? 'https://downloads.example.test'
          : undefined,
        NATIVE_APP_UPDATE_PUBLISH_TOKEN: withFeed ? 'token' : undefined,
      },
      allowTimeoutResult,
      timeoutMs,
    },
  );
  return {
    result,
    log: readFileSync(log, 'utf8'),
    nodeLog: readFileSync(nodeLog, 'utf8'),
    state: readFileSync(state, 'utf8').trim(),
  };
}

describe('mobile feed publication compensation', () => {
  test('publishes without feed deployment when the custom feed is absent', async () => {
    const { result, log, nodeLog, state } = await run({ withFeed: false });
    expect(result.status).toBe(0);
    expect(state).toBe('false');
    expect(log).toContain('--draft=false');
    expect(nodeLog).toContain('native-update-feed.mjs validate-config');
    expect(nodeLog).not.toContain('native-update-feed.mjs deploy');
  });

  test(
    'safe deploy failure re-drafts the public release',
    async () => {
      const { result, log } = await run({ deploy: 1 });
      expect(result.status).toBe(1);
      expect(log).toContain('--draft=true');
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );

  test('fails closed when a fixture command cannot launch', async () => {
    await expect(
      runBoundedFixture('/definitely/not/a/fixture-command', []),
    ).rejects.toMatchObject({ code: 'ENOENT', status: null });
  });

  test('fails closed when bounded fixture output is truncated', async () => {
    await expect(
      runBoundedFixture('bash', ['-c', "printf 'overflow'"], {
        maxOutputBytes: 4,
      }),
    ).rejects.toThrow('fixture process output was truncated');
  });

  test.runIf(process.platform !== 'win32')(
    'bounds a hung transaction root process',
    async () => {
      await expect(
        runBoundedFixture('bash', ['-c', 'exec sleep 60'], {
          timeoutMs: 250,
        }),
      ).rejects.toMatchObject({ code: 'ETIMEDOUT', status: null });

      const { result } = await run({
        hangRoot: true,
        timeoutMs: 250,
        allowTimeoutResult: true,
      });
      expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe(
        'ETIMEDOUT',
      );
      expect(result.status).toBeNull();
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );

  test.runIf(process.platform !== 'win32')(
    'reaps a timed-out fixture descendant process group',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'station-fixture-descendant-'));
      roots.push(root);
      const childPidPath = join(root, 'child.pid');
      const result = await runBoundedFixture(
        'bash',
        [
          '-c',
          `sleep 60 </dev/null >/dev/null 2>&1 & echo $! > ${JSON.stringify(childPidPath)}; wait`,
        ],
        { allowTimeoutResult: true, timeoutMs: 250 },
      );
      const childPid = Number(readFileSync(childPidPath, 'utf8').trim());
      expect(Number.isSafeInteger(childPid)).toBe(true);
      expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe(
        'ETIMEDOUT',
      );
      expect(result.status).toBeNull();
      expect(() => process.kill(childPid, 0)).toThrow();
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );

  test('ambiguous exit 75 remains public', async () => {
    const { result, log } = await run({ deploy: 75 });
    expect(result.status).toBe(75);
    expect(log).not.toContain('--draft=true');
  });
  test.each(['INT', 'TERM'])(
    '%s remains public for manual recovery',
    async (signal) => {
      const { result, log } = await run({ signal });
      expect(result.status).toBe(75);
      expect(log).not.toContain('--draft=true');
    },
  );
  test('redraft failure remains public and exits for manual recovery', async () => {
    const { result, log } = await run({ deploy: 1, redraftFails: true });
    expect(result.status).toBe(75);
    expect(log).toContain('--draft=true');
    expect(result.stderr).toContain('manual recovery');
  });
  test('publish side effect followed by nonzero is detected and safely re-drafted', async () => {
    const { result, log } = await run({ publishCommitsThenFails: true });
    expect(result.status).toBe(1);
    expect(log).toContain('--draft=true');
  });
  test('unavailable publication state remains ambiguous and public', async () => {
    const { result, log } = await run({ viewUnavailable: true });
    expect(result.status).toBe(75);
    expect(log).not.toContain('--draft=true');
  });
  test('nominal publish no-op remains draft, fails nonzero, and never deploys', async () => {
    const { result, log } = await run({ publishNoOp: true });
    expect(result.status).toBe(1);
    expect(log).not.toContain('--draft=true');
  });
  test('failed publish proven draft preserves its original status', async () => {
    const { result } = await run({ publishFailsNoCommit: true });
    expect(result.status).toBe(9);
  });
});

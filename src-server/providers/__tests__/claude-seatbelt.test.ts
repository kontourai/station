/**
 * #2494 fix round: the confined Claude home is never one an unconfined spawn
 * uses (R3), and the spawn wrapper passes the engine only an allowlisted
 * environment (R8) with the secure-store override dropped wherever it came
 * from. The wrapper is exercised directly, through the production provider.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createSeatbeltConfinementProvider } from '../../security/confinement/seatbelt.js';
import {
  confinedClaudeConfigDir,
  confinedClaudeSpawn,
  confinedEnvAllows,
} from '../adapters/claude-seatbelt.js';
import { appHomeProfileDir } from '../app-home/app-home-profiles.js';
import { credentialProfileAppHomeDir } from '../app-home/credential-profile-registry.js';

const STATION_HOME = '/Users/op/.station/instances/stable';
const CONFINED_ROOT = `${STATION_HOME}/confined-homes`;

describe('the confined Claude home', () => {
  /** Every config home an unconfined spawn can be given, by layer. */
  const unconfinedHomes = {
    'no app home (the global ~/.claude)': {
      appHomeEnv: undefined,
      unconfined: join(homedir(), '.claude'),
    },
    'the app-home opt-in': {
      appHomeEnv: {
        CLAUDE_CONFIG_DIR: appHomeProfileDir('claude', STATION_HOME),
      },
      unconfined: appHomeProfileDir('claude', STATION_HOME),
    },
    'a selected credential profile': {
      appHomeEnv: {
        CLAUDE_CONFIG_DIR: credentialProfileAppHomeDir(
          'claude',
          'work',
          STATION_HOME,
        ),
      },
      unconfined: credentialProfileAppHomeDir('claude', 'work', STATION_HOME),
    },
    "a connection's configHome": {
      appHomeEnv: { CLAUDE_CONFIG_DIR: '/Users/op/.claude-work' },
      unconfined: '/Users/op/.claude-work',
    },
  };

  test.each(Object.entries(unconfinedHomes))(
    'with %s, it is under the confined root and differs from the unconfined home',
    (_label, { appHomeEnv, unconfined }) => {
      const confined = confinedClaudeConfigDir(appHomeEnv, STATION_HOME);
      expect(confined.startsWith(`${CONFINED_ROOT}/`)).toBe(true);
      expect(confined).not.toBe(unconfined);
      expect(confined.startsWith(`${STATION_HOME}/app-homes`)).toBe(false);
    },
  );

  test('a credential profile gets a confined twin of its own', () => {
    expect(
      confinedClaudeConfigDir(
        {
          CLAUDE_CONFIG_DIR: credentialProfileAppHomeDir(
            'claude',
            'work',
            STATION_HOME,
          ),
        },
        STATION_HOME,
      ),
    ).toMatch(
      /^\/Users\/op\/\.station\/instances\/stable\/confined-homes\/credential-profile-[0-9a-f]+$/,
    );
    expect(confinedClaudeConfigDir(undefined, STATION_HOME)).toBe(
      `${CONFINED_ROOT}/claude`,
    );
  });
});

describe('the confined spawn environment', () => {
  const launch = {
    workspace: '/Users/op/dev/project',
    configDir: `${CONFINED_ROOT}/claude`,
    tmpDir: `${STATION_HOME}/tmp/confined-sessions/session-1-abcdef`,
    grants: { writable: ['/Users/op/dev/project'], readable: [] },
  };

  test('passes only allowlisted ambient variables and the configured ones, and never the secure-store override', () => {
    const { wrap } = confinedClaudeSpawn(
      createSeatbeltConfinementProvider(),
      launch,
      new Set(['STATION_TEST_CONFIGURED', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']),
    );
    const out = wrap({
      command: '/usr/local/bin/claude',
      args: [],
      cwd: launch.workspace,
      env: {
        PATH: '/usr/bin',
        HOME: '/Users/op',
        LC_ALL: 'en_US.UTF-8',
        ANTHROPIC_API_KEY: 'sk-ant-fake',
        CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
        GH_TOKEN: 'ghp_planted',
        GITHUB_TOKEN: 'ghp_planted',
        NPM_TOKEN: 'npm_planted',
        AWS_SECRET_ACCESS_KEY: 'aws_planted',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        STATION_TEST_CONFIGURED: 'kept',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '/Users/op/.claude',
        CLAUDE_CONFIG_DIR: '/Users/op/.claude',
        TMPDIR: '/tmp',
        UNSET: undefined,
      },
    });
    expect(out.command).toBe('/usr/bin/sandbox-exec');
    expect(out.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/op',
      LC_ALL: 'en_US.UTF-8',
      ANTHROPIC_API_KEY: 'sk-ant-fake',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      STATION_TEST_CONFIGURED: 'kept',
      CLAUDE_CONFIG_DIR: launch.configDir,
      TMPDIR: launch.tmpDir,
    });
  });

  test.each([
    ['GH_TOKEN', false],
    ['GITHUB_TOKEN', false],
    ['NPM_TOKEN', false],
    ['AWS_ACCESS_KEY_ID', false],
    ['GOOGLE_APPLICATION_CREDENTIALS', false],
    ['SSH_AUTH_SOCK', false],
    ['OPENAI_API_KEY', false],
    ['PATH', true],
    ['HTTPS_PROXY', true],
    ['NODE_EXTRA_CA_CERTS', true],
    ['ANTHROPIC_BASE_URL', true],
    ['CLAUDE_CODE_OAUTH_TOKEN', true],
    ['GIT_AUTHOR_NAME', true],
    ['GIT_AUTHOR_EMAIL', true],
    ['GIT_COMMITTER_NAME', true],
    ['GIT_COMMITTER_EMAIL', true],
    ['EDITOR', true],
    ['VISUAL', true],
    ['GIT_ASKPASS', false],
    ['GIT_SSH_COMMAND', false],
    ['NVM_DIR', false],
    ['JAVA_HOME', false],
  ])('%s is allowed: %s', (key, allowed) => {
    expect(confinedEnvAllows(key)).toBe(allowed);
  });
});

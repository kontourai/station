/**
 * #4774 acceptance: for the same inputs, the confinement preflight's
 * credential answer and the start's own decision (`confinedClaudeDecision`)
 * agree. Both are the real functions; only the inputs are fixtures. The
 * environment layering written here (base, then connection, then app home)
 * is the one `ClaudeAdapter.prepareSeatbeltStart` builds; a change there is
 * not seen by this test.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { canonicalPath } from '../../security/confinement/seatbelt.js';
import { claudeConfinedCredentialPreflight } from '../adapters/claude-confinement-preflight.js';
import { confinedClaudeDecision } from '../adapters/claude-seatbelt.js';
import { CredentialProfileEnvironmentError } from '../app-home/app-home-profiles.js';

type Env = Record<string, string>;

interface Case {
  name: string;
  baseEnv?: Env;
  connectionEnv?: Env;
  /** App-home directory name under `<stationHome>/app-homes`, if any. */
  profile?: string;
  /** Confined home (under `<stationHome>/confined-homes`) holding a credential file. */
  enrolledIn?: string;
  expected: 'available' | 'unavailable';
}

const OAUTH = { claudeAiOauth: { accessToken: 'fixture-access-token' } };

const CASES: Case[] = [
  { name: 'no credential anywhere', expected: 'unavailable' },
  {
    name: 'an API key in the base environment',
    baseEnv: { ANTHROPIC_API_KEY: 'fixture-key' },
    expected: 'available',
  },
  {
    name: 'an OAuth token only in the connection environment',
    connectionEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token' },
    expected: 'available',
  },
  {
    name: 'a connection environment that blanks the base key',
    baseEnv: { ANTHROPIC_API_KEY: 'fixture-key' },
    connectionEnv: { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' },
    expected: 'unavailable',
  },
  {
    name: 'a whitespace-only key',
    baseEnv: { ANTHROPIC_AUTH_TOKEN: '   ' },
    expected: 'unavailable',
  },
  {
    name: 'a credential file enrolled in the default confined home',
    enrolledIn: 'claude',
    expected: 'available',
  },
  {
    name: 'a credential profile whose confined twin holds the file',
    profile: 'credential-profile-abc',
    enrolledIn: 'credential-profile-abc',
    expected: 'available',
  },
  {
    name: 'a credential profile; the file is only in the default confined home',
    profile: 'credential-profile-abc',
    enrolledIn: 'claude',
    expected: 'unavailable',
  },
];

describe('#4774: the confinement preflight answers what a Claude start decides', () => {
  let root: string;
  let stationHome: string;
  let home: string;
  let workspace: string;
  const makeTempDir = trackTempDirs();

  beforeEach(() => {
    root = canonicalPath(makeTempDir('station-preflight-'));
    stationHome = join(root, 'station-home');
    home = join(root, 'home');
    workspace = join(root, 'workspace');
    for (const dir of [stationHome, home, workspace])
      mkdirSync(dir, { recursive: true });
  });

  function arrange(c: Case): Env | undefined {
    if (c.enrolledIn) {
      const dir = join(stationHome, 'confined-homes', c.enrolledIn);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.credentials.json'), JSON.stringify(OAUTH));
    }
    return c.profile
      ? { CLAUDE_CONFIG_DIR: join(stationHome, 'app-homes', c.profile) }
      : undefined;
  }

  test.each(CASES)('agrees for $name', async (c) => {
    const appHomeEnv = arrange(c);
    const preflight = await claudeConfinedCredentialPreflight({
      baseEnv: async () => ({ ...c.baseEnv }),
      connectionEnv: async () => c.connectionEnv,
      appHomeEnv: async () =>
        appHomeEnv ? { env: appHomeEnv, profileRef: 'abc' } : undefined,
      stationHome,
    });
    const decision = confinedClaudeDecision({
      cwd: workspace,
      appHomeEnv,
      env: { ...c.baseEnv, ...c.connectionEnv, ...appHomeEnv },
      globalConfigPinned: false,
      stationHome,
      home,
    });
    const startFallsBack =
      'fallback' in decision &&
      decision.fallback === 'confined-credential-unavailable';
    // The start reached the credential step: anything else would make the
    // agreement vacuous.
    expect('fallback' in decision ? decision.fallback : 'confined').toMatch(
      /^(confined|confined-credential-unavailable)$/,
    );
    expect({
      case: c.name,
      preflightSaysUnavailable: preflight.state === 'unavailable',
    }).toEqual({ case: c.name, preflightSaysUnavailable: startFallsBack });
    expect(preflight.state).toBe(c.expected);
  });

  test('the case table exercises both answers', () => {
    expect(new Set(CASES.map((c) => c.expected))).toEqual(
      new Set(['available', 'unavailable']),
    );
  });

  test('names the fallback and the remedy, never the credential or a path', async () => {
    const preflight = await claudeConfinedCredentialPreflight({
      baseEnv: async () => ({ OTHER: 'unrelated' }),
      connectionEnv: async () => undefined,
      appHomeEnv: async () => undefined,
      stationHome,
    });
    expect(preflight).toMatchObject({
      state: 'unavailable',
      fallback: 'confined-credential-unavailable',
    });
    const available = await claudeConfinedCredentialPreflight({
      baseEnv: async () => ({
        ANTHROPIC_API_KEY: 'sk-ant-fixture-secret-0123456789',
      }),
      connectionEnv: async () => undefined,
      appHomeEnv: async () => undefined,
      stationHome,
    });
    expect(available).toEqual({ state: 'available', source: 'environment' });
    const text = JSON.stringify([preflight, available]);
    expect(text).not.toContain('sk-ant-fixture-secret');
    expect(text).not.toContain(stationHome);
  });

  test('a connection launch the start cannot resolve leaves the answer unverified', async () => {
    const preflight = await claudeConfinedCredentialPreflight({
      baseEnv: async () => ({ ANTHROPIC_API_KEY: 'fixture-key' }),
      connectionEnv: async () => {
        throw new Error('proxy misconfigured at /Users/someone/.station');
      },
      appHomeEnv: async () => undefined,
      stationHome,
    });
    expect(preflight.state).toBe('unverified');
    expect(JSON.stringify(preflight)).not.toContain('/Users/someone');
  });

  test('a credential profile that cannot be prepared leaves it unverified; another app-home failure continues as the start does', async () => {
    const failed = await claudeConfinedCredentialPreflight({
      baseEnv: async () => ({ ANTHROPIC_API_KEY: 'fixture-key' }),
      connectionEnv: async () => undefined,
      appHomeEnv: async () => {
        throw new CredentialProfileEnvironmentError();
      },
      stationHome,
    });
    expect(failed.state).toBe('unverified');
    const continued = await claudeConfinedCredentialPreflight({
      baseEnv: async () => ({ ANTHROPIC_API_KEY: 'fixture-key' }),
      connectionEnv: async () => undefined,
      appHomeEnv: async () => {
        throw new Error('legacy lookup failed');
      },
      stationHome,
    });
    expect(continued).toEqual({ state: 'available', source: 'environment' });
  });
});

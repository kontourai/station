/**
 * #4515 fix round 3: a disallowed engine's account credentials are not used.
 * Under `allowed: []` the engine page's usage read reported live usage: it
 * read the Claude OAuth token through `/usr/bin/security` and called the
 * vendor. The usage seam now answers unavailable with the organization's
 * sentence before any credential is read or any request is sent, and writes
 * that would set the engine up are refused.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { agentConnectionFixture } from '../../../../tests/helpers/connection-fixtures.js';
import { readJson } from '../../../__test-utils__/read-json.js';

// Every child process the route starts; the Keychain read is
// `/usr/bin/security` (other children, such as `ps` for process identity,
// read no credential).
const execFile = vi.hoisted(() =>
  vi.fn((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function')
      callback(new Error('no Keychain entry in this test'));
  }),
);
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile,
}));

const { installManagedEngineLimits } = await import(
  '../../../security/managed-engine-limits.js'
);
const { createAppHomeRoutes } = await import('../app-home.js');

const keychainReads = () =>
  execFile.mock.calls.filter(([command]) => command === '/usr/bin/security');

function install(allowed: string[] | null) {
  if (!allowed) return installManagedEngineLimits(null);
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    limits: { engines: { allowed } },
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  installManagedEngineLimits({
    document: parsed.document,
    summary: summarizeManagedPolicy(parsed.document),
  });
}

describe('a disallowed engine account at the app-home routes', () => {
  const originalFetch = globalThis.fetch;
  let home: string;
  let fetchSpy: ReturnType<typeof vi.fn>;
  let app: ReturnType<typeof createAppHomeRoutes>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'managed-account-usage-'));
    // A signed-in Claude account in the connection's config folder.
    await writeFile(
      join(home, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'live-token' } }),
    );
    execFile.mockClear();
    fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ five_hour: { utilization: 74, resets_at: null } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    globalThis.fetch = fetchSpy as never;
    const connection = agentConnectionFixture({
      id: 'claude',
      type: 'claude',
      config: { provider: 'claude', env: { CLAUDE_CONFIG_DIR: home } },
    });
    app = createAppHomeRoutes({
      connectionService: {
        getConnection: vi.fn(async () => connection),
        getCredentialRecovery: vi.fn(async () => ({
          profiles: [],
          group: { profileRefs: [], enrolledProfileRefs: [] },
          policy: { automatic: false },
          application: { capability: 'unsupported', outcome: 'unsupported' },
        })),
      } as never,
      isLoginReadCurrent: () => true,
    });
  });

  afterEach(async () => {
    install(null);
    globalThis.fetch = originalFetch;
    await rm(home, { recursive: true, force: true });
  });

  test('with no engine allowed, usage reports unavailable with no credential read and no request', async () => {
    install([]);
    const response = await app.request('/agent/claude/account-usage');
    expect(response.status).toBe(200);
    const body = await readJson<{
      data: { usage?: { status: string; reason?: string } } & {
        status?: string;
        reason?: string;
      };
    }>(response);
    const usage = body.data.usage ?? body.data;
    expect(usage.status).toBe('unknown');
    expect(usage.reason).toContain(
      "Acme's policy manages which engines run on this computer: claude is not allowed",
    );
    expect(keychainReads()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('with no engine allowed, setting the engine up is refused', async () => {
    install([]);
    const response = await app.request(
      '/agent/claude/enrolment/profile-a/device-code',
      { method: 'POST' },
    );
    expect(response.status).toBe(403);
    expect(await readJson(response)).toMatchObject({
      code: 'managed-policy-engine-refused',
    });
    expect(keychainReads()).toEqual([]);
  });

  test('control: with claude allowed, the same read uses the credential and calls the vendor', async () => {
    install(['claude']);
    const response = await app.request('/agent/claude/account-usage');
    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer live-token',
        }),
      }),
    );
    // On macOS the Keychain is asked first, so the refusal case above
    // reaches a seam that would otherwise run it.
    if (process.platform === 'darwin')
      expect(keychainReads().length).toBeGreaterThan(0);
  });
});

describe('the credential seams every caller reaches', () => {
  afterEach(() => install(null));

  test('Codex usage and both sign-in detectors read nothing for a disallowed engine', async () => {
    const { readCodexUsage } = await import(
      '../../../services/connections/credential-usage.js'
    );
    const { detectCodexAuthState } = await import(
      '../../../providers/auth/codex-auth.js'
    );
    const { detectClaudeAuthState } = await import(
      '../../../providers/auth/claude-auth.js'
    );
    const dir = await mkdtemp(join(tmpdir(), 'managed-codex-auth-'));
    try {
      await writeFile(
        join(dir, 'auth.json'),
        JSON.stringify({ tokens: { access_token: 'live-token' } }),
      );
      const deps = {
        fetch: vi.fn(),
        now: () => new Date('2026-11-05T00:00:00Z'),
        readTextFile: vi.fn(),
        readClaudeSecureCredentials: vi.fn(),
      };
      install([]);
      const usage = await readCodexUsage(dir, deps as never);
      expect(usage).toMatchObject({
        status: 'unknown',
        reason: expect.stringContaining('codex is not allowed'),
      });
      expect(deps.fetch).not.toHaveBeenCalled();
      expect(deps.readTextFile).not.toHaveBeenCalled();
      expect(await detectCodexAuthState(dir)).toBe('unknown');
      execFile.mockClear();
      expect(await detectClaudeAuthState({ CLAUDE_CONFIG_DIR: dir }, dir)).toBe(
        'unknown',
      );
      expect(keychainReads()).toEqual([]);
      // Control: allowed, the same credential file reads as signed in.
      install(['codex']);
      expect(await detectCodexAuthState(dir)).toBe('authenticated');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

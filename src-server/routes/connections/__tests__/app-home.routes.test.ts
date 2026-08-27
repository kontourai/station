import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { appHomesRootDir } from '../../../providers/app-home/app-home-profiles.js';
import { appHomeCleared, appHomeImport } from '../../../telemetry/metrics.js';
import { resolveHomeDir } from '../../../utils/paths.js';
import { createAppHomeRoutes } from '../app-home.js';

afterEach(() => {
  rmSync(appHomesRootDir(), { recursive: true, force: true });
});

function credentialRecoveryFixture(
  capability: 'restart_resume' | 'unsupported' = 'restart_resume',
) {
  const recovery = {
    profiles: [{ ref: 'profile-a', label: 'Canary Account Label' }],
    group: { profileRefs: ['profile-a'], enrolledProfileRefs: [] },
    policy: { automatic: false },
    application:
      capability === 'unsupported'
        ? {
            capability: 'unsupported' as const,
            outcome: 'unsupported' as const,
          }
        : {
            capability: 'restart_resume' as const,
            activeProfileRef: 'profile-a',
            outcome: 'adopted' as const,
          },
  };
  const service = {
    getConnection: vi.fn(async (id: string) =>
      id === 'missing-runtime'
        ? null
        : {
            id,
            kind: 'agent',
            enabled: true,
            capabilities: ['agent-runtime'],
            config: { provider: 'codex' },
          },
    ),
    getCredentialRecovery: vi.fn(async () => recovery),
    upsertCredentialProfile: vi.fn(async () => recovery),
    deleteCredentialProfile: vi.fn(async () => recovery),
    setCredentialProfileEnrollment: vi.fn(async () => recovery),
    setCredentialRecoveryAutomaticPolicy: vi.fn(async () => recovery),
    applyCredentialProfile: vi.fn(async () => ({
      capability: 'restart_resume' as const,
      activeProfileRef: 'profile-a',
      outcome: 'rolled_back' as const,
    })),
  };
  return { recovery, service };
}

describe('App home profile routes (#896)', () => {
  test('reports profile status with the profile-scoped auth state', async () => {
    const app = createAppHomeRoutes();

    const res = await app.request('/agent/claude/app-home');
    const body = await readJson<{
      success: boolean;
      data: {
        profileDir: string;
        exists: boolean;
        seededFrom?: string;
        authState: string;
      };
    }>(res);

    expect(body.success).toBe(true);
    expect(body.data.exists).toBe(false);
    expect(body.data.profileDir).toBe(
      join(resolveHomeDir(), 'app-homes', 'claude'),
    );
    // No profile dir yet, so no `.credentials.json` under it either.
    expect(body.data.authState).toBe('unauthenticated');
  });

  test('reports an authenticated profile-scoped auth state once credentials are imported', async () => {
    const app = createAppHomeRoutes();
    const fakeGlobalDir = await mkdtemp(join(tmpdir(), 'station-fake-claude-'));
    try {
      await mkdir(fakeGlobalDir, { recursive: true });
      writeFileSync(
        join(fakeGlobalDir, '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: { accessToken: 'fake-token-value' },
        }),
      );
      const previous = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = fakeGlobalDir;
      try {
        const importRes = await app.request('/agent/claude/app-home/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ includeCredentials: true }),
        });
        expect(importRes.status).toBe(200);
        const importBody = await readJson<{
          success: boolean;
          data: { copied: string[] };
        }>(importRes);
        expect(importBody.data.copied).toContain('.credentials.json');
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
      }

      const statusRes = await app.request('/agent/claude/app-home');
      const statusBody = await readJson<{
        data: { exists: boolean; seededFrom: string; authState: string };
      }>(statusRes);
      expect(statusBody.data.exists).toBe(true);
      expect(statusBody.data.seededFrom).toBe('global-import');
      expect(statusBody.data.authState).toBe('authenticated');
    } finally {
      rmSync(fakeGlobalDir, { recursive: true, force: true });
    }
  });

  test('import requires the explicit credentials flag to copy credentials', async () => {
    const app = createAppHomeRoutes();
    const fakeGlobalDir = await mkdtemp(join(tmpdir(), 'station-fake-claude-'));
    try {
      writeFileSync(
        join(fakeGlobalDir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }),
      );
      writeFileSync(join(fakeGlobalDir, 'settings.json'), '{}');
      const previous = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = fakeGlobalDir;
      try {
        const res = await app.request('/agent/claude/app-home/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
        const body = await readJson<{
          data: {
            profileDir: string;
            copied: string[];
            skipped: Array<{ path: string; reason: string }>;
          };
        }>(res);
        expect(body.data.copied).toEqual(['settings.json']);
        expect(body.data.skipped).toEqual([
          { path: '.credentials.json', reason: 'credentials-excluded' },
        ]);
        expect(
          existsSync(join(body.data.profileDir, '.credentials.json')),
        ).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
      }
    } finally {
      rmSync(fakeGlobalDir, { recursive: true, force: true });
    }
  });

  test('provenance only advances on a completed import', async () => {
    // MED-3 (security review): an unreadable/absent global config dir must
    // fail the import outright — the route must never advance
    // `seededFrom` to `'global-import'` on a failed one.
    const app = createAppHomeRoutes();
    const missingGlobalDir = join(
      tmpdir(),
      `station-does-not-exist-${Date.now()}`,
    );
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = missingGlobalDir;
    try {
      const importRes = await app.request('/agent/claude/app-home/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(importRes.status).toBe(400);
      const importBody = await readJson<{
        success: boolean;
        error: string;
        data: { outcome: string; reason: string };
      }>(importRes);
      expect(importBody.success).toBe(false);
      expect(importBody.data.outcome).toBe('failed');
      expect(importBody.data.reason).toBe('global-config-dir-missing');

      const statusRes = await app.request('/agent/claude/app-home');
      const statusBody = await readJson<{
        data: { exists: boolean; seededFrom?: string };
      }>(statusRes);
      // The profile dir was created (ensureAppHomeProfile runs before the
      // import attempt), but its provenance must still read 'empty' —
      // never advanced by the failed import.
      expect(statusBody.data.exists).toBe(true);
      expect(statusBody.data.seededFrom).toBe('empty');
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  test('an import that copies nothing does not advance provenance', async () => {
    // Item 3 (security review round 2): an import that reads a genuinely
    // empty (or wholly-refused) global config dir still succeeds — but
    // must NOT stamp `seededFrom: 'global-import'` on a profile that
    // received nothing. The response says so plainly via
    // `data.provenanceUpdated`.
    const app = createAppHomeRoutes();
    const emptyGlobalDir = await mkdtemp(
      join(tmpdir(), 'station-empty-claude-'),
    );
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = emptyGlobalDir;
    try {
      const importRes = await app.request('/agent/claude/app-home/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(importRes.status).toBe(200);
      const importBody = await readJson<{
        success: boolean;
        data: {
          outcome: string;
          copied: string[];
          provenanceUpdated: boolean;
        };
      }>(importRes);
      expect(importBody.success).toBe(true);
      expect(importBody.data.outcome).toBe('completed');
      expect(importBody.data.copied).toEqual([]);
      expect(importBody.data.provenanceUpdated).toBe(false);

      const statusRes = await app.request('/agent/claude/app-home');
      const statusBody = await readJson<{
        data: { exists: boolean; seededFrom?: string };
      }>(statusRes);
      expect(statusBody.data.exists).toBe(true);
      expect(statusBody.data.seededFrom).toBe('empty');
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      rmSync(emptyGlobalDir, { recursive: true, force: true });
    }
  });

  test('records the appHomeImport metric with outcome failed for an unreadable global config dir', async () => {
    // Item 5 (security review round 2): the reviewer noted no test pinned
    // either the 'failed' or 'error' telemetry outcome — this pins
    // 'failed' (MED-3's route branch).
    const app = createAppHomeRoutes();
    const missingGlobalDir = join(
      tmpdir(),
      `station-metric-failed-${Date.now()}`,
    );
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = missingGlobalDir;
    const addSpy = vi.spyOn(appHomeImport, 'add');
    try {
      await app.request('/agent/claude/app-home/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(addSpy).toHaveBeenCalledWith(1, {
        provider: 'claude',
        outcome: 'failed',
        credentials: 'excluded',
      });
    } finally {
      addSpy.mockRestore();
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  test('records the appHomeImport metric with outcome error when the import throws unexpectedly', async () => {
    // Item 5: pins the 'error' outcome — the route's catch-all path for an
    // exception that escapes the whole import attempt (here: triggered via
    // the HIGH fix's own refusal, a poisoned profile marker, reused purely
    // as a convenient real exception source).
    const app = createAppHomeRoutes();
    const dir = join(appHomesRootDir(), 'claude');
    mkdirSync(dir, { recursive: true });
    const sentinelTarget = join(
      tmpdir(),
      `station-sentinel-${Date.now()}.json`,
    );
    writeFileSync(sentinelTarget, 'do not touch');
    await symlink(sentinelTarget, join(dir, 'profile.json'));

    const addSpy = vi.spyOn(appHomeImport, 'add');
    try {
      const res = await app.request('/agent/claude/app-home/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await readJson<{ success: boolean }>(res);
      expect(body.success).toBe(false);

      expect(addSpy).toHaveBeenCalledWith(1, {
        provider: 'claude',
        outcome: 'error',
        credentials: 'excluded',
      });
    } finally {
      addSpy.mockRestore();
      rmSync(sentinelTarget, { force: true });
    }
  });

  test('rejects connections without app-home support', async () => {
    const app = createAppHomeRoutes();

    const getRes = await app.request('/agent/acp/app-home');
    expect(getRes.status).toBe(404);
    const getBody = await readJson<{ success: boolean }>(getRes);
    expect(getBody.success).toBe(false);

    const postRes = await app.request('/agent/acp/app-home/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(postRes.status).toBe(404);
  });

  // #896 wave 2: codex-runtime joins the app-home engine table.
  test('reports codex profile status with the profile-scoped auth state', async () => {
    const app = createAppHomeRoutes();

    const res = await app.request('/agent/codex/app-home');
    const body = await readJson<{
      success: boolean;
      data: {
        profileDir: string;
        exists: boolean;
        authState: string;
        keychainAuthPossible: boolean;
      };
    }>(res);

    expect(body.success).toBe(true);
    expect(body.data.exists).toBe(false);
    expect(body.data.profileDir).toBe(
      join(resolveHomeDir(), 'app-homes', 'codex'),
    );
    expect(body.data.authState).toBe('unauthenticated');
    // Codex auth is `auth.json`-based only — no macOS Keychain analog
    // (Ambiguity D).
    expect(body.data.keychainAuthPossible).toBe(false);
  });

  test('codex import requires the explicit credentials flag to copy auth.json', async () => {
    const app = createAppHomeRoutes();
    const fakeGlobalDir = await mkdtemp(join(tmpdir(), 'station-fake-codex-'));
    try {
      writeFileSync(
        join(fakeGlobalDir, 'auth.json'),
        JSON.stringify({ tokens: { access_token: 'x' } }),
      );
      writeFileSync(join(fakeGlobalDir, 'config.toml'), '[projects]\n');
      const previous = process.env.CODEX_HOME;
      process.env.CODEX_HOME = fakeGlobalDir;
      try {
        const res = await app.request('/agent/codex/app-home/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
        const body = await readJson<{
          data: {
            profileDir: string;
            copied: string[];
            skipped: Array<{ path: string; reason: string }>;
          };
        }>(res);
        expect(body.data.copied).toEqual(['config.toml']);
        expect(body.data.skipped).toEqual([
          { path: 'auth.json', reason: 'credentials-excluded' },
        ]);
        expect(existsSync(join(body.data.profileDir, 'auth.json'))).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previous;
      }
    } finally {
      rmSync(fakeGlobalDir, { recursive: true, force: true });
    }
  });

  test('codex import copies only the codex allowlist', async () => {
    const app = createAppHomeRoutes();
    const fakeGlobalDir = await mkdtemp(join(tmpdir(), 'station-fake-codex-'));
    try {
      writeFileSync(join(fakeGlobalDir, 'config.toml'), '[projects]\n');
      writeFileSync(join(fakeGlobalDir, 'AGENTS.md'), '# notes');
      writeFileSync(join(fakeGlobalDir, 'history.jsonl'), '{}');
      const previous = process.env.CODEX_HOME;
      process.env.CODEX_HOME = fakeGlobalDir;
      try {
        const res = await app.request('/agent/codex/app-home/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
        const body = await readJson<{
          data: { copied: string[]; skipped: Array<{ path: string }> };
        }>(res);
        expect(body.data.copied.sort()).toEqual(['AGENTS.md', 'config.toml']);
        expect(body.data.skipped.map((s) => s.path)).toEqual(['history.jsonl']);
      } finally {
        if (previous === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previous;
      }
    } finally {
      rmSync(fakeGlobalDir, { recursive: true, force: true });
    }
  });

  // #896 wave 2: bounded profile GC — usage report + explicit clear.
  test('status includes bounded usage for an existing profile', async () => {
    const app = createAppHomeRoutes();
    await app.request('/agent/claude/app-home/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await app.request('/agent/claude/app-home');
    const body = await readJson<{
      data: {
        exists: boolean;
        usage?: { sizeBytes: number; entryCount: number; truncated: boolean };
      };
    }>(res);

    expect(body.data.exists).toBe(true);
    expect(body.data.usage).toBeTruthy();
    expect(body.data.usage?.truncated).toBe(false);
    expect(body.data.usage?.entryCount).toBeGreaterThan(0);
  });

  test('clear refuses with 409 while the connection app home is enabled', async () => {
    const app = createAppHomeRoutes({
      isUseAppHomeEnabled: async () => true,
    });
    await app.request('/agent/claude/app-home/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await app.request('/agent/claude/app-home', {
      method: 'DELETE',
    });

    expect(res.status).toBe(409);
    const body = await readJson<{ success: boolean; error: string }>(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe(
      'Turn off "Run sessions in a Station-managed app home" for this connection before clearing its app home.',
    );
    // Nothing was actually cleared.
    const statusRes = await app.request('/agent/claude/app-home');
    const statusBody = await readJson<{ data: { exists: boolean } }>(statusRes);
    expect(statusBody.data.exists).toBe(true);
  });

  test('clear removes the profile and records the appHomeCleared metric', async () => {
    const app = createAppHomeRoutes({
      isUseAppHomeEnabled: async () => false,
    });
    await app.request('/agent/claude/app-home/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const addSpy = vi.spyOn(appHomeCleared, 'add');

    try {
      const res = await app.request('/agent/claude/app-home', {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const body = await readJson<{
        success: boolean;
        data: { cleared: boolean };
      }>(res);
      expect(body.success).toBe(true);
      expect(body.data.cleared).toBe(true);
      expect(addSpy).toHaveBeenCalledWith(1, { provider: 'claude' });

      const statusRes = await app.request('/agent/claude/app-home');
      const statusBody = await readJson<{ data: { exists: boolean } }>(
        statusRes,
      );
      expect(statusBody.data.exists).toBe(false);
    } finally {
      addSpy.mockRestore();
    }
  });

  test('clear 404s for a connection without app-home support', async () => {
    const app = createAppHomeRoutes();
    const res = await app.request('/agent/acp/app-home', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });

  test('credential recovery GET exposes the default-off management projection without an app-home path', async () => {
    const { service } = credentialRecoveryFixture();
    const app = createAppHomeRoutes({ connectionService: service as any });

    const res = await app.request('/agent/codex/credential-recovery');
    const body = await readJson<{
      success: boolean;
      data: {
        policy: { automatic: boolean };
        profiles: Array<{ label?: string }>;
      };
    }>(res);

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.policy.automatic).toBe(false);
    expect(body.data.profiles[0].label).toBe('Canary Account Label');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('profileDir');
    expect(serialized).not.toContain('/private/station');
  });

  test('credential recovery keeps unsupported projection visible but refuses apply and unsupported provisioning', async () => {
    const { service } = credentialRecoveryFixture('unsupported');
    const app = createAppHomeRoutes({ connectionService: service as any });

    const getRes = await app.request(
      '/agent/other-runtime/credential-recovery',
    );
    expect(getRes.status).toBe(200);
    await expect(
      readJson<{ data: { application: { capability: string } } }>(getRes),
    ).resolves.toMatchObject({
      data: { application: { capability: 'unsupported' } },
    });

    const applyRes = await app.request(
      '/agent/other-runtime/credential-recovery/profiles/profile-a/apply',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      },
    );
    expect(applyRes.status).toBe(409);
    const applyBody = await readJson<{
      success: boolean;
      data: { capability: string; outcome: string };
    }>(applyRes);
    expect(applyBody).toMatchObject({
      success: false,
      data: { capability: 'unsupported', outcome: 'unsupported' },
    });
    expect(service.applyCredentialProfile).not.toHaveBeenCalled();

    const importRes = await app.request(
      '/agent/other-runtime/credential-recovery/profiles/profile-a/import',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(importRes.status).toBe(404);

    const policyRes = await app.request(
      '/agent/other-runtime/credential-recovery/policy',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ automatic: true }),
      },
    );
    expect(policyRes.status).toBe(409);
    expect(
      await readJson<{ data: { application: { capability: string } } }>(
        policyRes,
      ),
    ).toMatchObject({
      data: { application: { capability: 'unsupported' } },
    });
    expect(service.setCredentialRecoveryAutomaticPolicy).not.toHaveBeenCalled();
  });

  test('credential recovery validates hostile refs and labels before service mutations', async () => {
    const { service } = credentialRecoveryFixture();
    const app = createAppHomeRoutes({ connectionService: service as any });

    const hostileRef = await app.request(
      '/agent/codex/credential-recovery/profiles',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: '../canary-secret' }),
      },
    );
    expect(hostileRef.status).toBe(400);
    const hostileLabel = await app.request(
      '/agent/codex/credential-recovery/profiles',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'profile-a', label: 'canary\nlabel' }),
      },
    );
    expect(hostileLabel.status).toBe(400);
    expect(service.upsertCredentialProfile).not.toHaveBeenCalled();
  });

  test('credential recovery reports a conflicting profile mutation instead of claiming it completed', async () => {
    const { service } = credentialRecoveryFixture();
    const app = createAppHomeRoutes({ connectionService: service as any });

    const res = await app.request(
      '/agent/codex/credential-recovery/profiles/profile-a',
      { method: 'DELETE' },
    );

    expect(res.status).toBe(409);
    expect(await readJson<{ success: boolean }>(res)).toMatchObject({
      success: false,
    });
  });

  test('credential recovery apply rejects a rolled-back application rather than claiming success', async () => {
    const { service } = credentialRecoveryFixture();
    const app = createAppHomeRoutes({ connectionService: service as any });

    const res = await app.request(
      '/agent/codex/credential-recovery/profiles/profile-a/apply',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true, timeoutMs: 20_000 }),
      },
    );
    const body = await readJson<{
      success: boolean;
      data: { capability: string; outcome: string; activeProfileRef: string };
    }>(res);

    expect(res.status).toBe(409);
    expect(body).toEqual({
      success: false,
      error:
        'Credential recovery state changed before the request could complete.',
      data: {
        capability: 'restart_resume',
        activeProfileRef: 'profile-a',
        outcome: 'rolled_back',
      },
    });
    expect(service.applyCredentialProfile).toHaveBeenCalledWith(
      'codex',
      'profile-a',
      { confirmed: true, timeoutMs: 20_000 },
    );
    expect(JSON.stringify(body)).not.toContain('Canary Account Label');
  });

  test('credential profile import uses the hashed candidate app home and never returns its path or copied credential material', async () => {
    const { service } = credentialRecoveryFixture();
    const app = createAppHomeRoutes({ connectionService: service as any });
    const globalDir = await mkdtemp(join(tmpdir(), 'station-profile-import-'));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = globalDir;
    const metricAdd = vi.spyOn(appHomeImport, 'add');
    try {
      writeFileSync(join(globalDir, 'config.toml'), '[projects]\n');
      writeFileSync(
        join(globalDir, 'auth.json'),
        JSON.stringify({ access_token: 'canary-credential-secret' }),
      );
      const res = await app.request(
        '/agent/codex/credential-recovery/profiles/profile-a/import',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ includeCredentials: false }),
        },
      );
      expect(res.status).toBe(200);
      const body = await readJson<{
        success: boolean;
        data: {
          copied: string[];
          skipped: Array<{ path: string; reason: string }>;
        };
      }>(res);
      expect(body.data.copied).toContain('config.toml');
      expect(body.data.skipped).toContainEqual({
        path: 'auth.json',
        reason: 'credentials-excluded',
      });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(globalDir);
      expect(serialized).not.toContain('canary-credential-secret');
      expect(serialized).not.toContain('profile-a');
      expect(serialized).not.toContain('profileDir');
      expect(metricAdd).toHaveBeenCalledWith(1, {
        provider: 'codex',
        outcome: 'copied',
        credentials: 'excluded',
      });
      expect(JSON.stringify(metricAdd.mock.calls)).not.toContain('profile-a');
      expect(JSON.stringify(metricAdd.mock.calls)).not.toContain(globalDir);
    } finally {
      metricAdd.mockRestore();
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      rmSync(globalDir, { recursive: true, force: true });
    }
  });
});

// station#3552: one entry per credential Station can reach — the connection's
// own account plus every enrolled profile — each read independently.
describe('credential usage route (station#3552)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('404s for a connection with no app-home channel', async () => {
    const app = createAppHomeRoutes();
    const res = await app.request('/agent/ollama/credential-usage');
    expect(res.status).toBe(404);
  });

  test("lists the connection's own account plus each enrolled profile", async () => {
    const { service } = credentialRecoveryFixture();
    // CODEX_HOME must point at an EMPTY dir, not the developer's real one:
    // otherwise this asserts against whatever account happens to be signed in
    // on the machine, and makes a live API call from a unit test.
    const empty = await mkdtemp(join(tmpdir(), 'usage-route-empty-'));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = empty;
    // Any network call here would be a defect; fail loudly rather than hang.
    globalThis.fetch = vi.fn(async () => {
      throw new Error('no credential should have been readable');
    }) as never;
    const app = createAppHomeRoutes({ connectionService: service as any });

    try {
      const res = await app.request('/agent/codex/credential-usage');
      const body = await readJson<{
        success: boolean;
        data: {
          credentials: Array<{
            ref: string | null;
            label: string;
            usage: { status: string; reason?: string };
          }>;
        };
      }>(res);

      expect(res.status).toBe(200);
      expect(body.data.credentials.map((entry) => entry.ref)).toEqual([
        null,
        'profile-a',
      ]);
      expect(body.data.credentials[0]?.label).toBe("This connection's account");
      expect(body.data.credentials[1]?.label).toBe('Canary Account Label');
      // Unknown, never a zeroed meter.
      for (const entry of body.data.credentials) {
        expect(entry.usage.status).toBe('unknown');
        expect(entry.usage.reason).toBeTruthy();
        expect(entry.usage).not.toHaveProperty('windows');
      }
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      rmSync(empty, { recursive: true, force: true });
    }
  });

  // One account being unreadable must never suppress another's reading.
  test('an unreadable account does not hide a readable one', async () => {
    const { service } = credentialRecoveryFixture();
    const dir = await mkdtemp(join(tmpdir(), 'usage-route-'));
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ access_token: 'tok', account_id: 'acct' }),
    );
    // Point the connection's global dir at a real signed-in config.
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dir;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            plan_type: 'pro',
            rate_limit: {
              allowed: true,
              limit_reached: false,
              primary_window: { used_percent: 7, reset_at: 1787463023 },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as never;
    try {
      const app = createAppHomeRoutes({ connectionService: service as any });
      const res = await app.request('/agent/codex/credential-usage');
      const body = await readJson<{
        data: {
          credentials: Array<{
            ref: string | null;
            usage: { status: string; windows?: Array<{ usedPercent: number }> };
          }>;
        };
      }>(res);
      const [connectionAccount, profile] = body.data.credentials;
      expect(connectionAccount?.usage.status).toBe('ok');
      expect(connectionAccount?.usage.windows?.[0]?.usedPercent).toBe(7);
      // The profile has no credential on disk and still reports independently.
      expect(profile?.usage.status).toBe('unknown');
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// station#3549: the command is returned, never spawned, and the auth state
// comes from asking the engine rather than reading a credential file.
describe('enrolment route (station#3549)', () => {
  test('404s for a connection with no app-home channel', async () => {
    const app = createAppHomeRoutes();
    const res = await app.request('/agent/ollama/enrolment/profile-a');
    expect(res.status).toBe(404);
  });

  test('404s for a ref that is not an enrolled profile', async () => {
    const { service } = credentialRecoveryFixture();
    const app = createAppHomeRoutes({ connectionService: service as any });
    const res = await app.request('/agent/codex/enrolment/not-a-profile');
    expect(res.status).toBe(404);
  });

  test("returns the engine's own login pointed at the profile home", async () => {
    const { service } = credentialRecoveryFixture();
    const app = createAppHomeRoutes({ connectionService: service as any });

    const res = await app.request('/agent/codex/enrolment/profile-a');
    const body = await readJson<{
      success: boolean;
      data: {
        profileDir: string;
        authState: string;
        command: {
          command: string;
          args: string[];
          env: Record<string, string>;
          description: string;
        };
      };
    }>(res);

    expect(res.status).toBe(200);
    expect(body.data.command.command).toBe('codex');
    expect(body.data.command.args).toEqual(['login']);
    // Points at the profile store, not the user's global config.
    expect(body.data.command.env.CODEX_HOME).toBe(body.data.profileDir);
    expect(body.data.profileDir).toContain('credential-profile-');
    // Station never puts a credential in the environment it hands the CLI.
    expect(Object.keys(body.data.command.env)).toEqual(['CODEX_HOME']);
    expect(JSON.stringify(body.data.command)).not.toMatch(
      /token|secret|password/i,
    );
    // No enrolment has happened, and the response must not imply one has.
    expect(body.data.authState).not.toBe('authenticated');
  });
});

// Review round 2 (Codex) deleted the route's per-account `.catch()` and this
// suite stayed green: the isolation test exercised a FULFILLED `unknown`, not
// a REJECTED read, so it never bound the guard it claimed to prove.
describe('credential usage isolates a rejected read (station#3552)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('one account whose read rejects does not 500 the others', async () => {
    const { service } = credentialRecoveryFixture();
    const dir = await mkdtemp(join(tmpdir(), 'usage-reject-'));
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ access_token: 'tok', account_id: 'acct' }),
    );
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dir;
    // `fetch` itself is fine; the rejection is forced deeper, at the point the
    // response body is read, which is inside the reader rather than the route.
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: () => Promise.reject(new Error('socket closed mid-body')),
        }) as unknown as Response,
    ) as never;
    try {
      const app = createAppHomeRoutes({ connectionService: service as any });
      const res = await app.request('/agent/codex/credential-usage');
      const body = await readJson<{
        success: boolean;
        data: {
          credentials: Array<{ ref: string | null; usage: { status: string } }>;
        };
      }>(res);

      // The whole request must still succeed, with both accounts represented.
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.credentials).toHaveLength(2);
      for (const entry of body.data.credentials) {
        expect(entry.usage.status).toBe('unknown');
      }
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

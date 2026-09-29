import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  credentialProfileAppHomeDir,
  credentialProfileStorageId,
  deleteCredentialProfile,
  ensureCredentialProfileAppHome,
  normalizeCredentialProfileRegistry,
  persistedCredentialProfileEnv,
  projectCredentialProfileRegistry,
  setCredentialProfileEnrollment,
  setCredentialProfileEnv,
  setCredentialRecoveryAutomaticPolicy,
  upsertCredentialProfile,
} from '../credential-profile-registry.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('credential profile registry', () => {
  test('normalizes hostile refs, duplicate refs, malformed membership, and default-off policy without retaining secrets', () => {
    const state = normalizeCredentialProfileRegistry({
      profiles: [
        { ref: ' profile-a ', label: ' Profile A ' },
        { ref: 'profile-a', label: 'duplicate' },
        { ref: '../escape', label: 'hostile' },
        { ref: 'profile-b', apiKey: 'canary-secret' },
        { ref: 'profile-c', label: 'unsafe\u0000label' },
      ],
      group: {
        profileRefs: [
          'profile-a',
          '../escape',
          'profile-b',
          'profile-b',
          'profile-c',
        ],
        enrolledProfileRefs: ['profile-b', 'not-a-member'],
      },
      policy: { automatic: 'true' },
      activeProfileRef: '../escape',
      rawCredential: 'canary-secret',
    });

    expect(state).toEqual({
      profiles: [
        { ref: 'profile-a', label: 'Profile A' },
        { ref: 'profile-b' },
        { ref: 'profile-c' },
      ],
      group: {
        profileRefs: ['profile-a', 'profile-b', 'profile-c'],
        enrolledProfileRefs: ['profile-b'],
      },
      policy: { automatic: false },
    });
    expect(JSON.stringify(state)).not.toContain('canary-secret');
  });

  test('requires explicit enrollment and default-off policy, and refuses deletion of protected profiles', () => {
    const added = upsertCredentialProfile(
      {},
      { ref: 'profile-a', label: 'Account A' },
    ).state;
    expect(
      projectCredentialProfileRegistry(added, 'restart_resume'),
    ).toMatchObject({
      policy: { automatic: false },
      group: { profileRefs: ['profile-a'], enrolledProfileRefs: [] },
    });
    const enrolled = setCredentialProfileEnrollment(
      added,
      'profile-a',
      true,
    ).state;
    expect(deleteCredentialProfile(enrolled, 'profile-a').transition).toBe(
      'rejected',
    );
    const unenrolled = setCredentialProfileEnrollment(
      enrolled,
      'profile-a',
      false,
    ).state;
    expect(deleteCredentialProfile(unenrolled, 'profile-a').transition).toBe(
      'ignored',
    );
    expect(
      setCredentialRecoveryAutomaticPolicy(added, true).state.policy,
    ).toEqual({ automatic: true });
  });

  test('derives deterministic filesystem-safe app-home ids from engine and opaque ref without using the ref as a path', async () => {
    const homeDir = await mkdtemp(
      join(tmpdir(), 'station-credential-profile-'),
    );
    tempDirs.push(homeDir);
    const ref = 'opaque-profile:alpha';
    const id = credentialProfileStorageId('codex', ref);
    expect(id).toMatch(/^credential-profile-[a-f0-9]{64}$/);
    expect(id).not.toContain(ref);
    expect(credentialProfileStorageId('codex', ref)).toBe(id);
    expect(credentialProfileStorageId('claude', ref)).not.toBe(id);
    const ensured = await ensureCredentialProfileAppHome('codex', ref, {
      homeDir,
    });
    expect(ensured.dir).toBe(
      credentialProfileAppHomeDir('codex', ref, homeDir),
    );
    expect(ensured.dir).toContain(join(homeDir, 'app-homes'));
    expect(ensured.dir).not.toContain(ref);
  });

  describe('#2966 env overlay', () => {
    const routed = {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8318',
      ANTHROPIC_API_KEY: '',
    };

    test('a valid overlay survives normalization and reaches the projection', () => {
      const state = normalizeCredentialProfileRegistry({
        profiles: [{ ref: 'proxy', label: 'Proxy', env: routed }],
      });
      expect(state.profiles).toEqual([
        { ref: 'proxy', label: 'Proxy', env: routed },
      ]);
      expect(
        projectCredentialProfileRegistry(state, 'restart_resume').profiles,
      ).toEqual([{ ref: 'proxy', label: 'Proxy', env: routed }]);
    });

    test('an overlay with a refused entry is dropped whole, never partially kept', () => {
      const state = normalizeCredentialProfileRegistry({
        profiles: [
          {
            ref: 'tampered',
            env: { ...routed, ANTHROPIC_AUTH_TOKEN: 'canary-secret' },
          },
          { ref: 'home-key', env: { ...routed, CLAUDE_CONFIG_DIR: '/x' } },
        ],
      });
      expect(state.profiles).toEqual([
        { ref: 'tampered' },
        { ref: 'home-key' },
      ]);
      expect(JSON.stringify(state)).not.toContain('canary-secret');
      // The raw value stays reachable for the spawn-time resolver to refuse.
      expect(
        persistedCredentialProfileEnv(
          {
            profiles: [
              {
                ref: 'tampered',
                env: { ANTHROPIC_AUTH_TOKEN: 'canary-secret' },
              },
            ],
          },
          'tampered',
        ),
      ).toEqual({ ANTHROPIC_AUTH_TOKEN: 'canary-secret' });
    });

    test('a label-only upsert preserves an existing overlay', () => {
      const withEnv = setCredentialProfileEnv(
        upsertCredentialProfile({}, { ref: 'proxy', label: 'Old' }).state,
        'proxy',
        routed,
      ).state;
      const relabelled = upsertCredentialProfile(withEnv, {
        ref: 'proxy',
        label: 'New',
      }).state;
      expect(relabelled.profiles).toEqual([
        { ref: 'proxy', label: 'New', env: routed },
      ]);
      // Re-normalizing the persisted result (what the next read does) keeps it.
      expect(
        normalizeCredentialProfileRegistry(
          JSON.parse(JSON.stringify(relabelled)),
        ).profiles,
      ).toEqual([{ ref: 'proxy', label: 'New', env: routed }]);
    });

    test('setCredentialProfileEnv replaces wholesale, clears with {}, and rejects invalid or unknown input', () => {
      const base = setCredentialProfileEnv(
        upsertCredentialProfile({}, { ref: 'proxy' }).state,
        'proxy',
        routed,
      ).state;
      const replaced = setCredentialProfileEnv(base, 'proxy', {
        OPENAI_BASE_URL: 'http://127.0.0.1:9000',
      });
      expect(replaced.state.profiles).toEqual([
        { ref: 'proxy', env: { OPENAI_BASE_URL: 'http://127.0.0.1:9000' } },
      ]);
      expect(setCredentialProfileEnv(base, 'proxy', {}).state.profiles).toEqual(
        [{ ref: 'proxy' }],
      );
      const refused = setCredentialProfileEnv(base, 'proxy', {
        ANTHROPIC_AUTH_TOKEN: 'canary-secret',
      });
      expect(refused.transition).toBe('rejected');
      expect(refused.state.profiles).toEqual([{ ref: 'proxy', env: routed }]);
      expect(setCredentialProfileEnv(base, 'missing', {}).transition).toBe(
        'rejected',
      );
    });
  });
});

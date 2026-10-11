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
  persistedCredentialProfile,
  projectCredentialProfileRegistry,
  projectPublicCredentialProfiles,
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

    test('an invalid saved overlay is persisted as a value-free marker that survives unrelated writes until a valid overlay replaces it', () => {
      const canary = 'sk-live-canary';
      const tampered = { ...routed, ANTHROPIC_AUTH_TOKEN: canary };
      const saved = {
        profiles: [{ ref: 'a' }, { ref: 'b', label: 'B', env: tampered }],
        group: { profileRefs: ['a', 'b'], enrolledProfileRefs: [] },
      };
      const marked = {
        ref: 'b',
        label: 'B',
        envInvalid: { names: ['ANTHROPIC_AUTH_TOKEN'] },
      };
      // Reading a hand-edited registry already drops the values.
      const normalized = normalizeCredentialProfileRegistry(saved);
      expect(normalized.profiles[1]).toEqual(marked);
      expect(JSON.stringify(normalized)).not.toContain(canary);
      // An unrelated write (relabel a) persists what normalization produced:
      // the marker survives, the values do not.
      const written = JSON.parse(
        JSON.stringify(
          upsertCredentialProfile(saved, { ref: 'a', label: 'A' }).state,
        ),
      );
      expect(JSON.stringify(written)).not.toContain(canary);
      expect(written.profiles[1]).toEqual(marked);
      // ...and a second unrelated write keeps the persisted marker.
      const rewritten = JSON.parse(
        JSON.stringify(
          setCredentialRecoveryAutomaticPolicy(written, true).state,
        ),
      );
      expect(rewritten.profiles[1]).toEqual(marked);
      expect(
        upsertCredentialProfile(rewritten, { ref: 'b', label: 'B2' }).state
          .profiles[1],
      ).toEqual({ ...marked, label: 'B2' });
      expect(persistedCredentialProfile(rewritten, 'b')).toEqual(marked);
      const projected = projectCredentialProfileRegistry(
        rewritten,
        'restart_resume',
      );
      expect(projected.profiles[1]).toEqual(marked);
      // Replacing the overlay with a valid one is the repair path and clears
      // the marker.
      expect(
        setCredentialProfileEnv(rewritten, 'b', routed).state.profiles[1],
      ).toEqual({ ref: 'b', label: 'B', env: routed });
      expect(
        setCredentialProfileEnv(rewritten, 'b', {}).state.profiles[1],
      ).toEqual({ ref: 'b', label: 'B' });
    });

    test('a persisted marker wins over an env beside it and never echoes malformed or unbounded names', () => {
      const state = normalizeCredentialProfileRegistry({
        profiles: [
          {
            ref: 'hand-fixed',
            env: routed,
            envInvalid: { names: ['ANTHROPIC_AUTH_TOKEN'] },
          },
          {
            ref: 'hostile-names',
            envInvalid: {
              names: [
                'OK_NAME',
                'sk-live-canary with spaces',
                'A'.repeat(129),
                7,
                'OK_NAME',
              ],
            },
          },
          { ref: 'bare-marker', envInvalid: true },
          { ref: 'empty-marker', env: routed, envInvalid: {} },
          { ref: 'bad-name', env: { 'sk-live-canary=': 'x' } },
          {
            ref: 'many',
            env: Object.fromEntries(
              Array.from({ length: 100 }, (_, i) => [`V${i}_TOKEN`, 'x']),
            ),
          },
        ],
      });
      expect(state.profiles.slice(0, 5)).toEqual([
        { ref: 'hand-fixed', envInvalid: { names: ['ANTHROPIC_AUTH_TOKEN'] } },
        { ref: 'hostile-names', envInvalid: { names: ['OK_NAME'] } },
        { ref: 'bare-marker', envInvalid: { names: [] } },
        { ref: 'empty-marker', envInvalid: { names: [] } },
        { ref: 'bad-name', envInvalid: { names: [] } },
      ]);
      expect(state.profiles[5]?.envInvalid?.names).toHaveLength(64);
      expect(state.profiles[5]?.env).toBeUndefined();
      expect(JSON.stringify(state)).not.toContain('sk-live-canary');
    });

    test('the public profile projection of a raw registry never carries invalid values', () => {
      expect(
        projectPublicCredentialProfiles([
          { ref: 'ok', env: routed },
          { ref: 'bad', env: { ANTHROPIC_API_KEY: 'sk-live-canary' } },
          { ref: '../escape', env: routed },
        ]),
      ).toEqual([
        { ref: 'ok', env: routed },
        { ref: 'bad', envInvalid: { names: ['ANTHROPIC_API_KEY'] } },
      ]);
      expect(projectPublicCredentialProfiles('garbage')).toEqual([]);
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

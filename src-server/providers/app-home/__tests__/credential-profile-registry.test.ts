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
  projectCredentialProfileRegistry,
  setCredentialProfileEnrollment,
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
});

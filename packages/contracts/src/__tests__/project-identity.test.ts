/**
 * station#1498 slice 1 — `ProjectManifest` validation and the
 * `ResourceResolutionResult` honesty predicate
 * (`docs/design/portable-project-identity.md` §3.2, §3.4, §3.5, §3.6).
 */

import { describe, expect, test } from 'vitest';
import {
  isLocalCloneSource,
  isSelectionAmbiguityOnly,
  isWellFormedResolution,
  PROJECT_MANIFEST_SCHEMA_VERSION,
  type ProjectManifest,
  type ProjectRepoResource,
  RESOURCE_RESOLUTION_STATES,
  type ResourceResolutionResult,
  SELECTION_AMBIGUITY_CODES,
  selectPrimaryResource,
  validateProjectManifest,
} from '../project-identity.js';

function minimalManifest(): ProjectManifest {
  return {
    schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
    id: 'prj_test123',
    slug: 'station',
    name: 'Station',
    repos: [
      {
        kind: 'git',
        id: 'github.com/kontourai/station',
        canonicalRemote: 'github.com/kontourai/station',
        role: 'primary',
      },
    ],
    knowledge: [{ namespaceId: 'default', root: { kind: 'station-managed' } }],
    agents: ['reviewer'],
    integrations: [{ id: 'linear', kind: 'mcp', auth: { station: 'linear' } }],
    layouts: ['coding'],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

describe('validateProjectManifest — valid input', () => {
  test('a valid minimal manifest passes', () => {
    const result = validateProjectManifest(minimalManifest());
    expect(result.ok).toBe(true);
  });

  test('a valid manifest with a local-only resource and repo-relative knowledge passes', () => {
    const manifest: ProjectManifest = {
      ...minimalManifest(),
      repos: [
        ...minimalManifest().repos,
        { kind: 'local-only', id: 'local:scratch', label: 'Scratch notes' },
      ],
      knowledge: [
        {
          namespaceId: 'rules',
          root: {
            kind: 'repo',
            repoId: 'github.com/kontourai/station',
            path: 'docs',
          },
        },
      ],
    };
    const result = validateProjectManifest(manifest);
    expect(result.ok).toBe(true);
  });
});

describe('validateProjectManifest — the five rejection classes', () => {
  test('class 1: unknown/absent schemaVersion is refused with a NAMED error, never cast', () => {
    const manifest = { ...minimalManifest(), schemaVersion: 999 };
    const result = validateProjectManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('schemaVersion:'))).toBe(
        true,
      );
    }
  });

  test('class 1b: a manifest with no schemaVersion field at all is refused', () => {
    const manifest = minimalManifest() as unknown as Record<string, unknown>;
    delete manifest.schemaVersion;
    const result = validateProjectManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('schemaVersion:'))).toBe(
        true,
      );
    }
  });

  test('class 2: an absolute filesystem path in a knowledge root path position is refused', () => {
    const manifest: ProjectManifest = {
      ...minimalManifest(),
      knowledge: [
        {
          namespaceId: 'rules',
          root: {
            kind: 'repo',
            repoId: 'github.com/kontourai/station',
            path: '/etc/passwd',
          },
        },
      ],
    };
    const result = validateProjectManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) =>
            e.includes('knowledge[0].root.path') && e.includes('repo-relative'),
        ),
      ).toBe(true);
    }
  });

  test('class 2b: a tilde-prefixed path is refused', () => {
    const manifest: ProjectManifest = {
      ...minimalManifest(),
      knowledge: [
        {
          namespaceId: 'rules',
          root: {
            kind: 'repo',
            repoId: 'github.com/kontourai/station',
            path: '~/secrets',
          },
        },
      ],
    };
    const result = validateProjectManifest(manifest);
    expect(result.ok).toBe(false);
  });

  test('class 2c: a Windows drive-letter path is refused', () => {
    const manifest: ProjectManifest = {
      ...minimalManifest(),
      knowledge: [
        {
          namespaceId: 'rules',
          root: {
            kind: 'repo',
            repoId: 'github.com/kontourai/station',
            path: 'C:\\secrets',
          },
        },
      ],
    };
    const result = validateProjectManifest(manifest);
    expect(result.ok).toBe(false);
  });

  test('class 2d: a UNC path is refused', () => {
    const manifest: ProjectManifest = {
      ...minimalManifest(),
      knowledge: [
        {
          namespaceId: 'rules',
          root: {
            kind: 'repo',
            repoId: 'github.com/kontourai/station',
            path: '\\\\server\\share',
          },
        },
      ],
    };
    const result = validateProjectManifest(manifest);
    expect(result.ok).toBe(false);
  });

  test('class 2e: canonicalRemote and aliases are NOT treated as path positions — a base URL passes', () => {
    const manifest: ProjectManifest = {
      ...minimalManifest(),
      repos: [
        {
          kind: 'git',
          id: 'git.internal.example.com/kontourai/station',
          canonicalRemote: 'git.internal.example.com/kontourai/station',
          aliases: ['github.com/kontourai/station'],
        },
      ],
    };
    const result = validateProjectManifest(manifest);
    expect(result.ok).toBe(true);
  });

  test('class 3: a key-looking literal in an env auth field is refused', () => {
    const manifest: ProjectManifest = {
      ...minimalManifest(),
      integrations: [
        {
          id: 'linear',
          kind: 'mcp',
          auth: { env: 'sk_live_abcdefghijklmnopqrstuvwxyz0123456789' },
        },
      ],
    };
    const result = validateProjectManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.startsWith('integrations[0].auth.env:')),
      ).toBe(true);
    }
  });

  test('class 3b: an op reference not shaped like op://... is refused', () => {
    const manifest: ProjectManifest = {
      ...minimalManifest(),
      integrations: [
        { id: 'linear', kind: 'mcp', auth: { op: 'not-an-op-ref' } },
      ],
    };
    const result = validateProjectManifest(manifest);
    expect(result.ok).toBe(false);
  });

  test('class 3c: a well-formed op reference passes even though it is long', () => {
    // The reference here is 39 characters after "op://". The previous
    // revision used `op://vault/item/field`, whose inspected remainder is 16
    // characters — under the retired >=20 length heuristic, so it proved
    // nothing about long references passing.
    const manifest: ProjectManifest = {
      ...minimalManifest(),
      integrations: [
        {
          id: 'linear',
          kind: 'mcp',
          auth: { op: 'op://engineering-vault/github-deploy/token' },
        },
      ],
    };
    const result = validateProjectManifest(manifest);
    expect(result.ok).toBe(true);
  });

  test('class 4: more than one backend key on a single ProjectAuthReference is refused', () => {
    const manifest: ProjectManifest = {
      ...minimalManifest(),
      integrations: [
        {
          id: 'linear',
          kind: 'mcp',
          auth: { env: 'LINEAR_TOKEN', station: 'linear' } as unknown as {
            env: string;
          },
        },
      ],
    };
    const result = validateProjectManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.includes('exactly one auth backend')),
      ).toBe(true);
    }
  });

  test('class 4b: zero backend keys on a ProjectAuthReference is refused', () => {
    const manifest: ProjectManifest = {
      ...minimalManifest(),
      integrations: [
        { id: 'linear', kind: 'mcp', auth: {} as unknown as { env: string } },
      ],
    };
    const result = validateProjectManifest(manifest);
    expect(result.ok).toBe(false);
  });

  test('class 5: missing id/slug/name are each refused', () => {
    const manifest = minimalManifest() as unknown as Record<string, unknown>;
    delete manifest.id;
    delete manifest.slug;
    delete manifest.name;
    const result = validateProjectManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('id:'))).toBe(true);
      expect(result.errors.some((e) => e.startsWith('slug:'))).toBe(true);
      expect(result.errors.some((e) => e.startsWith('name:'))).toBe(true);
    }
  });

  test('class 5b: a non-array repos field is refused', () => {
    const manifest = { ...minimalManifest(), repos: 'not-an-array' };
    const result = validateProjectManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e === 'repos: must be an array')).toBe(
        true,
      );
    }
  });

  test('class 5c: a git repo resource whose id !== canonicalRemote is refused', () => {
    const manifest: ProjectManifest = {
      ...minimalManifest(),
      repos: [
        {
          kind: 'git',
          id: 'github.com/kontourai/station-wrong',
          canonicalRemote: 'github.com/kontourai/station',
        },
      ],
    };
    const result = validateProjectManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) => e.includes('repos[0].id') && e.includes('canonicalRemote'),
        ),
      ).toBe(true);
    }
  });

  test('class 5d: a canonicalRemote that is not already canonical is refused', () => {
    const manifest: ProjectManifest = {
      ...minimalManifest(),
      repos: [
        {
          kind: 'git',
          id: 'git@github.com:kontourai/station.git',
          canonicalRemote: 'git@github.com:kontourai/station.git',
        },
      ],
    };
    const result = validateProjectManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) =>
            e.includes('repos[0].canonicalRemote') && e.includes('canonical'),
        ),
      ).toBe(true);
    }
  });

  test('errors accumulate rather than stopping at the first (schemaVersion is the one deliberate exception — it GATES; see the transition suite)', () => {
    const manifest = {
      ...minimalManifest(),
      repos: 'not-an-array',
      layouts: 'not-an-array',
    };
    delete (manifest as unknown as Record<string, unknown>).id;
    const result = validateProjectManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('validateProjectManifest — transition / round-trip coverage', () => {
  test('a manifest round-trips through JSON.parse(JSON.stringify(...)) and still validates', () => {
    const manifest = minimalManifest();
    const roundTripped = JSON.parse(JSON.stringify(manifest));
    const before = validateProjectManifest(manifest);
    const after = validateProjectManifest(roundTripped);
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
  });

  test('the SAME manifest object validates at schemaVersion 1, then is REFUSED once its schemaVersion is bumped to 2 — a transition, not just a first-time value', () => {
    const manifest = minimalManifest() as unknown as Record<string, unknown>;
    const first = validateProjectManifest(manifest);
    expect(first.ok).toBe(true);

    manifest.schemaVersion = 2;
    const second = validateProjectManifest(manifest);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.errors.some((e) => e.startsWith('schemaVersion:'))).toBe(
        true,
      );
    }
  });

  test('a v2 document reports ONLY the version error — v1 field assertions are never applied to it', () => {
    // Before the gate returned, a v2-shaped document reported
    // `repos: must be an array` and `agents: must be a string array`
    // alongside the version error, which reads as if the v2 producer emitted
    // malformed fields. The only true fact is that this reader cannot read
    // it.
    const v2Document = {
      schemaVersion: 2,
      id: 'prj_test123',
      slug: 'station',
      name: 'Station',
      repos: { 'github.com/kontourai/station': { kind: 'git' } },
      agents: 'reviewer',
    };
    const result = validateProjectManifest(v2Document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/^schemaVersion:/);
    }
  });
});

describe('isWellFormedResolution', () => {
  test('bound with a path passes', () => {
    const result: ResourceResolutionResult = {
      state: 'bound',
      resourceId: 'github.com/kontourai/station',
      path: '/Users/brian/dev/station',
    };
    expect(isWellFormedResolution(result)).toBe(true);
  });

  test('bound without a path fails', () => {
    // No `ResourceResolutionResult` annotation, here or below: since
    // station#1594 the type is a discriminated union, so annotating these
    // deliberately-malformed shapes is a COMPILE error. That is the point —
    // the predicate's remaining job is the producers the compiler never sees,
    // which is why its parameter is `unknown`.
    expect(
      isWellFormedResolution({
        state: 'bound',
        resourceId: 'github.com/kontourai/station',
      }),
    ).toBe(false);
  });

  test.each([
    'unbound',
    'missing',
    'drifted',
    'stale',
    'unresolvable',
    'not-portable',
  ] as const)('%s without a reason fails', (state) => {
    expect(
      isWellFormedResolution({
        state,
        resourceId: 'github.com/kontourai/station',
      }),
    ).toBe(false);
  });

  test.each([
    ['unbound', {}],
    [
      'missing',
      { record: 'working-directory' as const, declaredPath: '~/dev/gone' },
    ],
    ['drifted', { unverifiedPath: '/Users/brian/dev/station' }],
    ['stale', { unverifiedPath: '/Users/brian/dev/station' }],
    ['unresolvable', {}],
    ['not-portable', {}],
  ] as const)(
    '%s with a reason, its required observations, and no path passes',
    (state, extra) => {
      expect(
        isWellFormedResolution({
          state,
          resourceId: 'github.com/kontourai/station',
          reason: 'binding not found',
          ...extra,
        }),
      ).toBe(true);
    },
  );

  test('a non-bound state WITH a path fails, even when a reason is also present', () => {
    // Slice 1's invariant, unchanged by #1594: `path` is the ANSWER slot and
    // only `bound` may answer.
    expect(
      isWellFormedResolution({
        state: 'missing',
        resourceId: 'github.com/kontourai/station',
        reason: 'path no longer exists',
        record: 'binding',
        declaredPath: '/Users/brian/dev/station',
        path: '/Users/brian/dev/station',
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// station#1594 — the DECLARATION and OBSERVATION slots.
//
// The root defect these close: the result reported a derived label and threw
// away the observations it was derived from. Both slots are enforced in BOTH
// directions — required where the resolver holds the fact, FORBIDDEN where it
// does not. The forbidding half is the one that matters: a `missing` result
// carrying an `unverifiedPath` would be a path on a state that never checked
// one, which is exactly the leak slice 1's invariant exists to prevent.
// ---------------------------------------------------------------------------

describe('isWellFormedResolution — `missing` carries its record (station#1594)', () => {
  const base = {
    state: 'missing',
    resourceId: 'github.com/kontourai/station',
    reason: 'gone',
  };

  test('a missing result with a record and a declaredPath passes', () => {
    expect(
      isWellFormedResolution({
        ...base,
        record: 'binding',
        declaredPath: '~/dev/station',
      }),
    ).toBe(true);
    expect(
      isWellFormedResolution({
        ...base,
        record: 'working-directory',
        declaredPath: '~/dev/station',
      }),
    ).toBe(true);
  });

  test.each([
    ['no record at all', { declaredPath: '~/dev/station' }],
    ['an invented record', { record: 'guess', declaredPath: '~/dev/station' }],
    ['no declaredPath', { record: 'binding' }],
    ['an empty declaredPath', { record: 'binding', declaredPath: '' }],
  ])('a missing result with %s fails', (_label, extra) => {
    expect(isWellFormedResolution({ ...base, ...extra })).toBe(false);
  });

  test.each([
    'bound',
    'unbound',
    'drifted',
    'stale',
    'ambiguous',
    'unresolvable',
    'not-portable',
  ] as const)('%s carrying a record/declaredPath fails', (state) => {
    const shape =
      state === 'bound'
        ? { state, resourceId: 'r', path: '/p' }
        : {
            state,
            resourceId: state === 'ambiguous' ? '' : 'r',
            reason: 'because',
            ...(state === 'drifted' || state === 'stale'
              ? { unverifiedPath: '/p' }
              : {}),
          };
    expect(isWellFormedResolution(shape)).toBe(true);
    expect(
      isWellFormedResolution({
        ...shape,
        record: 'binding',
        declaredPath: '/p',
      }),
    ).toBe(false);
  });
});

describe('isWellFormedResolution — `stale`/`drifted` carry their observation (station#1594)', () => {
  test.each(['stale', 'drifted'] as const)(
    '%s without an unverifiedPath fails — the resolver HAD the directory and is required to say so',
    (state) => {
      expect(
        isWellFormedResolution({ state, resourceId: 'r', reason: 'because' }),
      ).toBe(false);
      expect(
        isWellFormedResolution({
          state,
          resourceId: 'r',
          reason: 'because',
          unverifiedPath: '',
        }),
      ).toBe(false);
    },
  );

  test.each([
    'bound',
    'unbound',
    'missing',
    'ambiguous',
    'unresolvable',
    'not-portable',
  ] as const)('%s carrying an unverifiedPath fails', (state) => {
    const shape =
      state === 'bound'
        ? { state, resourceId: 'r', path: '/p' }
        : {
            state,
            resourceId: state === 'ambiguous' ? '' : 'r',
            reason: 'because',
            ...(state === 'missing'
              ? { record: 'binding', declaredPath: '/p' }
              : {}),
          };
    expect(isWellFormedResolution(shape)).toBe(true);
    expect(isWellFormedResolution({ ...shape, unverifiedPath: '/p' })).toBe(
      false,
    );
  });

  test('a non-object is refused rather than throwing — these arrive off disk', () => {
    for (const value of [null, undefined, 'bound', 42, ['bound']]) {
      expect(isWellFormedResolution(value)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// station#1498 review round 1 — the §3.2 exclusions the module docblock
// claims, asserted in every field position the claim covers. Four of the five
// HIGH findings were the same shape: a rule enforced in exactly one field
// while the docblock described it as enforced.
// ---------------------------------------------------------------------------

/** A manifest whose sole integration carries `auth`, for the §3.4 table. */
function manifestWithAuth(auth: unknown): Record<string, unknown> {
  return {
    ...minimalManifest(),
    integrations: [{ id: 'linear', kind: 'mcp', auth }],
  };
}

describe('§3.2 — a local filesystem path can never reach a git resource (HIGH-1)', () => {
  test('a file:// remote canonicalizes to an absolute path, is therefore idempotent, and is REFUSED as a canonicalRemote', () => {
    // normalizeGitOrigin('file:///Users/brian/dev/acme-client/repo') is
    // '/users/brian/dev/acme-client/repo' — see
    // `git-remote-identity.test.ts`'s file:// row, which asserts exactly that
    // mapping. It passes the already-canonical check, so §5's migration
    // (which derives canonicalRemote from an observed `git remote`) would
    // otherwise publish a member's home directory and a client name in the
    // manifest's most-displayed field.
    const canonical = '/users/brian/dev/acme-client/repo';
    const result = validateProjectManifest({
      ...minimalManifest(),
      repos: [
        {
          kind: 'git',
          id: canonical,
          canonicalRemote: canonical,
          role: 'primary',
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) =>
            e.startsWith('repos[0].canonicalRemote:') &&
            e.includes('local-only'),
        ),
      ).toBe(true);
    }
  });

  test('an absolute-path alias is refused, naming repos[i].aliases[j]', () => {
    const result = validateProjectManifest({
      ...minimalManifest(),
      repos: [
        {
          kind: 'git',
          id: 'github.com/kontourai/station',
          canonicalRemote: 'github.com/kontourai/station',
          role: 'primary',
          aliases: ['/users/brian/dev/station-mirror'],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) =>
            e.startsWith('repos[0].aliases[0]:') && e.includes('local-only'),
        ),
      ).toBe(true);
    }
  });
});

describe('§3.3 — every declared alias must already be canonical (HIGH-2)', () => {
  test('an alias pasted verbatim out of `git remote -v` is refused rather than silently matching nothing', () => {
    // Matching is set-intersection of a binding's CANONICALIZED remotes
    // against `{canonicalRemote} ∪ aliases` (§3.3(b)/(c)). A raw scp-style
    // alias intersects nothing, so the resource resolves `unbound` forever
    // and the repair prompt tells an operator to clone a repo they have.
    const result = validateProjectManifest({
      ...minimalManifest(),
      repos: [
        {
          kind: 'git',
          id: 'github.com/kontourai/station',
          canonicalRemote: 'github.com/kontourai/station',
          role: 'primary',
          aliases: ['git@git.internal:kontourai/station.git'],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) =>
            e.startsWith('repos[0].aliases[0]:') && e.includes('canonical'),
        ),
      ).toBe(true);
    }
  });

  test('the second alias in a list is checked too, naming its own index', () => {
    const result = validateProjectManifest({
      ...minimalManifest(),
      repos: [
        {
          kind: 'git',
          id: 'github.com/kontourai/station',
          canonicalRemote: 'github.com/kontourai/station',
          role: 'primary',
          aliases: [
            'git.internal.example.com/kontourai/station',
            'https://GitHub.com/KontourAI/Station',
          ],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.startsWith('repos[0].aliases[1]:')),
      ).toBe(true);
    }
  });
});

describe('§3.4 — auth references that are legitimate and long (HIGH-3 accept table)', () => {
  test.each([
    ['env', { env: 'AWS_SECRET_ACCESS_KEY' }],
    ['env', { env: 'GITHUB_PERSONAL_ACCESS_TOKEN' }],
    ['env', { env: 'STATION_LINEAR_TOKEN' }],
    ['station', { station: 'com.kontourai.station.linear' }],
    [
      'keychain',
      { keychain: { service: 'station', account: 'brian@briananderson.xyz' } },
    ],
    ['op', { op: 'op://engineering-vault/github-deploy/token' }],
  ])('%s: %j is accepted', (_backend, auth) => {
    // Every one of these was REJECTED by the retired `length >= 20 && no
    // whitespace` heuristic. Each field it guarded is whitespace-free by
    // construction, so the heuristic degenerated to a length test and
    // >=20-character identifiers are the norm in all four backends.
    const result = validateProjectManifest(manifestWithAuth(auth));
    expect(result.ok).toBe(true);
  });
});

describe('§3.4 — auth values that are actually secrets (HIGH-3 reject table)', () => {
  test.each([
    [
      'an AWS access key id in an env position',
      { env: 'AKIAIOSFODNN7EXAM' },
      'integrations[0].auth.env:',
    ],
    [
      'a Stripe-style live key in a keychain service position',
      { keychain: { service: 'sk_live_9aZ2Kq1x' } },
      'integrations[0].auth.keychain.service:',
    ],
    [
      'a live key smuggled behind an op:// prefix',
      { op: 'op://sk_live_9aZ2Kq1x' },
      'integrations[0].auth.op:',
    ],
  ])('%s is refused', (_label, auth, expectedPrefix) => {
    // All three were ACCEPTED by the retired length heuristic. Each is
    // caught by the known-credential-prefix signal — the only leak evidence
    // the validator actually has. See decision 5 for what it does not catch:
    // a secret with no recognizable prefix, in any field.
    const result = validateProjectManifest(manifestWithAuth(auth));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith(expectedPrefix))).toBe(
        true,
      );
    }
  });

  test('a suggestive but well-formed env variable NAME is accepted', () => {
    // Deliberate, and the counterpart to decision 5's honesty note: an `env`
    // reference is a variable NAME, and the secret it points at never enters
    // the manifest. An earlier revision refused this by requiring
    // UPPER_SNAKE_CASE, which would have refused a legitimate lowercase
    // variable too — enforcing a naming convention under a security banner is
    // the same proxy mistake as the length heuristic it replaced.
    const result = validateProjectManifest(
      manifestWithAuth({ env: 'hunter2_password' }),
    );
    expect(result.ok).toBe(true);
  });

  test('a JWT pasted into an op reference is refused', () => {
    const result = validateProjectManifest(
      manifestWithAuth({ op: 'op://eyJhbGciOiJIUzI1NiJ9.payload.sig' }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('§3.2 — a local-only resource id is grammar-constrained (HIGH-4a)', () => {
  test.each([
    ['an absolute filesystem path', '/Users/brian/dev/secret-client/repo'],
    ['a tilde-prefixed path', '~/dev/x'],
    ['a bare name with no local: prefix', 'scratch'],
    ['a local: prefix with a path inside it', 'local:/Users/brian/dev'],
  ])('%s is refused as a local-only id', (_label, id) => {
    // §5 turns today's directory-only Project into a local-only resource,
    // and the only value on hand for its id is that directory. The grammar
    // closes that migration hole by construction.
    const result = validateProjectManifest({
      ...minimalManifest(),
      repos: [...minimalManifest().repos, { kind: 'local-only', id }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) => e.startsWith('repos[1].id:') && e.includes('local:<name>'),
        ),
      ).toBe(true);
    }
  });

  test('the design doc’s own example id (`local:scratch`) is accepted', () => {
    const result = validateProjectManifest({
      ...minimalManifest(),
      repos: [
        ...minimalManifest().repos,
        { kind: 'local-only', id: 'local:scratch', label: 'Scratch notes' },
      ],
    });
    expect(result.ok).toBe(true);
  });
});

describe('§3.2 — the free-text fields that REPLICATE are path-checked too (HIGH-4b)', () => {
  test.each([
    ['name', { name: '/Users/brian/dev/secret-client' }],
    ['slug', { slug: '~/dev/secret-client' }],
    ['icon', { icon: '/Users/brian/secrets/logo.png' }],
    ['id', { id: '/Users/brian/dev/secret-client' }],
  ])('a filesystem path in the manifest %s is refused', (field, patch) => {
    // Non-portability describes RESOLUTION, not whether a record travels:
    // every one of these fields is in the manifest each member reads.
    const result = validateProjectManifest({ ...minimalManifest(), ...patch });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) => e.startsWith(`${field}:`) && e.includes('filesystem path'),
        ),
      ).toBe(true);
    }
  });

  test('a filesystem path in a resource label is refused', () => {
    const result = validateProjectManifest({
      ...minimalManifest(),
      repos: [
        {
          kind: 'git',
          id: 'github.com/kontourai/station',
          canonicalRemote: 'github.com/kontourai/station',
          role: 'primary',
          label: '/Users/brian/dev/acme-client',
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) =>
            e.startsWith('repos[0].label:') && e.includes('filesystem path'),
        ),
      ).toBe(true);
    }
  });
});

describe('§3.2 — a repo-relative path cannot escape its repo (HIGH-5)', () => {
  function manifestWithKnowledgePath(path: unknown): Record<string, unknown> {
    return {
      ...minimalManifest(),
      knowledge: [
        {
          namespaceId: 'rules',
          root: {
            kind: 'repo',
            repoId: 'github.com/kontourai/station',
            path,
          },
        },
      ],
    };
  }

  test.each([
    ['a traversal to the filesystem root', '../../../etc/passwd'],
    ['a traversal that starts inside the repo', 'docs/../../..'],
    ['a Windows-separator traversal', 'docs\\..\\..\\..'],
  ])('%s is refused', (_label, path) => {
    // ABSOLUTE_OR_TILDE_PATH_PATTERN anchors at ^, so a `..` path was
    // accepted. Once slice 3 joins a binding path to a root path and hands
    // the result to KnowledgeService, `../../../../.ssh` in a manifest
    // authored by another member is a semantically searchable copy of the
    // recipient's private keys.
    const result = validateProjectManifest(manifestWithKnowledgePath(path));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) => e.startsWith('knowledge[0].root.path:') && e.includes('".."'),
        ),
      ).toBe(true);
    }
  });

  test.each([
    ['an empty path', ''],
    ['a path with an empty segment', 'docs//rules'],
  ])('%s is refused', (_label, path) => {
    expect(validateProjectManifest(manifestWithKnowledgePath(path)).ok).toBe(
      false,
    );
  });

  test.each([
    ['an ordinary nested repo-relative path', 'docs/design'],
    // A trailing separator is an ordinary way to write a directory root and
    // means exactly what the bare form means; refusing it for an "empty
    // segment" the author never perceived writing is a false rejection.
    ['a directory root written with a trailing separator', 'docs/'],
    ['a nested directory root with a trailing separator', 'docs/design/'],
    // "index the whole repo" was previously unrepresentable — every spelling
    // of the repo root was refused. It is inside the repo, which is the only
    // thing this check is for.
    ['the repo root as "."', '.'],
    ['the repo root as "./"', './'],
    // Exact segment equality, so a name that merely starts with dots passes.
    ['a path whose segment starts with dots', 'docs/..rules'],
  ])('%s is accepted', (_label, path) => {
    expect(validateProjectManifest(manifestWithKnowledgePath(path)).ok).toBe(
      true,
    );
  });
});

describe('§3.4 — the per-backend positive shape checks have their own power', () => {
  // Mutation testing during delta review found every one of these checks
  // survived deletion: the accept/reject tables above exercised the
  // credential-prefix signal, and nothing exercised the shapes. A check no
  // test kills is a check that can be deleted by accident.
  test.each([
    ['env with a hyphen', { env: 'LINEAR-TOKEN' }, 'integrations[0].auth.env:'],
    ['env with a dot', { env: 'my.var' }, 'integrations[0].auth.env:'],
    ['env starting with a digit', { env: '1VAR' }, 'integrations[0].auth.env:'],
    [
      'a station id with a space',
      { station: 'has space' },
      'integrations[0].auth.station:',
    ],
    [
      'an empty keychain service',
      { keychain: { service: '' } },
      'integrations[0].auth.keychain.service:',
    ],
    [
      'a multi-line keychain service',
      { keychain: { service: 'a\nb' } },
      'integrations[0].auth.keychain.service:',
    ],
    [
      'a non-string keychain account',
      { keychain: { service: 'linear', account: 42 } },
      'integrations[0].auth.keychain.account:',
    ],
    [
      'an op reference with no path',
      { op: 'op://' },
      'integrations[0].auth.op:',
    ],
  ])('%s is refused, naming its own field', (_label, auth, expectedPrefix) => {
    const result = validateProjectManifest(manifestWithAuth(auth));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith(expectedPrefix))).toBe(
        true,
      );
    }
  });

  test('zero backend keys is refused by NAME, not by falling through to keychain', () => {
    // This test previously asserted only `ok === false`, which it got for the
    // wrong reason: with the zero-key check removed, control fell into the
    // keychain branch and the manifest was rejected with
    // "auth.keychain.service: must be a plain service name" — an error naming
    // a field the author never wrote.
    const result = validateProjectManifest(manifestWithAuth({}));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) =>
            e.startsWith('integrations[0].auth:') &&
            /none|exactly one/i.test(e),
        ),
      ).toBe(true);
      expect(result.errors.some((e) => e.includes('keychain.service'))).toBe(
        false,
      );
    }
  });
});

describe('§3.5 — role is validated and usable on BOTH resource kinds', () => {
  test('an invalid role value is refused on a local-only resource', () => {
    // The enum check used to live inside the `git` branch only; a local-only
    // resource could declare any role at all.
    const result = validateProjectManifest({
      ...minimalManifest(),
      repos: [{ kind: 'local-only', id: 'local:scratch', role: 'PRIMARY' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('repos[0].role:'))).toBe(
        true,
      );
    }
  });

  test('a manifest of only local-only resources can still declare its primary', () => {
    // Without `role` on the local-only type this shape was refused for
    // failing the multi-resource cardinality rule, with no way to satisfy it.
    expect(
      validateProjectManifest({
        ...minimalManifest(),
        repos: [
          { kind: 'local-only', id: 'local:notes', role: 'primary' },
          { kind: 'local-only', id: 'local:scratch' },
        ],
      }).ok,
    ).toBe(true);
  });

  test('a sole resource declaring itself secondary is refused', () => {
    // §3.5 says a single-resource manifest's sole resource IS its primary.
    // Accepting an explicit `secondary` would force a resolver to treat a
    // resource that declared itself non-primary as the primary.
    const result = validateProjectManifest({
      ...minimalManifest(),
      repos: [{ kind: 'local-only', id: 'local:scratch', role: 'secondary' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('repos:'))).toBe(true);
    }
  });
});

describe('§3.3 — the local-clone rule is ONE rule (write side and read side)', () => {
  // Delta review measured two separate implementations of "is this remote
  // local" diverging in BOTH directions. The leak direction let
  // `localhost:2222/org/repo` validate as portable; the brick direction let
  // the backfill persist `.\mirror\repo` that this validator then refused
  // forever, with no write able to repair it. `isLocalCloneSource` is now the
  // single rule both sides call, so this table pins the shapes that used to
  // fall between them.
  test.each([
    ['a loopback host with a port', 'localhost:2222/org/repo'],
    ['a loopback IPv4 with a port', '127.0.0.1:9418/org/repo'],
    ['a bracketed IPv6 loopback', '[::1]/org/repo'],
    ['a bracketed IPv6 loopback with a port', '[::1]:2222/org/repo'],
    ['a Windows-style dot-relative source', '.\\mirror\\repo'],
    ['a Windows-style parent-relative source', '..\\mirror\\repo'],
    ['a posix dot-relative source', './mirror/repo'],
    ['a posix parent-relative source', '../mirror/repo'],
    ['a file:// absolute path', '/users/alice/dev/acme'],
    ['a file://localhost absolute path', 'localhost/users/alice/dev/acme'],
  ])('%s is a local clone source on both sides', (_label, remote) => {
    expect(isLocalCloneSource(remote)).toBe(true);
    // And the validator, which calls it, refuses the same string.
    const result = validateProjectManifest({
      ...minimalManifest(),
      repos: [
        { kind: 'git', id: remote, canonicalRemote: remote, role: 'primary' },
      ],
    });
    expect(result.ok).toBe(false);
  });

  test.each([
    ['an ordinary forge remote', 'github.com/kontourai/station'],
    ['a self-hosted forge', 'git.internal/kontourai/station'],
    ['a self-hosted forge with a port', 'git.internal:2222/kontourai/station'],
    // The disclosed residual: indistinguishable from a single-label host.
    ['a bare relative source with no dot segments', 'mirror/repo'],
    // Not loopback — a host that merely starts with the same letters.
    ['a host prefixed like loopback', 'localhost.example.com/org/repo'],
  ])('%s is NOT treated as a local clone source', (_label, remote) => {
    expect(isLocalCloneSource(remote)).toBe(false);
  });
});

describe('§3.3 — local clone sources git supports but the anchored pattern misses', () => {
  test.each([
    ['a file://localhost absolute path', 'localhost/users/alice/dev/acme'],
    ['a loopback IPv4 host', '127.0.0.1/users/alice/dev/acme'],
    ['a parent-relative clone source', '../mirror/repo'],
    ['a dot-relative clone source', './mirror/repo'],
  ])('%s is refused as a git canonicalRemote', (_label, remote) => {
    // `git clone file://localhost/<abs path>` is supported and reports that
    // exact URL; normalizeGitOrigin strips only the scheme, so the result no
    // longer starts with "/" and escapes ABSOLUTE_OR_TILDE_PATH_PATTERN.
    const result = validateProjectManifest({
      ...minimalManifest(),
      repos: [
        { kind: 'git', id: remote, canonicalRemote: remote, role: 'primary' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('local-only'))).toBe(true);
    }
  });

  test('a single-label host remote is accepted — the named residual', () => {
    // `git clone mirror/repo` canonicalizes to `mirror/repo`, which is
    // indistinguishable at the string level from a remote on a single-label
    // host. Recorded as an accepted limitation, not silently hoped away.
    expect(
      validateProjectManifest({
        ...minimalManifest(),
        repos: [
          {
            kind: 'git',
            id: 'mirror/repo',
            canonicalRemote: 'mirror/repo',
            role: 'primary',
          },
        ],
      }).ok,
    ).toBe(true);
  });
});

describe('§3.6 — the state array covers the whole union (cross-branch tripwire)', () => {
  test('every ResourceResolution member is well-formed with a reason', () => {
    // The runtime membership check in isWellFormedResolution is only as good
    // as this array. Slice 1 added the array and slice 2 added `ambiguous`, on
    // separate branches that merged cleanly — after which every `ambiguous`
    // result would have been rejected by the predicate the resolver asserts on
    // its own output. Neither branch's tests could see it. This one can.
    for (const state of RESOURCE_RESOLUTION_STATES) {
      // `bound` carries a path instead of a reason; `ambiguous` is the one
      // state that exists because no single resource could be NAMED, so its
      // `resourceId` is required empty rather than required non-empty.
      const result =
        state === 'bound'
          ? { state, resourceId: 'local:x', path: '/tmp/x' }
          : {
              state,
              resourceId: state === 'ambiguous' ? '' : 'local:x',
              reason: 'because',
              // station#1594's per-state required observations.
              ...(state === 'missing'
                ? { record: 'binding', declaredPath: '~/x' }
                : {}),
              ...(state === 'stale' || state === 'drifted'
                ? { unverifiedPath: '/tmp/x' }
                : {}),
            };
      expect(isWellFormedResolution(result)).toBe(true);
    }
  });

  test('a state outside the array is refused even when it type-checks', () => {
    expect(
      isWellFormedResolution({
        state: 'invented',
        resourceId: 'local:x',
        reason: 'because',
      }),
    ).toBe(false);
  });
});

describe('§3.2 — prose is exempt from the anchored path check, by design', () => {
  test.each([
    [
      'a description beginning with a route path',
      '/api/projects/:slug is the route family we own',
    ],
    [
      'a description beginning with a tilde path',
      '~/.station is where this Station keeps state',
    ],
    [
      'a description mentioning a path mid-sentence',
      'see /etc/hosts for the mapping',
    ],
  ])('%s is accepted', (_label, description) => {
    // The pattern is anchored, so path-checking prose refuses ordinary
    // sentences that BEGIN with a path while catching nothing a sentence
    // hides mid-string — a false rejection, not a guard. The migration leak
    // §5 describes lands in identity-shaped fields, which ARE checked.
    expect(
      validateProjectManifest({ ...minimalManifest(), description }).ok,
    ).toBe(true);
  });
});

describe('§3.5 — referential integrity and primary cardinality (MEDIUM-2)', () => {
  test('two resources sharing one id are refused', () => {
    const result = validateProjectManifest({
      ...minimalManifest(),
      repos: [
        ...minimalManifest().repos,
        { kind: 'local-only', id: 'local:scratch' },
        { kind: 'local-only', id: 'local:scratch' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) => e.startsWith('repos[2].id:') && e.includes('duplicate'),
        ),
      ).toBe(true);
    }
  });

  test('two resources both declaring role "primary" are refused', () => {
    const result = validateProjectManifest({
      ...minimalManifest(),
      repos: [
        {
          kind: 'git',
          id: 'github.com/kontourai/station',
          canonicalRemote: 'github.com/kontourai/station',
          role: 'primary',
        },
        {
          kind: 'git',
          id: 'github.com/kontourai/flow',
          canonicalRemote: 'github.com/kontourai/flow',
          role: 'primary',
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) => e.startsWith('repos:') && e.includes('at most one'),
        ),
      ).toBe(true);
    }
  });

  test('a multi-resource manifest with NO primary is refused — §3.5 resolves an omitted resourceId to THE primary', () => {
    const result = validateProjectManifest({
      ...minimalManifest(),
      repos: [
        {
          kind: 'git',
          id: 'github.com/kontourai/station',
          canonicalRemote: 'github.com/kontourai/station',
        },
        {
          kind: 'git',
          id: 'github.com/kontourai/flow',
          canonicalRemote: 'github.com/kontourai/flow',
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) => e.startsWith('repos:') && e.includes('exactly one'),
        ),
      ).toBe(true);
    }
  });

  test('a single-repo manifest with no declared role passes — its sole repo IS its primary', () => {
    const result = validateProjectManifest({
      ...minimalManifest(),
      repos: [
        {
          kind: 'git',
          id: 'github.com/kontourai/station',
          canonicalRemote: 'github.com/kontourai/station',
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test('a knowledge root naming a repo that does not exist is refused', () => {
    const result = validateProjectManifest({
      ...minimalManifest(),
      knowledge: [
        {
          namespaceId: 'rules',
          root: {
            kind: 'repo',
            repoId: 'github.com/kontourai/does-not-exist',
            path: 'docs',
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) =>
            e.startsWith('knowledge[0].root.repoId:') &&
            e.includes('names no resource'),
        ),
      ).toBe(true);
    }
  });

  test('the dangling-repoId check is skipped when repos is not an array — one cause, one error', () => {
    const result = validateProjectManifest({
      ...minimalManifest(),
      repos: 'not-an-array',
      knowledge: [
        {
          namespaceId: 'rules',
          root: { kind: 'repo', repoId: 'github.com/whatever', path: 'docs' },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('names no resource'))).toBe(
        false,
      );
    }
  });
});

describe('ok:true never returns an unvalidated optional field (MEDIUM-4)', () => {
  test('a non-string resource label is refused rather than cast', () => {
    const result = validateProjectManifest({
      ...minimalManifest(),
      repos: [{ ...minimalManifest().repos[0], label: 42 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('repos[0].label:'))).toBe(
        true,
      );
    }
  });

  test('a non-string defaultBranch is refused rather than cast', () => {
    const result = validateProjectManifest({
      ...minimalManifest(),
      repos: [{ ...minimalManifest().repos[0], defaultBranch: { x: 1 } }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.startsWith('repos[0].defaultBranch:')),
      ).toBe(true);
    }
  });

  test('a string label and defaultBranch still pass', () => {
    const result = validateProjectManifest({
      ...minimalManifest(),
      repos: [
        {
          ...minimalManifest().repos[0],
          label: 'Station',
          defaultBranch: 'main',
        },
      ],
    });
    expect(result.ok).toBe(true);
  });
});

describe('isWellFormedResolution — the resource is NAMED and the state is real (LOW-1)', () => {
  test('§3.6 rule 3: an unresolvable result with an empty resourceId is NOT well-formed', () => {
    expect(
      isWellFormedResolution({
        state: 'unresolvable',
        resourceId: '',
        reason: 'denied',
      }),
    ).toBe(false);
  });

  test('a bound result with an empty resourceId is NOT well-formed either', () => {
    expect(
      isWellFormedResolution({
        state: 'bound',
        resourceId: '',
        path: '/Users/brian/dev/station',
      }),
    ).toBe(false);
  });

  test('a state outside the seven-member union is NOT well-formed — slice 2 reads these off disk, where the TypeScript union proves nothing', () => {
    expect(
      isWellFormedResolution({
        state: 'resolved',
        resourceId: 'github.com/kontourai/station',
        reason: 'looks fine',
      }),
    ).toBe(false);
  });

  test("RESOURCE_RESOLUTION_STATES carries exactly the declared state set — §3.6's states plus slice 2's `ambiguous`", () => {
    // The name deliberately carries no COUNT. The previous spelling ("exactly
    // the seven §3.6 states") froze one, and slice 2 legitimately added an
    // eighth on another branch: the two merged cleanly and this test failed
    // for naming a number rather than for anything being wrong. Assert the
    // set; let the set be the contract.
    expect([...RESOURCE_RESOLUTION_STATES].sort()).toEqual(
      [
        'ambiguous',
        'bound',
        'drifted',
        'missing',
        'not-portable',
        'stale',
        'unbound',
        'unresolvable',
      ].sort(),
    );
  });

  test('an `ambiguous` result that NAMES a resource is not well-formed', () => {
    // The whole point of the state is that no single resource could be named.
    // An id here would be a claim the state contradicts, and a consumer would
    // reasonably act on it.
    expect(
      isWellFormedResolution({
        state: 'ambiguous',
        resourceId: 'github.com/kontourai/station',
        reason: 'two resources declare role "primary"',
      }),
    ).toBe(false);
  });

  test('an `ambiguous` result still needs a reason — an empty id AND no reason is an empty result', () => {
    expect(isWellFormedResolution({ state: 'ambiguous', resourceId: '' })).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// station#1499 slice 2 — UNREADABLE vs UNSELECTABLE (decision 11).
//
// Slice 1 enforces §3.5's primary cardinality here; slice 2 runs this
// validator on every manifest READ. Without a classification channel, a
// manifest with two primaries — readable in every other respect — made a read
// throw where §3.6 has a state (`ambiguous`) for exactly that situation. The
// channel is structured on purpose: matching on message prose would be a
// stringly-typed join across a package boundary that rots the first time a
// sentence is reworded.
// ---------------------------------------------------------------------------

describe('validation diagnostics carry a machine-readable code', () => {
  test('every diagnostic is the same failure, in the same order, as `errors`', () => {
    const result = validateProjectManifest({
      ...minimalManifest(),
      id: '',
      name: '',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.message)).toEqual(result.errors);
    expect(result.diagnostics.length).toBeGreaterThan(1);
  });

  test('a structural failure is `manifest-invalid`, and is NOT a selection ambiguity', () => {
    const result = validateProjectManifest({ ...minimalManifest(), id: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.code)).toEqual(['manifest-invalid']);
    expect(isSelectionAmbiguityOnly(result.diagnostics)).toBe(false);
  });

  test('an unknown schemaVersion is its own code, and is NOT a selection ambiguity', () => {
    const result = validateProjectManifest({
      ...minimalManifest(),
      schemaVersion: 2,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      'schema-version-unknown',
    ]);
    expect(isSelectionAmbiguityOnly(result.diagnostics)).toBe(false);
  });

  test.each([
    [
      'two primaries',
      [
        {
          kind: 'git' as const,
          id: 'github.com/kontourai/station',
          canonicalRemote: 'github.com/kontourai/station',
          role: 'primary' as const,
        },
        {
          kind: 'git' as const,
          id: 'github.com/kontourai/flow',
          canonicalRemote: 'github.com/kontourai/flow',
          role: 'primary' as const,
        },
      ],
      'multiple-primaries-declared',
    ],
    [
      'several resources and no primary',
      [
        {
          kind: 'git' as const,
          id: 'github.com/kontourai/station',
          canonicalRemote: 'github.com/kontourai/station',
        },
        {
          kind: 'git' as const,
          id: 'github.com/kontourai/flow',
          canonicalRemote: 'github.com/kontourai/flow',
        },
      ],
      'no-primary-declared',
    ],
    [
      'a sole resource declaring itself secondary',
      [
        {
          kind: 'local-only' as const,
          id: 'local:scratch',
          role: 'secondary' as const,
        },
      ],
      'sole-resource-declared-secondary',
    ],
  ])(
    '%s is a SELECTION ambiguity — the document is readable, no single resource is selectable',
    (_label, repos, code) => {
      const result = validateProjectManifest({ ...minimalManifest(), repos });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics.map((d) => d.code)).toEqual([code]);
      expect(isSelectionAmbiguityOnly(result.diagnostics)).toBe(true);
    },
  );

  test('a cardinality failure ALONGSIDE a structural one is not "ambiguity only" — it fails closed', () => {
    // The mixed case is the one that matters: a consumer that kept reading
    // here would be reading a document it has already been told is malformed.
    const result = validateProjectManifest({
      ...minimalManifest(),
      id: '',
      repos: [
        {
          kind: 'git',
          id: 'github.com/kontourai/station',
          canonicalRemote: 'github.com/kontourai/station',
          role: 'primary',
        },
        {
          kind: 'git',
          id: 'github.com/kontourai/flow',
          canonicalRemote: 'github.com/kontourai/flow',
          role: 'primary',
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.code).sort()).toEqual([
      'manifest-invalid',
      'multiple-primaries-declared',
    ]);
    expect(isSelectionAmbiguityOnly(result.diagnostics)).toBe(false);
  });

  test('an empty diagnostics list is not "ambiguity only" — nothing failed, so nothing is ambiguous', () => {
    expect(isSelectionAmbiguityOnly([])).toBe(false);
  });

  test('SELECTION_AMBIGUITY_CODES is exactly the §3.5 cardinality rules', () => {
    expect([...SELECTION_AMBIGUITY_CODES].sort()).toEqual(
      [
        'multiple-primaries-declared',
        'no-primary-declared',
        'sole-resource-declared-secondary',
      ].sort(),
    );
  });
});

describe('selectPrimaryResource — §3.5 as one rule, applied twice', () => {
  const git = (
    id: string,
    role?: 'primary' | 'secondary',
  ): ProjectRepoResource => ({
    kind: 'git',
    id,
    canonicalRemote: id,
    ...(role ? { role } : {}),
  });
  const local = (
    id: string,
    role?: 'primary' | 'secondary',
  ): ProjectRepoResource => ({
    kind: 'local-only',
    id,
    ...(role ? { role } : {}),
  });

  test('a sole resource IS the primary, declared or not', () => {
    const repos = [git('github.com/kontourai/station')];
    expect(selectPrimaryResource(repos)).toEqual({
      ok: true,
      resource: repos[0],
    });
  });

  test('a local-only resource can be the primary — `role` is not git-only', () => {
    // The resolver used to filter `kind === 'git'` here while the validator
    // counted `role` across both kinds, so this manifest validated and then
    // resolved `ambiguous`.
    const repos = [
      local('local:notes', 'primary'),
      git('github.com/a/b', 'secondary'),
    ];
    expect(selectPrimaryResource(repos)).toEqual({
      ok: true,
      resource: repos[0],
    });
  });

  test('nothing is picked when nothing is THE primary, and every candidate is returned', () => {
    const repos = [git('github.com/a/b'), git('github.com/c/d')];
    expect(selectPrimaryResource(repos)).toEqual({
      ok: false,
      code: 'no-primary-declared',
      candidates: repos,
    });
  });

  test('two primaries return the two primaries, not the whole list', () => {
    const repos = [
      git('github.com/a/b', 'primary'),
      git('github.com/c/d', 'primary'),
      git('github.com/e/f', 'secondary'),
    ];
    expect(selectPrimaryResource(repos)).toEqual({
      ok: false,
      code: 'multiple-primaries-declared',
      candidates: [repos[0], repos[1]],
    });
  });

  test('a sole resource that declared itself secondary is NOT overruled', () => {
    const repos = [local('local:scratch', 'secondary')];
    expect(selectPrimaryResource(repos)).toEqual({
      ok: false,
      code: 'sole-resource-declared-secondary',
      candidates: repos,
    });
  });

  test('no resources at all: nothing to select, and nothing invented', () => {
    expect(selectPrimaryResource([])).toEqual({
      ok: false,
      code: 'no-resources-declared',
      candidates: [],
    });
  });

  test('the validator and the selector agree on every shape — including the one documented disagreement', () => {
    // Two implementations of one rule (the validator reports indexes over
    // not-yet-typed input; the selector returns the resource) are held in
    // agreement here rather than by hope. The single deliberate exception is
    // `repos: []`: a manifest may legitimately declare no resources, so the
    // validator has nothing to refuse, while a caller that asked for "the
    // primary" still has nothing to name.
    const cases: { repos: ProjectRepoResource[]; validatorAccepts: boolean }[] =
      [
        { repos: [], validatorAccepts: true },
        { repos: [git('github.com/a/b')], validatorAccepts: true },
        { repos: [git('github.com/a/b', 'primary')], validatorAccepts: true },
        { repos: [local('local:scratch')], validatorAccepts: true },
        {
          repos: [local('local:scratch', 'secondary')],
          validatorAccepts: false,
        },
        {
          repos: [local('local:notes', 'primary'), git('github.com/a/b')],
          validatorAccepts: true,
        },
        {
          repos: [
            local('local:notes', 'primary'),
            git('github.com/a/b', 'secondary'),
          ],
          validatorAccepts: true,
        },
        {
          repos: [git('github.com/a/b'), git('github.com/c/d')],
          validatorAccepts: false,
        },
        {
          repos: [
            git('github.com/a/b', 'primary'),
            git('github.com/c/d', 'primary'),
          ],
          validatorAccepts: false,
        },
      ];

    for (const { repos, validatorAccepts } of cases) {
      const validation = validateProjectManifest({
        ...minimalManifest(),
        repos,
      });
      const selection = selectPrimaryResource(repos);
      expect({ repos, ok: validation.ok }).toEqual({
        repos,
        ok: validatorAccepts,
      });
      if (repos.length === 0) {
        // The documented exception, asserted rather than skipped.
        expect(validation.ok).toBe(true);
        expect(selection.ok).toBe(false);
        continue;
      }
      expect({ repos, selects: selection.ok }).toEqual({
        repos,
        selects: validatorAccepts,
      });
      if (!validation.ok && !selection.ok) {
        expect(validation.diagnostics.map((d) => d.code)).toEqual([
          selection.code,
        ]);
      }
    }
  });
});

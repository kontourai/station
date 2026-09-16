/**
 * #2060 — a Layout is owned by a project, a principal, or the instance, and
 * `layoutOwner` is the ONE place that question is answered.
 *
 * Every case here drives the exported derivation directly, which is the same
 * function the storage parser (`src-server/domain/file-storage-schemas.ts`)
 * and the storage adapter call, so a green case here is a statement about the
 * production reading, not about a re-implementation living in the test.
 */
import { describe, expect, test } from 'vitest';
import {
  INSTANCE_LAYOUT_OWNER,
  InvalidLayoutOwnerError,
  layoutOwner,
  layoutOwnerProjectSlug,
} from '../layout';
import { humanPrincipal } from '../principal';

const alice = humanPrincipal('oidc', 'alice', 'Alice');

describe('layoutOwner', () => {
  test('derives project ownership from a record that predates owners', () => {
    // The exact ownership shape every Layout written before Boards has on
    // disk: `projectSlug`, no `owner`. Nothing migrated it.
    expect(layoutOwner({ projectSlug: 'acme' })).toEqual({
      kind: 'project',
      projectSlug: 'acme',
    });
    expect(layoutOwnerProjectSlug({ projectSlug: 'acme' })).toBe('acme');
  });

  test('reads a principal owner and reports it owns no project', () => {
    const record = { owner: { kind: 'principal', principal: alice } } as const;
    expect(layoutOwner(record)).toEqual({
      kind: 'principal',
      principal: alice,
    });
    expect(layoutOwnerProjectSlug(record)).toBeUndefined();
  });

  test('reads an instance owner and reports it owns no project', () => {
    expect(layoutOwner({ owner: INSTANCE_LAYOUT_OWNER })).toEqual({
      kind: 'instance',
    });
    expect(layoutOwnerProjectSlug({ owner: INSTANCE_LAYOUT_OWNER })).toBe(
      undefined,
    );
  });

  test('refuses a layout that is both project- and principal-owned', () => {
    expect(() =>
      layoutOwner({
        projectSlug: 'acme',
        owner: { kind: 'principal', principal: alice },
      }),
    ).toThrow(InvalidLayoutOwnerError);
    expect(() =>
      layoutOwner({
        projectSlug: 'acme',
        owner: { kind: 'principal', principal: alice },
      }),
    ).toThrow('owned by one or the other, never both');
  });

  test('refuses a layout that is both project- and instance-owned', () => {
    expect(() =>
      layoutOwner({ projectSlug: 'acme', owner: INSTANCE_LAYOUT_OWNER }),
    ).toThrow('owned by one or the other, never both');
  });

  test('refuses a project owner that contradicts its own projectSlug', () => {
    // Not the "both owners" case: two project answers that disagree. Picking
    // either one silently relocates the Layout.
    expect(() =>
      layoutOwner({
        projectSlug: 'acme',
        owner: { kind: 'project', projectSlug: 'other' },
      }),
    ).toThrow('contradicts owner.projectSlug');
  });

  test('accepts a project owner that agrees with its projectSlug', () => {
    expect(
      layoutOwner({
        projectSlug: 'acme',
        owner: { kind: 'project', projectSlug: 'acme' },
      }),
    ).toEqual({ kind: 'project', projectSlug: 'acme' });
  });

  test('refuses a record that names no owner at all', () => {
    expect(() => layoutOwner({})).toThrow(
      'must carry a non-empty `projectSlug`',
    );
    expect(() => layoutOwner({ projectSlug: '  ' })).toThrow(
      'must carry a non-empty `projectSlug`',
    );
  });

  test('refuses a principal owner whose principal is not well formed', () => {
    // Delegates to `isPrincipalRef` rather than sniffing the shape here, so a
    // value this accepts is a value the principal store accepts.
    expect(() =>
      layoutOwner({
        owner: {
          kind: 'principal',
          principal: { id: 'human:oidc:alice', kind: 'human', display: '  ' },
        } as never,
      }),
    ).toThrow('well-formed PrincipalRef');
  });

  test('refuses an unknown owner kind rather than defaulting to a project', () => {
    expect(() =>
      layoutOwner({ owner: { kind: 'team', teamId: 't1' } as never }),
    ).toThrow('unknown owner kind "team"');
  });
});

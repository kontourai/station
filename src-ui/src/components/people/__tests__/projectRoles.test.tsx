/** @vitest-environment jsdom */
import { PROJECT_MEMBER_ROLES } from '@kontourai/station-contracts/project-membership';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ProjectRolePicker } from '../ProjectRolePicker';
import { canGrant, GRANTABLE_ROLES } from '../projectRoles';

/** A member holding exactly `role`'s actions, as the server reports them. */
const holding = (role: keyof typeof PROJECT_MEMBER_ROLES) => ({
  actions: [...PROJECT_MEMBER_ROLES[role]],
});

afterEach(cleanup);

describe('canGrant (#3586)', () => {
  test('no acting member grants nothing', () => {
    for (const role of [...GRANTABLE_ROLES, 'owner'] as const)
      expect(canGrant(undefined, role)).toBe(false);
  });

  test('a member grants exactly the roles whose actions they all hold', () => {
    // Pinned literally, not derived from PROJECT_MEMBER_ROLES: the ladder is
    // viewer < contributor < admin < owner.
    const grantable = (actor: keyof typeof PROJECT_MEMBER_ROLES) =>
      (['viewer', 'contributor', 'admin', 'owner'] as const).filter((role) =>
        canGrant(holding(actor), role),
      );
    expect(grantable('viewer')).toEqual(['viewer']);
    expect(grantable('contributor')).toEqual(['viewer', 'contributor']);
    expect(grantable('admin')).toEqual(['viewer', 'contributor', 'admin']);
    expect(grantable('owner')).toEqual([
      'viewer',
      'contributor',
      'admin',
      'owner',
    ]);
  });

  test('one missing action is enough to refuse', () => {
    const almostAdmin = {
      actions: PROJECT_MEMBER_ROLES.admin.filter(
        (action) => action !== 'manage-members',
      ),
    };
    expect(canGrant(almostAdmin, 'admin')).toBe(false);
    expect(canGrant(almostAdmin, 'contributor')).toBe(true);
  });
});

describe('ProjectRolePicker', () => {
  test('lists every grantable role and disables the ones the actor cannot grant', () => {
    render(
      <ProjectRolePicker
        label="Role"
        value="viewer"
        onChange={() => {}}
        canGrant={(role) => canGrant(holding('contributor'), role)}
      />,
    );
    const options = Array.from(
      (screen.getByLabelText('Role') as HTMLSelectElement).options,
    ).map((option) => [option.textContent, option.disabled]);
    expect(options).toEqual([
      ['Viewer', false],
      ['Contributor', false],
      ['Project admin', true],
    ]);
  });
});

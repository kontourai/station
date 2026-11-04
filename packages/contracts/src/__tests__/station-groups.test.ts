import { describe, expect, test } from 'vitest';
import {
  capScopeToGroup,
  STATION_GROUP_CEILINGS,
  STATION_GROUP_GOVERNED_SCOPES,
} from '../station-groups.js';

describe('Station group ceilings (#3557)', () => {
  test('no group ever includes access:manage, and Admin includes everything Member does', () => {
    for (const ceiling of Object.values(STATION_GROUP_CEILINGS))
      expect(ceiling).not.toContain('access:manage');
    expect(STATION_GROUP_GOVERNED_SCOPES).not.toContain('access:manage');
    for (const token of STATION_GROUP_CEILINGS.member)
      expect(STATION_GROUP_CEILINGS.admin).toContain(token);
  });

  test('Member keeps Standard; Admin keeps the governed set (literals, not the table under test)', () => {
    expect([...STATION_GROUP_CEILINGS.member]).toEqual([
      'orchestration:read',
      'orchestration:operate',
      'terminal:operate',
    ]);
    expect([...STATION_GROUP_CEILINGS.admin].sort()).toEqual(
      [
        'access:approve',
        'access:devices',
        'approval:full-access',
        'coding:exec',
        'consent:decide',
        'orchestration:operate',
        'orchestration:read',
        'terminal:observe',
        'terminal:operate',
      ].sort(),
    );
  });

  test('a cap removes only governed permissions the group does not allow', () => {
    expect(
      capScopeToGroup(
        'orchestration:read terminal:observe terminal:operate coding:exec relay:manage access:manage',
        'member',
      ),
    ).toBe('orchestration:read terminal:operate relay:manage access:manage');
    expect(
      capScopeToGroup(
        'orchestration:read terminal:observe coding:exec approval:full-access',
        'admin',
      ),
    ).toBe(
      'orchestration:read terminal:observe coding:exec approval:full-access',
    );
  });
});

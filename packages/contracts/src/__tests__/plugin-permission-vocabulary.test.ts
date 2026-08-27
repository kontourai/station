import { describe, expect, test } from 'vitest';
import { permissionTier } from '../plugin.js';

/**
 * Permission names arrive from a plugin manifest, so Object's inherited keys
 * are in the input space. A plain object literal answers them:
 * `PERMISSION_TIERS['__proto__']` is `Object.prototype`, which is truthy — so
 * a `?? 'trusted'` default never fires and the tier reads as neither passive
 * nor trusted.
 *
 * That matters because `POST /api/plugins/:name/grant` refuses a permission
 * whose tier is `trusted`, forcing it through the isolated host-approval
 * channel. A tier that is neither slips past that refusal.
 */
describe('permissionTier fails closed on inherited keys', () => {
  test.each([
    '__proto__',
    'toString',
    'constructor',
    'hasOwnProperty',
    'valueOf',
  ])('an inherited key %s reads as trusted, not as an object', (key) => {
    expect(permissionTier(key)).toBe('trusted');
  });

  test('an unknown permission still reads as trusted', () => {
    expect(permissionTier('nope.not.a.permission')).toBe('trusted');
  });

  test('the real vocabulary is unaffected', () => {
    expect(permissionTier('navigation.dock')).toBe('passive');
    expect(permissionTier('ui.confirm')).toBe('active');
    expect(permissionTier('plugin.server')).toBe('trusted');
  });
});

import { describe, expect, test } from 'vitest';
import { getInitials, getLayoutIcon } from '../utils/layout';

describe('project initials', () => {
  test.each([
    ['Station', 'ST'],
    ['open-therapist', 'OT'],
    ['Kontour AI', 'KA'],
    ['  ', '?'],
  ])(
    'derives stable one or two character initials from %j',
    (name, expected) => {
      expect(getInitials(name)).toBe(expected);
    },
  );

  test('treats discovered data images as renderable artwork', () => {
    expect(
      getLayoutIcon({
        name: 'Station',
        icon: 'data:image/png;base64,iVBORw==',
      }),
    ).toMatchObject({ isUrl: true, isCustomIcon: true });
  });
});

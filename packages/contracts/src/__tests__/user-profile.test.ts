import { describe, expect, it } from 'vitest';
import {
  buildUserProfileContextBlock,
  hasAnsweredUserProfile,
  isUserProfileComfort,
  isUserProfileRole,
  USER_PROFILE_COMFORT_LABELS,
  USER_PROFILE_COMFORT_LEVELS,
  USER_PROFILE_ROLE_LABELS,
  USER_PROFILE_ROLES,
  type UserProfileSettings,
} from '../user-profile.js';

describe('user profile vocabulary', () => {
  it('labels every declared role and comfort level', () => {
    for (const role of USER_PROFILE_ROLES) {
      expect(USER_PROFILE_ROLE_LABELS[role]).toBeTruthy();
    }
    for (const comfort of USER_PROFILE_COMFORT_LEVELS) {
      expect(USER_PROFILE_COMFORT_LABELS[comfort]).toBeTruthy();
    }
    expect(Object.keys(USER_PROFILE_ROLE_LABELS)).toHaveLength(
      USER_PROFILE_ROLES.length,
    );
    expect(Object.keys(USER_PROFILE_COMFORT_LABELS)).toHaveLength(
      USER_PROFILE_COMFORT_LEVELS.length,
    );
  });

  it('accepts only declared values', () => {
    expect(isUserProfileRole('engineer')).toBe(true);
    expect(isUserProfileRole('ENGINEER')).toBe(false);
    expect(isUserProfileRole('astronaut')).toBe(false);
    expect(isUserProfileRole(undefined)).toBe(false);
    expect(isUserProfileComfort('new-to-this')).toBe(true);
    expect(isUserProfileComfort('novice')).toBe(false);
    expect(isUserProfileComfort(null)).toBe(false);
  });
});

describe('buildUserProfileContextBlock — nothing is injected for an unanswered profile', () => {
  // The point of the whole module: a block the user never authored reads to the
  // model exactly like one they did, so absent must mean absent.
  const nothingCases: Array<[string, UserProfileSettings | null | undefined]> =
    [
      ['undefined (never asked)', undefined],
      ['null', null],
      ['empty object (asked, skipped both)', {}],
      [
        'explicitly-cleared fields',
        { role: undefined, comfort: undefined } as UserProfileSettings,
      ],
      [
        'values outside the vocabulary',
        {
          role: 'astronaut',
          comfort: 'vibes',
        } as unknown as UserProfileSettings,
      ],
      [
        'wrong types',
        { role: 3, comfort: true } as unknown as UserProfileSettings,
      ],
    ];

  it.each(nothingCases)('returns null for %s', (_label, profile) => {
    expect(buildUserProfileContextBlock(profile)).toBeNull();
    expect(hasAnsweredUserProfile(profile)).toBe(false);
  });

  it('never invents the unanswered half of a partial profile', () => {
    const roleOnly = buildUserProfileContextBlock({ role: 'engineer' });
    expect(roleOnly).not.toBeNull();
    // Exactly one instruction line between the header and the closing tag —
    // a second line here would be an invented comfort level.
    expect(
      roleOnly?.split('\n').filter((line) => line.startsWith('- ')),
    ).toHaveLength(1);
    // And it must say nothing about how much detail they want.
    for (const comfort of USER_PROFILE_COMFORT_LEVELS) {
      const comfortLine = buildUserProfileContextBlock({ comfort })?.split(
        '\n',
      )[2];
      expect(roleOnly).not.toContain(comfortLine);
    }
  });
});

describe('buildUserProfileContextBlock — the authored block', () => {
  it('emits exactly the authored block for a fully answered profile', () => {
    expect(
      buildUserProfileContextBlock({ role: 'engineer', comfort: 'expert' }),
    ).toBe(
      [
        '[USER PROFILE]',
        'The person you are answering told Station this about themselves. Tune the shape of your answer to it; it does not change what is true.',
        '- They are an engineer: lead with the concrete change, code, or command, and keep the framing short.',
        '- They build agent tools: skip the introductions and go straight to specifics, including internals when relevant.',
        '[/USER PROFILE]',
      ].join('\n'),
    );
  });

  it('emits one line per answered question and nothing for the other', () => {
    expect(buildUserProfileContextBlock({ comfort: 'new-to-this' })).toBe(
      [
        '[USER PROFILE]',
        'The person you are answering told Station this about themselves. Tune the shape of your answer to it; it does not change what is true.',
        '- They are new to agent tools: name each unfamiliar concept the first time it appears, and do not assume Station vocabulary.',
        '[/USER PROFILE]',
      ].join('\n'),
    );
  });

  it('gives every declared value its own distinct instruction', () => {
    const roleLines = USER_PROFILE_ROLES.map(
      (role) => buildUserProfileContextBlock({ role })?.split('\n')[2],
    );
    expect(new Set(roleLines).size).toBe(USER_PROFILE_ROLES.length);

    const comfortLines = USER_PROFILE_COMFORT_LEVELS.map(
      (comfort) => buildUserProfileContextBlock({ comfort })?.split('\n')[2],
    );
    expect(new Set(comfortLines).size).toBe(USER_PROFILE_COMFORT_LEVELS.length);
  });

  it('reports an answered profile', () => {
    expect(hasAnsweredUserProfile({ role: 'manager' })).toBe(true);
    expect(hasAnsweredUserProfile({ comfort: 'comfortable' })).toBe(true);
  });
});

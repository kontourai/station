import { describe, expect, test } from 'vitest';
import { resolveTaskExperiences } from '../views/task-experiences';

describe('task experiences', () => {
  test('keeps Direct available without advertising unattached owner experiences', () => {
    const experiences = resolveTaskExperiences();

    expect(
      experiences.map(({ id, authority, availability }) => ({
        id,
        authority,
        availability,
      })),
    ).toEqual([
      { id: 'direct', authority: 'Station', availability: 'available' },
    ]);
  });

  test('adds only owner experiences whose capability is attached', () => {
    expect(
      resolveTaskExperiences({ attachedExperiences: ['deliver'] }).map(
        ({ id, availability }) => ({ id, availability }),
      ),
    ).toEqual([
      { id: 'direct', availability: 'available' },
      { id: 'deliver', availability: 'available' },
    ]);
  });

  test('does not expose an owner destination before a trusted contract exists', () => {
    for (const experience of resolveTaskExperiences()) {
      expect(experience).not.toHaveProperty('href');
      expect(experience).not.toHaveProperty('reference');
    }
  });
});

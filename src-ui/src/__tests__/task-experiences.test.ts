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

  // No owner product publishes a trusted deep-link contract yet, so a resolved
  // experience (attached or not) may carry only Station's own copy and an
  // alternative that is a Station route or the explicitly allowed Console
  // project page. A new destination field fails the key allowlist.
  test('does not expose an owner destination before a trusted contract exists', () => {
    const allowedKeys = new Set([
      'id',
      'label',
      'authority',
      'description',
      'unavailableDescription',
      'alternativeHref',
      'alternativeLabel',
      'availability',
    ]);
    const allowedExternalHrefs = new Set([
      'https://github.com/kontourai/console',
    ]);
    const everyExperience = resolveTaskExperiences({
      attachedExperiences: ['deliver', 'learn', 'operate'],
    });
    expect(everyExperience.map(({ id }) => id)).toEqual([
      'direct',
      'deliver',
      'learn',
      'operate',
    ]);

    for (const experience of [
      ...resolveTaskExperiences(),
      ...everyExperience,
    ]) {
      for (const key of Object.keys(experience)) {
        expect(allowedKeys, `${experience.id}.${key}`).toContain(key);
      }
      const href = experience.alternativeHref;
      if (href === undefined) continue;
      const stationRoute = href.startsWith('/') && !href.startsWith('//');
      expect(
        stationRoute || allowedExternalHrefs.has(href),
        `${experience.id} alternativeHref ${href}`,
      ).toBe(true);
    }
  });
});

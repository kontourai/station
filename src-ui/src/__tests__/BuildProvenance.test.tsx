// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import {
  BuildProvenance,
  formatBuildAge,
} from '../views/settings/BuildProvenance';

const build = {
  fullSha: 'abcdef0123456789abcdef0123456789abcdef01',
  shortSha: 'abcdef0',
  branch: 'main',
  builtAt: '2026-07-10T18:00:00.000Z',
  ageSeconds: 120,
  instanceId: 'phone-dogfood',
};

describe('BuildProvenance', () => {
  test('renders an accessible deployed artifact identity', () => {
    render(<BuildProvenance build={build} />);

    expect(
      screen.getByRole('group', { name: 'Deployed build provenance' }),
    ).toBeTruthy();
    expect(screen.getByText('abcdef0').getAttribute('title')).toBe(
      build.fullSha,
    );
    expect(screen.getByText('2 minutes ago').getAttribute('title')).toBe(
      build.builtAt,
    );
    expect(screen.getByText('main')).toBeTruthy();
    expect(screen.getByText('phone-dogfood')).toBeTruthy();
  });

  test('states when release metadata is unavailable', () => {
    render(<BuildProvenance />);
    expect(
      screen.getByText('Build provenance is unavailable for this instance.'),
    ).toBeTruthy();
  });

  // archive#1085: one missing field used to hide all four rows. Asserted on
  // the row LABELS, not the values: a row rendered with an undefined value
  // produces an empty <dd>, which no value-based assertion can see.
  const ROWS = {
    Revision: 'abcdef0',
    Built: '2 minutes ago',
    Branch: 'main',
    Instance: 'phone-dogfood',
  } as const;

  function renderedRows(): string[] {
    return Object.keys(ROWS).filter((label) => screen.queryByText(label));
  }

  test.each([
    [['shortSha', 'fullSha'], 'Revision'],
    [['builtAt', 'ageSeconds'], 'Built'],
    [['branch'], 'Branch'],
    [['instanceId'], 'Instance'],
  ])('dropping %s removes only the %s row', (fields, droppedLabel) => {
    const partial = { ...build } as Record<string, unknown>;
    for (const field of fields) delete partial[field];
    render(<BuildProvenance build={partial} />);

    expect(renderedRows()).toEqual(
      Object.keys(ROWS).filter((label) => label !== droppedLabel),
    );
    for (const [label, value] of Object.entries(ROWS)) {
      if (label === droppedLabel) continue;
      expect(screen.getByText(value)).toBeTruthy();
    }
    expect(
      screen.queryByText('Build provenance is unavailable for this instance.'),
    ).toBeNull();
  });

  test('an empty provenance object still reads as unavailable', () => {
    render(<BuildProvenance build={{}} />);
    expect(
      screen.getByText('Build provenance is unavailable for this instance.'),
    ).toBeTruthy();
    expect(
      screen.queryByRole('group', { name: 'Deployed build provenance' }),
    ).toBeNull();
  });

  test.each([
    [-5, 'just now'],
    [59, 'just now'],
    [60, '1 minute ago'],
    [3_600, '1 hour ago'],
    [86_400, '1 day ago'],
    [172_800, '2 days ago'],
  ])('formats age %i as %s', (seconds, expected) => {
    expect(formatBuildAge(seconds)).toBe(expected);
  });
});

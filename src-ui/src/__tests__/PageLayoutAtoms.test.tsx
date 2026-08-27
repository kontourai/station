/**
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { DetailHeader } from '../components/DetailHeader';
import { PageRow } from '../components/PageRow';
import { PageSection } from '../components/PageSection';
import { SettingsSection } from '../views/settings/SettingsSection';

describe('page-layout atoms', () => {
  test('PageSection exposes semantic hierarchy while keeping content composable', () => {
    const { container } = render(
      <PageSection
        id="section-models"
        eyebrow="Connections"
        title="Models"
        description="LLM endpoints used by Station agents."
        actions={<button type="button">Manage</button>}
      >
        <p>Model inventory</p>
      </PageSection>,
    );

    expect(screen.getByRole('heading', { name: 'Models' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy();
    expect(
      container.querySelector('#section-models[data-page-section]'),
    ).toBeTruthy();
  });

  test('PageRow aligns optional description, status, and control slots', () => {
    render(
      <PageRow
        label="Default model"
        description="Used for new conversations."
        status="Ready"
        control={<button type="button">Choose</button>}
      />,
    );

    expect(screen.getByText('Default model')).toBeTruthy();
    expect(screen.getByText('Used for new conversations.')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose' })).toBeTruthy();
  });

  test('SettingsSection is a thin consumer of PageSection', () => {
    const { container } = render(
      <SettingsSection id="section-system" icon="S" title="System">
        System controls
      </SettingsSection>,
    );

    expect(
      container.querySelector('#section-system[data-page-section]'),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'System' })).toBeTruthy();
  });

  test('DetailHeader keeps title, subtitle, and actions in distinct hierarchy lanes', () => {
    const { container } = render(
      <DetailHeader title="Connections" subtitle="External services">
        <button type="button">Add</button>
      </DetailHeader>,
    );

    expect(screen.getByRole('heading', { name: 'Connections' })).toBeTruthy();
    expect(container.querySelector('.detail-header__subtitle')?.tagName).toBe(
      'P',
    );
    expect(
      container
        .querySelector('.detail-header__actions')
        ?.contains(screen.getByRole('button', { name: 'Add' })),
    ).toBe(true);
  });
});

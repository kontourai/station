/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { SettingsOverview } from '../views/settings/SettingsOverview';

describe('SettingsOverview', () => {
  test('summarizes honest status and drills into a URL-backed view', () => {
    const onNavigate = vi.fn();
    render(
      <SettingsOverview
        connectionName="Local Station"
        validationIssueCount={0}
        hasUnsavedChanges={false}
        hrefForView={(view) => `/settings?view=${view}`}
        onNavigate={onNavigate}
      />,
    );

    expect(screen.getByText('Your settings are ready')).not.toBeNull();
    expect(screen.getByText('Local Station')).not.toBeNull();
    expect(screen.getByText('No issues')).not.toBeNull();
    expect(screen.getByText('All saved')).not.toBeNull();

    const deviceCard = screen.getByRole('link', {
      name: /This devicePersonal experience/,
    });
    expect(deviceCard.getAttribute('href')).toBe('/settings?view=appearance');
    fireEvent.click(deviceCard);
    expect(onNavigate).toHaveBeenCalledWith('appearance');
  });

  test('does not call a warning state ready', () => {
    render(
      <SettingsOverview
        validationIssueCount={2}
        hasUnsavedChanges
        hrefForView={(view) => `/settings?view=${view}`}
        onNavigate={() => undefined}
      />,
    );

    expect(screen.getByText('Settings need attention')).not.toBeNull();
    expect(screen.getByText('2 issues')).not.toBeNull();
    expect(screen.getByText('Unsaved')).not.toBeNull();
  });
});

/**
 * @vitest-environment jsdom
 */

import { render, screen, waitFor } from '@testing-library/react';
import { Component, type ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { RouteViewBoundary } from '../../app-shell/RouteViewBoundary';
import { LocaleProvider } from '../LocaleContext';

class ThrowingView extends Component<{ error: Error }> {
  render(): ReactNode {
    throw this.props.error;
  }
}

describe('RouteViewBoundary localization pilot', () => {
  test('renders English roles and actions through the root-default locale', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <LocaleProvider>
        <RouteViewBoundary routeKey="route">
          <ThrowingView error={new Error('view failed')} />
        </RouteViewBoundary>
      </LocaleProvider>,
    );

    expect(screen.getByRole('alert').textContent).toContain(
      'This view stopped working.',
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  test('renders pseudo-locale error roles and actions after its lazy catalog arrives', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <LocaleProvider developmentLocale="en-XA">
        <RouteViewBoundary routeKey="route">
          <ThrowingView error={new Error('view failed')} />
        </RouteViewBoundary>
      </LocaleProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(
        /Ŧħīş ṽīēŵ şŧōƥƥēđ ŵōřķīñğ/,
      );
    });
    expect(screen.getByRole('button', { name: /Ŧřŷ àğàīñ/ })).toBeTruthy();
  });
});

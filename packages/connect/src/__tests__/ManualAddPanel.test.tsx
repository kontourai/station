// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ManualAddPanel } from '../react/connection-manager-modal/ManualAddPanel';

const HINT = /Messages sent this way are not encrypted/i;

function renderPanel(url: string) {
  return render(
    <ManualAddPanel
      name=""
      url={url}
      onNameChange={() => {}}
      onUrlChange={() => {}}
      onAdd={() => {}}
      onCancel={() => {}}
    />,
  );
}

describe('ManualAddPanel explicit HTTP exception', () => {
  it('defaults the address placeholder to an HTTPS example', () => {
    renderPanel('');
    expect(
      screen.getByPlaceholderText('https://station.example.ts.net'),
    ).toBeTruthy();
  });

  it('focuses the name field when the panel opens', () => {
    renderPanel('');
    expect(document.activeElement).toBe(
      screen.getByPlaceholderText('Name (optional)'),
    );
  });

  it('exposes both manual-add fields to assistive technology', () => {
    renderPanel('');

    expect(
      screen.getByRole('textbox', { name: 'Name (optional)' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('textbox', {
        name: 'Station address',
      }),
    ).toBeTruthy();
  });

  it.each(['http://192.168.1.5:3141', 'http://localhost:3141'])(
    'requires explicit unencrypted-connection consent for %s',
    (url) => {
      renderPanel(url);
      expect(screen.getByText(HINT)).toBeTruthy();
      const add = screen.getByRole('button', { name: 'Add' });
      expect(add.hasAttribute('disabled')).toBe(true);
      fireEvent.click(
        screen.getByRole('checkbox', {
          name: 'Allow an unencrypted connection',
        }),
      );
      expect(add.hasAttribute('disabled')).toBe(false);
      fireEvent.click(
        screen.getByRole('checkbox', {
          name: 'Allow an unencrypted connection',
        }),
      );
      expect(add.hasAttribute('disabled')).toBe(true);
    },
  );

  it('hides the hint for an https entry', () => {
    renderPanel('https://station.foo.ts.net');
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('hides the hint for a bare host (it normalizes to https)', () => {
    renderPanel('station.foo.ts.net');
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it.each(['http://127.0.0.1:3141', 'http://[::1]:3141'])(
    'keeps the numeric-loopback exception for %s',
    (url) => {
      renderPanel(url);
      expect(screen.queryByText(HINT)).toBeNull();
      expect(
        screen.getByRole('button', { name: 'Add' }).hasAttribute('disabled'),
      ).toBe(false);
    },
  );
});

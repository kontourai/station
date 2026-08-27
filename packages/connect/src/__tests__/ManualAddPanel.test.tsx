// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ManualAddPanel } from '../react/connection-manager-modal/ManualAddPanel';

const HINT = /Connecting over http to a raw address/i;

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

describe('ManualAddPanel prefer-HTTPS hint', () => {
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

  it('shows the hint when the entry is http:// to a raw IP', () => {
    renderPanel('http://192.168.1.5:3141');
    expect(screen.getByText(HINT)).toBeTruthy();
  });

  it('hides the hint for an https entry', () => {
    renderPanel('https://station.foo.ts.net');
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('hides the hint for a bare host (it normalizes to https)', () => {
    renderPanel('station.foo.ts.net');
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('hides the hint for http to loopback', () => {
    renderPanel('http://localhost:3141');
    expect(screen.queryByText(HINT)).toBeNull();
  });
});

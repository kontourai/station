/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import {
  WorkspacePaneFailure,
  workspacePaneFailureDetail,
} from '../WorkspacePaneFailure';

const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => {
  cleanup();
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

test.each(['station-plugin://localhost', 'http://station-plugin.localhost'])(
  'Copy details redacts %s asset queries and fragments but preserves source coordinates',
  async (origin) => {
    const secret = `${'AbC_'.repeat(10)}xyz`;
    const url = `${origin}/api/plugins/demo/bundle.js?port=43123&capability=${secret}#private-fragment`;
    const error = new TypeError(`Plugin failed at ${url}`);
    error.stack = `${error.name}: ${error.message}\n    at render (${url}:12:7)\nupdate@${url}:40:2\n    at host (http://tauri.localhost/assets/host.js?debug=private/path#fragment/more:9:4)`;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      <WorkspacePaneFailure
        paneName="Demo"
        detail={workspacePaneFailureDetail(error)}
        onRetry={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));
    await screen.findByRole('button', { name: 'Copied' });
    const expected =
      'TypeError: Plugin failed at /api/plugins/demo/bundle.js\n    at render (/api/plugins/demo/bundle.js:12:7)\nupdate@/api/plugins/demo/bundle.js:40:2\n    at host (host.js:9:4)';
    expect(writeText).toHaveBeenCalledExactlyOnceWith(expected);
    expect(
      screen.getByText(expected, { exact: true, normalizer: (text) => text }),
    ).toBeTruthy();
  },
);

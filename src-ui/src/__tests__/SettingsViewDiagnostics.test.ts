/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { downloadDiagnosticsBundle } from '../views/settings/diagnostics-download';

describe('downloadDiagnosticsBundle', () => {
  const createObjectURL = vi.fn(() => 'blob:diagnostics');
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
  });

  test('clicks an attached anchor, removes it, then revokes the URL later', () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(document.body.contains(this)).toBe(true);
        expect(revokeObjectURL).not.toHaveBeenCalled();
      });

    downloadDiagnosticsBundle(
      new Blob(['{}'], { type: 'application/json' }),
      new Date('2026-07-20T12:34:56.000Z'),
    );

    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:diagnostics');
  });
});

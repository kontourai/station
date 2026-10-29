/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isDocumentVisible,
  subscribeDocumentVisibility,
} from '../documentVisibility';

describe('documentVisibility', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shares one document listener and detaches it with the last subscriber', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeDocumentVisibility(first);
    const stopSecond = subscribeDocumentVisibility(second);
    expect(
      add.mock.calls.filter(([type]) => type === 'visibilitychange'),
    ).toHaveLength(1);

    document.dispatchEvent(new Event('visibilitychange'));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    stopFirst();
    expect(
      remove.mock.calls.filter(([type]) => type === 'visibilitychange'),
    ).toHaveLength(0);
    stopSecond();
    expect(
      remove.mock.calls.filter(([type]) => type === 'visibilitychange'),
    ).toHaveLength(1);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('reads the page as hidden only when the document says so', () => {
    const hidden = vi.spyOn(document, 'hidden', 'get');
    hidden.mockReturnValue(true);
    expect(isDocumentVisible()).toBe(false);
    hidden.mockReturnValue(false);
    expect(isDocumentVisible()).toBe(true);
  });
});

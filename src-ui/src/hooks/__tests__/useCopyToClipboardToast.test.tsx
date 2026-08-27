/**
 * @vitest-environment jsdom
 *
 * The toast wording is asserted here as literal text, once. The two call-site
 * tests assert against the exported constants, so without this file a change to
 * either sentence would go unnoticed — including a regression to the
 * unconditional "Copied to clipboard" station#3341 removed.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  clipboardAbsent,
  clipboardRefuses,
  clipboardWrites,
} from '../../__tests__/clipboard-stubs';
import {
  COPY_TOAST_FAILURE,
  COPY_TOAST_SUCCESS,
  useCopyToClipboardToast,
} from '../useCopyToClipboardToast';

const showToast = vi.fn();
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast }),
}));

afterEach(() => {
  showToast.mockReset();
  clipboardAbsent();
});

describe('useCopyToClipboardToast', () => {
  test('the sentences the operator actually reads', () => {
    expect(COPY_TOAST_SUCCESS).toBe('Copied to clipboard');
    expect(COPY_TOAST_FAILURE).toBe(
      "Couldn't copy — this browser refused clipboard access",
    );
  });

  test('a resolved write toasts success and resolves true', async () => {
    const writeText = clipboardWrites();
    const { result } = renderHook(() => useCopyToClipboardToast());

    await expect(result.current('receipt-path')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('receipt-path');
    expect(showToast).toHaveBeenCalledWith('Copied to clipboard');
  });

  test('a refused write toasts the failure and resolves false', async () => {
    clipboardRefuses();
    const { result } = renderHook(() => useCopyToClipboardToast());

    await expect(result.current('receipt-path')).resolves.toBe(false);
    expect(showToast).toHaveBeenCalledWith(
      "Couldn't copy — this browser refused clipboard access",
    );
    expect(showToast).not.toHaveBeenCalledWith('Copied to clipboard');
  });

  test('no clipboard at all toasts the failure and resolves false', async () => {
    clipboardAbsent();
    const { result } = renderHook(() => useCopyToClipboardToast());

    await expect(result.current('receipt-path')).resolves.toBe(false);
    expect(showToast).not.toHaveBeenCalledWith('Copied to clipboard');
  });
});

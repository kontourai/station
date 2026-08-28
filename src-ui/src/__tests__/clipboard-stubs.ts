/**
 * Clipboard arrangement shared by the archive#3341 call-site tests.
 *
 * These deliberately stub `navigator.clipboard` rather than mocking the
 * `copyToClipboard` seam: a site test that mocked the seam would still pass if
 * the seam itself started claiming success for a missing clipboard, which is
 * the exact defect the whole class was made of.
 */

import { vi } from 'vitest';

/** A clipboard whose write resolves. Returns the spy for argument assertions. */
export function clipboardWrites(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  return writeText;
}

/** A clipboard that refuses (permission denied). */
export function clipboardRefuses(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockRejectedValue(new Error('denied'));
  Object.assign(navigator, { clipboard: { writeText } });
  return writeText;
}

/** A non-secure origin: no `navigator.clipboard` at all. */
export function clipboardAbsent(): void {
  Object.assign(navigator, { clipboard: undefined });
}

import { useCallback } from 'react';
import { useToast } from '../contexts/ToastContext';
import { copyToClipboard } from '../lib/clipboard';

/**
 * The toast half of archive#3341's copy affordance, shared by the two surfaces
 * that report a copy through a toast rather than an inline label (the chat
 * transcript's per-message copy and Monitoring's tool-result copy). Both wrote
 * "Copied to clipboard" unconditionally; a single hook keeps the success and
 * failure sentences from drifting apart the next time one of them is edited.
 */

export const COPY_TOAST_SUCCESS = 'Copied to clipboard';
export const COPY_TOAST_FAILURE =
  "Couldn't copy — this browser refused clipboard access";

export function useCopyToClipboardToast(): (text: string) => Promise<boolean> {
  const { showToast } = useToast();
  return useCallback(
    async (text: string) => {
      const copied = await copyToClipboard(text);
      showToast(copied ? COPY_TOAST_SUCCESS : COPY_TOAST_FAILURE);
      return copied;
    },
    [showToast],
  );
}

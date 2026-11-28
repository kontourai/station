import { useMemo, useSyncExternalStore } from 'react';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import { useCopyToClipboardToast } from '../../hooks/useCopyToClipboardToast';
import { useInboxRowActionsPreview } from '../../hooks/useInboxRowActionsPreview';
import { triggerHaptic } from '../../platform/native/haptics';
import {
  inboxPinsVersion,
  isInboxPinned,
  readInboxPins,
  subscribeInboxPins,
  toggleInboxPin,
} from '../../utils/inbox-pin-store';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import { inboxRowCopyTargets } from './inbox-row-actions';

const subscribeDisabled = () => () => {};

export function useInboxPins() {
  const enabled = useInboxRowActionsPreview();
  const { namespace } = useAuthorityPersistence();
  const version = useSyncExternalStore(
    enabled ? subscribeInboxPins : subscribeDisabled,
    inboxPinsVersion,
    inboxPinsVersion,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: version invalidates the persisted snapshot
  const pins = useMemo(
    () => (enabled ? readInboxPins(namespace) : {}),
    [enabled, namespace, version],
  );
  return { enabled, namespace, pins };
}

export function useInboxRowIdentityActions(item: HomeWorkItem) {
  const { enabled, namespace, pins } = useInboxPins();
  const pinned = isInboxPinned(item, pins);
  const copy = useInboxRowCopy();
  return {
    enabled,
    pinned,
    pinAction: {
      key: 'pin',
      label: pinned ? 'Unpin' : 'Pin to top',
      onSelect: () => {
        if (enabled) toggleInboxPin(item, namespace);
      },
    },
    copyActions: enabled ? copy(item) : [],
  };
}

export function useInboxRowCopy() {
  const copyWithToast = useCopyToClipboardToast(true);
  return (item: HomeWorkItem) =>
    inboxRowCopyTargets(item).map(({ key, label, value }) => ({
      key,
      label:
        label === 'Chat ID'
          ? 'Copy chat ID'
          : label === 'Task ID'
            ? 'Copy task ID'
            : 'Copy session ID',
      onSelect: async () => {
        if (await copyWithToast(value)) triggerHaptic('light');
      },
    }));
}

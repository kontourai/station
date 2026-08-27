export type RegistryLayoutAction = 'install' | 'remove' | 'enable' | 'disable';

import { Button } from '../Button';

export interface RegistryLayoutItemLike {
  name?: string;
  enabled?: boolean;
  installable?: boolean;
  lifecycle?: { state?: 'installed' | 'installable' | 'disabled' };
}

export function primaryLayoutAction(
  item: RegistryLayoutItemLike,
): RegistryLayoutAction | 'use' {
  if (item.lifecycle?.state === 'disabled') return 'enable';
  if (item.lifecycle?.state === 'installable' || item.installable)
    return 'install';
  return 'use';
}

function actionLabel(action: RegistryLayoutAction | 'use') {
  return {
    install: 'Install',
    remove: 'Remove',
    enable: 'Enable',
    disable: 'Disable',
    use: 'Use',
  }[action];
}

export function layoutActionSuccessVerb(action: RegistryLayoutAction) {
  return {
    install: 'Installed',
    remove: 'Removed',
    enable: 'Enabled',
    disable: 'Disabled',
  }[action];
}

export function RegistryLayoutActions({
  item,
  pending,
  showSecondary = false,
  stopPropagation = false,
  onAction,
  onUse,
}: {
  item: RegistryLayoutItemLike;
  pending: boolean;
  showSecondary?: boolean;
  stopPropagation?: boolean;
  onAction: (action: RegistryLayoutAction) => void;
  onUse: () => void;
}) {
  const primary = primaryLayoutAction(item);
  const installed = item.lifecycle?.state === 'installed';
  return (
    <>
      <Button
        variant="primary"
        size="sm"
        disabled={pending}
        onClick={(event) => {
          if (stopPropagation) event.stopPropagation();
          if (primary === 'use') onUse();
          else onAction(primary);
        }}
      >
        {pending ? 'Working...' : actionLabel(primary)}
      </Button>
      {showSecondary && installed && (
        <Button
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={(event) => {
            if (stopPropagation) event.stopPropagation();
            onAction('disable');
          }}
        >
          Disable
        </Button>
      )}
      {showSecondary && item.lifecycle?.state !== 'installable' && (
        <Button
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={(event) => {
            if (stopPropagation) event.stopPropagation();
            onAction('remove');
          }}
        >
          Remove
        </Button>
      )}
    </>
  );
}

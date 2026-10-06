import { Popover, type PopoverPlacement, Tooltip } from '@kontourai/ui/react';
import type { ReactNode } from 'react';
import { Button } from '../../components/Button';
import { InfoGlyph } from '../../components/icons/Glyph';

export function RelaySetupHelp({
  label,
  children,
  placement = 'bottom-end',
}: {
  label: string;
  children: ReactNode;
  placement?: PopoverPlacement;
}) {
  return (
    <Popover
      ariaLabel={label}
      placement={placement}
      className="relay-setup-help"
      trigger={
        <Tooltip label={label} placement="left">
          <Button
            variant="ghost"
            className="relay-setup-help__trigger"
            aria-label={label}
            aria-haspopup="dialog"
            onKeyDown={(event) => {
              // The shared popover closes at document level; keep Escape from
              // dismissing the surrounding setup dialog first.
              if (
                event.key === 'Escape' &&
                event.currentTarget
                  .closest('.relay-setup-help')
                  ?.querySelector('[role="dialog"]')
              ) {
                event.preventDefault();
              }
            }}
          >
            <InfoGlyph />
          </Button>
        </Tooltip>
      }
    >
      {children}
    </Popover>
  );
}

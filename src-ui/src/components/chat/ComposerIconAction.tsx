import { type ReactNode, useState } from 'react';
import { useLongPress } from '../../hooks/useLongPress';
import { Button } from '../Button';

/** Hover, focus and a touch hold reveal the same name without invoking the action. */
export function ComposerIconAction({
  label,
  children,
  onClick,
  className,
  expanded,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  className?: string;
  expanded?: boolean;
}) {
  const [showLabel, setShowLabel] = useState(false);
  const gesture = useLongPress({
    onLongPress: () => setShowLabel(true),
    onClick: () => {
      setShowLabel(false);
      onClick();
    },
  });
  return (
    <span
      className="composer-icon-action"
      data-label-visible={showLabel || undefined}
    >
      <Button
        variant="ghost"
        size="sm"
        className={className}
        aria-label={label}
        title={label}
        aria-haspopup={expanded === undefined ? undefined : 'dialog'}
        aria-expanded={expanded}
        onBlur={() => setShowLabel(false)}
        {...gesture}
        onPointerDown={(event) => {
          if (event.pointerType === 'touch' || event.pointerType === 'pen')
            event.preventDefault();
          gesture.onPointerDown(event);
        }}
      >
        {children}
      </Button>
      <span className="composer-icon-action__label" role="tooltip">
        {label}
      </span>
    </span>
  );
}

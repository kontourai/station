/**
 * #4470: the one "Troubleshoot" action error surfaces render.
 *
 * It only dispatches the open event with the surface's error facts; the start
 * flow, its availability checks and the Report-a-problem fallback live in
 * `TroubleshootHost` in the deferred overlays chunk. Keep this file free of
 * anything heavier than the event helper: it sits on eager surfaces.
 */

import type { ActionControlProps } from '@kontourai/station-sdk/action-control';
import type { ReactNode } from 'react';
import {
  requestTroubleshoot,
  type TroubleshootRequest,
} from '../../lib/troubleshootEvents';
import { Button } from '../Button';

export function TroubleshootAction({
  request,
  children = 'Troubleshoot',
  variant = 'secondary',
  size,
  className,
  onRequested,
}: {
  request: TroubleshootRequest;
  children?: ReactNode;
  variant?: ActionControlProps['variant'];
  size?: ActionControlProps['size'];
  className?: string;
  /** Runs after the request is dispatched, e.g. to dismiss a toast. */
  onRequested?: () => void;
}) {
  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      onClick={(event) => {
        event.stopPropagation();
        requestTroubleshoot(request);
        onRequested?.();
      }}
    >
      {children}
    </Button>
  );
}

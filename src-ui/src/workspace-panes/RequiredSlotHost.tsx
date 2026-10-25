import {
  REQUIRED_SLOT_DEFAULTS,
  type RequiredSlot,
  type RequiredSlotResolution,
  resolveRequiredSlot,
} from '@kontourai/station-contracts/required-slots';
import { Component, type ReactNode, useEffect, useState } from 'react';
import { ErrorState } from '../components/state';
import {
  reportRequiredSlotFailure,
  useRequiredSlotRenderRecovery,
} from './requiredSlotRecovery';

class FillerBoundary extends Component<
  {
    children: ReactNode;
    onFailure: (error: Error) => void;
  },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    this.props.onFailure(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function FailedDefault({
  resolution,
  action,
}: {
  resolution: Extract<
    RequiredSlotResolution<ReactNode>,
    { state: 'safe-mode' }
  >;
  action?: ReactNode;
}) {
  useEffect(() => {
    reportRequiredSlotFailure(resolution.slot, 'unavailable');
  }, [resolution.slot]);
  return (
    <ErrorState
      title={
        resolution.slot === 'home'
          ? 'Home is unavailable'
          : 'Inbox/Chat is unavailable'
      }
      // Name a button only when the caller supplies it; Chat supplies none.
      description={`${resolution.slot === 'home' ? 'Home' : 'Inbox/Chat'}’s layout needs a renderer this version doesn’t include.${action && resolution.slot === 'home' ? ' Choose Close Home to leave Home.' : ''}`}
      action={action}
    />
  );
}

function DefaultContent({
  slot,
  children,
}: {
  slot: RequiredSlot;
  children: ReactNode;
}) {
  const recovery = useRequiredSlotRenderRecovery(slot);
  return (
    <FillerBoundary
      onFailure={(error) => {
        recovery.failed();
        // Preserve the original error and the existing frame's Retry/Close context.
        throw error;
      }}
    >
      {children}
    </FillerBoundary>
  );
}

/** Overrides fall back locally; default render errors reach the pane's recovery frame. */
export function RequiredSlotHost({
  slot,
  defaultAvailable,
  unavailableAction,
  defaultContent,
  override,
}: {
  slot: RequiredSlot;
  unavailableAction?: ReactNode;
  defaultContent: ReactNode;
  override?: { id: string; available: boolean; content: ReactNode };
} & (
  | { defaultAvailable?: true; defaultFailureReason?: never }
  | { defaultAvailable: false; defaultFailureReason: 'selection-refused' }
)) {
  const [failedOverride, setFailedOverride] = useState<string>();
  const resolution = resolveRequiredSlot(
    slot,
    {
      id: REQUIRED_SLOT_DEFAULTS[slot],
      available: defaultAvailable !== false,
      value: defaultContent,
    },
    override
      ? {
          id: override.id,
          available: override.available && failedOverride !== override.id,
          value: override.content,
        }
      : undefined,
  );
  if (resolution.state === 'safe-mode')
    return <FailedDefault resolution={resolution} action={unavailableAction} />;
  if (resolution.source === 'default')
    return (
      <DefaultContent slot={slot}>{resolution.filler.value}</DefaultContent>
    );
  return (
    <FillerBoundary
      key={`${slot}:${resolution.filler.id}`}
      onFailure={() => setFailedOverride(resolution.filler.id)}
    >
      {resolution.filler.value}
    </FillerBoundary>
  );
}

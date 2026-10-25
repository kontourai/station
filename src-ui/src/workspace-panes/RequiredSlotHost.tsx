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
  reason,
  action,
}: {
  resolution: Extract<
    RequiredSlotResolution<ReactNode>,
    { state: 'safe-mode' }
  >;
  reason: 'selection-refused' | 'load-failed';
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
      description={
        reason === 'selection-refused'
          ? `This build registers no renderer that ${resolution.slot === 'home' ? 'Home' : 'Inbox/Chat'}’s declaration admits.`
          : `The built-in ${resolution.slot === 'home' ? 'Home' : 'Inbox/Chat'} surface could not be loaded.`
      }
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
      <StableDefault onStable={recovery.recovered}>{children}</StableDefault>
    </FillerBoundary>
  );
}

function StableDefault({
  children,
  onStable,
}: {
  children: ReactNode;
  onStable: () => void;
}) {
  useEffect(() => {
    // A commit alone does not survive child layout/passive effects or early updates.
    const timer = setTimeout(onStable, 1_000);
    return () => clearTimeout(timer);
  }, [onStable]);
  return children;
}

/** Overrides fall back locally; default render errors reach the pane's recovery frame. */
export function RequiredSlotHost({
  slot,
  defaultAvailable = true,
  defaultFailureReason = 'load-failed',
  unavailableAction,
  defaultContent,
  override,
}: {
  slot: RequiredSlot;
  defaultAvailable?: boolean;
  defaultFailureReason?: 'selection-refused' | 'load-failed';
  unavailableAction?: ReactNode;
  defaultContent: ReactNode;
  override?: { id: string; available: boolean; content: ReactNode };
}) {
  const [failedOverride, setFailedOverride] = useState<string>();
  const resolution = resolveRequiredSlot(
    slot,
    {
      id: REQUIRED_SLOT_DEFAULTS[slot],
      available: defaultAvailable,
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
    return (
      <FailedDefault
        resolution={resolution}
        reason={defaultFailureReason}
        action={unavailableAction}
      />
    );
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

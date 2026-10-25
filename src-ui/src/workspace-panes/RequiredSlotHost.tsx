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
}: {
  resolution: Extract<
    RequiredSlotResolution<ReactNode>,
    { state: 'safe-mode' }
  >;
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
      description="The default surface failed. Station recovery is required."
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
      <CommittedDefault onCommit={recovery.recovered}>
        {children}
      </CommittedDefault>
    </FillerBoundary>
  );
}

function CommittedDefault({
  children,
  onCommit,
}: {
  children: ReactNode;
  onCommit: () => void;
}) {
  useEffect(() => {
    onCommit();
  });
  return children;
}

/** Overrides fall back locally; default render errors reach the pane's recovery frame. */
export function RequiredSlotHost({
  slot,
  defaultAvailable = true,
  defaultContent,
  override,
}: {
  slot: RequiredSlot;
  defaultAvailable?: boolean;
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
    return <FailedDefault resolution={resolution} />;
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

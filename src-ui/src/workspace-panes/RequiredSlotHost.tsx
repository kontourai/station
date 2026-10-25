import {
  REQUIRED_SLOT_DEFAULTS,
  type RequiredSlot,
  type RequiredSlotResolution,
  resolveRequiredSlot,
} from '@kontourai/station-contracts/required-slots';
import { Component, type ReactNode, useEffect, useState } from 'react';
import { ErrorState } from '../components/state';

/** Slice f can listen without executing a failed filler to inspect its status. */
export const REQUIRED_SLOT_SAFE_MODE_EVENT = 'station:required-slot-safe-mode';

class FillerBoundary extends Component<
  {
    children: ReactNode;
    onFailure: () => void;
  },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFailure();
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
    window.dispatchEvent(
      new CustomEvent(REQUIRED_SLOT_SAFE_MODE_EVENT, {
        detail: {
          slot: resolution.slot,
          defaultFiller: resolution.defaultFiller,
        },
      }),
    );
  }, [resolution.slot, resolution.defaultFiller]);
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

/** Both load refusal and render failure go through the same required-slot decision. */
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
  const [failedDefault, setFailedDefault] = useState(false);
  const [failedOverride, setFailedOverride] = useState<string>();
  const resolution = resolveRequiredSlot(
    slot,
    {
      id: REQUIRED_SLOT_DEFAULTS[slot],
      available: defaultAvailable && !failedDefault,
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
  return (
    <FillerBoundary
      key={`${slot}:${resolution.source}:${resolution.filler.id}`}
      onFailure={() =>
        resolution.source === 'default'
          ? setFailedDefault(true)
          : setFailedOverride(resolution.filler.id)
      }
    >
      {resolution.filler.value}
    </FillerBoundary>
  );
}

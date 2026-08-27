/**
 * Station#1134 ask 1 — one "Add a computer" entry point that asks the GOAL
 * first, then routes into the flow that serves it. Three branches, because
 * three mechanisms exist and the audit found all three reachable by
 * differently-shaped affordances within 300px of each other (CI-R9):
 *   - "control this Station" -> device pairing, via `ConnectionManagerModal`'s
 *     already-shipped `pair-host` panel (create an offer, approve requests,
 *     manage paired devices — `HostDevicePairingPanel` in
 *     `@kontourai/station-connect`). Nothing about that flow changes here;
 *     this is a new call site only, mirroring the existing
 *     `GuidedConnect`/`OnboardingGate` wiring.
 *   - "reach another Station" -> `StationAddressDialog`, which absorbs the
 *     sibling inline "Add Station" form this replaced.
 *   - "run work over SSH" -> `SshComputerCreatorDialog` (D7), which replaced
 *     `SshEnvironmentSetupModal`: that one dead-ended in the browser and, on
 *     desktop, created a saved connection rather than the SSH environment
 *     profile this section lists (CI-R1).
 *
 * The underlying flows stay distinct on purpose (per the issue: "the flows
 * can stay distinct underneath; the decision should not be the user's to
 * reverse-engineer") — this component only removes the guesswork of which
 * one to open. See docs/guides/machine-relationships.md for the direction /
 * trust / unlock model this copy encodes.
 */

import { ConnectionManagerModal } from '@kontourai/station-connect';
import { authenticatedFetch } from '@kontourai/station-sdk';
import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { checkHostCompatibility } from '../../lib/compatibilityLoader';
import './AddMachineModal.css';
import { checkServerHealthDetailed } from '../../lib/serverHealth';
import { triggerHaptic } from '../../platform/native/haptics';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { SshComputerCreatorDialog } from './SshComputerCreatorDialog';
import { StationAddressDialog } from './StationAddressDialog';

export type AddMachineGoal = 'control' | 'station' | 'delegate';

interface AddMachineGoalOption {
  goal: AddMachineGoal;
  title: string;
  detail: string;
  unlocks: string;
}

/**
 * The two goals, and the exact "what this unlocks" copy (station#1134 ask 3
 * — "the highest-value part of the whole issue"). Each line names the
 * direction (ask 2) and the capability it grants, never a liveness claim —
 * both flows below still gate the real "ready"/"connected" state themselves.
 */
export const ADD_MACHINE_GOAL_OPTIONS: readonly AddMachineGoalOption[] = [
  {
    goal: 'control',
    title: 'Control this Station from another device',
    detail:
      'Pair a phone, browser, or command line. You can then use this Station from that device.',
    unlocks: 'That device can control this Station.',
  },
  {
    goal: 'station',
    title: 'Reach another Station',
    detail:
      'Save the address of a Station running on another computer, so you can open it from here.',
    unlocks: 'This device can open that Station.',
  },
  {
    goal: 'delegate',
    title: 'Run work on another computer over SSH',
    detail: 'Connect a computer over SSH so this Station can send work to it.',
    unlocks:
      'Tasks run there with that computer’s own agents and project files.',
  },
];

export interface AddMachineModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * The entry button persists while a selected setup flow replaces this
   * chooser. Carry it across that replacement so the child flow can restore
   * focus after it closes instead of capturing the removed goal option.
   */
  returnFocusTarget?: HTMLElement | null;
}

export function AddMachineModal({
  isOpen,
  onClose,
  returnFocusTarget,
}: AddMachineModalProps) {
  const [goal, setGoal] = useState<AddMachineGoal | null>(null);
  const profile = usePlatformProfile();

  function close() {
    setGoal(null);
    onClose();
  }

  if (!isOpen) return null;

  if (goal === 'control') {
    return (
      <ConnectionManagerModal
        isOpen
        onClose={close}
        checkHealth={checkServerHealthDetailed}
        checkCompatibility={checkHostCompatibility}
        initialPanel="pair-host"
        originIsStation={!profile.isTauri}
        hostAppName={
          profile.isTauri ? profile.productName || 'Station' : undefined
        }
        allowManualCredentials={!profile.isDesktop}
        authenticatedRequest={
          profile.isDesktop ? authenticatedFetch : undefined
        }
        returnFocusTarget={returnFocusTarget}
        onPairingSucceeded={() => triggerHaptic('success')}
      />
    );
  }

  if (goal === 'station') {
    return <StationAddressDialog onClose={close} />;
  }

  if (goal === 'delegate') {
    return (
      <SshComputerCreatorDialog
        onClose={close}
        returnFocusTarget={returnFocusTarget}
      />
    );
  }

  return (
    <Dialog
      eyebrow="Add a computer"
      title="What do you want to do?"
      closeLabel="Close add a computer"
      onClose={close}
      size="lg"
    >
      <div className="add-machine-modal__body">
        <div className="add-machine-modal__options">
          {ADD_MACHINE_GOAL_OPTIONS.map((option) => (
            <button
              key={option.goal}
              type="button"
              className="add-machine-modal__option"
              onClick={() => setGoal(option.goal)}
            >
              <span className="add-machine-modal__option-title">
                {option.title}
              </span>
              <span className="add-machine-modal__option-detail">
                {option.detail}
              </span>
              <span className="add-machine-modal__option-unlocks">
                {option.unlocks}
              </span>
            </button>
          ))}
        </div>
        <a
          className="add-machine-modal__learn-more tap-target"
          href="https://github.com/kontourai/station/blob/main/docs/guides/machine-relationships.md"
          target="_blank"
          rel="noopener noreferrer"
        >
          How device pairing and remote computers differ
        </a>
      </div>
    </Dialog>
  );
}

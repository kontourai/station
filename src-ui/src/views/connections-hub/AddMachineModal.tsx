/**
 * The chooser lives below the replaceable authority tree. Station setup and
 * Device invitations hand off to the stable recovery shell so an access change
 * cannot discard an in-flight exchange. SSH and broker routes retain their
 * transport-specific setup owners.
 */

import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { openConnectionsModal } from '../../lib/connectionModalEvents';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import './AddMachineModal.css';
import { RelayRouteProfileDialog } from './RelayRouteProfileDialog';
import { SshComputerCreatorDialog } from './SshComputerCreatorDialog';

export type AddMachineGoal = 'control' | 'station' | 'delegate' | 'relay';

interface AddMachineGoalOption {
  goal: AddMachineGoal;
  title: string;
  detail: string;
  unlocks: string;
}

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
    title: 'Connect a Station',
    detail:
      'Choose a Station, then approve access for this device, remote work, or both.',
    unlocks: 'Device access and permission to send work stay separate.',
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
  const { isTauri } = usePlatformProfile();

  function close() {
    setGoal(null);
    onClose();
  }

  /**
   * The control goal hands off to the stable recovery shell instead of
   * mounting a modal here — see the module docblock. Firing the event
   * before closing keeps exactly one modal on screen: the chooser is gone
   * by the time the shell's modal opens.
   */
  function chooseGoal(option: AddMachineGoal) {
    if (option === 'station') {
      openConnectionsModal({ mode: 'connect-station' });
      close();
      return;
    }
    if (option === 'control') {
      openConnectionsModal({ mode: 'pair-host' });
      close();
      return;
    }
    setGoal(option);
  }

  if (!isOpen) return null;

  if (goal === 'relay') {
    return <RelayRouteProfileDialog onClose={close} />;
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
              onClick={() => chooseGoal(option.goal)}
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
          {isTauri && (
            <button
              type="button"
              className="add-machine-modal__option"
              onClick={() => chooseGoal('relay')}
            >
              <span className="add-machine-modal__option-title">
                Save an encrypted broker route
              </span>
              <span className="add-machine-modal__option-detail">
                Save where the Station is reached and which separately trusted
                Station identity it must use.
              </span>
              <span className="add-machine-modal__option-unlocks">
                The route stays unconnected until its transport and account
                setup are available.
              </span>
            </button>
          )}
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

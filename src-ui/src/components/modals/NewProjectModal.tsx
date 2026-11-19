import { useNewProjectModalState } from '../../hooks/useNewProjectModalState';
import { NewProjectModalContent } from './NewProjectModalContent';
import './NewProjectModal.css';

export interface NewProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: (slug: string) => void;
  returnFocusTarget?: HTMLElement | null;
}

/** Thin route-modal orchestrator; details, starter selection, and submit retry stay focused. */
export function NewProjectModal({
  isOpen,
  onClose,
  onCreated,
  returnFocusTarget,
}: NewProjectModalProps) {
  const state = useNewProjectModalState(isOpen, onClose, onCreated);
  if (!isOpen) return null;

  return (
    <NewProjectModalContent
      state={state}
      onClose={onClose}
      historyMode={onCreated ? 'entry' : 'route'}
      returnFocusTarget={returnFocusTarget}
    />
  );
}

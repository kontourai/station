import { useNewProjectModalState } from '../../hooks/useNewProjectModalState';
import { NewProjectModalContent } from './NewProjectModalContent';
import './NewProjectModal.css';

export interface NewProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Thin route-modal orchestrator; details, starter selection, and submit retry stay focused. */
export function NewProjectModal({ isOpen, onClose }: NewProjectModalProps) {
  const state = useNewProjectModalState(isOpen, onClose);
  if (!isOpen) return null;

  return <NewProjectModalContent state={state} onClose={onClose} />;
}

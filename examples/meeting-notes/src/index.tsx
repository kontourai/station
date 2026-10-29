/**
 * Meeting Notes plugin client bundle entry point (`layout.json`'s three tabs):
 * Capture (`CaptureModal.tsx`), Library (the wikilink graph in
 * `GraphPane.tsx`) and Ask (retrieval-grounded Q&A in `AskPane.tsx`).
 */
import './meeting-notes.css';
import { AskPane } from './AskPane';
import { CaptureModal } from './CaptureModal';
import { GraphPane } from './GraphPane';

export { AskPane } from './AskPane';
export { CaptureModal } from './CaptureModal';
export { GraphPane } from './GraphPane';

export const components = {
  'meeting-notes-capture': CaptureModal,
  'meeting-notes-library': GraphPane,
  'meeting-notes-ask': AskPane,
};

export default CaptureModal;

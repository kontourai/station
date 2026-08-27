/**
 * Meeting Notes plugin — client bundle entry point (`layout.json`'s three
 * tabs: Capture, Library, Ask).
 *
 * Wave 1 shipped the Capture tab. Wave 2 Task 4 replaced the Library stub
 * with the real wikilink graph pane (`GraphPane.tsx`). Wave 2 Task 5 (this
 * change) replaces the Ask stub with the real retrieval-grounded Q&A pane
 * (`AskPane.tsx`) — see that file's module doc for the Q3 scope decision.
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

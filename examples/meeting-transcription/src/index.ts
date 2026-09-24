/**
 * Meeting Transcription plugin — client bundle entry point.
 *
 * The plugin loader registers `components` by the renderer name each
 * `workspacePanes` entry in plugin.json declares.
 */
import { MeetingTranscriptionPane } from './MeetingTranscriptionPane';

export { MeetingTranscriptionModal } from './MeetingTranscriptionModal';
export { MeetingTranscriptionPane } from './MeetingTranscriptionPane';

export const components = {
  'meeting-transcription': MeetingTranscriptionPane,
};

export default MeetingTranscriptionPane;

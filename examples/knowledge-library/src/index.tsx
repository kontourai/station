import './knowledge-library.css';
import { KnowledgeLibrary } from './KnowledgeLibrary';

export { freshnessLabel, recordFreshness } from './freshness';
export { KnowledgeLibrary } from './KnowledgeLibrary';
export { isRelevantRoot, RootPicker } from './RootPicker';

export const components = {
  'kit-knowledge-library': KnowledgeLibrary,
};

export default KnowledgeLibrary;

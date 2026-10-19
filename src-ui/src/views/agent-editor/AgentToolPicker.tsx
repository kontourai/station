import { useContext } from 'react';
import { AgentToolLibrary } from './AgentToolLibrary';
import {
  StationToolLibraryProvider,
  ToolLibraryClientContext,
} from './ToolLibraryContext';
import type { AgentEditorFormProps } from './types';
export function AgentToolPicker(
  props: Pick<
    AgentEditorFormProps,
    'form' | 'setForm' | 'availableTools' | 'integrationTools'
  > & {
    engineId: string;
    initialSourceId?: string;
    onConnectionDirtyChange?: (dirty: boolean) => void;
  },
) {
  const client = useContext(ToolLibraryClientContext);
  if (client) return <AgentToolLibrary {...props} />;
  return (
    <StationToolLibraryProvider>
      <AgentToolLibrary {...props} />
    </StationToolLibraryProvider>
  );
}

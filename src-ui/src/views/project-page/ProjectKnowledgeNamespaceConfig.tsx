import { PathAutocomplete } from '../../components/PathAutocomplete';
import type { KnowledgeNamespace } from './types';

interface ProjectKnowledgeNamespaceConfigProps {
  apiBase: string;
  namespace: KnowledgeNamespace & {
    storageDir?: string;
    writeFiles?: boolean;
    enhance?: { auto?: boolean };
  };
  storageDirDraft: string;
  onStorageDirChange: (value: string) => void;
  onStorageDirBlur: () => void;
  onWriteFilesChange: (checked: boolean) => void;
  onAutoEnhanceChange: (checked: boolean) => void;
}

export function ProjectKnowledgeNamespaceConfig({
  apiBase,
  namespace,
  storageDirDraft,
  onStorageDirChange,
  onStorageDirBlur,
  onWriteFilesChange,
  onAutoEnhanceChange,
}: ProjectKnowledgeNamespaceConfigProps) {
  return (
    <div className="project-page__ns-config">
      <span className="project-page__ns-config-label">Storage:</span>
      <PathAutocomplete
        apiBase={apiBase}
        value={storageDirDraft}
        onChange={onStorageDirChange}
        onBlur={onStorageDirBlur}
        placeholder="Default (built-in)"
        className="project-page__ns-config-input"
      />
      <label className="project-page__ns-config-check">
        <input
          type="checkbox"
          defaultChecked={namespace.writeFiles ?? false}
          onChange={(event) => onWriteFilesChange(event.target.checked)}
        />
        Write files
      </label>
      <label className="project-page__ns-config-check">
        <input
          type="checkbox"
          defaultChecked={!!namespace.enhance?.auto}
          onChange={(event) => onAutoEnhanceChange(event.target.checked)}
        />
        Auto-enhance
      </label>
    </div>
  );
}

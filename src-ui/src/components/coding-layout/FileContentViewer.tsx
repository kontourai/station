import { FilePreviewPane } from '../../workspace-panes/FilePreviewPane';
import { Empty } from '../state';

export function FileContentViewer({
  filePath,
  projectSlug,
}: {
  /** The caller's folder. The project-bound preview resolves the file
   * against the Project's own folder, and nothing reads this. */
  workingDir: string;
  filePath: string;
  onClose: () => void;
  /** The preview is project-bound; without a Project there is no reader. */
  projectSlug?: string;
}) {
  if (projectSlug) {
    return (
      <FilePreviewPane
        projectSlug={projectSlug}
        stateKey="coding-file-preview"
        state={{
          version: '1.0',
          projectSlug,
          path: filePath,
          wrap: true,
        }}
      />
    );
  }

  // #2412: every coding read names its Project, so there is no path-only
  // reader for a caller without one.
  return (
    <Empty
      variant="compact"
      label="Preview unavailable"
      description={`Open ${filePath} from its Project to preview it.`}
    />
  );
}

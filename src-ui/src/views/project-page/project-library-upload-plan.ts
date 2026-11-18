import {
  PROJECT_LIBRARY_UPLOAD_MAX_BYTES,
  projectLibraryUploadPath,
} from '@kontourai/station-contracts/project-library';

export interface PickedFile {
  name: string;
  size: number;
  /** Set by a folder picker: the path below (and including) the picked folder. */
  webkitRelativePath?: string;
}

export interface LibraryUploadPlan<F extends PickedFile> {
  accepted: { file: F; relativePath: string }[];
  /** Files left out, by reason; hidden files and node_modules are expected. */
  skipped: {
    hidden: number;
    nodeModules: number;
    invalid: number;
    tooLarge: number;
  };
}

/**
 * Which picked files the Library uploads, keeping a picked folder's layout.
 * Hidden files and node_modules are skipped, as are files over the limit.
 */
export function planLibraryUpload<F extends PickedFile>(
  files: Iterable<F>,
): LibraryUploadPlan<F> {
  const plan: LibraryUploadPlan<F> = {
    accepted: [],
    skipped: { hidden: 0, nodeModules: 0, invalid: 0, tooLarge: 0 },
  };
  for (const file of files) {
    const parsed = projectLibraryUploadPath(
      file.webkitRelativePath || file.name,
    );
    if (!parsed.ok) {
      if (parsed.reason === 'hidden') plan.skipped.hidden += 1;
      else if (parsed.reason === 'node_modules') plan.skipped.nodeModules += 1;
      else plan.skipped.invalid += 1;
      continue;
    }
    if (file.size > PROJECT_LIBRARY_UPLOAD_MAX_BYTES) {
      plan.skipped.tooLarge += 1;
      continue;
    }
    plan.accepted.push({ file, relativePath: parsed.path });
  }
  return plan;
}

/** One sentence naming what was left out, or undefined when nothing was. */
export function describeSkipped(
  skipped: LibraryUploadPlan<PickedFile>['skipped'],
): string | undefined {
  const parts: string[] = [];
  const quietly = skipped.hidden + skipped.nodeModules;
  if (quietly > 0)
    parts.push(
      `${quietly} hidden or node_modules ${quietly === 1 ? 'file' : 'files'}`,
    );
  if (skipped.tooLarge > 0)
    parts.push(
      `${skipped.tooLarge} over ${PROJECT_LIBRARY_UPLOAD_MAX_BYTES / (1024 * 1024)} MB`,
    );
  if (skipped.invalid > 0)
    parts.push(
      `${skipped.invalid} with ${skipped.invalid === 1 ? 'a name' : 'names'} Station can't store`,
    );
  return parts.length > 0 ? `Skipped ${parts.join(', ')}.` : undefined;
}

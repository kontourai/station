import {
  filterProjectLibraryItems,
  type ProjectLibraryItem,
  type ProjectLibrarySourceFilter,
  projectLibraryTasks,
} from '@kontourai/station-contracts/project-library';
import {
  downloadProjectLibraryContent,
  type ProjectLibraryContent,
  projectLibraryQueries,
  readProjectLibraryCapability,
  uploadProjectLibraryFile,
  useDeleteProjectLibraryFileMutation,
  useProjectLibraryQuery,
} from '@kontourai/station-sdk/project-library';
import { Badge, Select } from '@kontourai/ui/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { ActionRow } from '../../components/ActionRow';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { PageSection } from '../../components/PageSection';
import {
  Empty,
  ErrorState,
  FilteredEmpty,
  SkeletonBlock,
  SkeletonList,
} from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { errorText } from '../../utils/errorText';
import { formatBytes } from '../../utils/formatBytes';
import { formatDateTime } from '../../utils/relativeTime';
import {
  describeSkipped,
  planLibraryUpload,
} from './project-library-upload-plan';
import './ProjectLibrarySection.css';

type Scope = NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;

const SOURCE_LABELS: Record<ProjectLibrarySourceFilter, string> = {
  all: 'All files',
  people: 'Added by people',
  tasks: 'Kept by Tasks',
};

function itemKey(item: ProjectLibraryItem): string {
  return item.kind === 'upload'
    ? `upload:${item.relativePath}`
    : `output:${item.outputId}`;
}

function itemName(item: ProjectLibraryItem): string {
  return item.kind === 'upload' ? item.relativePath : item.fileName;
}

/**
 * #5067: the Project Library, on the Project's Files & connections tab.
 * Files people add and files Tasks keep, in one list; every chat in the
 * Project can read them.
 */
export function ProjectLibrarySection({ slug }: { slug: string }) {
  const enabled = useSurfaceVisibilityFlags().has('project-library');
  return enabled ? <ProjectLibraryGate slug={slug} /> : null;
}

function ProjectLibraryGate({ slug }: { slug: string }) {
  const authority = useHostRequestAuthorityScope();
  const capability = useQuery({
    queryKey: ['project-library-capability', authority?.apiBase ?? null],
    queryFn: () => readProjectLibraryCapability(authority!.apiBase),
    enabled: Boolean(authority),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return (
    <PageSection
      id="section-library"
      title="Library"
      description="Files people add and files Tasks keep. Every chat in this Project can read them."
    >
      {!authority ? (
        <p>Connect to this Station to see the Library.</p>
      ) : capability.isPending ? (
        <SkeletonBlock count={1} label="Loading Library" />
      ) : capability.data !== true ? (
        <Empty
          variant="compact"
          label="This Station can't keep a Library"
          description="Update Station on this computer to add files to Projects."
        />
      ) : (
        <ProjectLibrary
          key={JSON.stringify([
            slug,
            authority.apiBase,
            authority.authorityKey,
          ])}
          slug={slug}
          scope={authority}
        />
      )}
    </PageSection>
  );
}

function ProjectLibrary({ slug, scope }: { slug: string; scope: Scope }) {
  const { navigate } = useNavigation();
  const library = useProjectLibraryQuery(slug, { requestScope: scope });
  const queryClient = useQueryClient();
  const remove = useDeleteProjectLibraryFileMutation();
  const [source, setSource] = useState<ProjectLibrarySourceFilter>('all');
  const [taskId, setTaskId] = useState<string>('');
  const [open, setOpen] = useState<string>();
  const [removing, setRemoving] = useState<string>();
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [notice, setNotice] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const sourceId = useId();
  const taskFilterId = useId();

  async function addFiles(list: FileList | null) {
    if (!list || list.length === 0 || !scope.isCurrent()) return;
    const plan = planLibraryUpload(Array.from(list));
    setFailure(undefined);
    setNotice(undefined);
    const failed: string[] = [];
    for (const [index, entry] of plan.accepted.entries()) {
      if (!scope.isCurrent()) break;
      setProgress({ done: index, total: plan.accepted.length });
      try {
        await uploadProjectLibraryFile(
          scope.apiBase,
          slug,
          entry.relativePath,
          entry.file,
          {
            requestScope: scope,
          },
        );
      } catch {
        failed.push(entry.relativePath);
      }
    }
    if (plan.accepted.length > 0) {
      const target = {
        queryKey: projectLibraryQueries.library(slug, scope).queryKey,
        exact: true,
      };
      // An initial read with no cached data is reused by invalidation unless cancelled.
      await queryClient.cancelQueries(target);
      void queryClient.invalidateQueries({
        ...target,
        refetchType: scope.isCurrent() ? 'active' : 'none',
      });
    }
    setProgress(undefined);
    if (!scope.isCurrent()) return;
    const added = plan.accepted.length - failed.length;
    setNotice(
      [
        added > 0 ? `Added ${added} ${added === 1 ? 'file' : 'files'}.` : '',
        describeSkipped(plan.skipped) ?? '',
      ]
        .filter(Boolean)
        .join(' ') || undefined,
    );
    if (failed.length > 0)
      setFailure(
        `${failed.length} ${failed.length === 1 ? 'file' : 'files'} didn't upload: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}`,
      );
  }

  const items = library.data?.items ?? [];
  const tasks = projectLibraryTasks(items);
  const visible = filterProjectLibraryItems(items, {
    source,
    ...(taskId ? { taskId } : {}),
  });
  const busy = progress !== undefined;

  return (
    <div className="project-library">
      <ActionRow
        label="Library actions"
        overflowLabel="More Library actions"
        primary={
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => filesInput.current?.click()}
          >
            Add files
          </Button>
        }
        secondary={
          <Button disabled={busy} onClick={() => folderInput.current?.click()}>
            Add folder
          </Button>
        }
      />
      <input
        ref={filesInput}
        type="file"
        multiple
        hidden
        aria-label="Choose files to add"
        onChange={(event) => {
          const files = event.currentTarget.files;
          void addFiles(files).finally(() => {
            if (filesInput.current) filesInput.current.value = '';
          });
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        aria-label="Choose a folder to add"
        {...{ webkitdirectory: '', directory: '' }}
        onChange={(event) => {
          const files = event.currentTarget.files;
          void addFiles(files).finally(() => {
            if (folderInput.current) folderInput.current.value = '';
          });
        }}
      />
      {progress && (
        <p className="project-library__status" role="status">
          Adding {Math.min(progress.done + 1, progress.total)} of{' '}
          {progress.total}…
        </p>
      )}
      {!progress && notice && (
        <p className="project-library__status" role="status">
          {notice}
        </p>
      )}
      {failure && (
        <ErrorState
          variant="compact"
          title="Some files didn't upload"
          description={failure}
          action={
            <Button size="sm" onClick={() => setFailure(undefined)}>
              Dismiss
            </Button>
          }
        />
      )}

      {library.isPending ? (
        <SkeletonList count={3} label="Loading Library files" />
      ) : library.isError ? (
        <ErrorState
          variant="compact"
          title="Couldn't load the Library"
          description={errorText(library.error)}
          action={
            <Button size="sm" onClick={() => void library.refetch()}>
              Retry
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <Empty
          variant="compact"
          label="This Library is empty"
          description="Add files or a folder, or keep a file from a Task."
        />
      ) : (
        <>
          {(library.data.partial || library.data.truncated) && (
            <ErrorState
              variant="compact"
              title={
                library.data.truncated
                  ? 'Showing the first 2,000 files'
                  : 'Some files couldn’t be listed'
              }
              description="The rest are still in the Library."
              action={
                <Button size="sm" onClick={() => void library.refetch()}>
                  Retry
                </Button>
              }
            />
          )}
          <div className="project-library__filters">
            <span className="project-library__filter">
              <label htmlFor={sourceId}>Show</label>
              <Select
                id={sourceId}
                value={taskId ? 'tasks' : source}
                onChange={(event) => {
                  setSource(
                    event.currentTarget.value as ProjectLibrarySourceFilter,
                  );
                  setTaskId('');
                }}
              >
                {(
                  Object.keys(SOURCE_LABELS) as ProjectLibrarySourceFilter[]
                ).map((key) => (
                  <option key={key} value={key}>
                    {SOURCE_LABELS[key]}
                  </option>
                ))}
              </Select>
            </span>
            {tasks.length > 0 && (
              <span className="project-library__filter">
                <label htmlFor={taskFilterId}>Task</label>
                <Select
                  id={taskFilterId}
                  value={taskId}
                  onChange={(event) => setTaskId(event.currentTarget.value)}
                >
                  <option value="">Any Task</option>
                  {tasks.map((task) => (
                    <option key={task.taskId} value={task.taskId}>
                      {task.title ?? 'Deleted Task'}
                    </option>
                  ))}
                </Select>
              </span>
            )}
          </div>
          {visible.length === 0 ? (
            <FilteredEmpty
              query={taskId ? 'this Task' : SOURCE_LABELS[source]}
              noun="the Library"
              onClear={() => {
                setSource('all');
                setTaskId('');
              }}
            />
          ) : (
            <ul className="project-library__list" aria-label="Library files">
              {visible.map((item) => {
                const key = itemKey(item);
                const expanded = open === key;
                return (
                  <li key={key} className="project-library__item">
                    <div className="project-library__row">
                      <div className="project-library__identity">
                        <span className="project-library__name">
                          {itemName(item)}
                        </span>
                        <span className="project-library__meta">
                          {formatBytes(item.byteLength)} ·{' '}
                          {formatDateTime(
                            item.kind === 'upload'
                              ? item.modifiedAt
                              : item.createdAt,
                            '',
                          )}
                        </span>
                        <span className="project-library__origin">
                          {item.kind === 'upload' ? (
                            <Badge tone="neutral" value="Added" />
                          ) : item.task.state === 'present' ? (
                            <button
                              type="button"
                              className="project-library__task-link"
                              onClick={() =>
                                navigate(
                                  `/tasks/${encodeURIComponent(item.taskId)}`,
                                )
                              }
                            >
                              From {item.task.title}
                            </button>
                          ) : (
                            <Badge tone="caution" value="Orphaned" />
                          )}
                          {item.kind === 'task-output' &&
                            item.task.state === 'orphaned' && (
                              <span className="project-library__meta">
                                Its Task was deleted.
                              </span>
                            )}
                        </span>
                      </div>
                      <ActionRow
                        label={`Actions for ${itemName(item)}`}
                        overflowLabel={`More actions for ${itemName(item)}`}
                        primary={
                          <Button
                            size="sm"
                            aria-expanded={expanded}
                            aria-label={`${expanded ? 'Hide' : 'Preview'} ${itemName(item)}`}
                            onClick={() => setOpen(expanded ? undefined : key)}
                          >
                            {expanded ? 'Hide' : 'Preview'}
                          </Button>
                        }
                        overflow={
                          item.kind === 'upload'
                            ? [
                                {
                                  key: 'remove',
                                  label: 'Remove…',
                                  tone: 'danger',
                                  haspopup: 'dialog',
                                  onSelect: () =>
                                    setRemoving(item.relativePath),
                                },
                              ]
                            : []
                        }
                      />
                    </div>
                    {expanded && (
                      <LibraryFilePreview
                        slug={slug}
                        scope={scope}
                        item={item}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <ConfirmModal
        isOpen={removing !== undefined}
        title="Remove this file?"
        message={`${removing ?? ''} leaves the Library. Chats in this Project can no longer read it.`}
        confirmLabel="Remove"
        variant="danger"
        pending={remove.isPending}
        onCancel={() => setRemoving(undefined)}
        onConfirm={() => {
          const path = removing;
          if (!path) return;
          remove.mutate(
            { slug, requestScope: scope, relativePath: path },
            {
              onSuccess: () => {
                setRemoving(undefined);
                if (open === `upload:${path}`) setOpen(undefined);
              },
              onError: (error) => {
                setRemoving(undefined);
                setFailure(`Couldn't remove ${path}: ${errorText(error)}`);
              },
            },
          );
        }}
      />
    </div>
  );
}

const TEXT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);
const PREVIEW_MAX_BYTES = 256 * 1024;

/** The same bounded preview Task outputs use: text inline, a checked PNG, else download. */
function LibraryFilePreview({
  slug,
  scope,
  item,
}: {
  slug: string;
  scope: Scope;
  item: ProjectLibraryItem;
}) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; content: ProjectLibraryContent }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [pngUrl, setPngUrl] = useState<string>();
  const target =
    item.kind === 'upload'
      ? { relativePath: item.relativePath }
      : { outputId: item.outputId };
  const targetKey = itemKey(item);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `target` is derived from `targetKey`.
  useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    if (item.kind === 'task-output' && !item.contentAvailable) {
      setState({ kind: 'error', message: 'This file’s content is gone.' });
      return;
    }
    void downloadProjectLibraryContent(scope.apiBase, slug, target, {
      requestScope: {
        apiBase: scope.apiBase,
        authorityKey: scope.authorityKey,
      },
    })
      .then((content) => {
        if (active && scope.isCurrent()) setState({ kind: 'ready', content });
      })
      .catch((error) => {
        if (active) setState({ kind: 'error', message: errorText(error) });
      });
    return () => {
      active = false;
    };
  }, [slug, scope, targetKey, attempt]);
  const safePng =
    state.kind === 'ready' &&
    state.content.safePreview === 'image/png' &&
    state.content.mediaType === 'image/png';
  useEffect(() => {
    if (!safePng || state.kind !== 'ready') {
      setPngUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([state.content.bytes.slice().buffer], { type: 'image/png' }),
    );
    setPngUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [safePng, state]);

  function download() {
    if (state.kind !== 'ready') return;
    const url = URL.createObjectURL(
      new Blob([state.content.bytes.slice().buffer], {
        type: state.content.mediaType,
      }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    const name = itemName(item);
    anchor.download = name.slice(name.lastIndexOf('/') + 1);
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (state.kind === 'loading')
    return <SkeletonBlock count={1} label="Loading preview" />;
  if (state.kind === 'error')
    return (
      <ErrorState
        variant="compact"
        title="Couldn't open this file"
        description={state.message}
        action={
          <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </Button>
        }
      />
    );
  const downloadButton = (
    <Button
      size="sm"
      onClick={download}
      aria-label={`Download ${itemName(item)}`}
    >
      Download
    </Button>
  );
  if (safePng && pngUrl)
    return (
      <section
        className="project-library__preview"
        aria-label={`Preview of ${itemName(item)}`}
      >
        <img src={pngUrl} alt={itemName(item)} />
        {downloadButton}
      </section>
    );
  if (!TEXT_TYPES.has(state.content.mediaType.split(';')[0]!.trim()))
    return (
      <div className="project-library__preview">
        <p>Download this file to open it.</p>
        {downloadButton}
      </div>
    );
  const bounded = state.content.bytes.slice(0, PREVIEW_MAX_BYTES);
  return (
    <section
      className="project-library__preview"
      aria-label={`Preview of ${itemName(item)}`}
    >
      <pre>{new TextDecoder().decode(bounded)}</pre>
      {state.content.bytes.length > bounded.length && (
        <p>Showing the first 256 KiB. Download for the whole file.</p>
      )}
      {downloadButton}
    </section>
  );
}

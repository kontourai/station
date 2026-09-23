import type { LayoutComponent } from '@kontourai/station-sdk';
import {
  PLUGIN_DRAFT_LEASE_TTL_MS,
  type PluginDraftStatus,
} from '@kontourai/station-contracts/plugin-draft';
import { authenticatedFetch } from '@kontourai/station-sdk';
import { useQuery } from '@tanstack/react-query';
import {
  Component,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Button } from '../components/Button';
import { describeReadFailure, ErrorState, SkeletonBlock } from '../components/state';
import { useApiBase } from '../contexts/ApiBaseContext';
import {
  type PluginBundleExports,
  pluginRegistry,
} from '../core/PluginRegistry';
import { LayoutRenderer } from '../layouts';
import { PluginWorkspacePaneSDKBoundary } from './PluginWorkspacePaneSDKBoundary';
import './PluginDraftPreviewPane.css';

/**
 * The Plugin preview pane (epic #2323 S3): a Project's plugin draft, built
 * from its folder by the server and run IN-PROCESS — the same runtime an
 * installed loopback plugin uses — but only when the person looking at it
 * says so.
 *
 * The guardrail is the product here (owner decision, epic #2323):
 *
 * - Nothing about the draft's CODE is fetched or executed when this pane
 *   opens. The pane reads status only; the bundle is requested by
 *   {@link DraftRevisionHost}, which mounts only after an explicit click.
 * - Each revision needs its own click. A rebuilt revision shows a
 *   "Revision N ready" bar with a one-click Run; it never replaces the
 *   running one on its own.
 * - The choice lives in this component's memory and nowhere else — not
 *   localStorage, not the server — so another tab, another device, or
 *   another member opening the same Project starts at the inert card.
 * - A draft registers under its own per-revision key, never an installed
 *   plugin's (see `PluginRegistry.loadDraftBundle`).
 */

export const PLUGIN_DRAFT_DISCLOSURE =
  'This draft is not installed or reviewed. Running it gives its code your full access in this tab.';

/** One lease refresh well inside the server's lease TTL. */
const LEASE_REFRESH_MS = Math.floor(PLUGIN_DRAFT_LEASE_TTL_MS / 3);

export const pluginDraftQueryKey = (apiBase: string, projectSlug: string) =>
  ['plugin-draft', apiBase, projectSlug] as const;

interface RunningRevision {
  readonly generation: number;
  readonly registrationKey: string;
  readonly hasCss: boolean;
}

export function PluginDraftPreviewPane({
  projectSlug,
}: {
  projectSlug: string;
}) {
  const { apiBase } = useApiBase();
  const draftPath = `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/plugin-draft`;
  // The lease IS the status read: refreshing it keeps the server watching
  // this folder while the pane is open, and answers with the latest status.
  // The server's rebuilt event invalidates this key (useServerEvents).
  const status = useQuery({
    queryKey: pluginDraftQueryKey(apiBase, projectSlug),
    queryFn: async ({ signal }): Promise<PluginDraftStatus> => {
      const response = await authenticatedFetch(`${draftPath}/lease`, {
        method: 'POST',
        signal,
      });
      if (!response.ok) {
        throw new Error(`Plugin preview is unavailable (${response.status}).`);
      }
      return (await response.json()) as PluginDraftStatus;
    },
    refetchInterval: LEASE_REFRESH_MS,
  });
  const [running, setRunning] = useState<RunningRevision | null>(null);
  const [selectedComponent, setSelectedComponent] = useState<string>();
  const [inProcess, setInProcess] = useState<boolean | undefined>();

  useEffect(() => {
    let current = true;
    void pluginRegistry.executesBundlesInProcess().then(
      (value) => current && setInProcess(value),
      () => current && setInProcess(false),
    );
    return () => {
      current = false;
    };
  }, [apiBase]);

  const draft = status.data;
  const latest: RunningRevision | null =
    draft?.generation && draft.registrationKey
      ? {
          generation: draft.generation,
          registrationKey: draft.registrationKey,
          hasCss: draft.hasCss,
        }
      : null;
  const panes = draft?.panes ?? [];
  const component =
    selectedComponent && panes.some((p) => p.component === selectedComponent)
      ? selectedComponent
      : panes[0]?.component;

  if (status.isPending) {
    return <SkeletonBlock count={3} label="Loading Plugin preview" />;
  }
  if (status.isError && !draft) {
    return (
      <ErrorState
        title="Plugin preview is unavailable"
        description={describeReadFailure(status.error)}
        action={
          <Button size="sm" onClick={() => void status.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  if (!draft) return null;

  const newerRevision =
    running && latest && latest.generation > running.generation ? latest : null;

  return (
    <section className="plugin-draft-pane" aria-label="Plugin preview">
      <header className="plugin-draft-pane__header">
        <div>
          <h3 className="plugin-draft-pane__title">
            {draft.pluginName ?? 'Plugin preview'}
            {draft.pluginVersion ? (
              <span className="plugin-draft-pane__version">
                {' '}
                {draft.pluginVersion}
              </span>
            ) : null}
          </h3>
          <p className="plugin-draft-pane__status" role="status">
            {describeDraftState(draft, running)}
          </p>
        </div>
        {panes.length > 1 ? (
          <label className="plugin-draft-pane__picker">
            <span>Pane</span>
            <select
              value={component}
              onChange={(event) => setSelectedComponent(event.target.value)}
            >
              {panes.map((pane) => (
                <option key={pane.id} value={pane.component}>
                  {pane.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </header>

      {draft.diagnostics.length > 0 ? (
        <ul className="plugin-draft-pane__diagnostics" aria-label="Problems">
          {draft.diagnostics.map((diagnostic, index) => (
            <li key={`${index}-${diagnostic.text}`}>
              {diagnostic.file ? (
                <code>
                  {diagnostic.file}
                  {diagnostic.line ? `:${diagnostic.line}` : ''}
                  {diagnostic.column !== undefined && diagnostic.line
                    ? `:${diagnostic.column}`
                    : ''}
                </code>
              ) : null}{' '}
              {diagnostic.text}
            </li>
          ))}
        </ul>
      ) : null}

      {newerRevision ? (
        <div className="plugin-draft-pane__bar" role="status">
          <span>Revision {newerRevision.generation} ready.</span>
          <Button
            size="sm"
            variant="primary"
            onClick={() => setRunning(newerRevision)}
          >
            Run revision {newerRevision.generation}
          </Button>
        </div>
      ) : null}

      {running ? (
        <div className="plugin-draft-pane__running">
          <div className="plugin-draft-pane__running-bar">
            <span>
              Running revision {running.generation} in this tab. It is not
              installed or reviewed.
            </span>
            <Button size="sm" onClick={() => setRunning(null)}>
              Stop
            </Button>
          </div>
          <DraftRevisionHost
            // A new revision is a new tree: nothing from the previous
            // revision's components or state can survive into it.
            key={running.registrationKey}
            draftPath={draftPath}
            projectSlug={projectSlug}
            revision={running}
            componentName={component}
          />
        </div>
      ) : (
        <div className="plugin-draft-pane__inert">
          <p className="plugin-draft-pane__disclosure">
            {PLUGIN_DRAFT_DISCLOSURE}
          </p>
          {inProcess === false ? (
            <p className="plugin-draft-pane__note">
              Draft previews run only on a local Station connection, where
              installed plugins also run in this tab.
            </p>
          ) : null}
          <Button
            variant="primary"
            disabled={!latest || inProcess !== true}
            onClick={() => latest && setRunning(latest)}
          >
            {latest ? `Run revision ${latest.generation}` : 'Run this draft'}
          </Button>
        </div>
      )}
    </section>
  );
}

function describeDraftState(
  draft: PluginDraftStatus,
  running: RunningRevision | null,
): string {
  switch (draft.state) {
    case 'no-manifest':
      return 'No plugin.json in this Project’s folder yet. The preview will build when one appears.';
    case 'building':
      return draft.generation
        ? `Building a new revision. Revision ${draft.generation} is the latest that built.`
        : 'Building the draft…';
    case 'failed':
      return draft.generation
        ? `The latest edit did not build. Revision ${draft.generation} is the latest that did.`
        : 'The draft did not build.';
    case 'unavailable':
      return 'This draft cannot be previewed right now.';
    case 'idle':
      return 'Not watching this folder.';
    case 'ready':
      return running
        ? `Revision ${draft.generation} is the latest build.`
        : `Revision ${draft.generation} built. It has not run in this tab.`;
  }
}

type RevisionLoad =
  | { state: 'loading' }
  | { state: 'failed'; message: string }
  | { state: 'ready'; exports: PluginBundleExports };

/**
 * Fetches and executes ONE draft revision. It exists only after the viewer
 * chose to run this revision; its unmount (Stop, a newer revision, closing
 * the pane) unloads the revision's registration, nodes and activation.
 */
function DraftRevisionHost({
  draftPath,
  projectSlug,
  revision,
  componentName,
}: {
  draftPath: string;
  projectSlug: string;
  revision: RunningRevision;
  componentName: string | undefined;
}) {
  const [load, setLoad] = useState<RevisionLoad>({ state: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    let unload: (() => void) | undefined;
    const base = `${draftPath}/generations/${revision.generation}`;
    pluginRegistry
      .loadDraftBundle({
        bundleUrl: `${base}/bundle.js`,
        ...(revision.hasCss ? { cssUrl: `${base}/bundle.css` } : {}),
        registrationKey: revision.registrationKey,
        signal: controller.signal,
      })
      .then(
        (bundle) => {
          if (controller.signal.aborted) {
            bundle.unload();
            return;
          }
          unload = bundle.unload;
          setLoad({ state: 'ready', exports: bundle.exports });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setLoad({
            state: 'failed',
            message:
              error instanceof Error
                ? error.message
                : 'The draft could not be loaded.',
          });
        },
      );
    return () => {
      controller.abort();
      unload?.();
    };
  }, [draftPath, revision]);

  const Draft = useMemo(
    () =>
      load.state === 'ready'
        ? resolveDraftComponent(load.exports, componentName)
        : null,
    [load, componentName],
  );

  if (load.state === 'loading')
    return <SkeletonBlock count={3} label="Loading the draft" />;
  if (load.state === 'failed')
    return (
      <ErrorState
        title="This revision could not run"
        description={load.message}
      />
    );
  if (!Draft)
    return (
      <ErrorState
        title="Nothing to render"
        description={
          componentName
            ? `The draft does not export a component named “${componentName}”.`
            : 'The draft declares no workspace pane and has no default export.'
        }
      />
    );
  const tab = {
    id: `plugin-draft:${revision.registrationKey}`,
    label: componentName ?? 'Draft',
    component: { kind: 'plugin-component' as const, name: componentName ?? 'default' },
  };
  const layout = { name: 'Plugin preview', slug: tab.id, tabs: [tab] };
  return (
    <DraftErrorBoundary>
      <PluginWorkspacePaneSDKBoundary layout={layout} projectSlug={projectSlug}>
        <LayoutRenderer
          componentId={tab.component}
          trustedPluginLayout={Draft}
          layout={layout}
          activeTab={tab}
          activeTabId={tab.id}
        />
      </PluginWorkspacePaneSDKBoundary>
    </DraftErrorBoundary>
  );
}

function resolveDraftComponent(
  exports: PluginBundleExports,
  componentName: string | undefined,
): LayoutComponent | null {
  if (componentName) {
    const named = exports.components?.[componentName];
    return typeof named === 'function' ? named : null;
  }
  if (typeof exports.default === 'function') return exports.default;
  const first = Object.values(exports.components ?? {})[0];
  return typeof first === 'function' ? first : null;
}

/**
 * A draft that throws while rendering takes down its own subtree, not the
 * pane's controls: the person still sees Stop and the next revision's Run.
 */
class DraftErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed)
      return (
        <ErrorState
          title="This revision stopped rendering"
          description="It threw an error. Fix it in the Project and run the next revision."
        />
      );
    return this.props.children;
  }
}

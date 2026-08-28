import { isCanonicalWorkspaceHomePaneInstance } from '@kontourai/station-contracts/workspace-home-pane';
import { createContext, type ReactNode, useContext } from 'react';
import type { NavigationView } from '../../types';
import type { BuiltinWorkspacePaneProps } from '../../workspace-panes/builtinWorkspacePaneRegistry';
import { WorkspacePaneBindingUnavailable } from '../../workspace-panes/WorkspacePaneBindingUnavailable';
import { WorkspacePaneDockAction } from '../../workspace-panes/WorkspacePaneDockAction';
import { HomeSurface, type HomeViewModel } from './HomeSurface';
import type { HomeViewNavigation } from './useHomeViewModel';

/**
 * What the built-in Home renderer needs that a Pane host cannot supply.
 *
 * `WorkspacePaneDescriptor` deliberately carries no renderer inputs — a
 * descriptor is inert data, and a host handing a renderer a live model
 * through it would make every contributed Pane's data surface a property of
 * the declaration rather than of the grant. Home's model therefore reaches
* its renderer the same way `useNavigation` and `useProjectLayoutQuery`
 * reach the Project built-ins: through context owned by the route that has
 * the data, read by the renderer that needs it.
 *
 * This is also where the trust question in archive#3122 lands: a
 * contributed Home renderer must not receive this value. It is scoped to the
 * built-in renderer's module rather than exported as an app-wide context so
 * that reaching it is a deliberate act, not an ambient one.
 */
export interface HomeWorkspacePaneBinding {
  model: HomeViewModel;
/** Best safe project continuation, or null when there is nothing to resume. */
  continuation: HomeViewNavigation | null;
  onNavigate: (view: NavigationView) => void;
}

const HomeWorkspacePaneContext = createContext<HomeWorkspacePaneBinding | null>(
  null,
);

export function HomeWorkspacePaneBindingProvider({
  binding,
  children,
}: {
  binding: HomeWorkspacePaneBinding;
  children: ReactNode;
}) {
  return (
    <HomeWorkspacePaneContext.Provider value={binding}>
      {children}
    </HomeWorkspacePaneContext.Provider>
  );
}

/**
 * The built-in Home Workspace Pane renderer.
 *
 * Registered in `builtinWorkspacePaneRegistry` under the renderer name its
 * contract declares. Unlike the eleven Project built-ins it never consults
 * `useWorkspacePaneBoundIdentity`: Home binds no Project, so there is no
 * captured identity whose resolution could fail — reporting
 * `missing-project-binding` here would name a defect the contract says
 * cannot exist. Home's one derivable failure is the same occurrence check
 * every built-in performs: a placed instance that is not Home's canonical
 * one does not match the renderer it was opened with, and says so.
 *
 * A missing context binding is not a user-visible state: the context is
 * module-scoped and its only producer is Home's route host, so its absence
 * means a host mounted this renderer outside that seam — a programming
 * error with no honest user copy. It renders nothing rather than narrating
 * a state no supported host produces.
 */
export function HomeWorkspacePane({
  descriptor,
  instance,
}: BuiltinWorkspacePaneProps) {
  const binding = useContext(HomeWorkspacePaneContext);
  if (!isCanonicalWorkspaceHomePaneInstance(instance))
    return (
      <WorkspacePaneBindingUnavailable
        identity={{ state: 'pane-instance-invalid' }}
      />
    );
  if (!binding) return null;
  return (
    <HomeSurface
      model={binding.model}
      continuation={binding.continuation}
      onNavigate={binding.onNavigate}
      topAction={
        <WorkspacePaneDockAction descriptor={descriptor} instance={instance} />
      }
    />
  );
}

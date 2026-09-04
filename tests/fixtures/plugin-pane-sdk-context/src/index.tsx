import {
  type LayoutComponent,
  type LayoutComponentProps,
  useAgents,
  useNavigation,
  useSDK,
  useToast,
} from '@kontourai/station-sdk';

/** Real public SDK consumers: no replacement providers or injected callbacks. */
function PaneSDKContextProof({ layout }: LayoutComponentProps) {
  const agents = useAgents();
  const navigation = useNavigation();
  const { pluginName } = useSDK();
  const { showToast } = useToast();
  return (
    <section aria-label="Installed Pane SDK proof">
      <h2>Installed Pane SDK proof</h2>
      <p>Plugin: {pluginName}</p>
      <p>Project: {navigation.selectedProject ?? 'unbound'}</p>
      <p>Occurrence: {layout?.slug ?? 'unbound'}</p>
      <p>Discovered Agents: {agents.length}</p>
      <p>Chat dock: {navigation.dockState ? 'open' : 'closed'}</p>
      <button
        type="button"
        onClick={() => {
          navigation.setDockState(true);
          showToast({ type: 'info', message: 'Pane proof chat dock opened' });
        }}
      >
        Open Chat Dock
      </button>
    </section>
  );
}

export const components = {
  'pane-sdk-context-proof': PaneSDKContextProof,
} satisfies Record<string, LayoutComponent>;

export default PaneSDKContextProof;

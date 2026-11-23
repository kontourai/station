import { usePageHeader } from '../../components/page-frame';
import { Tabs, tabElementId, tabPanelElementId } from '../../components/Tabs';
import { useNavigation } from '../../contexts/NavigationContext';
import { PluginManagementView } from '../PluginManagementView';
import { APPS_SUBTITLE } from './appsCopy';
import { DiscoverView } from './DiscoverView';
import './AppsView.css';

const TABS_ID = 'apps';
const TABS = [
  { key: 'discover', label: 'Discover' },
  { key: 'library', label: 'Library' },
] as const;

/**
 * Apps: Discover finds what can be added, and Library manages what is
 * installed. Library hosts the installed-plugin management view as it is.
 */
export function AppsView({ tab }: { tab: 'discover' | 'library' }) {
  const { navigate } = useNavigation();
  return (
    <div className="apps-view">
      <Tabs
        id={TABS_ID}
        aria-label="Apps"
        className="apps-view__tabs"
        // Each tab is its own address, so moving focus must not navigate.
        activation="manual"
        items={TABS}
        activeKey={tab}
        onSelect={(key) => navigate(`/apps/${key}`)}
      />
      <div
        className="apps-view__panel"
        role="tabpanel"
        id={tabPanelElementId(TABS_ID, tab)}
        aria-labelledby={tabElementId(TABS_ID, tab)}
      >
        {tab === 'discover' ? <DiscoverPanel /> : <PluginManagementView />}
      </div>
    </div>
  );
}

const DISCOVER_HEADER = { title: 'Apps', subtitle: APPS_SUBTITLE };

function DiscoverPanel() {
  usePageHeader(DISCOVER_HEADER);
  return <DiscoverView />;
}

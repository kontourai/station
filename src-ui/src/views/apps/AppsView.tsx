import { usePageHeader } from '../../components/page-frame';
import {
  StationExtensionsAccess,
  useStationExtensionsAccess,
} from '../../components/registry/StationExtensionsAccess';
import { Tabs, tabElementId, tabPanelElementId } from '../../components/Tabs';
import { useNavigation } from '../../contexts/NavigationContext';
import { PluginManagementView } from '../PluginManagementView';
import { AppsLoadFailure } from './AppsLoadFailure';
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
        {tab === 'discover' ? <DiscoverPanel /> : <LibraryPanel />}
      </div>
    </div>
  );
}

const DISCOVER_HEADER = { title: 'Apps', subtitle: APPS_SUBTITLE };

function DiscoverPanel() {
  usePageHeader(DISCOVER_HEADER);
  return <DiscoverView />;
}

/**
 * Library is where installed apps are managed, so it also holds this
 * device's switch for remote extension code: first while it blocks apps from
 * loading, otherwise after the list.
 */
function LibraryPanel() {
  const extensionAccess = useStationExtensionsAccess();
  const remoteAccess = <StationExtensionsAccess />;
  return (
    <>
      {extensionAccess.blocked && remoteAccess}
      <AppsLoadFailure />
      <PluginManagementView />
      {!extensionAccess.blocked && remoteAccess}
    </>
  );
}

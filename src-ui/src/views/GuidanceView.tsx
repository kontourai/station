import { useLayoutEffect, useState } from 'react';
import { PageHeaderScope, usePageHeader } from '../components/page-frame';
import { Tabs, tabElementId, tabPanelElementId } from '../components/Tabs';
import { useNavigation } from '../contexts/NavigationContext';
import type { NavigationView } from '../types';
import { CommandsView } from './CommandsView';
import {
  GUIDANCE_TAB_MEMORY_KEY,
  type GuidanceTab,
  resolveGuidanceTab,
} from './guidance-tab';
import { SkillsView } from './SkillsView';
import { SKILLS_SUBTITLE } from './skills/skill-view-utils';

type GuidanceRoute = Extract<NavigationView, { type: 'guidance' }>;

/**
 * Guidance is one page with two tabs. archive#4463 fixed the page's TITLE at
 * 'Guidance' — it must not change when
 * the tab changes, the same rule every other page-level view follows now: the
 * tab strip already names the section, and a title that flips between
 * 'Skills' and 'Commands' as the reader clicks a tab reads as two different
 * pages rather than one page with two views into it. Only the SUBTITLE still
 * varies by tab, and the route table cannot supply either slot, because the
 * tab can come from `sessionStorage` rather than the URL. The tab is resolved
 * by `./guidance-tab`, which the shell's route placeholder reads too, so the
 * shape it holds while this chunk loads is the shape this tab renders. The
 * Skills tab is itself a split pane with a collection title of its own
 * ("Installed Skills"); `PageHeaderScope` below stops that reaching the page
 * header, so the page title a reader reads is always 'Guidance', never the
 * pane's own collection name.
 *
 * There is ONE authored concept here — a Skill — and some skills are runnable
 * as a `/command`. Commands is deliberately still its own tab rather than a
 * filter on Skills: it answers a different question (what can I type in this
 * chat right now, and why is that one unavailable?), and most of its rows —
 * `/clear`, `/model`, an engine's own commands — are not skills and never will
 * be. Listing them under "Skills" would recreate exactly the conflation this
 * merge removes. The skills that ARE commands are reachable as a narrowed
 * Skills list (`?tab=skills&filter=commands`).
 */
const TAB_HEADERS: Record<GuidanceTab, { subtitle: string }> = {
  skills: {
    subtitle: SKILLS_SUBTITLE,
  },
  commands: {
    subtitle: 'Slash commands available to agents in chat.',
  },
};

/**
 * The Skills tab's subtitle when the reader narrowed it to command skills. It
 * says which list is on screen, because a filtered list that claims to be the
 * whole collection is the same lie as an unmeasured count.
 */
const COMMAND_SKILLS_HEADER = {
  subtitle: 'Skills that are runnable as a slash command.',
};

const PAGE_TITLE = 'Guidance';

/** Groups this view's generated tab/panel ids — see `components/Tabs.tsx`. */
const TABS_ID = 'guidance-resource-type';

export function GuidanceView({ route }: { route: GuidanceRoute }) {
  const { navigate } = useNavigation();
  const [activeTab, setActiveTab] = useState<GuidanceTab>(() =>
    resolveGuidanceTab(route.tab),
  );

  useLayoutEffect(() => {
    if (route.tab) setActiveTab(route.tab);
  }, [route.tab]);

  useLayoutEffect(() => {
    const tab = route.tab ?? activeTab;
    try {
      sessionStorage.setItem(GUIDANCE_TAB_MEMORY_KEY, tab);
    } catch {
      // Storage can be unavailable in privacy-restricted webviews.
    }
    if (route.redirectFromAlias || !route.tab) {
      navigate(
        `/guidance${route.selectedId ? `/${encodeURIComponent(route.selectedId)}` : ''}`,
        { tab },
      );
    }
  }, [activeTab, navigate, route]);

  // A filter narrows the SKILLS list; it means nothing on Commands, and
  // carrying it there would leave a live-looking param that narrows nothing.
  const filter = activeTab === 'skills' ? route.filter : undefined;
  usePageHeader({
    title: PAGE_TITLE,
    subtitle: (filter === 'commands'
      ? COMMAND_SKILLS_HEADER
      : TAB_HEADERS[activeTab]
    ).subtitle,
  });

  function selectTab(tab: GuidanceTab) {
    setActiveTab(tab);
    try {
      sessionStorage.setItem(GUIDANCE_TAB_MEMORY_KEY, tab);
    } catch {
      // The URL remains authoritative when storage is unavailable.
    }
    navigate('/guidance', { tab, filter: null });
  }

  return (
    <div className="pane-host">
      <Tabs
        id={TABS_ID}
        className="guidance-view__tabs"
        aria-label="Agent resource type"
        // Automatic activation: switching is a cheap in-place re-render
        // (no route push), so an arrow key both moves focus and activates,
        // per WAI-ARIA APG.
        activation="automatic"
        items={[
          { key: 'skills', label: 'Skills' },
          { key: 'commands', label: 'Commands' },
        ]}
        activeKey={activeTab}
        onSelect={(key) => selectTab(key as GuidanceTab)}
      />
      <div
        role="tabpanel"
        id={tabPanelElementId(TABS_ID, activeTab)}
        aria-labelledby={tabElementId(TABS_ID, activeTab)}
        className="tab-panel"
      >
        <PageHeaderScope>
          {activeTab === 'commands' ? (
            <CommandsView />
          ) : (
            <SkillsView basePath="/guidance" filter={filter} />
          )}
        </PageHeaderScope>
      </div>
    </div>
  );
}

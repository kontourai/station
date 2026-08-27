import type { ReactNode } from 'react';
import { useState } from 'react';
import { Button } from '../components/Button';
import {
  PageEyebrowTrail,
  PageFrameActions,
  PageHeaderScope,
  usePageHeader,
} from '../components/page-frame';
import {
  SplitPaneReturnFocusProvider,
  useSplitPaneExternalReturnFocus,
} from '../components/split-pane-return-focus-context';
import { Tabs, tabElementId, tabPanelElementId } from '../components/Tabs';
import { useNavigation } from '../contexts/NavigationContext';
import { AddMachineModal } from './connections-hub/AddMachineModal';
import { useConnectionSectionSignals } from './connections-hub/connection-section-signals';
import {
  CONNECTION_SECTIONS,
  type ConnectionSectionId,
} from './connections-hub/connection-sections';

// station#4463 slice 2: the rail now renders the shared `Tabs` primitive,
// which self-imports `.page__tabs`/`.page__tab`'s stylesheet — the frame no
// longer needs to carry this import for it (see `components/Tabs.tsx`).

/**
 * The eyebrow every section publishes: 'Connections', unlinked.
 *
 * station#4463 slice 1 fix round (arbiter decision): `/connections` is a
 * redirect-only resolver — `ConnectionsHub` immediately navigates to
 * whichever section most needs attention, or to Models. A click here would
 * therefore either be a no-op (it redirects right back to the section
 * already on screen) or a SIBLING jump dressed up as "go up" — worse than no
 * affordance at all. Static parent-context text, not a link, until
 * Connections has a real landing surface to go up TO (tracked as a
 * follow-up). Hoisted to module scope: with no `onClick` the node has no
 * per-render dependency, so a fresh element every render would only cost
 * `usePageHeader`'s identity check an extra settle for nothing.
 */
const CONNECTIONS_EYEBROW = (
  <PageEyebrowTrail segments={[{ label: 'Connections' }]} />
);

/** Groups this rail's generated tab/panel ids — see `components/Tabs.tsx`. */
const TABS_ID = 'connections-sections';

export function ConnectionsSectionFrame({
  sectionId,
  children,
}: {
  sectionId: ConnectionSectionId;
  children: ReactNode;
}) {
  return (
    <SplitPaneReturnFocusProvider>
      <ConnectionsSectionFrameInner sectionId={sectionId}>
        {children}
      </ConnectionsSectionFrameInner>
    </SplitPaneReturnFocusProvider>
  );
}

function ConnectionsSectionFrameInner({
  sectionId,
  children,
}: {
  sectionId: ConnectionSectionId;
  children: ReactNode;
}) {
  const section = CONNECTION_SECTIONS.find((entry) => entry.id === sectionId)!;
  const { navigate } = useNavigation();
  const [computerChooserOpen, setComputerChooserOpen] = useState(false);
  const mobileReturnFocus = useSplitPaneExternalReturnFocus();
  // One derivation for both facts this rail renders, shared with the
  // `/connections` resolver (sol review findings 5 and 6).
  const { count, needsAttention } = useConnectionSectionSignals();
  usePageHeader({
    eyebrow: CONNECTIONS_EYEBROW,
    title: section.title,
    subtitle: section.subtitle,
  });
  const add = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (sectionId === 'computers') return setComputerChooserOpen(true);
    if (sectionId === 'models') {
      mobileReturnFocus?.captureExternalReturnFocus(event.currentTarget);
      return navigate('/connections/models/new');
    }
    if (sectionId === 'engines') {
      mobileReturnFocus?.captureExternalReturnFocus(event.currentTarget);
      return navigate('/connections/engines/new');
    }
    if (sectionId === 'tools') {
      mobileReturnFocus?.captureExternalReturnFocus(event.currentTarget);
      return navigate('/connections/tools/new');
    }
    navigate('/settings?view=knowledge');
  };
  return (
    <div className="pane-host connections-section-frame">
      <PageFrameActions>
        {/* station#4463 slice 5 (Button): was a bespoke `button button--primary`
            with no size modifier, rendering at the base 10px/16px scale while
            every other primary page action (Agents/Plugins/Skills/Schedule)
            renders through the shared `Button` at `size="sm"` — the audit's
            "outsized" Models action. Same primitive, same scale now. */}
        <Button variant="primary" size="sm" onClick={add}>
          {section.addLabel}
        </Button>
      </PageFrameActions>
      <Tabs
        id={TABS_ID}
        aria-label="Connection sections"
        // Manual activation (station#4463 slice 2 review HIGH-2): each
        // tab's onSelect pushes a ROUTE (`navigate`), so automatic
        // activation was pushing one history entry per arrow-key press and
        // yanking focus out of the strip. Arrows move focus only here;
        // Enter/Space navigates.
        activation="manual"
        items={CONNECTION_SECTIONS.map((entry) => ({
          key: entry.id,
          label: entry.title,
          count: count(entry.id),
          attention: needsAttention(entry.id),
        }))}
        activeKey={sectionId}
        onSelect={(key) =>
          navigate(CONNECTION_SECTIONS.find((entry) => entry.id === key)!.path)
        }
      />
      <div
        role="tabpanel"
        id={tabPanelElementId(TABS_ID, sectionId)}
        aria-labelledby={tabElementId(TABS_ID, sectionId)}
        className="tab-panel"
      >
        <PageHeaderScope>{children}</PageHeaderScope>
      </div>
      <AddMachineModal
        isOpen={computerChooserOpen}
        onClose={() => setComputerChooserOpen(false)}
      />
    </div>
  );
}

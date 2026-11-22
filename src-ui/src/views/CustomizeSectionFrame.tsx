import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { PageCreateAction } from '../components/PageCreateAction';
import {
  PageEyebrowTrail,
  PageHeaderScope,
  usePageHeader,
} from '../components/page-frame';
import {
  SplitPaneReturnFocusProvider,
  useSplitPaneExternalReturnFocus,
} from '../components/split-pane-return-focus-context';
import { useNavigation } from '../contexts/NavigationContext';
import {
  CONNECTION_SECTIONS,
  type ConnectionSectionId,
} from './connections-hub/connection-sections';
import { IntegrationStatusSection } from './connections-hub/IntegrationStatusSection';

/**
 * The frame for a Customize item that hosts one of today's connection
 * screens: its header, its add action and the screen. The Customize page's
 * left list is the way between items, so there is no section rail here. The
 * eyebrow links back to Customize, which on a phone is the only way back to
 * the list.
 */
export function CustomizeSectionFrame({
  sectionId,
  children,
  creating = false,
}: {
  sectionId: ConnectionSectionId;
  children: ReactNode;
  creating?: boolean;
}) {
  return (
    <SplitPaneReturnFocusProvider>
      <CustomizeSectionFrameInner sectionId={sectionId} creating={creating}>
        {children}
      </CustomizeSectionFrameInner>
    </SplitPaneReturnFocusProvider>
  );
}

function CustomizeSectionFrameInner({
  sectionId,
  children,
  creating = false,
}: {
  sectionId: ConnectionSectionId;
  children: ReactNode;
  creating?: boolean;
}) {
  const section = CONNECTION_SECTIONS.find((entry) => entry.id === sectionId)!;
  const { navigate } = useNavigation();
  const mobileReturnFocus = useSplitPaneExternalReturnFocus();
  const eyebrow = useMemo(
    () => (
      <PageEyebrowTrail
        segments={[
          { label: 'Customize', onClick: () => navigate('/customize') },
          ...(creating
            ? [{ label: section.title, onClick: () => navigate(section.path) }]
            : []),
        ]}
      />
    ),
    [navigate, creating, section.title, section.path],
  );
  usePageHeader({
    eyebrow,
    title: creating ? 'Add engine' : section.title,
    subtitle: creating ? undefined : section.subtitle,
  });
  const add = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (sectionId === 'knowledge') return navigate('/settings?view=knowledge');
    mobileReturnFocus?.captureExternalReturnFocus(event.currentTarget);
    navigate(`${section.path}/new`);
  };
  if (creating)
    return (
      <div className="customize-section-frame">
        <PageHeaderScope>{children}</PageHeaderScope>
      </div>
    );
  return (
    <div className="pane-host customize-section-frame">
      {/* The same shared primary scale as every other page action on
          desktop; on a phone it floats instead of taking a row. */}
      <PageCreateAction label={section.addLabel} onClick={add} />
      <IntegrationStatusSection />
      <PageHeaderScope>{children}</PageHeaderScope>
    </div>
  );
}

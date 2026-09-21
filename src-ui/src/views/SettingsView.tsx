import './SettingsView.css';
import {
  PROJECT_OVERRIDABLE_APP_SETTING_KEYS,
  type ProjectOverridableAppSettingKey,
} from '@kontourai/station-contracts/project-settings-overrides';
import {
  authenticatedFetch,
  isPluginVisibilityForbidden,
  StationReadOnlyError,
  useConfigProvenanceQuery,
  useInvalidateQuery,
  usePluginVisibilityQuery,
  useProjectQuery,
  useProjectsQuery,
  useUpdateProjectMutation,
} from '@kontourai/station-sdk';
import { updateAppLogLevel } from '@kontourai/station-sdk/app-config';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  APP_DESTINATION_REGISTRY,
  type SettingsNavEntry,
  type SettingsNavGroupId,
} from '../app-shell/destination-registry';
import { Button } from '../components/Button';
import { ThemeToggle } from '../components/header/ThemeToggle';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import { PageRow } from '../components/PageRow';
import { SectionNav, type SectionNavItem } from '../components/SectionNav';
import { ExistingSetupImportStepper } from '../components/setup/ExistingSetupImportStepper';
import {
  describeReadFailure,
  ErrorState,
  Skeleton,
  SkeletonBlock,
} from '../components/state';
import { Toggle } from '../components/Toggle';
import {
  UsageTelemetryDisclosure,
  usageTelemetryDestinationSummary,
  useUsageTelemetryDisclosureState,
} from '../components/UsageTelemetryDisclosure';
import { useApiBase } from '../contexts/ApiBaseContext';
import { useConfigActions, useConfigSnapshot } from '../contexts/ConfigContext';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../contexts/DeviceSettingsContext';
import { useNavigationActions } from '../contexts/NavigationContext';
import { useCloseShortcut } from '../hooks/useCloseShortcut';
import { useSectionNavigation } from '../hooks/useSectionNavigation';
import { useSurfaceVisibilityFlags } from '../hooks/useSurfaceVisibilityFlags';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { useLocale } from '../i18n/LocaleContext';
import { DeviceSettingsImportVersionError } from '../lib/device-settings-store';
import { usePlatformProfile } from '../platform/PlatformProfileContext';
import type { AppConfig, NavigationView } from '../types';
import {
  ANSWER_DELIVERY_OPTIONS,
  type AnswerDeliveryMode,
  answerDeliveryModeOf,
  settingsForAnswerDelivery,
} from '../utils/answerDelivery';
import { AccentColorPicker } from './settings/AccentColorPicker';
import { AgentDefaultsSection } from './settings/AgentDefaultsSection';
import { AnswerSharesSection } from './settings/AnswerSharesSection';
import { downloadDiagnosticsBundle } from './settings/diagnostics-download';
import { EnvironmentStatus } from './settings/EnvironmentStatus';
import { FeaturePreviewsSection } from './settings/FeaturePreviewsSection';
import { KeyboardShortcutsSection } from './settings/KeyboardShortcutsSection';
import { KnowledgeStoreSection } from './settings/KnowledgeStoreSection';
import { LocalAccountsSection } from './settings/LocalAccountsSection';
import { PairingSection } from './settings/PairingSection';
import { PluginVisibilitySection } from './settings/PluginVisibilitySection';
import {
  buildProjectOverrideUpdate,
  effectiveOverrideValue,
  type ProjectOverrideDraft,
  pendingOverrideChanges,
  projectOverrideDelta,
  savedOverridesFor,
} from './settings/project-override-draft';
import { SettingsSection as Section } from './settings/SettingsSection';
import { StationConfigSection } from './settings/StationConfigSection';
import { SystemSection } from './settings/SystemSection';
import {
  formatSettingsMessage,
  localizedSettingsTargetLabel,
  matchingSettingsRows,
  OPERATOR_ONLY_SECTION_IDS,
  SETTINGS_CATALOG,
  SETTINGS_SECTIONS,
  type SettingsNavGroup,
  settingsRow,
} from './settings/settings-catalog';
import { buildStationResetPlan } from './settings/station-reset';
import {
  buildSettingsExportPayload,
  getSettingsValidation,
  parseImportedSettingsFile,
} from './settings/utils';
import {
  NotificationsSection,
  VoiceFeaturesSection,
} from './settings/VoiceFeaturesSection';

/**
 * archive#settings-revamp: three registry-driven scope sections
 * (docs/design/settings-architecture.md §5) replace the single flat nav —
 * Station, Defaults, This device. Leaf section DOM ids are
 * unchanged from pre-slice-3 (`useSectionNavigation` deep links and
 * existing tests key off them); only the top-level nav/page grouping
 * restructures. #2182 then dissolved `station-config` — the card those
 * hidden Station fields landed in — into the sections named for what each
 * row decides; `StationConfigSection.tsx` is now the shared renderer for
 * those registry-driven rows rather than a section of its own. "My knowledge
 * store" (archive#settings-revamp: renamed from "Knowledge Store" to
 * disambiguate from the project-scoped and infrastructure-scoped Knowledge
 * surfaces, docs/design/settings-architecture.md §3) stays its own
 * top-level card outside every scope group.
 */
// The nav strip lists sections in `SETTINGS_SECTIONS` order (archive#1826
// ordered that list by what a person came here to do: the sections with
// controls first — System, Shared answers — then the read-mostly surfaces,
// the Station host report and the Diagnostics bundle), and the page body
// below must mount them in the SAME order. That is two statements, not one:
// the nav derives its order from the catalog, but the body's order is the
// sequence of JSX blocks in this file, written by hand. Nothing forces them
// to agree — #2182 briefly mounted its two new cards at the top of This
// Station while the nav listed them near the bottom — so
// `settings-catalog-completeness.test.tsx` holds them together, comparing the
// rendered anchors against what `settingsSectionNavItems` actually lists.
const ALL_LEAF_SECTION_IDS = SETTINGS_SECTIONS.map(({ id }) => id);
const ALL_SETTINGS_VIEWS = ['overview', ...ALL_LEAF_SECTION_IDS];

/**
 * How long a Settings save may stay in flight before the UI stops waiting.
 *
 * The browser SDK deliberately configures no default request deadline
 * (`packages/sdk/src/client/http.ts`) — only the CLI sets one — so a request
 * that never settles would otherwise leave `Save` disabled until reload. The
 * deadline does not cancel the write (it may still land); it releases the UI
 * and keeps the drafts so the user can retry.
 */
export const SETTINGS_SAVE_DEADLINE_MS = 30_000;

/**
 * How long the save path waits for the saved project's record to be re-read
 * before clearing the override draft anyway.
 *
 * The write has already landed when this runs, so the wait only decides what
 * the row shows next. It is its own, much shorter deadline rather than a
 * second use of the save deadline above, and it must have one at all because
 * it runs AFTER the save deadline's race has been decided — a refetch that
 * never settles would otherwise leave `Save` spinning with nothing left to
 * wait for.
 *
 * What the timeout costs, stated honestly: when the refetch is merely SLOW
 * the draft clears against a record this page has not re-read, and the
 * stale value shows until it lands. A FAILED refetch does not go through the
 * timeout at all — `invalidateQueries` resolves once its refetches settle,
 * errors included — but it leaves the same picture: the row goes on showing
 * the pre-save value with no pill and no error, and this page will not say
 * the save happened until something else refetches the project. That is
 * still the better outcome against a Save button that never releases, but
 * it is a real gap, not a flicker.
 */
const SETTINGS_OVERRIDE_REFETCH_DEADLINE_MS = 3_000;

export interface SettingsViewProps {
  onBack: () => void;
  onSaved?: () => void;
  onNavigate?: (view: NavigationView) => void;
}

export function SettingsView({ onBack, onSaved }: SettingsViewProps) {
  const { apiBase: currentApiBase } = useApiBase();
  const {
    config: configData,
    error: configError,
    retry: retryConfigRead,
    dataUpdatedAt: configUpdatedAt,
  } = useConfigSnapshot();
  const { updateConfig, isSaving } = useConfigActions();
  const invalidate = useInvalidateQuery();
  // #2144 slice 3. The project the page is showing settings FOR. It lives
  // OUTSIDE the Station draft on purpose: a project override is a different
  // document with a different write path, and folding it into `config` would
  // make one Save request carry two authorities' values.
  const [selectedProjectSlug, setSelectedProjectSlug] = useState<string | null>(
    null,
  );
  const [overrideDraft, setOverrideDraft] = useState<ProjectOverrideDraft>({});
  const { data: projects } = useProjectsQuery();
  const projectList: { slug: string; name?: string }[] = Array.isArray(projects)
    ? projects
    : [];
  const { data: selectedProject } = useProjectQuery(selectedProjectSlug ?? '', {
    enabled: Boolean(selectedProjectSlug),
  });
  const savedOverrides = savedOverridesFor(
    selectedProjectSlug ? selectedProject : undefined,
  );
  const updateProject = useUpdateProjectMutation();
  // Asking the SAME route for more provenance, not for different values: the
  // response body stays this Station's config and only the attribution gains
  // the project's scope (`GET /config/app?project=<slug>`, slice 2).
  const { data: provenance } = useConfigProvenanceQuery(
    selectedProjectSlug ?? undefined,
  );
  // The SAME route read WITHOUT a project, for the Station reset plan only.
  //
  // A scoped read replaces an overridden key's entry with the project's
  // (`{ source: 'file', scope: 'project' }`), which `buildStationResetPlan`
  // reads as an ordinary stored Station value. With a project selected that
  // made the dialog offer to clear a Station setting nobody had stored and
  // send `null` for it to the STATION document — a write against the wrong
  // authority, decided by which project happened to be selected. Reset is a
  // Station action and must read Station provenance, so it gets its own
  // query; React Query keys them apart (`['config','provenance', null]` vs
  // the slug) and dedupes the unscoped one with every other unscoped caller.
  const { data: stationProvenance } = useConfigProvenanceQuery();
  const {
    chatFontSize,
    featureSettings,
    hapticsEnabled,
    developerToolsEnabled,
    sidebarSections,
    confirmConversationDelete,
    // #2144 decision 2: these five had a device-settings contract row and no
    // Settings row, so the in-chat gear was the only place to change them.
    chatShowReasoning,
    chatShowToolDetails,
    chatDockAutoHide,
    diffStyle,
    diffWrap,
  } = useDeviceSettings();
  const { setDeviceSetting, resetDeviceSetting } = useDeviceSettingsActions();
  const { isMobile, isDesktop } = usePlatformProfile();
  // #2144 slice 6 item D. The same query the disclosure card reads; React
  // Query dedupes on its key so there is one request, not two answers.
  const telemetryDisclosure = useUsageTelemetryDisclosureState();
  const { locale } = useLocale();

  const [config, setConfig] = useState<AppConfig>(
    (configData as AppConfig) || {},
  );
  const [savedConfig, setSavedConfig] = useState<AppConfig>(
    (configData as AppConfig) || {},
  );
  const [isSplitSaving, setIsSplitSaving] = useState(false);
  const saveInFlightRef = useRef(false);
  // When each key was last written from this form, so a server snapshot can be
  // compared against our own writes key by key rather than wholesale.
  const savedAtRef = useRef<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const diagnosticsBundle = useMutation({
    mutationFn: async () => {
      const response = await authenticatedFetch(
        `${currentApiBase}/api/diagnostics/bundle`,
      );
      if (!response.ok) {
        throw new Error('The diagnostics bundle could not be generated.');
      }
      return response.blob();
    },
    onSuccess: downloadDiagnosticsBundle,
  });
  const [showResetModal, setShowResetModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightAnnouncement, setHighlightAnnouncement] = useState('');
  const { activeSection, hrefForSection, navigateToSection } =
    useSectionNavigation(ALL_SETTINGS_VIEWS, 'overview', {
      queryKey: 'view',
      legacyQueryKey: 'section',
      clearHighlightOnNavigate: true,
    });
  const configJson = JSON.stringify(config);
  const baselineJson = JSON.stringify(savedConfig);
  const hasChanges = configJson !== baselineJson;
  const overrideDelta = projectOverrideDelta(overrideDraft, savedOverrides);
  const overrideDirty = Object.keys(overrideDelta).length > 0;
  // ONE guard over both drafts. Two guards would ask twice for a single
  // navigation and let either one discard while the other still holds an
  // unsaved edit.
  const { guard, DiscardModal } = useUnsavedGuard(hasChanges || overrideDirty);
  const selectProject = (slug: string | null) => {
    guard(() => {
      setConfig(savedConfig);
      setOverrideDraft({});
      setSelectedProjectSlug(slug);
    });
  };
  const projectOverride = selectedProjectSlug
    ? {
        name:
          projectList.find((entry) => entry.slug === selectedProjectSlug)
            ?.name ?? selectedProjectSlug,
        values: Object.fromEntries(
          PROJECT_OVERRIDABLE_APP_SETTING_KEYS.map((key) => [
            key,
            effectiveOverrideValue(key, overrideDraft, savedOverrides),
          ]),
        ),
        // The set the SAVE will change, which is neither the raw draft nor
        // the delta: a draft entry equal to the stored value is not a change
        // at all, and the delta is too NARROW because the model pair is
        // written whole — resetting one half drops the other. Both rules live
        // in `pendingOverrideChanges`, which reads the request body itself.
        pending: pendingOverrideChanges(overrideDraft, savedOverrides),
        onChange: (key: ProjectOverridableAppSettingKey, value: unknown) =>
          setOverrideDraft((current) => ({ ...current, [key]: value })),
        // `null`, not a delete: the route reads `null` as "drop this
        // override", and removing the key from the draft would only mean
        // "never touched", which saves nothing.
        onReset: (key: ProjectOverridableAppSettingKey) =>
          setOverrideDraft((current) => ({ ...current, [key]: null })),
      }
    : undefined;
  const highlightNotice = highlightAnnouncement ? (
    <div
      className="settings__highlight-notice"
      role="status"
      aria-atomic="true"
    >
      {highlightAnnouncement}
    </div>
  ) : null;
  const showRegion = true;
  // #2067: the operator fact, from the query the plugin-visibility section
  // already makes. React Query dedupes it, so this is the SAME request rather
  // than a second one — and it is what stops the Settings search offering a
  // collaborator a jump to a section the server will refuse to populate.
  // `isOperator` false until the directory resolves is the fail-closed
  // direction, and matches the section, which renders nothing until then.
  const pluginVisibilityDirectory = usePluginVisibilityQuery();
  const isOperator = pluginVisibilityDirectory.data !== undefined;
  // What the PAGE may select is not the same question as `isOperator`: it
  // mirrors what `PluginVisibilitySection` itself renders. The section draws
  // nothing while pending and nothing on the server's refusal, but on any
  // OTHER failure it draws its own error with a Retry — the only way an
  // operator whose one request failed (the query does not retry) gets back.
  // Gating on `data` alone filtered that operator out into a blank body with
  // no error and no Retry (#2182 delta review). So a settled non-forbidden
  // error still selects the section; a refusal and the pending interval do
  // not.
  const operatorSectionsSelectable =
    isOperator ||
    (pluginVisibilityDirectory.isError &&
      !isPluginVisibilityForbidden(pluginVisibilityDirectory.error));
  // Keyed on the CONDITIONAL, not on one section id: a second
  // operator-conditional section would otherwise leak the day somebody adds
  // it.
  const operatorMayView = (section: string) =>
    operatorSectionsSelectable || !OPERATOR_ONLY_SECTION_IDS.has(section);
  const visibleSections = new Set(
    searchQuery.trim()
      ? matchingSettingsRows(searchQuery, { isOperator }).map(
          (entry) => entry.section,
        )
      : activeSection === 'overview'
        ? ALL_LEAF_SECTION_IDS.filter(operatorMayView)
        : // #2182 review M-b: the SAME gate on the direct-view path. It used
          // to select `[activeSection]` unconditionally, so a non-operator on
          // `?view=plugin-visibility` had the section "selected" while
          // `PluginVisibilitySection` rendered nothing for them — and the
          // This Station caption printed over the empty box. With the gate the
          // view selects nothing: the body is empty, which is what the
          // section's own refusal already rendered, and no caption claims a
          // box that is not there.
          //
          // Operator status is not known synchronously: nothing is selectable
          // until the directory query settles. For an OPERATOR landing here
          // that interval now renders no section and no caption, then the
          // section once the answer arrives (or its error, with Retry). It rendered no section before this fix
          // either (the section returns null while pending), so the only
          // change in the interval is that the caption no longer precedes
          // content that may never come. Fail-closed, and no content flashes.
          [activeSection].filter(operatorMayView),
  );
  const sectionVisible = (section: string) =>
    visibleSections.has(section as never);
  /**
   * Whether a scope group has anything to show (#2182, review L7).
   *
   * Each `.settings__scope-group` opens with the storage rule its sections
   * are saved under. Three of the four rendered that caption unconditionally,
   * so a `?view=` naming one section — or a search matching rows in one
   * group — printed "Saved to this Station", "Saved to this Station — what
   * agents may do…" and "Saved to this device only" over nothing at all: a
   * promise about a box with no contents, twice over.
   *
   * Derived from the catalog rather than listed, so a new section joins its
   * group's visibility the day it is added. It can be a plain `some` over
   * `sectionVisible` because that set already carries the search filter, the
   * active `?view=`, and the operator gate on all three paths (search,
   * overview, direct view — the last since review M-b).
   *
   * What it does NOT know is whether a selected section will render anything.
   * It counts SELECTION, not content: a selected section whose component
   * returns null (for instance while its own data loads) still makes its
   * group visible, so the caption can precede it for that interval. That
   * transient is accepted; this function claims only what it computes.
   */
  const groupVisible = (group: SettingsNavGroup) =>
    SETTINGS_SECTIONS.some(
      (section) => section.group === group && sectionVisible(section.id),
    );

  const [highlightRequest, setHighlightRequest] = useState(() => ({
    id: new URLSearchParams(window.location.search).get('highlight'),
    nonce: 0,
  }));

  // NavigationStore dispatches popstate for both browser navigation and an
  // in-app same-route query navigation. Keep a separate request state so a
  // second palette selection for the same mounted Settings view is still a
  // new reveal, rather than an ignored equal active-section state update.
  useEffect(() => {
    const syncHighlight = () =>
      setHighlightRequest((previous) => ({
        id: new URLSearchParams(window.location.search).get('highlight'),
        nonce: previous.nonce + 1,
      }));
    window.addEventListener('popstate', syncHighlight);
    return () => window.removeEventListener('popstate', syncHighlight);
  }, []);

  useEffect(() => {
    const highlight = highlightRequest.id;
    const entry = SETTINGS_CATALOG.find(
      (candidate) => candidate.id === highlight,
    );
    if (!highlight || !entry) {
      if (highlight) {
        const url = new URL(window.location.href);
        url.searchParams.delete('highlight');
        window.history.replaceState(window.history.state, '', url);
        setHighlightAnnouncement(
          formatSettingsMessage('targetUnavailable', locale),
        );
      }
      return;
    }
    if (entry.conditional === 'mobile' && !isMobile) {
      const url = new URL(window.location.href);
      url.searchParams.delete('highlight');
      window.history.replaceState(window.history.state, '', url);
      setHighlightAnnouncement(
        formatSettingsMessage('unavailableMobile', locale),
      );
      return;
    }
    if (entry.conditional === 'desktop' && !isDesktop) {
      const url = new URL(window.location.href);
      url.searchParams.delete('highlight');
      window.history.replaceState(window.history.state, '', url);
      setHighlightAnnouncement(
        formatSettingsMessage('unavailableDesktop', locale),
      );
      return;
    }
    // A target owns its section. Clear only the local search filter (drafts
    // stay untouched) and heal a mismatched view before waiting for its row.
    setSearchQuery('');
    const requestedView = new URLSearchParams(window.location.search).get(
      'view',
    );
    if (requestedView !== entry.section) {
      const url = new URL(window.location.href);
      url.searchParams.set('view', entry.section);
      window.history.replaceState(window.history.state, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
    let observer: MutationObserver | undefined;
    let timer: number | undefined;
    let pulseTimer: number | undefined;
    let pulsedTarget: HTMLElement | undefined;
    let done = false;
    const focusOwner = document.activeElement;
    const focusTarget = (target: HTMLElement) => {
      // Leaf controls are preferred when they are editable. Buttons are
      // intentionally excluded: a deep link must not choose a destructive or
      // otherwise surprising action merely because it is first in a row.
      const control = [
        ...target.querySelectorAll<HTMLElement>(
          'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"]',
        ),
      ].find(
        (candidate) =>
          !candidate.hidden &&
          candidate.getAttribute('aria-hidden') !== 'true' &&
          !(
            candidate instanceof HTMLInputElement && candidate.type === 'hidden'
          ),
      );
      const destination = control ?? target;
      destination.focus({ preventScroll: true });
      // Browsers may reject a focus target that has become hidden/disabled
      // during the reveal. The labeled catalog row is always the safe fallback.
      if (document.activeElement !== destination) {
        target.focus({ preventScroll: true });
      }
    };
    const reveal = () => {
      const target = document.getElementById(highlight);
      if (!target || done) return false;
      done = true;
      // Several Settings rows still live inside a closed <details> (keyboard
      // shortcuts, update technical detail, host environment). A deep link
      // owns revealing the declared target, not an arbitrary first button
      // inside the section. (Defaults no longer needs this: its fields render
      // directly.)
      target.closest('details')?.setAttribute('open', '');
      target.scrollIntoView?.({
        block: 'center',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
      });
      // Delayed mount must not pull focus away from a person who began typing
      // somewhere else while the target was becoming available. The palette's
      // input is still the owner during its normal close/restore hand-off, so
      // the destination may claim focus in that ordinary case.
      if (
        document.activeElement === focusOwner ||
        document.activeElement === document.body ||
        document.activeElement?.id === `section-${entry.section}`
      ) {
        focusTarget(target);
      }
      setHighlightAnnouncement(
        formatSettingsMessage('revealed', locale, {
          target: localizedSettingsTargetLabel(entry.id, locale),
        }),
      );
      target.classList.add('settings__highlight-pulse');
      pulsedTarget = target;
      pulseTimer = window.setTimeout(
        () => target.classList.remove('settings__highlight-pulse'),
        1400,
      );
      const url = new URL(window.location.href);
      url.searchParams.delete('highlight');
      window.history.replaceState(window.history.state, '', url);
      observer?.disconnect();
      if (timer !== undefined) window.clearTimeout(timer);
      return true;
    };
    const frame = window.requestAnimationFrame(() => {
      if (reveal()) return;
      observer = new MutationObserver(() => reveal());
      observer.observe(document.body, { childList: true, subtree: true });
      timer = window.setTimeout(() => {
        observer?.disconnect();
        if (done) return;
        done = true;
        const url = new URL(window.location.href);
        url.searchParams.delete('highlight');
        window.history.replaceState(window.history.state, '', url);
        setHighlightAnnouncement(
          formatSettingsMessage('targetTimedOut', locale),
        );
      }, 5_000);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      if (timer !== undefined) window.clearTimeout(timer);
      if (pulseTimer !== undefined) window.clearTimeout(pulseTimer);
      pulsedTarget?.classList.remove('settings__highlight-pulse');
    };
  }, [highlightRequest, isMobile, isDesktop, locale]);

  // Reconciling the server snapshot with the form is a question about *time*,
  // not about values: a just-invalidated query can still hold the pre-save
  // payload, and a value comparison cannot tell that apart from the server
  // genuinely changing away and back. React Query's `dataUpdatedAt` is the
  // fetch generation — it advances on every successful fetch even when the
  // payload is identical — so it answers both.
  //
  // A snapshot is adopted only while the form is clean; one that arrives while
  // the user has unsaved drafts is *remembered*, not consumed, and adopted the
  // moment the form becomes clean. Keys this form wrote after that snapshot was
  // fetched keep the local value (the snapshot predates the write); every other
  // key takes server truth, so an external edit is never hidden.
  const adoptedUpdatedAtRef = useRef(configUpdatedAt);
  const unadoptedSnapshotRef = useRef<{
    config: AppConfig;
    updatedAt: number;
  } | null>(null);
  useEffect(() => {
    if (configData && configUpdatedAt > adoptedUpdatedAtRef.current) {
      unadoptedSnapshotRef.current = {
        config: configData as AppConfig,
        updatedAt: configUpdatedAt,
      };
    }
    const snapshot = unadoptedSnapshotRef.current;
    if (!snapshot) return;
    if (configJson !== baselineJson) return;

    const localWrites: Record<string, unknown> = {};
    for (const [key, writtenAt] of Object.entries(savedAtRef.current)) {
      if (writtenAt > snapshot.updatedAt) {
        localWrites[key] = (savedConfig as Record<string, unknown>)[key];
      } else {
        delete savedAtRef.current[key];
      }
    }
    const merged = { ...snapshot.config, ...localWrites } as AppConfig;

    adoptedUpdatedAtRef.current = snapshot.updatedAt;
    unadoptedSnapshotRef.current = null;
    setConfig(merged);
    setSavedConfig(merged);
  }, [baselineJson, configData, configJson, configUpdatedAt, savedConfig]);

  useCloseShortcut(onBack);

  const {
    errors: validationErrors,
    warnings: validationWarnings,
    isValid,
  } = getSettingsValidation(config);

  const exportSettings = () => {
    const payload = buildSettingsExportPayload(config);
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'station-settings.json';
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const importSettings = async (file: File) => {
    try {
      const { serverConfig, droppedDeviceKeys } =
        await parseImportedSettingsFile(file);
      setConfig({ ...config, ...serverConfig });
      // archive#settings-revamp: an invalid device
      // value is dropped (not silently merged, not a hard failure) — surface
      // that it happened rather than absorbing it without a trace.
      setError(
        droppedDeviceKeys.length > 0
          ? `Imported, but ${droppedDeviceKeys.length} device setting${droppedDeviceKeys.length === 1 ? '' : 's'} had an invalid value and kept its current value instead.`
          : null,
      );
    } catch (err) {
      setError(
        err instanceof DeviceSettingsImportVersionError
          ? err.message
          : 'Invalid settings file',
      );
    }
  };

  const saveConfig = async () => {
    if (!isValid || saveInFlightRef.current) return;
    const changed = Object.fromEntries(
      Object.keys({ ...savedConfig, ...config })
        .filter(
          (key) =>
            (savedConfig as Record<string, unknown>)[key] !==
            (config as Record<string, unknown>)[key],
        )
        .map((key) => [key, (config as Record<string, unknown>)[key]]),
    ) as Partial<AppConfig>;
    const { logLevel, ...plainChanges } = changed;
    const plainWrite =
      Object.keys(plainChanges).length > 0
        ? updateConfig(plainChanges)
        : undefined;
    const logLevelWrite =
      logLevel !== undefined
        ? updateAppLogLevel(currentApiBase, logLevel)
        : undefined;
    // #2144 slice 3: the project's own document, written by its own route.
    // A third independent write rather than a third key in the config PUT —
    // `PUT /api/projects/:slug` is what accepts `null` as "drop this
    // override", and the Station config route has no way to express that.
    // `selectedProject !== undefined` is a real precondition, not a
    // convenience: `savedOverrides` is derived from that record, so an
    // in-flight or failed read presents as "this project overrides nothing"
    // — and `buildProjectOverrideUpdate` would then see a half-pair and null
    // BOTH model fields on a project that had set them.
    // Pinned once: the whole settle path below refers to the project this
    // save was for, not to whatever the selector holds by the time it lands.
    const overrideSlug =
      selectedProjectSlug && overrideDirty && selectedProject !== undefined
        ? selectedProjectSlug
        : undefined;
    const overrideWrite = overrideSlug
      ? updateProject.mutateAsync({
          slug: overrideSlug,
          ...buildProjectOverrideUpdate(overrideDelta, savedOverrides),
        })
      : undefined;
    if (!plainWrite && !logLevelWrite && !overrideWrite) return;

    saveInFlightRef.current = true;
    setIsSplitSaving(true);
    setError(null);
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = await Promise.race([
        Promise.allSettled([
          plainWrite ?? Promise.resolve(),
          logLevelWrite ?? Promise.resolve(),
          overrideWrite ?? Promise.resolve(),
        ]),
        new Promise<'deadline'>((resolve) => {
          deadlineTimer = setTimeout(
            () => resolve('deadline'),
            SETTINGS_SAVE_DEADLINE_MS,
          );
        }),
      ]);
      if (settled === 'deadline') {
        setError(
          'Save timed out — Station did not answer. Your changes are kept here until you retry; they may not be saved.',
        );
        return;
      }
      const [plainOutcome, logLevelOutcome, overrideOutcome] = settled;
      const plainFailed =
        plainWrite !== undefined && plainOutcome.status === 'rejected';
      const logLevelFailed =
        logLevelWrite !== undefined && logLevelOutcome.status === 'rejected';
      const hasSaved =
        (plainWrite !== undefined && plainOutcome.status === 'fulfilled') ||
        (logLevelWrite !== undefined && logLevelOutcome.status === 'fulfilled');
      if (hasSaved) {
        const written = {
          ...(plainWrite !== undefined && plainOutcome.status === 'fulfilled'
            ? plainChanges
            : {}),
          ...(logLevelWrite &&
          logLevelOutcome.status === 'fulfilled' &&
          logLevelOutcome.value
            ? { logLevel: logLevelOutcome.value.value }
            : {}),
        };
        // Stamp each written key so a server snapshot fetched *before* this
        // write cannot silently roll it back, while one fetched after it still
        // wins — see the reconciliation effect above.
        const writtenAt = Date.now();
        for (const key of Object.keys(written)) {
          savedAtRef.current[key] = writtenAt;
        }
        setSavedConfig((current) => ({ ...current, ...written }));
        invalidate(['config']);
        onSaved?.();
      }
      // The project write settles on its own: it is a different document on a
      // different route, so it succeeding or failing says nothing about the
      // Station config write and must not silence or absorb its message.
      // Keyed on `overrideSlug`, which is defined exactly when
      // `overrideWrite` is — and unlike it, still carries the project's name.
      if (overrideSlug && overrideOutcome.status === 'fulfilled') {
        // Await the project record's refetch BEFORE clearing the draft: the
        // row falls back to `savedOverrides` the instant the draft goes, and
        // that read is stale until this settles, so clearing first shows the
        // pre-save value back at the person who just changed it. Bounded —
        // see `SETTINGS_OVERRIDE_REFETCH_DEADLINE_MS` for what expiry costs.
        let refetchTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            invalidate(['projects', overrideSlug]),
            new Promise<void>((resolve) => {
              refetchTimer = setTimeout(
                resolve,
                SETTINGS_OVERRIDE_REFETCH_DEADLINE_MS,
              );
            }),
          ]);
        } finally {
          if (refetchTimer !== undefined) clearTimeout(refetchTimer);
        }
        setOverrideDraft({});
        // The provenance the page renders is computed from the project record
        // that just changed, so the badges are stale until it is re-read.
        invalidate(['config']);
      }
      const overrideFailed =
        overrideWrite !== undefined && overrideOutcome.status === 'rejected';
      const stationMessage =
        plainFailed && logLevelFailed
          ? 'Log Level and other settings could not be saved. Your changes are kept here until you retry.'
          : logLevelFailed
            ? plainOutcome.status === 'fulfilled'
              ? 'Log Level could not be saved. Other settings were saved; your Log Level change is kept here until you retry.'
              : 'Log Level could not be saved. Your change is kept here until you retry.'
            : plainFailed
              ? plainOutcome.reason instanceof StationReadOnlyError
                ? 'Save failed — Station is unreachable. Your changes are kept here until you retry; they are not saved yet.'
                : 'Some settings could not be saved. Your changes are kept here until you retry.'
              : null;
      const messages = [
        stationMessage,
        overrideFailed
          ? "This project's overrides could not be saved. Your changes to them are kept here until you retry."
          : null,
      ].filter((message): message is string => message !== null);
      if (messages.length > 0) setError(messages.join(' '));
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      saveInFlightRef.current = false;
      setIsSplitSaving(false);
    }
  };

  // What a reset would actually do, recomputed from the provenance the page
  // already holds: only a `source: 'file'` key is stored, and only a stored
  // key changes when it is cleared. The dialog names these, and an empty plan
  // is a disabled confirm rather than a request that silently does nothing.
  const resetPlan = buildStationResetPlan(stationProvenance);

  const resetToDefaults = async () => {
    setShowResetModal(false);
    if (resetPlan.keys.length === 0) return;
    try {
      setError(null);
      const result = await updateConfig(resetPlan.delta);
      const ignoredKeys = result?.ignoredKeys ?? [];
      // A key the server declined comes back on a 2xx. Absorbing it here is
      // exactly the failure this whole item exists to remove.
      setError(
        ignoredKeys.length > 0
          ? `Station did not clear ${ignoredKeys
              .map((entry) => entry.key)
              .join(', ')}. Every other setting listed was reset.`
          : null,
      );
      invalidate(['config']);
      onSaved?.();
    } catch (err: any) {
      // `updateAppConfig` throws the route's joined violation messages, so a
      // refusal names the keys instead of disappearing.
      setError(err.message);
    }
  };

  if (!configData) {
    return (
      // The page header is the frame's (SHELL-11) and is already on screen
      // above this body; the section nav and C2's error-is-not-loading fork
      // stay exactly as they are.
      <div className="settings">
        {highlightNotice}
        {/* #2059: the section nav renders in BOTH the loaded and the
            not-yet-loaded branch, because nothing it draws comes from the
            config read. Its rows are derived from the destination registry,
            the device flags and `SETTINGS_SECTIONS`, so it is complete before
            `/api/config/app` answers — and a failed or slow read must not be
            able to strand this page's own way back to Agents, Skills, Engines
            & Models, Plugins, Schedule or Developer. (The command palette
            reaches each of them too; `destination-registry.test.ts` pins
            that. This is about not stranding a reader who is already here.)
            */}
        {/* The same rail frame the loaded branch renders (#2144 slice 7), so
            a slow or failed config read does not first draw the navigation in
            one place and then move it. */}
        <div className="section-nav-rail">
          <SettingsSectionNav
            activeSection={activeSection}
            hrefForSection={hrefForSection}
            navigateToSection={navigateToSection}
          />
          <div className="section-nav-rail__body">
            {/*
          Review M2: this branch used to be the skeleton alone, and
          `useConfigSnapshot` discarded the query error — so a failed initial
          config read left Settings drawing "still loading" forever. Error is
          not loading. The header and section nav above stay put either way
          (6-OPS-23): the frame a page owns is known before its data is.
*/}
            {configError ? (
              <ErrorState
                title="Unable to load settings"
                description={describeReadFailure(configError)}
                action={
                  <Button size="sm" onClick={retryConfigRead}>
                    Retry
                  </Button>
                }
              />
            ) : (
              <SkeletonBlock
                count={3}
                className="settings__skeleton"
                label="Loading settings"
              />
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="settings">
        {highlightNotice}
        {/* archive#1826: the three-card "This device / Station / Defaults"
            legend is gone. It restated the taxonomy the grouped nav below
            already shows, in implementation vocabulary, and treated
            "Defaults" (a precedence rule) as a peer of two storage
            locations. Each scope group's caption states the persistence
            fact where it applies instead. */}
        {error && (
          <div className="settings__error-banner">
            <span className="settings__error-banner-msg">{error}</span>
            <button
              type="button"
              className="settings__error-banner-retry"
              onClick={saveConfig}
            >
              Retry
            </button>
          </div>
        )}

        {/* ── Section Nav ── */}
        <input
          type="text"
          className="settings__search"
          placeholder="Filter settings…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="Filter settings"
        />
        <div className="section-nav-rail">
          <SettingsSectionNav
            activeSection={activeSection}
            hrefForSection={hrefForSection}
            navigateToSection={navigateToSection}
          />
          <div className="section-nav-rail__body">
            {/* #2144 slice 3: which document the page is showing values for.
            Outside every scope group because it re-attributes rows in more
            than one of them, and the sentence beside it names exactly what a
            project may override — the selector governs attribution for the
            whole page, but only these settings are a project's to change. */}
            <div className="settings__project-scope">
              <label
                className="settings__project-scope-label"
                htmlFor="settings-project-scope"
              >
                Show settings for:
              </label>
              <select
                id="settings-project-scope"
                className="editor-select"
                value={selectedProjectSlug ?? ''}
                onChange={(event) => selectProject(event.target.value || null)}
              >
                <option value="">Station only</option>
                {projectList.map((project) => (
                  <option key={project.slug} value={project.slug}>
                    {project.name ?? project.slug}
                  </option>
                ))}
              </select>
              <span className="settings__field-hint">
                A project can override its new-chat workspace and its default
                model connection and model. Every other setting on this page
                belongs to the Station.
              </span>
            </div>

            {/* ── Station scope ── */}
            {groupVisible('this-station') && (
              <section
                aria-label="This Station settings"
                className="settings__scope-group"
              >
                <p className="settings__scope-caption">
                  Saved to this Station — every client sees the same values.
                </p>

                {sectionVisible('system') && (
                  <>
                    <SystemSection
                      apiBase={currentApiBase}
                      config={config}
                      onChange={setConfig}
                      onExport={exportSettings}
                      onImport={importSettings}
                      onResetToDefaults={() => setShowResetModal(true)}
                      hasUnsavedChanges={hasChanges}
                    />
                    <ExistingSetupImportStepper />
                    {/* #2182: who may sign in to this Station. It has no
                  catalog row of its own (giving it one is out of scope —
                  see the epic), so it had to be placed by hand when the card
                  it used to sit in was dissolved. System is where this page
                  already keeps Station administration: updates, log level,
                  export and import, and the two resets. */}
                    <LocalAccountsSection />
                  </>
                )}

                {/* archive#3313: previews persist on the Station (PUT
              /api/feature-previews/:id), so the section lives in this scope. */}
                {sectionVisible('feature-previews') && (
                  <FeaturePreviewsSection />
                )}

                {/* archive#1423: answer permalinks the operator has minted. Station
              scope because the shares live on this Station and every client
              of it sees the same list. */}
                {sectionVisible('answer-shares') && <AnswerSharesSection />}

                {/* #2067: per-principal plugin visibility. Station scope — the
              grants live on this Station — and the section renders nothing
              for a caller the route refuses as a non-operator. */}
                {sectionVisible('plugin-visibility') && (
                  <PluginVisibilitySection />
                )}
                {sectionVisible('host-runtime') && (
                  <EnvironmentStatus apiBase={currentApiBase}>
                    {/* #2182: three settings whose subject is the machine,
                  inside the card that reports on it. Embedded rather than a
                  second card, because `section-host-runtime` is one anchor
                  and one heading. */}
                    <StationConfigSection
                      section="host-runtime"
                      embedded
                      config={config}
                      provenance={provenance}
                      onChange={setConfig}
                      containerScope="station"
                      projectOverride={projectOverride}
                    />
                  </EnvironmentStatus>
                )}

                {/* #2182: two of the cards the dissolved "Station
              configuration" section's rows moved to. Their position here is
              `SETTINGS_SECTIONS`' — the nav strip and the page body must
              scroll in the same order, which `settings-catalog-completeness`
              now asserts from the catalog rather than from a list. */}
                {sectionVisible('sources') && (
                  <StationConfigSection
                    section="sources"
                    icon="⚙"
                    config={config}
                    provenance={provenance}
                    onChange={setConfig}
                    // This box's caption is "Saved to this Station"; a plain
                    // Station row inside it says nothing more.
                    containerScope="station"
                    projectOverride={projectOverride}
                  />
                )}

                {/* Glyphs already on `ui-glyph-coverage-allowlist.json`, not
              new ones: that list is recorded debt (#1704 is shrinking it),
              and a section arriving with its own pictogram would grow it for
              decoration. ⚙ is the dissolved card's own glyph, kept for
              Sources; ◉ and ◆ were already carried. */}
                {sectionVisible('telemetry') && (
                  <Section icon="◉" title="Telemetry" id="section-telemetry">
                    <StationConfigSection
                      section="telemetry"
                      embedded
                      config={config}
                      provenance={provenance}
                      onChange={setConfig}
                      containerScope="station"
                      projectOverride={projectOverride}
                    />
                    {/* #2144 slice 6 item D: whether anything CAN be sent, beside
                  the toggle that decides whether it is. Derived from the
                  boolean the disclosure query already holds — React Query
                  dedupes on the key, so this is the same request the
                  disclosure below makes, not a second one. The host is not
                  exposed (see `usageTelemetryDestinationSummary`). */}
                    <PageRow
                      {...settingsRow('telemetry-destination')}
                      description="Usage telemetry has somewhere to go only when the operator has configured a destination for this Station. Station does not show where that is."
                      control={(() => {
                        // `null` is the in-flight read: the row keeps its place
                        // (and its catalog identity) while saying nothing, rather
                        // than asserting the host reported nothing.
                        const summary = usageTelemetryDestinationSummary({
                          endpointConfigured:
                            telemetryDisclosure.data?.endpointConfigured,
                          settled: telemetryDisclosure.settled,
                          isError: telemetryDisclosure.isError,
                        });
                        return summary === null ? null : (
                          <span className="settings__field-hint">
                            {summary}
                          </span>
                        );
                      })()}
                    />
                    <UsageTelemetryDisclosure />
                  </Section>
                )}

                {sectionVisible('diagnostics') && (
                  <Section
                    icon="◫"
                    title="Diagnostics"
                    id="section-diagnostics"
                  >
                    <PageRow
                      {...settingsRow('diagnostics-bundle')}
                      description="Download a redacted snapshot of Station health and configuration. It includes recent server logs when logging is enabled."
                      control={
                        <button
                          type="button"
                          className="settings__secondary-btn settings__diagnostics-download"
                          disabled={diagnosticsBundle.isPending}
                          onClick={() => diagnosticsBundle.mutate(undefined)}
                        >
                          Download diagnostics bundle
                        </button>
                      }
                    />
                    {diagnosticsBundle.isPending && (
                      <div
                        className="settings__diagnostics-status"
                        role="status"
                        aria-label="Generating diagnostics bundle"
                      >
                        <Skeleton variant="line" />
                      </div>
                    )}
                    {diagnosticsBundle.isError && (
                      <ErrorState
                        className="settings__diagnostics-status"
                        variant="compact"
                        title="Diagnostics bundle failed"
                        description="Station could not prepare the diagnostics bundle."
                        action={
                          <button
                            type="button"
                            className="settings__secondary-btn"
                            onClick={() => diagnosticsBundle.mutate(undefined)}
                          >
                            Retry download
                          </button>
                        }
                      />
                    )}
                  </Section>
                )}
              </section>
            )}

            {/* ── Defaults scope ── */}
            {groupVisible('control') && (
              <section
                aria-label="Control settings"
                className="settings__scope-group"
              >
                {/* #2182. This box holds ELEVEN rows and they are not all the
              same kind of rule, which is why the caption has three clauses
              rather than one. Each clause is true of at least one row and the
              three together cover all eleven, so a row added here has to pick
              one — or the caption needs a fourth. Assigned from what the
              RUNTIME does with each value, not from its help text:

                • "what agents may do without asking" (2) —
                  `approval-guardian`, an always-on screener; and
                  `default-approval-mode`, which is ALSO a fallback: a chat or
                  its engine connection that names its own posture wins.
                • "what every run gets" (4) —
                  `default-agent-instructions`, prepended to the agent's own
                  prompt and never replaced by it
                  (`runtime-agent-builder.ts` `createRuntimeInstructions`,
                  `routes/chat/chat.ts`); `template-variables`, one
                  Station-wide list substituted into those prompts
                  (`runtime-template-variables.ts`); `workspace-checkpoints`,
                  read once when Station starts, so a change applies on the
                  next start, and only to sessions bound to a project with a
                  working directory (`turn-checkpoint-capture.ts`); and
                  `builtin-agent-engine`,
                  which applies to every run of a BUILT-IN agent only — an
                  agent bound to its own engine is not carried by it. The
                  first two reach runs Station builds itself; an external
                  engine receives its own prompt.
                • "the values a chat, project or agent inherits when it does
                  not name its own" (5) — `default-model`, `default-region`,
                  `default-workspace-isolation`, and the two run ceilings:
                  `default-max-turns` (`resolveMaxSteps` in `constants.ts`:
                  agent guardrails, then agent spec, then this) and
                  `default-max-output-tokens` (`voltagent-adapter.ts`:
                  `spec.guardrails.maxTokens ?? defaultMaxOutputTokens`).

              2 + 4 + 5 = 11. No "device" clause: the one Station row a DEVICE
              overrides is `default-chat-font-size`, and that row is in the
              Chat box, not this one. */}
                <p className="settings__scope-caption">
                  Saved to this Station — what agents may do without asking,
                  what every run gets, and the values a chat, project or agent
                  inherits when it does not name its own.
                </p>

                {sectionVisible('permissions') && (
                  <StationConfigSection
                    section="permissions"
                    icon="◆"
                    config={config}
                    provenance={provenance}
                    onChange={setConfig}
                    containerScope="station"
                    projectOverride={projectOverride}
                  />
                )}

                {sectionVisible('agent-runs') && (
                  <AgentDefaultsSection
                    config={config}
                    validationErrors={validationErrors}
                    validationWarnings={validationWarnings}
                    onChange={setConfig}
                    region={config.region || ''}
                    regionError={validationErrors.region}
                    regionProvenance={provenance?.region}
                    showRegion={showRegion}
                    onRegionChange={(value) =>
                      setConfig({ ...config, region: value })
                    }
                  >
                    {/* #2182: what a run starts with and what bounds it —
                  which engine carries the built-in agent, its step and
                  output-token ceilings, the workspace a new chat gets and
                  whether it is checkpointed. */}
                    <StationConfigSection
                      section="agent-runs"
                      embedded
                      config={config}
                      provenance={provenance}
                      onChange={setConfig}
                      containerScope="station"
                      projectOverride={projectOverride}
                    />
                  </AgentDefaultsSection>
                )}
              </section>
            )}

            {/* ── This device scope ── */}
            {groupVisible('you') && (
              <section
                aria-label="This device settings"
                className="settings__scope-group"
              >
                <p className="settings__scope-caption">
                  Saved to this device only — these choices won’t follow you to
                  another device.
                </p>

                {sectionVisible('appearance') && (
                  <Section icon="◐" title="Appearance" id="section-appearance">
                    <PageRow
                      {...settingsRow('theme')}
                      description="Toggle between light and dark mode."
                      control={<ThemeToggle />}
                    />
                    {/* archive#3314: the restore path for a section removed via the
                  sidebar's own × affordance. */}
                    <PageRow
                      {...settingsRow('sidebar-sections')}
                      description="Show the Open chats and Drafts sections in the sidebar."
                      control={
                        <div className="settings__toggle-column">
                          <div className="settings__toggle-line">
                            <Toggle
                              checked={!sidebarSections.openChatsHidden}
                              onChange={(checked) =>
                                setDeviceSetting('sidebarSections', {
                                  ...sidebarSections,
                                  openChatsHidden: !checked,
                                })
                              }
                              label="Open chats in sidebar"
                            />
                            <span aria-hidden="true">Open chats</span>
                          </div>
                          <div className="settings__toggle-line">
                            <Toggle
                              checked={!sidebarSections.draftsHidden}
                              onChange={(checked) =>
                                setDeviceSetting('sidebarSections', {
                                  ...sidebarSections,
                                  draftsHidden: !checked,
                                })
                              }
                              label="Drafts in sidebar"
                            />
                            <span aria-hidden="true">Drafts</span>
                          </div>
                        </div>
                      }
                    />
                    {isMobile && (
                      <PageRow
                        {...settingsRow('haptic-feedback')}
                        description="Light pulses while an assistant reply streams, plus feedback on copy, pairing success, and destructive confirms."
                        control={
                          <Toggle
                            checked={hapticsEnabled}
                            onChange={(checked) =>
                              setDeviceSetting('hapticsEnabled', checked)
                            }
                            label={settingsRow('haptic-feedback').title}
                          />
                        }
                      />
                    )}
                    <AccentColorPicker />
                  </Section>
                )}

                {/* #2144 decision 2: Chat owns the rows that decide what a chat
              LOOKS and BEHAVES like on this device. Two of them moved here
              from Appearance (their ids, and therefore every `highlight=`
              deep link, are unchanged); the other five had a device-settings
              contract row and no Settings row at all, so Settings' own search
              returned nothing for "reasoning" or "diff".

              Only THREE of those five had the gear panel as their one
              surface — Show reasoning, Show tool details and Auto-hide chat
              dock. The panel has never offered the diff rows; those were
              changed from `DiffPanel`'s own toolbar, which the note beside
              them names.

              Every one of these surfaces writes the SAME device-settings key
              through the same store, so none of them is a copy of another's
              state: the gear panel is a shortcut to the handful used
              mid-conversation, `DiffPanel`'s toolbar to the two that only
              mean anything over a diff, and Settings is where all of them
              have a home and a search term.

              The icon is one already on the glyph-coverage allowlist rather
              than a new one: that list is recorded debt (#1704 is shrinking
              it), so a section arriving with its own pictogram would grow it
              for decoration. A speech bubble would have. */}
                {sectionVisible('chat') && (
                  <Section icon="◇" title="Chat" id="section-chat">
                    {/* This slider writes the DEVICE key only. The Station
                  default it falls back to (`defaultChatFontSize`) has its own
                  row, immediately below — the catalog entry used to
                  claim both keys while nothing here wrote the Station one. */}
                    <PageRow
                      {...settingsRow('chat-font-size')}
                      // `savedConfig`, not `config`, in all three places below: this
                      // row reports what this device falls back to, which is the
                      // STORED Station default. An unsaved draft of
                      // `defaultChatFontSize` is not in force anywhere yet, so
                      // moving the slider with it would show a fallback no chat is
                      // using.
                      description={`Font size for chat messages on this device (10–24px). Leave at the Station default of ${savedConfig.defaultChatFontSize ?? 14}px unless you want this device to differ.`}
                      control={
                        <div className="settings__range-row">
                          <input
                            id="chatFontSize"
                            aria-label={settingsRow('chat-font-size').title}
                            type="range"
                            min="10"
                            max="24"
                            value={
                              chatFontSize ??
                              savedConfig.defaultChatFontSize ??
                              14
                            }
                            onChange={(e) =>
                              setDeviceSetting(
                                'chatFontSize',
                                parseInt(e.target.value, 10),
                              )
                            }
                          />
                          <span className="settings__range-value">
                            {`${chatFontSize ?? savedConfig.defaultChatFontSize ?? 14}px`}
                          </span>
                          {chatFontSize != null && (
                            <button
                              type="button"
                              className="settings__secondary-btn"
                              onClick={() => resetDeviceSetting('chatFontSize')}
                            >
                              Use Station default
                            </button>
                          )}
                        </div>
                      }
                    />
                    {/* #2182: the Station default the slider above falls back
                  to, beside it rather than in a Station card a reader would
                  have to know to look in. It is the one STATION-scope row in
                  a device box, so `containerScope="device"` makes it print a
                  "Station" chip — the chip is a DIFFERENCE from the group's
                  caption, and this is the first row that actually differs. */}
                    <StationConfigSection
                      section="chat"
                      embedded
                      config={config}
                      provenance={provenance}
                      onChange={setConfig}
                      containerScope="device"
                      projectOverride={projectOverride}
                    />
                    {/* #585: one control names all device-local delivery
                  outcomes. The in-chat gear panel renders the same options
                  from the same mapping module. */}
                    <PageRow
                      {...settingsRow('smooth-answer-reveal')}
                      description="How this device displays streamed answer text: immediately, at a steady pace, or in larger updates at action boundaries."
                      control={
                        <select
                          className="editor-select"
                          aria-label={settingsRow('smooth-answer-reveal').title}
                          value={answerDeliveryModeOf(
                            featureSettings?.smoothReveal,
                            featureSettings?.bufferedDelivery,
                          )}
                          onChange={(event) => {
                            const mode = event.target
                              .value as AnswerDeliveryMode;
                            setDeviceSetting('featureSettings', {
                              ...featureSettings,
                              ...settingsForAnswerDelivery(mode),
                            });
                          }}
                        >
                          {ANSWER_DELIVERY_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      }
                    />
                    <PageRow
                      {...settingsRow('chat-show-reasoning')}
                      description="Chat messages on this device include the model’s reasoning steps."
                      control={
                        <Toggle
                          checked={chatShowReasoning}
                          onChange={(checked) =>
                            setDeviceSetting('chatShowReasoning', checked)
                          }
                          label={settingsRow('chat-show-reasoning').title}
                        />
                      }
                    />
                    <PageRow
                      {...settingsRow('chat-show-tool-details')}
                      description="Tool calls can be expanded to read their arguments and results."
                      control={
                        <Toggle
                          checked={chatShowToolDetails}
                          onChange={(checked) =>
                            setDeviceSetting('chatShowToolDetails', checked)
                          }
                          label={settingsRow('chat-show-tool-details').title}
                        />
                      }
                    />
                    <PageRow
                      {...settingsRow('chat-dock-auto-hide')}
                      description="An idle, open chat dock collapses to its bar after five seconds."
                      control={
                        <Toggle
                          checked={chatDockAutoHide}
                          onChange={(checked) =>
                            setDeviceSetting('chatDockAutoHide', checked)
                          }
                          label={settingsRow('chat-dock-auto-hide').title}
                        />
                      }
                    />
                    {/* The diff rows belong to chat because the changed files a
                  reader opens arrive there. `DiffPanel` writes the same two
                  keys from its own controls. */}
                    <PageRow
                      {...settingsRow('diff-style')}
                      description="Changed files show as one column, or as two side-by-side columns."
                      control={
                        <select
                          className="editor-select"
                          aria-label={settingsRow('diff-style').title}
                          value={diffStyle}
                          onChange={(event) => {
                            const value = event.target.value;
                            if (value !== 'unified' && value !== 'split')
                              return;
                            setDeviceSetting('diffStyle', value);
                          }}
                        >
                          <option value="unified">Unified</option>
                          <option value="split">Side by side</option>
                        </select>
                      }
                    />
                    <PageRow
                      {...settingsRow('diff-wrap')}
                      description="Long diff lines wrap instead of scrolling sideways."
                      control={
                        <Toggle
                          checked={diffWrap}
                          onChange={(checked) =>
                            setDeviceSetting('diffWrap', checked)
                          }
                          label={settingsRow('diff-wrap').title}
                        />
                      }
                    />
                    {/* #2144 slice 6 item E. A group, not a new section: only
                  ONE destructive confirm has an action behind it today —
                  archive and quit do not exist, and "Clear all conversations"
                  deliberately keeps asking. It moved here from Appearance
                  with its heading (#2182): whether deleting a conversation
                  asks first is a fact about conversations, not about how the
                  app looks. */}
                    <h3 className="settings__group-title">Confirmations</h3>
                    <PageRow
                      {...settingsRow('confirm-conversation-delete')}
                      description="Deleting a conversation cannot be undone. Turn this off to delete immediately. Clearing all conversations always asks."
                      control={
                        <Toggle
                          checked={confirmConversationDelete}
                          onChange={(checked) =>
                            setDeviceSetting(
                              'confirmConversationDelete',
                              checked,
                            )
                          }
                          label={
                            settingsRow('confirm-conversation-delete').title
                          }
                        />
                      }
                    />
                  </Section>
                )}

                {sectionVisible('keyboard-shortcuts') && (
                  <Section
                    icon="⌨"
                    title="Keyboard shortcuts"
                    id="section-keyboard-shortcuts"
                  >
                    <KeyboardShortcutsSection />
                  </Section>
                )}

                {sectionVisible('notifications') && (
                  <NotificationsSection apiBase={currentApiBase} />
                )}

                {sectionVisible('voice') && <VoiceFeaturesSection />}

                {/* #2182: pairing is not a voice feature, and now says so. */}
                {sectionVisible('pairing') && <PairingSection />}

                {sectionVisible('developer-tools') && (
                  <Section
                    icon="⌥"
                    title="Developer tools"
                    id="section-developer-tools"
                  >
                    <PageRow
                      {...settingsRow('enable-developer-tools')}
                      // Where the result APPEARS, because it is not here: the row
                      // this adds opens the This Station group of the navigation
                      // strip at the top of this page, while the switch itself sits
                      // in This device further down, and the strip scrolls
                      // sideways. Nothing else on the page moves, so without the
                      // sentence the press reads as having done nothing.
                      description="Show the Developer surface (logs, system, telemetry, memory, archive) on this device. A Developer row appears in the navigation at the top of this page, first under This Station, and Developer joins the sidebar and the command palette. Deep links to /developer keep working either way."
                      control={
                        <Toggle
                          checked={developerToolsEnabled}
                          onChange={(checked) =>
                            setDeviceSetting('developerToolsEnabled', checked)
                          }
                          label={settingsRow('enable-developer-tools').title}
                        />
                      }
                    />
                  </Section>
                )}
              </section>
            )}

            {/* ── My knowledge store (stays its own top-level card) ──
            The caption keeps the persistence fact the removed scope legend
            used to carry for knowledge (station#1826 delivery review, M2):
            this card sits outside every scope group, so without its own
            caption nothing on the page said knowledge lives on the Station
            and follows you across devices. */}
            {groupVisible('knowledge') && (
              <section
                aria-label="Knowledge settings"
                className="settings__scope-group"
              >
                <p className="settings__scope-caption">
                  Saved to this Station — available from every device that
                  connects to it.
                </p>
                <KnowledgeStoreSection />
              </section>
            )}
          </div>
        </div>
      </div>

      {(hasChanges || overrideDirty) && (
        <div className="settings__save-pill" role="status" aria-live="polite">
          <span className="settings__save-pill-text">Unsaved changes</span>
          <button
            type="button"
            className="settings__save-pill-discard"
            onClick={() => {
              setConfig(savedConfig);
              setOverrideDraft({});
            }}
          >
            Discard
          </button>
          <button
            type="button"
            className="settings__save-pill-btn"
            onClick={saveConfig}
            disabled={isSaving || isSplitSaving || !isValid}
          >
            {isSaving || isSplitSaving
              ? 'Saving…'
              : !isValid
                ? 'Fix errors'
                : 'Save'}
          </button>
        </div>
      )}

      <ConfirmModal
        isOpen={showResetModal}
        title="Reset Station settings"
        message={
          resetPlan.keys.length === 0
            ? 'No Station setting currently has a stored value, so there is nothing to reset. Settings on this device are not affected.'
            : `This clears ${resetPlan.keys.length} stored Station setting${resetPlan.keys.length === 1 ? '' : 's'} and lets Station use its default again: ${resetPlan.labels.join(', ')}. The required model settings (Default model, Invoke model, Structure model) and the built-in agent engine choice are kept. Usage telemetry is not changed by a reset. Settings on this device are not affected. This cannot be undone.`
        }
        confirmLabel="Reset"
        confirmDisabled={resetPlan.keys.length === 0}
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={resetToDefaults}
        onCancel={() => setShowResetModal(false)}
      />

      <DiscardModal />
    </>
  );
}

/**
 * The settings section rail, extracted so it can render BEFORE the config
 * read settles (6-OPS-23).
 *
 * Every link here is derived from the static `SETTINGS_SECTIONS` catalog and
 * from the URL — none of it waits on `/api/config/app`. Rendering it only in
 * the loaded branch meant a measured ~16 s during which Settings showed a
 * title and three grey blocks: the page's whole navigable shape was known the
 * whole time and withheld anyway.
 *
 * archive#4463 removed this strip's all-caps `STATION` / `DEFAULTS` /
 * `THIS DEVICE` group-label `<span>`s — two label vocabularies colliding in
 * one control — and left a silent `dividerAfter` in their place. #2144
 * decision 6 brings NAMED groups back, and has to answer that removal rather
 * than ignore it. Two things changed:
 *
 * - The label is a real `<h2>` styled to be unmistakably not a link (see
 *   `.section-nav__group-label`), so the vocabularies no longer share one
 *   visual control. The divider said "the subject changed" to sighted readers
 *   and nothing at all to a screen reader; a heading says it to both and puts
 *   the groups in the heading rotor.
 * - The group names are deliberately ALIGNED with the page below, not
 *   independent of it. This page's structure IS persistence-shaped: its body
 *   is a run of `.settings__scope-group` sections, each opening with the rule
 *   its settings are saved under, and four of the five nav groups map onto
 *   one of those boxes each. "This Station" is its box's caption restated,
 *   and that is the point — a nav that named the page's structure differently
 *   would mislabel a box a reader is about to scroll into. Set up is the one
 *   group with no box, because it holds no sections of this page at all.
 *   archive#4463's collision was two label vocabularies over ONE control, and
 *   what answers it is that a group label is a non-interactive heading and
 *   never a place to press — not that its words have to differ from the
 *   caption's.
 *
 * "Control" is the one group name that is not a storage location, and it has
 * to be: its box is saved on the Station exactly as This Station's is, so a
 * name drawn from persistence could not tell the two apart. What separates
 * them is the rest of its caption — these are the values "used when a chat,
 * project, or agent doesn't set its own value" — and the name states that
 * authority relationship rather than a place.
 *
 * The landmark stays single (`aria-label="Settings sections"`): one
 * navigation with headings inside, not one landmark per group.
 *
 * `SectionNav`, not `Tabs`: these are real, deep-linkable URL sections
 * (`?view=`) navigated via `useSectionNavigation`'s `hrefForSection`, not an
 * in-place tab widget — see `components/SectionNav.tsx`'s docblock for why
 * that distinction is load-bearing (archive#4463). The Set up rows are the
 * exception that proves it: they are ordinary links to other routes, and
 * `SettingsSectionNav` sends them to the navigation store instead of the
 * section resolver.
 */
/**
 * The nav group order, and the words each one is shown under. Order is the
 * PAGE's order too: every section body below is rendered in this sequence, so
 * the strip a reader skims and the page they scroll agree. Adding a group
 * here without moving its bodies would desynchronise a scroll-spy nav.
 */
// Sentence case in the DOM; `.section-nav__group-label` is what draws them as
// small caps. Writing "SET UP" here would put shouted text in the accessibility
// tree for a purely visual treatment, and some screen readers spell short
// all-caps strings out letter by letter.
const NAV_GROUPS = [
  // Set up holds no settings sections at all — only rows that leave this page
  // for the surface they name.
  { id: 'set-up', label: 'Set up' },
  { id: 'this-station', label: 'This Station' },
  { id: 'control', label: 'Control' },
  // The id stays as minted: it is internal, and no URL, registry record or
  // deep link carries it. The LABEL is the owner decision on #2144 — a
  // heading reading "You" over a caption that says "Saved to this device
  // only" named a person where the box names a machine.
  { id: 'you', label: 'This device' },
  { id: 'knowledge', label: 'Knowledge' },
] as const satisfies readonly {
  // Both vocabularies: a group can hold sections, nav-only rows, or both.
  // This Station holds both — its sections, plus Developer when this device
  // has developer tools on.
  id: SettingsNavGroup | SettingsNavGroupId;
  label: string;
}[];

/**
 * The key prefix that separates a nav-only row from a settings section.
 *
 * A nav-only row LEAVES this page, so its key must never be mistaken for a
 * `?view=` value: `useSectionNavigation` validates against
 * `ALL_SETTINGS_VIEWS` and silently falls back to overview for anything else,
 * which would turn "open Agents" into "scroll to the top" with no error
 * anywhere. The prefix cannot collide, because a `SettingsSectionId` is a
 * plain slug and `:` is not in that grammar.
 */
const NAV_ONLY_KEY_PREFIX = 'nav:';

/** Exported for `SettingsSectionNav.test.tsx` — the nav's shape is worth testing directly, independent of the many hooks a full `SettingsView` render would require mocking. */
export function settingsSectionNavItems(
  hrefForSection: (section: string) => string,
  navOnlyEntries: readonly SettingsNavEntry[] = APP_DESTINATION_REGISTRY.getSettingsNav(),
): SectionNavItem[] {
  const grouped = NAV_GROUPS.flatMap((group) => {
    // Nav-only rows come FIRST within their group: they are surfaces, and a
    // reader scanning for "Agents" or "Developer" is looking for a place, not
    // a row of this page. Each row is placed by the group the registry gives
    // it, not by being nav-only — Developer belongs beside this Station's own
    // sections, not under Set up with the entity lists.
    const items = [
      ...navOnlyEntries
        .filter((entry) => entry.group === group.id)
        .map((entry) => ({
          key: `${NAV_ONLY_KEY_PREFIX}${entry.id}`,
          label: entry.label,
          href: entry.route,
        })),
      ...SETTINGS_SECTIONS.filter((section) => section.group === group.id).map(
        (section) => ({
          key: section.id as string,
          label: section.title as string,
          href: hrefForSection(section.id),
        }),
      ),
    ];
    // An empty group renders NO heading: a label naming a group that is not
    // there is worse than a missing label. This Station's Developer row is
    // conditional today, and a group could become wholly conditional next.
    if (items.length === 0) return [];
    return items.map((item, index) =>
      index === 0 ? { ...item, groupLabel: group.label } : item,
    );
  });
  return [
    { key: 'overview', label: 'Overview', href: hrefForSection('overview') },
    ...grouped,
  ];
}

function SettingsSectionNav({
  activeSection,
  hrefForSection,
  navigateToSection,
}: {
  activeSection: string;
  hrefForSection: (section: string) => string;
  navigateToSection: (section: string) => void;
}) {
  // The narrow hook: this destructure is actions only, and the bare
  // `useNavigation()` re-renders the strip on every navigation-store write.
  const { navigate } = useNavigationActions();
  // The SAME flag set every other advertisement surface filters on, so
  // Developer appears here exactly when it appears in the palette — and
  // disappears from the nav, not merely from the old Manage grid, when
  // developer tools are off. Passing nothing would silently drop it forever.
  const flags = useSurfaceVisibilityFlags();
  const items = settingsSectionNavItems(
    hrefForSection,
    APP_DESTINATION_REGISTRY.getSettingsNav(flags),
  );
  return (
    <SectionNav
      className="settings__section-nav section-nav--rail"
      aria-label="Settings sections"
      items={items}
      activeKey={activeSection}
      onNavigate={(key) => {
        if (!key.startsWith(NAV_ONLY_KEY_PREFIX)) {
          navigateToSection(key);
          return;
        }
        // The canonical `navigate`, so the page's unsaved-changes guard is
        // asked exactly once — leaving Settings with a pending edit through
        // this row must behave like leaving it any other way (src-ui/AGENTS.md).
        const target = items.find((item) => item.key === key);
        if (target) navigate(target.href);
      }}
    />
  );
}

import { SectionNavigation } from '../components/SectionNavigation';
import './SettingsView.css';
import { APPROVAL_FULL_ACCESS_NOT_GRANTED_CODE } from '@kontourai/station-contracts/orchestration';
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
  useUpdateProjectMutation,
} from '@kontourai/station-sdk';
import { updateAppLogLevel } from '@kontourai/station-sdk/app-config';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { ThemeToggle } from '../components/header/ThemeToggle';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import { PageRow } from '../components/PageRow';
import type { SectionNavItem } from '../components/SectionNav';
import { ExistingSetupImportStepper } from '../components/setup/ExistingSetupImportStepper';
import {
  describeReadFailure,
  Empty,
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
import {
  useScopedProjectQuery,
  useScopedProjectsQuery,
} from '../contexts/ProjectsContext';
import { useCloseShortcut } from '../hooks/useCloseShortcut';
import { useSectionNavigation } from '../hooks/useSectionNavigation';
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
import { DeviceHostsSection } from './settings/DeviceHostsSection';
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
import {
  SETTINGS_PAGES,
  settingsPageForSection,
  settingsSectionsForView,
} from './settings/settings-pages';
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

const ALL_LEAF_SECTION_IDS = SETTINGS_SECTIONS.map(({ id }) => id);
const ALL_SETTINGS_VIEWS = [
  ...new Set([
    'overview',
    ...SETTINGS_PAGES.map(({ id }) => id),
    ...ALL_LEAF_SECTION_IDS,
  ]),
];

/**
 * How long a Settings save may stay in flight before the UI stops waiting.
 *
 * The browser SDK deliberately configures no default request deadline
 * (`packages/sdk/src/client/http.ts`) — only the CLI sets one — so a request
 * that never settles would otherwise leave `Save` disabled until reload. The
 * deadline does not cancel the write (it may still land); it releases the UI
 * and keeps the drafts so the user can retry.
 */
/**
 * #2436: the server's message when this device may not set the Station's
 * default approval mode to full access, or `undefined` for any other
 * failure.
 */
function fullAccessRefusal(reason: unknown): string | undefined {
  return reason instanceof Error &&
    (reason as { code?: unknown }).code ===
      APPROVAL_FULL_ACCESS_NOT_GRANTED_CODE
    ? reason.message
    : undefined;
}

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
  const { data: projects } = useScopedProjectsQuery();
  const projectList: { slug: string; name?: string }[] = Array.isArray(projects)
    ? projects
    : [];
  const { data: selectedProject } = useScopedProjectQuery(
    selectedProjectSlug ?? '',
    {
      enabled: Boolean(selectedProjectSlug),
    },
  );
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
    useSectionNavigation(ALL_SETTINGS_VIEWS, 'general', {
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
        : settingsSectionsForView(activeSection).filter(operatorMayView),
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
    isValid: stationConfigValid,
  } = getSettingsValidation(config);
  const projectModelIncomplete =
    !!selectedProjectSlug &&
    typeof projectOverride?.values.defaultLLMProvider === 'string' &&
    !!projectOverride.values.defaultLLMProvider &&
    (typeof projectOverride.values.defaultModel !== 'string' ||
      !projectOverride.values.defaultModel.trim());
  const isValid = stationConfigValid && !projectModelIncomplete;

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
        .map((key) => {
          const value = (config as Record<string, unknown>)[key];
          // Region's empty input inherits; null is the route's clear signal.
          return [key, key === 'region' && value === '' ? null : value];
        }),
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
        // Preserve draft spelling until readback, including '' for cleared Region.
        const written = {
          ...(plainWrite !== undefined && plainOutcome.status === 'fulfilled'
            ? Object.fromEntries(
                Object.keys(plainChanges).map((key) => [
                  key,
                  (config as Record<string, unknown>)[key],
                ]),
              )
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
                : fullAccessRefusal(plainOutcome.reason)
                  ? // #2436: a retry would be refused again; say why instead.
                    `${fullAccessRefusal(plainOutcome.reason)} Nothing in this save was stored. Choose a stricter default approval mode to save your other changes.`
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
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            activeSection={activeSection}
            hrefForSection={hrefForSection}
            navigateToSection={navigateToSection}
          />
          <div
            className="section-nav-rail__body"
            id={
              !ALL_LEAF_SECTION_IDS.includes(activeSection as never)
                ? `section-${activeSection}`
                : undefined
            }
            tabIndex={-1}
          >
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

        <div className="section-nav-rail">
          <SettingsSectionNav
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            activeSection={activeSection}
            hrefForSection={hrefForSection}
            navigateToSection={navigateToSection}
          />
          <div
            className="section-nav-rail__body"
            id={
              !ALL_LEAF_SECTION_IDS.includes(activeSection as never)
                ? `section-${activeSection}`
                : undefined
            }
            tabIndex={-1}
          >
            {searchQuery.trim() && visibleSections.size === 0 && (
              <div role="status">
                <Empty label={`No settings match “${searchQuery}”.`} />
              </div>
            )}
            {/* #2144 slice 3: which document the page is showing values for.
            Outside every scope group because it re-attributes rows in more
            than one of them, and the sentence beside it names exactly what a
            project may override — the selector governs attribution for the
            whole page, but only these settings are a project's to change. */}
            {(sectionVisible('agent-runs') ||
              sectionVisible('permissions')) && (
              <div className="settings__project-scope">
                <label
                  className="settings__project-scope-label"
                  htmlFor="settings-project-scope"
                >
                  Defaults for
                </label>
                <select
                  id="settings-project-scope"
                  className="editor-select"
                  value={selectedProjectSlug ?? ''}
                  onChange={(event) =>
                    selectProject(event.target.value || null)
                  }
                >
                  <option value="">All projects</option>
                  {projectList.map((project) => (
                    <option key={project.slug} value={project.slug}>
                      {project.name ?? project.slug}
                    </option>
                  ))}
                </select>
                <span className="settings__field-hint">
                  Projects can override the model and new-chat workspace.
                </span>
              </div>
            )}

            {/* ── Station scope ── */}
            {groupVisible('this-station') && (
              <section
                aria-label="This Station settings"
                className="settings__scope-group"
              >
                <p className="settings__scope-caption">
                  Saved to this Station.
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
                {/* #1973: SSH device hosts. Operator-only (the same gate as
              plugin visibility); the panel itself is lazy-loaded. */}
                {sectionVisible('device-hosts') && <DeviceHostsSection />}
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
                <p className="settings__scope-caption">
                  Saved to this Station.
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
                    projectOverride={projectOverride}
                    projectReadReady={selectedProject !== undefined}
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
                <p className="settings__scope-caption">Saved to this device.</p>

                {sectionVisible('appearance') && (
                  <Section icon="◐" title="Appearance" id="section-appearance">
                    <PageRow
                      {...settingsRow('theme')}
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
                    {/* #90 D9: the same key the in-chat gear panel sets. */}
                    <PageRow
                      {...settingsRow('chat-auto-float-browser')}
                      description="When an agent in a chat opens or drives a browser and no pane shows it, the browser floats over that chat. A session you close stays closed in that chat."
                      control={
                        <Toggle
                          checked={
                            featureSettings?.autoFloatAgentBrowserSessions !==
                            false
                          }
                          onChange={(checked) =>
                            setDeviceSetting('featureSettings', {
                              ...featureSettings,
                              autoFloatAgentBrowserSessions: checked,
                            })
                          }
                          label={settingsRow('chat-auto-float-browser').title}
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

                {sectionVisible('notifications') && <NotificationsSection />}

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
                      description="Show Developer in Customize and the command palette on this device."
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

/** Settings navigation stays within this page. Leaf URLs remain supported. */
export function settingsSectionNavItems(
  hrefForSection: (section: string) => string,
): SectionNavItem[] {
  return SETTINGS_PAGES.map((page) => ({
    key: page.id,
    label: page.title,
    href: hrefForSection(page.id),
  }));
}

function SettingsSectionNav({
  activeSection,
  hrefForSection,
  navigateToSection,
  searchQuery,
  onSearchChange,
}: {
  activeSection: string;
  hrefForSection: (section: string) => string;
  navigateToSection: (section: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
}) {
  const items = settingsSectionNavItems(hrefForSection);
  const activePage =
    SETTINGS_PAGES.find((page) => page.id === activeSection) ??
    settingsPageForSection(activeSection);
  const selectedKey = activePage?.id ?? 'overview';
  const choosePage = (key: string) => {
    onSearchChange('');
    navigateToSection(key);
  };
  return (
    <SectionNavigation
      label="Settings sections"
      pickerLabel="Settings section"
      items={items}
      activeKey={selectedKey}
      showSelection={!searchQuery.trim()}
      onNavigate={choosePage}
    >
      <input
        type="search"
        className="settings__search"
        placeholder="Search settings…"
        value={searchQuery}
        onChange={(event) => onSearchChange(event.target.value)}
        aria-label="Filter settings"
      />
    </SectionNavigation>
  );
}

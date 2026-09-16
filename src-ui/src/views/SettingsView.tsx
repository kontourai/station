import './SettingsView.css';
import {
  PROJECT_OVERRIDABLE_APP_SETTING_KEYS,
  type ProjectOverridableAppSettingKey,
} from '@kontourai/station-contracts/project-settings-overrides';
import {
  authenticatedFetch,
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
import { UsageTelemetryDisclosure } from '../components/UsageTelemetryDisclosure';
import { useApiBase } from '../contexts/ApiBaseContext';
import { useConfigActions, useConfigSnapshot } from '../contexts/ConfigContext';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../contexts/DeviceSettingsContext';
import { useCloseShortcut } from '../hooks/useCloseShortcut';
import { useSectionNavigation } from '../hooks/useSectionNavigation';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { useLocale } from '../i18n/LocaleContext';
import { DeviceSettingsImportVersionError } from '../lib/device-settings-store';
import { usePlatformProfile } from '../platform/PlatformProfileContext';
import type { AppConfig, NavigationView } from '../types';
import { AccentColorPicker } from './settings/AccentColorPicker';
import { AgentDefaultsSection } from './settings/AgentDefaultsSection';
import { AnswerSharesSection } from './settings/AnswerSharesSection';
import { downloadDiagnosticsBundle } from './settings/diagnostics-download';
import { EnvironmentStatus } from './settings/EnvironmentStatus';
import { FeaturePreviewsSection } from './settings/FeaturePreviewsSection';
import { KeyboardShortcutsSection } from './settings/KeyboardShortcutsSection';
import { KnowledgeStoreSection } from './settings/KnowledgeStoreSection';
import { LocalAccountsSection } from './settings/LocalAccountsSection';
import { PluginVisibilitySection } from './settings/PluginVisibilitySection';
import { SettingsManageSection } from './settings/SettingsManageSection';
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
  settingsRow,
} from './settings/settings-catalog';
import {
  buildProjectOverrideUpdate,
  effectiveOverrideValue,
  type ProjectOverrideDraft,
  projectOverrideDelta,
  savedOverridesFor,
} from './settings/project-override-draft';
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
 * restructures. `station-config` is the one new leaf (the previously
 * hidden Station fields — see StationConfigSection.tsx). "My knowledge
 * store" (archive#settings-revamp: renamed from "Knowledge Store" to
 * disambiguate from the project-scoped and infrastructure-scoped Knowledge
 * surfaces, docs/design/settings-architecture.md §3) stays its own
 * top-level card outside every scope group.
 */
// Ordered by what a person came here to do (archive#1826): the sections with
// controls first (Station configuration, System, Shared answers), then the
// read-mostly surfaces (Station host status, the Diagnostics bundle). A
// settings page should open with what you change, not what an engineer
// collects.
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
  const {
    chatFontSize,
    featureSettings,
    hapticsEnabled,
    developerToolsEnabled,
    sidebarSections,
  } = useDeviceSettings();
  const { setDeviceSetting, resetDeviceSetting } = useDeviceSettingsActions();
  const { isMobile, isDesktop } = usePlatformProfile();
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
  const visibleSections = new Set(
    searchQuery.trim()
      ? matchingSettingsRows(searchQuery, { isOperator }).map(
          (entry) => entry.section,
        )
      : activeSection === 'overview'
        ? ALL_LEAF_SECTION_IDS.filter(
            // Keyed on the CONDITIONAL, not on one section id: a second
            // operator-conditional section would otherwise leak into the
            // overview the day somebody adds it.
            (section) => isOperator || !OPERATOR_ONLY_SECTION_IDS.has(section),
          )
        : [activeSection],
  );
  const sectionVisible = (section: string) =>
    visibleSections.has(section as never);

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
    const overrideWrite =
      selectedProjectSlug && overrideDirty
        ? updateProject.mutateAsync({
            slug: selectedProjectSlug,
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
      if (overrideWrite !== undefined && overrideOutcome.status === 'fulfilled') {
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
  const resetPlan = buildStationResetPlan(provenance);

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
        {/* #2059: rendered in BOTH branches for the same reason the section
            nav is — it is derived from the destination registry and the
            device flags, so it never waits on `/api/config/app`. A failed or
            slow config read must not be able to strand the only in-app way
            back to Agents, Connections or Plugins. */}
        <SettingsManageSection />
        <SettingsSectionNav
          activeSection={activeSection}
          hrefForSection={hrefForSection}
          navigateToSection={navigateToSection}
        />
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
        <SettingsSectionNav
          activeSection={activeSection}
          hrefForSection={hrefForSection}
          navigateToSection={navigateToSection}
        />

        {/* ── Manage (other surfaces, not sections of this page) ── */}
        <SettingsManageSection />

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
            A project can override its new-chat workspace and its default model
            connection and model. Every other setting on this page belongs to
            the Station.
          </span>
        </div>

        {/* ── Station scope ── */}
        <section
          aria-label="Station settings"
          className="settings__scope-group"
        >
          <p className="settings__scope-caption">
            Saved to this Station — every client sees the same values.
          </p>

          {sectionVisible('station-config') && (
            <>
              <StationConfigSection
                config={config}
                provenance={provenance}
                onChange={setConfig}
                projectOverride={projectOverride}
              />
              <UsageTelemetryDisclosure />
              <LocalAccountsSection />
            </>
          )}

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
            </>
          )}

          {/* archive#3313: previews persist on the Station (PUT
              /api/feature-previews/:id), so the section lives in this scope. */}
          {sectionVisible('feature-previews') && <FeaturePreviewsSection />}

          {/* archive#1423: answer permalinks the operator has minted. Station
              scope because the shares live on this Station and every client
              of it sees the same list. */}
          {sectionVisible('answer-shares') && <AnswerSharesSection />}

          {/* #2067: per-principal plugin visibility. Station scope — the
              grants live on this Station — and the section renders nothing
              for a caller the route refuses as a non-operator. */}
          {sectionVisible('plugin-visibility') && <PluginVisibilitySection />}
          {sectionVisible('host-runtime') && (
            <EnvironmentStatus apiBase={currentApiBase} />
          )}

          {sectionVisible('diagnostics') && (
            <Section icon="◫" title="Diagnostics" id="section-diagnostics">
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

        {/* ── Defaults scope ── */}
        <section
          aria-label="Defaults settings"
          className="settings__scope-group"
        >
          <p className="settings__scope-caption">
            Saved to this Station — used when a chat, project, or agent doesn’t
            set its own value.
          </p>

          {sectionVisible('agent-defaults') && (
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
            />
          )}
        </section>

        {/* ── This device scope ── */}
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
              {/* This slider writes the DEVICE key only. The Station
                  default it falls back to (`defaultChatFontSize`) has its own
                  row under Station configuration — the catalog entry used to
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
                        chatFontSize ?? savedConfig.defaultChatFontSize ?? 14
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
              <PageRow
                {...settingsRow('smooth-answer-reveal')}
                description="Reveal incoming answer text steadily instead of showing network bursts all at once."
                control={
                  <Toggle
                    checked={featureSettings?.smoothReveal ?? false}
                    onChange={(checked) =>
                      setDeviceSetting('featureSettings', {
                        ...featureSettings,
                        smoothReveal: checked,
                      })
                    }
                    label={settingsRow('smooth-answer-reveal').title}
                  />
                }
              />
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

          {sectionVisible('developer-tools') && (
            <Section
              icon="⌥"
              title="Developer tools"
              id="section-developer-tools"
            >
              <PageRow
                {...settingsRow('enable-developer-tools')}
                description="Show the Developer surface (logs, system, telemetry, memory, archive) in the sidebar and command palette on this device. Deep links to /developer keep working either way."
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

        {/* ── My knowledge store (stays its own top-level card) ──
            The caption keeps the persistence fact the removed scope legend
            used to carry for knowledge (station#1826 delivery review, M2):
            this card sits outside every scope group, so without its own
            caption nothing on the page said knowledge lives on the Station
            and follows you across devices. */}
        {sectionVisible('knowledge') && (
          <section
            aria-label="Knowledge settings"
            className="settings__scope-group"
          >
            <p className="settings__scope-caption">
              Saved to this Station — available from every device that connects
              to it.
            </p>
            <KnowledgeStoreSection />
          </section>
        )}
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
 * archive#4463: this used to render its own all-caps `STATION` /
 * `DEFAULTS` / `THIS DEVICE` group-label `<span>`s inline in the same row as
 * the section links — the named this a bug (two label
 * vocabularies colliding in one control), and the fix is not to relabel it
 * but to remove it: every scope group's content already opens with its own
 * caption ("Saved to this Station — every client sees the same values.",
 * etc.), so the nav label was pure duplication. The scope grouping itself is
 * not lost — it is now a `dividerAfter` on each group's last item, drawn by
 * `SectionNav` as a real presentational separator element rather than a
 * second label vocabulary sharing the nav row.
 *
 * `SectionNav`, not `Tabs`: these are real, deep-linkable URL sections
 * (`?view=`) navigated via `useSectionNavigation`'s `hrefForSection`, not an
 * in-place tab widget — see `components/SectionNav.tsx`'s docblock for why
 * that distinction is load-bearing (archive#4463).
 */
/** Exported for `SettingsSectionNav.test.tsx` — the nav's shape is worth testing directly, independent of the many hooks a full `SettingsView` render would require mocking. */
export function settingsSectionNavItems(
  hrefForSection: (section: string) => string,
): SectionNavItem[] {
  const NAV_GROUPS = ['Station', 'Defaults', 'This device'] as const;
  const grouped = NAV_GROUPS.flatMap((group, groupIndex) => {
    const groupSections = SETTINGS_SECTIONS.filter(
      (section) => section.group === group,
    );
    // A divider marks a boundary BETWEEN two groups — never after the last
    // group's last item, which matches the original markup: Knowledge
    // rendered outside every `.settings__nav-group` wrapper, so the CSS
    // sibling-divider (`.settings__nav-group + .settings__nav-group`) never
    // fired between "This device" and Knowledge.
    const isLastGroup = groupIndex === NAV_GROUPS.length - 1;
    return groupSections.map((section, index) => ({
      key: section.id,
      label: section.title,
      href: hrefForSection(section.id),
      dividerAfter: !isLastGroup && index === groupSections.length - 1,
    }));
  });
  const knowledge = SETTINGS_SECTIONS.filter(
    (section) => section.group === 'Knowledge',
  ).map((section) => ({
    key: section.id,
    label: section.title,
    href: hrefForSection(section.id),
  }));
  return [
    { key: 'overview', label: 'Overview', href: hrefForSection('overview') },
    ...grouped,
    ...knowledge,
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
  return (
    <SectionNav
      className="settings__section-nav"
      aria-label="Settings sections"
      items={settingsSectionNavItems(hrefForSection)}
      activeKey={activeSection}
      onNavigate={navigateToSection}
    />
  );
}

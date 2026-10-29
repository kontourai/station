import type { DeviceSettings } from '@kontourai/station-contracts/device-settings';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { Button } from '../components/Button';
import { CheckGlyph } from '../components/icons/Glyph';
import { PageCallout } from '../components/PageCallout';
import { PageRow } from '../components/PageRow';
import { PageSection } from '../components/PageSection';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../contexts/DeviceSettingsContext';
import { useShortcutRegistry } from '../contexts/KeyboardShortcutsContext';
import { useCoarsePointer } from '../hooks/useCoarsePointer';
import { useIsMobile } from '../hooks/useIsMobile';
import {
  useKeyboardShortcut,
  useShortcutDisplay,
} from '../hooks/useKeyboardShortcut';
import { useLocale } from '../i18n/LocaleContext';
import {
  COLOR_THEME_ACCENT_ATTRIBUTE,
  COLOR_THEME_ATTRIBUTE,
  COLOR_THEME_FAILED_ATTRIBUTE,
  COLOR_THEME_FLAVOR_ATTRIBUTE,
  retryColorTheme,
  selectionKey,
} from '../lib/color-theme-apply';
import {
  type ColorThemeMode,
  type ResolvedColorTheme,
  resolveColorThemeSelection,
} from '../lib/color-theme-selection';
// The full catalog: fine here, because this page is its own lazy chunk.
import {
  COLOR_THEME_OPTIONS,
  type ColorThemeOption,
  type ColorThemeSwatch,
} from '../lib/color-themes';
import { AccentColorPicker } from '../views/settings/AccentColorPicker';
import { formatSettingsMessage } from '../views/settings/settings-catalog';
import './AppearancePage.css';
import '../views/page-layout.css';

/** The same shape `applyAccentColor` accepts; anything else is not applied. */
const HEX_ACCENT = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function customAccent(settings: DeviceSettings): string | null {
  const value = settings.accentColor;
  return typeof value === 'string' && HEX_ACCENT.test(value) ? value : null;
}

type FamilyResolution = Exclude<ResolvedColorTheme, { id: 'station' }>;

/** The flavor option a family shows in `mode`, honoring the chosen dark flavor. */
function flavorOptionFor(
  option: ColorThemeOption,
  mode: ColorThemeMode,
  resolved: FamilyResolution | null,
) {
  if (mode === 'light') return option.flavors.find((f) => f.mode === 'light');
  const darkId = resolved?.darkFlavor ?? option.defaultDarkFlavor;
  return option.flavors.find((f) => f.id === darkId);
}

export interface ThemePreview {
  readonly swatch: ColorThemeSwatch;
  /** The flavor shown, `null` for Station. */
  readonly flavorLabel: string | null;
}

/**
 * What a gallery card shows in `mode`. The SELECTED card is what is on screen
 * now: its chosen flavor and accent, and a custom accent when one is set (it
 * wins on every theme). Every other card shows that theme's own defaults, so
 * the gallery compares themes rather than one accent on six backgrounds.
 */
export function themePreview(
  option: ColorThemeOption,
  mode: ColorThemeMode,
  settings: DeviceSettings,
): ThemePreview {
  const resolved = resolveColorThemeSelection(settings);
  const selected = resolved.id === option.id;
  const custom = selected ? customAccent(settings) : null;
  if (option.id === 'station') {
    const swatch = option.preview[mode];
    return {
      swatch: custom ? { ...swatch, accent: custom } : swatch,
      flavorLabel: null,
    };
  }
  const family = selected ? (resolved as FamilyResolution) : null;
  const flavor = flavorOptionFor(option, mode, family);
  if (!flavor) return { swatch: option.preview[mode], flavorLabel: null };
  const accentId = family?.accent ?? option.defaultAccent;
  const named = option.accents.find((accent) => accent.id === accentId);
  return {
    swatch: {
      ...flavor.swatch,
      accent: custom ?? named?.swatches[flavor.id] ?? flavor.swatch.accent,
    },
    flavorLabel: flavor.label,
  };
}

function ThemeThumbnail({ swatch }: { swatch: ColorThemeSwatch }) {
  return (
    <span
      className="appearance-theme__preview"
      aria-hidden="true"
      style={{ background: swatch.background, color: swatch.text }}
    >
      <span
        className="appearance-theme__panel"
        style={{ background: swatch.panel }}
      >
        <span className="appearance-theme__line appearance-theme__line--title" />
        <span className="appearance-theme__line appearance-theme__line--muted" />
        <span className="appearance-theme__code">
          <span
            className="appearance-theme__token"
            style={{ background: swatch.accent }}
          />
          <span className="appearance-theme__token appearance-theme__token--text" />
          <span className="appearance-theme__token appearance-theme__token--short" />
        </span>
        <span
          className="appearance-theme__button"
          style={{ background: swatch.accent }}
        />
      </span>
      <span className="appearance-theme__strip">
        {[swatch.background, swatch.panel, swatch.text, swatch.accent].map(
          (color, index) => (
            // Four fixed slots; the index IS the identity.
            <span key={index} style={{ background: color }} />
          ),
        )}
      </span>
    </span>
  );
}

function ModeControl({
  mode,
  onChange,
}: {
  mode: ColorThemeMode;
  onChange: (mode: ColorThemeMode) => void;
}) {
  const shortcut = useShortcutDisplay('theme.toggle');
  // A shortcut the person unbound is registered but disabled; it has no
  // chord to advertise.
  const unbound =
    useShortcutRegistry()
      .getAllShortcuts()
      .find((candidate) => candidate.id === 'theme.toggle')?.disabled === true;
  // A phone or a touch screen has no ⌘H to press; the hint would be noise.
  const touch = useCoarsePointer();
  const mobile = useIsMobile();
  return (
    <div className="appearance-mode">
      <div
        className="appearance-mode__options"
        role="radiogroup"
        aria-label="Mode"
      >
        {(['light', 'dark'] as const).map((value) => (
          <label
            key={value}
            className={`appearance-mode__option${mode === value ? ' is-selected' : ''}`}
          >
            <input
              type="radio"
              className="appearance__radio"
              name="appearance-mode"
              value={value}
              checked={mode === value}
              onChange={() => onChange(value)}
            />
            {value === 'light' ? 'Light' : 'Dark'}
          </label>
        ))}
      </div>
      {!touch && !mobile && !unbound && shortcut && (
        <span className="appearance__hint">{shortcut} switches modes.</span>
      )}
    </div>
  );
}

const APPLIED_ATTRIBUTES = [
  COLOR_THEME_ATTRIBUTE,
  COLOR_THEME_FLAVOR_ATTRIBUTE,
  COLOR_THEME_ACCENT_ATTRIBUTE,
];

/**
 * A family sheet still on its way: not yet settled by the applier (which
 * marks `data-state`) and, for the startup script's own request, not yet
 * parsed either. A failed sheet is removed (lib/color-theme-apply.ts), so it
 * never counts as on its way.
 */
function sheetInFlight(): boolean {
  return [
    ...document.head.querySelectorAll<HTMLLinkElement>(
      'link[rel="stylesheet"][href*="/color-themes/"]',
    ),
  ].some((link) => !link.dataset.state && !link.sheet);
}

/** What the document root names now, and whether a sheet is in flight. */
function readAppliedSelection(): string {
  const root = document.documentElement;
  const [id, darkFlavor, accent] = APPLIED_ATTRIBUTES.map((name) =>
    root.getAttribute(name),
  );
  const named = appliedKey(
    id
      ? resolveColorThemeSelection({
          colorTheme: id,
          colorThemeFlavor: darkFlavor,
          colorThemeAccent: accent,
        })
      : { id: 'station' },
  );
  const failed = root.getAttribute(COLOR_THEME_FAILED_ATTRIBUTE) ?? '';
  return `${named}#${sheetInFlight() ? 'loading' : 'settled'}#${failed}`;
}

function subscribeAppliedSelection(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [...APPLIED_ATTRIBUTES, COLOR_THEME_FAILED_ATTRIBUTE],
  });
  observer.observe(document.head, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-state'],
  });
  return () => observer.disconnect();
}

/** The applier's own selection key, with Station as itself. */
function appliedKey(resolved: ResolvedColorTheme): string {
  return resolved.id === 'station' ? 'station' : selectionKey(resolved);
}

export function AppearancePage() {
  const settings = useDeviceSettings();
  const { setDeviceSetting, setDeviceSettings } = useDeviceSettingsActions();
  const { locale } = useLocale();
  const mode: ColorThemeMode = settings.theme === 'light' ? 'light' : 'dark';
  const resolved = resolveColorThemeSelection(settings);
  const selectedOption =
    COLOR_THEME_OPTIONS.find((option) => option.id === resolved.id) ??
    COLOR_THEME_OPTIONS[0];
  const family = resolved.id === 'station' ? null : resolved;
  const custom = customAccent(settings);
  // A different family's stylesheet loads on demand, and the applier names
  // it on the root only once it has (lib/color-theme-apply.ts). Until then
  // the choice is made but not on screen, and the card says so rather than
  // showing a tick over colours that have not changed yet.
  const applied = useSyncExternalStore(
    subscribeAppliedSelection,
    readAppliedSelection,
    readAppliedSelection,
  );
  const [named, flight, failedFamily] = applied.split('#');
  // Applied, on its way, or failed. A sheet in flight is loading (the applier
  // also lifts its failure marker while a retry is in flight); with nothing in
  // flight, the marker says this family's latest sheet failed
  // (lib/color-theme-apply.ts).
  const sheetState =
    named === appliedKey(resolved)
      ? 'applied'
      : flight === 'loading'
        ? 'loading'
        : failedFamily === resolved.id
          ? 'failed'
          : 'loading';
  const loading = sheetState === 'loading';
  const failed = sheetState === 'failed';
  // Try again sits in the notice that goes away while the retry loads, so
  // focus moves first to the choice being retried; it would otherwise drop to
  // the page body.
  const selectedRadio = useRef<HTMLInputElement | null>(null);
  const retry = () => {
    selectedRadio.current?.focus();
    retryColorTheme();
  };

  const setMode = useCallback(
    (next: ColorThemeMode) => setDeviceSetting('theme', next),
    [setDeviceSetting],
  );
  // The same shortcut, id and handler shape as the Settings ThemeToggle, so
  // ⌘H works on this page as it does there.
  useKeyboardShortcut('theme.toggle', 'h', ['cmd'], 'Toggle theme', () =>
    setMode(mode === 'dark' ? 'light' : 'dark'),
  );

  // A family starts at its own default flavor and accent. Flavor and accent
  // ids are per family, so carrying them over would pick something nobody
  // chose (Gruvbox's `red` is not Catppuccin's).
  const chooseTheme = (id: ColorThemeOption['id']) =>
    setDeviceSettings({
      colorTheme: id,
      colorThemeFlavor: null,
      colorThemeAccent: null,
    });

  // A custom hex accent wins over a theme's named accent, so choosing a named
  // one has to clear it or the choice would change nothing on screen.
  const chooseAccent = (id: string) =>
    setDeviceSettings({ colorThemeAccent: id, accentColor: null });

  const shownFlavor = family
    ? flavorOptionFor(selectedOption, mode, family)
    : undefined;
  const lightFlavor = selectedOption.flavors.find((f) => f.mode === 'light');
  const darkFlavors = selectedOption.flavors.filter((f) => f.mode === 'dark');
  const accentLabel = family
    ? selectedOption.accents.find((accent) => accent.id === family.accent)
        ?.label
    : undefined;

  return (
    <div className="appearance">
      <p className="appearance__scope">
        {formatSettingsMessage('scopeAccount', locale)}
      </p>

      <PageSection className="appearance__section">
        <PageRow
          title="Mode"
          description="Every theme has a light and a dark version."
          control={<ModeControl mode={mode} onChange={setMode} />}
        />
      </PageSection>

      <PageSection
        className="appearance__section"
        title="Theme"
        description={`Previews show ${mode} mode.`}
      >
        <div
          className="appearance-theme__grid"
          role="radiogroup"
          aria-label="Color theme"
        >
          {COLOR_THEME_OPTIONS.map((option) => {
            const preview = themePreview(option, mode, settings);
            const selected = option.id === resolved.id;
            const settling = selected && loading;
            const broken = selected && failed;
            return (
              <label
                key={option.id}
                className={`appearance-theme${selected ? ' is-selected' : ''}${settling ? ' is-loading' : ''}${broken ? ' is-failed' : ''}`}
              >
                <input
                  ref={selected ? selectedRadio : undefined}
                  type="radio"
                  className="appearance__radio"
                  name="appearance-color-theme"
                  value={option.id}
                  checked={selected}
                  onChange={() => chooseTheme(option.id)}
                />
                <ThemeThumbnail swatch={preview.swatch} />
                {selected && !settling && !broken && (
                  <span className="appearance-theme__check" aria-hidden="true">
                    <CheckGlyph />
                  </span>
                )}
                <span className="appearance-theme__name">{option.label}</span>
                <span className="appearance-theme__detail">
                  {settling
                    ? 'Loading…'
                    : broken
                      ? 'Not loaded'
                      : (preview.flavorLabel ?? 'Default')}
                </span>
              </label>
            );
          })}
        </div>
        <p className="sr-only" role="status">
          {loading
            ? `Loading ${selectedOption.label}.`
            : failed
              ? `Couldn't load ${selectedOption.label}.`
              : ''}
        </p>
        {failed && (
          <PageCallout
            calloutId="appearance-theme-failed"
            className="appearance__failed"
            tone="warning"
            ariaLabel="Theme not loaded"
            title={`Couldn't load ${selectedOption.label}.`}
            action={
              <Button size="sm" onClick={retry}>
                Try again
              </Button>
            }
          >
            The colors you had stay until it loads.
          </PageCallout>
        )}
      </PageSection>

      {family && darkFlavors.length > 1 && (
        <PageSection className="appearance__section">
          <PageRow
            title="Dark flavor"
            description={`Used in dark mode. Light mode uses ${lightFlavor?.label ?? 'the light flavor'}.`}
          >
            <div
              className="appearance-choice__row"
              role="radiogroup"
              aria-label="Dark flavor"
            >
              {darkFlavors.map((flavor) => {
                const selected = flavor.id === family.darkFlavor;
                return (
                  <label
                    key={flavor.id}
                    className={`appearance-choice${selected ? ' is-selected' : ''}`}
                  >
                    <input
                      type="radio"
                      className="appearance__radio"
                      name="appearance-flavor"
                      value={flavor.id}
                      checked={selected}
                      onChange={() =>
                        setDeviceSetting('colorThemeFlavor', flavor.id)
                      }
                    />
                    <span
                      className="appearance-choice__dot"
                      aria-hidden="true"
                      // The flavor's canvas with its accent in the corner: a
                      // swatch, not something that reads as a radio button.
                      style={{
                        background: `linear-gradient(135deg, ${flavor.swatch.background} 55%, ${flavor.swatch.accent} 55%)`,
                      }}
                    />
                    {flavor.label}
                  </label>
                );
              })}
            </div>
          </PageRow>
        </PageSection>
      )}

      <PageSection className="appearance__section">
        {family ? (
          <PageRow
            title="Accent"
            description={
              custom
                ? `Your custom accent ${custom} is in use on every theme. Choosing an accent here replaces it.`
                : `Buttons, links and focus. ${accentLabel ?? 'The default'} is selected.`
            }
          >
            <div
              className="appearance-accent__row"
              role="radiogroup"
              aria-label="Accent"
            >
              {selectedOption.accents.map((accent) => {
                const selected = !custom && accent.id === family.accent;
                const color =
                  accent.swatches[shownFlavor?.id ?? family.darkFlavor];
                return (
                  <label
                    key={accent.id}
                    className={`appearance-accent${selected ? ' is-selected' : ''}`}
                    title={accent.label}
                  >
                    <input
                      type="radio"
                      className="appearance__radio"
                      name="appearance-accent"
                      value={accent.id}
                      aria-label={accent.label}
                      checked={selected}
                      onChange={() => chooseAccent(accent.id)}
                    />
                    <span
                      className="appearance-accent__swatch"
                      aria-hidden="true"
                      style={{ background: color }}
                    />
                  </label>
                );
              })}
            </div>
          </PageRow>
        ) : (
          <AccentColorPicker description="Buttons, links and focus. A custom color also applies on other themes until you choose one of their accents." />
        )}
      </PageSection>
    </div>
  );
}

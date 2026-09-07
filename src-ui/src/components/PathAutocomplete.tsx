import { useFileSystemBrowseQuery } from '@kontourai/station-sdk';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isComposingKeyEvent } from '../lib/isComposingKeyEvent';
import { FolderGlyph } from './icons/Glyph';
import { FolderBrowserModal } from './modals/FolderBrowserModal';
import './PathAutocomplete.css';

/**
 * The rectangle an element is actually visible within: the nearest ancestor
 * that scrolls and therefore clips, or the viewport when nothing does.
 *
 * Exported so its own answer is provable without a browser fixture. `overflow`
 * is read from the computed style rather than inferred from a class name,
 * because a modal body only clips when the cascade says it does — and only the
 * FIRST such ancestor matters: anything above it clips this element only
 * through that one.
 */
export function scrollClipRect(element: Element): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  for (
    let parent = element.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    const style = getComputedStyle(parent);
    const clips = [style.overflowY, style.overflowX].some(
      (overflow) => overflow === 'auto' || overflow === 'scroll',
    );
    if (!clips) continue;
    const rect = parent.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
    };
  }
  return {
    top: 0,
    bottom: window.innerHeight,
    left: 0,
    right: window.innerWidth,
  };
}

/**
 * Is the anchor inside the rectangle that clips it?
 *
 * A zero-sized anchor answers YES. An element that has not been laid out —
 * jsdom measures nothing, and a field can render a frame before layout —
 * produces an all-zero rect, and hiding the list because a measurement is
 * unavailable would be a guess dressed as an observation. The rule this
 * function exists for is the OTHER direction: hide only when the anchor was
 * measured and is demonstrably outside.
 */
export function anchorIsWithinClip(
  anchor: { top: number; bottom: number; left: number; right: number },
  clip: { top: number; bottom: number; left: number; right: number },
): boolean {
  if (anchor.bottom === anchor.top && anchor.right === anchor.left) return true;
  return (
    anchor.bottom > clip.top &&
    anchor.top < clip.bottom &&
    anchor.right > clip.left &&
    anchor.left < clip.right
  );
}

const MAX_SUGGESTIONS = 8;

function resolveBrowsePath(value: string): string | undefined {
  const shouldSuggest = value.startsWith('/') || value.startsWith('~');
  if (!shouldSuggest) return undefined;

  if (value === '~') return '~';
  if (value === '/') return '/';

  const endsWithSlash = value.endsWith('/');
  if (endsWithSlash) {
    return value === '/' ? '/' : value.replace(/\/$/, '');
  }

  const lastSlash = value.lastIndexOf('/');
  if (value.startsWith('~/') && lastSlash === 1) {
    return '~';
  }
  if (lastSlash <= 0) {
    return value.startsWith('~') ? '~' : '/';
  }
  return value.substring(0, lastSlash);
}

function buildSuggestionPath(basePath: string, entryName: string): string {
  if (basePath === '/' || basePath === '') {
    return `/${entryName}`;
  }
  if (basePath === '~') {
    return `~/${entryName}`;
  }
  return `${basePath.replace(/\/$/, '')}/${entryName}`;
}

function normalizePathValue(value: string): string {
  if (value === '/' || value === '~') return value;
  return value.replace(/\/+$/, '');
}

function getPathLabel(path: string): string {
  if (path === '/' || path === '~') return path;
  return path.split('/').filter(Boolean).pop() ?? path;
}

export function PathAutocomplete({
  value,
  onChange,
  onSubmit,
  onBlur,
  placeholder,
  disabled,
  apiBase: _apiBase,
  className,
  id,
  autoFocus = true,
  suggestionsInitiallyOpen = true,
  browsable = false,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  disabled?: boolean;
  apiBase: string;
  className?: string;
  id?: string;
  autoFocus?: boolean;
  suggestionsInitiallyOpen?: boolean;
  /**
   * Opt-in Browse affordance (#1014): renders a button beside the input that
   * opens the shared `FolderBrowserModal`. Off by default so existing
   * callers are unaffected until they adopt it.
   */
  browsable?: boolean;
  /** Set when the host has a field-level error to bind to this input. */
  'aria-invalid'?: boolean | undefined;
  'aria-describedby'?: string | undefined;
}) {
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [userDismissed, setUserDismissed] = useState(false);
  const [active, setActive] = useState(suggestionsInitiallyOpen);
  const [showBrowser, setShowBrowser] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pickingRef = useRef(false);
  const outsidePointerRef = useRef(false);
  const pickingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards the input's own 200ms blur-dismiss timer while the folder browser
  // is open. Without this, a blur timer scheduled the instant Browse steals
  // focus can fire well after the dialog closes and the input regains focus
  // — dismissing suggestions the user just reopened by refocusing/typing.
  // That race is exactly the #998 class this component's mount identity is
  // designed to avoid (the modal renders as a sibling here; the input never
  // unmounts), so this guard is belt-and-braces against the same failure
  // mode reappearing through a different trigger.
  const browsingRef = useRef(false);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const shouldSuggest = value.startsWith('/') || value.startsWith('~');
  const endsWithSlash = value.endsWith('/');
  const browsePath = resolveBrowsePath(value);
  const normalizedValue = normalizePathValue(value);
  const prefix = !shouldSuggest
    ? ''
    : endsWithSlash
      ? ''
      : value.substring(value.lastIndexOf('/') + 1).toLowerCase();

  const { data } = useFileSystemBrowseQuery(browsePath, {
    enabled: shouldSuggest,
  });

  const suggestions = useMemo(() => {
    if (!shouldSuggest || !browsePath) {
      return [];
    }
    const items: Array<{
      badge: string;
      label: string;
      path: string;
      variant: 'exact' | 'directory';
    }> = [];
    const seen = new Set<string>();
    const hasExactParentMatch =
      !endsWithSlash &&
      !!prefix &&
      (data?.entries ?? []).some(
        (entry) => entry.isDirectory && entry.name.toLowerCase() === prefix,
      );

    if (hasExactParentMatch) {
      const exactPath = normalizedValue;
      if (exactPath && !seen.has(exactPath)) {
        seen.add(exactPath);
        items.push({
          path: exactPath,
          label: getPathLabel(exactPath),
          badge: 'folder',
          variant: 'exact',
        });
      }
    }

    for (const entry of data?.entries ?? []) {
      if (!entry.isDirectory) continue;
      // Prefix match (not substring): typing "de" must surface `dev`/`Desktop`
      // but never `.codex`/`.claude`, which only *contain* "de".
      if (prefix && !entry.name.toLowerCase().startsWith(prefix)) continue;

      const path = buildSuggestionPath(browsePath, entry.name);
      if (seen.has(path)) continue;
      seen.add(path);
      items.push({
        path,
        label: entry.name,
        badge: entry.name.toLowerCase() === prefix ? 'folder' : 'match',
        variant: 'directory',
      });
    }

    // Exact match first, then prefix matches alphabetically; cap the list so
    // a wide directory does not flood the dropdown.
    items.sort((a, b) => {
      if (a.variant === 'exact' && b.variant !== 'exact') return -1;
      if (b.variant === 'exact' && a.variant !== 'exact') return 1;
      const aExact = a.label.toLowerCase() === prefix;
      const bExact = b.label.toLowerCase() === prefix;
      if (aExact !== bExact) return aExact ? -1 : 1;
      return a.label.localeCompare(b.label);
    });

    return items.slice(0, MAX_SUGGESTIONS);
  }, [
    browsePath,
    data?.entries,
    endsWithSlash,
    normalizedValue,
    prefix,
    shouldSuggest,
  ]);

  const wouldShow = active && !userDismissed && suggestions.length > 0;
  /*
   * #1582 E6. The list is `position: absolute` inside the field, so it moves
   * with its input already — what it did NOT do is stop rendering when the
   * input left the scrollport it lives in. Scrolling the New Project modal's
   * body by 220px put the input 177px above the visible area while the list,
   * which hangs below the input and is taller than the gap, still painted 138px
   * of itself over the Description field: a suggestion list with no field,
   * anchored to something the reader cannot see.
   *
   * Measured rather than assumed: the input's rect against the rect of the
   * nearest scrollable ancestor. It re-evaluates on any scroll (capture, so
   * scrolls inside the modal body are seen) and on resize, and it is only ever
   * a display decision — nothing is dismissed, so scrolling back reveals the
   * same list with the same selection.
   */
  const [anchorVisible, setAnchorVisible] = useState(true);
  useEffect(() => {
    if (!wouldShow) return;
    const measure = () => {
      const input = inputRef.current;
      if (!input) return;
      setAnchorVisible(
        anchorIsWithinClip(
          input.getBoundingClientRect(),
          scrollClipRect(input),
        ),
      );
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [wouldShow]);
  const show = wouldShow && anchorVisible;

  const dismiss = useCallback(() => {
    setSelectedIdx(-1);
    setUserDismissed(true);
    setActive(false);
  }, []);

  // A blur can be armed for reasons that have nothing to do with the user
  // choosing to leave the field (e.g. a remount elsewhere in the tree
  // stealing then returning focus). If the input is re-engaged before the
  // 200ms blur timer fires, that timer is stale and must not dismiss a
  // dropdown the user never asked to close.
  const cancelBlurTimer = useCallback(() => {
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!show) return;
    const isInside = (target: EventTarget | null) =>
      target instanceof Node && !!rootRef.current?.contains(target);
    const onPointerDown = (event: PointerEvent) => {
      outsidePointerRef.current = !isInside(event.target);
    };
    const onFocusIn = (event: FocusEvent) => {
      // A pointer press moves focus before the ensuing click. On mobile the
      // suggestion list participates in layout, so removing it here would
      // move the intended target out from under the pointer. Let the click
      // complete, then dismiss the list.
      if (!outsidePointerRef.current && !isInside(event.target)) dismiss();
    };
    const onClick = (event: MouseEvent) => {
      if (outsidePointerRef.current && !isInside(event.target)) dismiss();
      outsidePointerRef.current = false;
    };
    const onPointerCancel = () => {
      if (outsidePointerRef.current) dismiss();
      outsidePointerRef.current = false;
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('click', onClick);
    document.addEventListener('pointercancel', onPointerCancel, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('click', onClick);
      document.removeEventListener('pointercancel', onPointerCancel, true);
    };
  }, [dismiss, show]);

  useEffect(
    () => () => {
      if (pickingTimerRef.current) clearTimeout(pickingTimerRef.current);
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    },
    [],
  );

  // Keyed on `value` (what the user actually typed), not `suggestions` (the
  // async-arriving browse-query data derived from it) — an explicit Escape
  // dismissal (`setUserDismissed(true)`) must stay dismissed for that same
  // value even if the in-flight filesystem browse query for it resolves
  // afterwards; only the user typing something new should re-open the
  // dropdown. Discovered via s202 Wave 4's full Playwright run: a delayed
  // `useFileSystemBrowseQuery` resolution after Escape was silently
  // re-opening the dropdown over whatever button sat below it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: value is an intentional trigger, not read in the body.
  useEffect(() => {
    setSelectedIdx(-1);
    setUserDismissed(false);
  }, [value]);

  const pick = (path: string) => {
    pickingRef.current = true;
    onChange(`${path}/`);
    setUserDismissed(false);
    setActive(true);
    inputRef.current?.focus();
    if (pickingTimerRef.current) clearTimeout(pickingTimerRef.current);
    pickingTimerRef.current = setTimeout(() => {
      pickingRef.current = false;
    }, 300);
  };

  const openBrowser = () => {
    // Cancel any dismiss timer the ensuing blur (Browse stealing focus) is
    // about to schedule or has already scheduled — mousedown moves focus,
    // and therefore fires the input's blur handler, before this click
    // handler runs.
    cancelBlurTimer();
    browsingRef.current = true;
    // Hide the suggestion dropdown while the folder browser dialog is open
    // — the two would otherwise render on top of each other.
    dismiss();
    setShowBrowser(true);
  };

  const handleBrowserSelect = (path: string) => {
    onChange(`${path}/`);
    setUserDismissed(false);
    setActive(true);
  };

  const handleBrowserClose = () => {
    browsingRef.current = false;
    setShowBrowser(false);
    // Return focus to the input synchronously, ahead of the dialog's own
    // unmount and return-focus restore, so a later stale timer or a
    // trigger-button restore cannot leave the suggestion dropdown out of
    // sync with what is actually focused (the #998 class).
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Escape is also meaningful while the browse request is still in flight.
    // Mark the current value dismissed before suggestions exist so a late
    // response cannot open the dropdown over the next control.
    if (e.key === 'Escape') {
      e.preventDefault();
      dismiss();
      inputRef.current?.blur();
      return;
    }
    if (!show || suggestions.length === 0) {
      if (e.key === 'Enter' && !isComposingKeyEvent(e)) {
        onSubmit?.();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const exactSuggestion = suggestions.find(
        (suggestion) => suggestion.variant === 'exact',
      );
      if (exactSuggestion) {
        pick(exactSuggestion.path);
      } else if (suggestions.length === 1) {
        pick(suggestions[0].path);
      } else if (suggestions.length > 1) {
        setSelectedIdx((i) => (i + 1) % suggestions.length);
      }
    } else if (e.key === 'Enter' && !isComposingKeyEvent(e)) {
      if (selectedIdx >= 0) {
        e.preventDefault();
        pick(suggestions[selectedIdx].path);
      } else {
        const exactSuggestion = suggestions.find(
          (suggestion) => suggestion.variant === 'exact',
        );
        if (exactSuggestion) {
          e.preventDefault();
          pick(exactSuggestion.path);
        } else if (suggestions.length === 1) {
          e.preventDefault();
          pick(suggestions[0].path);
        } else {
          dismiss();
          onSubmit?.();
        }
      }
    }
  };

  return (
    <div className="path-autocomplete" ref={rootRef}>
      <div className="path-autocomplete__row">
        <input
          id={id}
          ref={inputRef}
          className={className ?? 'editor-input path-autocomplete__input'}
          type="text"
          value={value}
          onChange={(e) => {
            cancelBlurTimer();
            onChange(e.target.value);
            setUserDismissed(false);
            setActive(true);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (browsingRef.current) return;
            if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
            blurTimerRef.current = setTimeout(() => {
              if (!pickingRef.current) {
                dismiss();
                onBlur?.();
              }
            }, 200);
          }}
          onFocus={() => {
            cancelBlurTimer();
            setUserDismissed(false);
            setActive(true);
          }}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={ariaInvalid}
          aria-describedby={ariaDescribedBy}
        />
        {browsable && (
          <button
            type="button"
            className="path-autocomplete__browse-btn"
            onClick={openBrowser}
            disabled={disabled}
            title="Browse for a folder"
            aria-label="Browse for a folder"
          >
            <FolderGlyph />
          </button>
        )}
      </div>
      {browsable && showBrowser && (
        <FolderBrowserModal
          initialPath={resolveBrowsePath(value) ?? ''}
          onSelect={handleBrowserSelect}
          onClose={handleBrowserClose}
        />
      )}
      {show && (
        <div className="path-autocomplete__dropdown">
          {suggestions.map((suggestion, i) => (
            <button
              key={suggestion.path}
              className={`path-autocomplete__option${
                i === selectedIdx ? ' path-autocomplete__option--selected' : ''
              }`}
              onPointerDown={() => pick(suggestion.path)}
              type="button"
            >
              <span className="path-autocomplete__icon">
                <FolderGlyph />
              </span>
              <span className="path-autocomplete__content">
                <span className="path-autocomplete__label-row">
                  <span className="path-autocomplete__label">
                    {suggestion.label}
                  </span>
                  <span className="path-autocomplete__badge">
                    {suggestion.badge}
                  </span>
                </span>
                <span className="path-autocomplete__path">
                  {suggestion.path}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

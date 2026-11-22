import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { navigationStore } from '../contexts/navigation-store';

interface SectionNavigationOptions {
  queryKey?: string;
  legacyQueryKey?: string;
  sectionAliases?: Readonly<Record<string, string>>;
  /** A leaf reveal is consumed when someone intentionally chooses a section. */
  clearHighlightOnNavigate?: boolean;
  /** Selected panels can take focus without scrolling the page chrome away. */
  scrollOnNavigate?: boolean;
}

function currentSection(
  allowed: readonly string[],
  fallback: string,
  queryKey: string,
  legacyQueryKey?: string,
  aliases: Readonly<Record<string, string>> = {},
) {
  const params = new URLSearchParams(window.location.search);
  const value =
    params.get(queryKey) ??
    (legacyQueryKey ? params.get(legacyQueryKey) : null);
  const section = value ? (aliases[value] ?? value) : null;
  return section && allowed.includes(section) ? section : fallback;
}

function focusSection(section: string, scroll = true) {
  const reveal = () => {
    const target = document.getElementById(`section-${section}`);
    if (!target) return false;
    // A background route must not scroll or take focus from an open dialog.
    if (
      [...document.querySelectorAll('[aria-modal="true"], dialog[open]')].some(
        (modal) => !modal.contains(target),
      )
    )
      return true;
    if (scroll && typeof target?.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'start' });
    }
    target?.focus({ preventScroll: true });
    return true;
  };

  let observer: MutationObserver | undefined;
  let timer: number | undefined;
  const frame = window.requestAnimationFrame(() => {
    if (reveal()) return;

    const retainedObserver = new MutationObserver(() => {
      if (reveal()) retainedObserver.disconnect();
    });
    observer = retainedObserver;
    retainedObserver.observe(document.body, { childList: true, subtree: true });
    timer = window.setTimeout(() => observer?.disconnect(), 5_000);
  });
  return () => {
    window.cancelAnimationFrame(frame);
    observer?.disconnect();
    if (timer !== undefined) window.clearTimeout(timer);
  };
}

/** Keeps bounded page-section navigation in a validated, shareable URL query. */
export function useSectionNavigation(
  allowedSections: readonly string[],
  fallbackSection = allowedSections[0] ?? '',
  options: SectionNavigationOptions = {},
) {
  const queryKey = options.queryKey ?? 'section';
  const legacyQueryKey = options.legacyQueryKey;
  const aliasesKey = JSON.stringify(options.sectionAliases ?? {});
  const aliases = useMemo<Record<string, string>>(
    () => JSON.parse(aliasesKey),
    [aliasesKey],
  );
  const clearHighlightOnNavigate = options.clearHighlightOnNavigate ?? false;
  const scrollOnNavigate = options.scrollOnNavigate ?? true;
  const allowedKey = allowedSections.join('\u0000');
  const allowed = useMemo(
    () => allowedKey.split('\u0000').filter(Boolean),
    [allowedKey],
  );
  const [activeSection, setActiveSection] = useState(() =>
    currentSection(allowed, fallbackSection, queryKey, legacyQueryKey, aliases),
  );
  const cancelFocusRef = useRef<(() => void) | undefined>(undefined);

  const syncFromLocation = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    const requested =
      params.get(queryKey) ??
      (legacyQueryKey ? params.get(legacyQueryKey) : null);
    const next = currentSection(
      allowed,
      fallbackSection,
      queryKey,
      legacyQueryKey,
      aliases,
    );

    const hasHighlight = params.has('highlight');
    if (requested && !allowed.includes(aliases[requested] ?? requested)) {
      const url = new URL(window.location.href);
      url.searchParams.delete(queryKey);
      if (legacyQueryKey) url.searchParams.delete(legacyQueryKey);
      window.history.replaceState(window.history.state, '', url);
    } else if (
      requested &&
      ((legacyQueryKey && params.has(legacyQueryKey)) || aliases[requested])
    ) {
      // Fold published section aliases into the current destination without
      // adding a Back entry or disturbing other query parameters.
      const url = new URL(window.location.href);
      url.searchParams.set(queryKey, next);
      if (legacyQueryKey) url.searchParams.delete(legacyQueryKey);
      window.history.replaceState(window.history.state, '', url);
    }

    setActiveSection(next);
    cancelFocusRef.current?.();
    // A catalog leaf owns focus for `highlight`; section focus must never
    // race it and steal the final destination.
    cancelFocusRef.current =
      requested &&
      allowed.includes(aliases[requested] ?? requested) &&
      !hasHighlight
        ? focusSection(next, scrollOnNavigate)
        : undefined;
  }, [
    aliases,
    allowed,
    fallbackSection,
    legacyQueryKey,
    queryKey,
    scrollOnNavigate,
  ]);

  useEffect(() => {
    syncFromLocation();
    window.addEventListener('popstate', syncFromLocation);
    return () => {
      window.removeEventListener('popstate', syncFromLocation);
      cancelFocusRef.current?.();
    };
  }, [syncFromLocation]);

  const hrefForSection = useCallback(
    (section: string) => {
      const url = new URL(window.location.href);
      url.searchParams.set(queryKey, section);
      if (legacyQueryKey) url.searchParams.delete(legacyQueryKey);
      if (clearHighlightOnNavigate) url.searchParams.delete('highlight');
      return `${url.pathname}${url.search}${url.hash}`;
    },
    [clearHighlightOnNavigate, legacyQueryKey, queryKey],
  );

  const navigateToSection = useCallback(
    (section: string) => {
      if (!allowed.includes(section)) return;
      const url = new URL(window.location.href);
      url.searchParams.set(queryKey, section);
      if (legacyQueryKey) url.searchParams.delete(legacyQueryKey);
      if (clearHighlightOnNavigate) url.searchParams.delete('highlight');
      if (clearHighlightOnNavigate) {
        // Settings owns dirty drafts, so its same-page selections must traverse
        // the canonical writer (history index + unsaved guard) rather than
        // copying an opaque history state into pushState.
        navigationStore.navigate(`${url.pathname}${url.search}${url.hash}`, {
          highlight: null,
          ...(legacyQueryKey ? { [legacyQueryKey]: null } : {}),
        });
      } else {
        // Other bounded section users retain their pre-existing lightweight
        // query navigation semantics.
        window.history.pushState(window.history.state, '', url);
        setActiveSection(section);
        cancelFocusRef.current?.();
        cancelFocusRef.current = focusSection(section, scrollOnNavigate);
      }
    },
    [
      allowed,
      clearHighlightOnNavigate,
      legacyQueryKey,
      queryKey,
      scrollOnNavigate,
    ],
  );

  return { activeSection, hrefForSection, navigateToSection };
}

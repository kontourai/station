import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { navigationStore } from '../contexts/navigation-store';

interface SectionNavigationOptions {
  queryKey?: string;
  legacyQueryKey?: string;
  /** A leaf reveal is consumed when someone intentionally chooses a section. */
  clearHighlightOnNavigate?: boolean;
}

function currentSection(
  allowed: readonly string[],
  fallback: string,
  queryKey: string,
  legacyQueryKey?: string,
) {
  const params = new URLSearchParams(window.location.search);
  const value =
    params.get(queryKey) ??
    (legacyQueryKey ? params.get(legacyQueryKey) : null);
  return value && allowed.includes(value) ? value : fallback;
}

function focusSection(section: string) {
  const reveal = () => {
    const target = document.getElementById(`section-${section}`);
    if (!target) return false;
    if (typeof target?.scrollIntoView === 'function') {
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
  const clearHighlightOnNavigate = options.clearHighlightOnNavigate ?? false;
  const allowedKey = allowedSections.join('\u0000');
  const allowed = useMemo(
    () => allowedKey.split('\u0000').filter(Boolean),
    [allowedKey],
  );
  const [activeSection, setActiveSection] = useState(() =>
    currentSection(allowed, fallbackSection, queryKey, legacyQueryKey),
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
    );

    const hasHighlight = params.has('highlight');
    if (requested && !allowed.includes(requested)) {
      const url = new URL(window.location.href);
      url.searchParams.delete(queryKey);
      if (legacyQueryKey) url.searchParams.delete(legacyQueryKey);
      window.history.replaceState(window.history.state, '', url);
    } else if (requested && legacyQueryKey && params.has(legacyQueryKey)) {
      // `section` was the old Settings spelling. Fold it into the canonical
      // `view` key without adding a Back entry or disturbing shell/locale
      // params owned by other surfaces.
      const url = new URL(window.location.href);
      url.searchParams.set(queryKey, next);
      url.searchParams.delete(legacyQueryKey);
      window.history.replaceState(window.history.state, '', url);
    }

    setActiveSection(next);
    cancelFocusRef.current?.();
    // A catalog leaf owns focus for `highlight`; section focus must never
    // race it and steal the final destination.
    cancelFocusRef.current =
      requested && allowed.includes(requested) && !hasHighlight
        ? focusSection(next)
        : undefined;
  }, [allowed, fallbackSection, legacyQueryKey, queryKey]);

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
        cancelFocusRef.current = focusSection(section);
      }
    },
    [allowed, clearHighlightOnNavigate, legacyQueryKey, queryKey],
  );

  return { activeSection, hrefForSection, navigateToSection };
}

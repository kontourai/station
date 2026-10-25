import { BROWSER_PANE_TAB_LIMIT } from '@kontourai/station-contracts/workspace-browser-pane';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { CloseGlyph, PlusGlyph } from '../../components/icons/Glyph';
import {
  type BrowserPaneApi,
  browserPaneKeys,
  describeBrowserFailure,
} from './browserPaneApi';

export function BrowserTabs({
  apiBase,
  api,
  projectSlug,
  ids,
  selected,
  onSelect,
  onChange,
}: {
  apiBase: string;
  api: BrowserPaneApi;
  projectSlug: string;
  ids: string[];
  selected: string;
  onSelect: (id: string) => void;
  onChange: (ids: string[], selected: string) => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [closedUrl, setClosedUrl] = useState<string | null>(null);
  const closedIds = useRef(new Set<string>());
  const sessions = useQuery({
    queryKey: browserPaneKeys.sessions(apiBase, projectSlug),
    queryFn: ({ signal }) => api.sessions(projectSlug, signal),
    refetchInterval: 3_000,
    retry: false,
  });
  useEffect(() => {
    if (sessions.data) {
      const liveIds = new Set(
        sessions.data.map((entry) => entry.browserSessionId),
      );
      for (const id of closedIds.current)
        if (!liveIds.has(id)) closedIds.current.delete(id);
    }
    const popup = sessions.data?.find(
      (entry) =>
        entry.state === 'live' &&
        entry.openerBrowserSessionId &&
        ids.includes(entry.openerBrowserSessionId) &&
        !ids.includes(entry.browserSessionId) &&
        !closedIds.current.has(entry.browserSessionId),
    );
    if (popup && ids.length < BROWSER_PANE_TAB_LIMIT)
      onChange([...ids, popup.browserSessionId], popup.browserSessionId);
  }, [sessions.data, ids, onChange]);
  const create = useMutation({
    mutationFn: (url: string) => api.create({ projectSlug, url }),
    onSuccess: (next, url) => {
      setNotice(null);
      if (url === closedUrl) setClosedUrl(null);
      onSelect(next.browserSessionId);
    },
    onError: (error) => setNotice(describeBrowserFailure(error)),
  });
  const close = useMutation({
    mutationFn: (id: string) => api.close(id),
    onSuccess: (_, id) => {
      closedIds.current.add(id);
      setClosedUrl(
        sessions.data?.find((entry) => entry.browserSessionId === id)?.url ??
          null,
      );
      const remaining = ids.filter((candidate) => candidate !== id);
      const next =
        id === selected
          ? remaining[Math.min(ids.indexOf(id), remaining.length - 1)]
          : selected;
      if (next) onChange(remaining, next);
      setNotice(null);
    },
    onError: (error) => setNotice(describeBrowserFailure(error)),
  });
  return (
    <>
      <section className="browser-tabs" aria-label="Browser tabs">
        <div className="browser-tabs__list" role="tablist" aria-label="Pages">
          {ids.map((id, index) => {
            const session = sessions.data?.find(
              (entry) => entry.browserSessionId === id,
            );
            const url = session?.url;
            const label =
              url === 'about:blank'
                ? 'New tab'
                : session?.title || url || 'Browser page';
            return (
              <div className="browser-tabs__item" key={id}>
                <button
                  type="button"
                  className="browser-tabs__tab"
                  role="tab"
                  aria-selected={id === selected}
                  tabIndex={id === selected ? 0 : -1}
                  title={label}
                  onClick={() => onSelect(id)}
                  onKeyDown={(event) => {
                    const direction =
                      event.key === 'ArrowLeft'
                        ? -1
                        : event.key === 'ArrowRight'
                          ? 1
                          : 0;
                    if (!direction) return;
                    event.preventDefault();
                    const nextIndex =
                      (index + direction + ids.length) % ids.length;
                    if (event.altKey) {
                      const reordered = [...ids];
                      [reordered[index], reordered[nextIndex]] = [
                        reordered[nextIndex],
                        reordered[index],
                      ];
                      onChange(reordered, selected);
                    } else {
                      onSelect(ids[nextIndex]);
                      const tablist =
                        event.currentTarget.closest('[role="tablist"]');
                      tablist
                        ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                        [nextIndex]?.focus();
                    }
                  }}
                >
                  {label}
                </button>
                <IconButton
                  className="browser-tabs__close"
                  aria-label={`Close ${label}`}
                  disabled={ids.length === 1 || close.isPending}
                  onClick={() => close.mutate(id)}
                >
                  <CloseGlyph />
                </IconButton>
              </div>
            );
          })}
        </div>
        <IconButton
          aria-label="New tab"
          disabled={ids.length >= BROWSER_PANE_TAB_LIMIT || create.isPending}
          onClick={() => create.mutate('about:blank')}
          title={`New tab (up to ${BROWSER_PANE_TAB_LIMIT} per pane)`}
        >
          <PlusGlyph />
        </IconButton>
        {closedUrl ? (
          <Button
            disabled={ids.length >= BROWSER_PANE_TAB_LIMIT || create.isPending}
            onClick={() => create.mutate(closedUrl)}
          >
            Reopen tab
          </Button>
        ) : null}
      </section>
      {notice ? <p role="status">{notice}</p> : null}
    </>
  );
}

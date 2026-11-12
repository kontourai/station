import {
  HTML_REPLY_THEME_KEYS,
  type HtmlReplyPage,
  type HtmlReplyTheme,
} from '@kontourai/station-contracts/html-reply';
import { buildHtmlReplyDocument } from '@kontourai/station-shared/html-reply-document';
import { useEffect, useMemo, useRef, useState } from 'react';
import { observeRootTheme } from '../../lib/root-theme';
import { openNativeExternalLink } from '../../platform/openExternalLink';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { isDistinctFrameOrigin } from '../mcp-ui/frameOrigin';
import { ConfirmModal } from '../modals/ConfirmModal';
import './HtmlReply.css';

const TOKENS = [
  'bg',
  'text',
  'text-muted',
  'line',
  'action',
  'negative',
  'positive',
  'caution',
  'action',
  'active',
  'positive',
  'caution',
  'negative',
  'brand',
  'radius-md',
  'font-ui',
  'font-mono',
];

/** Station's theme as the page's tokens, read from the live root styles. */
function readThemeTokens(): HtmlReplyTheme {
  const computed = getComputedStyle(document.documentElement);
  const tokens: HtmlReplyTheme = {};
  HTML_REPLY_THEME_KEYS.forEach((key, index) => {
    tokens[key] = computed.getPropertyValue(`--k-${TOKENS[index]}`).trim();
  });
  return tokens;
}

/**
 * The theme as CSS for the opaque frame, whose inline scripts the app's own
 * CSP may refuse. A value that could break out of the rule is dropped.
 */
function themeStyle(tokens: HtmlReplyTheme, theme: 'light' | 'dark'): string {
  const declarations = Object.entries(tokens)
    .filter(
      ([, value]) =>
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 256 &&
        !/[;{}<>\\]/.test(value),
    )
    .map(([key, value]) => `--${key}:${value};`)
    .join('');
  return `<style>:root{${declarations}color-scheme:${theme === 'light' ? 'light' : 'dark'}}</style>`;
}

/**
 * Viewer primitive. Conversation publication/placement is a separate slice.
 * With a reachable frame origin the page loads through its proxy; without one
 * (#4821) it renders in an opaque-origin sandbox.
 */
export function HtmlReply({
  page,
  frameOrigin,
  theme,
}: {
  page: HtmlReplyPage;
  frameOrigin: string;
  theme: 'light' | 'dark';
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [link, setLink] = useState<string | null>(null);
  const linksMuted = useRef(false);
  const [canOpenLink, setCanOpenLink] = useState(false);
  useEffect(() => {
    setCanOpenLink(false);
    if (!link) return;
    const timer = setTimeout(() => setCanOpenLink(true), 500);
    return () => clearTimeout(timer);
  }, [link]);
  const distinct =
    isDistinctFrameOrigin(frameOrigin) &&
    /^https?:$/.test(new URL(frameOrigin).protocol);
  const origin = distinct ? new URL(frameOrigin).origin : '';
  const [opaqueTokens, setOpaqueTokens] = useState<HtmlReplyTheme | null>(null);
  useEffect(() => {
    if (distinct) return;
    const update = () => setOpaqueTokens(readThemeTokens());
    update();
    return observeRootTheme(update);
  }, [distinct]);
  const opaqueDocument = useMemo(
    () =>
      distinct || !opaqueTokens
        ? null
        : buildHtmlReplyDocument(themeStyle(opaqueTokens, theme) + page.html),
    [distinct, opaqueTokens, theme, page.html],
  );
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        // The opaque-origin sandbox reports its origin as "null".
        event.origin !== (distinct ? origin : 'null')
      )
        return;
      // Only the distinct-origin proxy loads the page by message.
      if (distinct && event.data?.type === 'html-reply-ready') setReady(origin);
      if (
        event.data?.type === 'html-reply-link' &&
        navigator.userActivation?.isActive &&
        !linksMuted.current &&
        typeof event.data.url === 'string' &&
        event.data.url.length <= 2048
      ) {
        try {
          const url = new URL(event.data.url);
          if (url.protocol === 'https:' || url.protocol === 'http:')
            setLink((current) => current ?? url.href);
        } catch {}
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [distinct, origin]);
  useEffect(() => {
    if (ready === origin)
      frame.current?.contentWindow?.postMessage(
        { type: 'html-reply-load', html: page.html },
        origin,
      );
  }, [ready, page.html, origin]);
  useEffect(() => {
    if (ready !== origin) return;
    const update = () => {
      frame.current?.contentWindow?.postMessage(
        { type: 'html-reply-theme', tokens: readThemeTokens(), theme },
        origin,
      );
    };
    update();
    // Light/dark, palette (data-color-theme*), accent and branding changes.
    return observeRootTheme(update);
  }, [ready, origin, theme]);
  const viewer = (
    <span className="html-reply">
      <span className="html-reply__controls">
        <Button
          variant="ghost"
          onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
          disabled={zoom <= 0.5}
          aria-label="Zoom out"
        >
          −
        </Button>
        <Button
          variant="ghost"
          onClick={() => setZoom(1)}
          aria-label="Reset zoom"
        >
          {Math.round(zoom * 100)}%
        </Button>
        <Button
          variant="ghost"
          onClick={() => setZoom((value) => Math.min(2, value + 0.25))}
          disabled={zoom >= 2}
          aria-label="Zoom in"
        >
          +
        </Button>
        {!expanded && (
          <Button
            variant="ghost"
            onClick={() => {
              setReady(null);
              setExpanded(true);
            }}
          >
            Expand
          </Button>
        )}
      </span>
      <span
        className="html-reply__viewport"
        style={{ height: expanded ? '70dvh' : page.height }}
      >
        {distinct ? (
          <iframe
            ref={frame}
            title="Visual reply"
            src={`${origin}/html-reply/frame`}
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
            onLoad={() => {
              setReady(null);
              frame.current?.contentWindow?.postMessage(
                { type: 'html-reply-connect' },
                origin,
              );
            }}
            style={{
              width: `${100 / zoom}%`,
              height: `${100 / zoom}%`,
              transform: `scale(${zoom})`,
              transformOrigin: 'top left',
            }}
          />
        ) : opaqueDocument ? (
          <iframe
            ref={frame}
            title="Visual reply"
            // No allow-same-origin: an opaque origin cannot reach Station's.
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={opaqueDocument}
            style={{
              width: `${100 / zoom}%`,
              height: `${100 / zoom}%`,
              transform: `scale(${zoom})`,
              transformOrigin: 'top left',
            }}
          />
        ) : null}
      </span>
    </span>
  );
  return (
    <>
      {expanded ? (
        <Dialog
          title="Visual reply"
          closeLabel="Close visual reply"
          onClose={() => {
            setReady(null);
            setExpanded(false);
          }}
          panelClassName="html-reply__dialog"
        >
          {viewer}
        </Dialog>
      ) : (
        viewer
      )}
      {link && (
        <ConfirmModal
          title="Open link from visual reply?"
          message={link}
          isOpen
          confirmLabel="Open link"
          confirmDisabled={!canOpenLink}
          onCancel={() => {
            linksMuted.current = true;
            setLink(null);
          }}
          onConfirm={() => {
            if (!canOpenLink) return;
            const url = link;
            setLink(null);
            void openNativeExternalLink(url).then((result) => {
              if (result === null)
                window.open(url, '_blank', 'noopener,noreferrer');
            });
          }}
        />
      )}
    </>
  );
}

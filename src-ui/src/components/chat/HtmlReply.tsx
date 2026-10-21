import {
  HTML_REPLY_THEME_KEYS,
  type HtmlReplyPage,
  type HtmlReplyTheme,
} from '@kontourai/station-contracts/html-reply';
import { useEffect, useRef, useState } from 'react';
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

/** Viewer primitive. Conversation publication/placement is a separate slice. */
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
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        !distinct ||
        event.source !== frame.current?.contentWindow ||
        event.origin !== origin
      )
        return;
      if (event.data?.type === 'html-reply-ready') setReady(origin);
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
      const computed = getComputedStyle(document.documentElement);
      const tokens: HtmlReplyTheme = {};
      HTML_REPLY_THEME_KEYS.forEach((key, index) => {
        tokens[key] = computed.getPropertyValue(`--k-${TOKENS[index]}`).trim();
      });
      frame.current?.contentWindow?.postMessage(
        { type: 'html-reply-theme', tokens, theme },
        origin,
      );
    };
    update();
    // Light/dark, palette (data-color-theme*), accent and branding changes.
    return observeRootTheme(update);
  }, [ready, origin, theme]);
  const viewer = (
    <div className="html-reply">
      <div className="html-reply__controls">
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
      </div>
      <div
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
        ) : (
          <p>Visual replies require an isolated frame origin.</p>
        )}
      </div>
    </div>
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

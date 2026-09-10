/**
 * archive#3354 — shared chrome for a code block: language header + copy
 * button, then highlighted HTML or a plain <pre>. Lives in its own module so
 * its one consumer — the async markdown renderer's code component
 * (`HighlightedCodeBlock`) — can use it WITHOUT pulling it into the entry
 * chunk.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { copyToClipboard } from '../../lib/clipboard';
import { triggerHaptic } from '../../platform/native/haptics';
import { Button } from '../Button';
import { CheckGlyph } from '../icons/Glyph';
import { ResponsiveSurfaceActions } from '../ResponsiveDialogSurface';
import './CodeBlockFrame.css';

export function CodeBlockFrame({
  lang,
  code,
  html,
}: {
  lang: string;
  code: string;
  html: string | null;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [repeatActions, setRepeatActions] = useState(false);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const viewport = body.closest<HTMLElement>('.chat-messages');
    const measure = () => {
      const pageHeight = viewport?.clientHeight || window.innerHeight;
      setRepeatActions(body.getBoundingClientRect().height > pageHeight);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    if (viewport) observer.observe(viewport);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // "Copied" is only ever shown for a clipboard write that resolved
  // (archive#3339, the same defect as #3317's dir-path button). Station is
  // routinely reached over plain http:// from another device, where
  // `navigator.clipboard` does not exist at all, and a permission refusal
  // rejects — the old `clipboard?.writeText(code)` no-opped or threw into an
  // unhandled rejection and reported success either way.
  //
  // Unlike the #3317 button this needs no live region: its accessible name is
  // name-from-content, so the label change IS the name change. There is no
  // fixed `aria-label` pinning the name past the state.
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  const copyResetRef = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (copyResetRef.current !== undefined) {
        window.clearTimeout(copyResetRef.current);
      }
    },
    [],
  );

  const handleCopy = useCallback(async () => {
    const copied = await copyToClipboard(code);
    if (copied) triggerHaptic('light');
    setCopyState(copied ? 'copied' : 'failed');
    if (copyResetRef.current !== undefined) {
      window.clearTimeout(copyResetRef.current);
    }
    copyResetRef.current = window.setTimeout(() => setCopyState('idle'), 1500);
  }, [code]);

  const actions = (
    <ResponsiveSurfaceActions className="code-block-actions">
      <span>{lang}</span>
      <Button
        variant="ghost"
        onClick={() => void handleCopy()}
        title={
          copyState === 'failed'
            ? 'This browser refused clipboard access — select the code to copy it manually.'
            : 'Copy code'
        }
      >
        {copyState === 'copied' ? (
          <>
            <CheckGlyph /> Copied
          </>
        ) : copyState === 'failed' ? (
          "Can't copy"
        ) : (
          'Copy'
        )}
      </Button>
    </ResponsiveSurfaceActions>
  );
  return (
    <div className="code-block-frame">
      {actions}
      <div ref={bodyRef} className="code-block-body">
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre>
            <code>{code}</code>
          </pre>
        )}
      </div>
      {repeatActions && actions}
    </div>
  );
}

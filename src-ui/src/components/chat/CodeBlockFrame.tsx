/**
 * station#3354 — shared chrome for a code block: language header + copy
 * button, then highlighted HTML or a plain <pre>. Lives in its own module so
 * both the async markdown renderer's code component
 * (`HighlightedCodeBlock`) and the streaming open-fence block
 * (`StreamingOpenFence`) share it WITHOUT pulling either into the entry
 * chunk.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { copyToClipboard } from '../../lib/clipboard';
import { triggerHaptic } from '../../platform/native/haptics';
import { CheckGlyph } from '../icons/Glyph';

export function CodeBlockFrame({
  lang,
  code,
  html,
}: {
  lang: string;
  code: string;
  html: string | null;
}) {
  // "Copied" is only ever shown for a clipboard write that resolved
  // (station#3339, the same defect as #3317's dir-path button). Station is
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

  return (
    <div style={{ position: 'relative', margin: '8px 0' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 12px',
          background: '#161b22',
          borderRadius: '6px 6px 0 0',
          borderBottom: '1px solid #30363d',
        }}
      >
        <span style={{ fontSize: '11px', color: '#8b949e' }}>{lang}</span>
        <button
          type="button"
          onClick={() => {
            void handleCopy();
          }}
          title={
            copyState === 'failed'
              ? 'This browser refused clipboard access — select the code to copy it manually.'
              : 'Copy code'
          }
          style={{
            background: 'none',
            border: 'none',
            color: copyState === 'failed' ? '#f85149' : '#8b949e',
            cursor: 'pointer',
            fontSize: '11px',
            padding: '2px 6px',
          }}
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
        </button>
      </div>
      {html ? (
        <div
          style={{ fontSize: '12px', lineHeight: '1.5', overflowX: 'auto' }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre
          style={{
            margin: 0,
            padding: '12px',
            background: '#0d1117',
            borderRadius: '0 0 6px 6px',
            overflowX: 'auto',
          }}
        >
          <code
            style={{
              fontFamily: 'monospace',
              fontSize: '12px',
              color: '#e6edf3',
            }}
          >
            {code}
          </code>
        </pre>
      )}
    </div>
  );
}

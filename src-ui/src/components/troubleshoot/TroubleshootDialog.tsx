/**
 * #4470: the intro step of Troubleshoot with an agent.
 *
 * Asks "What went wrong?" so the person's own words become the first message
 * of a new Station Assistant conversation, names the Station and build being
 * troubleshot, and offers the `station triage` command for when the app
 * itself is broken. Nothing is sent until they choose Start.
 */

import type { TroubleshootPrepareResponse } from '@kontourai/station-contracts/troubleshoot';
import { useId, useRef, useState } from 'react';
import { copyToClipboard } from '../../lib/clipboard';
import { Button } from '../Button';
import { Dialog } from '../Dialog';

export interface TroubleshootDialogProps {
  prepared: TroubleshootPrepareResponse;
  onStart: (description: string) => Promise<void> | void;
  onClose: () => void;
}

const factStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 'var(--k-space-3)',
  padding: 'var(--k-space-1) 0',
  fontSize: 'var(--k-text-sm)',
};

const factLabelStyle: React.CSSProperties = {
  color: 'var(--k-text-muted)',
  flexShrink: 0,
};

export default function TroubleshootDialog({
  prepared,
  onStart,
  onClose,
}: TroubleshootDialogProps) {
  const [description, setDescription] = useState('');
  const [copied, setCopied] = useState(false);
  const fieldId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { display, cliCommand } = prepared;
  const build = [display.version, display.channel].filter(Boolean).join(' · ');

  return (
    <Dialog
      eyebrow="Troubleshoot"
      title="What went wrong?"
      subtitle="The Station Assistant will investigate with you. Nothing is filed without your yes."
      closeLabel="Close troubleshoot"
      onClose={onClose}
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void onStart(description)}>
            Start troubleshooting
          </Button>
        </>
      }
    >
      <label
        htmlFor={fieldId}
        style={{
          display: 'block',
          fontSize: 'var(--k-text-sm)',
          color: 'var(--k-text-muted)',
          marginBottom: 'var(--k-space-1)',
        }}
      >
        Describe it in your own words. You can paste screenshots in the chat.
      </label>
      <textarea
        id={fieldId}
        ref={inputRef}
        data-testid="troubleshoot-description"
        rows={4}
        value={description}
        placeholder="What did you expect, and what happened instead?"
        onChange={(event) => setDescription(event.target.value)}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          font: 'inherit',
          fontSize: 'var(--k-text-sm)',
          padding: 'var(--k-space-2)',
          color: 'var(--k-text)',
          background: 'var(--k-panel)',
          border: 'var(--k-border-thin) solid var(--k-line)',
          borderRadius: 'var(--k-radius-control)',
          resize: 'vertical',
        }}
      />
      <dl style={{ margin: 'var(--k-space-3) 0 0' }}>
        <div style={factStyle}>
          <dt style={factLabelStyle}>Station</dt>
          <dd style={{ margin: 0 }} data-testid="troubleshoot-station">
            {display.stationName}
          </dd>
        </div>
        <div style={factStyle}>
          <dt style={factLabelStyle}>Version</dt>
          <dd style={{ margin: 0 }} data-testid="troubleshoot-version">
            {build}
          </dd>
        </div>
      </dl>
      <div
        style={{
          ...factStyle,
          alignItems: 'center',
          marginTop: 'var(--k-space-2)',
        }}
      >
        <span style={factLabelStyle}>App not working?</span>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--k-space-2)',
          }}
        >
          <code style={{ fontFamily: 'var(--k-font-mono)' }}>{cliCommand}</code>
          <Button
            variant="secondary"
            onClick={() =>
              void copyToClipboard(cliCommand).then((ok) => setCopied(ok))
            }
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </span>
      </div>
    </Dialog>
  );
}

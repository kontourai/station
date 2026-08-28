/**
* "Reach another Station" — the chooser's second branch.
 *
 * This is the old inline "Add Station" form, which sat unlabelled directly
 * below the "Add computer" button and bypassed the very chooser whose copy
 * exists to explain how a paired device, a Station and an SSH computer
 * differ. Same registry call, same background identity handshake; what
 * changed is that it is now reached through the one entry point, in the one
 * dialog chrome.
 */

import type { KnownEnvironmentRegistry } from '@kontourai/station-connect/known-environment';
import { PUBLIC_STATION_HANDSHAKE_PATH } from '@kontourai/station-contracts';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { knownEnvironmentRegistry } from './known-environment-registry';

/**
 * Best-effort identity upgrade for a freshly-added manual entry (archive#1096
 *). Fires the well-known handshake in the background, AFTER the
 * synchronous local add already succeeded, and attaches `environmentId` only
 * on a clean, well-shaped response.
 *
 * Non-negotiable: the add itself never waits on this, and a failed, slow or
 * malformed response degrades the entry to silently unidentified rather than
 * surfacing an error — reachability is never a precondition for the
* local-first add path.
 */
async function verifyAndAttachIdentity(
  registry: KnownEnvironmentRegistry,
  id: string,
  httpBaseUrl: string,
): Promise<void> {
  try {
    const response = await fetch(
      `${httpBaseUrl}${PUBLIC_STATION_HANDSHAKE_PATH}`,
    );
    if (!response.ok) return;
    const handshake: unknown = await response.json();
    const environmentId =
      handshake && typeof handshake === 'object' && 'environmentId' in handshake
        ? (handshake as { environmentId: unknown }).environmentId
        : undefined;
    if (typeof environmentId === 'string' && environmentId) {
      registry.attachEnvironmentDescriptor(id, environmentId);
    }
  } catch {
// Unreachable, slow, or malformed — leave the entry unidentified.
  }
}

export function StationAddressDialog({ onClose }: { onClose: () => void }) {
  const fieldId = useId();
  const [label, setLabel] = useState('');
  const [httpBaseUrl, setHttpBaseUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    const registry = knownEnvironmentRegistry();
    try {
      const created = registry.add({
        label: label.trim() || httpBaseUrl.trim(),
        httpBaseUrl: httpBaseUrl.trim(),
        source: 'manual',
      });
// Fire-and-forget: the add above already committed synchronously.
      void verifyAndAttachIdentity(
        registry,
        created.id,
        created.endpoints[0].httpBaseUrl,
      );
      onClose();
    } catch {
      setError(
        'Enter a valid Station address, e.g. https://box-b.tailnet.ts.net',
      );
    }
  }

  return (
    <Dialog
      eyebrow="Add a computer"
      title="Reach another Station"
      subtitle="Save the address of a Station running somewhere else so this device can open it."
      closeLabel="Close add Station"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={!httpBaseUrl.trim()}
          >
            Add Station
          </Button>
        </>
      }
    >
      <label className="editor-field" htmlFor={`${fieldId}-url`}>
        <span className="editor-label">Station address</span>
        <input
          id={`${fieldId}-url`}
          className="editor-input"
          value={httpBaseUrl}
          placeholder="https://box-b.tailnet.ts.net"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => setHttpBaseUrl(event.target.value)}
        />
        <span className="editor-hint">
          Saved on this device only. Station checks the address in the
          background and records nothing it cannot confirm.
        </span>
      </label>
      <label className="editor-field" htmlFor={`${fieldId}-label`}>
        <span className="editor-label">
          Name <span className="editor-hint">optional</span>
        </span>
        <input
          id={`${fieldId}-label`}
          className="editor-input"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      {error && (
        <p className="connections-computers__alert" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

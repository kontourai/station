import {
  ENSEMBLE_MAX_BYTES,
  type EnsemblePreset,
  parseEnsemblePreset,
} from '@kontourai/station-contracts/ensemble';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useRef, useState } from 'react';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { EnsembleCliGroupForm } from './EnsembleCliGroupForm';
import { EnsembleRecordedGroupInspection } from './EnsembleRecordedGroupInspection';

export function EnsemblePresetUpload({
  scope,
}: {
  scope: ApiRequestScope & { isCurrent(): boolean };
}) {
  const [source, setSource] = useState<{
    json: string;
    hash: string;
    preset: EnsemblePreset;
  }>();
  const [failure, setFailure] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [selectionCancelled, setSelectionCancelled] = useState(false);
  const sequence = useRef(0);
  const { guard, DiscardModal } = useUnsavedGuard(dirty);
  const current = scope.isCurrent();
  const load = async (file: File) => {
    const attempt = ++sequence.current;
    setSource(undefined);
    setFailure(false);
    setSelectionCancelled(false);
    setDirty(false);
    try {
      if (file.size > ENSEMBLE_MAX_BYTES)
        throw new Error('Preset exceeds byte limit');
      const bytes = await file.arrayBuffer();
      const json = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      const preset = parseEnsemblePreset(json);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hash = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      if (scope.isCurrent() && attempt === sequence.current)
        setSource({ json, hash, preset });
    } catch {
      if (scope.isCurrent() && attempt === sequence.current) setFailure(true);
    }
  };
  return (
    <section aria-label="Use a preset from this device">
      <h2>Use a preset from this device</h2>
      <p>
        Select a JSON preset to review its roster and create a group. This does
        not read files on the Station host or start engines.
      </p>
      <label>
        Preset file from this device
        <input
          type="file"
          accept=".json,application/json"
          disabled={!current}
          onChange={(event) => {
            const file = event.target.files?.[0];
            const input = event.currentTarget;
            if (file)
              guard(
                () => {
                  input.value = '';
                  void load(file);
                },
                () => {
                  input.value = '';
                  setSelectionCancelled(true);
                },
              );
          }}
        />
      </label>
      {selectionCancelled && current && (
        <p role="status">
          File selection cancelled. The current preset and draft are unchanged.
        </p>
      )}
      {failure && current && (
        <p role="alert">
          Preset could not be read. Select a valid UTF-8 Ensemble JSON file of
          at most 128 KiB.
        </p>
      )}
      {source && current && (
        <>
          <h3>{source.preset.name}</h3>
          <p>
            Source <code>{source.hash}</code>
          </p>
          <ul>
            {source.preset.members.map((member) => (
              <li key={member.id}>
                {member.codename} ({member.id}) · {member.engine} ·{' '}
                {member.model}
                {source.preset.stationmaster === member.id
                  ? ' · Stationmaster'
                  : ''}
              </li>
            ))}
          </ul>
          <EnsembleRecordedGroupInspection
            scope={scope}
            presetJson={source.json}
            hash={source.hash}
          />
          <EnsembleCliGroupForm
            key={source.hash}
            scope={scope}
            presetJson={source.json}
            hash={source.hash}
            memberIds={source.preset.members.map((member) => member.id)}
            onDirtyChange={setDirty}
          />
        </>
      )}
      <DiscardModal />
    </section>
  );
}

/**
 * archive#settings-revamp (archive#1441): the row for
 * `builtinAgentEngineConnectionId` with a "Change…" action. Reuses the
 * onboarding-era `EnginePicker` component (archive#1194) rather than forking
 * a second picker — `EnginePicker` already renders its own full
 * backdrop+panel overlay, so no extra modal shell is needed; only its
 * eyebrow/title/description copy is overridden so it reads as a deliberate
 * re-configuration action instead of first-run framing.
 *
 * archive#1194: the row shows the engine the runtime is ACTUALLY bound to,
 * resolved through `builtinEngineDisplay` (which calls the same
 * `resolveBuiltinAgentEngineBinding` the server bootstrap uses), not the raw
 * config value. Those two diverge whenever a saved choice names an engine
 * that cannot run the built-in assistant, or that has gone away: the
 * resolver already failed that binding safe to Station, so rendering the raw
 * value made Settings claim an engine that was not in effect. The reason for
 * any divergence is stated on a second line rather than swallowed.
 *
 * this row lives inside SettingsView's batched
 * draft/Save/Discard page, so the picker's choice is routed through
 * `onSelect` into `onChange` (the row's own batched-draft callback) instead
 * of letting `EnginePicker` PATCH the config directly — an immediate save
 * here would land server-side but the page's dirty-draft re-sync guard
 * skips adopting fresh server data while there are unsaved edits, so the
 * user's NEXT Save would silently revert the engine choice they just made.
 * For the same reason the picker's none-capable panel points at Connections
 * in prose instead of navigating there: a navigation out of this page from
 * inside a nested modal would bypass SettingsView's `useUnsavedGuard` and
 * silently discard the draft.
 *
 * The modal copy deliberately does NOT mention Voice. archive#1441's wording said
 * this reassigns "Station's default agent and voice", but the server refuses
 * exactly that: `rebindBuiltinAgents` (station-runtime.ts) leaves
 * `station-voice` alone on purpose — Voice is speech-to-speech
 * (`voice-session.ts`'s `IS2SProvider`) and never reads an engine binding, so
 * rebinding it would be a category error. A screen promising a rebind the
 * runtime declines to perform is a claim with no truthful source.
 *
 * `EnginePicker` is lazy-loaded (low-traffic — see `composite-editors.tsx`),
 * which is why the shared binding logic lives in `utils/engineBinding.ts`
 * and not in the picker module: importing it from there would pull the modal
 * and its CSS into the Settings bundle eagerly.
 */
import type { EngineConnectionId } from '@kontourai/station-contracts/agent-identity';
import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import { useEngineConnectionsQuery } from '@kontourai/station-sdk';
import { useState } from 'react';
import { LazyBoundary } from '../../components/LazyBoundary';
import { PageRow } from '../../components/PageRow';
import { useSystemStatus } from '../../hooks/useSystemStatus';
import {
  builtinEngineDisplay,
  isStationChatReady,
} from '../../utils/engineBinding';
import type { RegistryRowComponentProps } from './registry-row-types';

const loadEnginePicker = () =>
  import('../../components/EnginePicker').then((m) => ({
    default: m.EnginePicker,
  }));

export function BuiltinEngineRow({
  definition,
  value,
  onChange,
}: RegistryRowComponentProps) {
  const { data: connections = [] } = useEngineConnectionsQuery() as {
    data?: AgentConnectionView[];
  };
  const { data: status } = useSystemStatus();
  const [pickerOpen, setPickerOpen] = useState(false);

  const display = builtinEngineDisplay({
    value: value as EngineConnectionId | null | undefined,
    stationChatReady: status ? isStationChatReady(status) : false,
    connections: connections ?? [],
  });

  return (
    <>
      <PageRow
        label={definition.label}
        description={definition.description}
        control={
          <button
            type="button"
            className="settings__secondary-btn"
            onClick={() => setPickerOpen(true)}
          >
            Change…
          </button>
        }
      >
        <span className="settings__field-hint">{display.name}</span>
        {display.note && (
          <span className="settings__field-hint">{display.note}</span>
        )}
      </PageRow>
      {pickerOpen && (
        <LazyBoundary
          load={loadEnginePicker}
          componentProps={{
            eyebrow: 'Station settings',
            title: "Choose the built-in assistant's engine",
            description:
              "Reassign which engine powers Station's built-in assistant.",
            onSelect: (id) => onChange(id),
            onChosen: () => setPickerOpen(false),
            onDismiss: () => setPickerOpen(false),
          }}
          pending={null}
        />
      )}
    </>
  );
}

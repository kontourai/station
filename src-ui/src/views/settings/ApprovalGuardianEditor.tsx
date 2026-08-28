/**
 * archive#settings-revamp: custom composite editor for
 * `approvalGuardian` (docs/design/settings-architecture.md's "Config with
 * no UI" list — this field had zero Settings UI before this slice).
 * Toggle + review/enforce select + model text + instructions textarea, on
 * the existing AgentDefaultsSection bespoke-editor pattern (plain
 * label/control markup, not the generic per-kind row renderer — composite
 * kinds never get a generic editor, see `registry-row.tsx`).
 *
 * Lazy-loaded via `React.lazy` (low-traffic — see `composite-editors.tsx`).
 */
import type { ApprovalGuardianConfig } from '@kontourai/station-contracts/config';
import { InfoTip } from '../../components/InfoTip';
import { PageRow } from '../../components/PageRow';
import { ProvenanceBadge } from '../../components/ProvenanceBadge';
import { Toggle } from '../../components/Toggle';
import type { RegistryRowComponentProps } from './registry-row-types';

export function ApprovalGuardianEditor({
  definition,
  value,
  provenance,
  onChange,
}: RegistryRowComponentProps) {
  const guardian = (value as ApprovalGuardianConfig | undefined) ?? {};
  const update = (patch: Partial<ApprovalGuardianConfig>) =>
    onChange({ ...guardian, ...patch });

  return (
    <>
      <PageRow
        label={
          <>
            {definition.label}
            <InfoTip label={definition.label}>
              Review asks you to decide when the guardian objects. Enforce
              blocks those calls. Either mode adds a separate model request
              whenever a tool call needs approval.
            </InfoTip>
          </>
        }
        description={definition.description}
        status={<ProvenanceBadge provenance={provenance} />}
        control={
          <Toggle
            checked={!!guardian.enabled}
            onChange={(checked) => update({ enabled: checked })}
            label={definition.label}
          />
        }
      />
      {guardian.enabled && (
        <>
          <PageRow
            label="Guardian mode"
            description="In both modes, calls the guardian clears run without asking you. Review still brings the guardian's denials to you to decide; Enforce blocks them outright."
            control={
              <select
                className="editor-select"
                aria-label="Guardian mode"
                value={guardian.mode ?? 'review'}
                onChange={(event) =>
                  update({ mode: event.target.value as 'review' | 'enforce' })
                }
              >
                <option value="review">Review</option>
                <option value="enforce">Enforce</option>
              </select>
            }
          />
          <PageRow
            label="Guardian model"
            description="Model that performs the screening. Leave empty to use the Structure model."
            control={
              <input
                type="text"
                className="editor-input"
                aria-label="Guardian model"
                value={guardian.model ?? ''}
                placeholder="e.g. anthropic.claude-3-5-sonnet"
                onChange={(event) =>
                  update({ model: event.target.value || undefined })
                }
              />
            }
          />
          <PageRow
            label="Guardian instructions"
            description="House rules added on top of the guardian's built-in judgment of safety, scope, and intent."
          >
            {/* The field holds a prompt (archive#1831): sized like one, with a
                placeholder that ADDS a concrete house rule rather than
                restating DEFAULT_GUARDIAN_PROMPT's own decision rules. */}
            <textarea
              aria-label="Guardian instructions"
              className="editor-textarea settings__guardian-instructions"
              rows={6}
              placeholder={
                'e.g. Deny anything that writes outside the project workspace. Always defer git pushes and package publishes to a human.'
              }
              value={guardian.instructions ?? ''}
              onChange={(event) =>
                update({ instructions: event.target.value || undefined })
              }
            />
          </PageRow>
        </>
      )}
    </>
  );
}

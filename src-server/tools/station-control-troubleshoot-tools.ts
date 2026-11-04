/**
 * #4470: the Station Assistant's troubleshooting tools. Both are pure: they
 * call no route, change no state and send nothing off this machine.
 *
 * - `get_troubleshoot_playbook` returns the bundled playbook, which is too
 *   long for the first turn's ambient context.
 * - `draft_troubleshoot_report` redacts issue-form fields with the shared
 *   report drafter (also behind `station triage draft-report`) and returns
 *   the prefilled `troubleshoot-report.yml` link.
 *   A field that does not fit the link comes back whole in `overflow`.
 */

import {
  MAX_TROUBLESHOOT_REPORT_FIELD_LENGTH,
  MAX_TROUBLESHOOT_REPORT_TITLE_LENGTH,
  TROUBLESHOOT_REPORT_FIELD_IDS,
  TROUBLESHOOT_REPORT_LABEL,
  TroubleshootReportBoundsError,
  type TroubleshootReportFieldId,
  type TroubleshootReportFields,
} from '@kontourai/station-contracts/troubleshoot';
import { draftTroubleshootReport } from '@kontourai/station-shared/triage-context';
import {
  TROUBLESHOOT_PLAYBOOK,
  TROUBLESHOOT_PLAYBOOK_VERSION,
} from '@kontourai/station-shared/troubleshoot-playbook';
import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import { jsonToolResult } from './station-control-shared.js';

const fieldShape = Object.fromEntries(
  TROUBLESHOOT_REPORT_FIELD_IDS.map((id) => [
    id,
    z.string().max(MAX_TROUBLESHOOT_REPORT_FIELD_LENGTH).optional(),
  ]),
) as Record<TroubleshootReportFieldId, z.ZodOptional<z.ZodString>>;

export function registerTroubleshootTools(
  registry: StationControlToolRegistry,
) {
  registry.tool(
    'get_troubleshoot_playbook',
    'Return the Station troubleshooting playbook. Call it at the start of a troubleshooting conversation and follow it throughout. Reads nothing else and changes nothing.',
    {},
    async () =>
      jsonToolResult({
        version: TROUBLESHOOT_PLAYBOOK_VERSION,
        playbook: TROUBLESHOOT_PLAYBOOK,
      }),
  );
  registry.tool(
    'draft_troubleshoot_report',
    `Redact a troubleshooting report and build its prefilled kontourai/station issue-form link (template troubleshoot-report.yml, label ${TROUBLESHOOT_REPORT_LABEL}). Sends nothing. Show the person the returned redacted text before anything is filed. Fields that do not fit in the link are returned in overflow, whole, for the person to paste.`,
    {
      title: z
        .string()
        .min(1)
        .max(MAX_TROUBLESHOOT_REPORT_TITLE_LENGTH)
        .describe('One-line summary of the problem.'),
      fields: z
        .object(fieldShape)
        .strict()
        .describe('Issue-form field values keyed by field id.'),
    },
    async ({ title, fields }) => {
      // The schema rejects these before an agent call arrives; a direct
      // invocation without it gets the same typed refusal, never a throw.
      if (
        typeof title !== 'string' ||
        typeof fields !== 'object' ||
        fields === null ||
        Array.isArray(fields)
      ) {
        return jsonToolResult({
          success: false,
          code: 'invalid_troubleshoot_report',
          error: 'A report needs a string title and an object of fields.',
        });
      }
      try {
        const draft = draftTroubleshootReport({
          title,
          fields: fields as TroubleshootReportFields,
        });
        return jsonToolResult({
          title: draft.title,
          fields: draft.fields,
          url: draft.url,
          included: draft.included,
          overflow: draft.overflow,
        });
      } catch (error) {
        if (error instanceof TroubleshootReportBoundsError)
          return jsonToolResult({ success: false, error: error.message });
        throw error;
      }
    },
  );
}

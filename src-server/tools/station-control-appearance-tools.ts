import {
  CUSTOM_APPEARANCE_CSS_MAX_LENGTH,
  CUSTOM_APPEARANCE_GUIDE,
  CUSTOM_APPEARANCE_NAME_MAX_LENGTH,
  type CustomAppearance,
} from '@kontourai/station-contracts/custom-appearance';
import {
  getCustomAppearance,
  proposeCustomAppearance,
} from '@kontourai/station-sdk/client';
import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import {
  controlRequestOptions,
  jsonToolResult,
  resolveControlApiBase,
  toToolEnvelope,
} from './station-control-shared.js';

const hex = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
const modePalette = z
  .object({
    roles: z.record(z.string(), hex).optional(),
    accent: hex.optional(),
  })
  .strict();

/**
 * The person's custom appearance (docs/decisions/custom-appearance.md). An
 * agent reads it and proposes; it can never apply one. The person previews
 * the proposal in their own tab, and the route refuses an agent every step
 * after proposing.
 */
export function registerAppearanceTools(server: StationControlToolRegistry) {
  server.tool(
    'get_appearance',
    'Read the person’s custom appearance (palette and CSS), their pending proposal, the render report from their last preview of it, the revision, and the guide: palette roles, CSS rules and stable hook selectors. Read before proposing.',
    {},
    async () => {
      const result = await toToolEnvelope(
        getCustomAppearance(resolveControlApiBase(), controlRequestOptions()),
      );
      return jsonToolResult({ ...result, guide: CUSTOM_APPEARANCE_GUIDE });
    },
  );
  server.tool(
    'propose_appearance',
    'Propose a custom appearance for the person: a name, an optional palette per mode (dark, light) and optional CSS. Requires get_appearance’s revision. You cannot see the result, and nothing changes until the person previews it at /appearance and keeps it. Propose small changes, ask the person to preview, then read get_appearance for the render report. Never claim it was applied.',
    {
      revision: z.string().min(1),
      name: z.string().min(1).max(CUSTOM_APPEARANCE_NAME_MAX_LENGTH),
      palette: z
        .object({ dark: modePalette.optional(), light: modePalette.optional() })
        .strict()
        .optional(),
      css: z.string().max(CUSTOM_APPEARANCE_CSS_MAX_LENGTH).optional(),
    },
    async ({ revision, name, palette, css }) => {
      const result = await toToolEnvelope(
        proposeCustomAppearance(
          resolveControlApiBase(),
          {
            revision,
            appearance: {
              version: 1,
              name,
              // The route parses roles against the contract; this is its input.
              palette: (palette ?? {}) as CustomAppearance['palette'],
              css: css ?? '',
            },
          },
          controlRequestOptions(),
        ),
      );
      return jsonToolResult({
        ...result,
        openPath: CUSTOM_APPEARANCE_GUIDE.openPath,
        state: result.success
          ? 'proposed'
          : result.outcome === 'indeterminate'
            ? 'unconfirmed'
            : 'refused',
      });
    },
  );
}

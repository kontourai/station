import type { WorkspacePaneDescriptor } from '@kontourai/station-contracts/workspace-pane';
import type { ComponentType } from 'react';
import {
  BoardGlyph,
  ChartGlyph,
  CheckGlyph,
  CodeGlyph,
  DatabaseGlyph,
  DiffGlyph,
  DocumentGlyph,
  EditGlyph,
  FolderGlyph,
  GlobeGlyph,
  HomeGlyph,
  MessageGlyph,
  PinGlyph,
  PlayGlyph,
  ShieldGlyph,
  TargetGlyph,
  TerminalGlyph,
} from '../components/icons/Glyph';
import type { BuiltinWorkspacePaneRendererName } from './builtinWorkspacePaneCanonical';

type PaneGlyphComponent = ComponentType<{ className?: string }>;

/**
 * #765 F4: each built-in pane's real icon for the workspace-pane card tiles.
 *
 * The tiles used to fall back to the pane name's first letter, which made
 * Coding and Chat both render a giant "C". Built-in descriptors deliberately
 * carry `icon === undefined` (the canonical-descriptor admission checks in
 * `builtinWorkspacePaneCanonical.ts` pin that), so the association lives here
 * as UI presentation keyed on the renderer inventory — `satisfies` over the
 * renderer-name union means registering a new built-in renderer without
 * choosing its tile glyph fails to typecheck.
 *
 * Plugin/MCP panes are untouched: their descriptors carry their own `icon`
 * or `previewImage`, which the card prefers over anything here.
 */
const BUILTIN_PANE_GLYPHS = {
  'flow-run-console': PlayGlyph,
  'workspace-chat': MessageGlyph,
  'task-room-editor': EditGlyph,
  coding: CodeGlyph,
  'workspace-coding-file-browser': FolderGlyph,
  'workspace-coding-diff': DiffGlyph,
  'workspace-coding-terminal': TerminalGlyph,
  'workspace-plan': TargetGlyph,
  'workspace-readiness': CheckGlyph,
  'workspace-trust': ShieldGlyph,
  'workspace-browser-preview': GlobeGlyph,
  'workspace-file-preview': DocumentGlyph,
  'workspace-home': HomeGlyph,
  'workspace-activity': ChartGlyph,
  'workspace-spatial-board': PinGlyph,
  'workspace-board': BoardGlyph,
  'workspace-basis': DatabaseGlyph,
} satisfies Record<BuiltinWorkspacePaneRendererName, PaneGlyphComponent>;

/**
 * The tile glyph for a built-in pane renderer, or `null` for anything this
 * build does not positively recognise (plugin/MCP renderers, unknown names) —
 * callers keep their existing fallback for those.
 */
export function builtinWorkspacePaneGlyph(
  renderer: WorkspacePaneDescriptor['renderer'] | undefined,
): PaneGlyphComponent | null {
  if (renderer?.kind !== 'builtin-component') return null;
  return (
    (BUILTIN_PANE_GLYPHS as Record<string, PaneGlyphComponent>)[
      renderer.name
    ] ?? null
  );
}

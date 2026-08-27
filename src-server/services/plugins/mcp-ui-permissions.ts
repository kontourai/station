/**
 * MCP-UI per-server render permission (S2).
 *
 * Posture: allow + per-server revoke (opt-out). Rendering an MCP server's UI in
 * Station is allowed by default (preserving the "open + hardened sandbox"
 * decision); an operator may explicitly REVOKE render for a given server. The
 * store records the explicit per-server decision; an absent server ⇒ allowed.
 *
 * Mirrors the plugin-grants storage shape (JSON file keyed by id), kept
 * separate from plugin-grants.json because MCP servers are integrations, not
 * plugins, and render is always an explicit operator choice (never auto-granted
 * like passive plugin permissions).
 *
 * Storage is FAIL-CLOSED (station#1835, via {@link GrantsFileStore}). The
 * headline contract: **revoked stays revoked** — a MISSING store means "no
 * server was ever revoked" and answers allowed, but an unreadable, corrupt, or
 * ill-shaped store must never answer "allowed" for a server that may have been
 * revoked. Reads over such a store throw
 * {@link McpUiRenderGrantsUnavailableError}; the render routes' error handling
 * turns that into a blocked render, never a silent re-allow.
 */

import { join } from 'node:path';
import {
  GrantsFileStore,
  GrantsStoreUnavailableError,
  isPlainObject,
} from './grants-file-store.js';

/** Permission name carried in the tier model for completeness. */
export const MCP_UI_RENDER_PERMISSION = 'mcp-ui.render';

interface RenderGrantsFile {
  [serverId: string]: { renderAllowed: boolean };
}

/** The render grants store cannot be read; no render answer may come from it. */
export class McpUiRenderGrantsUnavailableError extends GrantsStoreUnavailableError {
  constructor(
    storePath: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(storePath, detail, options);
    this.name = 'McpUiRenderGrantsUnavailableError';
  }
}

export function mcpUiRenderGrantsPath(projectHomeDir: string): string {
  return join(projectHomeDir, 'mcp-ui-render-grants.json');
}

/** Valid = plain object; every value an object with a boolean `renderAllowed`. */
function renderGrantsShapeProblems(value: unknown): string[] {
  if (!isPlainObject(value)) {
    return ['must be a plain object keyed by server id'];
  }
  const problems: string[] = [];
  for (const [serverId, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) {
      problems.push(`${serverId}: must be an object`);
      continue;
    }
    // A real boolean, never truthy coercion: this is the revocation record.
    if (typeof entry.renderAllowed !== 'boolean') {
      problems.push(`${serverId}.renderAllowed: must be a boolean`);
    }
  }
  return problems;
}

function renderGrantsStore(
  projectHomeDir: string,
): GrantsFileStore<RenderGrantsFile> {
  return new GrantsFileStore<RenderGrantsFile>({
    filePath: mcpUiRenderGrantsPath(projectHomeDir),
    storeLabel: 'mcp-ui-render-grants',
    shapeProblems: renderGrantsShapeProblems,
    makeUnavailableError: (storePath, detail, cause) =>
      new McpUiRenderGrantsUnavailableError(storePath, detail, { cause }),
    emptyValue: {},
  });
}

/**
 * True only when the server has been EXPLICITLY revoked. Absent (the default)
 * or an explicit allow ⇒ false (rendering permitted).
 *
 * Throws {@link McpUiRenderGrantsUnavailableError} when the store cannot be
 * read: with the revocation record unreadable there is no honest boolean
 * answer, and returning `false` here would re-allow a revoked server. Callers
 * sit inside route error handling that fails the render closed.
 */
export function isMcpUiRenderRevoked(
  projectHomeDir: string,
  serverId: string,
): boolean {
  return (
    renderGrantsStore(projectHomeDir).read()[serverId]?.renderAllowed === false
  );
}

/** Convenience inverse of {@link isMcpUiRenderRevoked} for read surfaces. */
export function isMcpUiRenderAllowed(
  projectHomeDir: string,
  serverId: string,
): boolean {
  return !isMcpUiRenderRevoked(projectHomeDir, serverId);
}

/**
 * Record the explicit per-server render decision. `allowed: false` revokes
 * rendering; `allowed: true` clears a prior revoke back to the open default.
 * Serialized and fail-closed: an unreadable store throws with nothing written.
 */
export async function setMcpUiRenderAllowed(
  projectHomeDir: string,
  serverId: string,
  allowed: boolean,
): Promise<void> {
  await renderGrantsStore(projectHomeDir).mutate(serverId, (grants) => {
    grants[serverId] = { renderAllowed: allowed };
    return grants;
  });
}

export async function revokeMcpUiRender(
  projectHomeDir: string,
  serverId: string,
): Promise<void> {
  await setMcpUiRenderAllowed(projectHomeDir, serverId, false);
}

export async function allowMcpUiRender(
  projectHomeDir: string,
  serverId: string,
): Promise<void> {
  await setMcpUiRenderAllowed(projectHomeDir, serverId, true);
}

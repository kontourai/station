/**
 * How Station's approval mode answers the Copilot runtime's permission
 * requests (docs/decisions/copilot-sdk-engine.md).
 *
 * Every session is created with `permissionMode: 'manual'`, so the runtime's
 * own automatic modes (`assisted`, an LLM judge; `allow-all`) never answer for
 * Station. Each request the runtime raises reaches the SDK's
 * `onPermissionRequest`, and this module decides who answers it:
 *
 * - `ask`: Station allows a read inside the session's working directory;
 *   everything else goes to a person through Station's approval card.
 * - `auto`: as `ask`, and Station also allows a file write inside the working
 *   directory.
 * - `never` (full access): Station allows every request. Applied only to a
 *   `host` session: the Copilot runtime gives Station no process sandbox to
 *   confine it with, so full access elsewhere applies `auto`, as it does for
 *   an ACP engine.
 *
 * Not governed by Station: approvals a person saved in the Copilot CLI itself
 * (for example "approve for this location"). The runtime applies them without
 * raising a request, so no Station mode can narrow them.
 *
 * Request shapes: `PermissionRequest` in `@github/copilot-sdk`
 * `dist/generated/session-events.d.ts` (1.0.32), mirrored in
 * github/copilot-sdk `nodejs/src/generated/session-events.ts`.
 */
import { isAbsolute, relative, resolve } from 'node:path';
import type {
  PermissionRequest,
  PermissionRequestResult,
} from '@github/copilot-sdk';
import type {
  ApprovalMode,
  StationConfinement,
} from '@kontourai/station-contracts/provider';
import type { EngineToolKind } from '@kontourai/station-contracts/runtime-events';

export type CopilotAppliedApprovalMode = 'ask' | 'auto' | 'never';

/**
 * The mode a session applies for a requested one. Unlike an ACP engine, a
 * Copilot SDK session has no "engine decides" setting: with no requested mode
 * Station still answers every request, at the strictest mode.
 */
export function copilotAppliedApprovalMode(
  requested: ApprovalMode | undefined,
  confinement: StationConfinement | undefined,
): CopilotAppliedApprovalMode {
  if (requested === 'never') return confinement === 'host' ? 'never' : 'auto';
  if (requested === 'auto') return 'auto';
  return 'ask';
}

function insideDirectory(cwd: string, target: string | undefined): boolean {
  if (!target) return false;
  const rel = relative(resolve(cwd), resolve(cwd, target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The path a read or write request names, preferring the runtime's resolution. */
function requestPath(request: PermissionRequest): string | undefined {
  if (request.kind === 'read') return request.resolvedPath ?? request.path;
  if (request.kind === 'write') return request.resolvedPath ?? request.fileName;
  return undefined;
}

/**
 * The key a person's "allow for this session" answer is remembered under, or
 * `undefined` when that answer is taken as a one-call allow. A shell grant
 * covers the exact command text only; an MCP grant one server's tool.
 */
export function copilotSessionGrantKey(
  request: PermissionRequest,
): string | undefined {
  switch (request.kind) {
    case 'shell':
      return `shell:${request.fullCommandText}`;
    case 'write':
      return 'write';
    case 'read':
      return 'read';
    case 'url':
      return `url:${request.url}`;
    case 'mcp':
      return `mcp:${request.serverName}/${request.toolName}`;
    default:
      return undefined;
  }
}

/** Whether Station allows this request without asking a person. */
export function copilotModeAllows(
  mode: CopilotAppliedApprovalMode,
  request: PermissionRequest,
  cwd: string,
  sessionGrants: ReadonlySet<string>,
): boolean {
  if (mode === 'never') return true;
  const grant = copilotSessionGrantKey(request);
  if (grant !== undefined && sessionGrants.has(grant)) {
    // A session grant for reads or writes stays inside the working directory.
    if (request.kind === 'read' || request.kind === 'write')
      return insideDirectory(cwd, requestPath(request));
    return true;
  }
  if (request.kind === 'read')
    return insideDirectory(cwd, requestPath(request));
  if (request.kind === 'write' && mode === 'auto')
    return insideDirectory(cwd, requestPath(request));
  return false;
}

const VIEW_TEXT_MAX_CHARS = 8_000;

function bounded(text: string): string {
  return text.length > VIEW_TEXT_MAX_CHARS
    ? `${text.slice(0, VIEW_TEXT_MAX_CHARS)}…`
    : text;
}

export interface CopilotPermissionView {
  title: string;
  toolName: string;
  toolKind: EngineToolKind;
  toolInput: Record<string, unknown>;
}

/** What Station's approval card shows for a request. */
export function copilotPermissionView(
  request: PermissionRequest,
): CopilotPermissionView {
  switch (request.kind) {
    case 'shell':
      return {
        title: 'Run a command',
        toolName: 'shell',
        toolKind: 'execute',
        toolInput: {
          command: bounded(request.fullCommandText),
          intention: request.intention,
        },
      };
    case 'write':
      return {
        title: 'Edit a file',
        toolName: 'write',
        toolKind: 'edit',
        toolInput: {
          path: request.fileName,
          diff: bounded(request.diff),
          intention: request.intention,
        },
      };
    case 'read':
      return {
        title: 'Read a file',
        toolName: 'read',
        toolKind: 'read',
        toolInput: { path: request.path, intention: request.intention },
      };
    case 'url':
      return {
        title: 'Fetch a URL',
        toolName: 'url',
        toolKind: 'fetch',
        toolInput: { url: request.url, intention: request.intention },
      };
    case 'mcp':
      return {
        title: `Use ${request.serverName}: ${request.toolTitle}`,
        toolName: `${request.serverName}/${request.toolName}`,
        toolKind: request.readOnly ? 'read' : 'other',
        toolInput: {
          server: request.serverName,
          tool: request.toolName,
          ...(request.args !== undefined ? { arguments: request.args } : {}),
        },
      };
    case 'memory':
      return {
        title: 'Remember a fact',
        toolName: 'memory',
        toolKind: 'other',
        toolInput: { fact: bounded(request.fact) },
      };
    case 'custom-tool':
    case 'hook':
      return {
        title: `Use ${request.toolName}`,
        toolName: request.toolName,
        toolKind: 'other',
        toolInput: {},
      };
    default:
      return {
        title: `Allow a ${request.kind} request`,
        toolName: request.kind,
        toolKind: 'other',
        toolInput: {},
      };
  }
}

/** The SDK result for a person's answer. */
export function copilotPermissionResult(
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
): PermissionRequestResult {
  switch (decision) {
    case 'accept':
    case 'acceptForSession':
      // A session grant is remembered by Station (`copilotSessionGrantKey`),
      // never handed to the runtime as a wider rule of its own.
      return { kind: 'approve-once' };
    case 'decline':
      return { kind: 'reject' };
    case 'cancel':
      return { kind: 'user-not-available' };
  }
}

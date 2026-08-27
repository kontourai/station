/**
 * Tool Routes - MCP tool management
 */

import type { ToolDef } from '@kontourai/station-contracts/tool';
import { Hono } from 'hono';
import {
  markIntegrationEnabledExplicit,
  wasIntegrationEnabledExplicit,
} from '../../domain/config-loader-storage.js';
import { isRuntimeManagedIntegrationId } from '../../runtime/bootstrap/station-control-runtime-env.js';
import { MCPAppsToolAccessError } from '../../runtime/mcp/mcp-apps-metadata.js';
import { resolveMCPToolUIRef } from '../../runtime/mcp/mcp-ui-resolver.js';
import { normalizePersistedToolServerReason } from '../../security/tool-server-reason.js';
import {
  type ApprovalOutcome,
  ApprovalRegistry,
} from '../../services/approvals/approval-registry.js';
import { IntegrationIconAssets } from '../../services/plugins/integration-icon-assets.js';
import {
  MCPServerDisabledError,
  type MCPService,
  MCPToolDisabledError,
} from '../../services/plugins/mcp-service.js';
import {
  integrationIconAssetReads,
  mcpUiRenderPermissionAllows,
  mcpUiRenderPermissionRevokes,
  mcpUiResourceReadTotal,
  mcpUiToolCallRequestOpened,
  mcpUiToolCallRequestResolved,
  mcpUiToolCallTotal,
  toolDefinitionOps,
  toolServerCredentialWrites,
} from '../../telemetry/metrics.js';
import { resolveHomeDir } from '../../utils/paths.js';
import {
  errorMessage,
  getBody,
  integrationEnabledSchema,
  integrationSchema,
  integrationToolsApplySchema,
  param,
  validate,
} from '../schemas/schemas.js';

/**
 * Optional collaborators for the MCP-UI tool-call proxy (S2 approval+audit).
 * Absent in legacy/test wiring → the proxy keeps its original direct behavior.
 */
export interface McpUiCallDeps {
  /** Injectable for local icon route tests; production defaults to Station home. */
  integrationIconAssets?: Pick<IntegrationIconAssets, 'resolve'>;
  /**
   * Registry that opens an inbox approval and resolves to the human decision.
   * When present, an `approvalPolicy: 'require'` call BLOCKS on it before the
   * tool runs ("never direct execution").
   *
   * `registerForOutcome`, not `register`: the boolean form cannot tell a
   * refusal from an unanswered request, and this route has to say which to
   * the panel that made the call.
   */
  approvalRegistry?: Pick<ApprovalRegistry, 'registerForOutcome'>;
  /**
   * Attach an approved MCP-UI tool call's result as Flow evidence when the
   * call's session is bound to a run. Best-effort: never blocks the result.
   */
  attachMcpUiEvidence?: (input: {
    threadId: string;
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    result: unknown;
  }) => Promise<void>;
  /**
   * Per-server MCP-UI render permission (S2, allow + revoke). When present, a
   * server whose render is explicitly revoked resolves to `render_revoked` and
   * its UI never renders. Absent ⇒ legacy open behavior (everything renders).
   */
  isRenderRevoked?: (serverId: string) => boolean;
  /** Set the per-server render decision (false ⇒ revoke, true ⇒ re-allow). */
  setRenderAllowed?: (serverId: string, allow: boolean) => void | Promise<void>;
  /**
   * Request-authorized host delivery for model-visible read-only App tools.
   * Undefined means this tool has no specialized host initializer and may use
   * the ordinary app-visible MCP call path. The browser body never supplies
   * authority; production derives it from this exact Request.
   */
  readInitialMcpAppResult?: (input: {
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    request: Request;
  }) => Promise<unknown | undefined>;
}

/**
 * Why a gated MCP-UI tool call did not run, in words the person looking at the
 * panel can act on.
 *
 * This used to be one sentence — "The MCP-UI tool call was denied or timed
 * out" — for outcomes the registry already tells apart. Someone rejecting the
 * call and nobody answering it are different situations: the first means stop
 * asking, the second means answer the approval and try again. The registry
 * emits `denied` and `expired` as distinct lifecycle statuses; the route now
 * keeps that distinction instead of reading a collapsed boolean.
 *
 * Every entry stays a 403: the call was equally not permitted to run in all
 * four cases, so the status is not what distinguishes them — the message is.
 */
const MCP_UI_APPROVAL_REFUSALS: Readonly<
  Record<Exclude<ApprovalOutcome, 'approved'>, string>
> = {
  denied:
    'The MCP-UI tool call was denied in the approval inbox. It will not run unless it is approved there.',
  expired:
    'The MCP-UI tool call was never answered, and its approval request expired. Run it again and approve it in the inbox while it is open.',
  cancelled:
    'The MCP-UI tool call was cancelled before anyone answered its approval request, usually because the Station runtime shut down. Run it again.',
  unbound:
    'The MCP-UI tool call could not be sent for approval, because this call is not bound to a session that can approve it. Open the panel from a conversation and try again.',
};

function integrationReadProjection(
  def: Awaited<ReturnType<MCPService['getIntegration']>>,
) {
  const { env, secretEnv, storedEnvNames, secretEnvRefs, ...safe } = def;
  const probe = safe.probe
    ? {
        ...safe.probe,
        ...(safe.probe.error
          ? { error: normalizePersistedToolServerReason(safe.probe.error) }
          : {}),
        ...(safe.probe.authorization && 'reason' in safe.probe.authorization
          ? {
              authorization: {
                ...safe.probe.authorization,
                reason: normalizePersistedToolServerReason(
                  safe.probe.authorization.reason,
                ),
              },
            }
          : {}),
      }
    : undefined;
  return {
    ...safe,
    ...(probe ? { probe } : {}),
    // CI-R7: derived from the registered-id gate, not from `kind` (which is
    // `'mcp'` for both built-ins). A client uses it to stop offering a delete
    // the runtime undoes on its next start.
    builtin: isRuntimeManagedIntegrationId(safe.id),
    secretEnvKeys: [
      ...new Set([
        ...(storedEnvNames ?? Object.keys(env ?? {})),
        ...Object.keys(secretEnvRefs ?? {}),
      ]),
    ].sort(),
    requiresEnvSecrets: Boolean(
      (env && Object.keys(env).length > 0) ||
        (storedEnvNames && storedEnvNames.length > 0) ||
        Object.keys(secretEnvRefs ?? {}).length > 0,
    ),
  };
}

export function createToolRoutes(
  mcpService: MCPService,
  reinitialize: () => Promise<void>,
  mcpUiCallDeps: McpUiCallDeps = {},
) {
  const app = new Hono();
  const iconAssets =
    mcpUiCallDeps.integrationIconAssets ??
    new IntegrationIconAssets(resolveHomeDir());

  async function persistAndActivate(
    id: string,
    persist: () => Promise<ToolDef>,
  ): Promise<
    | { applied: true; def: ToolDef }
    | { applied: false; status: 400; error: string }
    | { applied: true; status: 202; def: ToolDef; data: unknown }
  > {
    const previous = await mcpService.getIntegration(id);
    const def = await persist();
    try {
      await reinitialize();
      return { applied: true, def };
    } catch (activationError) {
      try {
        const rollback = { ...previous };
        if (!wasIntegrationEnabledExplicit(previous)) delete rollback.enabled;
        await mcpService.saveIntegration(rollback);
        await reinitialize();
        return {
          applied: false,
          status: 400,
          error: `Change was not applied; runtime activation failed and the persisted configuration was rolled back: ${errorMessage(activationError)}`,
        };
      } catch (rollbackError) {
        const recovery = await mcpService.resetRuntimeState();
        const persisted = await mcpService.getIntegration(id).catch(() => def);
        return {
          applied: true,
          status: 202,
          def: persisted,
          data: {
            ...integrationReadProjection(persisted),
            live: recovery.rebuilt,
            restartRequired: !recovery.rebuilt,
            restartRequiredScope: recovery.rebuilt ? undefined : recovery.scope,
            activationError: errorMessage(activationError),
            reconciliationError: errorMessage(rollbackError),
          },
        };
      }
    }
  }

  // Same-origin artwork endpoint. The integration id selects a bounded local
  // directory; the resolver validates realpath containment, byte size and magic.
  app.get('/:id/icon', async (c) => {
    const id = param(c, 'id');
    const result = await iconAssets.resolve(id);
    integrationIconAssetReads.add(1, { result: result.status });
    if (result.status !== 'found') {
      return c.body(null, 404, {
        'Cache-Control': 'private, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      });
    }
    if (c.req.header('if-none-match') === result.asset.etag) {
      return c.body(null, 304, {
        ETag: result.asset.etag,
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      });
    }
    return c.body(new Uint8Array(result.asset.body), 200, {
      'Content-Type': result.asset.contentType,
      'Content-Length': String(result.asset.body.byteLength),
      ETag: result.asset.etag,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  // List all available tools (GET /tools)
  app.get('/', async (c) => {
    try {
      toolDefinitionOps.add(1, { op: 'list' });
      const [tools, agentMap, catalog] = await Promise.all([
        mcpService.listIntegrations(),
        mcpService.getToolAgentMap(),
        Promise.resolve(mcpService.getMCPToolCatalog()),
      ]);
      const data = tools.map((t) => ({
        ...t,
        builtin: isRuntimeManagedIntegrationId(t.id),
        usedBy: agentMap[t.id] || [],
        connected:
          mcpService.getConnectionStatus('default', t.id)?.connected ?? false,
        tools: catalog
          .filter((tool) => tool.serverId === t.id)
          .map((tool) => ({ name: tool.name, description: tool.description })),
        // Per-server render permission (S2). Default allowed; only false when
        // explicitly revoked. Drives the settings toggle's current state.
        renderAllowed: mcpUiCallDeps.isRenderRevoked
          ? !mcpUiCallDeps.isRenderRevoked(t.id)
          : true,
      }));
      return c.json({ success: true, data });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  // Create/update an integration (POST /integrations)
  app.post('/', validate(integrationSchema), async (c) => {
    try {
      const input = getBody(c) as ToolDef;
      const { env, ...safe } = input;
      delete safe.storedEnvNames;
      if (env)
        toolServerCredentialWrites.add(Object.keys(env).length, {
          operation: 'create',
        });
      await mcpService.saveIntegration({
        ...safe,
        ...(env ? { secretEnv: env } : {}),
        enabled: false,
      } as ToolDef);
      return c.json({ success: true });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  // Get single integration (GET /integrations/:id)
  app.get('/:id', async (c) => {
    try {
      const def = await mcpService.getIntegration(param(c, 'id'));
      return c.json({ success: true, data: integrationReadProjection(def) });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 404);
    }
  });

  // Resolve a canonical MCP UI layout ref (GET /integrations/:serverId/ui/:toolName)
  // Degraded resolutions (missing server/tool/resource) are successful answers
  // to the resolve question, so they return 200 with the state in data.status.
  app.get('/:serverId/ui/:toolName', async (c) => {
    try {
      const ref = `${param(c, 'serverId')}/${param(c, 'toolName')}`;
      const data = await resolveMCPToolUIRef(mcpService, ref, 'default', {
        isRenderRevoked: mcpUiCallDeps.isRenderRevoked,
      });
      return c.json({ success: true, data });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  // Read the resolved UI resource's content (GET /integrations/:serverId/ui/:toolName/resource).
  // Re-resolves the ref to pin serverId and read ONLY the tool's declared
  // `_meta.ui.resourceUri` — the client never supplies a URI, so there is no
  // arbitrary-resource read surface. Powers the sandboxed MCP-UI host render.
  app.get('/:serverId/ui/:toolName/resource', async (c) => {
    const serverId = param(c, 'serverId');
    try {
      const ref = `${serverId}/${param(c, 'toolName')}`;
      const resolution = await resolveMCPToolUIRef(mcpService, ref, 'default', {
        isRenderRevoked: mcpUiCallDeps.isRenderRevoked,
      });
      if (resolution.status !== 'success' || !resolution.resourceUri) {
        mcpUiResourceReadTotal.add(1, {
          server: serverId,
          result: resolution.status,
        });
        return c.json(
          {
            success: false,
            error: resolution.reason || 'MCP UI resource is not resolvable',
            status: resolution.status,
          },
          404,
        );
      }
      const data = await mcpService.readMCPUIResource(
        serverId,
        resolution.resourceUri,
      );
      mcpUiResourceReadTotal.add(1, { server: serverId, result: 'success' });
      return c.json({ success: true, data });
    } catch (error: unknown) {
      mcpUiResourceReadTotal.add(1, { server: serverId, result: 'error' });
      return c.json({ success: false, error: errorMessage(error) }, 502);
    }
  });

  // Read an mcp-ui.dev embedded UI resource (GET /integrations/:serverId/ui/:toolName/embedded).
  // For servers that ship the older mcp-ui.dev convention — the UI is returned
  // INSIDE a tool result rather than declared via SEP-1865 `_meta.ui.resourceUri`
  // — there is no static resource to `resources/read`. So this CALLS the tool
  // (fixed empty args, pinned to :serverId) and extracts the embedded `ui://`
  // resource. The UI only reaches here for a read-only-pinned component, so the
  // call is the operator-asserted display fetch.
  app.get('/:serverId/ui/:toolName/embedded', async (c) => {
    const serverId = param(c, 'serverId');
    try {
      // Render permission (S2): the embedded path renders a server's UI without
      // going through the resolver, so gate it explicitly. Default allowed.
      if (mcpUiCallDeps.isRenderRevoked?.(serverId)) {
        mcpUiResourceReadTotal.add(1, {
          server: serverId,
          result: 'render_revoked',
          dialect: 'mcp-ui-embedded',
        });
        return c.json(
          {
            success: false,
            error:
              'Rendering is disabled for this MCP server; re-enable it in settings.',
            status: 'render_revoked',
          },
          403,
        );
      }
      const data = await mcpService.readMCPUIResourceFromTool(
        serverId,
        param(c, 'toolName'),
      );
      mcpUiResourceReadTotal.add(1, {
        server: serverId,
        result: 'success',
        dialect: 'mcp-ui-embedded',
      });
      return c.json({ success: true, data });
    } catch (error: unknown) {
      mcpUiResourceReadTotal.add(1, {
        server: serverId,
        result: 'error',
        dialect: 'mcp-ui-embedded',
      });
      return c.json({ success: false, error: errorMessage(error) }, 502);
    }
  });

  // Proxy a UI-initiated MCP tool call (POST /integrations/:serverId/ui/call).
  // The connection is pinned to :serverId, so a UI can only call that server's
  // own tools — never pivot to another server.
  //
  // Gating keys on the layout's `approvalPolicy` (sent by the host bridge), NOT
  // on session presence — MCP-UI panels render in layout tabs without a thread:
  //   - 'read-only' → never executes a tool (spec-compliant error).
  //   - 'require'   → BLOCKS on an inbox approval before executing; deny/expiry
  //                   returns an error. This is the "never direct execution"
  //                   path: the iframe simply awaits its standard tool result.
  //   - otherwise   → direct call (legacy behavior; the client may still prompt).
  // An optional `threadId` is pure enrichment: it lets an approved call attach a
  // Flow-evidence receipt when the session is bound to a run.
  app.post('/:serverId/ui/call', async (c) => {
    const serverId = param(c, 'serverId');
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        tool?: unknown;
        arguments?: Record<string, unknown>;
        approvalPolicy?: unknown;
        threadId?: unknown;
        sessionId?: unknown;
      };
      if (typeof body.tool !== 'string' || body.tool.length === 0) {
        mcpUiToolCallTotal.add(1, { server: serverId, result: 'invalid' });
        return c.json(
          { success: false, error: 'A non-empty "tool" name is required' },
          400,
        );
      }
      const toolName = body.tool;
      const args = body.arguments ?? {};
      const approvalPolicy =
        typeof body.approvalPolicy === 'string'
          ? body.approvalPolicy
          : undefined;
      const threadId =
        typeof body.threadId === 'string' && body.threadId.length > 0
          ? body.threadId
          : undefined;

      if (approvalPolicy === 'read-only') {
        mcpUiToolCallTotal.add(1, { server: serverId, result: 'denied' });
        return c.json(
          {
            success: false,
            error:
              'Tool calls are not permitted for a read-only MCP-UI component',
          },
          403,
        );
      }

      if (approvalPolicy === 'require' && mcpUiCallDeps.approvalRegistry) {
        const approvalId = ApprovalRegistry.generateId('mcp-ui');
        mcpUiToolCallRequestOpened.add(1, { server: serverId, tool: toolName });
        const outcome = await mcpUiCallDeps.approvalRegistry.registerForOutcome(
          approvalId,
          {
            metadata: {
              source: 'runtime',
              title: `MCP-UI: ${toolName}`,
              toolName,
              tool: toolName,
              server: serverId,
              agentName: serverId,
              description: `An MCP-UI panel from ${serverId} requests calling ${toolName}.`,
              ...(threadId ? { conversationId: threadId } : {}),
            },
          },
        );
        mcpUiToolCallRequestResolved.add(1, {
          server: serverId,
          tool: toolName,
          decision: outcome,
        });
        if (outcome !== 'approved') {
          // `result: 'denied'` stays coarse here on purpose — this counter
          // records that the proxy refused the call, which is true of all
          // four outcomes. Which outcome it was lives on the counter above.
          mcpUiToolCallTotal.add(1, { server: serverId, result: 'denied' });
          return c.json(
            { success: false, error: MCP_UI_APPROVAL_REFUSALS[outcome] },
            403,
          );
        }
      }

      const data = await mcpService.callMCPUITool(serverId, toolName, args);
      mcpUiToolCallTotal.add(1, { server: serverId, result: 'success' });

      // Best-effort Flow-evidence receipt; never fails the tool result.
      if (threadId && mcpUiCallDeps.attachMcpUiEvidence) {
        try {
          await mcpUiCallDeps.attachMcpUiEvidence({
            threadId,
            serverId,
            toolName,
            arguments: args,
            result: data,
          });
        } catch {
          // evidence is non-blocking — swallow
        }
      }
      return c.json({ success: true, data });
    } catch (error: unknown) {
      if (
        error instanceof MCPAppsToolAccessError ||
        error instanceof MCPServerDisabledError ||
        error instanceof MCPToolDisabledError
      ) {
        mcpUiToolCallTotal.add(1, {
          server: serverId,
          result: 'visibility_denied',
        });
        return c.json({ success: false, error: error.message }, 403);
      }
      mcpUiToolCallTotal.add(1, { server: serverId, result: 'error' });
      return c.json({ success: false, error: errorMessage(error) }, 502);
    }
  });

  // Initial App data is a host-owned, fixed-path read. Unlike /ui/call it
  // accepts no body-selected tool or arguments: the pane descriptor already
  // captured both, and only a tool that declares readOnlyHint may be invoked.
  app.post('/:serverId/ui/:toolName/initial-result', async (c) => {
    const serverId = param(c, 'serverId');
    const toolName = param(c, 'toolName');
    try {
      if (mcpUiCallDeps.isRenderRevoked?.(serverId)) {
        return c.json(
          { success: false, error: 'Initial result unavailable' },
          403,
        );
      }
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(
          { success: false, error: 'Object arguments are required' },
          400,
        );
      }
      // The path fixes the server/tool; only descriptor-captured arguments are
      // accepted, never a body-selected tool or approval policy.
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !Object.hasOwn(body, 'arguments')
      ) {
        return c.json(
          { success: false, error: 'Object arguments are required' },
          400,
        );
      }
      const candidate = (body as { arguments?: unknown }).arguments;
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate)
      ) {
        return c.json(
          { success: false, error: 'Object arguments are required' },
          400,
        );
      }
      const args = candidate as Record<string, unknown>;
      const catalog = await mcpService.getMCPUIToolCatalog(serverId);
      const tool = catalog.available
        ? (catalog.tools.find((candidate) => {
            const record = candidate as Record<string, unknown>;
            return (
              record.originalName === toolName || record.toolName === toolName
            );
          }) as Record<string, unknown> | undefined)
        : undefined;
      const annotations = tool?.annotations as
        | Record<string, unknown>
        | undefined;
      if (!tool || annotations?.readOnlyHint !== true) {
        return c.json(
          {
            success: false,
            error:
              'Initial result is unavailable for this read-only MCP App tool',
          },
          404,
        );
      }
      const authorizedInitial = await mcpUiCallDeps.readInitialMcpAppResult?.({
        serverId,
        toolName,
        arguments: args,
        request: c.req.raw,
      });
      const result =
        authorizedInitial !== undefined
          ? authorizedInitial
          : await mcpService.callMCPUITool(serverId, toolName, args);
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 128 * 1024) {
        return c.json(
          { success: false, error: 'Initial result unavailable' },
          503,
        );
      }
      return c.json({ success: true, data: result });
    } catch {
      return c.json(
        { success: false, error: 'Initial result unavailable' },
        503,
      );
    }
  });

  // Set a server's MCP-UI render permission (POST /integrations/:serverId/ui/permissions).
  // Body: `{ allowRender: boolean }`. allowRender=false revokes rendering for
  // this server (its UI resolves to `render_revoked`); true clears the revoke
  // back to the open default. A deliberate operator setting — not an approval.
  app.post('/:serverId/ui/permissions', async (c) => {
    const serverId = param(c, 'serverId');
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        allowRender?: unknown;
      };
      if (typeof body.allowRender !== 'boolean') {
        return c.json(
          { success: false, error: 'A boolean "allowRender" is required' },
          400,
        );
      }
      await mcpUiCallDeps.setRenderAllowed?.(serverId, body.allowRender);
      if (body.allowRender) {
        mcpUiRenderPermissionAllows.add(1, { server: serverId });
      } else {
        mcpUiRenderPermissionRevokes.add(1, { server: serverId });
      }
      return c.json({
        success: true,
        data: { renderAllowed: body.allowRender },
      });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  // Update integration (PUT /integrations/:id)
  app.put('/:id', validate(integrationSchema.partial()), async (c) => {
    try {
      const id = param(c, 'id');
      const update = getBody(c) as Partial<ToolDef>;
      // Secret submission is merge-based: submitted env keys upsert, omitted
      // keys remain unchanged, and `{ env: {} }` is a no-op. Deletion is only
      // through `removeSecretEnvKeys`, which names every key to remove.
      if (Object.hasOwn(update, 'env')) {
        toolServerCredentialWrites.add(Object.keys(update.env ?? {}).length, {
          operation: 'upsert',
        });
        update.secretEnv = update.env;
        delete update.env;
      }
      const existing = await mcpService.getIntegration(id);
      // GET intentionally redacts env, so an ordinary edit round-trip omits it.
      // Omission and partial submission preserve untouched stored secrets.
      const merged: ToolDef = { ...existing, ...update, id };
      if (Object.hasOwn(update, 'secretEnv')) delete merged.env;
      if (Object.hasOwn(update, 'enabled')) {
        markIntegrationEnabledExplicit(merged);
      }
      if (
        !Object.hasOwn(update, 'enabled') &&
        !wasIntegrationEnabledExplicit(existing)
      ) {
        delete merged.enabled;
      }
      if (!Object.hasOwn(update, 'secretEnv') && existing.env) {
        merged.env = existing.env;
      }
      await mcpService.saveIntegration(merged);
      return c.json({ success: true });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  // Delete integration (DELETE /integrations/:id)
  app.delete('/:id', async (c) => {
    try {
      const id = param(c, 'id');
      // CI-R7: the runtime re-registers its own tool servers on every start,
      // so this delete removed the directory and the row came back on the
      // next reload — the caller was told an irreversible action succeeded
      // and nothing had happened. Refuse it, and name why.
      if (isRuntimeManagedIntegrationId(id)) {
        return c.json(
          {
            success: false,
            error:
              'This tool server is built into Station and is re-created every time it starts, so it cannot be deleted. Disable it instead.',
          },
          409,
        );
      }
      await mcpService.deleteIntegration(id);
      return c.json({ success: true });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  // Reconnect integration (POST /integrations/:id/reconnect)
  app.post('/:id/reconnect', async (c) => {
    try {
      toolDefinitionOps.add(1, { op: 'reconnect' });
      const def = await mcpService.probeIntegration(param(c, 'id'));
      if (def.enabled !== false) await reinitialize();
      return c.json({ success: true, data: integrationReadProjection(def) });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.post('/:id/enabled', validate(integrationEnabledSchema), async (c) => {
    try {
      const id = param(c, 'id');
      const body = getBody(c) as { enabled?: unknown };
      if (typeof body.enabled !== 'boolean')
        throw new Error('enabled must be boolean');
      const result = await persistAndActivate(id, () =>
        mcpService.setEnabled(id, body.enabled as boolean),
      );
      if (!result.applied) {
        return c.json({ success: false, error: result.error }, result.status);
      }
      if ('status' in result && result.status === 202) {
        return c.json({ success: true, data: result.data }, 202);
      }
      return c.json({
        success: true,
        data: integrationReadProjection(result.def),
      });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.post('/:id/oauth/authorize', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        mode?: unknown;
      };
      if (body.mode !== 'local' && body.mode !== 'remote')
        throw new Error('mode must be local or remote');
      const data = await mcpService.startOAuth(param(c, 'id'), body.mode);
      return c.json({ success: true, data });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.post('/:id/oauth/callback', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        callbackUrl?: unknown;
      };
      if (typeof body.callbackUrl !== 'string')
        throw new Error('callbackUrl must be a string');
      const def = await mcpService.finishOAuth(
        param(c, 'id'),
        body.callbackUrl,
      );
      return c.json({ success: true, data: integrationReadProjection(def) });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.post(
    '/:id/tools/apply',
    validate(integrationToolsApplySchema),
    async (c) => {
      try {
        const body = getBody(c) as { disabledTools?: unknown };
        if (
          !Array.isArray(body.disabledTools) ||
          !body.disabledTools.every((v) => typeof v === 'string')
        ) {
          throw new Error('disabledTools must be an array of strings');
        }
        const id = param(c, 'id');
        const result = await persistAndActivate(id, () =>
          mcpService.applyDisabledTools(id, body.disabledTools as string[]),
        );
        if (!result.applied) {
          return c.json({ success: false, error: result.error }, result.status);
        }
        if ('status' in result && result.status === 202) {
          return c.json({ success: true, data: result.data }, 202);
        }
        return c.json({
          success: true,
          data: integrationReadProjection(result.def),
        });
      } catch (error: unknown) {
        return c.json({ success: false, error: errorMessage(error) }, 400);
      }
    },
  );

  return app;
}

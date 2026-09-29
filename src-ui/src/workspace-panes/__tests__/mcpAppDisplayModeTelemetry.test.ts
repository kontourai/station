import type { MCPAppDisplayModeDecision } from '@kontourai/station-contracts/mcp-app-display-mode';
import { describe, expect, test, vi } from 'vitest';
import { trackMcpAppDisplayModeDecision } from '../mcpAppDisplayModeTelemetry';

// Identity a caller's decision object might carry alongside the policy facts.
const IDENTITY = {
  descriptorId: 'plugin.secret-pane',
  instanceId: 'instance-7f3a',
  stateKey: 'pane-state:secret',
  serverId: 'mcp-server-secret',
  resourceUri: 'ui://secret/resource',
  pluginId: 'secret-plugin',
};

describe('MCP App display-mode production telemetry', () => {
  test.each([
    {
      outcome: 'accepted' as const,
      requestedMode: 'fullscreen' as const,
      actualMode: 'fullscreen' as const,
      panePresentation: 'maximized' as const,
      popout: false as const,
      reason: undefined,
    },
    {
      outcome: 'declined' as const,
      requestedMode: 'fullscreen' as const,
      actualMode: 'inline' as const,
      panePresentation: 'inline' as const,
      popout: false as const,
      reason: 'host-mode-unavailable' as const,
    },
    {
      outcome: 'unsupported' as const,
      requestedMode: 'pip' as const,
      actualMode: 'inline' as const,
      panePresentation: 'inline' as const,
      popout: false as const,
      reason: 'pip-unsupported' as const,
    },
  ])(
    'emits bounded $outcome evidence without occurrence or contributor identity',
    (decision) => {
      const track = vi.fn();
      trackMcpAppDisplayModeDecision(
        { ...decision, ...IDENTITY } as MCPAppDisplayModeDecision,
        track,
      );
      expect(track).toHaveBeenCalledWith(
        'ui.workspace_pane.mcp_display_mode_decision',
        {
          renderer: 'sandboxed-mcp-app',
          category: 'display-mode',
          outcome: decision.outcome,
          reason: decision.reason ?? 'none',
          requested_mode: decision.requestedMode,
          actual_mode: decision.actualMode,
        },
      );
      const emitted = JSON.stringify(track.mock.calls);
      for (const value of Object.values(IDENTITY))
        expect(emitted).not.toContain(value);
    },
  );
});

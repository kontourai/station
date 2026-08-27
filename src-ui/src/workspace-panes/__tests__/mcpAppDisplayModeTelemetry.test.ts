import { describe, expect, test, vi } from 'vitest';
import {
  MCP_APP_DISPLAY_MODE_EVENT,
  trackMcpAppDisplayModeDecision,
} from '../mcpAppDisplayModeTelemetry';

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
      trackMcpAppDisplayModeDecision(decision, track);
      expect(track).toHaveBeenCalledWith(MCP_APP_DISPLAY_MODE_EVENT, {
        renderer: 'sandboxed-mcp-app',
        category: 'display-mode',
        outcome: decision.outcome,
        reason: decision.reason ?? 'none',
        requested_mode: decision.requestedMode,
        actual_mode: decision.actualMode,
      });
      expect(JSON.stringify(track.mock.calls)).not.toMatch(
        /descriptor|instance|stateKey|server|resource|pluginId/,
      );
    },
  );
});

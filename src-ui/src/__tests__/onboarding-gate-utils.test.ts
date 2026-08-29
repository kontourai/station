import type { SystemStatus } from '@kontourai/station-sdk';
import { describe, expect, test } from 'vitest';
import {
  buildSetupBannerContent,
  configuredLlmProviders,
  setupBannerVariant,
  shouldShowSetupBanner,
} from '../components/onboardingGateUtils';

function createStatus(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    prerequisites: [],
    acp: {
      connected: false,
      connections: [],
    },
    providers: {
      configuredChatReady: false,
      configured: [],
      detected: {
        ollama: false,
        bedrock: false,
      },
    },
    clis: {},
    recommendation: {
      code: 'unconfigured',
      type: 'connections',
      actionLabel: 'Open Connections',
      title: 'No usable AI path is configured yet',
      detail:
        'Start Ollama locally or add a provider/runtime connection to make Station ready for first-run chat.',
    },
    ready: false,
    ...overrides,
  };
}

describe('onboardingGateUtils', () => {
  test('shows generic setup guidance when nothing is configured or detected', () => {
    const status = createStatus();

    expect(shouldShowSetupBanner(status)).toBe(true);
    expect(setupBannerVariant(status)).toBe('unconfigured');
    expect(configuredLlmProviders(status)).toEqual([]);
    expect(buildSetupBannerContent(status)).toEqual({
      title: 'Choose what powers Station',
      description:
        'Add a model connection or engine for chat, agents, or both.',
      actionLabel: 'Open Connections',
      badges: [],
      actionTarget: 'providers',
    });
  });

  test('does not present setup work for a ready adopted engine', () => {
    const status = createStatus({
      externalEngines: [
        {
          engineId: engineId('claude-code'),
          name: 'Claude Code',
          detected: true,
          ready: true,
          source: 'claude-cli',
        },
      ],
      recommendation: {
        code: 'runtime-only',
        type: 'runtimes',
        actionLabel: 'Review engines',
        title: 'An engine is available',
        detail: 'Station found a ready engine that can start a chat.',
      },
      ready: true,
    });

    expect(setupBannerVariant(status)).toBe('hidden');
    expect(shouldShowSetupBanner(status)).toBe(false);
  });

  test('ready-path precedence hides setup when another detected engine needs attention', () => {
    const status = createStatus({
      externalEngines: [
        {
          engineId: engineId('claude-code'),
          name: 'Claude Code',
          engineConnectionId: engineConnectionId('claude'),
          detected: true,
          ready: true,
          source: 'claude-cli',
        },
        {
          engineId: engineId('codex'),
          name: 'Codex',
          engineConnectionId: engineConnectionId('codex'),
          detected: true,
          ready: false,
          source: null,
          reason: 'sign_in_required',
        },
      ],
      recommendation: {
        code: 'runtime-only',
        type: 'runtimes',
        actionLabel: 'Review engines',
        title: 'An engine is available',
        detail: 'Claude Code can already start chat.',
      },
      ready: true,
    });

    expect(setupBannerVariant(status)).toBe('hidden');
    expect(shouldShowSetupBanner(status)).toBe(false);
  });

  test('names the detected engine that needs sign-in instead of sending users through generic setup', () => {
    const status = createStatus({
      externalEngines: [
        {
          engineId: engineId('codex'),
          name: 'Codex',
          engineConnectionId: engineConnectionId('codex'),
          detected: true,
          ready: false,
          source: null,
          reason: 'sign_in_required',
        },
      ],
    });

    expect(setupBannerVariant(status)).toBe('engine-needs-attention');
    expect(buildSetupBannerContent(status)).toMatchObject({
      title: 'Codex needs attention',
      description: 'Sign in to Codex, then Station will be ready to use it.',
      actionLabel: 'Sign in to Codex',
      actionTarget: 'engine',
      engineConnectionId: 'codex',
    });
  });

  test('keeps an unverifiable engine distinct from a sign-in requirement', () => {
    const status = createStatus({
      externalEngines: [
        {
          engineId: engineId('plugin-engine'),
          name: 'Plugin Engine',
          detected: false,
          ready: false,
          source: null,
          reason: 'cannot_verify',
        },
      ],
    });

    expect(buildSetupBannerContent(status)).toMatchObject({
      description: 'Station cannot verify that Plugin Engine is ready yet.',
      actionLabel: 'Review Plugin Engine',
      actionTarget: 'connections',
    });
  });

  test('names a detected engine that was disabled', () => {
    const status = createStatus({
      externalEngines: [
        {
          engineId: engineId('claude-code'),
          name: 'Claude Code',
          detected: true,
          ready: false,
          source: null,
          reason: 'disabled',
        },
      ],
    });

    expect(buildSetupBannerContent(status)).toMatchObject({
      description:
        'Claude Code is turned off. Turn it on to use it in Station.',
      actionLabel: 'Enable Claude Code',
    });
  });

  test('shows detection-led guidance when Ollama is reachable', () => {
    const status = createStatus({
      providers: {
        configuredChatReady: false,
        configured: [],
        detected: {
          ollama: true,
          bedrock: false,
        },
      },
      recommendation: {
        code: 'detected-provider',
        type: 'providers',
        actionLabel: 'Add Ollama connection',
        title: 'Ollama is available',
        detail:
          'Create a model connection for the detected local Ollama server to make first-run chat explicit.',
        detectedProviderType: 'ollama',
        detectedProviderLabel: 'Ollama',
      },
      ready: true,
    });

    expect(shouldShowSetupBanner(status)).toBe(true);
    expect(setupBannerVariant(status)).toBe('detected-provider');
    expect(buildSetupBannerContent(status)).toEqual({
      title: 'Ollama is available',
      description:
        'Create a model connection for the detected local Ollama server to make first-run chat explicit.',
      actionLabel: 'Review Connections',
      badges: ['Detected: Ollama'],
      actionTarget: 'providers',
    });
  });

  test('shows generic setup guidance when only vectordb providers exist', () => {
    const status = createStatus({
      providers: {
        configuredChatReady: false,
        configured: [
          {
            id: 'lancedb-builtin',
            type: 'lancedb',
            enabled: true,
            capabilities: ['vectordb'],
          },
        ],
        detected: {
          ollama: false,
          bedrock: false,
        },
      },
      recommendation: {
        code: 'unconfigured',
        type: 'connections',
        actionLabel: 'Open Connections',
        title: 'No usable AI path is configured yet',
        detail:
          'Start Ollama locally or add a provider/runtime connection to make Station ready for first-run chat.',
      },
    });

    expect(shouldShowSetupBanner(status)).toBe(true);
    expect(setupBannerVariant(status)).toBe('unconfigured');
    expect(buildSetupBannerContent(status)).toEqual({
      title: 'Choose what powers Station',
      description:
        'Add a model connection or engine for chat, agents, or both.',
      actionLabel: 'Open Connections',
      badges: [],
      actionTarget: 'providers',
    });
  });

  test('prefers ollama detection over vectordb-only configured providers', () => {
    const status = createStatus({
      providers: {
        configuredChatReady: false,
        configured: [
          {
            id: 'lancedb-builtin',
            type: 'lancedb',
            enabled: true,
            capabilities: ['vectordb'],
          },
        ],
        detected: {
          ollama: true,
          bedrock: false,
        },
      },
      recommendation: {
        code: 'detected-provider',
        type: 'providers',
        actionLabel: 'Add Ollama connection',
        title: 'Ollama is available',
        detail:
          'Create a model connection for the detected local Ollama server to make first-run chat explicit.',
        detectedProviderType: 'ollama',
        detectedProviderLabel: 'Ollama',
      },
      ready: true,
    });

    expect(setupBannerVariant(status)).toBe('detected-provider');
  });

  test('a configured and ready llm provider does not interrupt Home with setup', () => {
    const status = createStatus({
      providers: {
        configuredChatReady: true,
        configured: [
          {
            id: 'ollama-local',
            type: 'ollama',
            enabled: true,
            capabilities: ['llm', 'embedding'],
          },
        ],
        detected: {
          ollama: true,
          bedrock: false,
        },
      },
      recommendation: {
        code: 'configured-chat-ready',
        type: 'providers',
        actionLabel: 'Review model connections',
        title: 'A chat-capable model connection is already configured',
        detail:
          'Station can already route chat through ollama. Review connections if you want to change the default.',
      },
      ready: true,
    });

    expect(configuredLlmProviders(status)).toHaveLength(1);
    expect(setupBannerVariant(status)).toBe('hidden');
    expect(shouldShowSetupBanner(status)).toBe(false);
  });

  test('an ACP-connected session does not interrupt Home with setup', () => {
    const status = createStatus({
      acp: {
        connected: true,
        connections: [{ id: 'kiro', status: 'available' }],
      },
      ready: true,
    });

    expect(setupBannerVariant(status)).toBe('hidden');
    expect(shouldShowSetupBanner(status)).toBe(false);
  });

  test('shows disabled llm providers as configured but not enabled', () => {
    const status = createStatus({
      providers: {
        configuredChatReady: false,
        configured: [
          {
            id: 'bedrock-default',
            type: 'bedrock',
            enabled: false,
            capabilities: ['llm'],
          },
        ],
        detected: {
          ollama: false,
          bedrock: true,
        },
      },
      recommendation: {
        code: 'configured-no-chat',
        type: 'providers',
        actionLabel: 'Manage model connections',
        title: 'No chat-capable connection is enabled',
        detail:
          'Model connections are configured, but none can run chat yet. Enable or repair a model connection in Connections.',
      },
    });

    expect(configuredLlmProviders(status)).toEqual([]);
    expect(setupBannerVariant(status)).toBe('configured-no-chat');
    expect(buildSetupBannerContent(status)).toEqual({
      title: 'No model connection is ready for chat',
      description:
        'Enable or repair a model connection in Connections before starting a chat.',
      actionLabel: 'Manage Connections',
      badges: ['Disabled: Amazon Bedrock'],
      actionTarget: 'providers',
    });
  });

  test('collapses duplicate configured connections into one counted badge', () => {
    const status = createStatus({
      providers: {
        configuredChatReady: false,
        configured: [
          { id: 'a', type: 'ollama', enabled: true, capabilities: ['llm'] },
          { id: 'b', type: 'ollama', enabled: true, capabilities: ['llm'] },
          { id: 'c', type: 'ollama', enabled: true, capabilities: ['llm'] },
          {
            id: 'd',
            type: 'bedrock',
            enabled: false,
            capabilities: ['llm'],
          },
        ],
        detected: {
          ollama: false,
          bedrock: false,
        },
      },
      recommendation: {
        code: 'configured-no-chat',
        type: 'providers',
        actionLabel: 'Manage model connections',
        title: 'No chat-capable connection is enabled',
        detail:
          'Model connections are configured, but none can run chat yet. Enable or repair a model connection in Connections.',
      },
    });

    expect(buildSetupBannerContent(status).badges).toEqual([
      'Configured: Ollama ×3',
      'Disabled: Amazon Bedrock',
    ]);
    // Mirrors the server's state-accurate generic branch: this one client
    // string covers three server branches, so it must never claim a
    // "default" the none-enabled state does not have.
    expect(buildSetupBannerContent(status)).toEqual(
      expect.objectContaining({
        title: 'No model connection is ready for chat',
        description:
          'Enable or repair a model connection in Connections before starting a chat.',
      }),
    );
  });

  test('an already-available agent engine hides setup', () => {
    const status = createStatus({
      recommendation: {
        code: 'runtime-only',
        type: 'runtimes',
        actionLabel: 'Review engines',
        title: 'An engine is available before chat is configured',
        detail:
          'Connected engines are detectable, but there is still no explicit chat-capable model connection configured.',
      },
      clis: {
        codex: true,
      },
      ready: false,
    });

    expect(setupBannerVariant(status)).toBe('hidden');
    expect(shouldShowSetupBanner(status)).toBe(false);
    expect(buildSetupBannerContent(status)).toEqual({
      title: '',
      description: '',
      actionLabel: '',
      badges: [],
      actionTarget: 'connections',
    });
  });

  // archive#1193: "chat ready" is engine-agnostic — the
  // UI mirrors whatever the backend's `recommendation.code`/`ready` already
  // decided (system-status-routes.ts's `resolveExternalEngineReadiness`),
  // rather than re-deriving readiness from `clis`/provider names itself. This
  // block pins that mirroring for every case archive#1193 requires: ACP
  // connected, a ready+authed native engine (Claude Code, Codex), a Station
  // model connection alone, and the negative case (CLI present but not
  // authenticated) staying NOT hidden.
  describe('engine-agnostic chat readiness (station#1193)', () => {
    test('hides the banner when an ACP engine is connected, with no model connection', () => {
      const status = createStatus({
        acp: {
          connected: true,
          connections: [{ id: 'kiro', status: 'available' }],
        },
        recommendation: {
          code: 'runtime-only',
          type: 'runtimes',
          actionLabel: 'Review engines',
          title: 'An engine is available',
          detail:
            'Station detected a ready engine. Ready engines can start a chat without a separate model connection.',
        },
        ready: true,
      });

      expect(setupBannerVariant(status)).toBe('hidden');
      expect(shouldShowSetupBanner(status)).toBe(false);
    });

    test('hides setup for a ready+authed Claude-Code-shaped external engine', () => {
      const status = createStatus({
        clis: { claude: true },
        recommendation: {
          code: 'runtime-only',
          type: 'runtimes',
          actionLabel: 'Review engines',
          title: 'An engine is available',
          detail:
            'Station detected a ready engine. Ready engines can start a chat without a separate model connection.',
        },
        ready: true,
      });

      expect(setupBannerVariant(status)).toBe('hidden');
      expect(shouldShowSetupBanner(status)).toBe(false);
    });

    test('hides setup for a ready+authed Codex-shaped external engine', () => {
      const status = createStatus({
        clis: { codex: true },
        recommendation: {
          code: 'runtime-only',
          type: 'runtimes',
          actionLabel: 'Review engines',
          title: 'An engine is available',
          detail:
            'Station detected a ready engine. Ready engines can start a chat without a separate model connection.',
        },
        ready: true,
      });

      expect(setupBannerVariant(status)).toBe('hidden');
      expect(shouldShowSetupBanner(status)).toBe(false);
    });

    test('a Station model connection alone hides setup too, symmetric with an external engine', () => {
      const status = createStatus({
        providers: {
          configuredChatReady: true,
          configured: [
            {
              id: 'bedrock-default',
              type: 'bedrock',
              enabled: true,
              capabilities: ['llm'],
            },
          ],
          detected: { ollama: false, bedrock: true },
        },
        recommendation: {
          code: 'configured-chat-ready',
          type: 'providers',
          actionLabel: 'Review model connections',
          title: 'A chat-capable model connection is already configured',
          detail:
            'Station can already route chat through bedrock. Review connections if you want to change the default.',
        },
        ready: true,
      });

      expect(setupBannerVariant(status)).toBe('hidden');
      expect(shouldShowSetupBanner(status)).toBe(false);
    });

    test('does NOT surface the engine picker (or hide the banner) when an external engine CLI is installed but not authenticated', () => {
      // The backend never emits `runtime-only`/`ready: true` for an
      // installed-but-unauthenticated engine (resolveExternalEngineReadiness
      // requires CLI resolvable AND authenticated) -- this is exactly the
      // "clis: true" case that used to leak through the old bare-`which`
      // reading. With nothing else configured or detected, the honest
      // backend state is `unconfigured`/`ready: false`, and the UI must keep
      // showing setup guidance rather than treating CLI presence alone as
      // readiness.
      const status = createStatus({
        clis: { codex: true },
        recommendation: {
          code: 'unconfigured',
          type: 'connections',
          actionLabel: 'Open Connections',
          title: 'No usable AI path is configured yet',
          detail:
            'Start a local model or add a Model or engine connection to make Station ready for first-run chat.',
        },
        ready: false,
      });

      expect(setupBannerVariant(status)).toBe('unconfigured');
      expect(shouldShowSetupBanner(status)).toBe(true);
    });
  });

  // archive#chat-dock-maximize-readiness: while prerequisite discovery is
  // `pending`, the status route serves an all-false placeholder snapshot that
  // reads as 'unconfigured'. The onboarding conclusion must be withheld until
  // discovery settles, so a genuinely ready Claude/Codex/ACP/Ollama path can
  // suppress the launcher instead of flashing a false setup overlay.
  describe('provisional pending-state safety', () => {
    test('withholds the setup conclusion while discovery is pending, even with an all-false snapshot', () => {
      const status = createStatus({ prerequisitesState: 'pending' });

      expect(setupBannerVariant(status)).toBe('hidden');
      expect(shouldShowSetupBanner(status)).toBe(false);
    });

    test('settles to the normal conclusion once discovery is ready', () => {
      const pending = createStatus({ prerequisitesState: 'pending' });
      expect(shouldShowSetupBanner(pending)).toBe(false);

      const settled = createStatus({ prerequisitesState: 'ready' });
      expect(setupBannerVariant(settled)).toBe('unconfigured');
      expect(shouldShowSetupBanner(settled)).toBe(true);
    });

    test('still suppresses setup when a ready engine path exists once discovery settles', () => {
      const status = createStatus({
        prerequisitesState: 'ready',
        clis: { claude: true },
        recommendation: {
          code: 'runtime-only',
          type: 'runtimes',
          actionLabel: 'Review engines',
          title: 'An engine is available',
          detail:
            'Station detected a ready engine. Ready engines can start a chat without a separate model connection.',
        },
        ready: true,
      });

      expect(setupBannerVariant(status)).toBe('hidden');
      expect(shouldShowSetupBanner(status)).toBe(false);
    });

    test('treats stale as settled (a stale snapshot still reflects real discovery)', () => {
      const status = createStatus({ prerequisitesState: 'stale' });

      expect(setupBannerVariant(status)).toBe('unconfigured');
      expect(shouldShowSetupBanner(status)).toBe(true);
    });
  });
});

import {
  engineConnectionId,
  engineId,
} from '@kontourai/station-contracts/agent-identity';

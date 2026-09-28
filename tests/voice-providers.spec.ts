/**
 * E2E: Voice Provider Pattern
 *
 * Tests the new provider-registry architecture introduced in feat/station-connect.
 * Uses Playwright route interception to avoid a real server dependency.
 *
 * Coverage:
 *  - Settings › Settings shows STT/TTS provider dropdowns
 *  - Default WebSpeech provider is pre-selected among several
 *  - Provider selection persists to localStorage
 *  - Context provider toggles (geolocation, timezone) render and toggle
 *  - Exactly one floating mic (the S2S pill) on mobile when voice is enabled
 *  - VoiceOrb is still rendered inside the chat input area
 *  - /api/system/capabilities response populates provider dropdowns
 */
import { expect, test } from '@playwright/test';
import {
  openChatRegion,
  seedActiveChats,
  seedOrchestrationRoutes,
} from './helpers/orchestration';
import { mockRuntimeConversation } from './helpers/runtime-conversation-fixture';

// Seed a connected server so the app skips onboarding
const SEED_STORAGE = () => {
  window.localStorage.setItem(
    'station-connect-connections',
    JSON.stringify([
      {
        id: 'c1',
        name: 'Dev Server',
        url: window.location.origin,
        lastConnected: Date.now(),
      },
    ]),
  );
  window.localStorage.setItem('station-connect-connections-active', 'c1');
};

const CAPABILITIES_RESPONSE = JSON.stringify({
  voice: {
    stt: [
      {
        id: 'webspeech',
        name: 'WebSpeech (Browser)',
        clientOnly: true,
        visibleOn: ['all'],
        configured: true,
      },
    ],
    tts: [
      {
        id: 'webspeech',
        name: 'WebSpeech (Browser)',
        clientOnly: true,
        visibleOn: ['all'],
        configured: true,
      },
    ],
  },
  context: {
    providers: [
      { id: 'geolocation', name: 'Geolocation', visibleOn: ['mobile'] },
      { id: 'timezone', name: 'Timezone', visibleOn: ['all'] },
    ],
  },
});

/**
 * A capabilities response whose STT list is WebSpeech plus the given
 * server-backed (not client-only) providers.
 */
function capabilitiesWithServerSTT(
  ...servers: { id: string; name: string; configured: boolean }[]
) {
  const webspeech = {
    id: 'webspeech',
    name: 'WebSpeech (Browser)',
    clientOnly: true,
    visibleOn: ['all'],
    configured: true,
  };
  return JSON.stringify({
    voice: {
      stt: [
        webspeech,
        ...servers.map((server) => ({
          ...server,
          clientOnly: false,
          visibleOn: ['all'],
        })),
      ],
      tts: [webspeech],
    },
    context: { providers: [] },
  });
}

const STATUS_READY = JSON.stringify({
  ready: true,
  acp: { connected: false, connections: [] },
  clis: {},
  prerequisites: [],
  providers: {
    configuredChatReady: true,
    configured: [
      {
        id: 'voice-test-runtime',
        type: 'codex',
        enabled: true,
        capabilities: ['llm'],
      },
    ],
    detected: { ollama: false, bedrock: false },
  },
  capabilities: {
    chat: {
      ready: true,
      source: 'voice-test-runtime',
    },
  },
});

/** Open the Voice section directly and wait for its real surface. */
async function openSettings(page: import('@playwright/test').Page) {
  await page.goto('/settings?section=voice');
  await expect(page.getByRole('heading', { name: 'Voice' })).toBeVisible();
}

test.describe('Voice Providers — Settings UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(SEED_STORAGE);
    // Register catch-all FIRST (Playwright matches LIFO — last registered wins)
    await page.route('**/api/**', (r) => {
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"agents":[],"plugins":[]}',
      });
    });
    // Specific routes registered AFTER catch-all so they take priority
    await page.route('**/api/system/status', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: STATUS_READY,
      }),
    );
    await page.route('**/api/system/capabilities', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: CAPABILITIES_RESPONSE,
      }),
    );
  });

  test('Settings shows STT provider dropdown', async ({ page }) => {
    await openSettings(page);
    await expect(page.locator('text=Speech-to-text')).toBeVisible();
    const sttSelect = page.locator('[data-testid="stt-provider-select"]');
    await expect(sttSelect).toBeVisible();
    await expect(sttSelect).toContainText('WebSpeech');
  });

  test('Settings shows TTS provider dropdown', async ({ page }) => {
    await openSettings(page);
    await expect(page.locator('text=Text-to-speech')).toBeVisible();
    const ttsSelect = page.locator('[data-testid="tts-provider-select"]');
    await expect(ttsSelect).toBeVisible();
    await expect(ttsSelect).toContainText('WebSpeech');
  });

  test('WebSpeech is the default selected STT provider', async ({ page }) => {
    // Clear any saved selection so we get the default
    await page.addInitScript(`
      window.localStorage.removeItem('station-stt-provider');
      window.localStorage.removeItem('station-tts-provider');
    `);
    // A second configured provider, so the default is a CHOICE: a <select>
    // holding only WebSpeech reports it whatever the default logic says.
    await page.route('**/api/system/capabilities', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: capabilitiesWithServerSTT({
          id: 'elevenlabs',
          name: 'ElevenLabs Scribe',
          configured: true,
        }),
      }),
    );
    await openSettings(page);
    const sttSelect = page.locator('[data-testid="stt-provider-select"]');
    await expect(sttSelect).toContainText('ElevenLabs Scribe');
    await expect(sttSelect).toHaveValue('webspeech');
  });

  test('provider selection persists to the device-settings envelope', async ({
    page,
  }) => {
    // Persistence is only observable on a GENUINE change — the device
    // store's same-value set() is a deliberate no-op (slice-2 review
    // round). The option list comes from the client-side provider registry
    // (webspeech is the only registered provider here), so seed the
    // envelope with a different stored value pre-boot and select the real
    // provider: value changes 'nova' -> 'webspeech' through the handler.
    await page.addInitScript(() => {
      localStorage.setItem(
        'station-device-settings-v1',
        JSON.stringify({ version: 1, values: { sttProvider: 'nova' } }),
      );
    });
    await openSettings(page);
    const sttSelect = page.locator('[data-testid="stt-provider-select"]');
    await sttSelect.selectOption('webspeech');
    // Slice 2 (archive#1271): the raw station-stt-provider key migrated into
    // the versioned device-settings envelope.
    const stored = await page.evaluate(() => {
      const raw = localStorage.getItem('station-device-settings-v1');
      return raw ? JSON.parse(raw).values?.sttProvider : null;
    });
    expect(stored).toBe('webspeech');
  });

  test('context provider toggle changes enabled state', async ({ page }) => {
    await openSettings(page);
    await expect(page.locator('text=Message Context')).toBeVisible();
    // Timezone is visibleOn 'all', so it renders on desktop too.
    const toggle = page.getByRole('switch', { name: 'Timezone' });
    const before = await toggle.getAttribute('aria-checked');
    expect(before === 'true' || before === 'false').toBe(true);
    const after = before === 'true' ? 'false' : 'true';
    // In-memory by design (the context registry persists nothing), so the
    // flip is observed on the switch, and a second click flips it back.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', after);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', before as string);
  });

  test('WisprFlow hint is displayed below STT dropdown', async ({ page }) => {
    await openSettings(page);
    await expect(page.locator('text=WisprFlow')).toBeVisible();
  });

  test('TTS readback toggle is still present', async ({ page }) => {
    await openSettings(page);
    await expect(page.locator('text=Read replies aloud')).toBeVisible();
  });
});

test.describe('Voice Providers — server capability discovery', () => {
  test('only configured server providers are registered in the STT dropdown', async ({
    page,
  }) => {
    await page.addInitScript(SEED_STORAGE);
    await page.route('**/api/**', (r) => {
      r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.route('**/api/system/status', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: STATUS_READY,
      }),
    );
    await page.route('**/api/system/capabilities', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: capabilitiesWithServerSTT(
          { id: 'elevenlabs', name: 'ElevenLabs Scribe', configured: true },
          { id: 'nova-sonic', name: 'Nova Sonic', configured: false },
        ),
      }),
    );

    await openSettings(page);
    const sttSelect = page.locator('[data-testid="stt-provider-select"]');
    // The configured provider arriving proves the capabilities response has
    // been applied, so the absence below is not read before it lands.
    await expect(sttSelect).toContainText('ElevenLabs Scribe');
    await expect(sttSelect).not.toContainText('Nova Sonic');
  });
});

test.describe('Voice Providers — global floating mic', () => {
  test.use({ viewport: { width: 390, height: 844 } }); // iPhone 14 Pro

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(SEED_STORAGE);
    // The floating voice affordance is gated behind the voice-S2S toggle
    // (default off) so the user never sees a non-functional mic. Enable it
    // here to exercise the rendered path. There is exactly ONE floating mic —
    // the S2S pill; the legacy STT FAB was removed because the two together
    // showed a mic in each bottom corner.
    await page.addInitScript(() => {
      localStorage.setItem(
        'station-feature-settings',
        JSON.stringify({ voiceS2SEnabled: true }),
      );
    });
    await page.addInitScript(() => {
      function SpeechRecognitionMock(this: any) {
        this.continuous = false;
        this.interimResults = false;
        this.start = () => this.onstart?.();
        this.stop = () => this.onend?.();
        this.abort = () => {};
        this.onstart = null;
        this.onresult = null;
        this.onerror = null;
        this.onend = null;
      }
      (window as any).SpeechRecognition = SpeechRecognitionMock;
      (window as any).webkitSpeechRecognition = SpeechRecognitionMock;
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async () => ({
            getTracks: () => [{ stop: () => {} }],
          }),
        },
      });
    });
    await page.route('**/api/**', (r) => {
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"agents":[],"plugins":[]}',
      });
    });
    await page.route('**/api/system/status', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: STATUS_READY,
      }),
    );
    await page.route('**/api/system/capabilities', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: CAPABILITIES_RESPONSE,
      }),
    );
  });

  test('exactly one floating mic (the S2S pill) when voice is enabled', async ({
    page,
  }) => {
    await page.goto('/');
    const pill = page.locator('[data-testid="voice-pill"]');
    await expect(pill).toBeVisible();

    // It is a fixed-position floating control.
    const position = await pill.evaluate(
      (el) => window.getComputedStyle(el).position,
    );
    expect(position).toBe('fixed');

    // And it is the ONLY floating mic — the legacy STT FAB must not render,
    // otherwise the user sees a mic in each bottom corner.
    await expect(
      page.locator('[data-testid="global-voice-button"]'),
    ).toHaveCount(0);
  });

  test('no floating mic at all when voice-S2S is disabled', async ({
    page,
  }) => {
    // Override the beforeEach seed: with the voice feature off (the default),
    // there must be zero floating mics — neither the S2S pill nor the (removed)
    // STT FAB.
    await page.addInitScript(() => {
      localStorage.setItem(
        'station-feature-settings',
        JSON.stringify({ voiceS2SEnabled: false }),
      );
    });
    await page.goto('/');
    await expect(page.locator('[data-testid="voice-pill"]')).toHaveCount(0);
    await expect(
      page.locator('[data-testid="global-voice-button"]'),
    ).toHaveCount(0);
  });
});

test.describe('Voice Providers — VoiceOrb in chat input', () => {
  test.beforeEach(async ({ page }) => {
    // This suite exercises the chat control, not first-run onboarding. Keep the
    // independently tested engine picker from intercepting the dock controls.
    await page.addInitScript(() => {
      window.localStorage.setItem('station:onboarding-setup-dismissed', '1');
    });
    await seedActiveChats(page, [
      {
        sessionId: 'session-voice',
        conversationId: 'conv-1',
        agentSlug: 'dev-agent',
        model: 'claude-sonnet',
        provider: 'bedrock',
        providerOptions: {},
        orchestrationSessionStarted: false,
        ephemeralMessages: [],
        inputHistory: [],
      },
    ]);
    await seedOrchestrationRoutes(page);
    await mockRuntimeConversation(page, {
      id: 'conv-1',
      agentSlug: 'dev-agent',
      title: 'Dev Agent Chat',
      projectSlug: 'dev',
      provider: 'station-agent',
      model: 'claude-sonnet',
      canContinue: true,
      turns: () => [],
    });
    await page.route('**/api/system/capabilities', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: CAPABILITIES_RESPONSE,
      }),
    );
    // Stub SpeechRecognition (not available in headless Chromium)
    await page.addInitScript(() => {
      function SpeechRecognitionMock(this: any) {
        this.continuous = false;
        this.interimResults = false;
        this.start = () => this.onstart?.();
        this.stop = () => this.onend?.();
        this.abort = () => {};
        this.onstart = null;
        this.onresult = null;
        this.onerror = null;
        this.onend = null;
      }
      (window as any).SpeechRecognition = SpeechRecognitionMock;
      (window as any).webkitSpeechRecognition = SpeechRecognitionMock;
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async () => ({
            getTracks: () => [{ stop: () => {} }],
          }),
        },
      });
    });
  });

  test('VoiceOrb renders in chat input when SpeechRecognition is available', async ({
    page,
  }) => {
    await page.goto('/projects/dev/layouts/code?chat=conv-1');
    await openChatRegion(page);
    const orb = page.locator('[data-testid="voice-orb"]');
    await expect(orb).toBeVisible({ timeout: 10000 });
  });

  test('VoiceOrb changes appearance while listening', async ({ page }) => {
    await page.goto('/projects/dev/layouts/code?chat=conv-1');
    await openChatRegion(page);

    const orb = page.locator('[data-testid="voice-orb"]');
    await expect(orb).toBeVisible();

    await orb.click();

    await expect(orb).toHaveAttribute('title', 'Click to stop');

    await orb.click();
    await expect(orb).toHaveAttribute('title', 'Click to speak');
  });
});

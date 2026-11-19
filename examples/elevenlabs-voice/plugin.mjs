/**
 * ElevenLabs Voice — server module
 *
 * Exposes a single endpoint that exchanges the configured API key for a
 * single-use WebSocket token. The browser client connects directly to
 * ElevenLabs using that token — the API key never leaves the server.
 *
 * POST /api/plugins/elevenlabs-voice/signed-url
 *   Body: { type: 'stt' | 'tts', voiceId?: string }
 *   Response: { url: string, expiresAt: number }
 */

const VOICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const AUTHORIZATION_WINDOW_MS = 60_000;
const TOKEN_TTL_MS = 15 * 60_000;
const AUTHORIZATION_RESERVATION_MS = 30_000;
const MAX_AUTHORIZATIONS_PER_WINDOW = 12;
const MAX_OUTSTANDING_AUTHORIZATIONS = 6;

export default function register(app, { config, logger }) {
  const mintGuard = createMintGuard();
  app.post('/signed-url', async (c) => {
    const apiKey = config.get('apiKey') || process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return c.json({ error: 'ElevenLabs API key not configured' }, 503);
    }

    const parsed = await c.req.json().catch(() => ({}));
    const body = parsed && typeof parsed === 'object' ? parsed : {};
    const { type } = body;
    if (type !== 'stt' && type !== 'tts')
      return c.json({ error: 'Invalid voice type' }, 400);
    const voiceId =
      body.voiceId ?? config.get('voiceId') ?? '21m00Tcm4TlvDq8ikWAM';
    if (
      type === 'tts' &&
      (typeof voiceId !== 'string' || !VOICE_ID_PATTERN.test(voiceId))
    )
      return c.json({ error: 'Invalid ElevenLabs voice ID' }, 400);
    if (
      typeof body.sessionId !== 'string' ||
      !SESSION_ID_PATTERN.test(body.sessionId)
    ) {
      return c.json({ error: 'Invalid voice session ID' }, 400);
    }
    const reservation = mintGuard.reserve(body.sessionId);
    if (!reservation.ok) {
      return c.json(
        {
          error: 'Voice authorization is temporarily limited',
          retryAt: reservation.retryAt,
        },
        429,
      );
    }

    try {
      const expiresAt = Date.now() + TOKEN_TTL_MS;
      const tokenType = type === 'stt' ? 'realtime_scribe' : 'tts_websocket';
      const upstream = await fetch(
        `https://api.elevenlabs.io/v1/single-use-token/${tokenType}`,
        {
          method: 'POST',
          headers: { 'xi-api-key': apiKey },
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!upstream.ok) {
        reservation.releaseFailure();
        logger.warn('ElevenLabs voice authorization rejected', {
          status: upstream.status,
        });
        return c.json({ error: 'ElevenLabs authorization failed' }, 502);
      }
      const data = await upstream.json().catch(() => null);
      if (typeof data?.token !== 'string' || !data.token.trim()) {
        reservation.releaseFailure();
        return c.json({ error: 'Invalid ElevenLabs authorization' }, 502);
      }
      const url = new URL(
        type === 'stt'
          ? 'wss://api.elevenlabs.io/v1/speech-to-text/realtime'
          : `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input`,
      );
      if (type === 'stt') {
        url.search = new URLSearchParams({
          token: data.token,
          model_id: 'scribe_v2_realtime',
          audio_format: 'pcm_16000',
          commit_strategy: 'vad',
        }).toString();
      } else {
        url.search = new URLSearchParams({
          single_use_token: data.token,
          model_id: 'eleven_multilingual_v2',
          output_format: 'mp3_44100_128',
        }).toString();
      }
      return c.json({ url: url.href, expiresAt }, 200, {
        'Cache-Control': 'no-store',
      });
    } catch {
      reservation.releaseFailure();
      logger.error('ElevenLabs voice authorization transport failed');
      return c.json({ error: 'Internal error' }, 500);
    }
  });
}

export function createMintGuard(now = () => Date.now()) {
  const issuedAt = [];
  const reservations = new Map();
  return {
    reserve(sessionId) {
      const current = now();
      while (
        issuedAt.length > 0 &&
        issuedAt[0] <= current - AUTHORIZATION_WINDOW_MS
      ) {
        issuedAt.shift();
      }
      for (const [id, reservation] of reservations) {
        if (reservation.expiresAt <= current) reservations.delete(id);
      }
      const retryAt =
        issuedAt[0] === undefined
          ? current + AUTHORIZATION_RESERVATION_MS
          : issuedAt[0] + AUTHORIZATION_WINDOW_MS;
      if (
        reservations.has(sessionId) ||
        reservations.size >= MAX_OUTSTANDING_AUTHORIZATIONS ||
        issuedAt.length >= MAX_AUTHORIZATIONS_PER_WINDOW
      ) {
        return { ok: false, retryAt };
      }
      const reservation = Symbol(sessionId);
      issuedAt.push(current);
      reservations.set(sessionId, {
        expiresAt: current + AUTHORIZATION_RESERVATION_MS,
        token: reservation,
      });
      return {
        ok: true,
        releaseFailure() {
          if (reservations.get(sessionId)?.token !== reservation) return;
          reservations.delete(sessionId);
        },
      };
    },
  };
}

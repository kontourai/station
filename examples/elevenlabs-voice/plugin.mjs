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
    const type = body.type === 'tts' ? 'tts' : 'stt';
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
      return type === 'stt'
        ? await mintSttAuthorization(c, apiKey, logger, reservation)
        : await mintTtsAuthorization(c, apiKey, config, body, reservation);
    } catch {
      reservation.releaseFailure();
      logger.error('ElevenLabs signed-url error');
      return c.json({ error: 'Internal error' }, 500);
    }
  });
}

async function mintSttAuthorization(c, apiKey, logger, reservation) {
  const res = await fetch(
    'https://api.elevenlabs.io/v1/speech-to-text/stream/auth',
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model_id: 'scribe_v2' }),
    },
  );
  if (!res.ok) {
    reservation.releaseFailure();
    logger.warn('ElevenLabs STT auth failed', { status: res.status });
    return c.json({ error: 'ElevenLabs auth failed' }, 502);
  }
  return signedUrlResponse(c, await res.json());
}

async function mintTtsAuthorization(c, apiKey, config, body, reservation) {
  const voiceId =
    body.voiceId || config.get('voiceId') || '21m00Tcm4TlvDq8ikWAM';
  if (typeof voiceId !== 'string' || !VOICE_ID_PATTERN.test(voiceId)) {
    reservation.releaseFailure();
    return c.json({ error: 'Invalid ElevenLabs voice ID' }, 400);
  }
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input/auth`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
    },
  );
  if (!res.ok) {
    reservation.releaseFailure();
    return c.json({ error: 'ElevenLabs TTS auth failed' }, 502);
  }
  return signedUrlResponse(c, await res.json());
}

function signedUrlResponse(c, data) {
  return c.json({
    url: data.signed_url,
    expiresAt: Date.now() + 180_000,
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

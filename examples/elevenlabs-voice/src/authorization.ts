import { authenticatedFetch } from '@kontourai/station-sdk';

export async function requestVoiceAuthorization(
  apiBase: string,
  type: 'stt' | 'tts',
  signal: AbortSignal,
): Promise<string> {
  const response = await authenticatedFetch(
    `${apiBase}/api/plugins/elevenlabs-voice/signed-url`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, sessionId: crypto.randomUUID() }),
      redirect: 'error',
      signal,
    },
  );
  if (!response.ok) throw new Error('Voice authorization failed');
  const result = await response.json();
  if (
    typeof result?.url !== 'string' ||
    !Number.isFinite(result.expiresAt) ||
    result.expiresAt <= Date.now()
  )
    throw new Error('Voice authorization is missing or expired');
  const url = new URL(result.url);
  if (url.origin !== 'wss://api.elevenlabs.io' || url.username || url.password)
    throw new Error('Invalid voice authorization endpoint');
  return url.href;
}

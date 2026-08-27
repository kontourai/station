import { NovaSonicProvider } from '../src-server/voice/providers/nova-sonic.js';
import { createS2SRealtimeProvider } from '../src-server/voice/realtime/s2s-realtime-provider.js';

async function run(): Promise<void> {
  const provider = createS2SRealtimeProvider(
    () =>
      new NovaSonicProvider({
        region: process.env.AWS_REGION ?? 'us-east-1',
      }),
    {
      systemPrompt: 'Respond with one short acknowledgement.',
      tools: [],
    },
    async () =>
      process.env.AWS_PROFILE ||
      (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
        ? { status: 'ready' as const }
        : {
            status: 'unconfigured' as const,
            reason: 'missing-configuration' as const,
          },
  );
  const readiness = await provider.readiness();
  if (readiness.status !== 'ready') process.exit(2);
  const lease = await provider.mint();
  const connection = await lease.open();
  try {
    await connection.sendAudio?.(new Uint8Array(320));
  } finally {
    await connection.close();
  }
  // Nova's existing S2S protocol has no text-turn or explicit interrupt
  // operation. It is an executable start/speech/stop smoke, not AC2 proof.
  process.stdout.write('NOVA_START_SPEECH_STOP_COMPLETE\n');
  process.exitCode = 2;
}

void run().catch(() => {
  // Upstream AWS errors can contain request metadata; never relay them.
  process.exitCode = 1;
});

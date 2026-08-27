/**
 * Nova Sonic Voice — server module
 *
 * Exposes the structural WebSocket endpoint for a future relay between the
 * browser and AWS Bedrock's InvokeModelWithBidirectionalStream API (HTTP/2,
 * which cannot be called from browser JS). It is unavailable for real voice
 * until the WS-to-Bedrock bridge is built.
 *
 * WS /api/plugins/nova-sonic-voice/relay
 *
 * Required IAM permission: bedrock:InvokeModelWithBidirectionalStream
 */

export default function register(app, { config, logger }) {
  // WebSocket upgrade handler
  app.get('/relay', async (c) => {
    const upgrade = c.req.header('upgrade');
    if (upgrade?.toLowerCase() !== 'websocket') {
      return c.text('WebSocket required', 426);
    }

    const region =
      config.get('region') || process.env.AWS_REGION || 'us-east-1';
    const modelId = config.get('model') || 'us.amazon.nova-lite-v1:0';

    // Dynamic import so the plugin only loads AWS SDK when actually used
    const { BedrockRuntimeClient } = await import(
      '@aws-sdk/client-bedrock-runtime'
    ).catch(() => {
      logger.error('Nova Sonic: @aws-sdk/client-bedrock-runtime not installed');
      return {};
    });

    if (!BedrockRuntimeClient) {
      return c.text('AWS SDK not available', 503);
    }

    // Note: actual WebSocket upgrading depends on the server framework.
    // This endpoint is structural-only until the WS-to-Bedrock bridge exists.
    logger.info('Nova Sonic relay: WS upgrade requested', { modelId, region });

    // TODO: implement full WS-to-Bedrock bridge when framework supports WS upgrade
    return c.text(
      'Nova Sonic relay unavailable: capabilityState=structural-only; real voice requires the WS-to-Bedrock bridge',
      501,
    );
  });
}

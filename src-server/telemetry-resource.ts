/**
 * The resource attribute naming this installation. Its own module because
 * both `telemetry.ts` and the lazily loaded `telemetry-sdk.ts` need it, and
 * the SDK module must not import `telemetry.ts`: that module's evaluation
 * waits for the SDK module, so the import would never settle.
 */
export const OTEL_INSTALLATION_ID_ATTRIBUTE = 'service.installation.id';

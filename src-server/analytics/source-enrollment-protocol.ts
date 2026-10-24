import { z } from 'zod/v3';

export const enrollmentOperationId = z
  .string()
  .regex(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
export const enrollmentIdentity = z.string().min(1).max(200);
const retention = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('live-mirror') }).strict(),
  z
    .object({
      mode: z.literal('retained-copy'),
      days: z.number().int().min(1).max(90),
    })
    .strict(),
]);
export const analyticsOriginSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.origin === value &&
        !url.username &&
        !url.password &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' &&
            ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  });
export const sourceEnrollmentInput = z
  .object({
    operationId: enrollmentOperationId,
    proposedDestination: z
      .object({ stationId: enrollmentIdentity, origin: analyticsOriginSchema })
      .strict(),
    scope: z.enum(['individual', 'personal-account']),
    expiresAt: z
      .string()
      .datetime()
      .refine((value) => new Date(value).toISOString() === value),
    retention,
  })
  .strict();
export const enrollmentOwnerSchema = z
  .object({
    userId: enrollmentIdentity,
    mode: z.enum(['personal', 'hosted']),
    tenantId: enrollmentIdentity.nullable(),
    ownerIds: z.array(enrollmentIdentity).min(1).max(1000),
  })
  .strict()
  .refine(
    (value) =>
      (value.mode === 'hosted') === (value.tenantId !== null) &&
      value.ownerIds.includes(value.userId) &&
      JSON.stringify(value.ownerIds) ===
        JSON.stringify([...new Set(value.ownerIds)].sort()),
  );
export const enrollmentIntentSchema = sourceEnrollmentInput
  .extend({
    protocol: z.literal('station-analytics-source-enrollment-intent/v1'),
    sourceStationId: enrollmentIdentity,
    destinationVerified: z.literal(false),
    phase: z.enum(['prepared', 'cancelled']),
    createdAt: z.string().datetime(),
    exportAuthority: z.literal(false),
  })
  .strict();

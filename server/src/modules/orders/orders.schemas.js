import { z } from 'zod';

export const createOrderSchema = z.object({
  holdId: z.uuid('Invalid hold id'),
});

export const orderIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// The Idempotency-Key header: any client-made random string (we suggest a UUID).
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

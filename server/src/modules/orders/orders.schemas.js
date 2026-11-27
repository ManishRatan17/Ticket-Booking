import { z } from 'zod';

export const createOrderSchema = z.object({
  holdId: z.uuid('Invalid hold id'),
});

export const orderIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// The Idempotency-Key header format: middleware/idempotencyKey.js.
export { IDEMPOTENCY_KEY } from '../../middleware/idempotencyKey.js';

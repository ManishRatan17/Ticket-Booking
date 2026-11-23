import { z } from 'zod';
import { MAX_TICKETS_PER_HOLD } from '../reservation/holds.js';

export const createEventSchema = z.object({
  name: z.string().trim().min(3, 'Use at least 3 characters').max(120, 'Use at most 120 characters'),
  totalTickets: z.number().int().min(1).max(100_000),
  // Any moment is allowed — even the past, so a demo event can be on sale immediately.
  // z.coerce.date() turns "2026-12-01T18:00:00Z" into a Date and rejects nonsense.
  saleStartsAt: z.coerce.date(),
});

export const eventIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// JSON numbers only (no "2" strings): a hold is a precise request.
export const holdBodySchema = z.object({
  quantity: z.number().int().min(1).max(MAX_TICKETS_PER_HOLD, `At most ${MAX_TICKETS_PER_HOLD} tickets per person`),
});

export const holdIdParamsSchema = z.object({
  holdId: z.uuid('Invalid hold id'),
});

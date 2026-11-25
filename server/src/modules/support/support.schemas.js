import { z } from 'zod';

const message = z.string().trim().min(1, 'Write a message').max(2000, 'Use at most 2,000 characters');

// Two kinds, each with its own required fields (zod picks the right shape by `kind`).
export const createRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('more_tickets'),
    eventId: z.number().int().positive(),
    extraTickets: z.number().int().min(1).max(4), // limit becomes 4 + this, at most 8
    message,
  }),
  z.object({
    kind: z.literal('question'),
    eventId: z.number().int().positive().nullable().default(null),
    message,
  }),
  // "My account was restricted by mistake" (Phase 5e). Only while a restriction is in force.
  z.object({ kind: z.literal('appeal'), message }),
]);

export const messageSchema = z.object({ body: message });
export const requestIdParamsSchema = z.object({ id: z.coerce.number().int().positive() });
export const listQuerySchema = z.object({ status: z.enum(['open', 'approved', 'declined', 'closed']).optional() });
export const decisionSchema = z.object({
  decision: z.enum(['approved', 'declined', 'closed']),
  message: message.optional(),
});

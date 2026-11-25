import { z } from 'zod';
import { MAX_TICKETS_PER_HOLD } from '../reservation/holds.js';

export const createEventSchema = z
  .object({
    name: z.string().trim().min(3, 'Use at least 3 characters').max(120, 'Use at most 120 characters'),
    totalTickets: z.number().int().min(1).max(100_000),
    // Any moment is allowed — even the past, so a demo event can be on sale immediately.
    // z.coerce.date() turns "2026-12-01T18:00:00Z" into a Date and rejects nonsense.
    saleStartsAt: z.coerce.date(),
    // Whole paise (₹1 = 100 paise). 0 = free. Max ₹1,00,000 per ticket.
    pricePaise: z.number().int().min(0).max(10_000_000).default(0),
    // Waiting room: let this many people in per second. null/absent = no waiting room.
    admissionPerSecond: z.number().int().min(1).max(10_000).nullable().default(null),
    // …and its lobby opens this many minutes before the sale (1 minute to 24 hours).
    lobbyMinutes: z.number().int().min(1).max(1440).default(15),
    // The lucky draw: this % of the tickets (0 = none, at most 50) is given away by a random draw
    // among everyone in the waiting room, lotteryDrawMinutes after the sale opens, up to
    // lotteryPerWinner tickets per winner.
    lotteryPercent: z.number().int().min(0).max(50).default(0),
    lotteryDrawMinutes: z.number().int().min(1).max(1440).default(30),
    lotteryPerWinner: z.number().int().min(1).max(MAX_TICKETS_PER_HOLD).default(2),
  })
  // The draw's entrants are the people in the waiting room: no waiting room, no draw.
  .refine((e) => e.lotteryPercent === 0 || e.admissionPerSecond, {
    message: 'A lucky draw needs a waiting room (people let in per second)',
    path: ['lotteryPercent'],
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

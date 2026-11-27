// Validation for the train module.
import { z } from 'zod';

export const CLASS_CODES = ['1A', '2A', '3A', 'SL', 'CC', '2S'];
export const MAX_TRAVELLERS = 6; // per booking, as on Indian Railways
const city = z.string().trim().min(2, 'At least 2 characters').max(60);
const classCode = z.enum(CLASS_CODES);

export const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });

export const searchQuerySchema = z
  .object({ from: city, to: city, date: z.iso.date('Use YYYY-MM-DD'), classCode: classCode.optional() })
  .refine((q) => q.from.toLowerCase() !== q.to.toLowerCase(), { message: 'From and to must differ', path: ['to'] });

// The server allocates the berths: you choose the class and how many travellers.
export const holdBodySchema = z.object({
  classCode,
  travellers: z.number().int().min(1).max(MAX_TRAVELLERS, `At most ${MAX_TRAVELLERS} travellers per booking`),
});

export const confirmBodySchema = z.object({
  // In the same order as the allocated berths (traveller 1 → the first berth, …).
  passengers: z
    .array(
      z.object({
        name: z.string().trim().min(2, 'At least 2 characters').max(60),
        age: z.number().int().min(1).max(120),
        gender: z.enum(['female', 'male', 'other']),
      }),
    )
    .min(1)
    .max(MAX_TRAVELLERS),
  contactPhone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 -]{8,16}$/, 'A phone number, e.g. +91 98765 43210')
    .optional(),
});

// Admins: a new trip. Each class: its fare, how many coaches, berths per coach.
export const createTripSchema = z
  .object({
    trainNumber: z.string().trim().regex(/^\d{4,5}$/, '4–5 digits, e.g. 12123'),
    trainName: z.string().trim().min(2).max(80),
    from: city,
    to: city,
    departsAt: z.iso.datetime({ offset: true }),
    arrivesAt: z.iso.datetime({ offset: true }),
    classes: z
      .array(
        z.object({
          code: classCode,
          farePaise: z.number().int().min(0).max(5_000_000),
          coaches: z.number().int().min(1).max(24),
          berthsPerCoach: z.number().int().min(1).max(80),
        }),
      )
      .min(1)
      .max(CLASS_CODES.length)
      .refine((cs) => new Set(cs.map((c) => c.code)).size === cs.length, 'A class is listed twice'),
  })
  .refine((t) => t.from.toLowerCase() !== t.to.toLowerCase(), { message: 'From and to must differ', path: ['to'] })
  .refine((t) => new Date(t.arrivesAt) > new Date(t.departsAt), { message: 'Must arrive after it departs', path: ['arrivesAt'] });

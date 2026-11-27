// Validation for the bus module: what every request must look like before it reaches the service.
import { z } from 'zod';

export const MAX_SEATS_PER_BOOKING = 6;
const SEAT = /^[1-9][0-9]?[A-F]$/; // row 1–99 + column A–F, e.g. "7C"
const city = z.string().trim().min(2, 'At least 2 characters').max(60);

export const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });

export const searchQuerySchema = z
  .object({
    from: city,
    to: city,
    date: z.iso.date('Use YYYY-MM-DD'),
  })
  .refine((q) => q.from.toLowerCase() !== q.to.toLowerCase(), { message: 'From and to must differ', path: ['to'] });

export const holdBodySchema = z.object({
  seats: z
    .array(z.string().trim().toUpperCase().regex(SEAT, 'A seat looks like 7C'))
    .min(1, 'Choose at least one seat')
    .max(MAX_SEATS_PER_BOOKING, `At most ${MAX_SEATS_PER_BOOKING} seats per booking`)
    .refine((seats) => new Set(seats).size === seats.length, 'A seat is listed twice'),
});

export const confirmBodySchema = z.object({
  passengers: z
    .array(
      z.object({
        seat: z.string().trim().toUpperCase().regex(SEAT, 'A seat looks like 7C'),
        name: z.string().trim().min(2, 'At least 2 characters').max(60),
        age: z.number().int().min(1).max(120),
        gender: z.enum(['female', 'male', 'other']),
      }),
    )
    .min(1)
    .max(MAX_SEATS_PER_BOOKING),
  contactPhone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 -]{8,16}$/, 'A phone number, e.g. +91 98765 43210')
    .optional(),
});

// Admins: a new trip. The seat map is rows × columns: 10 rows of "ABCD" → 1A, 1B, … 10D.
export const createTripSchema = z
  .object({
    operator: z.string().trim().min(2).max(80),
    busNumber: z.string().trim().min(2).max(20),
    from: city,
    to: city,
    departsAt: z.iso.datetime({ offset: true }),
    arrivesAt: z.iso.datetime({ offset: true }),
    farePaise: z.number().int().min(0).max(1_000_000),
    rows: z.number().int().min(1).max(15),
    seatColumns: z
      .string()
      .regex(/^[A-F]{1,6}$/, 'Column letters A–F, e.g. ABCD')
      .refine((c) => new Set(c).size === c.length, 'A column letter is repeated')
      .default('ABCD'),
  })
  .refine((t) => t.from.toLowerCase() !== t.to.toLowerCase(), { message: 'From and to must differ', path: ['to'] })
  .refine((t) => new Date(t.arrivesAt) > new Date(t.departsAt), { message: 'Must arrive after it departs', path: ['arrivesAt'] });

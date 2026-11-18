import { z } from 'zod';

export const ROLES = ['user', 'admin'];

// Query strings are always TEXT ("?limit=20"), so z.coerce turns them into numbers first.
export const listUsersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20), // never "give me all 1,000,000"
  offset: z.coerce.number().int().min(0).default(0),
});

export const userIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const changeRoleBodySchema = z.object({
  role: z.enum(ROLES),
});

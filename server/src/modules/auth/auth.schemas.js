// Request shapes for the auth endpoints. Anything not listed here is stripped by validate().
import { z } from 'zod';
import { isCommonPassword } from './common-passwords.js';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email is too long') // the maximum length of a real email address
  .pipe(z.email('Invalid email address'));

// NIST guidance: length matters most; no forced symbols/uppercase; block known-common passwords.
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must be at most 128 characters') // stops huge inputs from overloading hashing
  .refine((p) => !isCommonPassword(p), 'This password is too common. Please choose another');

export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
  })
  // A check that needs TWO fields goes on the object. `path` says which field to blame.
  .refine((data) => data.password.trim().toLowerCase() !== data.email, {
    message: 'Password must not be the same as your email',
    path: ['password'],
  });

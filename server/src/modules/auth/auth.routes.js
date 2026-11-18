// URL → middleware → controller. Mounted at /api/auth in app.js.
import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import {
  registerSchema,
  loginSchema,
  googleCallbackQuerySchema,
  sessionIdParamsSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from './auth.schemas.js';
import * as authController from './auth.controller.js';
import {
  loginPerIp,
  loginAttempts,
  registerPerIp,
  refreshPerIp,
  googleStartPerIp,
  forgotPerIp,
  forgotPerEmail,
  resetPerIp,
} from './auth.rate-limits.js';

const router = Router();

// Middleware order matters: the IP limit runs BEFORE validation (invalid requests count too),
// the per-email limit AFTER it (it needs the normalised email).
router.post('/register', registerPerIp, validate({ body: registerSchema }), authController.register);
router.post('/login', loginPerIp, validate({ body: loginSchema }), loginAttempts, authController.login);
router.post('/refresh', refreshPerIp, authController.refresh); // authenticated by the refresh cookie
router.post('/logout', authController.logout); // also by the refresh cookie: works after the JWT expired
router.get('/me', authenticate, authController.me);

// Forgot / reset password
router.post(
  '/forgot-password',
  forgotPerIp,
  validate({ body: forgotPasswordSchema }),
  forgotPerEmail,
  authController.forgotPassword,
);
router.post('/reset-password', resetPerIp, validate({ body: resetPasswordSchema }), authController.resetPassword);

// Session management ("where am I logged in?")
router.post('/logout-all', authenticate, authController.logoutAll);
router.get('/sessions', authenticate, authController.listSessions);
router.delete(
  '/sessions/:id',
  authenticate,
  validate({ params: sessionIdParamsSchema }),
  authController.deleteSession,
);

// Continue with Google (browser navigations, not fetch calls)
router.get('/google', googleStartPerIp, authController.googleStart);
router.get(
  '/google/callback',
  validate({ query: googleCallbackQuerySchema }),
  authController.googleCallback,
);

export default router;

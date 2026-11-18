// URL → middleware → controller. Mounted at /api/auth in app.js.
import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import {
  registerSchema,
  loginSchema,
  googleCallbackQuerySchema,
  sessionIdParamsSchema,
} from './auth.schemas.js';
import * as authController from './auth.controller.js';

const router = Router();

router.post('/register', validate({ body: registerSchema }), authController.register);
router.post('/login', validate({ body: loginSchema }), authController.login);
router.post('/refresh', authController.refresh); // authenticated by the refresh cookie, not a JWT
router.post('/logout', authController.logout); // also by the refresh cookie: works after the JWT expired
router.get('/me', authenticate, authController.me);

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
router.get('/google', authController.googleStart);
router.get(
  '/google/callback',
  validate({ query: googleCallbackQuerySchema }),
  authController.googleCallback,
);

export default router;

// URL → middleware → controller. Mounted at /api/auth in app.js.
import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { registerSchema } from './auth.schemas.js';
import * as authController from './auth.controller.js';

const router = Router();

router.post('/register', validate({ body: registerSchema }), authController.register);

export default router;

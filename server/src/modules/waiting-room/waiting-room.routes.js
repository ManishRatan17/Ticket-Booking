// Waiting room. Mounted at /api in app.js. You must be signed in: the queue holds USERS,
// one place each, so opening ten tabs or reloading never gets you a second (or a better) place.
import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { eventIdParamsSchema } from '../events/events.schemas.js';
import * as waitingRoom from './waiting-room.service.js';

const router = Router();

router.post('/events/:id/queue', authenticate, validate({ params: eventIdParamsSchema }), async (req, res) => {
  res.json(await waitingRoom.join({ eventId: req.validated.params.id, userId: req.user.id }));
});

router.get('/events/:id/queue', authenticate, validate({ params: eventIdParamsSchema }), async (req, res) => {
  res.json(await waitingRoom.getStatus({ eventId: req.validated.params.id, userId: req.user.id }));
});

export default router;

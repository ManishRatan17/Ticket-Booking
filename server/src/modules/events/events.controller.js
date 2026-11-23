import * as eventsService from './events.service.js';

export async function createEvent(req, res) {
  res.status(201).json({ event: await eventsService.createEvent(req.validated.body) });
}

export async function listEvents(req, res) {
  res.json(await eventsService.listEvents());
}

export async function getEvent(req, res) {
  res.json(await eventsService.getEvent(req.validated.params.id));
}

export async function holdTickets(req, res) {
  const result = await eventsService.holdTickets({
    eventId: req.validated.params.id,
    userId: req.user.id,
    quantity: req.validated.body.quantity,
  });
  res.status(201).json(result);
}

export async function getMyHold(req, res) {
  res.json(await eventsService.getMyHold({ eventId: req.validated.params.id, userId: req.user.id }));
}

export async function releaseMyHold(req, res) {
  await eventsService.releaseMyHold({ holdId: req.validated.params.holdId, userId: req.user.id });
  res.status(204).end();
}

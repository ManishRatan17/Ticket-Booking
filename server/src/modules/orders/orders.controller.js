import { redisNow } from '../reservation/holds.js';
import * as ordersService from './orders.service.js';

// The Idempotency-Key check lives in middleware/idempotencyKey.js (shared with bus bookings).
export { requireIdempotencyKey } from '../../middleware/idempotencyKey.js';

export async function createOrder(req, res) {
  const { order, created } = await ordersService.createOrder({
    userId: req.user.id,
    holdId: req.validated.body.holdId,
    idempotencyKey: req.idempotencyKey,
  });
  // 201 Created the first time; 200 + a header saying "this is the earlier answer" on a retry.
  if (!created) res.set('Idempotent-Replayed', 'true');
  res.status(created ? 201 : 200).json({ order: ordersService.toPublicOrder(order), serverTime: await redisNow() });
}

export async function getOrder(req, res) {
  const order = await ordersService.getOrder({ orderId: req.validated.params.id, userId: req.user.id });
  res.json({ order: ordersService.toPublicOrder(order), serverTime: await redisNow() });
}

export async function listOrders(req, res) {
  const orders = await ordersService.listOrders(req.user.id);
  res.json({ orders: orders.map(ordersService.toPublicOrder) });
}

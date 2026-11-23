import { AppError } from '../../lib/errors.js';
import { redisNow } from '../reservation/holds.js';
import { IDEMPOTENCY_KEY } from './orders.schemas.js';
import * as ordersService from './orders.service.js';

// POST endpoints that create things must be safe to retry. The client sends a random
// Idempotency-Key header; the same key always gets the same result.
export function requireIdempotencyKey(req, res, next) {
  const key = req.get('idempotency-key');
  if (!key || !IDEMPOTENCY_KEY.test(key)) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8–128 letters, digits, - or _)');
  }
  req.idempotencyKey = key;
  next();
}

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

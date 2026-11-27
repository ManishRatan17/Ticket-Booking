// The EXTERNAL train provider: a licensed train-booking partner (TRAIN_PROVIDER=external).
//
// There is no public booking API for Indian Railways: IRCTC sells e-tickets itself or through licensed
// agents and partners (docs/24). So this adapter can't be written against a real API yet: it needs a
// partner's URL, key AND their API contract (endpoints, fields, booking/cancellation rules). Until
// then, every request answers honestly:
//   not configured (no URL / key)  → 503 TRAIN_PROVIDER_NOT_CONFIGURED
//   configured                     → 501 TRAIN_PROVIDER_NOT_IMPLEMENTED (the adapter isn't written yet)
// It NEVER answers with invented trains, availability or confirmations.
//
// When a partner is chosen: implement the functions below with lib/httpClient.js (timeouts, safe
// retries only, 502/503/504 errors), e.g.
//   const { status, data } = await requestJson({ service: 'train_provider', url: `${url}/…`,
//     headers: { Authorization: `Bearer ${apiKey}` }, timeoutMs });
// and send an idempotency key with booking POSTs (then `idempotent: true` makes retries safe).
import { env } from '../../../config/env.js';
import { AppError } from '../../../lib/errors.js';

export const name = 'external';

function unavailable() {
  const { url, apiKey } = env.train.external;
  if (!url || !apiKey) {
    throw new AppError(503, 'TRAIN_PROVIDER_NOT_CONFIGURED', 'Train booking needs a licensed provider, and none is configured on this server');
  }
  throw new AppError(501, 'TRAIN_PROVIDER_NOT_IMPLEMENTED', "A train provider is configured, but its booking API hasn't been connected yet");
}

export const searchTrips = async () => unavailable();
export const getTrip = async () => unavailable();
export const holdBerths = async () => unavailable();
export const confirmBooking = async () => unavailable();
export const cancelBooking = async () => unavailable();
export const getBooking = async () => unavailable();
export const listBookings = async () => unavailable();

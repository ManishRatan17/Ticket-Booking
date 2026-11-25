// The lucky draw's randomness — small, pure, and checkable by anyone.
//
// PROVABLY FAIR, with "commit–reveal":
//   1. When the event is created we pick a secret SEED (32 random bytes) and publish only its
//      fingerprint, seedHash = SHA-256(seed). That's the COMMIT: from now on we can't change the seed
//      without the fingerprint changing too.
//   2. At the draw, the entrants are frozen and the seed is REVEALED.
//   3. Everyone's draw number = HMAC-SHA256(key = seed, message = "<eventId>:<userId>"). Lowest wins.
//   Anyone can check: SHA-256(revealed seed) = the fingerprint published before the draw, and their
//   own draw number = HMAC(seed, "<eventId>:<theirId>"). So the admin couldn't have picked winners,
//   and couldn't have re-rolled the seed after seeing who entered.
//
// Why HMAC and not "shuffle with a random generator": each person's number depends only on the
// seed and their own id — not on who else entered or in what order — so it's easy to explain and
// to check, and adding or removing someone never changes anybody else's number.
import { createHash, createHmac, randomBytes } from 'node:crypto';

export const makeSeed = () => randomBytes(32).toString('hex');
export const hashSeed = (seed) => createHash('sha256').update(seed).digest('hex');
export const drawNumber = (seed, eventId, userId) => createHmac('sha256', seed).update(`${eventId}:${userId}`).digest('hex');

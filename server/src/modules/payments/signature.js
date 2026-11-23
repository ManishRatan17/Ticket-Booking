// Webhook signatures: proof that a webhook really came from the payment provider.
//
// The provider and we share a SECRET. The provider sends
//   X-Payment-Signature: sha256=<HMAC-SHA256(secret, the exact bytes of the body)>
// We compute the same HMAC over the bytes WE received. Equal → authentic and unmodified.
// Anyone can send a request to our webhook URL; only someone with the secret can sign it.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'X-Payment-Signature';

export function signPayload(rawBody, secret) {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

// Constant-time comparison: a normal === stops at the first different character, and those
// tiny timing differences can be measured to guess a valid signature piece by piece.
export function isValidSignature(rawBody, header, secret) {
  const expected = Buffer.from(signPayload(rawBody, secret));
  const received = Buffer.from(String(header ?? ''));
  return received.length === expected.length && timingSafeEqual(received, expected);
}

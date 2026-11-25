// Check the lucky draw YOURSELF, in your own browser, with the Web Crypto API — without trusting
// our server's word for it (the server's side is server/src/modules/lottery/lottery.js):
//   1. SHA-256(revealed seed) must equal the fingerprint we published BEFORE the draw
//   2. HMAC-SHA256(key = seed, "<eventId>:<yourUserId>") must equal your draw number
const bytes = (text) => new TextEncoder().encode(text)
const toHex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('')

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', bytes(text)))
}

export async function hmacHex(key, message) {
  const cryptoKey = await crypto.subtle.importKey('raw', bytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return toHex(await crypto.subtle.sign('HMAC', cryptoKey, bytes(message)))
}

// → { fingerprintOk, numberOk, myNumber }
export async function verifyDraw({ seed, seedHash, eventId, userId, myDrawNumber }) {
  const [fingerprint, myNumber] = await Promise.all([sha256Hex(seed), hmacHex(seed, `${eventId}:${userId}`)])
  return { fingerprintOk: fingerprint === seedHash, numberOk: myDrawNumber == null || myNumber === myDrawNumber, myNumber }
}

// The browser's check must compute EXACTLY what the server computes (node:crypto).
import { test, expect } from 'vitest'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { hmacHex, sha256Hex, verifyDraw } from './verifyDraw.js'

const seed = randomBytes(32).toString('hex')
const seedHash = createHash('sha256').update(seed).digest('hex')
const serverNumber = createHmac('sha256', seed).update('42:7').digest('hex')

test('SHA-256 and HMAC in the browser = the server\'s', async () => {
  expect(await sha256Hex(seed)).toBe(seedHash)
  expect(await hmacHex(seed, '42:7')).toBe(serverNumber)
})

test('an honest draw verifies; a swapped seed or a wrong number does not', async () => {
  expect(await verifyDraw({ seed, seedHash, eventId: 42, userId: 7, myDrawNumber: serverNumber })).toEqual({
    fingerprintOk: true,
    numberOk: true,
    myNumber: serverNumber,
  })
  const otherSeed = randomBytes(32).toString('hex')
  expect((await verifyDraw({ seed: otherSeed, seedHash, eventId: 42, userId: 7, myDrawNumber: serverNumber })).fingerprintOk).toBe(false)
  expect((await verifyDraw({ seed, seedHash, eventId: 42, userId: 8, myDrawNumber: serverNumber })).numberOk).toBe(false)
})

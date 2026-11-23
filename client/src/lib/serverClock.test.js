import { describe, test, expect } from 'vitest'
import { clockOffset, secondsUntil, formatCountdown } from './serverClock.js'

describe('countdowns use the SERVER clock, not the device clock', () => {
  const serverNow = new Date('2026-11-24T12:00:00Z').getTime()
  const expiresAt = new Date(serverNow + 300_000) // a 5-minute hold

  test('device clock correct → 300 s left', () => {
    const offset = clockOffset(serverNow, serverNow)
    expect(secondsUntil(expiresAt, offset, serverNow)).toBe(300)
  })

  test('device clock 3 minutes FAST → still 300 s left (not 120)', () => {
    const deviceNow = serverNow + 180_000
    const offset = clockOffset(serverNow, deviceNow)
    expect(secondsUntil(expiresAt, offset, deviceNow)).toBe(300)
  })

  test('device clock 10 minutes SLOW → still 300 s left (not 900)', () => {
    const deviceNow = serverNow - 600_000
    const offset = clockOffset(serverNow, deviceNow)
    expect(secondsUntil(expiresAt, offset, deviceNow)).toBe(300)
  })

  test('time passes on the device → the countdown follows; never below 0', () => {
    const offset = clockOffset(serverNow, serverNow)
    expect(secondsUntil(expiresAt, offset, serverNow + 61_000)).toBe(239)
    expect(secondsUntil(expiresAt, offset, serverNow + 999_000)).toBe(0)
  })
})

describe('formatCountdown', () => {
  test.each([
    [300, '5:00'],
    [299, '4:59'],
    [5, '0:05'],
    [3725, '1:02:05'],
  ])('%i seconds → %s', (seconds, text) => expect(formatCountdown(seconds)).toBe(text))
})

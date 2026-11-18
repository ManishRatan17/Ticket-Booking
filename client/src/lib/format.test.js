import { describe, test, expect } from 'vitest'
import { describeDevice, timeAgo } from './format.js'

describe('describeDevice', () => {
  const cases = [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Chrome on Windows'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0', 'Edge on Windows'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', 'Chrome on Android'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', 'Safari on iOS'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:132.0) Gecko/20100101 Firefox/132.0', 'Firefox on macOS'],
    ['PostmanRuntime/7.43.0', 'Postman'],
    [null, 'Unknown device'],
  ]
  for (const [userAgent, expected] of cases) {
    test(`${expected}`, () => expect(describeDevice(userAgent)).toBe(expected))
  }
})

describe('timeAgo', () => {
  const now = new Date('2026-11-19T12:00:00Z').getTime()
  test('under a minute → "just now"', () => expect(timeAgo(now - 20_000, now)).toBe('just now'))
  test('minutes and days are rounded to the biggest unit', () => {
    expect(timeAgo(now - 5 * 60_000, now)).toMatch(/5 minutes ago/)
    expect(timeAgo(now - 3 * 24 * 3600_000, now)).toMatch(/3 days ago/)
  })
})

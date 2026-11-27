// Helpers of the bus and train booking pages.
import { test, expect } from 'vitest'
import { duration, passengerErrors, seatRows, tomorrowInIndia } from './booking.js'

test('seatRows: rows in order, the aisle in the middle (2 + 2), numbers sorted as numbers', () => {
  const labels = ['10A', '10B', '10C', '10D', '1A', '1B', '1C', '1D', '2A', '2B', '2C', '2D']
  const rows = seatRows(labels)
  expect(rows.map((r) => r.row)).toEqual([1, 2, 10])
  expect(rows[0]).toEqual({ row: 1, left: ['1A', '1B'], right: ['1C', '1D'] })
})

test('seatRows: an odd number of columns puts the extra one on the left (2 + 1)', () => {
  expect(seatRows(['1A', '1B', '1C'])).toEqual([{ row: 1, left: ['1A', '1B'], right: ['1C'] }])
})

test('passengerErrors: name, age and gender checked per passenger, like the server', () => {
  expect(passengerErrors([{ name: 'Ann', age: 30, gender: 'female' }])).toEqual({})
  expect(passengerErrors([{ name: ' A ', age: 0, gender: '' }, { name: 'Bob', age: '121', gender: 'male' }])).toEqual({
    '0.name': 'At least 2 characters',
    '0.age': 'An age from 1 to 120',
    '0.gender': 'Choose one',
    '1.age': 'An age from 1 to 120',
  })
})

test('duration and tomorrow (India)', () => {
  expect(duration('2026-12-01T10:00:00Z', '2026-12-01T13:25:00Z')).toBe('3h 25m')
  expect(duration('2026-12-01T10:00:00Z', '2026-12-01T10:40:00Z')).toBe('40m')
  // 20:00 UTC is already 01:30 the next day in India: "tomorrow" there is two UTC days later.
  expect(tomorrowInIndia(Date.parse('2026-11-30T20:00:00Z'))).toBe('2026-12-02')
})

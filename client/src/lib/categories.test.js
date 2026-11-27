// Which categories can be booked, and what the unfinished ones load.
import { test, expect } from 'vitest'
import { CATEGORIES, findCategory, loadCategory } from './categories.js'

test('Train and Bus are bookable; Movie and Flight are "coming soon"; all four are listed', () => {
  expect(CATEGORIES.map((c) => [c.key, c.available])).toEqual([
    ['train', true],
    ['bus', true],
    ['movie', false],
    ['flight', false],
  ])
  expect(findCategory('bus').path).toBe('/book/bus')
  expect(findCategory('boat')).toBeNull()
})

test('a coming-soon category loads nothing (no API call); an unknown one is an error', async () => {
  await expect(loadCategory('movie')).resolves.toBeNull()
  await expect(loadCategory('flight')).resolves.toBeNull()
  await expect(loadCategory('boat')).rejects.toThrow(/Unknown category/)
})

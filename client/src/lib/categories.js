// The four booking categories on the landing page, and the data each category page needs.
//   available: false = not built yet: its page is a "Coming soon" screen, no booking.
//   exitMs: how long its scene takes to leave once the page is ready (the bus drives off first).
import { listEvents } from '../api/events.js'

export const CATEGORIES = [
  { key: 'train', label: 'Train', emoji: '🚆', tagline: 'Intercity routes, sleeper berths and day trips', available: true, exitMs: 450 },
  { key: 'bus', label: 'Bus', emoji: '🚌', tagline: 'City to city, door to door, day or night', available: true, exitMs: 950 },
  { key: 'movie', label: 'Movie', emoji: '🎬', tagline: 'Premieres, blockbusters and the best seats', available: false, exitMs: 450 },
  { key: 'flight', label: 'Flight', emoji: '✈️', tagline: 'Domestic and international, all fares', available: false, exitMs: 450 },
].map((c) => ({ ...c, path: `/book/${c.key}` }))

export const findCategory = (key) => CATEGORIES.find((c) => c.key === key) ?? null

// What a category page shows. The backend has no categories yet, so every bookable category gets the
// events on sale: this is the ONE place to change when it does (e.g. listEvents({ category: key })).
// A category that isn't built yet needs no data.
export async function loadCategory(key) {
  const category = findCategory(key)
  if (!category) throw new Error(`Unknown category: ${key}`)
  if (!category.available) return null
  const { events } = await listEvents()
  return { events }
}

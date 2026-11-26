// The admin "create event" call must send every field of the form (fake fetch).
import { test, expect, vi, afterEach } from 'vitest'
import { cancelEvent, createEvent } from './admin.js'

afterEach(() => vi.unstubAllGlobals())

test('createEvent sends price, waiting room, lobby and lucky-draw settings, not only the name', async () => {
  const fetchMock = vi.fn(async () => new Response('{"event":{}}', { status: 201, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  const event = {
    name: 'Concert',
    totalTickets: 100,
    saleStartsAt: '2030-01-01T10:00:00.000Z',
    pricePaise: 49900,
    admissionPerSecond: 5,
    lobbyMinutes: 20,
    lotteryPercent: 20,
    lotteryDrawMinutes: 30,
    lotteryPerWinner: 2,
  }
  await createEvent(event)
  const [url, init] = fetchMock.mock.calls[0]
  expect(`${init.method} ${url}`).toBe('POST /api/admin/events')
  expect(JSON.parse(init.body)).toEqual(event)
})

test('cancelEvent posts the reason to the event\'s cancel endpoint', async () => {
  const fetchMock = vi.fn(async () => new Response('{"cancelled":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  await cancelEvent(7, 'The venue flooded')
  const [url, init] = fetchMock.mock.calls[0]
  expect(`${init.method} ${url}`).toBe('POST /api/admin/events/7/cancel')
  expect(JSON.parse(init.body)).toEqual({ reason: 'The venue flooded' })
})

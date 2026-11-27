// The category transition's timing rules (fake timers: no real waiting).
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { startTransitionRun } from './transitionRun.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const after = (ms, value, fail = false) => () =>
  new Promise((resolve, reject) => setTimeout(() => (fail ? reject(value) : resolve(value)), ms))

function run(load) {
  const phases = []
  const ready = vi.fn()
  const controls = startTransitionRun({ load, minMs: 2500, maxMs: 10_000, onPhase: (p) => phases.push(p), onReady: ready })
  return { phases, ready, controls }
}

test('data at once → the page still waits for the 2.5 s animation', async () => {
  const { ready, phases } = run(async () => 'data')
  await vi.advanceTimersByTimeAsync(2499)
  expect(ready).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(ready).toHaveBeenCalledWith('data')
  expect(phases).toEqual([])
})

test('data after 4 s → opens at 4 s, no "waiting" state', async () => {
  const { ready, phases } = run(after(4000, 'data'))
  await vi.advanceTimersByTimeAsync(3999)
  expect(ready).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(ready).toHaveBeenCalledOnce()
  expect(phases).toEqual([])
})

test('data after 12 s → the animation stops at 10 s (normal loading), then opens at 12 s', async () => {
  const { ready, phases } = run(after(12_000, 'data'))
  await vi.advanceTimersByTimeAsync(9999)
  expect(phases).toEqual([])
  await vi.advanceTimersByTimeAsync(1)
  expect(phases).toEqual(['waiting'])
  await vi.advanceTimersByTimeAsync(2000)
  expect(ready).toHaveBeenCalledWith('data')
})

test('an error is shown only after the minimum; Try again loads again and opens', async () => {
  let calls = 0
  const load = () => (++calls === 1 ? Promise.reject(new Error('offline')) : after(500, 'data')())
  const { ready, phases, controls } = run(load)
  await vi.advanceTimersByTimeAsync(1000)
  expect(phases).toEqual([])
  await vi.advanceTimersByTimeAsync(1500)
  expect(phases).toEqual(['error'])

  controls.retry()
  expect(phases).toEqual(['error', 'waiting'])
  await vi.advanceTimersByTimeAsync(500)
  expect(ready).toHaveBeenCalledWith('data')
  expect(calls).toBe(2)
})

test('cancel → nothing happens afterwards; retry without an error does nothing', async () => {
  const { ready, phases, controls } = run(after(1000, 'data'))
  controls.retry() // no error yet
  controls.cancel()
  await vi.advanceTimersByTimeAsync(20_000)
  expect(ready).not.toHaveBeenCalled()
  expect(phases).toEqual([])
})

test('opens exactly once, even if the data and the minimum arrive together', async () => {
  const { ready } = run(after(2500, 'data'))
  await vi.advanceTimersByTimeAsync(15_000)
  expect(ready).toHaveBeenCalledOnce()
})

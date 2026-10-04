/**
 * Why four blocking checks in HistoricalWorkingHoursWizard reported nothing.
 *
 * The half-open overlap test `aStart < bEnd && aEnd > bStart` is correct — it is
 * the same shape as `msOverlap` and `overlapsHalfOpen` in the clean engine. What
 * broke it was an argument that was never assigned: `SectionFRide.newStartMs` is
 * declared `number` and the object pushed into `changedRides` omitted it, so every
 * row carried `undefined` there. The compiler said so (TS2345 at the push site),
 * but that error was one of the 207 the typecheck ratchet carries, so nobody saw
 * it.
 *
 * Any comparison with `undefined` is false, including `>` and `<`, so the
 * conjunction could never be true and the checks could never find an overlap —
 * not the Inhaber's own, not per vehicle, not against trips that did not move.
 * CLAUDE.md: "Only overlaps the app itself created are blocking errors." Those
 * are exactly these four, and all four were silent.
 *
 * These tests pin the mechanism rather than the caller, because the caller is a
 * memo inside an 11.7k-line component. If a later change drops one of the three
 * fields again, the ratchet is what catches it — the baseline moves. This file is
 * here so the next reader knows what a missing field does to an overlap test,
 * instead of trusting "the check passed".
 */
import { describe, it, expect } from 'vitest'

/** The half-open overlap test the wizard and the clean engine both use. */
function overlapsHalfOpen(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart
}

describe('the half-open overlap test', () => {
  it('finds a genuine overlap', () => {
    // 22:00–23:00 against 22:30–23:30 on the same day.
    const day = Date.parse('2026-08-01T00:00:00')
    const h = (n: number) => day + n * 3600_000
    expect(overlapsHalfOpen(h(22), h(23), h(22.5), h(23.5))).toBe(true)
  })

  it('leaves touching intervals alone, which is what half-open means', () => {
    const day = Date.parse('2026-08-01T00:00:00')
    const h = (n: number) => day + n * 3600_000
    // One ride ends exactly when the next begins: not an overlap.
    expect(overlapsHalfOpen(h(22), h(23), h(23), h(24))).toBe(false)
  })

  it('finds an overlap across midnight, because the operands are instants', () => {
    const a1 = Date.parse('2026-08-01T23:00:00')
    const a2 = Date.parse('2026-08-02T01:00:00')
    const b1 = Date.parse('2026-08-01T23:30:00')
    const b2 = Date.parse('2026-08-02T02:00:00')
    expect(overlapsHalfOpen(a1, a2, b1, b2)).toBe(true)
  })

  it('NEGATIVE CONTROL: one missing operand makes it false for a real overlap', () => {
    const day = Date.parse('2026-08-01T00:00:00')
    const h = (n: number) => day + n * 3600_000
    const missing = undefined as unknown as number

    // The same pair as the first test — which really does overlap — but with
    // b's start unassigned, exactly as changedRides carried it.
    expect(overlapsHalfOpen(h(22), h(23), missing, h(23.5))).toBe(false)
    // And with a's start unassigned, which is the direction the wizard had.
    expect(overlapsHalfOpen(missing, h(23), h(22.5), h(23.5))).toBe(false)
  })

  it('NEGATIVE CONTROL: every comparison with undefined is false, both ways', () => {
    const missing = undefined as unknown as number
    // This is the whole mechanism. It is not that the check judged wrongly; it
    // is that it could not judge at all, and a false answer reads as "no
    // overlap" — the same word a correct check uses when there is none.
    expect(missing < 5).toBe(false)
    expect(missing > 5).toBe(false)
    expect(5 < missing).toBe(false)
    expect(5 > missing).toBe(false)
  })
})

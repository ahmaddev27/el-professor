import { describe, it, expect } from 'vitest'
import { assessDay, compressToThree, MAX_DAY_MINUTES, MAX_SHIFT_MINUTES } from './shiftDayLimits'

/*
  vitest.config.ts pins TZ=Europe/Berlin. Every case here is built from absolute
  instants, which is the point: the old check used toMins() on HH:MM and produced
  end < start for anything crossing midnight.
*/
const at = (iso: string) => new Date(iso).getTime()
const w = (s: string, e: string) => ({ startMs: at(s), endMs: at(e) })

describe('assessDay — merging', () => {
  it('merges two overlapping shifts that both cross midnight, where HH:MM math did not', () => {
    // Measured on the old code: these produced TWO rows, while the same overlap
    // in daylight produced one. That asymmetry is the defect.
    const r = assessDay([
      w('2026-08-12T23:00', '2026-08-13T01:00'),
      w('2026-08-12T23:30', '2026-08-13T02:00'),
    ])
    expect(r.merged).toHaveLength(1)
    expect(r.merged[0].endMs).toBe(at('2026-08-13T02:00'))
  })

  it('merges the same overlap in daylight identically — the control', () => {
    const r = assessDay([
      w('2026-08-12T13:00', '2026-08-12T15:00'),
      w('2026-08-12T13:30', '2026-08-12T16:00'),
    ])
    expect(r.merged).toHaveLength(1)
  })

  it('leaves genuinely separate shifts separate', () => {
    const r = assessDay([
      w('2026-08-12T06:00', '2026-08-12T08:00'),
      w('2026-08-12T10:00', '2026-08-12T12:00'),
      w('2026-08-12T15:00', '2026-08-12T17:00'),
      w('2026-08-12T23:00', '2026-08-13T01:00'),
    ])
    expect(r.merged).toHaveLength(4)
    expect(r.needsCompression).toBe(true)
  })
})

describe('the three-shift count is a note, never a violation', () => {
  it('reports needsCompression and nothing else for a many-shift taxi day', () => {
    // A real shape: 1090 of 1178 driver-days on staging merge to more than three.
    const many = Array.from({ length: 12 }, (_, i) => {
      const h = String(6 + i).padStart(2, '0')
      return w(`2026-08-12T${h}:00`, `2026-08-12T${h}:20`)
    })
    const r = assessDay(many)
    expect(r.needsCompression).toBe(true)
    expect(r.exceedsDayLimit).toBe(false)   // 12 x 20 min = 240 min, well under 8:30
    expect(r.exceedsShiftLimit).toBe(false)
  })
})

describe('the duration limits are the real violations', () => {
  it('flags a day over 8:30 of merged work', () => {
    const r = assessDay([
      w('2026-08-23T06:00', '2026-08-23T11:00'),   // 300
      w('2026-08-23T12:00', '2026-08-23T17:00'),   // 300 -> 600 total
    ])
    expect(r.dayMinutes).toBe(600)
    expect(r.exceedsDayLimit).toBe(true)
    expect(MAX_DAY_MINUTES).toBe(510)
  })

  it('flags a single merged shift over 4:30', () => {
    const r = assessDay([w('2026-08-12T06:00', '2026-08-12T11:00')])  // 300 > 270
    expect(r.exceedsShiftLimit).toBe(true)
    expect(MAX_SHIFT_MINUTES).toBe(270)
  })

  it('does not flag a day exactly at either limit', () => {
    const day = assessDay([w('2026-08-12T06:00', '2026-08-12T14:30')])  // 510 exactly
    expect(day.dayMinutes).toBe(510)
    expect(day.exceedsDayLimit).toBe(false)
    const shift = assessDay([w('2026-08-12T06:00', '2026-08-12T10:30')])  // 270 exactly
    expect(shift.exceedsShiftLimit).toBe(false)
  })
})

describe('compressToThree — display only', () => {
  it('reduces to three by closing the smallest gap, and never loses the span', () => {
    const r = assessDay([
      w('2026-08-12T06:00', '2026-08-12T08:00'),
      w('2026-08-12T10:00', '2026-08-12T12:00'),
      w('2026-08-12T15:00', '2026-08-12T17:00'),
      w('2026-08-12T23:00', '2026-08-13T01:00'),
    ])
    const c = compressToThree(r.merged)
    expect(c).toHaveLength(3)
    expect(c[0].startMs).toBe(at('2026-08-12T06:00'))
    expect(c[c.length - 1].endMs).toBe(at('2026-08-13T01:00'))
  })

  it('negative control: the old HH:MM arithmetic disagrees on a midnight case', () => {
    // The shape that produced the defect, kept so nobody reintroduces it.
    const toMins = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
    const oldMerge = (ws: Array<[string, string]>) => {
      const arr = ws.map(([s, e]) => ({ s: toMins(s), e: toMins(e) })).sort((a, b) => a.s - b.s)
      const out: Array<{ s: number; e: number }> = []
      for (const x of arr) { const l = out[out.length - 1]; if (!l || x.s > l.e) out.push({ ...x }); else l.e = Math.max(l.e, x.e) }
      return out
    }
    expect(oldMerge([['23:00', '01:00'], ['23:30', '02:00']])).toHaveLength(2)
    expect(assessDay([
      w('2026-08-12T23:00', '2026-08-13T01:00'),
      w('2026-08-12T23:30', '2026-08-13T02:00'),
    ]).merged).toHaveLength(1)
  })
})

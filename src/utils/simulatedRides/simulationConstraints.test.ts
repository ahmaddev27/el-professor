import { describe, expect, it } from 'vitest';
import type { StructuredNote } from '../monatsplanungPhase3';
import { collapseDecisions, noteVerdict, vehicleVerdict, type ShiftDecision } from './simulationConstraints';

const DRIVER = '22222222-2222-4222-8222-222222222201';
const at = (iso: string) => new Date(iso).getTime();

const note = (over: Partial<StructuredNote>): StructuredNote => ({
  id: 'n1', driver_id: DRIVER, note_type: 'sick', note_text: '', note_planning_behavior: 'exclude_from_plan', is_full_day: true,
  start_date: '2026-10-05', end_date: '2026-10-06', note_date: '2026-10-01T09:00:00.000Z', start_time: null, end_time: null, ...over,
});

const notes = (...list: StructuredNote[]) => new Map([[DRIVER, list]]);
const shift = (day: string) => [at(`${day}T08:00:00+02:00`), at(`${day}T14:00:00+02:00`)] as const;

describe('a note on a simulated shift', () => {
  it('blocks only when its window is the event\'s own', () => {
    const [s, e] = shift('2026-10-05');
    expect(noteVerdict(DRIVER, s, e, notes(note({}))).blocking?.id).toBe('n1');
  });

  it('does not block when the window is only the notice date, and lists it for review', () => {
    const assumed = note({ id: 'n2', start_date: null, end_date: null, note_date: '2026-10-05T07:00:00.000Z' });
    const [s, e] = shift('2026-10-05');
    const verdict = noteVerdict(DRIVER, s, e, notes(assumed));
    expect(verdict.blocking).toBeNull();
    expect(verdict.review.map(n => n.id)).toEqual(['n2']);
  });

  it('ignores a past event and a neutral note, and a window that does not touch the shift', () => {
    const [s, e] = shift('2026-10-05');
    expect(noteVerdict(DRIVER, s, e, notes(note({ note_type: 'blitzer', note_planning_behavior: 'must_include_in_plan' })))).toEqual({ blocking: null, review: [] });
    expect(noteVerdict(DRIVER, s, e, notes(note({ note_type: 'general', note_planning_behavior: 'neutral' })))).toEqual({ blocking: null, review: [] });
    const [s2, e2] = shift('2026-10-09');
    expect(noteVerdict(DRIVER, s2, e2, notes(note({})))).toEqual({ blocking: null, review: [] });
  });

  it('matches on the driver id only: no id, no note', () => {
    const [s, e] = shift('2026-10-05');
    expect(noteVerdict(undefined, s, e, notes(note({})))).toEqual({ blocking: null, review: [] });
  });
});

describe('a vehicle on an operating day', () => {
  it('is usable through the last valid day of its TÜV and blocked from the day after', () => {
    expect(vehicleVerdict({ tuev_gueltig_bis: '2026-10-15' }, '2026-10-15')).toEqual({ kind: 'usable' });
    expect(vehicleVerdict({ tuev_gueltig_bis: '2026-10-15' }, '2026-10-16').kind).toBe('blocked');
  });

  it('is a review, never a block and never a pass, when no TÜV date is recorded', () => {
    expect(vehicleVerdict({ tuev_gueltig_bis: null }, '2026-10-16').kind).toBe('review');
    expect(vehicleVerdict({}, '2026-10-16').kind).toBe('review');
  });
});

describe('the decision rows', () => {
  const row = (over: Partial<ShiftDecision>): ShiftDecision => ({
    day: '2026-10-05', plate: 'XX-TEST-1', vehicleId: null, driverId: DRIVER, outcome: 'excluded', code: 'driver_resting',
    reason: 'x', eventRef: null, certainty: null, startMs: null, endMs: null, count: 1, ...over,
  });

  it('collapses identical refusals into one row with a count and keeps every accepted shift', () => {
    const rows = collapseDecisions([row({}), row({}), row({ code: 'driver_blocked_by_note', eventRef: 'n1' }), row({ outcome: 'accepted' }), row({ outcome: 'accepted' })]);
    expect(rows.filter(r => r.outcome === 'excluded').map(r => [r.code, r.count])).toEqual([['driver_resting', 2], ['driver_blocked_by_note', 1]]);
    expect(rows.filter(r => r.outcome === 'accepted')).toHaveLength(2);
  });
});

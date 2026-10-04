/**
 * The owner's free time, as a view.
 *
 * Built for the owner's question of 03.10.2026 — *"show the owner free time in
 * the whole month as blocks"* — and measured on his real August the same day:
 * the owner holds 156 h over 48 blocks and is free for **596 h in 70 windows**,
 * the longest a whole 24 h day, against 56 unassigned blocks totalling 184 h of
 * which **all 56 would fit in some window**. So the room is not the obstacle.
 */
import { describe, expect, it } from 'vitest';
import { ownerFreeTime } from './ownerFreeTime';
import type { PlanBlock } from './blocks';

const at = (day: string, from: string, to: string): { startMs: number; endMs: number } => ({
  startMs: new Date(`${day}T${from}:00`).getTime(),
  endMs: new Date(`${day}T${to}:00`).getTime(),
});

let seq = 0;
function block(day: string, from: string, to: string, vehicleId = 'car-A'): PlanBlock {
  const { startMs, endMs } = at(day, from, to);
  seq += 1;
  return {
    id: `${vehicleId}|${startMs}|${seq}`,
    vehicleId,
    vehicleLabel: vehicleId,
    startMs,
    endMs,
    spanMinutes: Math.round((endMs - startMs) / 60_000),
    rideMinutes: Math.round((endMs - startMs) / 60_000),
    trips: [],
    driverId: null,
    driverName: null,
  } as unknown as PlanBlock;
}

describe('ownerFreeTime', () => {
  it('a day the owner does not work is one free window of the whole day', () => {
    const all = [block('2026-08-03', '08:00', '12:00')];
    const free = ownerFreeTime(all, [], 30);
    expect(free.windows).toHaveLength(1);
    expect(free.windows[0].minutes).toBe(24 * 60);
    expect(free.assignedMinutes).toBe(0);
  });

  it('splits a day around the owner\'s own blocks', () => {
    const mine = block('2026-08-03', '08:00', '12:00');
    const free = ownerFreeTime([mine], [mine], 30);
    // 00:00–08:00 and 12:00–24:00.
    expect(free.windows.map(w => w.minutes)).toEqual([480, 720]);
    expect(free.assignedMinutes).toBe(240);
  });

  it('refuses to call a gap shorter than the switch duration free', () => {
    // 12:00–12:20 is twenty minutes: nobody can take anything in it, because
    // parting two blocks takes the switch duration (§3). Reporting it would
    // overstate the room by exactly the amount nobody can use.
    const a = block('2026-08-03', '00:00', '12:00');
    const b = block('2026-08-03', '12:20', '24:00');
    const free = ownerFreeTime([a, b], [a, b], 30);
    expect(free.windows).toHaveLength(0);
    expect(free.totalMinutes).toBe(0);
  });

  it('counts only the days the month actually spans', () => {
    // The owner is "free" on a day the fleet never drove, but saying so is noise.
    const all = [block('2026-08-03', '08:00', '12:00'), block('2026-08-05', '08:00', '12:00')];
    const free = ownerFreeTime(all, [], 30);
    expect(new Set(free.windows.map(w => w.day))).toEqual(new Set(['2026-08-03', '2026-08-05']));
  });

  it('reports the longest window, which is what decides whether a leftover fits', () => {
    const mine = block('2026-08-03', '08:00', '10:00');
    const free = ownerFreeTime([mine], [mine], 30);
    // 10:00–24:00 is fourteen hours, longer than 00:00–08:00.
    expect(free.longestWindowMinutes).toBe(14 * 60);
  });

  it('a block running past midnight does not invent a window behind it', () => {
    // The night block is clipped at the day's end; the remainder belongs to the
    // next day, which is walked on its own. Without the clip the owner would read
    // as free during hours he is driving.
    const night = block('2026-08-03', '22:00', '23:59');
    const next = block('2026-08-04', '00:00', '02:00');
    const free = ownerFreeTime([night, next], [night, next], 30);
    const third = free.windows.filter(w => w.day === '2026-08-03');
    expect(third.every(w => w.endMs <= night.startMs)).toBe(true);
  });
});

describe('what the view reports about its own extent', () => {
  it('says how many days it counted, so the screen cannot claim the month', () => {
    // The sentence read "free this month" over a figure covering 21 days of a
    // 30-day November — true of what was counted, an overstatement of what was
    // claimed. Found by walking it in a browser, not by reading it.
    const all = [block('2026-11-02', '08:00', '12:00'), block('2026-11-05', '08:00', '12:00')];
    const free = ownerFreeTime(all, [], 30);
    expect(free.daysCounted, 'only the days the fleet drove').toBe(2);
  });

  it('counts no days when the month holds no blocks', () => {
    expect(ownerFreeTime([], [], 30).daysCounted).toBe(0);
  });

  it('a whole free day is one window of exactly 24 hours, ending at the next midnight', () => {
    // The screen printed "02.11.2026 00:00 – 00:00 · 24,0 h", because the end
    // carried no date. The window itself was always right; the line was not. This
    // pins the shape the line has to render.
    const all = [block('2026-11-02', '08:00', '12:00')];
    const free = ownerFreeTime(all, [], 30);
    const whole = free.windows.find(w => w.minutes === 24 * 60);
    expect(whole, 'a day with none of the owner\'s work is one 24-hour window').toBeDefined();
    expect(new Date(whole!.endMs).getDate(), 'the end falls on the NEXT day')
      .toBe(new Date(whole!.startMs).getDate() + 1);
    expect(new Date(whole!.endMs).getHours()).toBe(0);
  });
});

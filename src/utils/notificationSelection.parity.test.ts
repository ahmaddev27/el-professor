/**
 * The nightly notification job and the screens must answer the same question
 * about a car's TÜV date, and this file keeps them from drifting apart.
 *
 * It used to pin a second rule as well: `subscriptionIsActive()` written once
 * in `src/utils/planState.ts` and once in `notification-core.ts`, because the
 * trial notices judged a company by it. The trial and its notices are gone
 * (owner, 15.10.2026), the job holds no subscription predicate any more, and
 * the browser's own is covered in `planState.test.ts`. What is left is the
 * window both spell: `getTuevStatus()` turns the badge amber at 60 days, and the
 * mail goes out at the same moment.
 */
import { describe, expect, it } from 'vitest';
import {
  TUEV_SOON_DAYS,
  selectNotifications,
  type NotificationCompany,
} from '../../supabase/functions/_shared/notification-core';
import { getTuevStatus } from '../types/car';


describe('the windows are the ones already on screen', () => {
  it('TÜV: the job warns exactly where getTuevStatus() turns the badge amber', () => {
    expect(TUEV_SOON_DAYS).toBe(60);

    const carRow = (isoDay: string) => ({ id: 'car', kennzeichen: 'B-EP 1', tuev_gueltig_bis: isoDay });
    const company = (isoDay: string): NotificationCompany => ({
      company_id: 'c1',
      company_name: 'Test',
      settings: [],
      cars: [carRow(isoDay)],
      sent: [],
    });

    // The screen and the mail must agree about the same car on the same day.
    // getTuevStatus reads the browser's own clock, so the days are taken
    // relative to it rather than to NOW.
    const inDays = (n: number) => {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() + n);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    for (const [offset, expected] of [
      [-1, 'abgelaufen'],
      [0, 'bald_ablaufend'],
      [59, 'bald_ablaufend'],
      [60, 'bald_ablaufend'],
      [61, 'gueltig'],
    ] as const) {
      const day = inDays(offset);
      expect(getTuevStatus(day).status, `screen at ${offset} days`).toBe(expected);

      const planned = selectNotifications(company(day), new Date());
      const mailed = planned.length === 0 ? 'gueltig'
        : planned[0].type === 'tuev_abgelaufen' ? 'abgelaufen' : 'bald_ablaufend';
      expect(mailed, `mail at ${offset} days`).toBe(expected);
    }
  });
});

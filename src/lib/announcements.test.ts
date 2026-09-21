/**
 * Announcements (plan 3.11). Three things are pinned here:
 *
 * - **The window is two instants.** A wall-clock time typed in the browser
 *   leaves it as the instant it names, with its `Z`, so the database never has
 *   to guess a zone; vitest runs in Europe/Berlin (vitest.config.ts), which is
 *   the zone the people using the screen are in.
 * - **The German is the fallback**, and half a translation is never shown.
 * - **The form names the fields the database would name**, so the refusal and
 *   the screen agree.
 */
import { describe, expect, it } from 'vitest';
import {
  announcementFromForm,
  announcementState,
  announcementText,
  announcementToForm,
  dismissalKey,
  emptyAnnouncementForm,
  isShowing,
  parseAnnouncementAnswer,
  parseAnnouncements,
  parsePanelAnnouncement,
  toIsoInstant,
  toLocalInput,
  type Announcement,
  type AnnouncementForm,
} from './announcements';

const base: Announcement = {
  id: 'a1',
  version: 1,
  tone: 'info',
  titleDe: 'Wartung',
  bodyDe: 'Heute Nacht ist El-Professor kurz nicht erreichbar.',
  titleEn: '',
  bodyEn: '',
  startsAt: '2026-09-20T20:00:00Z',
  endsAt: '2026-09-21T02:00:00Z',
};

const form = (over: Partial<AnnouncementForm> = {}): AnnouncementForm => ({
  ...emptyAnnouncementForm(new Date('2026-09-20T08:00:00Z')),
  titleDe: 'Wartung',
  bodyDe: 'Heute Nacht.',
  ...over,
});

describe('the window: a Berlin wall clock leaves the browser as an instant', () => {
  it('22:00 on 20.09.2026 in Berlin (summer time, +02:00) is 20:00 UTC', () => {
    expect(toIsoInstant('2026-09-20T22:00')).toBe('2026-09-20T20:00:00.000Z');
  });

  it('in winter (+01:00) the same wall clock is one hour later in UTC', () => {
    expect(toIsoInstant('2026-12-20T22:00')).toBe('2026-12-20T21:00:00.000Z');
  });

  it('round-trips through the datetime-local field', () => {
    expect(toLocalInput('2026-09-20T20:00:00.000Z')).toBe('2026-09-20T22:00');
    expect(toIsoInstant(toLocalInput('2026-03-01T06:30:00Z'))).toBe('2026-03-01T06:30:00.000Z');
  });

  it('refuses what is not a real time — a date that would roll over, a missing clock, nonsense', () => {
    expect(toIsoInstant('2026-06-31T10:00')).toBeNull();
    expect(toIsoInstant('2026-09-20')).toBeNull();
    expect(toIsoInstant('20.09.2026 22:00')).toBeNull();
    expect(toIsoInstant('')).toBeNull();
  });

  it('refuses the hour that does not exist when the clocks go forward', () => {
    // 29.03.2026, 02:30 in Berlin never happens: the clock jumps from 02:00 to 03:00.
    expect(toIsoInstant('2026-03-29T02:30')).toBeNull();
  });
});

describe('isShowing and announcementState', () => {
  const at = (iso: string) => Date.parse(iso);

  it('shows from its start, and not from its end', () => {
    expect(isShowing(base, at('2026-09-20T19:59:59Z'))).toBe(false);
    expect(isShowing(base, at('2026-09-20T20:00:00Z'))).toBe(true);
    expect(isShowing(base, at('2026-09-21T01:59:59Z'))).toBe(true);
    expect(isShowing(base, at('2026-09-21T02:00:00Z'))).toBe(false);
  });

  it('an announcement without an end shows for ever once started', () => {
    expect(isShowing({ ...base, endsAt: null }, at('2030-01-01T00:00:00Z'))).toBe(true);
  });

  it('names its state for the panel', () => {
    expect(announcementState(base, at('2026-09-19T00:00:00Z'))).toBe('scheduled');
    expect(announcementState(base, at('2026-09-20T21:00:00Z'))).toBe('showing');
    expect(announcementState(base, at('2026-09-22T00:00:00Z'))).toBe('ended');
  });
});

describe('announcementText: German is the fallback', () => {
  it('a German reader reads German', () => {
    expect(announcementText({ ...base, titleEn: 'Maintenance', bodyEn: 'Tonight.' }, 'de'))
      .toEqual({ title: 'Wartung', body: base.bodyDe });
  });

  it('an English reader reads English when there is a whole translation', () => {
    expect(announcementText({ ...base, titleEn: 'Maintenance', bodyEn: 'Tonight.' }, 'en'))
      .toEqual({ title: 'Maintenance', body: 'Tonight.' });
  });

  it('…and German when there is none, or only half of one', () => {
    expect(announcementText(base, 'en')).toEqual({ title: 'Wartung', body: base.bodyDe });
    expect(announcementText({ ...base, titleEn: 'Maintenance' }, 'en')).toEqual({ title: 'Wartung', body: base.bodyDe });
  });
});

describe('dismissalKey', () => {
  it('names the version, so a corrected announcement comes back', () => {
    expect(dismissalKey({ id: 'a1', version: 1 })).not.toBe(dismissalKey({ id: 'a1', version: 2 }));
  });
});

describe('reading what the database returns', () => {
  const raw = {
    id: 'a1', version: 2, tone: 'warning', title_de: 'Wartung', body_de: 'Heute.',
    title_en: '', body_en: '', starts_at: '2026-09-20T20:00:00+00:00', ends_at: null,
  };

  it('a tenant list drops an entry it cannot read and keeps the rest', () => {
    expect(parseAnnouncements([raw, { id: 'x' }, { ...raw, id: 'a2', tone: 'danger' }, null]))
      .toEqual([{
        id: 'a1', version: 2, tone: 'warning', titleDe: 'Wartung', bodyDe: 'Heute.',
        titleEn: '', bodyEn: '', startsAt: '2026-09-20T20:00:00+00:00', endsAt: null,
      }]);
    expect(parseAnnouncements('nope')).toBeNull();
  });

  it('the panel reads the audience too', () => {
    const panel = parsePanelAnnouncement({ ...raw, audience: 'plans', plans: ['basic', 'gold'], company_ids: [] });
    expect(panel?.audience).toBe('plans');
    expect(panel?.plans).toEqual(['basic']);
    expect(parsePanelAnnouncement({ ...raw, audience: 'everyone' })).toBeNull();
  });

  it('an {ok, …} answer: the value, or the refusal with its problem and version', () => {
    expect(parseAnnouncementAnswer({ ok: true, item: raw }, b => parsePanelAnnouncement({ ...(b.item as object), audience: 'all' })))
      .toMatchObject({ ok: true });
    expect(parseAnnouncementAnswer({ ok: false, reason: 'invalid_value', problem: 'announcement.english' }, () => 1))
      .toEqual({ ok: false, reason: 'invalid_value', problem: 'announcement.english' });
    expect(parseAnnouncementAnswer({ ok: false, reason: 'version_conflict', current_version: 3 }, () => 1))
      .toEqual({ ok: false, reason: 'version_conflict', currentVersion: 3 });
    expect(parseAnnouncementAnswer(null, () => 1)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('the form, as the database would judge it', () => {
  it('builds the document a save sends, the window as UTC instants', () => {
    const parsed = announcementFromForm(form({ startsLocal: '2026-09-20T22:00', endsLocal: '2026-09-21T04:00' }));
    expect(parsed).toEqual({
      value: {
        tone: 'info', title_de: 'Wartung', body_de: 'Heute Nacht.', title_en: '', body_en: '',
        audience: 'all', plans: [], company_ids: [],
        starts_at: '2026-09-20T20:00:00.000Z', ends_at: '2026-09-21T02:00:00.000Z',
      },
    });
  });

  it('no end is an open window', () => {
    const parsed = announcementFromForm(form({ endsLocal: '' }));
    expect('value' in parsed && parsed.value.ends_at).toBeNull();
  });

  it('names the field the database would name', () => {
    expect(announcementFromForm(form({ titleDe: '  ' }))).toEqual({ error: 'announcement.title_de' });
    expect(announcementFromForm(form({ bodyDe: '' }))).toEqual({ error: 'announcement.body_de' });
    expect(announcementFromForm(form({ titleEn: 'Maintenance' }))).toEqual({ error: 'announcement.english' });
    expect(announcementFromForm(form({ titleDe: 'a\nb' }))).toEqual({ error: 'announcement.title_de' });
    expect(announcementFromForm(form({ titleDe: 'x'.repeat(121) }))).toEqual({ error: 'announcement.title_de' });
    expect(announcementFromForm(form({ audience: 'plans', plans: [] }))).toEqual({ error: 'announcement.plans' });
    expect(announcementFromForm(form({ audience: 'companies', companyIds: [] }))).toEqual({ error: 'announcement.company_ids' });
    expect(announcementFromForm(form({ audience: 'companies', companyIds: ['nope'] }))).toEqual({ error: 'announcement.company_ids.0' });
    expect(announcementFromForm(form({ startsLocal: '' }))).toEqual({ error: 'announcement.starts_at' });
    expect(announcementFromForm(form({ startsLocal: '2026-09-20T22:00', endsLocal: '2026-09-20T21:00' })))
      .toEqual({ error: 'announcement.ends_at' });
  });

  it('keeps only the audience that was chosen, in the database\'s plan order', () => {
    const plans = announcementFromForm(form({ audience: 'plans', plans: ['premium', 'basic'], companyIds: ['c0000000-0000-4000-8000-00000000000a'] }));
    expect('value' in plans && plans.value.plans).toEqual(['basic', 'premium']);
    expect('value' in plans && plans.value.company_ids).toEqual([]);

    const all = announcementFromForm(form({ audience: 'all', plans: ['basic'] }));
    expect('value' in all && all.value.plans).toEqual([]);
  });

  it('a company chosen twice is sent once', () => {
    const id = 'c0000000-0000-4000-8000-00000000000A';
    const parsed = announcementFromForm(form({ audience: 'companies', companyIds: [id, id.toLowerCase()] }));
    expect('value' in parsed && parsed.value.company_ids).toEqual([id.toLowerCase()]);
  });

  it('an announcement opens in the editor with its window in the browser\'s own clock', () => {
    const panel = parsePanelAnnouncement({
      id: 'a1', version: 1, tone: 'info', title_de: 'x', body_de: 'y', title_en: '', body_en: '',
      starts_at: '2026-09-20T20:00:00Z', ends_at: null, audience: 'all', plans: [], company_ids: [],
    });
    expect(panel).not.toBeNull();
    const f = announcementToForm(panel!);
    expect(f.startsLocal).toBe('2026-09-20T22:00');
    expect(f.endsLocal).toBe('');
  });
});

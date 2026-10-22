import { describe, expect, it } from 'vitest';
import {
  EMPTY_PROVENANCE_FORM,
  EVIDENCE_MAX_BYTES,
  checkEvidenceFile,
  entrySourceOf,
  eventAfterReport,
  eventDetailsApply,
  evidenceKey,
  historyFields,
  instantFromLocalInput,
  isEvidenceKey,
  localInputFromInstant,
  provenanceErrorKey,
  provenanceFormOf,
  provenancePayload,
  readChangeLog,
  readPosition,
  reviewedFieldsChanged,
  verificationOf,
  type ProvenanceFormValues,
  type ReviewedFormValues,
} from './noteProvenance';

const CO = 'c0000000-0000-4000-8000-00000000000a';
const OTHER_CO = 'c0000000-0000-4000-8000-00000000000b';
const NOTE = 'a8100000-0000-4000-8000-000000000001';
const OTHER_NOTE = 'a8100000-0000-4000-8000-000000000002';
const FILE = 'f8100000-0000-4000-8000-000000000001';

describe('what a row says about itself, read defensively', () => {
  it('reads a missing or unknown source as the weakest claim, legacy', () => {
    expect(entrySourceOf({})).toBe('legacy');
    expect(entrySourceOf({ entry_source: null })).toBe('legacy');
    expect(entrySourceOf({ entry_source: 'import' })).toBe('legacy');
    expect(entrySourceOf({ entry_source: 'driver_app' })).toBe('driver_app');
  });

  it('reads a missing or unknown status as unverified, never as verified', () => {
    expect(verificationOf({})).toBe('unverified');
    expect(verificationOf({ verification_status: 'checked' })).toBe('unverified');
    expect(verificationOf({ verification_status: 'verified' })).toBe('verified');
    expect(verificationOf({ verification_status: 'rejected' })).toBe('rejected');
  });
});

describe('which notes are offered the event details', () => {
  it.each(['sick', 'vacation', 'off'])('not a %s note: its window is the fact', type => {
    expect(eventDetailsApply(type)).toBe(false);
  });

  it.each(['general', 'blitzer', 'accident', 'kontrolle', 'breakdown', 'wait', 'other'])('a %s note', type => {
    expect(eventDetailsApply(type)).toBe(true);
  });
});

describe('the document key', () => {
  it('is the company, the note and a generated name', () => {
    expect(evidenceKey(CO, NOTE, FILE, 'pdf')).toBe(`${CO}/driver-notes/${NOTE}/${FILE}.pdf`);
  });

  it.each(['pdf', 'jpg', 'jpeg', 'png', 'webp'] as const)('recognises its own, as .%s', ext => {
    expect(isEvidenceKey(evidenceKey(CO, NOTE, FILE, ext), CO, NOTE)).toBe(true);
  });

  const key = (tail: string) => `${CO}/driver-notes/${NOTE}/${tail}`;
  it.each([
    ['another company\'s folder', evidenceKey(OTHER_CO, NOTE, FILE, 'pdf')],
    ['another note\'s folder', evidenceKey(CO, OTHER_NOTE, FILE, 'pdf')],
    ['a traversal', key(`../${FILE}.pdf`)],
    ['a nested folder', key(`a/${FILE}.pdf`)],
    ['a person\'s file name', key('Bussgeld.pdf')],
    ['an svg', key(`${FILE}.svg`)],
    ['an html file', key(`${FILE}.html`)],
    ['no extension', key(FILE)],
    ['an upper-case extension', key(`${FILE}.PDF`)],
    ['an upper-case file id', key(`${FILE.toUpperCase()}.pdf`)],
    ['a trailing space', key(`${FILE}.pdf `)],
    ['a trailing newline', key(`${FILE}.pdf\n`)],
    ['a leading slash', `/${key(`${FILE}.pdf`)}`],
    ['a URL', `https://api.example.invalid/${key(`${FILE}.pdf`)}`],
    ['a signed URL', key(`${FILE}.pdf?token=abc`)],
    ['nothing', ''],
  ])('refuses %s', (_label, candidate) => {
    expect(isEvidenceKey(candidate, CO, NOTE)).toBe(false);
  });

  it('refuses to be asked about something that is not a uuid', () => {
    expect(isEvidenceKey(evidenceKey('x', 'y', FILE, 'pdf'), 'x', 'y')).toBe(false);
  });
});

describe('the file picked for a note', () => {
  const file = (name: string, type: string, size = 1000) => ({ name, type, size });

  it('takes a pdf and sends the content type of its extension', () => {
    expect(checkEvidenceFile(file('Bescheid.pdf', 'application/pdf'))).toEqual({
      ok: true, ext: 'pdf', contentType: 'application/pdf',
    });
  });

  it('takes a photo, in any case of extension, and a file the browser could not name', () => {
    expect(checkEvidenceFile(file('IMG_1.JPG', 'image/jpeg'))).toMatchObject({ ok: true, ext: 'jpg', contentType: 'image/jpeg' });
    expect(checkEvidenceFile(file('scan.png', ''))).toMatchObject({ ok: true, ext: 'png', contentType: 'image/png' });
  });

  it('refuses a file whose name and whose content type disagree: an svg called .png is not a png', () => {
    expect(checkEvidenceFile(file('x.png', 'image/svg+xml'))).toEqual({ ok: false, problem: 'type' });
  });

  it.each(['x.svg', 'x.html', 'x.exe', 'x.heic', 'x', 'x.'])('refuses %s', name => {
    expect(checkEvidenceFile(file(name, ''))).toEqual({ ok: false, problem: 'type' });
  });

  it('refuses an empty file and one over the limit', () => {
    expect(checkEvidenceFile(file('x.pdf', 'application/pdf', 0))).toEqual({ ok: false, problem: 'empty' });
    expect(checkEvidenceFile(file('x.pdf', 'application/pdf', EVIDENCE_MAX_BYTES + 1))).toEqual({ ok: false, problem: 'size' });
    expect(checkEvidenceFile(file('x.pdf', 'application/pdf', EVIDENCE_MAX_BYTES))).toMatchObject({ ok: true });
  });
});

describe('the two moments', () => {
  it('turns a local input into an instant with an explicit offset, and back', () => {
    const iso = instantFromLocalInput('2026-10-22T14:03');
    expect(iso).toMatch(/Z$/);
    expect(localInputFromInstant(iso)).toBe('2026-10-22T14:03');
  });

  it('reads nothing as nothing', () => {
    expect(instantFromLocalInput('')).toBeNull();
    expect(instantFromLocalInput('not a time')).toBeNull();
    expect(localInputFromInstant(null)).toBe('');
    expect(localInputFromInstant(undefined)).toBe('');
    expect(localInputFromInstant('garbage')).toBe('');
  });

  it('orders them: only a report dated before its event is a problem', () => {
    expect(eventAfterReport('2026-10-02T09:00', '2026-09-01T14:03')).toBe(true);
    expect(eventAfterReport('2026-09-01T14:03', '2026-09-01T14:03')).toBe(false);
    expect(eventAfterReport('2026-09-01T14:03', '2026-10-02T09:00')).toBe(false);
    expect(eventAfterReport('2026-09-01T14:03', '')).toBe(false);
    expect(eventAfterReport('', '2026-09-01T14:03')).toBe(false);
  });
});

describe('the place', () => {
  const text = (latitude: string, longitude: string, accuracy = '') => ({ latitude, longitude, accuracy });

  it('reads nothing as no position', () => {
    expect(readPosition(text('', ''))).toEqual({ ok: true, latitude: null, longitude: null, accuracy: null });
  });

  it('reads German decimals: a comma is a decimal point', () => {
    expect(readPosition(text('51,5', '7,25', '12,5'))).toEqual({ ok: true, latitude: 51.5, longitude: 7.25, accuracy: 12.5 });
    expect(readPosition(text('51.5', '7.25'))).toMatchObject({ ok: true, latitude: 51.5, longitude: 7.25 });
  });

  it('wants both coordinates or neither', () => {
    expect(readPosition(text('51,5', ''))).toEqual({ ok: false, problem: 'pair' });
    expect(readPosition(text('', '7,4'))).toEqual({ ok: false, problem: 'pair' });
  });

  it('keeps it on the globe, corners included', () => {
    expect(readPosition(text('91', '7'))).toEqual({ ok: false, problem: 'range' });
    expect(readPosition(text('-91', '7'))).toEqual({ ok: false, problem: 'range' });
    expect(readPosition(text('51', '181'))).toEqual({ ok: false, problem: 'range' });
    expect(readPosition(text('-90', '180'))).toMatchObject({ ok: true });
  });

  it('refuses what is not a number, rather than reading a prefix of it', () => {
    expect(readPosition(text('51,5 N', '7'))).toEqual({ ok: false, problem: 'number' });
    expect(readPosition(text('NaN', '7'))).toEqual({ ok: false, problem: 'number' });
    expect(readPosition(text('51', '7', 'abc'))).toEqual({ ok: false, problem: 'number' });
  });

  it('wants an accuracy only with a position, and within 100 km', () => {
    expect(readPosition(text('', '', '25'))).toEqual({ ok: false, problem: 'accuracy' });
    expect(readPosition(text('51', '7', '100001'))).toEqual({ ok: false, problem: 'accuracy' });
    expect(readPosition(text('51', '7', '100000'))).toMatchObject({ ok: true, accuracy: 100000 });
    expect(readPosition(text('51', '7', '0'))).toMatchObject({ ok: true, accuracy: 0 });
  });
});

describe('what a save sends', () => {
  const form = (patch: Partial<ProvenanceFormValues>): ProvenanceFormValues => ({ ...EMPTY_PROVENANCE_FORM, ...patch });

  it('sends a new note that uses none of it exactly what it always sent', () => {
    expect(provenancePayload(form({}), null)).toEqual({ ok: true, payload: {} });
  });

  it('sends a new note only what was filled in', () => {
    const read = provenancePayload(form({ occurred_at: '2026-09-01T14:03' }), null);
    expect(read).toMatchObject({ ok: true });
    expect(Object.keys((read as { payload: object }).payload)).toEqual(['occurred_at']);
  });

  it('sends an edit nothing when nothing was changed: a value shown to the minute is not re-sent as a different instant', () => {
    const opened = provenanceFormOf({
      occurred_at: '2026-09-01T12:03:37.123+00:00', latitude: 51.123456789, longitude: 7.4, location_accuracy_m: 12.5,
    });
    expect(provenancePayload(opened, opened)).toEqual({ ok: true, payload: {} });
  });

  it('sends an edit only what the person changed', () => {
    const opened = provenanceFormOf({ occurred_at: '2026-09-01T12:03:00+00:00' });
    const read = provenancePayload({ ...opened, reported_at: '2026-10-02T09:00' }, opened);
    expect(read).toMatchObject({ ok: true });
    expect(Object.keys((read as { payload: object }).payload)).toEqual(['reported_at']);
  });

  it('clears a field the person emptied', () => {
    const opened = provenanceFormOf({ occurred_at: '2026-09-01T12:03:00+00:00' });
    expect(provenancePayload({ ...opened, occurred_at: '' }, opened)).toEqual({ ok: true, payload: { occurred_at: null } });
  });

  it('sends the position as a unit, so the pair rule holds', () => {
    const opened = provenanceFormOf({ latitude: 51.5, longitude: 7.4 });
    const read = provenancePayload({ ...opened, location_accuracy_m: '30' }, opened);
    expect(read).toEqual({ ok: true, payload: { latitude: 51.5, longitude: 7.4, location_accuracy_m: 30 } });
  });

  it('finds a problem before the database does', () => {
    expect(provenancePayload(form({ occurred_at: '2026-10-02T09:00', reported_at: '2026-09-01T14:03' }), null))
      .toEqual({ ok: false, problem: 'eventOrder' });
    expect(provenancePayload(form({ latitude: '51,5' }), null)).toEqual({ ok: false, problem: 'pair' });
    expect(provenancePayload(form({ latitude: 'x', longitude: '7' }), null)).toEqual({ ok: false, problem: 'number' });
  });
});

describe('the sentence for a refusal the database made', () => {
  it('finds the constraint by name in the message', () => {
    expect(provenanceErrorKey({
      message: 'new row for relation "driver_notes" violates check constraint "driver_notes_occurred_not_after_reported"',
    })).toBe('notes.prov.err.eventOrder');
    expect(provenanceErrorKey({ message: 'x', details: 'driver_notes_location_accuracy' })).toBe('notes.prov.err.accuracy');
    expect(provenanceErrorKey({ message: 'violates check constraint "driver_notes_rejection_has_reason"' }))
      .toBe('notes.prov.err.rejectReason');
  });

  it('says nothing about any other error', () => {
    expect(provenanceErrorKey({ message: 'permission denied for function x' })).toBeNull();
    expect(provenanceErrorKey(null)).toBeNull();
    expect(provenanceErrorKey('boom')).toBeNull();
  });
});

describe('what a review covers', () => {
  const base: ReviewedFormValues = {
    driver_id: 'd1', car_id: '', note_type: 'blitzer', is_full_day: false, start_date: '2026-10-19', end_date: '2026-10-19',
    start_time: '14:00', end_time: '15:00', occurred_at: '', reported_at: '', latitude: '', longitude: '',
    location_accuracy_m: '', note_text: 'Blitzer A2',
  };

  it('is untouched by a save that changes nothing', () => {
    expect(reviewedFieldsChanged(base, { ...base })).toBe(false);
  });

  it.each([
    ['the driver', { driver_id: 'd2' }],
    ['the vehicle', { car_id: 'c1' }],
    ['the type', { note_type: 'accident' }],
    ['the window', { start_time: '08:00' }],
    ['the moment', { occurred_at: '2026-10-19T14:03' }],
    ['the place', { latitude: '51,5', longitude: '7,4' }],
    ['the text', { note_text: 'Blitzer A3' }],
  ])('is changed by %s', (_what, patch) => {
    expect(reviewedFieldsChanged(base, { ...base, ...patch })).toBe(true);
  });
});

describe('the change log, read defensively', () => {
  it('reads what the trigger writes', () => {
    expect(readChangeLog([{
      at: '2026-10-22T10:00:00+00:00', by: 'u1', changed: ['occurred_at', 'verification_status'],
      previous: { occurred_at: null }, verification_reset: true,
    }])).toEqual([{
      at: '2026-10-22T10:00:00+00:00', by: 'u1', changed: ['occurred_at', 'verification_status'],
      previous: { occurred_at: null }, verificationReset: true,
    }]);
  });

  it('drops an entry it cannot read, and reads a writer with no session as null', () => {
    const entries = readChangeLog([null, 7, { at: 5 }, { at: 'x', by: null, changed: ['note_text'] }]);
    expect(entries).toEqual([{ at: 'x', by: null, changed: ['note_text'], previous: {}, verificationReset: false }]);
    expect(readChangeLog('nope')).toEqual([]);
    expect(readChangeLog(undefined)).toEqual([]);
  });

  it('names the columns of an entry as the few things a person would, each once, in order', () => {
    expect(historyFields(['start_date', 'end_date', 'latitude', 'longitude', 'verification_status', 'reviewed_by', 'note_text']))
      .toEqual(['window', 'place', 'review', 'text']);
    expect(historyFields(['no_such_column'])).toEqual([]);
  });
});
